/** Dormant Pi-backed active context capture for a future delegate return sweep. */
import type { Context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ConversationRecord, type ContextView, type Cursor, type EntryId, type Harness, type Tx } from "@earendil-works/pi-durable";

type Bounds = { conversation: ConversationRecord; tail: EntryId | undefined; head: EntryId | undefined };

/** Capture every conversation and its context bounds on Pi's session line. */
export async function captureReturnSweepBounds(tx: Tx): Promise<Bounds[]> {
  const conversations: ConversationRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanConversations({ order: "ascending" }, 100, cursor);
    conversations.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  if (!conversations.some((conversation) => conversation.id === ROOT_CONVERSATION_ID)) {
    throw new Error("Return sweep has no main conversation; the source was preserved.");
  }
  const bounds: Bounds[] = [];
  for (const conversation of conversations) {
    // An inherited entry belongs to several contexts but only one global entry
    // ID. Its archive and restore provenance needs a separate design.
    if (conversation.parent !== undefined) throw new Error("Forked conversation sweep is unsupported; the source was preserved.");
    const tail = await tx.latestEntryId(conversation.id);
    const head = (await tx.latestHeadMarker(conversation.id))?.id;
    bounds.push({ conversation, tail, head });
  }
  return bounds;
}

export type ReturnSweepView = { conversation: ConversationRecord; tail: EntryId | undefined; view: ContextView };

/**
 * Read each conversation through Pi's own context derivation, preserving its
 * raw active entries and per-entry edited contributions. Does not archive or
 * transfer anything. The host must stop *all* source writers (including inbox
 * and background work) before this read and keep them stopped until the source
 * has been safely handled. The two bounds checks detect changes during capture;
 * they are not a lock and cannot detect every document or task change.
 *
 * This uses the host's already-open Harness: Pi's SQLite storage open performs
 * migrations and therefore cannot be opened on Carto's read-only source. The
 * current return-collapse guard remains in place until archival, provenance,
 * input recovery and journal integration are complete.
 */
export async function captureReturnSweepViews(harness: Harness, context: Context): Promise<ReturnSweepView[]> {
  const before = await harness.commit(captureReturnSweepBounds, context);
  const result: ReturnSweepView[] = [];
  for (const bound of before) {
    const conversation = await harness.conversation(bound.conversation.id, context);
    if (conversation === undefined) throw new Error("A return-sweep conversation disappeared; the source was preserved.");
    const view = await conversation.context(context, bound.tail === undefined ? undefined : { at: bound.tail });
    if (view.head?.id !== bound.head || view.entries.length !== view.contributions.length ||
        view.entries.some((entry) => entry.conversationId !== bound.conversation.id)) {
      throw new Error("A return-sweep context is inconsistent; the source was preserved.");
    }
    result.push({ conversation: bound.conversation, tail: bound.tail, view });
  }
  const after = await harness.commit(captureReturnSweepBounds, context);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Return-sweep conversations changed during capture; the source was preserved.");
  }
  // Pi may retain frozen objects in its cache. Give the host detached values.
  return structuredClone(result);
}
