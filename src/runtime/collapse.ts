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
 * Recovery uses a journal committed with the Brain and archive. A transition
 * that did not commit keeps its original store; one that committed keeps its
 * destination. Unjournaled stores whose history is ambiguous are preserved.
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { staleAtlasNodeIds } from "../domain/freshness.js";
import { userText } from "../domain/chat-identity.js";
import { projectContext } from "../domain/projection.js";
import { personName } from "../domain/person.js";
import type { CartoBrain } from "../domain/records.js";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { writeBackOf, type BrainStore } from "./brain-store.js";
import { applyArchiveMarks, withoutMark, type ArchivedItem, type ArchivedRecord, type EphemeralKind, type IncomingItem } from "../domain/archive.js";
import type { PinnedEphemeral } from "../domain/records.js";
import { applyWrite, type BrainWrite } from "../domain/brain.js";
import { assertFileScope, isImageFile, lexicalProjectPath, readProjectSettings, resolvePinnedFile, resolveReadReference } from "./workspace.js";
import { contextDirectory, removeSnapshot, snapshotPaths, writeSnapshot } from "./projection-files.js";
import { parseReturnedDelegation, type DelegationTransfer, type StoredCheckpoint } from "./delegation-record.js";
import { validateInputTransfer } from "./delegate-inputs.js";
import { clearedInputCheckpoint, clearedInputReplay } from "./delegate-input-replay.js";
import type { ReturnSweepView } from "./delegate-sweep-view.js";

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

const activeCollapses = new Set<string>();

/**
 * Read the exact Pi checkpoint in one SQLite snapshot. This document always
 * checkpoints its changes; an unexpected revision or incarnation is ambiguous
 * and must not be discarded. The caller must stop generation writers: this
 * check is not a cross-process lock.
 */
type StoredDelegation = StoredCheckpoint & { inputCheckpoint?: NonNullable<DelegationTransfer["inputCheckpoint"]> };

export async function readStoredDelegation(storePath: string, transferInputs = false): Promise<StoredDelegation | undefined> {
  if (!existsSync(storePath)) return undefined;
  const database = await openNodeSqliteDatabase(storePath, { mode: "read-only" });
  try {
    return await database.transaction(async (tx) => {
      const documents = await tx.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'live_documents'",
      );
      if (documents === undefined) return undefined;
      // Pi JSON-encodes indexed strings, including document kinds and keys.
      const readDoc = async (kind: string, label: string): Promise<StoredCheckpoint | undefined> => {
        const rows = await tx.all<{ id: number; scope_kind: string; owner_id: number; family: number; key_value: string; retired_at: number | null }>(
          "SELECT id, scope_kind, owner_id, family, key_value, retired_at FROM live_documents WHERE kind = ?", JSON.stringify(kind),
        );
        if (rows.length === 0) return undefined;
        const doc = rows[0];
        if (rows.length !== 1 || doc === undefined || doc.scope_kind !== "conversation" || doc.owner_id !== 1 || doc.family !== 0 || doc.key_value !== JSON.stringify("") || doc.retired_at !== null) {
          throw new Error(`Ambiguous ${label} document; the generation store was preserved.`);
        }
        const revision = await tx.get<{ seq: number; kind: string; version: number; content: string }>(
          "SELECT seq, kind, version, content FROM live_document_revisions WHERE document_id = ? ORDER BY seq DESC LIMIT 1", doc.id,
        );
        if (revision === undefined || revision.kind !== "base" || revision.version !== 1 || !Number.isSafeInteger(doc.id) || doc.id < 1 || !Number.isSafeInteger(revision.seq) || revision.seq < 1) {
          throw new Error(`Unsupported ${label} checkpoint; the generation store was preserved.`);
        }
        return { documentId: doc.id, revision: revision.seq, content: revision.content };
      };
      let checkpoint = await readDoc("carto.delegate-input-checkpoint", "delegate input checkpoint");
      const replay = await readDoc("carto.delegate-input-replay", "delegate input staging");
      if (replay !== undefined && !clearedInputReplay(JSON.parse(replay.content))) {
        throw new Error("Delegate input staging is awaiting reconciliation; the generation store was preserved.");
      }
      if (checkpoint !== undefined && clearedInputCheckpoint(JSON.parse(checkpoint.content))) checkpoint = undefined;
      if (checkpoint !== undefined && !transferInputs) throw new Error("A delegate input checkpoint is awaiting transfer; the generation store was preserved.");
      const handoff = await readDoc("carto.delegation", "delegation");
      if (handoff === undefined) {
        if (checkpoint !== undefined) throw new Error("Delegate input checkpoint lacks a handoff; the generation store was preserved.");
        return undefined;
      }
      const value: unknown = JSON.parse(handoff.content);
      if (value !== null && typeof value === "object" && !Array.isArray(value) &&
          Object.keys(value).length === 1 && (value as { active?: unknown }).active === null && checkpoint === undefined) return undefined;
      const active = parseReturnedDelegation(handoff.content).active;
      if (active === null || active.phase !== "returned") throw new Error("Invalid delegation; the generation store was preserved.");
      if (checkpoint === undefined) return handoff;
      const barrier = await readDoc("carto.delegate-main-barrier", "delegate source barrier");
      if (barrier === undefined || checkpoint.documentId === handoff.documentId || barrier.documentId === handoff.documentId) {
        throw new Error("Delegate input checkpoint lacks its source barrier; the generation store was preserved.");
      }
      const inputCheckpoint = { ...checkpoint, barrier };
      validateInputTransfer(inputCheckpoint, active.input.id);
      return { ...handoff, inputCheckpoint };
    });
  } finally {
    await database.close();
  }
}

