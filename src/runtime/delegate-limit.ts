/** Dormant delegate-only context-limit reporting boundary. */
import { awaitWithContext } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { defineDoc, defineExtension, GenerationTask, hook, LiveDoc, ToolTask, type ConversationId, type EntryId, type Harness, type ModelRef, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { DelegateChildIdentityDoc } from "./delegate-conversation.js";
import { DelegationDoc } from "./delegation-record.js";

export type DelegateLimitState = { handoffId: string | null; taskId: number | null; cutoff: number | null };
export const DelegateLimitDoc = defineDoc<DelegateLimitState>({
  kind: "carto.delegate-limit", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ handoffId: null, taskId: null, cutoff: null }), checkpointWhen: () => true,
});

const instruction = "Context is approaching its limit. Stop further work and call delegate_report alone now. Report only actual findings, changes and checks, uncertainty, and remaining work. Do not invent a report.";
type Policy = { model: ModelRef; window: number; reserveTokens: number };
type Decision = "normal" | "report" | "hold";

function validState(value: DelegateLimitState): boolean {
  return Object.keys(value).length === 3 && ((value.handoffId === null && value.taskId === null && value.cutoff === null) ||
    (typeof value.handoffId === "string" && value.handoffId.length > 0 && Number.isSafeInteger(value.taskId) && (value.taskId ?? 0) > 0 &&
      Number.isSafeInteger(value.cutoff) && (value.cutoff ?? 0) > 0));
}

/** Check provenance before using a boundary marker to describe a missing report. */
export async function hasDelegateLimitMarker(
  tx: Tx, mainId: ConversationId, childId: ConversationId, ownerId: TaskId, handoffId: string,
): Promise<boolean> {
  const marker = await tx.doc(DelegateLimitDoc, childId);
  if (!validState(marker)) throw new Error("Invalid delegate context-limit marker; the handoff was preserved.");
  if (marker.handoffId === null) return false;
  const child = await tx.conversation(childId);
  const identity = await tx.doc(DelegateChildIdentityDoc, childId);
  const task = await tx.task(marker.taskId as TaskId);
  const entry = await tx.entry(marker.cutoff as EntryId);
  if (marker.handoffId !== handoffId || handoffId !== `delegate:${ownerId}` ||
      Object.keys(identity).length !== 3 || identity.mainId !== mainId || identity.ownerId !== ownerId ||
      identity.handoffId !== handoffId || child?.owner?.conversationId !== mainId || child.owner.taskId !== ownerId ||
      task?.kind !== "pi.generation" || task.conversationId !== childId || entry?.conversationId !== childId) {
    throw new Error("Delegate context-limit marker conflicts with its source; the handoff was preserved.");
  }
  return true;
}

/**
 * Run on Pi's session line at the request boundary. The marker is committed
 * before the forced request can reach the provider, and is not reset by a
 * retry or crash. The model/window policy must describe the actual provider;
 * Pi's estimate is approximate and a single large result can overshoot it.
 */
