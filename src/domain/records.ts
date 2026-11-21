/**
 * The Brain's records (MINI.md §2). Explicit values, no behaviour: every
 * transformation lives in `brain.ts` and `handles.ts`, and nothing in this
 * file reads a clock, a file, or a model.
 */

export type RecordId = string;

export type Freshness = "fresh" | "stale" | "unknown";

export type SourceRef =
  | {
      kind: "file";
      path: string;
      startLine: number;
      endLine: number;
      /** Content digest at the time the evidence was checked. */
      digest: string;
      excerpt: string;
      freshness: Freshness;
    }
  | {
      kind: "context";
      /** The generation the excerpt came from. */
      contextId: string;
      excerpt: string;
      freshness: Freshness;
    };

/** A deliberate durable conversation record. Plain model output is not Chat. */
export interface ChatRecord {
  id: RecordId;
  author: "user" | "agent";
  text: string;
  /** The pin marker: an item pinned stays put. No reason, no source, no other bookkeeping. */
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type LedgerKind = "goal" | "note" | "question" | "instruction" | "progress";
export type LedgerStatus = "open" | "answered" | "closed";

export interface LedgerAnswer {
  text: string;
  evidenceIds: RecordId[];
}

export interface LedgerEntry {
  id: RecordId;
  kind: LedgerKind;
  text: string;
  status: LedgerStatus;
  /** Null while open; set when a question is answered or an entry is closed with its outcome. */
  answer: LedgerAnswer | null;
  /** The pin marker: an item pinned stays put. No reason, no source, no other bookkeeping. */
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AtlasEdgeKind = "replaces" | "depends-on" | "contradicts";

/**
 * A typed, optional edge to another Atlas node (MINI.md §2.1, confirmed).
 * Nothing requires an edge; a node or a sub-graph may float unconnected.
 */
export interface AtlasEdge {
  kind: AtlasEdgeKind;
  target: RecordId;
}

export interface AtlasNode {
  id: RecordId;
  title: string;
  /** The claim the node makes — the trees's leaves are these. */
  claim: string;
  evidence: SourceRef[];
  edges: AtlasEdge[];
  /** The pin marker: an item pinned stays put. No reason, no source, no other bookkeeping. */
  pinned?: boolean;
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
