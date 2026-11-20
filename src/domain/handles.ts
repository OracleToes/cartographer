/**
 * Generation-local handles (MINI.md §6).
 *
 * A handle is short, type-prefixed, and stable within one live generation.
 * A collapse rebuilds the table from 1; nothing about a handle survives a
 * collapse. The agent and the person refer to records by handle; a tool
 * parameter that names a record takes a handle, and an unknown handle is an
 * explicit error at the call site — this module never guesses.
 */
import type { CartoBrain, HandleKind, HandleTable, RecordHandle, RecordId } from "./records.js";

const PREFIX: Record<HandleKind, string> = {
  ledger: "L",
  chat: "C",
  atlas: "A",
  pin: "P",
  wake: "W",
};

interface Located {
  kind: HandleKind;
  id: RecordId;
  createdAt: number;
}

function locate(brain: CartoBrain): Located[] {
  const located: Located[] = [];
  for (const entry of brain.ledger) located.push({ kind: "ledger", id: entry.id, createdAt: entry.createdAt });
  for (const record of brain.chat) located.push({ kind: "chat", id: record.id, createdAt: record.createdAt });
  for (const node of brain.atlas) located.push({ kind: "atlas", id: node.id, createdAt: node.createdAt });
  for (const pin of brain.userPins) located.push({ kind: "pin", id: pin.id, createdAt: pin.createdAt });
  for (const pin of brain.carryPins) located.push({ kind: "pin", id: pin.id, createdAt: pin.createdAt });
  for (const wake of brain.wakes) located.push({ kind: "wake", id: wake.id, createdAt: wake.createdAt });
  // Collapse-time convention: creation order, ties broken by id. MINI.md §6 —
  // order is a convention at rebuild, not a product requirement.
  return located.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

/** Build a fresh handle table from the records in creation order. Used at collapse. */
export function rebuildHandles(brain: CartoBrain): HandleTable {
  const counters: Record<string, number> = {};
  const entries: RecordHandle[] = [];
  for (const record of locate(brain)) {
    const prefix = PREFIX[record.kind];
    const next = (counters[prefix] ?? 0) + 1;
    counters[prefix] = next;
    entries.push({ kind: record.kind, id: record.id, handle: `${prefix}${next}`, timestamp: record.createdAt });
  }
  return { counters, entries };
}

/**
 * Bring the stored table in step with the records without renumbering what
 * already has a handle: vanished records drop out, newcomers take the next
 * free number in their prefix. Deterministic — newcomers are assigned in
 * creation order.
 */
export function reconcileHandles(brain: CartoBrain): CartoBrain {
  const located = locate(brain);
  const locatedIds = new Set(located.map((record) => `${record.kind}:${record.id}`));

  const counters: Record<string, number> = { ...brain.handles.counters };
  const entries: RecordHandle[] = brain.handles.entries.filter((entry) => locatedIds.has(`${entry.kind}:${entry.id}`));
  const handled = new Set(entries.map((entry) => `${entry.kind}:${entry.id}`));

  const newcomers = located.filter((record) => !handled.has(`${record.kind}:${record.id}`));
  for (const record of newcomers) {
    const prefix = PREFIX[record.kind];
    const next = (counters[prefix] ?? 0) + 1;
    counters[prefix] = next;
    entries.push({ kind: record.kind, id: record.id, handle: `${prefix}${next}`, timestamp: record.createdAt });
  }
  return { ...brain, handles: { counters, entries } };
}

export function handleOf(table: HandleTable, kind: HandleKind, id: RecordId): string | undefined {
  return table.entries.find((entry) => entry.kind === kind && entry.id === id)?.handle;
}

export function findByHandle(table: HandleTable, handle: string): RecordHandle | undefined {
  return table.entries.find((entry) => entry.handle === handle);
}

export function handleTableFor(brain: CartoBrain): HandleTable {
  return reconcileHandles(brain).handles;
}
