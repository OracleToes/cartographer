/** Dormant source-generation checkpoint for inputs before delegate recovery aborts main. */
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc, InboxDoc, LiveDoc, type ConversationId, type Cursor, type Storage, type SubmissionRecord, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { DelegateMainBarrierDoc, DelegationDoc, type DelegationTransfer } from "./delegation-record.js";
import { DelegateChildIdentityDoc, delegateInitialInput } from "./delegate-conversation.js";

export type CapturedInput = {
  submissionId: number;
  placement: "placed" | "queued";
  whenBusy: "steer" | "followUp";
  content: JsonValue;
  entry: { kind: string; data?: JsonValue };
};
export type InputCheckpoint = { handoffId: string | null; inputs: CapturedInput[] };

/** Validate preserved content without rewriting or discarding unknown fields. */
export function parseInputCheckpoint(content: string, handoffId: string): InputCheckpoint {
  const value: unknown = JSON.parse(content);
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
  if (!object(value) || !keys(value, ["handoffId", "inputs"]) || value.handoffId !== handoffId || !Array.isArray(value.inputs)) {
    throw new Error("Invalid delegate input checkpoint; it was preserved.");
  }
  let previous = 0;
  for (const item of value.inputs) {
    if (!object(item) || !keys(item, ["submissionId", "placement", "whenBusy", "content", "entry"]) ||
        !Number.isSafeInteger(item.submissionId) || (item.submissionId as number) <= previous ||
        (item.placement !== "placed" && item.placement !== "queued") ||
        (item.whenBusy !== "steer" && item.whenBusy !== "followUp") ||
        !object(item.entry) || !keys(item.entry, ["kind", "data"]) || typeof item.entry.kind !== "string" || item.entry.kind.length === 0) {
      throw new Error("Invalid delegate input checkpoint; it was preserved.");
    }
    previous = item.submissionId as number;
    const input = item.content;
    if (typeof input !== "string" && (!Array.isArray(input) || input.some((part: unknown) =>
      !object(part) || !((part.type === "text" && typeof part.text === "string") ||
        (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string"))))) {
      throw new Error("Unsupported delegate input content; it was preserved.");
    }
  }
  return value as unknown as InputCheckpoint;
}

/** Validate both source documents before either is trusted or deleted. */
export function validateInputTransfer(value: NonNullable<DelegationTransfer["inputCheckpoint"]>, handoffId: string): InputCheckpoint {
  const valid = (item: unknown): item is { documentId: number; revision: number; content: string } => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as { documentId?: unknown; revision?: unknown; content?: unknown };
    return Number.isSafeInteger(record.documentId) && (record.documentId as number) > 0 &&
      Number.isSafeInteger(record.revision) && (record.revision as number) > 0 && typeof record.content === "string";
  };
  if (!valid(value) || !valid(value.barrier) || value.documentId === value.barrier.documentId) {
    throw new Error("Invalid delegate input transfer; it was preserved.");
  }
  const barrier: unknown = JSON.parse(value.barrier.content);
  if (barrier === null || typeof barrier !== "object" || Array.isArray(barrier) || Object.keys(barrier).length !== 3 ||
      (barrier as { sourceId?: unknown }).sourceId !== handoffId ||
      (barrier as { admittedId?: unknown }).admittedId !== null || (barrier as { submissionId?: unknown }).submissionId !== null) {
    throw new Error("Invalid delegate input source barrier; it was preserved.");
  }
  return parseInputCheckpoint(value.content, handoffId);
}

/**
 * Find inputs Pi has already settled without an answer. A queued input
 * withdrawn before capture may have no retained content; its submission still
 * identifies the loss. Pi exposes this scan on Storage, not Tx, so call outside
 * a Session commit. The caller must provide the Harness's own storage, verify
 * conversation identity and seal admission through checkpoint, scan and abort.
 * This function does not decide whether an input was already recovered.
 */
export async function findUnansweredInputs(
  storage: Pick<Storage, "scanSubmissions">, conversationId: ConversationId, context: Context,
): Promise<Array<Extract<SubmissionRecord, { type: "input"; status: "unanswered" }>>> {
  const result: Array<Extract<SubmissionRecord, { type: "input"; status: "unanswered" }>> = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanSubmissions({ conversationId, status: "unanswered", order: "ascending" }, 100, cursor, context);
    for (const submission of page.items) {
      if (submission.type === "input" && submission.status === "unanswered") result.push(submission);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return result;
}

export const DelegateInputCheckpointDoc = defineDoc<InputCheckpoint>({
  kind: "carto.delegate-input-checkpoint", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ handoffId: null, inputs: [] }), checkpointWhen: () => true,
});

/**
 * Call inside the Pi transaction before abort. The host must seal input
 * admission to main and child through capture and recovery; this checkpoint
 * is not a lock. A retry retains the original snapshot, but refuses new or
 * changed live and queued inputs instead of aborting them without a copy.
 */
export async function checkpointDelegateInputs(tx: Tx, mainId: ConversationId, id: string): Promise<void> {
  const active = (await tx.doc(DelegationDoc, mainId)).active;
  const barrier = await tx.doc(DelegateMainBarrierDoc, mainId);
  const saved = await tx.doc(DelegateInputCheckpointDoc, mainId);
  if (active?.input.id !== id || (active.phase !== "ending" && active.phase !== "returned") || barrier.sourceId !== id) {
    throw new Error("Input checkpoint requires the matching source handoff; all inputs were preserved.");
  }
  let previous: InputCheckpoint | undefined;
  if (saved.handoffId !== null) {
    if (saved.handoffId !== id) throw new Error("Another input checkpoint exists; it was preserved.");
    previous = parseInputCheckpoint(JSON.stringify(saved), id);
  } else if (!Array.isArray(saved.inputs) || saved.inputs.length !== 0 || Object.keys(saved).length !== 2) {
    throw new Error("Invalid empty input checkpoint; it was preserved.");
  }
  const inputs: CapturedInput[] = [];
  const capture = async (conversationId: ConversationId, initialSubmission?: number) => {
    const live = await tx.doc(LiveDoc, conversationId);
    const inbox = await tx.doc(InboxDoc, conversationId);
    if (live.run === undefined && (live.runFailure?.inputs.length ?? 0) > 0) {
      for (const failedId of live.runFailure?.inputs ?? []) {
        const failed = await tx.submission(failedId);
        const wasCaptured = previous?.inputs.some((input) => input.submissionId === failedId) === true;
        if (failed?.type !== "input" || failed.conversationId !== conversationId || failed.status !== "unanswered" ||
            (!wasCaptured && failed.id !== initialSubmission)) {
          throw new Error("A run already ended without an input checkpoint; its inputs were preserved for recovery.");
        }
      }
    }
    for (const submissionId of live.run?.inputs ?? []) {
      const submission = await tx.submission(submissionId);
      if (submission?.type !== "input" || submission.conversationId !== conversationId || submission.status !== "placed") {
        throw new Error("A running input is missing or inconsistent; it was preserved.");
      }
      if (submission.id === initialSubmission) {
        if (active.phase === "returned") throw new Error("The delegate's report run has not settled; its inputs were preserved.");
        continue;
      }
      const entry = await tx.entry(submission.entry);
      const message = entry?.model?.[0];
      if (entry?.conversationId !== conversationId || entry.model?.length !== 1 || message?.role !== "user") {
        throw new Error("A running input entry is missing or inconsistent; it was preserved.");
      }
      inputs.push({
        submissionId, placement: "placed", whenBusy: "followUp",
        content: JSON.parse(JSON.stringify(message.content)) as JsonValue,
        entry: { kind: entry.kind, ...(entry.data === undefined ? {} : { data: entry.data }) },
      });
    }
    for (const item of inbox.items) {
      if (item.mode === "write") throw new Error("A queued context write needs recovery; it was preserved.");
      const submission = await tx.submission(item.id);
      if (submission?.type !== "input" || submission.conversationId !== conversationId || submission.status !== "queued") {
        throw new Error("A queued input is missing or inconsistent; it was preserved.");
      }
      if (submission.id === initialSubmission) continue;
      inputs.push({
        submissionId: item.id, placement: "queued", whenBusy: item.mode,
        content: item.content as JsonValue,
        entry: item.entry === undefined ? { kind: "pi.user" } : { kind: item.entry.kind, ...(item.entry.data === undefined ? {} : { data: item.entry.data }) },
      });
    }
  };
  await capture(mainId);
  if (active.conversationId !== null) {
    const childId = active.conversationId as ConversationId;
    const identity = await tx.doc(DelegateChildIdentityDoc, childId);
    const child = await tx.conversation(childId);
    if (Object.keys(identity).length !== 3 || identity.mainId !== mainId || !Number.isSafeInteger(identity.ownerId) ||
        identity.ownerId === null || identity.ownerId < 1 || identity.handoffId !== id || id !== `delegate:${identity.ownerId}` ||
        child?.owner?.conversationId !== mainId || child.owner.taskId !== identity.ownerId) {
      throw new Error("Delegate child ownership conflicts with the checkpoint; its inputs were preserved.");
    }
    const owner = await tx.task(identity.ownerId as TaskId);
    if (owner?.kind !== "pi.tool" || owner.conversationId !== mainId) {
      throw new Error("Delegate owner is unavailable; its inputs were preserved.");
    }
    const initial = await delegateInitialInput(tx, childId, identity.ownerId as TaskId, id);
    await capture(childId, initial);
  }
  inputs.sort((left, right) => left.submissionId - right.submissionId);
  if (new Set(inputs.map((input) => input.submissionId)).size !== inputs.length) {
    throw new Error("Duplicate input identity in main; all inputs were preserved.");
  }
  if (previous !== undefined) {
    const captured = new Map(previous.inputs.map((input) => [input.submissionId, input]));
    for (const input of inputs) {
      if (!isDeepStrictEqual(input, captured.get(input.submissionId))) {
        throw new Error("A live or queued input changed after checkpoint; all inputs were preserved.");
      }
    }
    // Inputs withdrawn by an earlier abort need not still be live or queued;
    // their original checkpoint remains the only retained content.
    return;
  }
  saved.handoffId = id;
  saved.inputs = inputs;
}
