/** Dormant reconciliation of checkpointed inputs with a prospective return sweep. */
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { userText } from "../domain/chat-identity.js";
import type { CartoBrain } from "../domain/records.js";
import { ephemeralItemId } from "./collapse.js";
import { DelegateInputCheckpointDoc, parseInputCheckpoint } from "./delegate-inputs.js";
import { inspectReturnSweepInputs } from "./delegate-sweep-inputs.js";
import { prepareReturnSweepMarks } from "./delegate-sweep-marks.js";
import type { ReturnSweepView } from "./delegate-sweep-view.js";

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
    const text = userText(checkpoint.inputs[inputIndex]!.content);
    const incoming = pendingItems.filter((item) => item.ephemeral?.source?.entryId === entryId);
    const duplicates = plan.chatDuplicates.filter((duplicate) => duplicate.entryId === entryId);
    if (incoming.length + duplicates.length !== (text.trim() ? 1 : 0)) {
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
