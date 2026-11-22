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
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { staleAtlasNodeIds } from "../domain/freshness.js";
import { projectContext } from "../domain/projection.js";
import { personName } from "../domain/person.js";
import type { CartoBrain } from "../domain/records.js";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { BrainStore } from "./brain-store.js";
import { withoutMark, type ArchivedItem, type ArchivedRecord, type EphemeralKind, type IncomingItem } from "../domain/archive.js";
import type { PinnedEphemeral } from "../domain/records.js";
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
 * Read from the store's own entries table (`entries`, under the `live_`
 * prefix, one JSON `record` per row), before the store is deleted whole — what
 * a sweep moves out of a store, it moves out of a store that is then gone
 * (§3.4). Each item is kept as what it was, so a restore can put it back as
 * that thing (§3.3), and the entity a result came from is derived the same way
 * the prompt derives it (§5.4): the call it answers already carries the handle.
 *
 * Only what §3.1 calls ephemeral is taken. A Brain record or a Chat record is
 * not in the store's body and is not swept here; a record leaves the Brain by
 * its own mark (§4.1).
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
    const table = await database.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'live_entries'",
    );
    if (table === undefined) return [];
    const rows = await database.all<{ id: string; head: number | null; record: string }>(
      "SELECT id, head, record FROM live_entries ORDER BY id",
    );
    // Only what is still in the context is swept. A head marker starts a new
    // context — a reset — and everything before it is already out of the model's
    // view, so sweeping it would put text in the archive that the collapse did
    // not take out of the context. Compaction is declined here and a collapse
    // builds a new store rather than cutting, so the newest head is the whole of
    // it; there is no second, later cut to walk.
    const newestHead = rows.reduce<number>((latest, row) => (row.head === null ? latest : Math.max(latest, Number(row.id))), 0);
    const tools = new Map<string, { name: string; path?: string }>();
    const parsed = rows
      .filter((row) => Number(row.id) >= newestHead)
      .map((row) => ({ id: String(row.id), entry: JSON.parse(row.record) as StoredEntry }));
    for (const { entry } of parsed) {
      for (const call of toolCallsOf(entry)) tools.set(call.id, call);
    }
    const incoming: IncomingItem[] = [];
    for (const { id, entry } of parsed) {
      // The entity is what a restore needs to put the item back where it was:
      // the tool call's own id, and for a result the call it answers.
      const callId = callIdOf(entry);
      const call = callId === undefined ? undefined : tools.get(callId);
      const tool = call?.name;
      const path = call?.path;
      for (const part of ephemeralPartsOf(entry, tool)) {
        incoming.push({
          id: ephemeralItemId(generation, id, part.key),
          layer: "ephemeral",
          ephemeral: {
            ...part.value,
            ...(callId === undefined
              ? {}
              : { data: { callId, ...(tool === undefined ? {} : { tool }), ...(path === undefined ? {} : { path }) } }),
          },
        });
      }
    }
    return incoming;
  } catch {
    // A store whose shape this build does not recognise is not one to guess at:
    // the collapse still runs, and the store is still deleted whole (§3.4).
    return [];
  } finally {
    await database.close().catch(() => undefined);
  }
}

/** One row of the store's entries table, as far as the sweep reads it. */
interface StoredEntry {
  kind?: string;
  model?: Array<{ role?: string; content?: unknown }>;
}

/** A tool call in one entry, by the id the model issued and the tool's name. */
function toolCallsOf(entry: StoredEntry): Array<{ id: string; name: string; path?: string }> {
  const calls: Array<{ id: string; name: string; path?: string }> = [];
  for (const message of entry.model ?? []) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part === null || typeof part !== "object" || (part as { type?: unknown }).type !== "toolCall") continue;
      const call = part as { id?: unknown; name?: unknown; arguments?: unknown };
      if (typeof call.id !== "string" || typeof call.name !== "string") continue;
      // What a `read` was a read of is in the call's arguments, and the call is
      // the last place it exists once the store is gone: a result says only
      // what came back. Keeping it lets the archive say what restoring means.
      const args = call.arguments;
      const path =
        args !== null && typeof args === "object" && typeof (args as { path?: unknown }).path === "string"
          ? (args as { path: string }).path
          : undefined;
      calls.push({ id: call.id, name: call.name, ...(path === undefined ? {} : { path }) });
    }
  }
  return calls;
}

