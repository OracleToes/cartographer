/** Dormant reconciliation of checkpointed inputs with a prospective return sweep. */
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ROOT_CONVERSATION_ID, type ConversationId, type Harness, type Tx } from "@earendil-works/pi-durable";
import { userText } from "../domain/chat-identity.js";
import { applyWrite } from "../domain/brain.js";
import { projectContext } from "../domain/projection.js";
import type { Archive } from "../domain/archive.js";
import type { CartoBrain, ChatRecord, PinnedEphemeral } from "../domain/records.js";
import { ephemeralItemId, generationPaths, prepareCollapseFreshness, prepareCollapsePinRefresh, readStoredDelegation, readStoredMainCheckpoint } from "./collapse.js";
import type { BrainStore } from "./brain-store.js";
import { DelegateInputCheckpointDoc, parseInputCheckpoint } from "./delegate-inputs.js";
import { delegateReturnChat, DelegateCaptureDoc, DelegateMainBarrierDoc, DelegationDoc } from "./delegation-record.js";
import { inspectReturnSweepInputs } from "./delegate-sweep-inputs.js";
import { captureReturnSweepHead } from "./delegate-sweep-head.js";
import { prepareReturnSweepRecords } from "./delegate-sweep-records.js";
import { prepareReturnSweepMarks, verifyReturnSweepFrozenPins, verifyReturnSweepReadPins } from "./delegate-sweep-marks.js";
import { captureReturnSweepViews, type ReturnSweepView } from "./delegate-sweep-view.js";
import { captureDelegateSourceSeal } from "./delegate-source-seal.js";

/**
 * Make a prospective plan, not a source-deletion permit. The views must come
 * from captureReturnSweepViews on this same source after all writers have
 * stopped. Keep admissions, work, withdrawals and other source and Brain
 * writers sealed while using the result. The Pi bounds checks do not lock them.
 *
 * Replay owns every checkpointed input, including Pi's done inputs; Pi status
 * alone cannot prove the delegation's work was reconciled. A currently active
 * placed input is excluded from the prospective archive by its exact entry ID,
 * not its text. A pin or deletion mark on that source item, or a mark on its
 * Chat record, is an unresolved conflict: preserve the source and checkpoint
 * rather than silently changing the person's action or replaying deleted data.
 * A withdrawn queued input is carried from the checkpoint without claiming its
 * content is independently recoverable from Pi.
 */
