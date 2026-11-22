/** Queue the state block after a tree-terminated run, using Pi's durable task. */
import { defineTask } from "@earendil-works/pi-durable";

import { STATE_BLOCK_MARKER } from "../domain/state-block.js";

export const TreeReadTask = defineTask<{}, { phase: "queue" }, {}, object>({
  name: "carto.tree-read",
  version: 1,
  initial: () => ({ phase: "queue" }),
  phases: {
    queue: async (_task, runtime, context) => {
      const conversation = await runtime.conversation(runtime.conversationId, context);
      await runtime.commit(async (tx) => {
        // Admission and completion are atomic: a restart cannot queue the
        // continuation twice or lose it after marking the task complete.
        if (conversation !== undefined) {
          await conversation.submit(tx, { type: "input", content: STATE_BLOCK_MARKER, whenBusy: "followUp" });
        }
        return { status: "terminal" as const, outcome: { status: "completed" as const, result: {} } };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal" as const, outcome: { status: "aborted" as const } }),
      context,
    );
  },
});
