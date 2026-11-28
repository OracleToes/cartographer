/** Dormant source-generation checkpoint for inputs before delegate recovery aborts main. */
import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc, InboxDoc, LiveDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { DelegateMainBarrierDoc, DelegationDoc } from "./delegation-record.js";

type CapturedInput = {
  submissionId: number;
  placement: "placed" | "queued";
  whenBusy: "steer" | "followUp";
  content: JsonValue;
  entry: { kind: string; data?: JsonValue };
};
type InputCheckpoint = { handoffId: string | null; inputs: CapturedInput[] };

export const DelegateInputCheckpointDoc = defineDoc<InputCheckpoint>({
  kind: "carto.delegate-input-checkpoint", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ handoffId: null, inputs: [] }), checkpointWhen: () => true,
});

/**
 * Call inside the Pi transaction before abort. The host must seal input
 * admission through capture and recovery; this checkpoint is not a lock.
 * It deliberately has no clearing operation until transfer/replay exists.
 */
export async function checkpointDelegateInputs(tx: Tx, mainId: ConversationId, id: string): Promise<void> {
  const active = (await tx.doc(DelegationDoc, mainId)).active;
  const barrier = await tx.doc(DelegateMainBarrierDoc, mainId);
  const saved = await tx.doc(DelegateInputCheckpointDoc, mainId);
  if (active?.input.id !== id || (active.phase !== "ending" && active.phase !== "returned") || barrier.sourceId !== id) {
    throw new Error("Input checkpoint requires the matching source handoff; all inputs were preserved.");
  }
  if (saved.handoffId !== null) {
    if (saved.handoffId !== id) throw new Error("Another input checkpoint exists; it was preserved.");
    return;
  }
  const live = await tx.doc(LiveDoc, mainId);
  const inbox = await tx.doc(InboxDoc, mainId);
  if (live.run === undefined && (live.runFailure?.inputs.length ?? 0) > 0) {
    throw new Error("Main already ended without a checkpoint; its inputs were preserved for recovery.");
  }
  const inputs: CapturedInput[] = [];
  for (const submissionId of live.run?.inputs ?? []) {
    const submission = await tx.submission(submissionId);
    if (submission?.type !== "input" || submission.conversationId !== mainId || submission.status !== "placed") {
      throw new Error("A running main input is missing or inconsistent; it was preserved.");
    }
    const entry = await tx.entry(submission.entry);
    const message = entry?.model?.[0];
    if (entry?.conversationId !== mainId || entry.model?.length !== 1 || message?.role !== "user") {
      throw new Error("A running main input entry is missing or inconsistent; it was preserved.");
    }
    inputs.push({
      submissionId, placement: "placed", whenBusy: "followUp",
      content: JSON.parse(JSON.stringify(message.content)) as JsonValue,
      entry: { kind: entry.kind, ...(entry.data === undefined ? {} : { data: entry.data }) },
    });
  }
  for (const item of inbox.items) {
    if (item.mode === "write") throw new Error("A queued context write needs recovery; it was preserved.");
    const submission = await tx.submission(item.id);
    if (submission?.type !== "input" || submission.conversationId !== mainId || submission.status !== "queued") {
      throw new Error("A queued main input is missing or inconsistent; it was preserved.");
    }
    inputs.push({
      submissionId: item.id, placement: "queued", whenBusy: item.mode,
      content: item.content as JsonValue,
      entry: item.entry === undefined ? { kind: "pi.user" } : { kind: item.entry.kind, ...(item.entry.data === undefined ? {} : { data: item.entry.data }) },
    });
  }
  inputs.sort((left, right) => left.submissionId - right.submissionId);
  if (new Set(inputs.map((input) => input.submissionId)).size !== inputs.length) {
    throw new Error("Duplicate input identity in main; all inputs were preserved.");
  }
  saved.handoffId = id;
  saved.inputs = inputs;
}
