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
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/chord/sqlite";

import { reconcileHandles } from "../domain/handles.js";
import { applyWrite, type BrainWrite } from "../domain/brain.js";
import { emptyBrain, type AtlasNode, type CartoBrain, type ChatRecord, type LedgerEntry } from "../domain/records.js";
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
  /** The archive as it stands. The agent never sees it (§3.3). */
  readArchive(): Promise<Archive>;
  /** Durable cross-store collapse intent and commit status, if cleanup is pending. */
  readCollapseJournal(): Promise<CollapseJournal | undefined>;
  /** Reserve a transition before creating the next generation's files. */
  beginCollapse(source: string, destination: string, validate?: () => void): Promise<void>;
  /** Serialize filesystem recovery with other journal writers, clearing only after success. */
  recoverCollapseJournal(recover: (journal: CollapseJournal) => Promise<void>): Promise<void>;
  /**
   * Every Agent Chat record that still exists anywhere — in the Brain, or in
   * the archive because a collage swept it out. A Chat record does not leave
   * the agent's context when a collapse rebuilds it, and the transcript is where
   * the person reads the conversation, so it stays on screen; this is how the
   * transcript finds it after the store it was written in is gone.
   */
  readAgentChat(): Promise<ChatRecord[]>;
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
const ARCHIVE_INSERT =
  "INSERT INTO archive_item (id, swept_at_collapse, swept_at_generation, pinned, document) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET swept_at_collapse = excluded.swept_at_collapse, swept_at_generation = excluded.swept_at_generation, pinned = excluded.pinned, document = excluded.document";
const ARCHIVE_SELECT = "SELECT document FROM archive_item ORDER BY rowid";
const ARCHIVE_DELETE = "DELETE FROM archive_item WHERE id = ?";
const UPSERT =
  "INSERT INTO brain_document (id, document) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document";
const DOCUMENT = "SELECT document FROM brain_document WHERE id = 1";

/** The Brain write that puts an archived record back as the type it was. */
function writeBackOf(item: ArchivedItem): BrainWrite | undefined {
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
  /** A restored ephemeral has been durably placed in its destination. */
  | { kind: "restore-complete"; id: string }
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

export async function openBrain(databasePath: string): Promise<BrainStore> {
  // pi defaults to WAL + synchronous=NORMAL + a 5,000 ms busy timeout and
  // checkpoints the WAL at close; the Brain keeps that and adds secure_delete.
  const database = await openNodeSqliteDatabase(databasePath);
  await database.exec("PRAGMA secure_delete = ON");
  await database.exec(TABLE);
  await database.exec(ARCHIVE_TABLE);
  await database.exec(COUNTER_TABLE);
  await database.exec(COLLAPSE_JOURNAL_TABLE);
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

  return {
    read: () => readFrom(database),
    readCollapseJournal: () => readJournalFrom(database),
    beginCollapse: (source, destination, validate) => database.transaction(async (tx) => {
      if (await readJournalFrom(tx) !== undefined) throw new Error("A collapse is already in progress or awaiting recovery.");
      validate?.();
      await tx.run("INSERT INTO collapse_journal (id, source, destination, owner_pid, committed) VALUES (1, ?, ?, ?, 0)", source, destination, process.pid);
    }),
    recoverCollapseJournal: (recover) => database.transaction(async (tx) => {
      const journal = await readJournalFrom(tx);
      if (journal === undefined) return;
      // Hold SQLite's write lock while reconciling files: two recoveries must
      // not delete files after either has cleared and replaced the journal.
      await recover(journal);
      await tx.run("DELETE FROM collapse_journal WHERE id = 1");
    }),

    apply: (writeToApply, now) =>
      database.transaction(async (tx) => {
        const current = await readFrom(tx);
        const next = applyWrite(current, writeToApply, now);
        await tx.run(UPSERT, JSON.stringify(next));
        return next;
      }),

    readArchive: () => readArchiveFrom(database),

    readAgentChat: async () => {
      // Both places an Agent Chat record can be: the Brain, and the archive —
      // archived records keep their id, so a swept record is the same record,
      // and the transcript shows it once either way.
      const brainRecords = (await readFrom(database)).chat.filter((record) => record.author === "agent");
      const archived = (await readArchiveFrom(database)).items
        .filter((item) => item.layer === "record" && item.record?.kind === "chat")
        .map((item) => item.record?.value as ChatRecord | undefined)
        .filter((record): record is ChatRecord => record !== undefined && record.author === "agent");
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
        const swept = sweep(await readArchiveFrom(tx), change.generation, collapse, change.now, change.incoming);
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
        const current = await readArchiveFrom(tx);
        const now = Date.now();
        if (write.kind === "pin") {
          const next = setArchivePin(current, write.id, write.pinned);
          await writeArchiveRows(tx, next);
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
          await writeArchiveRows(tx, archive);
          return { archive, refused: false };
        }
        const item = current.items.find((candidate) => candidate.id === write.id);
        if (item === undefined) return { archive: current, refused: false };
        if (write.kind === "restore" && item.layer === "ephemeral") {
          // The caller must place it in the live store before acknowledging it.
          return { archive: current, item, refused: false };
        }
        if (write.kind === "restore-complete" && item.layer !== "ephemeral") {
          return { archive: current, refused: true };
        }
        const archive = { ...current, items: current.items.filter((candidate) => candidate.id !== item.id) };
        if (write.kind === "restore") {
          const back = writeBackOf(item);
          if (back === undefined) return { archive: current, item, refused: true };
          const brain = applyWrite(await readFrom(tx), back, now);
          await tx.run(UPSERT, JSON.stringify(brain));
        }
        await writeArchiveRows(tx, archive);
        return { archive, item, refused: false };
      }),

    archiveEphemeral: (item, generation, now) =>
      database.transaction(async (tx) => {
        if (item.layer !== "ephemeral" || item.ephemeral === undefined) throw new Error("Not an ephemeral item");
        const current = await readArchiveFrom(tx);
        // Retrying after interruption must not reset its grace or overwrite a pin.
        if (current.items.some((candidate) => candidate.id === item.id)) return;
        const counter = await tx.get<{ collapses: number }>("SELECT collapses FROM archive_counter WHERE id = 1");
        await writeArchiveRows(tx, sweep(current, generation, counter?.collapses ?? 0, now, [item]));
      }),

    applyRecordAction: (change) =>
      database.transaction(async (tx) => {
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
          // Stamped with the collapse that last ran, so the record waits out the
          // same one collapse of grace a swept record does (§3.3): the next
          // collapse keeps it, the one after that drops it.
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
