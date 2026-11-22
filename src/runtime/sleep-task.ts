/**
 * The timed rest (§10).
 *
 * A rest has to survive a restart, so the wait lives in the store and not in a
 * host's timer. `sleep` creates one of these tasks when it is given a time; the
 * task commits a real sleep on itself, and a reopened harness wakes it with
 * everything intact.
 *
 * It belongs to the conversation, not to the run that asked for it. That is the
 * whole point: a run that waited on its own rest would be a conversation that
 * could not hear the person until the rest was over, and §10 says a message
 * ends a rest early. So the run ends, the conversation goes idle, and the rest
 * goes on sleeping beside it.
 *
 * When the rest is over the task puts the next turn in the conversation — the
 * state block, which is how any turn starts (§5.7). If the person wrote before
 * that, their message was the turn and the rest stays quiet (§10: "A rest that
 * is over is over ... no second start").
 */
import { defineTask } from "@earendil-works/pi-durable";

import { STATE_BLOCK_MARKER } from "../domain/state-block.js";

export const SleepTask = defineTask<
  { seconds: number },
  { phase: "rest" | "wake" },
  { restedAt: number },
  object
>({
  name: "carto.sleep",
  version: 1,
  initial: () => ({ phase: "rest" }),
  phases: {
    rest: async (task, runtime, context) => {
      const until = runtime.now() + task.input.seconds * 1000;
      await runtime.commit(
        () => ({ status: "sleeping" as const, until, checkpoint: { phase: "wake" as const } }),
        context,
      );
    },
    wake: async (_task, runtime, context) => {
      const conversation = await runtime.conversation(runtime.conversationId, context);
      if (conversation !== undefined) {
        // A queued item is placed at the next boundary; admitted while the
        // conversation is idle, it starts the turn at once. Either way this is
        // one turn and it begins from the state block, not from a word.
        await conversation.submit({ type: "input", content: STATE_BLOCK_MARKER, whenBusy: "followUp" }, context);
      }
      await runtime.commit(
        () => ({
          status: "terminal" as const,
          outcome: { status: "completed" as const, result: { restedAt: runtime.now() } },
        }),
        context,
      );
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal" as const, outcome: { status: "aborted" as const, reason: "the host stopped the rest" } }),
      context,
    );
  },
});
