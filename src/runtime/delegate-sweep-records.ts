/** Dormant Brain-record and archive-mark planning for a delegate return. */
import { applyArchiveMarks, type Archive, type ArchivedItem, type IncomingItem } from "../domain/archive.js";
import { applyWrite, type BrainWrite } from "../domain/brain.js";
import type { CartoBrain } from "../domain/records.js";
import { writeBackOf } from "./brain-store.js";
import { prepareCollapseRecordMarks } from "./collapse.js";

type Step = { write: BrainWrite; now: number };

/**
 * Compose ordinary collapse record-mark and archive-restore semantics into a
 * prospective return plan. The returned writes and incoming items are suitable
 * only for further reconciliation; this performs no transaction, archive grace
 * advancement, destination placement or source deletion. Existing archive and
 * incoming IDs must not collide, and restoring a record over any current Brain
 * record is refused rather than overwriting it. Pending ephemeral restores are
 * returned separately: child destinations and recovery remain unresolved.
 *
 * The caller must provide authentic, unchanged snapshots and seal Pi, Brain,
 * archive, projection and project writers until a future journalled commit.
 * This does not do Atlas freshness or establish a complete collapse plan.
 */
export function prepareReturnSweepRecords(
  brain: CartoBrain, archive: Archive, incoming: readonly IncomingItem[], precedingWrites: readonly Step[], now: number,
): { writes: Step[]; incoming: IncomingItem[]; nextBrain: CartoBrain; restored: ArchivedItem[]; pendingEphemeralRestores: ArchivedItem[] } {
  if (archive.version !== 1 || !Array.isArray(archive.items)) throw new Error("Invalid return-sweep archive; the source was preserved.");
  const identities = new Set<string>();
  for (const [kind, records] of [["chat", brain.chat], ["ledger", brain.ledger], ["atlas", brain.atlas]] as const) {
    for (const record of records) {
      const key = `${kind}:${record.id}`;
      if (typeof record.id !== "string" || !record.id || identities.has(key)) throw new Error("Ambiguous Brain record identity; the source was preserved.");
      identities.add(key);
    }
  }
  if (precedingWrites.some(({ write }) => !["ephemeral.delete-mark", "ephemeral.unpin", "ephemeral.pin", "file.stale"].includes(write.kind))) {
    throw new Error("Unexpected preceding return-sweep write; the source was preserved.");
  }
  const marks = prepareCollapseRecordMarks(brain, now);
  const combined = [...marks.incoming, ...incoming];
  const archiveIds = new Set<string>();
  for (const item of archive.items) {
    if (typeof item.id !== "string" || !item.id || archiveIds.has(item.id)) throw new Error("Ambiguous archive identity; the source was preserved.");
    archiveIds.add(item.id);
  }
  for (const item of combined) {
    if (typeof item.id !== "string" || !item.id || archiveIds.has(item.id)) throw new Error("A return-sweep archive identity conflicts; the source was preserved.");
    archiveIds.add(item.id);
  }
  const restored = applyArchiveMarks(archive).restored;
  const restoredIdentities = new Set<string>();
  for (const item of restored) {
    if (item.layer === "ephemeral") {
      if (item.ephemeral === undefined || item.record !== undefined) throw new Error("Invalid pending ephemeral restore; the source was preserved.");
      continue;
    }
    const record = item.record;
    if (item.layer !== "record" || item.ephemeral !== undefined || record === undefined || !["chat", "ledger", "atlas"].includes(record.kind) ||
        record.value === null || typeof record.value !== "object" || typeof record.value.id !== "string" || !record.value.id) {
      throw new Error("Invalid archived record restore; the source was preserved.");
    }
    const key = `${record.kind}:${record.value.id}`;
    if (identities.has(key) || restoredIdentities.has(key)) throw new Error("An archived record restore conflicts with the Brain; the source was preserved.");
    restoredIdentities.add(key);
  }
  const writes = [...precedingWrites, ...marks.writes];
  let nextBrain = brain;
  for (const step of writes) nextBrain = applyWrite(nextBrain, step.write, step.now);
  for (const item of restored) {
    const write = writeBackOf(item);
    if (write !== undefined) nextBrain = applyWrite(nextBrain, write, now);
  }
  return { writes, incoming: combined, nextBrain, restored, pendingEphemeralRestores: restored.filter((item) => item.layer === "ephemeral") };
}