/**
 * A return sweep cannot yet archive several conversations safely. In particular,
 * the existing sweep has a global head and the restore path targets main. Keep
 * the source until conversation-aware archival and input recovery are available.
 * As with the handoff check, the caller must have stopped all source writers.
 */
async function requireSingleConversationReturn(storePath: string): Promise<void> {
  const database = await openNodeSqliteDatabase(storePath, { mode: "read-only" });
  try {
    const extra = await database.get<{ id: number }>("SELECT id FROM live_conversations WHERE id <> 1 LIMIT 1");
    if (extra !== undefined) {
      throw new Error("A return sweep with multiple conversations is not yet safe; the generation store was preserved.");
    }
    const root = await database.get<{ id: number }>("SELECT id FROM live_conversations WHERE id = 1");
    if (root === undefined) throw new Error("A return sweep has no root conversation; the generation store was preserved.");
  } finally {
    await database.close();
  }
}

/**
 * Resolve an interrupted cross-database collapse before the ordinary generation
 * cleanup runs. The Brain journal is written before any destination file and is
 * committed atomically with the sweep. Never infer success from timestamps.
 */
export async function recoverCollapse(root: string, brain: BrainStore, finishing = false): Promise<void> {
  if (activeCollapses.has(resolve(root)) && !finishing) throw new Error("A collapse is still running for this project.");
  await brain.recoverCollapseJournal(async (journal, transfer) => {
    if (!Number.isSafeInteger(journal.ownerPid) || journal.ownerPid <= 0) throw new Error("Invalid collapse owner; all generation files were preserved.");
    if (journal.ownerPid !== process.pid) {
      let alive = true;
      try { process.kill(journal.ownerPid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) throw new Error("Another process may still be collapsing this project; all generation files were preserved.");
    }
    const valid = (id: string) => /^gen-[\w-]+$/.test(id);
    if (!valid(journal.source) || !valid(journal.destination) || journal.source === journal.destination) {
      throw new Error("Invalid collapse journal; refusing to remove generation files.");
    }
    const keep = generationPaths(root, journal.committed ? journal.destination : journal.source);
    if (!existsSync(keep.store) || !existsSync(keep.markdown) || !existsSync(keep.sidecar)) {
      throw new Error("Collapse recovery cannot find the complete generation to keep; all remaining files were preserved.");
    }
    const keepDatabase = await openNodeSqliteDatabase(keep.store, { mode: "read-only" });
    try {
      const integrity = await keepDatabase.get<{ quick_check: string }>("PRAGMA quick_check");
      if (integrity?.quick_check !== "ok") throw new Error("The generation to keep failed its integrity check.");
    } finally {
      await keepDatabase.close();
    }
    const discardId = journal.committed ? journal.source : journal.destination;
    const discard = generationPaths(root, discardId);
    // A committed sweep may delete the source only if any handoff still in it
    // exactly matches the copy committed with that sweep. A missing source is
    // possible after cleanup completed but before the journal was cleared.
    if (journal.committed) {
      if (transfer !== undefined && (transfer.source !== journal.source || transfer.destination !== journal.destination)) {
        throw new Error("Delegation transfer does not match the collapse journal; all generation files were preserved.");
      }
      if (existsSync(discard.store)) {
        const stored = await readStoredDelegation(discard.store, transfer?.inputCheckpoint !== undefined);
        const expected = transfer === undefined ? undefined : {
          documentId: transfer.documentId, revision: transfer.revision, content: transfer.content,
          ...(transfer.inputCheckpoint === undefined ? {} : { inputCheckpoint: transfer.inputCheckpoint }),
        };
        if (JSON.stringify(stored ?? null) !== JSON.stringify(expected ?? null)) {
          throw new Error("Delegation record changed or was not transferred; all generation files were preserved.");
        }
        // A journal committed by an older version may have swept the wrong
        // range. Do not destroy its source, even though the Brain committed.
        if (stored !== undefined) await requireSingleConversationReturn(discard.store);
      }
    }
    // A partially written destination is disposable only before the Brain commit;
    // after commit, the old source is disposable only because the archive owns it.
    unlinkIfExists(discard.store);
    if (existsSync(discard.store)) throw new Error("Collapse recovery could not remove the superseded store; its journal remains for retry.");
    unlinkIfExists(`${discard.store}-wal`);
    unlinkIfExists(`${discard.store}-shm`);
    removeSnapshot({ directory: contextDirectory(root), markdown: discard.markdown, sidecar: discard.sidecar });
    if ([discard.store, `${discard.store}-wal`, `${discard.store}-shm`, discard.markdown, discard.sidecar].some(existsSync)) {
      throw new Error("Collapse recovery could not remove the superseded generation; its journal remains for retry.");
    }
  });
}

/**
 * Bring the generations in line with the rules at open. Returns the live
 * generation, or null when none is valid and one must be created.
 */
export async function reconcileGenerations(root: string, brain: BrainStore): Promise<{ live: GenerationFiles | null; removed: string[] }> {
  await recoverCollapse(root, brain);
  const generations = discoverGenerations(root);
  const stores = generations.filter((generation) => generation.hasStore);
  // Legacy unjournaled crash remainders are ambiguous: a newer store may have
  // been created before the sweep committed. Also, a store whose snapshot has
  // gone missing may still hold the only copy of live messages. Never guess.
  if (stores.some((generation) => !generation.hasMarkdown || !generation.hasSidecar)) {
    throw new Error("A generation store is missing its snapshot; all generation files were preserved for recovery.");
  }
  if (stores.length > 1) {
    throw new Error("Multiple unjournaled generation stores exist; all were preserved for recovery.");
  }
  const removed: string[] = [];
  for (const incomplete of generations.filter((generation) => !generation.hasStore)) {
    removeGenerationFiles(root, incomplete);
    removed.push(incomplete.generation);
  }
  return { live: stores[0] ?? null, removed };
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
  if (!existsSync(storePath)) throw new Error(`Live generation store is missing: ${storePath}`);
  // Failure to read the old store must abort collapse before the store is
  // removed. Treating a damaged database as an empty one destroys its only copy.
  const database = await openNodeSqliteDatabase(storePath, { mode: "read-only" });
  try {
    const table = await database.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'live_entries'",
    );
    if (table === undefined) {
      // A freshly created generation has an empty SQLite file before Pi opens
      // it. A database with other tables but no entries is not that state.
      const other = await database.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
      );
      if (other !== undefined) throw new Error(`Live generation has an unrecognized store schema: ${storePath}`);
      return [];
    }
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
    const parsed = rows
      .filter((row) => Number(row.id) >= newestHead)
      .map((row) => {
        const entry = JSON.parse(row.record) as StoredEntry;
        return { id: String(row.id), entry, original: entry };
      });
    // Pi's context edits supersede the raw model contribution. A delete applied
    // now must not reappear in the archive when the old store is swept.
    const edits = new Map<string, NonNullable<StoredEntry["edits"]>[number]>();
    for (const { entry } of parsed) {
      for (const edit of entry.edits ?? []) edits.set(String(edit.target), edit);
    }
    for (const item of parsed) {
      const edit = edits.get(item.id);
      if (edit !== undefined) item.entry = { ...item.entry, model: edit.action === "replace" ? (edit.messages ?? []) : [] };
    }
    return sweepParsedEntries(parsed, generation).map(({ item }) => item);
  } finally {
    await database.close().catch(() => undefined);
  }
}

