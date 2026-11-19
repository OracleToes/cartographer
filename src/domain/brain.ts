import type {
  AtlasNode,
  CartoBrain,
  ChatRecord,
  DeletionMark,
  DeletionTarget,
  LedgerEntry,
  RecordId,
} from "./types.js";

export function createEmptyBrain(): CartoBrain {
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
    handles: { counters: {}, entries: [] },
    context: { liveGeneration: null, archiveGeneration: null },
    activity: { kind: "idle", detail: null },
  };
}

function recordExists(brain: CartoBrain, kind: import("./types.js").HandleKind, id: RecordId): boolean {
  switch (kind) {
    case "ledger":
      return brain.ledger.some((entry) => entry.id === id);
    case "chat":
      return brain.chat.some((entry) => entry.id === id);
    case "atlas":
      return brain.atlas.some((entry) => entry.id === id);
    case "pin":
      return brain.userPins.some((entry) => entry.id === id) || brain.carryPins.some((entry) => entry.id === id);
    case "handoff":
      return brain.handoff !== null;
    case "wake":
      return brain.wakes.some((entry) => entry.id === id);
    case "change":
      return brain.changes.some((entry) => entry.id === id);
    case "deletion":
      return brain.deletionMarks.some((mark) => `${mark.target}:${mark.id}` === id);
  }
}

export function byCreatedAt<T extends { createdAt: number }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((first, second) => first.item.createdAt - second.item.createdAt || first.index - second.index)
    .map(({ item }) => item);
}

export function deletionKey(target: DeletionTarget): string {
  return `${target.target}:${target.id}`;
}

export function isMarkedForDeletion(brain: CartoBrain, target: DeletionTarget): boolean {
  const key = deletionKey(target);
  return brain.deletionMarks.some((mark) => deletionKey(mark) === key);
}

export function visibleChat(brain: CartoBrain): ChatRecord[] {
  return brain.chat.filter((entry) => !isMarkedForDeletion(brain, { target: "chat", id: entry.id }));
}

export function visibleLedger(brain: CartoBrain): LedgerEntry[] {
  return brain.ledger.filter((entry) => !isMarkedForDeletion(brain, { target: "ledger", id: entry.id }));
}

export function visibleAtlas(brain: CartoBrain): AtlasNode[] {
  return brain.atlas.filter((entry) => !isMarkedForDeletion(brain, { target: "atlas", id: entry.id }));
}

export function addDeletionMark(brain: CartoBrain, mark: DeletionMark): CartoBrain {
  if (isMarkedForDeletion(brain, mark)) return brain;
  return { ...brain, deletionMarks: [...brain.deletionMarks, mark] };
}

export function removeDeletionMark(brain: CartoBrain, target: DeletionTarget): CartoBrain {
  const key = deletionKey(target);
  const deletionMarks = brain.deletionMarks.filter((mark) => deletionKey(mark) !== key);
  return deletionMarks.length === brain.deletionMarks.length ? brain : { ...brain, deletionMarks };
}

export function purgeMarkedRecords(brain: CartoBrain): CartoBrain {
  const marks = new Set(brain.deletionMarks.map(deletionKey));
  if (marks.size === 0) return brain;
  const records: CartoBrain = {
    ...brain,
    chat: brain.chat.filter((entry) => !marks.has(deletionKey({ target: "chat", id: entry.id }))),
    ledger: brain.ledger.filter((entry) => !marks.has(deletionKey({ target: "ledger", id: entry.id }))),
    atlas: brain.atlas.filter((entry) => !marks.has(deletionKey({ target: "atlas", id: entry.id }))),
    userPins: brain.userPins.filter((entry) => !marks.has(deletionKey({ target: "user-pin", id: entry.id }))),
    carryPins: brain.carryPins.filter((entry) => !marks.has(deletionKey({ target: "carry-pin", id: entry.id }))),
    deletionMarks: [],
  };
  // Handles for purged records go away with them. The remaining handles stay
  // stable until the collapse decision rebuilds the whole table.
  return {
    ...records,
    handles: {
      counters: brain.handles.counters,
      entries: brain.handles.entries.filter((entry) => recordExists(records, entry.kind, entry.id)),
    },
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
