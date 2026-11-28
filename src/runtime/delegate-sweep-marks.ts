/** Dormant pin and deletion reconciliation for a prospective return sweep. */
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { IncomingItem } from "../domain/archive.js";
import type { BrainWrite } from "../domain/brain.js";
import type { CartoBrain } from "../domain/records.js";
import { collapseEphemeralDeletionWrites, type ReturnSweepPart } from "./collapse.js";
import { prepareReturnSweepArchive, type ReturnSweepChatDuplicate } from "./delegate-sweep-chat.js";
import type { ReturnSweepView } from "./delegate-sweep-view.js";

/** True when a saved Pi contribution includes an image that a text pin cannot carry. */
function hasImage(model: unknown): boolean {
  if (!Array.isArray(model)) return false;
  return model.some((message: unknown) => {
    if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content) && content.some((part: unknown) => part !== null && typeof part === "object" &&
      !Array.isArray(part) && (part as { type?: unknown }).type === "image");
  });
}

/**
 * Classify captured parts against one Brain snapshot without mutating it. The
 * caller supplies the identities actually held by the source's verified main
 * snapshot, not a list inferred from the current Brain. Child pins cannot be
 * projected into main and block unless explicitly marked for deletion. Unknown
 * pins also block; a current main pin must match the captured kind and text,
 * and a text-only pin cannot stand in for an image. A deletion wins over a pin
 * and a Chat duplicate, using the same Brain writes as ordinary collapse.
 *
 * This is a plan, not a commit or a source-deletion permit: the host must seal
 * writers, verify the snapshot/Brain and checkpoint inputs, handle record marks
 * and pin refresh, and atomically journal and commit everything before deletion.
 */
export function prepareReturnSweepMarks(
  views: readonly ReturnSweepView[], generation: string, brain: CartoBrain,
  headChatIds: ReadonlySet<string>, mainHeadPinIds: ReadonlySet<string>, now: number,
): {
  incoming: IncomingItem[];
  pinned: ReturnSweepPart[];
  deleted: ReturnSweepPart[];
  chatDuplicates: ReturnSweepChatDuplicate[];
  writes: Array<{ write: BrainWrite; now: number }>;
} {
  const prepared = prepareReturnSweepArchive(views, generation, brain.chat, headChatIds);
  const all = [...prepared.parts, ...prepared.chatDuplicates.map((duplicate) => duplicate.part)];
  const byId = new Map<string, ReturnSweepPart>();
  for (const part of all) {
    if (byId.has(part.item.id)) throw new Error("Duplicate return-sweep item identity; the source was preserved.");
    byId.set(part.item.id, part);
  }
  const pins = new Map(brain.ephemera.filter((item) => item.pinned !== undefined).map((item) => [item.id, item]));
  if (pins.size !== brain.ephemera.filter((item) => item.pinned !== undefined).length) {
    throw new Error("Duplicate pin identity; the source was preserved.");
  }
  const deletions = new Set(brain.ephemeralDeletes ?? []);
  for (const [id, pin] of pins) {
    // Deletion removes the pin from the new head; no source content is carried.
    if (deletions.has(id)) continue;
    const part = byId.get(id);
    if (part === undefined) {
      if (!mainHeadPinIds.has(id)) throw new Error("A pin has no proven main source; the source was preserved.");
      continue;
    }
    if (part.conversationId !== ROOT_CONVERSATION_ID) {
      throw new Error("A child pin cannot be carried into main; the source was preserved.");
    }
    const value = part.item.ephemeral;
    if (value === undefined || value.kind !== pin.kind || value.text !== pin.text || pin.containsImage || hasImage(value.model)) {
      throw new Error("A pin conflicts with its source or contains an image; the source was preserved.");
    }
  }
  const ordered = all.sort((left, right) => left.entryId - right.entryId);
  const pinned = ordered.filter((part) => pins.has(part.item.id) && !deletions.has(part.item.id));
  const deleted = ordered.filter((part) => deletions.has(part.item.id));
  const duplicates = prepared.chatDuplicates.filter(({ itemId }) => !pins.has(itemId) && !deletions.has(itemId));
  const duplicateIds = new Set(duplicates.map(({ itemId }) => itemId));
  const incoming = ordered.filter((part) => !pins.has(part.item.id) && !deletions.has(part.item.id) && !duplicateIds.has(part.item.id)).map((part) => part.item);
  return { incoming, pinned, deleted, chatDuplicates: duplicates, writes: collapseEphemeralDeletionWrites(brain, now) };
}
