/**
 * The collapse (§4) and the archive (§3.3, §4.1).
 *
 * One Pi store per generation. A collapse ends the live context, creates a
 * fresh store for the new generation, and moves what is leaving into the
 * archive — Carto's own database under `.brain/`, not the old store. The old
 * store is then deleted whole, which is what makes the sweep a real deletion
 * of the previous context rather than of a copy (§3.4); the archive's rows are
 * the record of what survived it.
 *
 * The sweep and the Brain's writes for the collapse land in one transaction
 * (§2): a crash during a collapse cannot leave a Brain that lost a record to a
 * sweep the archive never took, or an archive holding something the Brain
 * still has.
 *
 * The frozen projection snapshot for a generation is written once, at
 * creation, and is immutable until purge.
 *
 * Recovery at open is derived from those rules: a generation whose snapshot
 * is missing never existed as a frozen whole (crash mid-creation), so it is
 * deleted and the Brain — which is authoritative — builds the next one.
 * Anything beyond the newest live store and its archive is purged the same
 * way, crash remainders included.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { staleAtlasNodeIds } from "../domain/freshness.js";
import { projectContext } from "../domain/projection.js";
import type { CartoBrain } from "../domain/records.js";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { BrainStore } from "./brain-store.js";
import type { ArchivedRecord, EphemeralKind, IncomingItem } from "../domain/archive.js";
import { applyWrite, type BrainWrite } from "../domain/brain.js";
import { lexicalProjectPath } from "./workspace.js";
import { contextDirectory, removeSnapshot, snapshotPaths, writeSnapshot } from "./projection-files.js";

export interface GenerationFiles {
  generation: string;
  store: string;
  markdown: string;
  sidecar: string;
  hasStore: boolean;
  hasMarkdown: boolean;
  hasSidecar: boolean;
  mtimeMs: number;
}

export function generationPaths(root: string, generation: string): { store: string; markdown: string; sidecar: string } {
  const directory = contextDirectory(root);
  const paths = snapshotPaths(root, generation);
  return { store: resolve(directory, `${generation}.sqlite`), markdown: paths.markdown, sidecar: paths.sidecar };
}

export function newGenerationId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "T");
  return `gen-${stamp}Z-${randomBytes(3).toString("hex")}`;
}

function candidateGenerationIds(root: string): Set<string> {
  const directory = contextDirectory(root);
  const ids = new Set<string>();
  for (const name of readdirSync(directory)) {
    const match = /^(gen-[\w-]+)\.(sqlite|projection\.md|projection\.json)$/.exec(name);
    if (match !== null && match[1] !== undefined) ids.add(match[1]);
  }
  return ids;
}

export function discoverGenerations(root: string): GenerationFiles[] {
  const directory = contextDirectory(root);
  const generations: GenerationFiles[] = [];
  for (const generation of candidateGenerationIds(root)) {
    const paths = generationPaths(root, generation);
    const storeStat = existsSync(paths.store) ? statSync(paths.store) : undefined;
    const markdownStat = existsSync(paths.markdown) ? statSync(paths.markdown) : undefined;
    const sidecarStat = existsSync(paths.sidecar) ? statSync(paths.sidecar) : undefined;
    const mtimeMs = Math.max(storeStat?.mtimeMs ?? 0, markdownStat?.mtimeMs ?? 0, sidecarStat?.mtimeMs ?? 0);
    generations.push({
      generation,
      store: paths.store,
      markdown: paths.markdown,
      sidecar: paths.sidecar,
      hasStore: storeStat !== undefined,
      hasMarkdown: markdownStat !== undefined,
      hasSidecar: sidecarStat !== undefined,
      mtimeMs,
    });
  }
  // Newest first. Ties fall back to the generation name, which starts with a timestamp.
  return generations.sort((left, right) => (right.mtimeMs - left.mtimeMs) || right.generation.localeCompare(left.generation));
}

export function removeGenerationFiles(root: string, generation: GenerationFiles): void {
  unlinkIfExists(generation.store);
  removeSnapshot({ directory: contextDirectory(root), markdown: generation.markdown, sidecar: generation.sidecar });
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/**
 * Bring the generations in line with the rules at open. Returns the live
 * generation, or null when none is valid and one must be created.
 */
