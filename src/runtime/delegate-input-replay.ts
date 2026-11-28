/** Dormant staging of preserved main inputs before the delegate return is answered. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, InboxDoc, LiveDoc, type Conversation, type ConversationId, type EntryId, type SubmissionId, type Tx, type UserInput } from "@earendil-works/pi-durable";
import { DelegateInputCheckpointDoc, parseInputCheckpoint, type InputCheckpoint } from "./delegate-inputs.js";
import { DelegateMainBarrierDoc, DelegationDoc } from "./delegation-record.js";

type ReplayReceipt = { handoffId: string | null; digest: string | null; submissions: number[] };
export const DelegateInputReplayDoc = defineDoc<ReplayReceipt>({
  kind: "carto.delegate-input-replay", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ handoffId: null, digest: null, submissions: [] }), checkpointWhen: () => true,
});

export function clearedInputCheckpoint(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as InputCheckpoint;
  return Object.keys(value).length === 2 && record.handoffId === null && Array.isArray(record.inputs) && record.inputs.length === 0;
}
export function clearedInputReplay(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as ReplayReceipt;
  return Object.keys(value).length === 3 && record.handoffId === null && record.digest === null && Array.isArray(record.submissions) && record.submissions.length === 0;
}

const digestOf = (checkpoint: InputCheckpoint) => createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex");
const requestId = (digest: string, submissionId: number) => `carto.delegate-replay:${digest}:${submissionId}`;

/** Check the receipt against actual committed Pi writes and their user entries. */
async function validateReceipt(tx: Tx, mainId: ConversationId, id: string): Promise<{ checkpoint: InputCheckpoint; receipt: ReplayReceipt; digest: string }> {
  const checkpoint = await tx.doc(DelegateInputCheckpointDoc, mainId);
  parseInputCheckpoint(JSON.stringify(checkpoint), id);
  const receipt = await tx.doc(DelegateInputReplayDoc, mainId);
  const digest = digestOf(checkpoint);
  if (Object.keys(receipt).length !== 3 || receipt.handoffId !== id || receipt.digest !== digest || !Array.isArray(receipt.submissions) || receipt.submissions.length > checkpoint.inputs.length) {
    throw new Error("Delegate input staging receipt conflicts with the checkpoint; both were preserved.");
  }
  for (let index = 0; index < receipt.submissions.length; index++) {
    const input = checkpoint.inputs[index]!;
    const recorded = receipt.submissions[index]!;
    if (!Number.isSafeInteger(recorded) || recorded <= 0) throw new Error("Invalid delegate input staging receipt; it was preserved.");
    const submission = await tx.submission(recorded as SubmissionId);
    if (submission?.type !== "write" || submission.conversationId !== mainId || submission.status !== "done" || submission.requestId !== requestId(digest, input.submissionId)) {
      throw new Error("A staged delegate input submission conflicts with its receipt; it was preserved.");
    }
    const entry = await tx.entry(submission.entry);
    const message = entry?.model?.[0];
    if (entry?.conversationId !== mainId || entry.kind !== input.entry.kind || JSON.stringify(entry.data) !== JSON.stringify(input.entry.data) ||
        entry.model?.length !== 1 || message?.role !== "user" || JSON.stringify(message.content) !== JSON.stringify(input.content)) {
      throw new Error("A staged delegate input entry conflicts with its checkpoint; it was preserved.");
    }
  }
  return { checkpoint, receipt, digest };
}

/** Require a complete, checked staging whenever a checkpoint is present. */
export async function requireStagedDelegateInputs(tx: Tx, mainId: ConversationId, id: string): Promise<boolean> {
  const checkpoint = await tx.doc(DelegateInputCheckpointDoc, mainId);
  const receipt = await tx.doc(DelegateInputReplayDoc, mainId);
  if (clearedInputCheckpoint(checkpoint)) {
    if (!clearedInputReplay(receipt)) throw new Error("Delegate input staging lacks its checkpoint; it was preserved.");
    return false;
  }
  const checked = await validateReceipt(tx, mainId, id);
  if (checked.receipt.submissions.length !== checked.checkpoint.inputs.length) {
    throw new Error("Delegate input staging is incomplete; the checkpoint was preserved.");
  }
  return true;
}

/** Bounds and receipt for a Pi-derived context check; not a writer lock. */
export type StagedDelegateContext = { tail: EntryId | undefined; head: EntryId | undefined; fingerprint: string };

/**
 * Check that every staged input is actually still visible, unedited, in Pi's
 * derived context. A raw entry and a done write submission alone are not proof:
 * a later Pi edit or head reset can omit or replace their contributions. The
 * caller must seal all destination context writers from staging through the
 * answer and acknowledgement, and prevent other request hooks changing it.
 * Bounds and receipt are checked again on the transaction line; they detect
 * changes but cannot lock external writers or prove what the model received.
 */
