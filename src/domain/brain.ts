import type {
  AtlasNode,
  ChatRecord,
  DeletionMark,
  DeletionTarget,
  LedgerEntry,
  MiniBrain,
  RecordId,
} from "./types.js";

export function createEmptyBrain(): MiniBrain {
  return {
    version: 1,
    chat: [],
    ledger: [],
    atlas: [],
    userPins: [],
    carryPins: [],
    handoff: null,
    wakes: [],
    changes: [],
    deletionMarks: [],
    context: { liveGeneration: null, archiveGeneration: null },
    activity: { kind: "idle", detail: null },
  };
}

export function deletionKey(target: DeletionTarget): string {
  return `${target.target}:${target.id}`;
}

export function isMarkedForDeletion(brain: MiniBrain, target: DeletionTarget): boolean {
  const key = deletionKey(target);
  return brain.deletionMarks.some((mark) => deletionKey(mark) === key);
}

export function visibleChat(brain: MiniBrain): ChatRecord[] {
  return brain.chat.filter((entry) => !isMarkedForDeletion(brain, { target: "chat", id: entry.id }));
}

export function visibleLedger(brain: MiniBrain): LedgerEntry[] {
  return brain.ledger.filter((entry) => !isMarkedForDeletion(brain, { target: "ledger", id: entry.id }));
}

export function visibleAtlas(brain: MiniBrain): AtlasNode[] {
  return brain.atlas.filter((entry) => !isMarkedForDeletion(brain, { target: "atlas", id: entry.id }));
}

export function addDeletionMark(brain: MiniBrain, mark: DeletionMark): MiniBrain {
  if (isMarkedForDeletion(brain, mark)) return brain;
  return { ...brain, deletionMarks: [...brain.deletionMarks, mark] };
}

export function removeDeletionMark(brain: MiniBrain, target: DeletionTarget): MiniBrain {
  const key = deletionKey(target);
  const deletionMarks = brain.deletionMarks.filter((mark) => deletionKey(mark) !== key);
  return deletionMarks.length === brain.deletionMarks.length ? brain : { ...brain, deletionMarks };
}

export function purgeMarkedRecords(brain: MiniBrain): MiniBrain {
  const marks = new Set(brain.deletionMarks.map(deletionKey));
  if (marks.size === 0) return brain;
  return {
    ...brain,
    chat: brain.chat.filter((entry) => !marks.has(deletionKey({ target: "chat", id: entry.id }))),
    ledger: brain.ledger.filter((entry) => !marks.has(deletionKey({ target: "ledger", id: entry.id }))),
    atlas: brain.atlas.filter((entry) => !marks.has(deletionKey({ target: "atlas", id: entry.id }))),
    deletionMarks: [],
  };
}

export function replaceById<T extends { id: RecordId }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  return [...items.slice(0, index), item, ...items.slice(index + 1)];
}

export function removeById<T extends { id: RecordId }>(items: T[], id: RecordId): T[] {
  return items.filter((item) => item.id !== id);
}