/** Reuse the existing Carto archive conversion for one set of entries. */
type SweepEntry = { id: string; entry: StoredEntry; original: StoredEntry };
function sweepParsedEntries(parsed: SweepEntry[], generation: string): Array<{ entryId: string; item: IncomingItem }> {
  const tools = new Map<string, { name: string; path?: string }>();
  const callMessages = new Map<string, unknown>();
  const removed = removedPartKeys(parsed.map(({ original }) => original), generation);
  const changedParts = editedPartValues(parsed.map(({ original }) => original), generation);
  for (const { original } of parsed) {
    // Keep pairing metadata even when an edit removed the call. The result's
    // original bytes must still be recoverable rather than silently discarded.
    for (const call of toolCallsOf(original)) tools.set(call.id, call);
    for (const message of original.model ?? []) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part === null || typeof part !== "object") continue;
        const call = part as { type?: unknown; id?: unknown };
        if (call.type === "toolCall" && typeof call.id === "string") callMessages.set(call.id, { ...message, content: [part] });
      }
    }
  }
  // Prefer the call actually in the context when saving a result's restore
  // payload, but retain the original as a fallback for an omitted call.
  for (const { entry } of parsed) {
    for (const call of toolCallsOf(entry)) tools.set(call.id, call);
    for (const message of entry.model ?? []) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part === null || typeof part !== "object") continue;
        const call = part as { type?: unknown; id?: unknown };
        if (call.type === "toolCall" && typeof call.id === "string") callMessages.set(call.id, { ...message, content: [part] });
      }
    }
  }
  const incoming: Array<{ entryId: string; item: IncomingItem }> = [];
  for (const { id, entry, original } of parsed) {
    const oldMessage = original.model?.[0];
    const message = entry.model?.[0];
    const keys = oldMessage?.role === "assistant" && message?.role === "assistant"
      ? stablePartKeys(oldMessage.content, message.content, removed.get(id) ?? new Set(), changedParts.get(id))
      : undefined;
    // The entity is what a restore needs to put the item back where it was:
    // the tool call's own id, and for a result the call it answers.
    const callId = callIdOf(entry);
    const call = callId === undefined ? undefined : tools.get(callId);
    const tool = call?.name;
    const path = call?.path;
    for (const part of ephemeralPartsOf(entry, tool, keys)) {
      let model: unknown;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        const index = keys?.indexOf(part.key) ?? -1;
        if (index >= 0) model = [{ ...message, content: [message.content[index]], stopReason: part.value.kind === "toolCall" ? "toolUse" : "stop" }];
      } else if (message?.role === "toolResult" && callId !== undefined) {
        const callMessage = callMessages.get(callId);
        if (callMessage !== undefined) model = [callMessage, message];
      } else if (message?.role === "user") {
        model = [message];
      }
      incoming.push({ entryId: id, item: {
        id: ephemeralItemId(generation, id, part.key),
        layer: "ephemeral",
        ephemeral: {
          ...part.value,
          ...(model === undefined ? {} : { model }),
          ...(callId === undefined
            ? {}
            : { data: { callId, ...(tool === undefined ? {} : { tool }), ...(path === undefined ? {} : { path }) } }),
        },
      } });
    }
  }
  return incoming;
}

