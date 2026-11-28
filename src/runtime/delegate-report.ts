/**
 * A report endpoint for an explicitly selected delegate conversation. Pi owns
 * the tool call and validates its schema; Carto only connects it to its durable
 * handoff. This extension is not installed in ordinary direct-mode sessions.
 */
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, oneOf, str } from "@earendil-works/pi-schema";
import { DelegationDoc, returnDelegation, type DelegateReport } from "./delegation-record.js";
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
      if (active === null || active.phase === "prepared" || active.conversationId !== child.id) {
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

export const DelegateReportExtension = defineExtension({ name: "carto.delegate-report", tools: [DelegateReportTool] });
