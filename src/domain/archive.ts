/**
 * The archive (§3.3, §4.1).
 *
 * The archive is Carto's own store of swept items, under `.brain/`. It holds
 * two kinds of thing, and nothing else:
 *
 * - a Brain record that was marked for archive, typed as it was in the Brain
 *   (Atlas, Ledger, or Chat) so a restore can put it back as that type;
 * - an ephemeral item swept from a generation's store when that generation
 *   ended.
 *
 * **Archiving moves a record out of the Brain.** An archived Brain record is
 * not in `CartoBrain` any more (§4.1): a record is a Brain record while it is
 * in the Brain and an archived record while it is here, and restoring makes it
 * a Brain record again. Nothing in the Brain carries an archived state.
 *
 * **Grace is one collapse period, counted from the sweep.** An item swept by
 * the collapse that built generation G remains available through G and is
 * dropped by the next collapse. An item swept by a collapse is never dropped
 * by that same collapse. A pin keeps an item until it is unpinned or restored.
 *
 * **The agent cannot reach any of it.** Nothing here renders, no handle names
 * an archived item, and no tool accepts one (§3.3). These are the person's
 * operations over the store, not a surface the agent can address.
 *
 * Pure transformations over an explicit value, like the Brain (§11).
 */
import type { AtlasNode, Author, ChatRecord, LedgerEntry } from "./records.js";

/** What an archived record was, so a restore can make it that again. */
export type ArchivedKind = "atlas" | "ledger" | "chat";

/** What kind of ephemeral item this is, so a restore can put it back where it came from. */
export type EphemeralKind =
  | "toolCall"
  | "reasoning"
  | "plainText"
  | "readResult"
  | "toolResult"
  | "personMessage";

/** A Brain record as it stood when it was archived. */
export type ArchivedRecord = AtlasNode | LedgerEntry | ChatRecord;

/**
 * What an archived item is marked for (§4.1). Restore and delete are the two
 * actions, and both apply at the next collapse; `delete` is what drops an item
 * before its grace runs, or after it if the person wants it gone now and says so
 * through an apply-now.
 */
export interface ArchiveMark {
  action: "restore" | "delete";
  author: Author;
}

/** Identity of a Pi contribution captured for a future delegate return sweep. */
export interface EphemeralSource {
  version: 1;
  generation: string;
  conversationId: number;
  entryId: number;
  entryKind: string;
  entryData?: unknown;
}

/** One thing in the archive. */
export interface ArchivedItem {
  /** Storage-level identity. The agent never sees it (§5.4). */
  id: string;
  /** A Brain record that was marked for archive, or ephemeral material swept at a collapse. */
  layer: "record" | "ephemeral";
  /** Set for a record; absent for an ephemeral item. */
  record?: { kind: ArchivedKind; value: ArchivedRecord };
  /** Set for an ephemeral item; absent for a record. */
  ephemeral?: { kind: EphemeralKind; text: string; data?: unknown; model?: unknown; source?: EphemeralSource };
  /** The generation whose collapse swept this item in, for the person to read. */
  sweptAtGeneration: string;
  /**
   * Which collapse swept this item in, counted from the first. Grace is counted
   * from it: an item swept by collapse N is dropped by collapse N+1.
   */
  sweptAtCollapse: number;
  /** Who placed the pin, if any (§3.2). A pinned item is never dropped. */
  pinned?: Author;
  /**
   * What the next collapse does with this item (§4.1). A mark, like a Brain
   * record's: it says what happens next, and the collapse is what does it. An
   * item carrying no mark is simply waiting out its grace.
   */
  mark?: ArchiveMark;
  /** A collapse committed a restore whose live-store acknowledgement is pending. */
  restorePending?: boolean;
  /** When it was swept, on the Brain's clock. */
  sweptAt: number;
}

export interface Archive {
  version: 1;
  items: ArchivedItem[];
}

export function emptyArchive(): Archive {
  return { version: 1, items: [] };
}

/**
 * A record as it stood in the Brain, minus the mark it was carrying: the mark
 * is what is being applied, and an archived record is a record, not a decision
 * about one (§4.1). The key goes rather than sitting at `undefined`, so nothing
 * reads a mark that is no longer there.
 */
export function withoutMark<T extends { mark?: unknown }>(record: T): Omit<T, "mark"> {
  const copy: Record<string, unknown> = { ...record };
  delete copy.mark;
  return copy as Omit<T, "mark">;
}

/** An item on its way in, before the sweep stamps it with its collapse. */
export type IncomingItem = Omit<ArchivedItem, "sweptAtGeneration" | "sweptAtCollapse" | "sweptAt">;