/** A prospective item with the source needed for future Chat and restore handling. */
export type ReturnSweepPart = {
  conversationId: number;
  entryId: number;
  entryKind: string;
  entryData?: unknown;
  item: IncomingItem;
};

/**
 * Convert Pi-derived, non-forked contexts using Carto's existing part IDs,
 * editing and archive conversion. Tool IDs are scoped to one conversation;
 * ambiguous calls, unsupported multi-message entries and image-only inputs
 * fail rather than silently lose data. The result is only a preparation: its
 * provenance has not been persisted, Chat has not been deduplicated, and child
 * restoration or journal recovery is not implemented. It must not authorize
 * source deletion. The caller must keep the source writers sealed.
 */
export function prepareReturnSweepParts(views: readonly ReturnSweepView[], generation: string): ReturnSweepPart[] {
  const parts: ReturnSweepPart[] = [];
  const conversations = new Set<number>();
  const entries = new Set<number>();
  for (const { conversation, view } of views) {
    if (conversation.parent !== undefined || conversations.has(conversation.id) || view.entries.length !== view.contributions.length) {
      throw new Error("Ambiguous return-sweep conversations; the source was preserved.");
    }
    conversations.add(conversation.id);
    const parsed: SweepEntry[] = view.entries.map((entry, index) => {
      const messages = view.contributions[index]!;
      if (entry.conversationId !== conversation.id || entries.has(entry.id) || messages.length > 1 || (entry.model?.length ?? 0) > 1) {
        throw new Error("Unsupported or ambiguous return-sweep entry; the source was preserved.");
      }
      entries.add(entry.id);
      const original = entry as unknown as StoredEntry;
      const effective: StoredEntry = { ...original, model: [...messages] };
      const message = messages[0];
      if (message?.role === "assistant" && original.model?.[0]?.role !== "assistant") {
        throw new Error("An assistant contribution has no stable original; the source was preserved.");
      }
      if (message?.role === "user" && Array.isArray(message.content) &&
          message.content.some((part) => part.type === "image") && !modelTexts(effective).text.join("").trim()) {
        throw new Error("An image-only input needs separate archive handling; the source was preserved.");
      }
      return { id: String(entry.id), original, entry: effective };
    });
    const callOwners = new Map<string, string>();
    for (const { id, original } of parsed) {
      for (const call of toolCallsOf(original)) {
        if (callOwners.has(call.id)) throw new Error("Duplicate tool-call identity in one conversation; the source was preserved.");
        callOwners.set(call.id, id);
      }
    }
    const activeCalls = new Set<string>();
    for (const { id, entry } of parsed) {
      for (const call of toolCallsOf(entry)) {
        const owner = callOwners.get(call.id);
        if (activeCalls.has(call.id) || (owner !== undefined && owner !== id)) {
          throw new Error("Ambiguous edited tool-call identity; the source was preserved.");
        }
        activeCalls.add(call.id);
        callOwners.set(call.id, id);
      }
    }
    for (const { entry } of parsed) {
      const resultId = callIdOf(entry);
      if (entry.model?.[0]?.role === "toolResult" && (resultId === undefined || !callOwners.has(resultId))) {
        throw new Error("A tool result lacks its source call; the source was preserved.");
      }
    }
    const byId = new Map(view.entries.map((entry) => [String(entry.id), entry]));
    for (const { entryId, item } of sweepParsedEntries(parsed, generation)) {
      const source = byId.get(entryId)!;
      parts.push({ conversationId: conversation.id, entryId: source.id, entryKind: source.kind,
        ...(source.data === undefined ? {} : { entryData: source.data }), item });
    }
  }
  return parts.sort((left, right) => left.entryId - right.entryId);
}