export async function assessDelegateLimit(
  tx: Tx, childId: ConversationId, taskId: TaskId, estimated: number, policy: Policy,
): Promise<Decision> {
  if (!Number.isSafeInteger(policy.window) || policy.window <= 1 || !Number.isSafeInteger(policy.reserveTokens) ||
      policy.reserveTokens <= 0 || policy.reserveTokens >= policy.window || !Number.isFinite(estimated) || estimated < 0 ||
      !policy.model.provider || !policy.model.modelId) throw new Error("Invalid delegate context-limit policy.");
  const child = await tx.conversation(childId);
  const identity = await tx.doc(DelegateChildIdentityDoc, childId);
  if (Object.keys(identity).length !== 3 || identity.mainId === null || identity.ownerId === null ||
      !Number.isSafeInteger(identity.mainId) || !Number.isSafeInteger(identity.ownerId) || identity.mainId < 1 || identity.ownerId < 1 ||
      identity.handoffId !== `delegate:${identity.ownerId}` || child?.owner?.conversationId !== identity.mainId || child.owner.taskId !== identity.ownerId) {
    throw new Error("Delegate context-limit identity is unavailable.");
  }
  const handoff = (await tx.doc(DelegationDoc, identity.mainId as ConversationId)).active;
  if (handoff?.phase !== "running" || handoff.input.id !== identity.handoffId || handoff.conversationId !== childId) {
    throw new Error("Delegate context-limit handoff is no longer running.");
  }
  const task = await tx.task(taskId);
  const live = await tx.doc(LiveDoc, childId);
  const checkpoint = task?.state.status === "running" ? task.state.checkpoint : undefined;
  if (task?.kind !== "pi.generation" || task.conversationId !== childId || task.abortRequested || live.run?.taskId !== taskId ||
      checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint) || checkpoint.phase !== "request" ||
      !Number.isSafeInteger(checkpoint.cutoff) || (checkpoint.cutoff as number) < 1 ||
      checkpoint.model === null || typeof checkpoint.model !== "object" || Array.isArray(checkpoint.model) ||
      checkpoint.model.provider !== policy.model.provider || checkpoint.model.modelId !== policy.model.modelId) {
    throw new Error("Delegate context-limit request or model changed.");
  }
  const limit = await tx.doc(DelegateLimitDoc, childId);
  if (!validState(limit)) throw new Error("Invalid delegate context-limit marker.");
  if (limit.handoffId !== null) {
    if (limit.handoffId !== identity.handoffId) throw new Error("Delegate context-limit marker belongs to another handoff.");
    return limit.taskId === taskId && limit.cutoff === checkpoint.cutoff ? "report" : "hold";
  }
  if (estimated < policy.window - policy.reserveTokens) return "normal";
  limit.handoffId = identity.handoffId;
  limit.taskId = taskId;
  limit.cutoff = checkpoint.cutoff as number;
  return "report";
}

/**
 * Install only in selected delegates and keep it installed through recovery.
 * `harness` must return that child's actual Harness; the host must route a hold
 * to checkpoint/abort and a missing-report return, not leave it waiting. The
 * first forced request may be retried at its same Pi cutoff. Further requests
 * are held; beforeTool blocks new non-report calls. Pi recovery can replay a
 * tool whose intent was already recorded without invoking beforeTool again,
 * so this is not a universal execution guard. Other selected hooks must not
 * remove the instruction, and the host must stop in-flight work on recovery.
 * The instruction is request-only; the marker is durable. Pi does not enforce
 * a provider's tool choice or guarantee a report when a model ignores the
 * instruction, overflows, or fails. The host must also preserve person inputs.
 */
export function createDelegateLimitExtension(options: Policy & { harness: () => Harness; onBlocked?: () => void }) {
  return defineExtension({
    name: "carto.delegate-limit",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          let decision: Decision = "hold";
          try {
            const estimated = estimateContextTokens(request.messages).tokens;
            decision = await options.harness().commit((tx) => assessDelegateLimit(tx, api.conversationId, api.taskId, estimated, options), context);
          } catch (error) {
            // Pi skips throwing generation hooks. An uncertain assessment holds.
            if (context.abortSignal?.aborted) throw error;
          }
          if (decision === "normal") return;
          if (decision === "report") return { messages: [...request.messages, { role: "user" as const, content: instruction, timestamp: Date.now() }] };
          try { options.onBlocked?.(); } catch { /* notification cannot release the hold */ }
          await awaitWithContext(new Promise<void>(() => {}), context);
        },
      }),
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const state = await api.snapshot(DelegateLimitDoc, api.conversationId, context);
          if (state === undefined) return;
          if (!validState(state)) return { block: "Invalid delegate context-limit marker." };
          if (state.handoffId !== null && (call.name !== "delegate_report" || call.parent !== undefined)) {
            return { block: "The delegate must return its report; further work is blocked." };
          }
        },
      }),
    ],
  });
}
