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
 * **Grace is one collapse, counted from the sweep.** An item swept by the
 * collapse that built generation G is dropped by the collapse that builds the
 * generation after next: it lives through G, and one collapse later it is gone.
 * An item swept by a collapse is never dropped by that same collapse, nor by
 * the one directly after it. A pin suspends this: a pinned item is never
 * dropped, and stays until it is unpinned or restored.
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

/** One thing in the archive. */
export interface ArchivedItem {
  /** Storage-level identity. The agent never sees it (§5.4). */
  id: string;
  /** A Brain record that was marked for archive, or ephemeral material swept at a collapse. */
  layer: "record" | "ephemeral";
  /** Set for a record; absent for an ephemeral item. */
  record?: { kind: ArchivedKind; value: ArchivedRecord };
  /** Set for an ephemeral item; absent for a record. */
  ephemeral?: { kind: EphemeralKind; text: string; data?: unknown };
  /** The generation whose collapse swept this item in, for the person to read. */
  sweptAtGeneration: string;
  /**
   * Which collapse swept this item in, counted from the first. Grace is counted
   * from it: an item swept by collapse N is dropped by collapse N+2, and
   * survives N+1.
   */
  sweptAtCollapse: number;
  /** Who placed the pin, if any (§3.2). A pinned item is never dropped. */
  pinned?: Author;
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
 * dropped when collapse N+2 runs, so it lives through N and N+1.
 */
export function dropExpired(archive: Archive, collapse: number): { archive: Archive; dropped: string[] } {
  const dropped: string[] = [];
  const items = archive.items.filter((item) => {
    if (item.pinned !== undefined) return true;
    if (item.sweptAtCollapse > collapse - 2) return true;
    dropped.push(item.id);
    return false;
  });
  return { archive: { ...archive, items }, dropped };
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