/**
 * Sweep a collapse's worth of items in. Called before the generation's store is
 * unlinked — the move, not a copy (§3.4).
 */
export function sweep(
  archive: Archive,
  generation: string,
  collapse: number,
  now: number,
  incoming: readonly IncomingItem[],
): Archive {
  const items = incoming.map((item) => ({ ...item, sweptAtGeneration: generation, sweptAtCollapse: collapse, sweptAt: now }));
  return { ...archive, items: [...archive.items, ...items] };
}

/**
 * Drop every unpinned item whose grace has run, and say which went. `collapse`
 * is the number of the collapse now running: an item swept by collapse N is
 * dropped at N+1, after one period in the archive.
 */
export function dropExpired(archive: Archive, collapse: number): { archive: Archive; dropped: string[] } {
  const dropped: string[] = [];
  const items = archive.items.filter((item) => {
    if (item.pinned !== undefined) return true;
    // A mark holds the item where it is until a collapse applies it (§4.1), so
    // grace does not run while the person or the agent has decided something
    // about it. Both marks read as "not yet gone".
    if (item.mark !== undefined) return true;
    if (item.sweptAtCollapse >= collapse) return true;
    dropped.push(item.id);
    return false;
  });
  return { archive: { ...archive, items }, dropped };
}

/**
 * Apply every mark on the archive (§4.1). Runs as part of a collapse, after the
 * sweep and before grace is counted, so an item marked this time is not also
 * dropped this time.
 *
 * A restored item leaves the archive and is handed back to the caller, which is
 * what puts it where it came from: a Brain record into the Brain in the same
 * transaction, an ephemeral item into the live context. A delete is a real
 * deletion: the item is gone, not held aside (§3.3).
 */
export function applyArchiveMarks(archive: Archive): {
  archive: Archive;
  restored: ArchivedItem[];
  deleted: string[];
} {
  const restored: ArchivedItem[] = [];
  const deleted: string[] = [];
  const items: ArchivedItem[] = [];
  for (const item of archive.items) {
    if (item.mark === undefined) {
      items.push(item);
      continue;
    }
    // The mark has done its work either way, so it does not travel with the
    // item: `mark: undefined` would be a mark that lies.
    const bare: Record<string, unknown> = { ...item };
    delete bare.mark;
    if (item.mark.action === "restore") {
      restored.push(bare as unknown as ArchivedItem);
      continue;
    }
    deleted.push(item.id);
  }
  return { archive: { ...archive, items }, restored, deleted };
}

/**
 * Mark one archived item for restore or delete, or withdraw a mark (§4.1).
 *
 * The author rides with the mark, and the same rule the Brain uses holds here:
 * a mark the person placed is theirs to withdraw, and only theirs. An item out
 * of the archive cannot be marked, so an unknown id is a no-op rather than an
 * error — the person may have restored it in another window a moment ago.
 */
export function setArchiveMark(
  archive: Archive,
  id: string,
  mark: ArchiveMark | null,
  by: Author,
): { archive: Archive; refused: boolean } {
  const item = archive.items.find((candidate) => candidate.id === id);
  if (item === undefined) return { archive, refused: false };
  if (mark === null && item.mark !== undefined && item.mark.author !== by) {
    // The person may withdraw a mark the agent placed; the agent may not
    // withdraw the person's. That is the one asymmetry §3.2 and §4.1 both fix.
    return { archive, refused: true };
  }
  const items = archive.items.map((candidate) => {
    if (candidate.id !== id) return candidate;
    if (mark === null) {
      const copy: Record<string, unknown> = { ...candidate };
      delete copy.mark;
      return copy as unknown as ArchivedItem;
    }
    return { ...candidate, mark };
  });
  return { archive: { ...archive, items }, refused: false };
}

/** Pin or unpin one archived item. A pin means "keep it here" (§3.2). */
export function setArchivePin(archive: Archive, id: string, pinned: Author | null): Archive {
  return {
    ...archive,
    items: archive.items.map((item) => {
      if (item.id !== id) return item;
      if (pinned === null) {
        const copy: Record<string, unknown> = { ...item };
        delete copy.pinned;
        return copy as unknown as ArchivedItem;
      }
      return { ...item, pinned };
    }),
  };
}

/** Restore one archived item: it leaves the archive and goes back where it came from (§3.3). */
export function restore(archive: Archive, id: string): { archive: Archive; item: ArchivedItem | undefined } {
  const item = archive.items.find((candidate) => candidate.id === id);
  if (item === undefined) return { archive, item: undefined };
  return { archive: { ...archive, items: archive.items.filter((candidate) => candidate.id !== id) }, item };
}
