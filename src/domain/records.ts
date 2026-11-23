/**
 * The Brain's records (§2). Explicit values, no behaviour: every
 * transformation lives in `brain.ts` and `handles.ts`, and nothing in this
 * file reads a clock, a file, or a model.
 */

export type RecordId = string;

/**
 * Anything an Atlas node points at. A file attachment resolves to a path
 * inside the project root (the workspace boundary, §7 — the file
 * may not exist yet; the stale mark is what notices). A record attachment
 * resolves to any other Brain record by id. No types, no kinds, no digests.
 */
export type Attachment =
  | { kind: "file"; path: string }
  | { kind: "record"; id: RecordId };

/** A deliberate durable conversation record. Plain model output is not Chat. */
/** What the next collapse does with an entry (§4.1). A mark, not a state: applying it changes the Brain. */
export type MarkAction = "archive" | "delete" | "restore";

/** Who placed a mark or a pin. The person may withdraw either; the agent only its own. */
export type Author = "user" | "agent";

/** A pending action on one entry, with its author (§4.1). Cleared when a collapse applies it. */
export interface Mark {
  action: MarkAction;
  author: Author;
}

export interface ChatRecord {
  id: RecordId;
  author: "user" | "agent";
  text: string;
  /** The pending mark the next collapse applies (§4.1); its author rides with it. */
  mark?: Mark;
  createdAt: number;
  updatedAt: number;
}

export type LedgerKind = "goal" | "note" | "question" | "instruction" | "progress";
export type LedgerStatus = "open" | "answered" | "closed";

export interface LedgerAnswer {
  text: string;
}

export interface LedgerEntry {
  id: RecordId;
  kind: LedgerKind;
  text: string;
  status: LedgerStatus;
  /** Null while open; set when a question is answered or an entry is closed with its outcome. */
  answer: LedgerAnswer | null;
  /** The pending mark the next collapse applies (§4.1); its author rides with it. */
  mark?: Mark;
  createdAt: number;
  updatedAt: number;
}

/**
 * An Atlas node: a name and a text entry (§2.1). A node
 * may be linked to other Atlas nodes, or attached to any other reference in
 * Carto — a file, a Ledger entry, a Chat record. Nothing requires a node to
 * connect to anything: a node, or a sub-graph, may float unconnected, and
 * the Atlas is the agent's garden.
 *
 * The stale marker is stored at collapse: like a pin, it persists on the
 * entry — set when a file attachment has drifted (missing, or newer than
 * the entry was written), cleared when it has not.
 */
export interface AtlasNode {
  id: RecordId;
  /** The node's name. */
  title: string;
  /** The text entry — what the node holds. */
  text: string;
  /** Links to other Atlas nodes' IDs. Plain; nothing typed, nothing required. */
  links: RecordId[];
  /** Attachments to files and other records. */
  attachments: Attachment[];
  /** The collapse-time marker: a file attachment has drifted. No reason, no bookkeeping. */
  stale?: boolean;
  /** The pending mark the next collapse applies (§4.1); its author rides with it. */
  mark?: Mark;
  createdAt: number;
  updatedAt: number;
}

export type HandleKind = "ledger" | "chat" | "atlas" | "ephemera";

/**
 * One short, type-prefixed, generation-local public handle (§5.4).
 * Stable within one live generation; rebuilt from 1 at every collapse.
 * The private durable ID behind a handle is never rendered to the agent.
 */
export interface RecordHandle {
  kind: HandleKind;
  id: RecordId;
  handle: string;
  timestamp: number;
}

export interface HandleTable {
  counters: Record<string, number>;
  entries: RecordHandle[];
}

/**
 * The Brain: the only durable storage (§2). One current document per
 * project; `history: "latest"` in spirit — the store keeps current state, not
 * an audit trail (§2.2).
 */
/**
 * An ephemeral item the person pinned in the live context (§3.1, §3.2).
 *
 * A pin is the one thing that keeps an ephemeral item through a collapse: the
 * store is deleted whole (§3.4), so an unpinned item goes to the archive and
 * this one goes into the head instead, after Chat, under a handle of its own.
 * It has no mark and no place in the Atlas or the Ledger, because it is not a
 * Brain record — it is what the person kept in front of the agent.
 *
 * Restoring does not put anything here. A restored item goes back to the live
 * context, which is its home, and it is pinned only if the person pins it after
 * that (§3.3).
 */
export interface PinnedEphemeral {
  id: RecordId;
  text: string;
  kind: "toolCall" | "reasoning" | "plainText" | "readResult" | "toolResult" | "personMessage";
  /**
   * The tool call's model-issued id, or the call a result answers: how the item
   * survives a rebuild as itself. A `read` result also carries the path it read,
   * because a pin on one is a promise about that file and the collapse reads it
   * again (§5.5).
   */
  entity?: { callId: string; tool?: string | undefined; path?: string | undefined } | undefined;
  createdAt: number;
  /** Who keeps this item here. Only the person can unpin a pin they placed. */
  pinned: Author;
}

/**
 * A pin on a file (§5.1, §5.5).
 *
 * A file is not a Brain record (§2.1) and this is not a record of one: it is the
 * pin on it, which the head needs somewhere to live. At every collapse the file
 * is read again and its text goes into the head as the file now stands, so what
 * the head holds is the file and not a quotation of a read. The pin carries its
 * author like any other (§3.2), and the file keeps the handle the tree gave it:
 * a pin does not rename a file (§5.4).
 */
export interface PinnedFile {
  /** The path inside the project, as the tree shows it. */
  path: string;
  pinned: Author;
  createdAt: number;
  /** The collapse-time marker: the file is gone or has drifted since it was pinned. */
  stale?: boolean;
}

export interface CartoBrain {
  version: 1;
  chat: ChatRecord[];
  ledger: LedgerEntry[];
  atlas: AtlasNode[];
  /** Pinned ephemera: what a collapse carries into the head instead of sweeping (§3.2, §5.1). */
  ephemera: PinnedEphemeral[];
  /** Live generation item identities chosen for deletion at the next collapse. */
  ephemeralDeletes?: string[];
  /** Pinned files, read again at every collapse so the head holds the file (§5.1). */
  files: PinnedFile[];
  handles: HandleTable;
}

export function emptyBrain(): CartoBrain {
  return {
    version: 1,
    chat: [],
    ledger: [],
    atlas: [],
    ephemera: [],
    files: [],
    handles: { counters: {}, entries: [] },
  };
}
