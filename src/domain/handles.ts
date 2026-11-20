import type {
  CartoBrain,
  HandleKind,
  HandleTable,
  RecordHandle,
} from "./types.js";
import { byCreatedAt } from "./brain.js";

export type { HandleKind, HandleTable, RecordHandle };

export interface HandleRecord {
  kind: HandleKind;
  id: string;
  timestamp: number;
}

export interface ResolvedHandle {
  kind: HandleKind;
  id: string;
}

/** All handle kinds in their fixed allocation order. */
export const HANDLE_KINDS: readonly HandleKind[] = ["ledger", "chat", "atlas", "pin", "wake"];

const PREFIX: Record<HandleKind, string> = {
  ledger: "L",
  chat: "C",
  atlas: "A",
  pin: "P",
  wake: "W",
};

export function emptyHandleTable(): HandleTable {
  return { counters: {}, entries: [] };
}

export function handleKey(kind: HandleKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Keep every known handle and give the next free number to each new record.
 * Editing a record never moves it: Ledger stays in creation order. A collapse
 * passes no previous table, so the new generation starts again at 1.
 */
export function assignHandles(previous: HandleTable | undefined, records: readonly HandleRecord[]): HandleTable {
  const counters: Record<string, number> = { ...(previous?.counters ?? {}) };
  const known = new Map<string, string>();
  for (const entry of previous?.entries ?? []) known.set(handleKey(entry.kind, entry.id), entry.handle);
  const entries: RecordHandle[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const key = handleKey(record.kind, record.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = known.get(key);
    // Keep one key order so an unchanged table compares equal to its stored form.
    entries.push({ kind: record.kind, id: record.id, handle: existing ?? nextHandle(counters, record.kind), timestamp: record.timestamp });
  }
  return { counters, entries };
}

function nextHandle(counters: Record<string, number>, kind: HandleKind): string {
  const prefix = PREFIX[kind];
  const next = (counters[prefix] ?? 0) + 1;
  counters[prefix] = next;
  return `${prefix}${next}`;
}

/** The canonical record list. Its order matches the order of fresh context. */
export function collectHandleRecords(brain: CartoBrain): HandleRecord[] {
  const records: HandleRecord[] = [];
  for (const entry of byCreatedAt(brain.ledger)) records.push({ kind: "ledger", id: entry.id, timestamp: entry.createdAt });
  for (const entry of byCreatedAt(brain.chat)) records.push({ kind: "chat", id: entry.id, timestamp: entry.createdAt });
  for (const entry of byCreatedAt(brain.atlas)) records.push({ kind: "atlas", id: entry.id, timestamp: entry.createdAt });
  for (const pin of byCreatedAt(brain.userPins)) records.push({ kind: "pin", id: pin.id, timestamp: pin.createdAt });
  for (const pin of byCreatedAt(brain.carryPins)) records.push({ kind: "pin", id: pin.id, timestamp: pin.createdAt });
  for (const wake of byCreatedAt(brain.wakes)) {
    if (wake.status === "armed" || wake.status === "ready") records.push({ kind: "wake", id: wake.id, timestamp: wake.createdAt });
  }
  return records;
}

/** Bring the stored table up to date without renumbering any known record. */
export function ensureHandles(table: HandleTable | undefined, brain: CartoBrain): HandleTable {
  return assignHandles(table, collectHandleRecords(brain));
}

/** The table a new live generation starts with, numbered from 1. */
export function freshHandles(brain: CartoBrain): HandleTable {
  return assignHandles(undefined, collectHandleRecords(brain));
}

export function handleOf(table: HandleTable | undefined, kind: HandleKind, id: string): string | undefined {
  if (table === undefined) return undefined;
  const key = handleKey(kind, id);
  return table.entries.find((entry) => handleKey(entry.kind, entry.id) === key)?.handle;
}

/** Resolve one public handle. An unknown handle returns undefined. */
export function resolveHandle(table: HandleTable | undefined, handle: string): ResolvedHandle | undefined {
  if (table === undefined) return undefined;
  const normalized = handle.trim().toUpperCase();
  const entry = table.entries.find((candidate) => candidate.handle === normalized);
  return entry === undefined ? undefined : { kind: entry.kind, id: entry.id };
}

/** Resolve a handle that must name one of the allowed kinds or fail explicitly. */
export function resolveHandleOfKind(table: HandleTable | undefined, handle: string, allowed: readonly HandleKind[]): ResolvedHandle {
  const resolved = resolveHandle(table, handle);
  if (resolved === undefined) throw new Error(`Carto does not know the handle ${handle}. Use a handle from the current context.`);
  if (!allowed.includes(resolved.kind)) {
    throw new Error(`The handle ${handle} does not name a ${allowed.join(" or ")} record.`);
  }
  return resolved;
}

/** A person-facing list such as `L1, L3`, or `none`. */
export function listHandles(table: HandleTable | undefined, ids: readonly string[], kind: HandleKind): string {
  const values = ids.map((id) => handleOf(table, kind, id)).filter((value): value is string => value !== undefined);
  return values.join(", ") || "none";
}

/** Resolve a list of handles of one kind, keeping private IDs in order. */
export function resolveHandlesOfKind(table: HandleTable | undefined, handles: readonly string[], kind: HandleKind): string[] {
  return handles.map((handle) => {
    const resolved = resolveHandleOfKind(table, handle, [kind]);
    return resolved.id;
  });
}
