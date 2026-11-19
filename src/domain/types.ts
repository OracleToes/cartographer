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

export interface ChatRecord {
  id: RecordId;
  author: "user" | "agent";
  text: string;
  createdAt: number;
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

export interface DeletionMark {
  target: "chat" | "ledger" | "atlas";
  id: RecordId;
  markedAt: number;
}

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

export interface MiniBrain {
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
  context: ContextGenerations;
  activity: Activity;
}

export type DeletionTarget = Pick<DeletionMark, "target" | "id">;
