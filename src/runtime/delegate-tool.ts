/**
 * A dormant Pi tool that drives a single task-owned child. The host must
 * collapse main on return and provide controls and recovery before installing
 * it in an orchestration session.
 */
import { defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, oneOf, str } from "@earendil-works/pi-schema";
import { ensureDelegateConversation } from "./delegate-conversation.js";
import { DelegateReportExtension, DelegateReportTool } from "./delegate-report.js";
import { DelegationDoc, prepareDelegation, returnDelegation, type DelegateRole } from "./delegation-record.js";
import { requireSoleDelegateCall } from "./delegate-round.js";

type Profile = { extensions: readonly Extension[]; tools: readonly ToolRegistration[] };

/** The host passes its existing, explicitly selected tool registrations. */
export function createDelegateTool(options: { cwd: string; profiles?: Partial<Record<DelegateRole, Profile>> }): ToolRegistration {
  return defineTool({
    name: "delegate",
    description: "Delegate one focused capture, implementation, or verification task. Supply the instruction and done-when. The delegate returns a report to main.",
    parameters: obj({
      role: oneOf(["capture", "implementation", "verification"] as const),
      instruction: str({ minLength: 1 }),
      doneWhen: str({ minLength: 1 }),
    }),
    replay: "safe",
    callers: ["model"],
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const model = (await api.agent(context)).model;
      if (model === undefined) throw new Error("A delegate requires a selected model.");
      const profile = options.profiles?.[args.role] ?? { extensions: [], tools: [] };
      if (profile.tools.some((tool) => tool.name === DelegateReportTool.name) ||
          profile.extensions.some((extension) => extension.name === DelegateReportExtension.name)) {
        throw new Error("The delegate report extension is supplied by Carto, not the role profile.");
      }
      if (args.role === "capture" && profile.tools.some((tool) => !["read", "search", "grep", "glob"].includes(tool.name))) {
        throw new Error("Capture can only select read/search tools.");
      }
      const id = `delegate:${api.taskId}`;
      const input = { id, role: args.role, instruction: args.instruction, doneWhen: args.doneWhen };
      const alreadyReturned = await api.commit(async (tx) => {
        await requireSoleDelegateCall(tx, api.conversationId, api.taskId, api.callId, "delegate");
        const record = await tx.doc(DelegationDoc, api.conversationId);
        if (record.active === null) prepareDelegation(record, input);
        else if (record.active.input.id !== id || record.active.input.role !== input.role ||
                 record.active.input.instruction !== input.instruction || record.active.input.doneWhen !== input.doneWhen) {
          throw new Error("Another delegation is already recorded; it was preserved.");
        }
        return record.active?.phase === "returned";
      }, context);
      if (!alreadyReturned) {
        const guidance = args.role === "capture"
          ? "Investigate existing behavior, dependencies, impacts and unknowns. Do not modify the project or specification; report evidence with source references."
          : args.role === "implementation"
            ? "Work on the requested implementation, not the project specification. If an unrequested behavior must change, stop and report blocked; preserve partial work."
            : "Verify the focused task and report the checks actually performed, results, gaps and uncertainty.";
        const childId = await api.commit((tx) => ensureDelegateConversation(tx, api.conversationId, api.taskId, id, {
          model, cwd: options.cwd,
          instructions: `${guidance} Return via delegate_report. Do not invent findings, changes or checks.`,
          extensions: [...profile.extensions, DelegateReportExtension],
          tools: [...profile.tools, DelegateReportTool],
        }), context);
        await api.details({ conversationId: childId }, context);
        const child = await api.conversation(childId, context);
        if (child === undefined) throw new Error("The delegate conversation is unavailable; the handoff was preserved.");
        const submitted = await child.submit({
          type: "input", content: JSON.stringify(input), requestId: `carto.delegate-input:${api.taskId}`,
        }, context);
        const settled = await submitted.wait(context);
        await api.commit(async (tx) => {
          const record = await tx.doc(DelegationDoc, api.conversationId);
          if (record.active === null || record.active.input.id !== id) throw new Error("The delegation handoff changed; it was preserved.");
          if (record.active.phase !== "returned") {
            const explanation = settled.status === "unanswered"
              ? `Delegate ended without a report (${settled.reason}).`
              : "Delegate ended without a report.";
            returnDelegation(record, id, { kind: "failure", explanation });
          }
        }, context);
      }
      return { output: [{ type: "text" as const, text: "Delegation returned; main must collapse and reconcile the handoff." }], control: { terminate: true } };
    },
  });
}
