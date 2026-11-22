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
import { defineDoc, defineTask } from "@earendil-works/pi-durable";

/** The one timed rest allowed to resume this conversation. */
export const RestDoc = defineDoc<{ active: number | null; legacyAllowed: boolean }>({
  kind: "carto.rest",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ active: null, legacyAllowed: true }),
  checkpointWhen: () => true,
});

/** The tool call's durable receipt prevents a replay from creating a second rest. */
export const RestCallDoc = defineDoc<{ handled: boolean }>({
  kind: "carto.rest-call",
  version: 1,
  scope: "task",
  initial: () => ({ handled: false }),
  checkpointWhen: () => true,
});

import { STATE_BLOCK_MARKER } from "../domain/state-block.js";

export const SleepTask = defineTask<
  { seconds: number; tracked?: boolean },
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
    wake: async (task, runtime, context) => {
      const conversation = await runtime.conversation(runtime.conversationId, context);
      await runtime.commit(async (tx) => {
        const rest = await tx.doc(RestDoc, runtime.conversationId);
        // Legacy tasks created before RestDoc existed may still be sleeping
        // when the program is upgraded. A person's message invalidates them too.
        const active = task.input.tracked === true ? rest.active === runtime.taskId : rest.legacyAllowed;
        if (active && conversation !== undefined) {
          // Admission and completion are the same durable commit: neither a
          // crash nor a retry can commit one without the other.
          await conversation.submit(tx, { type: "input", content: STATE_BLOCK_MARKER, whenBusy: "followUp" });
        }
        if (active) {
          rest.active = null;
          rest.legacyAllowed = false;
        }
        return {
          status: "terminal" as const,
          outcome: { status: "completed" as const, result: { restedAt: runtime.now() } },
        };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal" as const, outcome: { status: "aborted" as const, reason: "the host stopped the rest" } }),
      context,
    );
  },
});