/** One row of the store's entries table, as far as the sweep reads it. */
interface StoredEntry {
  kind?: string;
  data?: unknown;
  model?: Array<{ role?: string; content?: unknown }>;
  edits?: Array<{ target: string | number; action: "omit" | "replace"; messages?: Array<{ role?: string; content?: unknown }> }>;
}

/**
 * Keep a part's original key after Carto edits a sibling. The original entry
 * remains in Pi's append-only log, and each edit records the exact removed key.
 * Never guess if another writer changed the contribution or an old edit cannot
 * be reconciled: guessing could delete or pin a different, identical sibling.
 */
export function stablePartKeys(original: unknown, current: unknown, removed: ReadonlySet<string>, changed?: ReadonlyMap<string, string>): string[] {
  if (!Array.isArray(original) || !Array.isArray(current)) throw new Error("Cannot identify edited context parts safely");
  let thinking = 0;
  let text = 0;
  const candidates = original.map((part: unknown, index: number) => {
    const type = part !== null && typeof part === "object" ? (part as { type?: unknown }).type : undefined;
    const key = type === "thinking" ? `t${thinking++}` : type === "text" ? `x${text++}` : type === "toolCall" ? `c${index}` : `other${index}`;
    return { key, part };
  }).filter(({ key }) => !removed.has(key));
  if (candidates.length !== current.length || candidates.some(({ key, part }, index) => (changed?.get(key) ?? JSON.stringify(part)) !== JSON.stringify(current[index]))) {
    throw new Error("Context parts changed outside Carto; refusing to guess their identities");
  }
  return candidates.map(({ key }) => key);
}