/** The tool call a tool result answers, when the entry is one. */
function callIdOf(entry: StoredEntry): string | undefined {
  for (const message of entry.model ?? []) {
    const id = (message as { toolCallId?: unknown }).toolCallId;
    if (message.role === "toolResult" && typeof id === "string") return id;
  }
  return undefined;
}

/** The model context one entry carried, as the text a person would read. */
function modelTexts(entry: StoredEntry): { thinking: string[]; text: string[] } {
  const thinking: string[] = [];
  const text: string[] = [];
  for (const message of entry.model ?? []) {
    if (!Array.isArray(message.content)) {
      if (typeof message.content === "string" && message.content.trim().length > 0) text.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part === null || typeof part !== "object") continue;
      const piece = part as { type?: unknown; thinking?: unknown; text?: unknown };
      if (piece.type === "thinking" && typeof piece.thinking === "string" && piece.thinking.trim().length > 0) {
        thinking.push(piece.thinking);
      } else if (piece.type === "text" && typeof piece.text === "string" && piece.text.trim().length > 0) {
        text.push(piece.text);
      }
    }
  }
  return { thinking, text };
}

/**
 * What one entry contributes to the archive. Nothing for the bookkeeping an
 * entry can also carry — a marker, a reset, a diagnostics payload — because
 * none of it is something the person could have been reading.
 */
/**
 * The id a swept ephemeral item goes by, and the id the person pins it under.
 *
 * Both sides call this: the collapse, when it writes the item into the archive
 * and decides whether a pin keeps it here, and the Context view, which offers
 * the pin. A pin is only a promise if it names the thing being swept, so the
 * name is made in one place rather than each side spelling it out.
 */
export function ephemeralItemId(generation: string, entryId: string | number, key: string): string {
  return `${generation}:${entryId}:${key}`;
}

export function ephemeralPartsOf(entry: StoredEntry, tool: string | undefined): Array<{ key: string; value: NonNullable<IncomingItem["ephemeral"]> }> {
  const parts: Array<{ key: string; value: NonNullable<IncomingItem["ephemeral"]> }> = [];
  const role = entry.model?.find((message) => typeof message.role === "string")?.role;
  const { thinking, text } = modelTexts(entry);
  for (const [index, value] of thinking.entries()) parts.push({ key: `t${index}`, value: { kind: "reasoning", text: value } });

  if (role === "toolResult") {
    const result = text.join("\n");
    if (result.trim().length === 0) return parts;
    // A read's result is its own kind, because that is the one a restore has to
    // make true again rather than merely put back (§5.5).
    const kind: EphemeralKind = tool === "read" ? "readResult" : "toolResult";
    parts.push({ key: "r", value: { kind, text: result } });
    return parts;
  }
  // A person's message is the one kind that is somebody's words rather than the
  // model's own: restoring it puts a message back, so it is not `plainText`.
  const kind: EphemeralKind = role === "user" ? "personMessage" : "plainText";
  for (const [index, value] of text.entries()) parts.push({ key: `x${index}`, value: { kind, text: value } });
  return parts;
}

/**
 * A pinned file's text as it stands, or `undefined` when it cannot be read:
 * outside the project, missing, or not a text file this can hold. The head says
 * so in its place, and the pin's stale mark does the same in the state block.
 */