export function reconcileGenerations(root: string): { live: GenerationFiles | null; removed: string[] } {
  const removed: string[] = [];
  // A generation missing any piece of its snapshot never existed as a frozen
  // whole: delete it and let the Brain build the next one.
  for (;;) {
    const generations = discoverGenerations(root);
    const head = generations[0];
    if (head === undefined) return { live: null, removed };
    if (head.hasStore && head.hasMarkdown && head.hasSidecar) break;
    removeGenerationFiles(root, head);
    removed.push(head.generation);
  }
  const generations = discoverGenerations(root);
  const live = generations[0] ?? null;
  // Only the live generation's files have any use: the archive lives in the
  // Brain's own database, and a store a collapse was interrupted before
  // deleting is a crash remainder, swept into the archive where it can still
  // be reached or simply gone (§3.3, §3.4). Nothing keeps a second store.
  for (const extra of generations.slice(1)) {
    removeGenerationFiles(root, extra);
    removed.push(extra.generation);
  }
  return { live, removed };
}

/**
 * The ephemeral items a generation's store held, as the archive takes them.
 *
 * Read before the store is unlinked: what a sweep moves out of a store, it
 * moves out of a store that is then deleted whole (§3.4). Each item is kept as
 * what it was — a tool call, reasoning, plain text, a read's result, a tool
 * result, or the person's message — so a restore can put it back where it came
 * from as that thing (§3.3).
 */
export async function readGenerationEphemera(storePath: string, generation: string): Promise<IncomingItem[]> {
  if (!existsSync(storePath)) return [];
  let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
  try {
    database = await openNodeSqliteDatabase(storePath);
  } catch {
    // Not a store at all — an interrupted creation, say. Nothing to move out.
    return [];
  }
  try {
    // A store that has never held a run has no entry table yet.
    const table = await database.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pi_live_entries'",
    );
    if (table === undefined) return [];
    const rows = await database.all<{ id: number; record: string }>("SELECT id, record FROM pi_live_entries ORDER BY id");
    const incoming: IncomingItem[] = [];
    for (const row of rows) {
      const parsed = JSON.parse(row.record) as { kind?: string; data?: { content?: unknown; text?: unknown } };
      const kind = ephemeralKindOf(parsed.kind ?? "");
      if (kind === undefined) continue;
      const text = textOf(parsed.data);
      if (text === "") continue;
      incoming.push({
        id: `${generation}:${row.id}`,
        layer: "ephemeral",
        ephemeral: { kind, text },
      });
    }
    return incoming;
  } catch {
    return [];
  } finally {
    await database.close().catch(() => undefined);
  }
}

/** An entry kind as the archive names it, or undefined for the bookkeeping entries it does not keep. */
function ephemeralKindOf(kind: string): EphemeralKind | undefined {
  if (kind.includes("tool-result")) return "toolResult";
  if (kind.includes("tool-call") || kind === "pi.tool") return "toolCall";
  if (kind.includes("reasoning")) return "reasoning";
  if (kind.includes("user")) return "personMessage";
  if (kind.includes("assistant") || kind.includes("message")) return "plainText";
  return undefined;
}