export async function prepareReturnSweepWithInputs(
  tx: Tx, mainId: ConversationId, id: string, views: readonly ReturnSweepView[], generation: string,
  brain: CartoBrain, headChatIds: ReadonlySet<string>, mainHeadPinIds: ReadonlySet<string>, now: number,
) {
  const inspected = await inspectReturnSweepInputs(tx, mainId, id, views);
  const checkpoint = parseInputCheckpoint(JSON.stringify(await tx.doc(DelegateInputCheckpointDoc, mainId)), id);
  const pendingChatIds = new Set<string>();
  const pendingEntries = new Set<number>();
  for (let index = 0; index < checkpoint.inputs.length; index++) {
    const input = checkpoint.inputs[index]!;
    const link = inspected[index]!;
    if (input.submissionId !== link.submissionId) throw new Error("Checkpoint input inspection changed; the source was preserved.");
    if (link.entryId !== null) {
      const itemId = ephemeralItemId(generation, link.entryId, "x0");
      if (brain.ephemera.some((pin) => pin.pinned !== undefined && pin.id === itemId) || (brain.ephemeralDeletes ?? []).includes(itemId)) {
        throw new Error("A checkpointed input has a pin or deletion mark; the source was preserved.");
      }
      if (link.active) pendingEntries.add(link.entryId);
    }
    const data = input.entry.data;
    if (input.entry.kind !== "carto.user" || data === null || typeof data !== "object" || Array.isArray(data) || !("chatRecordId" in data)) {
      if (brain.chat.some((record) => record.author === "user" && record.text === userText(input.content))) {
        throw new Error("A checkpointed input has ambiguous Chat identity; the source was preserved.");
      }
      continue;
    }
    const chatId = data.chatRecordId;
    if (typeof chatId !== "string" || chatId.length === 0 || pendingChatIds.has(chatId)) {
      throw new Error("A checkpointed Chat identity is invalid or repeated; the source was preserved.");
    }
    const records = brain.chat.filter((record) => record.id === chatId);
    if (records.length !== 1 || records[0]?.author !== "user" || records[0].text !== userText(input.content) || records[0].mark !== undefined) {
      throw new Error("A checkpointed Chat record conflicts or is marked; the source was preserved.");
    }
    // Do not allow a second active entry to claim the same record. In
    // particular, matching text in another conversation is not identity.
    for (const { view } of views) {
      for (const [position, entry] of view.entries.entries()) {
        const entryData = entry.data;
        if (entry.kind !== "carto.user" || entryData === null || typeof entryData !== "object" || Array.isArray(entryData) ||
            entryData.chatRecordId !== chatId || view.contributions[position]?.length === 0) continue;
        if (entry.id !== link.entryId) throw new Error("A checkpointed Chat identity is claimed by another active entry; the source was preserved.");
      }
    }
    pendingChatIds.add(chatId);
  }
  const plan = prepareReturnSweepMarks(views, generation, brain, headChatIds, mainHeadPinIds, now);
  const pendingItems = plan.incoming.filter((item) => pendingEntries.has(item.ephemeral?.source?.entryId ?? -1));
  for (const item of pendingItems) {
    const source = item.ephemeral?.source;
    if (source === undefined || item.ephemeral?.kind !== "personMessage" || item.id !== ephemeralItemId(generation, source.entryId, "x0")) {
      throw new Error("A checkpointed input has an unexpected archive part; the source was preserved.");
    }
  }
  for (const entryId of pendingEntries) {
    const inputIndex = inspected.findIndex((link) => link.entryId === entryId);
    const content = checkpoint.inputs[inputIndex]!.content;
    const text = userText(content);
    const hasImage = Array.isArray(content) && content.some((part) => part !== null && typeof part === "object" && !Array.isArray(part) && part.type === "image");
    const incoming = pendingItems.filter((item) => item.ephemeral?.source?.entryId === entryId);
    const duplicates = plan.chatDuplicates.filter((duplicate) => duplicate.entryId === entryId);
    if (incoming.length + duplicates.length !== (text.trim() || hasImage ? 1 : 0)) {
      throw new Error("A checkpointed input has ambiguous archive parts; the source was preserved.");
    }
  }
  return {
    ...plan,
    incoming: plan.incoming.filter((item) => !pendingEntries.has(item.ephemeral?.source?.entryId ?? -1)),
    chatDuplicates: plan.chatDuplicates.filter((duplicate) => !pendingEntries.has(duplicate.entryId)),
    checkpointInputs: inspected,
    pendingItems,
    pendingChatDuplicates: plan.chatDuplicates.filter((duplicate) => pendingEntries.has(duplicate.entryId)),
    pendingChatIds,
  };
}

/**
 * Extend the same prospective plan with ordinary collapse's file and pinned
 * read refresh. `mainHeadPins` must be taken from the verified source sidecar,
 * not inferred from the Brain; path aliases and transient handles that cannot
 * be proved identical are refused. Retained frozen items must match the Brain;
 * an unpinned frozen item blocks until it can be safely archived, unless it
 * has an explicit deletion mark. Seal Pi, Brain, project files, sidecar and
 * settings through planning and commit. These reads are not atomic and do not
 * bind the plan to the source seal, journal or head. This helper neither commits
 * a sweep nor permits source deletion.
 */
export async function prepareReturnSweepWithInputsAndPinRefresh(
  root: string, tx: Tx, mainId: ConversationId, id: string, views: readonly ReturnSweepView[], generation: string,
  brain: CartoBrain, headChatIds: ReadonlySet<string>, mainHeadPins: readonly PinnedEphemeral[], now: number,
) {
  verifyReturnSweepFrozenPins(brain, mainHeadPins);
  const plan = await prepareReturnSweepWithInputs(tx, mainId, id, views, generation, brain, headChatIds, new Set(mainHeadPins.map((pin) => pin.id)), now);
  verifyReturnSweepReadPins(brain, plan.pinned, mainHeadPins);
  const refresh = prepareCollapsePinRefresh(root, brain, now);
  return { ...plan, writes: [...plan.writes, ...refresh.writes], fileTexts: refresh.fileTexts };
}