function readPinnedFile(root: string, path: string): string | undefined {
  const real = safeResolve(root, path);
  if (real === null) return undefined;
  try {
    if (statSync(real).isDirectory()) return undefined;
    return readFileSync(real, "utf8");
  } catch {
    return undefined;
  }
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
  /**
   * The name the agent calls the person, written into the head this collapse
   * freezes. Absent: the launching account, resolved here — the head is what
   * the agent reads after the collapse, so it must name somebody either way.
   */
  person?: string;
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
  /**
   * Items a mark restored. A Brain record went back inside the collapse's own
   * transaction; an ephemeral item has no home in the Brain, so it travels here
   * for the caller to put back into the live context (§3.3).
   */
  restored: readonly ArchivedItem[];
  /** Archive items a mark deleted for good. */
  deleted: readonly string[];
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
  // What is leaving the old store (§3.1, §3.4).
  //
  // An ephemeral item survives a collapse only if it is pinned (§3.1), and a pin
  // is a promise it stays where it is, so a pinned item is not swept: it is in
  // the Brain, and the new generation's head is built from the Brain. Everything
  // else the store held is swept. The store is then deleted whole, so nothing
  // swept has been copied anywhere the context could still read it.
  //
  // A pin outlives the store it was placed in: the item is in the Brain, and the
  // head is rebuilt from the Brain, so it is in the next store's head without
  // being read out of this one.
  const pins = new Set(refreshed.ephemera.filter((item) => item.pinned !== undefined).map((item) => item.id));
  const swept = (await readGenerationEphemera(live.store, live.generation)).filter((item) => !pins.has(item.id));

  // The Brain the new generation is built from: the marks applied, so a record
  // that is archived or deleted is not in the head it was swept out of (§2,
  // §4.1). The same writes go into the transaction below, so what is rendered
  // and what is committed are the same Brain.
  const writes: { write: BrainWrite; now: number }[] = [];
  for (const record of leaving) {
    writes.push({ write: { kind: "mark.clear", target: record.kind, id: record.id }, now });
    writes.push({ write: { kind: "delete", target: record.kind, id: record.id }, now });
  }
  // A pinned file is read again here, at the collapse, so the head holds the
  // file as it now stands rather than a quotation of an earlier read (§5.1,
  // §5.5). A pinned `read` result is made true the same way (§5.5): its text
  // becomes what the file holds now, and if the file is gone it keeps its text
  // and is marked stale, because a pin that silently kept the old bytes would
  // be the stale quotation the pin exists to prevent.
  const fileTexts = new Map<string, string | undefined>();
  for (const file of refreshed.files) {
    const text = readPinnedFile(root, file.path);
    fileTexts.set(file.path, text);
    const stale = text === undefined;
    const already = file.stale === true;
    if (stale !== already) writes.push({ write: { kind: "file.stale", path: file.path, stale }, now });
  }
  for (const item of refreshed.ephemera) {
    if (item.pinned === undefined) continue;
    const path = item.kind === "readResult" ? item.entity?.path : undefined;
    if (path === undefined) continue;
    const text = readPinnedFile(root, path);
    if (text === undefined) continue;
    const refreshedItem: PinnedEphemeral = { ...item, text };
    writes.push({ write: { kind: "ephemeral.pin", item: refreshedItem }, now });
  }

  let next = refreshed;
  for (const step of writes) next = applyWrite(next, step.write, step.now);
  const projection = projectContext(next, fileTexts, options.person ?? personName());

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
      ...swept,
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
    restored: applied.restored,
    deleted: applied.deleted,
  };
}

/**
 * Re-freeze the head for the live generation, in place (§4.1).
 *
 * This is the one sanctioned exception to a snapshot's immutability. Applying
 * an action now is a rebuild at that point, and the head is the projection of
 * the Brain — so a Brain record that left the Brain has to leave the head in
 * the same step, or the person would be shown a prompt the model no longer
 * reads. Everything before the changed entry stays byte-identical, which is
 * what the provider's cached prefix is paid for again from there; that is the
 * cost §4.1 names, and it is why the UI says so before the key is pressed.
 *
 * Nothing else moves: the generation stays, the store stays, nothing is swept
 * and no grace is spent, because this is not a collapse.
 */
export function rewriteHeadSnapshot(root: string, generation: string, brain: CartoBrain, person: string, now: number): void {
  const fileTexts = new Map<string, string | undefined>();
  for (const file of brain.files) fileTexts.set(file.path, readPinnedFile(root, file.path));
  writeSnapshot(root, generation, projectContext(brain, fileTexts, person), now);
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
