/**
 * The Brain store (§2, §3.3, §4.2).
 *
 * One database per project, under `.brain/`: the Brain document and the
 * archive's rows, so a move between them is one transaction. One document per
 * project, current state only — the Brain has no audit trail of old values. Reads return a fresh value; `apply` runs inside a
 * single transaction and cannot leave a half-written Brain behind. Deletion
 * is a single step.
 *
 * Storage is pi's SQLite machinery: chord's `openNodeSqliteDatabase`
 * (`@earendil-works/chord/sqlite/node`), the same facade pi-durable's own
 * adapters sit on — node:sqlite over a file, WAL, synchronous=NORMAL, a
 * busy timeout, atomic transactions with rollback, a prepared-statement
 * cache, and a WAL checkpoint(TRUNCATE) at close. `secure_delete` is asked
 * for here because the Brain asks for it and pi does not (§4.2). A WAL
 * checkpoint with truncation and `VACUUM` on demand are the Brain's
 * best-effort local cleanup, not a guarantee against wear levelling or
 * backups.
 *
 * pi's document layer was considered and not used. pi-durable singleton
 * documents keep every revision, and its `retireDoc` is a tombstone:
 * history accumulates by construction, while the Brain keeps none and its
 * deletion is single-step. chord's `store` (tables stamped with commit
 * seqs, an outbox, row history) is Durable's commit substrate — the same
 * story one layer down. What stays hand-rolled is the Brain's own: one row,
 * overwritten in place, no audit trail.
 *
 * `history: "latest"` is honoured by construction: one row, one document,
 * overwritten in place.
 */
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { delegateReturnChat, parseReturnedDelegation, type DelegationTransfer } from "./delegation-record.js";
import { validateInputTransfer } from "./delegate-inputs.js";
import { validateDelegateSourceSeal } from "./delegate-source-seal.js";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { Message } from "@earendil-works/pi-ai";
import type { EntryId } from "@earendil-works/pi-durable";

import { reconcileHandles } from "../domain/handles.js";
import { parseEditedRecord, type EditableRecord } from "../domain/record-editor.js";
import { editArchivedEphemeral as updateArchivedEphemeral } from "../domain/archive-editor.js";
import { applyWrite, type BrainWrite } from "../domain/brain.js";
import { emptyBrain, type AtlasNode, type CartoBrain, type ChatRecord, type LedgerEntry, type PinnedEphemeral } from "../domain/records.js";
import {
  applyArchiveMarks,
  dropExpired,
  emptyArchive,
  restore,
  setArchiveMark,
  setArchivePin,
  sweep,
  withoutMark,
  type ArchivedItem,
  type ArchivedRecord,
  type Archive,
  type IncomingItem,
} from "../domain/archive.js";

export interface BrainStore {
  /** The current Brain, handles reconciled. Never undefined. */
  read(): Promise<CartoBrain>;
  /** Apply one write inside one transaction; returns the next Brain. */
  apply(write: BrainWrite, now: number): Promise<CartoBrain>;
  /** Validate and replace a Brain record only if it has not changed while being edited. */
  editBookRecord(original: EditableRecord, text: string, now: number): Promise<CartoBrain>;
  /** Replace a pin's text only if the original pin is still current. */
  editPinnedEphemeral(original: PinnedEphemeral, text: string): Promise<CartoBrain>;
  /** A cross-store edit is recoverable until its Pi write is acknowledged. */
  readPendingEdit(): Promise<ContextEditJournal | undefined>;
  beginChatEdit(journal: ContextEditJournal, original: ChatRecord, editedJson: string, now: number, pin?: PinnedEphemeral): Promise<void>;
  beginWorkEdit(journal: ContextEditJournal, pin: PinnedEphemeral | undefined, text: string): Promise<void>;
  finishPendingEdit(operation: string): Promise<void>;
  /** Edit an archived record without changing its archive identity or marks. */
  editArchivedRecord(original: ArchivedItem, text: string, now: number): Promise<Archive>;
  /** Edit the stored content and restore payload of an archived ephemeral item. */
  editArchivedEphemeral(original: ArchivedItem, text: string): Promise<Archive>;
  /** The archive as it stands. The agent never sees it (§3.3). */
  readArchive(): Promise<Archive>;
  /** Sidebar counts without loading or parsing archived content. */
  readArchiveCounts(): Promise<{ total: number; pinned: number }>;
  /** Durable cross-store collapse intent and commit status, if cleanup is pending. */
  readCollapseJournal(): Promise<CollapseJournal | undefined>;
  /** Reserve a transition before creating the next generation's files. */
  beginCollapse(source: string, destination: string, validate?: () => void): Promise<void>;
  /** Serialize filesystem recovery with other journal writers, clearing only after success. */
  recoverCollapseJournal(recover: (journal: CollapseJournal, transfer: DelegationTransfer | undefined) => Promise<void>): Promise<void>;
  /** Returned handoff retained across a committed collapse until placement. */
  readDelegationTransfer(): Promise<DelegationTransfer | undefined>;
  acknowledgeDelegationTransfer(expected: DelegationTransfer): Promise<void>;
  /**
   * Every Chat record that still exists anywhere, in the Brain or the archive.
   * This is a storage query, not the agent's context: archived Chat must not be
   * used to populate the live transcript.
   */
  readChat(): Promise<ChatRecord[]>;
  /**
   * One collapse's worth of Brain and archive change, in one transaction: the
   * writes apply to the Brain, what `sweep` says moves into the archive, and
   * what the archive drops is gone. Nothing half-done survives a crash at a
   * collapse (§2).
   */
  applyCollapse(change: CollapseChange): Promise<{
    brain: CartoBrain;
    archive: Archive;
    dropped: string[];
    /** Ephemera a mark returned to the live context; the caller writes them back (§3.3). */
    restored: ArchivedItem[];
    /** Archive items a mark deleted for good. */
    deleted: string[];
  }>;
  /** Replace the archive wholesale, for the person's pin and restore operations. */
  applyArchive(write: ArchiveWrite): Promise<{ archive: Archive; item?: ArchivedItem; refused: boolean }>;
  /** Copy an ephemeral into the archive before removing it from the live store. */
  archiveEphemeral(item: IncomingItem, generation: string, now: number): Promise<void>;
  /**
   * Apply one Brain record's archive or delete mark now (§4.1), in one
   * transaction: an archived record leaves the Brain and enters the archive
   * here, a deleted one leaves the Brain and goes nowhere. The collapse counter
   * does not move and no grace is spent, because this is not a collapse.
   */
  applyRecordAction(change: RecordActionChange): Promise<{ brain: CartoBrain; archive: Archive; found: boolean }>;
  /** Secure-delete the old pages: WAL checkpoint and VACUUM. */
  compact(): Promise<void>;
  close(): Promise<void>;
}

