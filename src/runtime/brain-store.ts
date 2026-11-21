/**
 * The Brain store (MINI.md §2, §4.2).
 *
 * One document per project, current state only — the Brain has no audit
 * trail of old values. Reads return a fresh value; `apply` runs inside a
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
import { emptyBrain, type CartoBrain } from "../domain/records.js";

export interface BrainStore {
  /** The current Brain, handles reconciled. Never undefined. */
  read(): Promise<CartoBrain>;
  /** Apply one write inside one transaction; returns the next Brain. */
  apply(write: BrainWrite, now: number): Promise<CartoBrain>;
  /** Secure-delete the old pages: WAL checkpoint and VACUUM. */
  compact(): Promise<void>;
  close(): Promise<void>;
}

const TABLE =
  "CREATE TABLE IF NOT EXISTS brain_document (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL)";
const UPSERT =
  "INSERT INTO brain_document (id, document) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document";
const DOCUMENT = "SELECT document FROM brain_document WHERE id = 1";

export async function openBrain(databasePath: string): Promise<BrainStore> {
  // pi defaults to WAL + synchronous=NORMAL + a 5,000 ms busy timeout and
  // checkpoints the WAL at close; the Brain keeps that and adds secure_delete.
  const database = await openNodeSqliteDatabase(databasePath);
  await database.exec("PRAGMA secure_delete = ON");
  await database.exec(TABLE);

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
    return reconcileHandles(parsed);
  };

  const readFrom = async (source: SqliteExecutor): Promise<CartoBrain> => {
    const row = await source.get<{ document: string }>(DOCUMENT);
    return row === undefined ? emptyBrain() : decode(row.document);
  };

  return {
    read: () => readFrom(database),

    apply: (writeToApply, now) =>
      database.transaction(async (tx) => {
        const current = await readFrom(tx);
        const next = applyWrite(current, writeToApply, now);
        await tx.run(UPSERT, JSON.stringify(next));
        return next;
      }),

    async compact() {
      await database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      await database.exec("VACUUM");
    },

    close: () => database.close(),
  };
}
