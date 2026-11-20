/**
 * The Brain store (MINI.md §2, §4.2).
 *
 * One document per project, current state only — the Brain has no audit
 * trail of old values. Reads return a fresh value; `apply` runs inside a
 * single transaction and cannot leave a half-written Brain behind. Deletion
 * is a single step.
 *
 * `history: "latest"` is honoured by construction: one row, one document,
 * overwritten in place. Carto asks SQLite for secure-delete, a WAL
 * checkpoint with truncation, and `VACUUM` on demand — best-effort local
 * cleanup, not a guarantee against wear levelling or backups (§4.2).
 */
import { DatabaseSync } from "node:sqlite";
import { reconcileHandles } from "../domain/handles.js";
import { applyWrite, type BrainWrite } from "../domain/brain.js";
import { emptyBrain, type CartoBrain } from "../domain/records.js";

export interface BrainStore {
  /** The current Brain, handles reconciled. Never undefined. */
  read(): CartoBrain;
  /** Apply one write inside one transaction; returns the next Brain. */
  apply(write: BrainWrite, now: number): CartoBrain;
  /** Secure-delete the old pages: WAL checkpoint and VACUUM. */
  compact(): void;
  close(): void;
}

export function openBrain(databasePath: string): BrainStore {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA secure_delete = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(
    "CREATE TABLE IF NOT EXISTS brain_document (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL)",
  );

  const readRow = (): string | undefined => {
    const row = database.prepare("SELECT document FROM brain_document WHERE id = 1").get() as
      | { document: string }
      | undefined;
    return row?.document;
  };

  const decode = (document: string): CartoBrain => {
    // A corrupt Brain throws. It must never silently read as an empty Brain —
    // that would overwrite the person's memory with nothing.
    const parsed = JSON.parse(document) as CartoBrain;
    if (parsed === null || typeof parsed !== "object" || parsed.version !== 1) {
      throw new Error(`The Brain at ${databasePath} is not a Carto Brain document.`);
    }
    for (const key of ["chat", "ledger", "atlas", "userPins", "carryPins", "wakes"] as const) {
      if (!Array.isArray(parsed[key])) {
        throw new Error(`The Brain at ${databasePath} is missing its ${key} records.`);
      }
    }
    return reconcileHandles(parsed);
  };

  const read = (): CartoBrain => {
    const document = readRow();
    return document === undefined ? emptyBrain() : decode(document);
  };

  const write = database.prepare(
    "INSERT INTO brain_document (id, document) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document",
  );

  return {
    read,

    apply(writeToApply, now) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = read();
        const next = applyWrite(current, writeToApply, now);
        write.run(JSON.stringify(next));
        database.exec("COMMIT");
        return next;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    compact() {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      database.exec("VACUUM");
    },

    close() {
      database.close();
    },
  };
}