/** The text of an entry, whichever place its payload keeps it. */
function textOf(data: { content?: unknown; text?: unknown } | undefined): string {
  if (data === undefined) return "";
  if (typeof data.text === "string") return data.text;
  if (typeof data.content === "string") return data.content;
  if (Array.isArray(data.content)) {
    return data.content
      .map((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
}

/** Lexical resolve; returns null instead of throwing. */
function safeResolve(root: string, path: string): string | null {
  try {
    return lexicalProjectPath(root, path);
  } catch {
    return null;
  }
}

function mtimeOf(root: string, path: string): number | null {
  const real = safeResolve(root, path);
  if (real === null) return null;
  try {
    return statSync(real).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Check every Atlas file attachment against the filesystem and apply the
 * resulting collapse-time marks. Must run before the snapshot is rendered,
 * so the frozen projection carries the fresh-from-rebuild truth: a drifted
 * attachment marks the node stale, a fresh one clears the mark, like a pin.
 */
export async function refreshFreshness(root: string, brain: CartoBrain, apply: BrainStore["apply"], now: number): Promise<CartoBrain> {
  const stale = new Set(staleAtlasNodeIds(brain, (path) => mtimeOf(root, path)));
  let next = brain;
  for (const node of brain.atlas) {
    const shouldBeStale = stale.has(node.id);
    const isStale = node.stale === true;
    if (shouldBeStale === isStale) continue;
    next = await apply({ kind: "atlas.stale", id: node.id, stale: shouldBeStale }, now);
  }
  return next;
}

export interface CollapseOptions {
  /** The collapse's own clock; defaults to now. */
  now?: () => number;
}

export interface CollapseReport {
  /** The fresh generation, its snapshot written and immutable. */
  generation: string;
  /** The generation whose store was swept and deleted at this collapse. */
  swept: string;
  /** Archive items whose one collapse of grace ran out here. */
  dropped: readonly string[];
  /** Brain records the sweep moved out of the Brain because they were marked for archive. */
  archived: readonly string[];
}

/**
 * Collapse: refresh the Brain's freshness marks, render the frozen projection
 * for the new generation, move what is leaving into the archive, delete the
 * old store whole, and VACUUM the Brain. The caller owns the live session's
 * lifecycle around this call.
 */
export async function collapse(root: string, brain: BrainStore, options: CollapseOptions = {}): Promise<CollapseReport> {
  const now = options.now?.() ?? Date.now();
  const refreshed = await refreshFreshness(root, await brain.read(), brain.apply.bind(brain), now);

  const discovered = discoverGenerations(root);
  const live = discovered[0];
  if (live === undefined) throw new Error("No live generation exists to collapse.");
  const generation = newGenerationId(new Date(now));

  // What is leaving the Brain: every record carrying a mark, with its action.
  // The writes below take each one out of the Brain, because an applied mark is
  // a mark gone and, for archive, the record is a Brain record no longer (§4.1).
  const leaving = markedForCollapse(refreshed);
  // What is leaving the old store. §3.4 has the store deleted whole, so only a
  // record the person pinned in the live context survives in the archive; the
  // rest is deleted, which is the point of deleting the store rather than
  // hiding it. Nothing here reads the store's contents.
  const ephemera: IncomingItem[] = [];

  // The Brain the new generation is built from: the marks applied, so a record
  // that is archived or deleted is not in the head it was swept out of (§2,
  // §4.1). The same writes go into the transaction below, so what is rendered
  // and what is committed are the same Brain.
  const writes: { write: BrainWrite; now: number }[] = [];
  for (const record of leaving) {
    writes.push({ write: { kind: "mark.clear", target: record.kind, id: record.id }, now });
    writes.push({ write: { kind: "delete", target: record.kind, id: record.id }, now });
  }
  let next = refreshed;
  for (const step of writes) next = applyWrite(next, step.write, step.now);
  const projection = projectContext(next);

  // 1. Snapshot first: no store exists for the new generation until the bytes
  //    are frozen on disk.
  writeSnapshot(root, generation, projection, now);
  // 1b. The generation exists only when its store does: an empty, valid
  //     database, so an open-time reconcile cannot mistake the frozen
  //     snapshot for a crash remainder and delete it. Pi creates its tables on
  //     first open.
  const created = await openNodeSqliteDatabase(generationPaths(root, generation).store);
  await created.close();
  // 1c. The Brain writes that record what the sweep did — a mark applied is a
  //     mark gone — plus the moves out of the Brain and the store, and the
  //     archive's expiry, all in one transaction (§2, §3.4).
  const applied = await brain.applyCollapse({
    writes,
    generation,
    incoming: [
      ...leaving.flatMap((record) => (record.incoming === undefined ? [] : [record.incoming])),
      ...ephemera,
    ],
    now,
  });
  // 2. The old store is deleted whole. Everything it held is gone rather than
  //    hidden, which is what makes the sweep a real deletion (§3.4).
  removeGenerationFiles(root, live);
  return {
    generation,
    swept: live.generation,
    dropped: applied.dropped,
    archived: leaving.filter((record) => record.action === "archive").map((record) => record.id),
  };
}

/** The record as it will sit in the archive: the mark is the Brain's business, and it is about to be applied. */
function withoutMark<T extends { mark?: unknown }>(record: T): Omit<T, "mark"> {
  const copy: Record<string, unknown> = { ...record };
  delete copy.mark;
  return copy as Omit<T, "mark">;
}

/** A Brain record a collapse is about to act on, and the archive row it becomes when it is archived. */
interface LeavingRecord {
  kind: "chat" | "ledger" | "atlas";
  id: string;
  action: "archive" | "delete";
  incoming?: IncomingItem;
}

/**
 * Every Brain record carrying a mark (§4.1). An archive mark moves the record
 * into the archive; a delete mark removes it, for real, and leaves nothing
 * behind.
 */
function markedForCollapse(brain: CartoBrain): LeavingRecord[] {
  const out: LeavingRecord[] = [];
  const take = (kind: "chat" | "ledger" | "atlas", record: { id: string; mark?: { action: string } }): void => {
    const action = record.mark?.action;
    if (action !== "archive" && action !== "delete") return;
    out.push({
      kind,
      id: record.id,
      action,
      ...(action === "archive"
        ? {
            incoming: {
              id: `record:${kind}:${record.id}`,
              layer: "record" as const,
              // The record as it stood in the Brain, minus the mark it was carrying.
              record: { kind, value: withoutMark(record) as ArchivedRecord },
            },
          }
        : {}),
    });
  };
  for (const record of brain.chat) take("chat", record);
  for (const entry of brain.ledger) take("ledger", entry);
  for (const node of brain.atlas) take("atlas", node);
  return out;
}
