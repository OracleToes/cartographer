import type { CartoBrain, RecordId } from "./types.js";

export function createEmptyBrain(): CartoBrain {
  return {
    version: 1,
    chat: [],
    ledger: [],
    atlas: [],
    userPins: [],
    carryPins: [],
    wakes: [],
    handles: { counters: {}, entries: [] },
  };
}

export function byCreatedAt<T extends { createdAt: number }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((first, second) => first.item.createdAt - second.item.createdAt || first.index - second.index)
    .map(({ item }) => item);
}

/**
 * Whether a handle could name a record of this kind. Handle assignment happens
 * where the Brain changes, so the UI and tools never invent a number.
 */
export function recordExists(brain: CartoBrain, kind: import("./types.js").HandleKind, id: RecordId): boolean {
  switch (kind) {
    case "ledger":
      return brain.ledger.some((entry) => entry.id === id);
    case "chat":
      return brain.chat.some((entry) => entry.id === id);
    case "atlas":
      return brain.atlas.some((entry) => entry.id === id);
    case "pin":
      return brain.userPins.some((entry) => entry.id === id) || brain.carryPins.some((entry) => entry.id === id);
    case "wake":
      return brain.wakes.some((entry) => entry.id === id);
  }
}

export function replaceById<T extends { id: RecordId }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  return [...items.slice(0, index), item, ...items.slice(index + 1)];
}

export function removeById<T extends { id: RecordId }>(items: T[], id: RecordId): T[] {
  return items.filter((item) => item.id !== id);
}