/**
 * Capture the source head alongside the prospective plan. The returned digest
 * records both projection files, but does not authenticate hidden sidecar IDs
 * or bind the plan to a journal. The host must independently establish their
 * authenticity, seal writers and recheck the bytes before any eventual commit.
 */
export async function prepareReturnSweepWithSourceHead(
  root: string, tx: Tx, mainId: ConversationId, id: string, views: readonly ReturnSweepView[], generation: string,
  brain: CartoBrain, now: number,
) {
  const head = captureReturnSweepHead(root, generation, views);
  const plan = await prepareReturnSweepWithInputsAndPinRefresh(root, tx, mainId, id, views, generation, brain, new Set(head.chatIds), head.pins, now);
  return { ...plan, sourceHeadDigest: head.digest };
}

/**
 * Prepare the required main Chat message from a reported return. This is a
 * write for the sweep transaction, not an independent delivery or an
 * exactly-once protocol. The generation and handoff together define its ID;
 * an existing Brain or archive Chat identity is a conflict, not permission to
 * overwrite or duplicate it. Person-ended and failure returns have no report
 * message and must not be turned into invented delegate speech.
 */
export function prepareDelegateReturnChat(
  content: string, id: string, generation: string, brain: CartoBrain, archive: Archive, now: number,
): ChatRecord | undefined {
  const record = delegateReturnChat(content, id, generation, now);
  if (record === undefined) return undefined;
  if (brain.chat.some((item) => item.id === record.id) || archive.items.some((item) =>
    item.record?.kind === "chat" && item.record.value.id === record.id)) {
    throw new Error("Delegate return Chat identity already exists; the handoff was preserved.");
  }
  return record;
}

/**
 * Prepare the next head alongside record marks and archive restores, reusing
 * ordinary collapse's Atlas freshness and projection. The original Brain must
 * be used as the expected commit snapshot; freshness is a prospective write,
 * not a separate mutation. Pending checkpoint Chat identities stay out of the
 * head. A delegate report's required main Chat is prepared as a Brain write in
 * the same plan; no message is fabricated for an early end or failure. The
 * person name must be the one resolved for the destination session.
 * This is not a journalled commit, a writer lock or permission to delete the
 * source; hidden source-head metadata still needs independent authentication,
 * and pending child restores still have no destination.
 */
export async function prepareReturnSweepWithRecords(
  root: string, tx: Tx, mainId: ConversationId, id: string, views: readonly ReturnSweepView[], generation: string,
  brain: CartoBrain, archive: Archive, now: number, person: string,
) {
  const freshness = prepareCollapseFreshness(root, brain, now);
  let refreshed = brain;
  for (const step of freshness) refreshed = applyWrite(refreshed, step.write, step.now);
  const plan = await prepareReturnSweepWithSourceHead(root, tx, mainId, id, views, generation, refreshed, now);
  const returnChat = prepareDelegateReturnChat(JSON.stringify(await tx.doc(DelegationDoc, mainId)), id, generation, brain, archive, now);
  const chatWrite = returnChat === undefined ? [] : [{ write: { kind: "chat.record" as const, record: returnChat }, now }];
  // Match BrainStore.applyCollapse ordering: planned writes precede archive
  // record restores, so the rendered Chat order must do the same.
  const recordSource = returnChat === undefined ? refreshed : applyWrite(refreshed, chatWrite[0]!.write, now);
  const records = prepareReturnSweepRecords(recordSource, archive, plan.incoming, plan.writes, now);
  const chat = new Set(records.nextBrain.chat.filter((record) => !plan.pendingChatIds.has(record.id)).map((record) => record.id));
  const projection = projectContext(records.nextBrain, plan.fileTexts, person, { chat });
  return { ...plan, ...records, writes: [...freshness, ...chatWrite, ...records.writes], returnChat, projection };
}

/**
 * Capture a prospective return plan together with source and Brain snapshots.
 * The host must pass the Harness opened on this exact generation store, stop
 * its work and seal all admissions, withdrawals, context, Brain, archive,
 * projection, settings and project-file writers through eventual handling. A
 * fresh Pi document challenge is written before capture and checked through a
 * read-only connection to the named store. This detects an accidentally unrelated
 * Harness, but not a copied or replaced database, a malicious relay, or a later
 * path swap. The caller must still ensure the backing-store relationship.
 * The two source seals and head/Brain comparisons are not locks, cannot detect
 * every ABA change, and do not authenticate hidden sidecar data or arbitrary
 * project-file observations. This does not commit, journal, establish a deletion
 * permit, or replace the multi-conversation guard. Recheck inputs at commit.
 */