const TABLE =
  "CREATE TABLE IF NOT EXISTS brain_document (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL)";
/**
 * The archive is rows, not one document: an item has to be deletable on its
 * own when its grace runs (§3.3), and a single blob would make every drop a
 * rewrite of everything. `swept_at_generation` is what grace is counted from.
 */
const ARCHIVE_TABLE =
  "CREATE TABLE IF NOT EXISTS archive_item (id TEXT PRIMARY KEY, swept_at_collapse INTEGER NOT NULL, swept_at_generation TEXT NOT NULL, pinned TEXT, document TEXT NOT NULL)";
/** The collapse counters, so grace can be counted and the archive survives a restart. */
const COUNTER_TABLE = "CREATE TABLE IF NOT EXISTS archive_counter (id INTEGER PRIMARY KEY CHECK (id = 1), collapses INTEGER NOT NULL)";
const COLLAPSE_JOURNAL_TABLE = "CREATE TABLE IF NOT EXISTS collapse_journal (id INTEGER PRIMARY KEY CHECK (id = 1), source TEXT NOT NULL, destination TEXT NOT NULL, owner_pid INTEGER NOT NULL, committed INTEGER NOT NULL CHECK (committed IN (0, 1)))";
const CHAT_EDIT_TABLE = "CREATE TABLE IF NOT EXISTS chat_edit_journal (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL)";
const DELEGATION_TRANSFER_TABLE = "CREATE TABLE IF NOT EXISTS delegation_transfer (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL)";
const ARCHIVE_INSERT =
  "INSERT INTO archive_item (id, swept_at_collapse, swept_at_generation, pinned, document) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET swept_at_collapse = excluded.swept_at_collapse, swept_at_generation = excluded.swept_at_generation, pinned = excluded.pinned, document = excluded.document";
const ARCHIVE_SELECT = "SELECT document FROM archive_item ORDER BY rowid";
const ARCHIVE_DELETE = "DELETE FROM archive_item WHERE id = ?";
const UPSERT =
  "INSERT INTO brain_document (id, document) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document";
const DOCUMENT = "SELECT document FROM brain_document WHERE id = 1";

/** The Brain write that puts an archived record back as the type it was. */
export function writeBackOf(item: ArchivedItem): BrainWrite | undefined {
  const record = item.record;
  // An ephemeral item goes back to the live context, which is not the Brain:
  // it is a write to the session's own store, and the caller has the session
  // (§3.3). There is nothing for the Brain to do with it, and it is not pinned,
  // because restoring does not also pin.
  if (record === undefined) return undefined;
  switch (record.kind) {
    case "chat":
      return { kind: "chat.record", record: record.value as ChatRecord };
    case "ledger":
      return { kind: "ledger.upsert", entry: record.value as LedgerEntry };
    case "atlas":
      return { kind: "atlas.upsert", node: record.value as AtlasNode };
  }
}

