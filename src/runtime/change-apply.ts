import { BrainStore } from "./brain-store.js";
import { applyApprovedPatch, isApprovedPatchApplied } from "./patch.js";

export type ChangeApplyResult = "applied" | "conflicted" | "skipped";

/** Product-owned work performed by a durable apply task. */
export async function applyApprovedChange(projectRoot: string, brainStore: BrainStore, changeId: string): Promise<ChangeApplyResult> {
  const change = (await brainStore.read()).changes.find((candidate) => candidate.id === changeId);
  if (change === undefined || change.status !== "approved") return "skipped";

  await brainStore.apply({ kind: "activity.set", activity: { kind: "applying-change", detail: change.id } });
  try {
    const alreadyApplied = await isApprovedPatchApplied(projectRoot, change);
    if (!alreadyApplied) await applyApprovedPatch(projectRoot, change);
    await brainStore.apply({
      kind: "change.upsert",
      change: { ...change, status: "applied", resolvedAt: Date.now() },
    });
    await brainStore.apply({ kind: "activity.set", activity: { kind: "idle", detail: null } });
    return "applied";
  } catch (error) {
    await brainStore.apply({
      kind: "change.upsert",
      change: { ...change, status: "conflicted", resolvedAt: Date.now() },
    });
    await brainStore.apply({
      kind: "activity.set",
      activity: { kind: "error", detail: error instanceof Error ? error.message : String(error) },
    });
    return "conflicted";
  }
}