export async function captureStagedDelegateContext(main: Conversation, id: string, context: Context): Promise<StagedDelegateContext | undefined> {
  const before = await main.commit(async (tx) => {
    if (!await requireStagedDelegateInputs(tx, main.id, id)) return undefined;
    const checked = await validateReceipt(tx, main.id, id);
    const entries: EntryId[] = [];
    for (const recorded of checked.receipt.submissions) {
      const submission = await tx.submission(recorded as SubmissionId);
      if (submission?.type !== "write" || submission.status !== "done") throw new Error("A staged delegate input is unavailable; it was preserved.");
      entries.push(submission.entry);
    }
    return {
      tail: await tx.latestEntryId(main.id), head: (await tx.latestHeadMarker(main.id))?.id,
      fingerprint: JSON.stringify([checked.checkpoint, checked.receipt]), entries,
      inputs: JSON.parse(JSON.stringify(checked.checkpoint.inputs)) as InputCheckpoint["inputs"],
    };
  }, context);
  if (before === undefined) return undefined;
  const view = await main.context(context, before.tail === undefined ? undefined : { at: before.tail });
  if (view.head?.id !== before.head || view.entries.length !== view.contributions.length) {
    throw new Error("Staged delegate input context changed; it was preserved.");
  }
  for (const [index, entryId] of before.entries.entries()) {
    const positions = view.entries.flatMap((entry, position) => entry.id === entryId ? [position] : []);
    const contribution = positions.length === 1 ? view.contributions[positions[0]!] : undefined;
    const input = before.inputs[index]!;
    if (contribution?.length !== 1 || contribution[0]?.role !== "user" || !isDeepStrictEqual(contribution[0].content, input.content)) {
      throw new Error("A staged delegate input is absent or edited in the active context; it was preserved.");
    }
  }
  const proof = { tail: before.tail, head: before.head, fingerprint: before.fingerprint };
  await main.commit((tx) => requireStagedDelegateContext(tx, main.id, id, proof), context);
  return proof;
}

/** Recheck the captured Pi context's bounds and receipt on the commit line. */
export async function requireStagedDelegateContext(tx: Tx, mainId: ConversationId, id: string, proof: StagedDelegateContext | undefined): Promise<void> {
  if (proof === undefined) {
    if (await requireStagedDelegateInputs(tx, mainId, id)) throw new Error("Delegate input staging changed; it was preserved.");
    return;
  }
  if (!await requireStagedDelegateInputs(tx, mainId, id)) throw new Error("Delegate input staging changed; it was preserved.");
  const checked = await validateReceipt(tx, mainId, id);
  if (JSON.stringify([checked.checkpoint, checked.receipt]) !== proof.fingerprint ||
      await tx.latestEntryId(mainId) !== proof.tail || (await tx.latestHeadMarker(mainId))?.id !== proof.head) {
    throw new Error("Staged delegate input context changed; it was preserved.");
  }
}

/**
 * Stage at most one input. A false result means staging is complete. The host
 * must seal other admission and ensure no work is running while this operates;
 * submit(tx) enables Pi scheduling even though these writes start no run.
 */
export async function stageNextDelegateInput(main: Conversation, id: string, context: Context): Promise<boolean> {
  return main.commit(async (tx) => {
    const handoff = (await tx.doc(DelegationDoc, main.id)).active;
    const barrier = await tx.doc(DelegateMainBarrierDoc, main.id);
    if (handoff?.phase !== "returned" || handoff.input.id !== id || barrier.sourceId !== null || barrier.admittedId !== null || barrier.submissionId !== null) {
      throw new Error("Delegate input staging requires the matching unadmitted destination return.");
    }
    const live = await tx.doc(LiveDoc, main.id);
    const inbox = await tx.doc(InboxDoc, main.id);
    if (live.run !== undefined || inbox.items.length !== 0) throw new Error("Main must be idle with an empty inbox before staging delegate inputs.");
    const checkpoint = await tx.doc(DelegateInputCheckpointDoc, main.id);
    parseInputCheckpoint(JSON.stringify(checkpoint), id);
    const receipt = await tx.doc(DelegateInputReplayDoc, main.id);
    const digest = digestOf(checkpoint);
    if (clearedInputReplay(receipt)) {
      receipt.handoffId = id;
      receipt.digest = digest;
    }
    const checked = await validateReceipt(tx, main.id, id);
    const input = checked.checkpoint.inputs[checked.receipt.submissions.length];
    if (input === undefined) return false;
    const key = requestId(digest, input.submissionId);
    if (await tx.submissionByRequest(main.id, key) !== undefined) throw new Error("Delegate input request identity is already in use; it was preserved.");
    const submission = await main.submit(tx, {
      type: "write", requestId: key,
      entry: {
        kind: input.entry.kind,
        ...(input.entry.data === undefined ? {} : { data: input.entry.data }),
        model: [{ role: "user", content: input.content as unknown as UserInput, timestamp: Date.now() }],
      },
    });
    receipt.submissions.push(submission);
    return true;
  }, context);
}