export interface ContextEditJournal {
  operation: string;
  generation: string;
  entryId: EntryId;
  itemId: string;
  /** Absent for pinned work; old Chat journals have no explicit kind. */
  kind?: "chat" | "work";
  recordId?: string;
  before: string;
  messages: Message[];
  partJson?: string;
}

export interface CollapseJournal {
  source: string;
  destination: string;
  ownerPid: number;
  committed: boolean;
}

/** Everything one collapse changes, applied as one transaction. */
export interface CollapseChange {
  /** Brain writes to apply, in order, before anything is swept. */
  writes: readonly { write: BrainWrite; now: number }[];
  /** The new generation used to stamp the sweep. */
  generation: string;
  /** Its source generation; the pair must match the reserved journal. */
  source: string;
  /** Source handoff to retain in the sweep transaction, if present. */
  delegationTransfer?: DelegationTransfer;
  /** State used to build the snapshot; reject concurrent edits rather than commit a stale head. */
  expected: { brain: CartoBrain; archive: Archive };

  /** Items leaving the Brain and the generation's store, on their way in. */
  incoming: readonly IncomingItem[];
  now: number;
}

/** What a collapse did to the archive, beyond taking items in. */
export interface ArchiveApplied {
  /** Items a mark returned to where they came from, in the order they were marked. */
  restored: ArchivedItem[];
  /** Items a mark deleted for good. */
  deleted: string[];
}

/**
 * One archive operation (§3.3, §4.1). Nothing here is reachable from a tool.
 *
 * Marking is the default and the collapse applies it. `restore` and `drop` are
 * the same actions applied now, which §4.1 allows for either party: they go
 * through the mark first so there is one rule, and then the store applies it
 * immediately instead of waiting.
 */
export type ArchiveWrite =
  | { kind: "pin"; id: string; pinned: "user" | "agent" | null }
  | { kind: "mark"; id: string; action: "restore" | "delete" | null; author: "user" | "agent" }
  | { kind: "restore"; id: string }
  /** A restored ephemeral was placed from this exact archive snapshot. */
  | { kind: "restore-complete"; id: string; expected: ArchivedItem }
  | { kind: "drop"; id: string };

/**
 * One Brain record's mark, applied now rather than at the next collapse
 * (§4.1). The action is the mark's own: `archive` moves the record into the
 * archive, `delete` removes it for good.
 */
export interface RecordActionChange {
  kind: "atlas" | "ledger" | "chat";
  id: string;
  action: "archive" | "delete";
  /** The generation whose head is rebuilt from the change; the archive stamps it on an archived record. */
  generation: string;
  now: number;
}

/** One Brain record by kind and id, or undefined when it is not in the Brain. */
function recordOf(brain: CartoBrain, kind: "atlas" | "ledger" | "chat", id: string): ArchivedRecord | undefined {
  if (kind === "chat") return brain.chat.find((record) => record.id === id);
  if (kind === "ledger") return brain.ledger.find((entry) => entry.id === id);
  return brain.atlas.find((node) => node.id === id);
}

function editedPinText(original: PinnedEphemeral, text: string): string {
  if (original.kind === "readResult" && original.entity?.path !== undefined) throw new Error("A pinned read result is refreshed from its source file at collapse.");
  if (original.kind !== "toolCall") return text;
  const separator = original.text.indexOf(" ");
  if (separator < 1) throw new Error("The pinned tool call has no identifiable arguments.");
  const args: unknown = JSON.parse(text);
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object.");
  return `${original.text.slice(0, separator)} ${JSON.stringify(args)}`;
}

