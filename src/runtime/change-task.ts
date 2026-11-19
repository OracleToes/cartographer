import { defineTask } from "@earendil-works/pi-durable";

import { BrainStore } from "./brain-store.js";
import { applyApprovedChange, type ChangeApplyResult } from "./change-apply.js";

export const PATCH_APPLY_TASK_NAME = "carto.apply-approved-patch";

type PatchApplyInput = { changeId: string };
type PatchApplyState = { phase: "apply" };

/** A Pi Durable task that resumes a person-approved patch after a restart. */
export function createPatchApplyTask(projectRoot: string, brain: BrainStore) {
  return defineTask<PatchApplyInput, PatchApplyState, { changeId: string; result: ChangeApplyResult }>({
    name: PATCH_APPLY_TASK_NAME,
    version: 1,
    initial: (input) => {
      if (input.changeId === "") throw new RangeError("A patch apply task needs a change id.");
      return { phase: "apply" };
    },
    phases: {
      apply: async (task, runtime, context) => {
        const result = await applyApprovedChange(projectRoot, brain, task.input.changeId);
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: { changeId: task.input.changeId, result } } }),
          context,
        );
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", result: { changeId: task.input.changeId, result: "skipped" } } }),
        context,
      );
    },
  });
}
