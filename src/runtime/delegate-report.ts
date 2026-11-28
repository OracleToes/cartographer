/**
 * A report endpoint for an explicitly selected delegate conversation. Pi owns
 * the tool call and validates its schema; Carto only connects it to its durable
 * handoff. This extension is not installed in ordinary direct-mode sessions.
 */
import { awaitWithContext } from "@earendil-works/chord/context";
import { defineExtension, defineTool, GenerationTask, hook, type ConversationId } from "@earendil-works/pi-durable";
import { obj, oneOf, str } from "@earendil-works/pi-schema";
import { DelegationDoc, returnDelegation, type DelegateReport } from "./delegation-record.js";
import { DelegateChildIdentityDoc } from "./delegate-conversation.js";
import { requireSoleDelegateCall } from "./delegate-round.js";

const fields = ["status", "findings", "changes", "checks", "uncertainty", "remaining", "mainMessage"] as const;

export const DelegateReportTool = defineTool({
  name: "delegate_report",
  description: "Return your work to main. Distinguish findings, actual changes and checks, uncertainty, remaining work, and what main must know. Use blocked when unrequested behavior must change; do not invent work or checks.",
  parameters: obj({
    status: oneOf(["done", "partial", "blocked", "unverified"] as const),
    findings: str({ minLength: 1 }),
    changes: str({ minLength: 1 }),
    checks: str({ minLength: 1 }),
    uncertainty: str({ minLength: 1 }),
    remaining: str({ minLength: 1 }),
    mainMessage: str({ minLength: 1 }),
  }),
  replay: "safe",
  callers: ["model"],
  execute: async (args, api, context) => {
    const report: DelegateReport = { ...args };
    await api.commit(async (tx) => {
      await requireSoleDelegateCall(tx, api.conversationId, api.taskId, api.callId, "delegate_report");
      const child = await tx.conversation(api.conversationId);
      if (child?.owner === undefined) throw new Error("A delegate report requires a task-owned conversation.");
      const owner = await tx.task(child.owner.taskId);
      if (owner === undefined || owner.conversationId !== child.owner.conversationId) {
        throw new Error("The delegate's owning task is unavailable; the report was not recorded.");
      }
      const record = await tx.doc(DelegationDoc, child.owner.conversationId);
      const active = record.active;
      if (active === null || active.phase === "prepared" || active.phase === "ending" || active.conversationId !== child.id) {
        throw new Error("The delegate does not match the active handoff; the report was not recorded.");
      }
      if (active.phase === "returned") {
        const result = active.result;
        if (result.kind !== "delegate" || fields.some((field) => result.report[field] !== report[field])) {
          throw new Error("The handoff has already returned a different result; it was preserved.");
        }
        return;
      }
      returnDelegation(record, active.input.id, { kind: "delegate", report });
    }, context);
    return { output: [{ type: "text" as const, text: "Report recorded for main." }], control: { terminate: true } };
  },
});

/** The host must install and retain this extension for every selected child. */
export function createDelegateReportExtension(onBlocked?: () => void) {
  return defineExtension({
    name: "carto.delegate-report",
    tools: [DelegateReportTool],
    hooks: [hook(GenerationTask, {
      beforeRequest: async (_request, api, context) => {
        let allowed = false;
        try {
          const identity = await api.snapshot(DelegateChildIdentityDoc, api.conversationId, context);
          if (identity !== undefined && Object.keys(identity).length === 3 &&
              Number.isSafeInteger(identity.mainId) && (identity.mainId ?? 0) > 0 &&
              Number.isSafeInteger(identity.ownerId) && (identity.ownerId ?? 0) > 0 &&
              typeof identity.handoffId === "string" && identity.handoffId.length > 0) {
            const record = await api.snapshot(DelegationDoc, identity.mainId as ConversationId, context);
            allowed = record?.active?.phase === "running" && record.active.input.id === identity.handoffId &&
              record.active.conversationId === api.conversationId;
          }
        } catch (error) {
          // Pi reports and skips throwing hooks; an uncertain read must hold.
          if (context.abortSignal?.aborted) throw error;
        }
        if (allowed) return;
        try { onBlocked?.(); } catch { /* notification cannot bypass the barrier */ }
        await awaitWithContext(new Promise<void>(() => {}), context);
      },
    })],
  });
}

export const DelegateReportExtension = createDelegateReportExtension();
