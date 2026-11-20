import type { Context } from "@earendil-works/chord/context";
import { defineTask } from "@earendil-works/pi-durable";
import type { TaskRuntime } from "@earendil-works/pi-durable";

import { BrainStore } from "./brain-store.js";
import { parseTimeWakeCondition } from "./wake.js";

export interface TimeWakeInput {
  wakeId: string;
  until: number;
}

type TimeWakeState = { phase: "wait" } | { phase: "deliver" };
type TimeWakeRuntime = TaskRuntime<TimeWakeInput, TimeWakeState, { wakeId: string }, object>;

export const TIME_WAKE_TASK_NAME = "carto.time-wake";

/** A Pi Durable sleep task. Its durable checkpoint survives a process restart. */
export function createTimeWakeTask(brain: BrainStore) {
  return defineTask<TimeWakeInput, TimeWakeState, { wakeId: string }>({
    name: TIME_WAKE_TASK_NAME,
    version: 1,
    initial: (input) => {
      if (!Number.isFinite(input.until) || input.until <= 0) throw new RangeError("A time wake needs a valid time.");
      return { phase: "wait" };
    },
    phases: {
      wait: async (task, runtime, context) => {
        if (task.input.until > runtime.now()) {
          await runtime.sleepUntil(task.input.until, { phase: "deliver" }, context);
          return;
        }
        await deliverWake(task.input.wakeId, task.input.until, brain, runtime, context);
      },
      deliver: async (task, runtime, context) => {
        await deliverWake(task.input.wakeId, task.input.until, brain, runtime, context);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", result: { wakeId: task.input.wakeId } } }),
        context,
      );
    },
  });
}

async function deliverWake(
  wakeId: string,
  until: number,
  brain: BrainStore,
  runtime: TimeWakeRuntime,
  context: Context,
): Promise<void> {
  const current = (await brain.read()).wakes.find((wake) => wake.id === wakeId);
  if (current?.status === "armed" && current.kind === "time" && parseTimeWakeCondition(current.condition) === until) {
    await brain.apply({ kind: "wake.upsert", wake: { ...current, status: "ready" } });
  }
  await runtime.commit(
    () => ({ status: "terminal", outcome: { status: "completed", result: { wakeId } } }),
    context,
  );
}