/** Exact edited values, recorded with Pi's context edit so identities are never guessed. */
export function editedPartValues(entries: readonly { kind?: string | undefined; data?: unknown }[], generation: string): Map<string, Map<string, string>> {
  const changed = new Map<string, Map<string, string>>();
  for (const entry of entries) {
    if ((entry.kind !== "carto.edit-work" && entry.kind !== "carto.edit-chat") || entry.data === null || typeof entry.data !== "object") continue;
    const data = entry.data as { entry?: unknown; item?: unknown; partJson?: unknown };
    if (typeof data.entry !== "string" || typeof data.item !== "string" || typeof data.partJson !== "string") continue;
    const prefix = `${generation}:${data.entry}:`;
    if (!data.item.startsWith(prefix)) continue;
    const values = changed.get(data.entry) ?? new Map<string, string>();
    values.set(data.item.slice(prefix.length), data.partJson);
    changed.set(data.entry, values);
  }
  return changed;
}

/** Carto's persisted part removals, keyed by original entry id. */
export function removedPartKeys(entries: readonly { kind?: string | undefined; data?: unknown }[], generation: string): Map<string, Set<string>> {
  const removed = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.kind !== "carto.apply-now" || entry.data === null || typeof entry.data !== "object") continue;
    const data = entry.data as { entry?: unknown; item?: unknown };
    if (typeof data.entry !== "string" || typeof data.item !== "string") continue;
    const prefix = `${generation}:${data.entry}:`;
    if (!data.item.startsWith(prefix)) continue;
    const keys = removed.get(data.entry) ?? new Set<string>();
    keys.add(data.item.slice(prefix.length));
    removed.set(data.entry, keys);
  }
  return removed;
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