export async function captureReturnSweepPlan(
  root: string, brain: BrainStore, harness: Harness, generation: string, id: string, now: number, person: string, context: Context,
) {
  if (!/^gen-[\w-]+$/.test(generation)) throw new Error("Invalid return-sweep generation; the source was preserved.");
  const path = generationPaths(root, generation).store;
  const expected = { brain: await brain.read(), archive: await brain.readArchive() };
  const challenge = { generation, challenge: randomBytes(32).toString("hex") };
  await harness.commit(async (tx) => {
    if (await tx.conversation(ROOT_CONVERSATION_ID) === undefined) throw new Error("Return-sweep Harness has no main conversation; the source was preserved.");
    const marker = await tx.doc(DelegateCaptureDoc, ROOT_CONVERSATION_ID);
    if (Object.keys(marker).length !== 2 ||
        !((marker.generation === null && marker.challenge === null) ||
          (marker.generation === generation && typeof marker.challenge === "string" && /^[0-9a-f]{64}$/.test(marker.challenge)))) {
      throw new Error("Return-sweep capture marker conflicts; the source was preserved.");
    }
    marker.generation = challenge.generation;
    marker.challenge = challenge.challenge;
  }, context);
  const database = await openNodeSqliteDatabase(path, { mode: "read-only" });
  try {
    const storedMarker = await database.transaction((tx) => readStoredMainCheckpoint(tx, DelegateCaptureDoc.definition.kind, "delegate capture"));
    let value: unknown;
    try { value = storedMarker === undefined ? undefined : JSON.parse(storedMarker.content); } catch { value = undefined; }
    if (!isDeepStrictEqual(value, challenge)) throw new Error("Return-sweep Harness does not match the named source; both stores were preserved.");
  } finally {
    await database.close();
  }
  const sourceSeal = await captureDelegateSourceSeal(path, generation);
  const views = await captureReturnSweepViews(harness, context);
  const captured = await harness.commit(async (tx) => {
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(await tx.doc(DelegateCaptureDoc, ROOT_CONVERSATION_ID))), challenge)) {
      throw new Error("Return-sweep capture marker changed; the source was preserved.");
    }
    const plan = await prepareReturnSweepWithRecords(root, tx, ROOT_CONVERSATION_ID, id, views, generation, expected.brain, expected.archive, now, person);
    return {
      plan,
      handoff: JSON.stringify(await tx.doc(DelegationDoc, ROOT_CONVERSATION_ID)),
      checkpoint: JSON.stringify(await tx.doc(DelegateInputCheckpointDoc, ROOT_CONVERSATION_ID)),
      barrier: JSON.stringify(await tx.doc(DelegateMainBarrierDoc, ROOT_CONVERSATION_ID)),
    };
  }, context);
  const stored = await readStoredDelegation(path, true);
  if (stored?.inputCheckpoint === undefined || !isDeepStrictEqual(JSON.parse(stored.content), JSON.parse(captured.handoff)) ||
      !isDeepStrictEqual(JSON.parse(stored.inputCheckpoint.content), JSON.parse(captured.checkpoint)) ||
      !isDeepStrictEqual(JSON.parse(stored.inputCheckpoint.barrier.content), JSON.parse(captured.barrier))) {
    throw new Error("Return-sweep source documents conflict with the Pi capture; the source was preserved.");
  }
  const head = captureReturnSweepHead(root, generation, views);
  if (head.digest !== captured.plan.sourceHeadDigest) throw new Error("Return-sweep projection changed during capture; the source was preserved.");
  const after = { brain: await brain.read(), archive: await brain.readArchive() };
  if (!isDeepStrictEqual(expected, after)) throw new Error("Brain or archive changed during return-sweep capture; the source was preserved.");
  const finalSeal = await captureDelegateSourceSeal(path, generation);
  if (!isDeepStrictEqual(sourceSeal, finalSeal)) throw new Error("Return-sweep source changed during capture; the source was preserved.");
  return { ...captured.plan, expected, sourceSeal, stored };
}
