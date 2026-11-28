/** Dormant main-only request barrier. The host must abort held work and collapse. */
import { awaitWithContext } from "@earendil-works/chord/context";
import { defineExtension, GenerationTask, hook, LiveDoc } from "@earendil-works/pi-durable";
import { DelegateMainBarrierDoc, DelegationDoc, parseReturnedDelegation } from "./delegation-record.js";
import { delegationReturnId, renderDelegationReturn } from "./delegate-return.js";

/** Install in main only; child agents must not select this extension. */
export function createDelegateMainBarrier(onBlocked?: () => void) {
  return defineExtension({
    name: "carto.delegate-main-barrier",
    hooks: [hook(GenerationTask, {
      beforeRequest: async (request, api, context) => {
        let allowed = false;
        try {
          const record = await api.snapshot(DelegationDoc, api.conversationId, context);
          const marker = await api.snapshot(DelegateMainBarrierDoc, api.conversationId, context);
          if (record === undefined || record.active === null) {
            allowed = marker === undefined || (marker.sourceId === null && marker.admittedId === null && marker.submissionId === null);
          } else if (record.active?.phase === "returned" && marker?.sourceId === null) {
            const checked = parseReturnedDelegation(JSON.stringify(record)).active;
            if (checked?.phase === "returned") {
              const id = delegationReturnId(checked);
              const live = await api.snapshot(LiveDoc, api.conversationId, context);
              allowed = marker.admittedId === id && marker.submissionId !== null &&
                live?.run?.taskId === api.taskId && live.run.inputs.some((submission) => submission === marker.submissionId) &&
                request.messages.some((message) => message.role === "user" && message.content === renderDelegationReturn(checked));
            }
          }
        } catch (error) {
          // Pi skips throwing hooks. Never turn a read/validation failure into
          // permission to send a request; cancellation must still propagate.
          if (context.abortSignal?.aborted) throw error;
        }
        if (allowed) return;
        try { onBlocked?.(); } catch { /* notification cannot bypass the barrier */ }
        await awaitWithContext(new Promise<void>(() => {}), context);
      },
    })],
  });
}
