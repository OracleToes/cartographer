/**
 * The Brain's records (MINI.md §2). Explicit values, no behaviour: every
 * transformation lives in `brain.ts` and `handles.ts`, and nothing in this
 * file reads a clock, a file, or a model.
 */

export type RecordId = string;

/**
 * Anything an Atlas node points at. A file attachment resolves to a path
 * inside the project root (the workspace boundary, MINI.md §7 — the file
 * may not exist yet; the stale mark is what notices). A record attachment
 * resolves to any other Brain record by id. No types, no kinds, no digests.
 */
export type Attachment =
  | { kind: "file"; path: string }
  | { kind: "record"; id: RecordId };

/** A deliberate durable conversation record. Plain model output is not Chat. */
export interface ChatRecord {
  id: RecordId;
  author: "user" | "agent";
  text: string;
  /** The pin marker: "user" | "agent" — who placed the pin. An item pinned stays put; no reason, no source, no other bookkeeping. */
  pinned?: "user" | "agent";
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
  /** The pin marker: "user" | "agent" — who placed the pin. An item pinned stays put; no reason, no source, no other bookkeeping. */
  pinned?: "user" | "agent";
  createdAt: number;
  updatedAt: number;
}

/**
 * An Atlas node: a name and a text entry (MINI.md §2.1, confirmed). A node
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
  /** The pin marker: "user" | "agent" — who placed the pin. An item pinned stays put; no reason, no source, no other bookkeeping. */
  pinned?: "user" | "agent";
  createdAt: number;
  updatedAt: number;
}

export type HandleKind = "ledger" | "chat" | "atlas";

/**
 * One short, type-prefixed, generation-local public handle (MINI.md §6).
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
 * The Brain: the only durable storage (MINI.md §2). One current document per
 * project; `history: "latest"` in spirit — the store keeps current state, not
 * an audit trail (MINI.md §4.2).
 */
export interface CartoBrain {
  version: 1;
  chat: ChatRecord[];
  ledger: LedgerEntry[];
  atlas: AtlasNode[];
  handles: HandleTable;
}

export function emptyBrain(): CartoBrain {
  return {
    version: 1,
    chat: [],
    ledger: [],
    atlas: [],
    handles: { counters: {}, entries: [] },
  };
}