export function ephemeralPartsOf(entry: StoredEntry, tool: string | undefined, keys?: readonly string[]): Array<{ key: string; value: NonNullable<IncomingItem["ephemeral"]> }> {
  const parts: Array<{ key: string; value: NonNullable<IncomingItem["ephemeral"]> }> = [];
  const role = entry.model?.find((message) => typeof message.role === "string")?.role;
  const { thinking, text } = modelTexts(entry);
  if (role === "assistant") {
    const content = entry.model?.[0]?.content;
    if (!Array.isArray(content)) return parts;
    const stable = keys ?? stablePartKeys(content, content, new Set());
    for (const [index, part] of content.entries()) {
      if (part === null || typeof part !== "object") continue;
      const value = part as { type?: unknown; thinking?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
      const key = stable[index];
      if (key === undefined) throw new Error("Missing stable part key");
      if (value.type === "thinking" && typeof value.thinking === "string" && value.thinking.trim()) {
        parts.push({ key, value: { kind: "reasoning", text: value.thinking } });
      } else if (value.type === "text" && typeof value.text === "string" && value.text.trim()) {
        parts.push({ key, value: { kind: "plainText", text: value.text } });
      } else if (value.type === "toolCall" && value.name !== "chat") {
        parts.push({ key, value: { kind: "toolCall", text: `${String(value.name)} ${JSON.stringify(value.arguments ?? {})}` } });
      }
    }
    return parts;
  }
  for (const [index, value] of thinking.entries()) parts.push({ key: `t${index}`, value: { kind: "reasoning", text: value } });

  if (role === "toolResult") {
    const content = entry.model?.[0]?.content;
    const containsImage = Array.isArray(content) && content.some((part) => part !== null && typeof part === "object" && (part as { type?: unknown }).type === "image");
    const result = [...text, ...(containsImage ? ["[image]"] : [])].join("\n");
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
  // A user message can contain multiple text blocks, but is one Chat line and
  // one selectable contribution. Its recorded text concatenates those blocks.
  const values = role === "user" ? [text.join("")] : text;
  for (const [index, value] of values.entries()) if (value.trim()) parts.push({ key: `x${index}`, value: { kind, text: value } });
  return parts;
}

/**
 * A pinned file's text as it stands, or `undefined` when it cannot be read:
 * missing, inaccessible, or not a regular file. The head says
 * so in its place, and the pin's stale mark does the same in the state block.
 */
function readPinnedFile(root: string, path: string, readResult = false): string | undefined {
  let real: string | null;
  try { real = readResult ? resolveReadReference(root, path, readProjectSettings(root).pathScope) : resolvePinnedFile(root, path); }
  catch { return undefined; }
  if (real === null) return undefined;
  try {
    if (!statSync(real).isFile() || isImageFile(real)) return undefined;
    return readFileSync(real, "utf8");
  } catch {
    return undefined;
  }
}

/** Resolve project paths and their symlink targets, returning null when inaccessible. */
function safeResolve(root: string, path: string): string | null {
  try {
    assertFileScope(root, path, "strict");
    return lexicalProjectPath(root, path);
  } catch {
    return null;
  }
}

/** Read current file pins for a newly frozen projection. */
export function pinnedFileTexts(root: string, brain: CartoBrain): Map<string, string | undefined> {
  return new Map(brain.files.map((file) => [file.path, readPinnedFile(root, file.path)]));
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
  /**
   * The text of the person's messages this collapse hands straight to the new
   * generation as its first turn. Their Chat records stay in the Brain but are
   * left out of the head, so each is read once: as that turn (§2.3).
   */
  carriedTexts?: readonly string[];
  /** Exact Chat identities of handed-on inputs, when known. */
  carriedChatIds?: readonly string[];
  /** Dormant: transfer a source checkpoint; caller must have stopped all writers. Replay is not implemented. */
  transferDelegateInputs?: boolean;
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
  const key = resolve(root);
  if (activeCollapses.has(key)) throw new Error("A collapse is already running for this project.");
  activeCollapses.add(key);
  try {
    return await performCollapse(root, brain, options);
  } finally {
    activeCollapses.delete(key);
  }
}

async function performCollapse(root: string, brain: BrainStore, options: CollapseOptions): Promise<CollapseReport> {
  if (await brain.readPendingEdit() !== undefined) throw new Error("A context edit is awaiting recovery; reopen the session before collapsing.");
  await recoverCollapse(root, brain, true);
  const now = options.now?.() ?? Date.now();
  const discovered = discoverGenerations(root).filter((candidate) => candidate.hasStore);
  if (discovered.length > 1) throw new Error("Multiple unjournaled generation stores exist; all were preserved for recovery.");
  const live = discovered[0];
  if (live === undefined) throw new Error("No live generation exists to collapse.");
  if (!live.hasMarkdown || !live.hasSidecar) throw new Error("The live generation is missing its snapshot; all files were preserved.");
  const storedDelegation = await readStoredDelegation(live.store, options.transferDelegateInputs === true);
  if (storedDelegation !== undefined) await requireSingleConversationReturn(live.store);
  const refreshed = await refreshFreshness(root, await brain.read(), brain.apply.bind(brain), now);
  const archive = await brain.readArchive();
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
  const deletions = new Set(refreshed.ephemeralDeletes ?? []);
  // A person's message is Chat once it is sent (§2.3), and Chat is swept like
  // any Brain record: only when it is marked for archive, and then as the
  // record. Its copy in the old store is the same words, so it is not swept a
  // second time as an ephemeral. A line with no record behind it still is.
  const recorded = new Map<string, number>();
  for (const record of refreshed.chat) if (record.author === "user") recorded.set(record.text, (recorded.get(record.text) ?? 0) + 1);
  const isRecordedPerson = (item: IncomingItem): boolean => {
    if (item.ephemeral?.kind !== "personMessage") return false;
    const left = recorded.get(item.ephemeral.text) ?? 0;
    if (left === 0) return false;
    recorded.set(item.ephemeral.text, left - 1);
    return true;
  };
  const swept = (await readGenerationEphemera(live.store, live.generation)).filter(
    (item) => !pins.has(item.id) && !deletions.has(item.id) && !isRecordedPerson(item),
  );

  // The Brain the new generation is built from: the marks applied, so a record
  // that is archived or deleted is not in the head it was swept out of (§2,
  // §4.1). The same writes go into the transaction below, so what is rendered
  // and what is committed are the same Brain.
  const writes: { write: BrainWrite; now: number }[] = [];
  for (const id of deletions) {
    writes.push({ write: { kind: "ephemeral.delete-mark", id, marked: false }, now });
    if (pins.has(id)) writes.push({ write: { kind: "ephemeral.unpin", id }, now });
  }
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
  const fileTexts = pinnedFileTexts(root, refreshed);
  for (const file of refreshed.files) {
    const text = fileTexts.get(file.path);
    const stale = text === undefined;
    const already = file.stale === true;
    if (stale !== already) writes.push({ write: { kind: "file.stale", path: file.path, stale }, now });
  }
  for (const item of refreshed.ephemera) {
    if (item.pinned === undefined || deletions.has(item.id)) continue;
    const path = item.kind === "readResult" ? item.entity?.path : undefined;
    if (path === undefined) continue;
    const text = readPinnedFile(root, path, true);
    if (text === undefined) continue;
    const refreshedItem: PinnedEphemeral = { ...item, text };
    writes.push({ write: { kind: "ephemeral.pin", item: refreshedItem }, now });
  }

  let next = refreshed;
  for (const step of writes) next = applyWrite(next, step.write, step.now);
  // Restored Brain records are committed by the same sweep and must already
  // be present in the frozen head. Ephemeral restores go to the live store.
  for (const item of applyArchiveMarks(archive).restored) {
    const write = writeBackOf(item);
    if (write !== undefined) next = applyWrite(next, write, now);
  }
  // A handed-on record stays in the body, not also the head. Prefer its exact
  // identity; carriedTexts is retained for older callers without identities.
  const handedOn = new Set<string>(options.carriedChatIds ?? []);
  if (storedDelegation?.inputCheckpoint !== undefined) {
    const active = parseReturnedDelegation(storedDelegation.content).active;
    if (active === null) throw new Error("The checkpoint has no returned handoff; the generation store was preserved.");
    const checkpoint = validateInputTransfer(storedDelegation.inputCheckpoint, active.input.id);
    for (const input of checkpoint.inputs) {
      const data = input.entry.data;
      if (input.entry.kind !== "carto.user" || data === null || typeof data !== "object" || Array.isArray(data) || typeof data.chatRecordId !== "string") continue;
      const chat = refreshed.chat.find((record) => record.id === data.chatRecordId);
      if (chat === undefined || chat.author !== "user" || chat.text !== userText(input.content)) {
        throw new Error("A checkpointed Chat identity conflicts with the Brain; the generation store was preserved.");
      }
      handedOn.add(chat.id);
    }
  }
  for (const text of options.carriedTexts ?? []) {
    const record = [...next.chat].reverse().find((candidate) => candidate.author === "user" && candidate.text === text && !handedOn.has(candidate.id));
    if (record !== undefined) handedOn.add(record.id);
  }
  const projection = projectContext(next, fileTexts, options.person ?? personName(), {
    chat: new Set(next.chat.filter((record) => !handedOn.has(record.id)).map((record) => record.id)),
  });

  // Reserve the handoff before creating any destination files. Recovery can
  // distinguish a partial destination from a committed sweep even if the
  // process stops at any point between those operations.
  const destination = generationPaths(root, generation);
  if (existsSync(destination.store) || existsSync(destination.markdown) || existsSync(destination.sidecar)) {
    throw new Error("New collapse generation already exists; refusing to overwrite it.");
  }
  await brain.beginCollapse(live.generation, generation, () => {
    const stores = discoverGenerations(root).filter((candidate) => candidate.hasStore);
    if (stores.length !== 1 || stores[0]?.generation !== live.generation || !stores[0].hasMarkdown || !stores[0].hasSidecar) {
      throw new Error("The live generation changed during collapse; all files were preserved.");
    }
    if (existsSync(destination.store) || existsSync(destination.markdown) || existsSync(destination.sidecar)) {
      throw new Error("New collapse generation already exists; refusing to overwrite it.");
    }
  });
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
    source: live.generation,
    ...(storedDelegation === undefined ? {} : { delegationTransfer: { source: live.generation, destination: generation, ...storedDelegation } satisfies DelegationTransfer }),
    expected: { brain: refreshed, archive },
    incoming: [
      ...leaving.flatMap((record) => (record.incoming === undefined ? [] : [record.incoming])),
      ...swept,
    ],
    now,
  });
  // 2. The journal is committed with the sweep, so the same recovery path
  // safely deletes the old store whether we finish here or crash beforehand.
  await recoverCollapse(root, brain, true);
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
  const fileTexts = pinnedFileTexts(root, brain);
  // Chat said since the freeze is in the body, and a rebuilt head keeps to the
  // records the frozen one held: the head gathers in new Chat at a collapse,
  // not before, or the model would read the same words twice (§2.3). A
  // snapshot from before Chat was in the head listed none, so it holds none.
  let held: ReadonlySet<string> | undefined;
  try {
    const sidecar = JSON.parse(readFileSync(snapshotPaths(root, generation).sidecar, "utf8")) as { chat?: unknown };
    held = new Set(Array.isArray(sidecar.chat) ? sidecar.chat.filter((id): id is string => typeof id === "string") : []);
  } catch {
    held = undefined;
  }
  writeSnapshot(root, generation, projectContext(brain, fileTexts, person, held === undefined ? {} : { chat: held }), now);
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