export async function openBrain(databasePath: string): Promise<BrainStore> {
  // pi defaults to WAL + synchronous=NORMAL + a 5,000 ms busy timeout and
  // checkpoints the WAL at close; the Brain keeps that and adds secure_delete.
  const database = await openNodeSqliteDatabase(databasePath);
  await database.exec("PRAGMA secure_delete = ON");
  await database.exec(TABLE);
  await database.exec(ARCHIVE_TABLE);
  await database.exec(COUNTER_TABLE);
  await database.exec(COLLAPSE_JOURNAL_TABLE);
  await database.exec(CHAT_EDIT_TABLE);
  await database.exec(DELEGATION_TRANSFER_TABLE);
  await database.exec("INSERT OR IGNORE INTO archive_counter (id, collapses) VALUES (1, 0)");

  const decode = (document: string): CartoBrain => {
    // A corrupt Brain throws. It must never silently read as an empty Brain —
    // that would overwrite the person's memory with nothing.
    const parsed = JSON.parse(document) as CartoBrain;
    if (parsed === null || typeof parsed !== "object" || parsed.version !== 1) {
      throw new Error(`The Brain at ${databasePath} is not a Carto Brain document.`);
    }
    for (const key of ["chat", "ledger", "atlas"] as const) {
      if (!Array.isArray(parsed[key])) {
        throw new Error(`The Brain at ${databasePath} is missing its ${key} records.`);
      }
    }
    // A Brain written before pinned ephemera existed has none; absence is the
    // earlier shape of the same document, not corruption, so it reads as empty.
    if (parsed.ephemera === undefined) parsed.ephemera = [];
    if (!Array.isArray(parsed.ephemera)) {
      throw new Error(`The Brain at ${databasePath} has malformed pinned ephemera.`);
    }
    return reconcileHandles(parsed);
  };

  const readFrom = async (source: SqliteExecutor): Promise<CartoBrain> => {
    const row = await source.get<{ document: string }>(DOCUMENT);
    return row === undefined ? emptyBrain() : decode(row.document);
  };

  const readArchiveFrom = async (source: SqliteExecutor): Promise<Archive> => {
    const rows = await source.all<{ document: string }>(ARCHIVE_SELECT);
    if (rows.length === 0) return emptyArchive();
    const items = rows.map((row) => JSON.parse(row.document) as ArchivedItem);
    return { version: 1, items };
  };

  const writeArchiveItem = async (source: SqliteExecutor, item: ArchivedItem): Promise<void> => {
    await source.run(ARCHIVE_INSERT, item.id, item.sweptAtCollapse, item.sweptAtGeneration, item.pinned ?? null, JSON.stringify(item));
  };

  /** Write the archive's rows to match a value: insert or update what is there, delete what is not. */
  const writeArchiveRows = async (source: SqliteExecutor, archive: Archive): Promise<void> => {
    const existing = await source.all<{ id: string }>("SELECT id FROM archive_item");
    const keep = new Set(archive.items.map((item) => item.id));
    for (const row of existing) {
      if (!keep.has(row.id)) await source.run(ARCHIVE_DELETE, row.id);
    }
    for (const item of archive.items) {
      await source.run(
        ARCHIVE_INSERT,
        item.id,
        item.sweptAtCollapse,
        item.sweptAtGeneration,
        item.pinned ?? null,
        JSON.stringify(item),
      );
    }
  };

  const readJournalFrom = async (source: SqliteExecutor): Promise<CollapseJournal | undefined> => {
    const row = await source.get<{ source: string; destination: string; owner_pid: number; committed: number }>("SELECT source, destination, owner_pid, committed FROM collapse_journal WHERE id = 1");
    return row === undefined ? undefined : { source: row.source, destination: row.destination, ownerPid: row.owner_pid, committed: row.committed === 1 };
  };

  const readTransferFrom = async (source: SqliteExecutor): Promise<DelegationTransfer | undefined> => {
    const row = await source.get<{ document: string }>("SELECT document FROM delegation_transfer WHERE id = 1");
    if (row === undefined) return undefined;
    const value = JSON.parse(row.document) as DelegationTransfer;
    if (value === null || typeof value !== "object" || typeof value.source !== "string" || typeof value.destination !== "string" ||
        !Number.isSafeInteger(value.documentId) || value.documentId < 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.content !== "string") {
      throw new Error("Invalid delegation transfer; recovery data was preserved.");
    }
    const active = parseReturnedDelegation(value.content).active;
    if (value.returnChat !== undefined) {
      if (active === null || value.returnChat === null || typeof value.returnChat !== "object" ||
          JSON.stringify(delegateReturnChat(value.content, active.input.id, value.source, value.returnChat.createdAt)) !== JSON.stringify(value.returnChat)) {
        throw new Error("Invalid delegation return Chat; recovery data was preserved.");
      }
    }
    if (value.sourceSeal !== undefined) validateDelegateSourceSeal(value.sourceSeal, value.source);
    if (value.inputCheckpoint !== undefined) {
      if (active === null || value.inputCheckpoint === null || value.inputCheckpoint.documentId === value.documentId || value.inputCheckpoint.barrier?.documentId === value.documentId) {
        throw new Error("Invalid delegate input transfer; recovery data was preserved.");
      }
      validateInputTransfer(value.inputCheckpoint, active.input.id);
    }
    return value;
  };

  const readChatEditFrom = async (source: SqliteExecutor): Promise<ContextEditJournal | undefined> => {
    const row = await source.get<{ document: string }>("SELECT document FROM chat_edit_journal WHERE id = 1");
    return row === undefined ? undefined : JSON.parse(row.document) as ContextEditJournal;
  };
  const requireNoPendingEdit = async (source: SqliteExecutor): Promise<void> => {
    if (await readChatEditFrom(source) !== undefined) throw new Error("A context edit is awaiting recovery; reopen the session before changing the Brain.");
  };

  return {
    read: () => readFrom(database),
    readPendingEdit: () => readChatEditFrom(database),
    beginChatEdit: (journal, original, editedJson, now, pin) => database.transaction(async (tx) => {
      await requireNoPendingEdit(tx);
      if (await readJournalFrom(tx) !== undefined) throw new Error("A collapse is in progress.");
      const edited = parseEditedRecord({ kind: "chat", value: original }, editedJson, now);
      if (edited.kind !== "chat" || journal.kind === "work" || journal.recordId !== original.id) throw new Error("Invalid Chat edit identity.");
      const current = await readFrom(tx);
      const record = current.chat.find((item) => item.id === original.id);
      if (record === undefined || JSON.stringify(record) !== JSON.stringify(original)) throw new Error("The Chat record changed while the editor was open.");
      const held = current.ephemera.find((item) => item.id === journal.itemId);
      if (JSON.stringify(held ?? null) !== JSON.stringify(pin ?? null)) throw new Error("The item's pin changed while the editor was open.");
      let next = applyWrite(current, { kind: "chat.update", id: original.id, text: edited.value.text, updatedAt: now }, now);
      if (held !== undefined) {
        let text = edited.value.text;
        if (original.author === "agent") {
          const message = journal.messages[0];
          const call = message?.role === "assistant" ? message.content.find((part) => part.type === "toolCall" && part.id === held.entity?.callId && part.name === "chat") : undefined;
          if (call?.type !== "toolCall") throw new Error("The Chat pin does not match the edited call.");
          text = `chat ${JSON.stringify(call.arguments)}`;
        }
        next = { ...next, ephemera: next.ephemera.map((item) => item.id === held.id ? { ...item, text } : item) };
      }
      await tx.run(UPSERT, JSON.stringify(next));
      await tx.run("INSERT INTO chat_edit_journal (id, document) VALUES (1, ?)", JSON.stringify(journal));
    }),
    beginWorkEdit: (journal, original, text) => database.transaction(async (tx) => {
      await requireNoPendingEdit(tx);
      if (await readJournalFrom(tx) !== undefined) throw new Error("A collapse is in progress.");
      if (journal.kind !== "work" || (original !== undefined && journal.itemId !== original.id)) throw new Error("Invalid work edit identity.");
      const current = await readFrom(tx);
      const pin = current.ephemera.find((item) => item.id === journal.itemId);
      if (JSON.stringify(pin ?? null) !== JSON.stringify(original ?? null)) throw new Error("The pin changed while the editor was open.");
      if (original !== undefined) {
        const value = editedPinText(original, text);
        const next = { ...current, ephemera: current.ephemera.map((item) => item.id === original.id ? { ...item, text: value } : item) };
        await tx.run(UPSERT, JSON.stringify(next));
      }
      await tx.run("INSERT INTO chat_edit_journal (id, document) VALUES (1, ?)", JSON.stringify(journal));
    }),
    finishPendingEdit: (operation) => database.transaction(async (tx) => {
      const pending = await readChatEditFrom(tx);
      if (pending === undefined) return;
      if (pending.operation !== operation) throw new Error("A different context edit is awaiting recovery.");
      await tx.run("DELETE FROM chat_edit_journal WHERE id = 1");
    }),
    readCollapseJournal: () => readJournalFrom(database),
    beginCollapse: (source, destination, validate) => database.transaction(async (tx) => {
      await requireNoPendingEdit(tx);
      if (await readJournalFrom(tx) !== undefined) throw new Error("A collapse is already in progress or awaiting recovery.");
      if (await readTransferFrom(tx) !== undefined) throw new Error("A delegation transfer is awaiting placement; reopen the session before collapsing.");
      validate?.();
      await tx.run("INSERT INTO collapse_journal (id, source, destination, owner_pid, committed) VALUES (1, ?, ?, ?, 0)", source, destination, process.pid);
    }),
    recoverCollapseJournal: (recover) => database.transaction(async (tx) => {
      const journal = await readJournalFrom(tx);
      if (journal === undefined) return;
      // Hold SQLite's write lock while reconciling files: two recoveries must
      // not delete files after either has cleared and replaced the journal.
      const transfer = await readTransferFrom(tx);
      if (journal.committed && transfer?.returnChat !== undefined) {
        const matches = (await readFrom(tx)).chat.filter((record) => record.id === transfer.returnChat!.id);
        if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(transfer.returnChat)) {
          throw new Error("Committed delegate return Chat changed; recovery data was preserved.");
        }
      }
      await recover(journal, transfer);
      await tx.run("DELETE FROM collapse_journal WHERE id = 1");
    }),
    readDelegationTransfer: () => readTransferFrom(database),
    acknowledgeDelegationTransfer: (expected) => database.transaction(async (tx) => {
      const current = await readTransferFrom(tx);
      if (current === undefined) return;
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("Delegation transfer changed; it was preserved.");
      if (await readJournalFrom(tx) !== undefined) throw new Error("Collapse recovery must finish before acknowledging a delegation transfer.");
      await tx.run("DELETE FROM delegation_transfer WHERE id = 1");
    }),

    apply: (writeToApply, now) =>
      database.transaction(async (tx) => {
        await requireNoPendingEdit(tx);
        const current = await readFrom(tx);
        const next = applyWrite(current, writeToApply, now);
        await tx.run(UPSERT, JSON.stringify(next));
        return next;
      }),

    editBookRecord: (original, text, now) => database.transaction(async (tx) => {
      await requireNoPendingEdit(tx);
      const edited = parseEditedRecord(original, text, now);
      const current = await readFrom(tx);
      const record = recordOf(current, original.kind, original.value.id);
      if (record === undefined || JSON.stringify(record) !== JSON.stringify(original.value)) {
        throw new Error("The record changed or disappeared while the editor was open; no changes were applied.");
      }
      const write: BrainWrite = edited.kind === "atlas"
        ? { kind: "atlas.upsert", node: edited.value }
        : edited.kind === "ledger"
          ? { kind: "ledger.upsert", entry: edited.value }
          : { kind: "chat.update", id: edited.value.id, text: edited.value.text, updatedAt: now };
      const next = applyWrite(current, write, now);
      await tx.run(UPSERT, JSON.stringify(next));
      return next;
    }),

    editPinnedEphemeral: (original, text) => database.transaction(async (tx) => {
      await requireNoPendingEdit(tx);
      const value = editedPinText(original, text);
      const current = await readFrom(tx);
      const pin = current.ephemera.find((item) => item.id === original.id);
      if (pin === undefined || JSON.stringify(pin) !== JSON.stringify(original)) throw new Error("The pin changed or disappeared while the editor was open; no changes were applied.");
      const next = { ...current, ephemera: current.ephemera.map((item) => item.id === original.id ? { ...item, text: value } : item) };
      await tx.run(UPSERT, JSON.stringify(next));
      return next;
    }),

    editArchivedRecord: (original, text, now) => database.transaction(async (tx) => {
      if (original.record === undefined || original.restorePending) throw new Error("That archive item cannot be edited as a record.");
      const editable = original.record as EditableRecord;
      const edited = parseEditedRecord(editable, text, now);
      const current = await readArchiveFrom(tx);
      const found = current.items.find((item) => item.id === original.id);
      if (found === undefined || JSON.stringify(found) !== JSON.stringify(original)) {
        throw new Error("The archived item changed or disappeared while the editor was open; no changes were applied.");
      }
      const item: ArchivedItem = { ...found, record: { kind: edited.kind, value: edited.value } };
      await writeArchiveItem(tx, item);
      return { ...current, items: current.items.map((candidate) => candidate.id === item.id ? item : candidate) };
    }),

    editArchivedEphemeral: (original, text) => database.transaction(async (tx) => {
      const changed = updateArchivedEphemeral(original, text);
      const current = await readArchiveFrom(tx);
      const found = current.items.find((item) => item.id === original.id);
      if (found === undefined || JSON.stringify(found) !== JSON.stringify(original)) {
        throw new Error("The archived item changed or disappeared while the editor was open; no changes were applied.");
      }
      await writeArchiveItem(tx, changed);
      return { ...current, items: current.items.map((item) => item.id === changed.id ? changed : item) };
    }),

    readArchive: () => readArchiveFrom(database),
    readArchiveCounts: async () => {
      const row = await database.get<{ total: number; pinned: number }>(
        "SELECT COUNT(*) AS total, COUNT(pinned) AS pinned FROM archive_item",
      );
      return { total: row?.total ?? 0, pinned: row?.pinned ?? 0 };
    },

    readChat: async () => {
      // Both places a Chat record can be: the Brain, and the archive —
      // archived records keep their id, so a swept record is the same record,
      // and the transcript shows it once either way.
      const brainRecords = (await readFrom(database)).chat;
      const archived = (await readArchiveFrom(database)).items
        .filter((item) => item.layer === "record" && item.record?.kind === "chat")
        .map((item) => item.record?.value as ChatRecord | undefined)
        .filter((record): record is ChatRecord => record !== undefined);
      const seen = new Set(brainRecords.map((record) => record.id));
      return [...brainRecords, ...archived.filter((record) => !seen.has(record.id))].sort(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      );
    },

    applyCollapse: (change) =>
      database.transaction(async (tx) => {
        const journal = await readJournalFrom(tx);
        if (journal === undefined || journal.committed || journal.source !== change.source || journal.destination !== change.generation) {
          throw new Error("Collapse has no matching uncommitted journal.");
        }
        let brain = await readFrom(tx);
        const archive = await readArchiveFrom(tx);
        if (JSON.stringify(brain) !== JSON.stringify(change.expected.brain) || JSON.stringify(archive) !== JSON.stringify(change.expected.archive)) {
          throw new Error("Brain or archive changed during collapse; refusing to commit a stale snapshot.");
        }
        const transferChat = change.delegationTransfer?.returnChat;
        if (transferChat !== undefined) {
          const transfer = change.delegationTransfer!;
          const active = parseReturnedDelegation(transfer.content).active;
          const expectedChat = active === null ? undefined : delegateReturnChat(transfer.content, active.input.id, change.source, change.now);
          if (expectedChat === undefined || JSON.stringify(expectedChat) !== JSON.stringify(transferChat) ||
              brain.chat.some((item) => item.id === expectedChat.id) ||
              [...archive.items, ...change.incoming].some((item) => item.record?.kind === "chat" && item.record.value.id === expectedChat.id)) {
            throw new Error("Delegate return Chat conflicts with the handoff or existing records; the sweep was not committed.");
          }
          const touching = change.writes.filter(({ write }) => {
            if (write.kind === "chat.record") return write.record.id === expectedChat.id;
            if (write.kind === "chat.update") return write.id === expectedChat.id;
            if ((write.kind === "delete" || write.kind === "mark.set" || write.kind === "mark.clear") && write.target === "chat") return write.id === expectedChat.id;
            return false;
          });
          if (touching.length !== 1 || touching[0]?.write.kind !== "chat.record" ||
              JSON.stringify(touching[0].write.record) !== JSON.stringify(expectedChat) || touching[0].now !== change.now) {
            throw new Error("Delegate return Chat write is missing or conflicts; the sweep was not committed.");
          }
        }
        for (const step of change.writes) brain = applyWrite(brain, step.write, step.now);
        // A record marked for archive leaves the Brain here (§4.1): the mark is
        // what puts it in `incoming`, and the Brain it is written back to has no
        // archived state to hold.
        const counter = await tx.get<{ collapses: number }>("SELECT collapses FROM archive_counter WHERE id = 1");
        const collapse = (counter?.collapses ?? 0) + 1;
        await tx.run("UPDATE archive_counter SET collapses = ? WHERE id = 1", collapse);
        // The marks the archive is carrying are applied here, with the Brain's
        // own (§4.1, §4 step 3-4): a restore puts an item back where it came
        // from, a delete removes it for good, and then grace is counted, so an
        // item marked this time is not also dropped this time.
        const swept = sweep(archive, change.generation, collapse, change.now, change.incoming);
        const applied = applyArchiveMarks(swept);
        for (const item of applied.restored) {
          // A restored Brain record goes back into the Brain it left, in this
          // same transaction: there is no moment where it is in neither place.
          const back = writeBackOf(item);
          if (back !== undefined) brain = applyWrite(brain, back, change.now);
        }
        // The live context is a different database. Keep each ephemeral source
        // until the destination confirms it has durably accepted the item.
        const pending = swept.items
          .filter((item) => item.layer === "ephemeral" && item.mark?.action === "restore")
          .map((item) => ({ ...item, restorePending: true }));
        const { archive: nextArchive, dropped } = dropExpired(
          { ...applied.archive, items: [...applied.archive.items, ...pending] }, collapse,
        );
        await tx.run(UPSERT, JSON.stringify(brain));
        await writeArchiveRows(tx, nextArchive);
        if (change.delegationTransfer !== undefined) {
          const transfer = change.delegationTransfer;
          if (transfer.source !== change.source || transfer.destination !== change.generation ||
              !Number.isSafeInteger(transfer.documentId) || transfer.documentId < 1 ||
              !Number.isSafeInteger(transfer.revision) || transfer.revision < 1 || await readTransferFrom(tx) !== undefined) {
            throw new Error("Invalid or conflicting delegation transfer; the sweep was not committed.");
          }
          const active = parseReturnedDelegation(transfer.content).active;
          if (transfer.sourceSeal !== undefined) validateDelegateSourceSeal(transfer.sourceSeal, transfer.source);
          if (transfer.inputCheckpoint !== undefined) {
            if (active === null || transfer.inputCheckpoint.documentId === transfer.documentId || transfer.inputCheckpoint.barrier?.documentId === transfer.documentId) {
              throw new Error("Invalid delegate input transfer; the sweep was not committed.");
            }
            validateInputTransfer(transfer.inputCheckpoint, active.input.id);
          }
          await tx.run("INSERT INTO delegation_transfer (id, document) VALUES (1, ?)", JSON.stringify(transfer));
        }
        // Commit the handoff in the same transaction as the sweep. Recovery can
        // now prove whether the old store was archived before removing it.
        await tx.run("UPDATE collapse_journal SET committed = 1 WHERE id = 1");
        // Every item a mark restored is reported, whoever's business it is to
        // put it back: a Brain record went back above, and an ephemeral item has
        // no home in the Brain, so the caller puts it into the live context.
        return { brain, archive: nextArchive, dropped, restored: applied.restored, deleted: applied.deleted };
      }),

    applyArchive: (write) =>
      database.transaction(async (tx) => {
        await requireNoPendingEdit(tx);
        const current = await readArchiveFrom(tx);
        const now = Date.now();
        if (write.kind === "pin") {
          const next = setArchivePin(current, write.id, write.pinned);
          const changed = next.items.find((item) => item.id === write.id);
          if (changed !== undefined) await writeArchiveItem(tx, changed);
          return { archive: next, refused: false };
        }
        if (write.kind === "mark") {
          // A mark changes nothing now: it is a decision the next collapse
          // applies (§4.1). The one thing it can do is be refused, when the
          // agent tries to withdraw a mark the person placed.
          const marked = setArchiveMark(current, write.id, write.action === null ? null : { action: write.action, author: write.author }, write.author);
          if (marked.refused) return { archive: current, refused: true };
          const archive = write.action === "restore" ? marked.archive : {
            ...marked.archive,
            items: marked.archive.items.map((item) => {
              if (item.id !== write.id || item.restorePending !== true) return item;
              const { restorePending: _pending, ...rest } = item;
              return rest;
            }),
          };
          const changed = archive.items.find((item) => item.id === write.id);
          if (changed !== undefined) await writeArchiveItem(tx, changed);
          return { archive, refused: false };
        }
        const item = current.items.find((candidate) => candidate.id === write.id);
        if (item === undefined) return { archive: current, refused: false };
        if (write.kind === "restore" && item.layer === "ephemeral") {
          // The caller must place it in the live store before acknowledging it.
          return { archive: current, item, refused: false };
        }
        if (write.kind === "restore-complete" && (item.layer !== "ephemeral" ||
            write.expected.id !== write.id || JSON.stringify(item) !== JSON.stringify(write.expected))) {
          // The live write and Brain acknowledgement are separate commits. An
          // edit, pin or withdrawn mark in between must not be deleted by a
          // stale acknowledgement, even if the archive ID is unchanged.
          return { archive: current, item, refused: true };
        }
        const archive = { ...current, items: current.items.filter((candidate) => candidate.id !== item.id) };
        if (write.kind === "restore") {
          const back = writeBackOf(item);
          if (back === undefined) return { archive: current, item, refused: true };
          const brain = applyWrite(await readFrom(tx), back, now);
          await tx.run(UPSERT, JSON.stringify(brain));
        }
        await tx.run(ARCHIVE_DELETE, item.id);
        return { archive, item, refused: false };
      }),

    archiveEphemeral: (item, generation, now) =>
      database.transaction(async (tx) => {
        if (item.layer !== "ephemeral" || item.ephemeral === undefined) throw new Error("Not an ephemeral item");
        const current = await readArchiveFrom(tx);
        // Retrying after interruption must not reset its grace or overwrite a pin.
        if (current.items.some((candidate) => candidate.id === item.id)) return;
        const counter = await tx.get<{ collapses: number }>("SELECT collapses FROM archive_counter WHERE id = 1");
        const added = sweep(emptyArchive(), generation, counter?.collapses ?? 0, now, [item]).items[0];
        if (added !== undefined) await writeArchiveItem(tx, added);
      }),

    applyRecordAction: (change) =>
      database.transaction(async (tx) => {
        await requireNoPendingEdit(tx);
        const current = await readFrom(tx);
        const record = recordOf(current, change.kind, change.id);
        // A record that is not in the Brain is not an error: the person may
        // have applied it in another window a moment ago. Nothing is written.
        if (record === undefined) return { brain: current, archive: await readArchiveFrom(tx), found: false };
        // The mark is spent by being applied, and the record leaves with it:
        // an archived record is a record, not a record carrying a mark.
        let next = applyWrite(current, { kind: "mark.clear", target: change.kind, id: change.id }, change.now);
        next = applyWrite(next, { kind: "delete", target: change.kind, id: change.id }, change.now);
        let archive = await readArchiveFrom(tx);
        if (change.action === "archive") {
          // Stamped with the last collapse, so an item archived between
          // collapses is dropped at the next one unless pinned or restored.
          const counter = await tx.get<{ collapses: number }>("SELECT collapses FROM archive_counter WHERE id = 1");
          const item: ArchivedItem = {
            id: `record:${change.kind}:${change.id}`,
            layer: "record",
            record: { kind: change.kind, value: withoutMark(record) as ArchivedRecord },
            sweptAtGeneration: change.generation,
            sweptAtCollapse: counter?.collapses ?? 0,
            sweptAt: change.now,
          };
          archive = { ...archive, items: [...archive.items.filter((candidate) => candidate.id !== item.id), item] };
        }
        await tx.run(UPSERT, JSON.stringify(next));
        await writeArchiveRows(tx, archive);
        return { brain: next, archive, found: true };
      }),

    async compact() {
      await database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      await database.exec("VACUUM");
    },

    close: () => database.close(),
  };
}
