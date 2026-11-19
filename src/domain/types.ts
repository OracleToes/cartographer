export type RecordId = string;
export type GenerationId = string;

export type Freshness = "fresh" | "stale" | "unknown";

export type SourceRef =
  | {
      kind: "file";
      path: string;
      startLine: number;
      endLine: number;
      digest: string;
      excerpt: string;
      freshness: Freshness;
    }
  | {
      kind: "context";
      contextId: string;
      excerpt: string;
      freshness: Freshness;
    };

/** A deliberate durable conversation record. Raw model output is not Chat. */
export interface ChatRecord {
  id: RecordId;
  author: "user" | "agent";
  text: string;
  createdAt: number;
  updatedAt: number;
}

export interface LedgerEntry {
  id: RecordId;
  kind: "goal" | "note" | "question";
  text: string;
  status: "open" | "answered" | "closed";
  answer: null | { text: string; evidenceIds: string[] };
  createdAt: number;
  updatedAt: number;
}

export interface AtlasNode {
  id: RecordId;
  title: string;
  claim: string;
  evidence: SourceRef[];
  links: RecordId[];
  createdAt: number;
  updatedAt: number;
}

export interface CarryPin {
  id: RecordId;
  item: string;
  reason: string;
  source: SourceRef;
  createdAt: number;
}

export interface UserPin {
  id: RecordId;
  item: string;
  reason: string;
  source: SourceRef;
  createdAt: number;
}

export interface Handoff {
  intent: string;
  activeLedgerIds: RecordId[];
  openQuestionIds: RecordId[];
  relevantAtlasIds: RecordId[];
  nextAction: string;
  note: string;
  updatedAt: number;
}

export interface WakeEntry {
  id: RecordId;
  kind: "time" | "path";
  condition: string;
  status: "armed" | "ready" | "consumed" | "cancelled";
  reason: string;
  createdAt: number;
}

export interface ChangeProposal {
  id: RecordId;
  rationale: string;
  patch: string;
  base: Array<{ path: string; digest: string }>;
  status: "proposed" | "approved" | "rejected" | "applied" | "conflicted";
  createdAt: number;
  resolvedAt: number | null;
}

export type DeletionRecordTarget = "chat" | "ledger" | "atlas";
export type DeletionTarget =
  | { target: DeletionRecordTarget; id: RecordId }
  | { target: "user-pin"; id: RecordId }
  | { target: "carry-pin"; id: RecordId };

export type DeletionMark = DeletionTarget & {
  markedAt: number;
};

export type ActivityKind =
  | "idle"
  | "thinking"
  | "reading"
  | "waiting-for-collapse"
  | "waiting-for-approval"
  | "applying-change"
  | "sleeping"
  | "woken"
  | "error";

export interface Activity {
  kind: ActivityKind;
  detail: string | null;
}

export interface ContextGenerations {
  liveGeneration: GenerationId | null;
  archiveGeneration: GenerationId | null;
}

export type HandleKind = "ledger" | "chat" | "atlas" | "pin" | "handoff" | "wake" | "change" | "deletion";

/**
 * One short, type-prefixed public handle for one durable record. Carto keeps
 * this table for one live context generation; a collapse rebuilds it from 1.
 */
export interface RecordHandle {
  kind: HandleKind;
  /** The private durable ID. It is never rendered to the agent. */
  id: RecordId;
  /** A short public handle such as `L1`, `C10`, `A1`, `P1`, or `H1`. */
  handle: string;
  /** Creation time for display order and public metadata. */
  timestamp: number;
}

/**
 * The generation-local resolver. It converts a public handle to a private
 * durable ID for tool and UI actions, and back for display.
 */
export interface HandleTable {
  counters: Record<string, number>;
  entries: RecordHandle[];
}

/**
 * Stable storage IDs stay private. Carto creates short presentation handles for
 * each live context projection and renews them after a collapse.
 */
export interface CartoBrain {
  version: 1;
  chat: ChatRecord[];
  ledger: LedgerEntry[];
  atlas: AtlasNode[];
  userPins: UserPin[];
  carryPins: CarryPin[];
  handoff: Handoff | null;
  wakes: WakeEntry[];
  changes: ChangeProposal[];
  deletionMarks: DeletionMark[];
  /** Generation-local public handles. Rebuilt on every collapse. */
  handles: HandleTable;
  context: ContextGenerations;
  activity: Activity;
}

