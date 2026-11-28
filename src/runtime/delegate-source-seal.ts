/** Dormant logical fingerprint of a stopped Pi generation store. */
import { createHash } from "node:crypto";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

export type DelegateSourceSeal = { version: 1; algorithm: "sha256"; source: string; digest: string };

/** A seal is a change detector, not proof that a sweep was complete or committed. */
export function validateDelegateSourceSeal(value: unknown, source: string): asserts value is DelegateSourceSeal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid delegate source seal; recovery data was preserved.");
  const seal = value as Partial<DelegateSourceSeal>;
  if (Object.keys(value).length !== 4 || seal.version !== 1 || seal.algorithm !== "sha256" || seal.source !== source ||
      typeof seal.digest !== "string" || !/^[0-9a-f]{64}$/.test(seal.digest)) {
    throw new Error("Invalid delegate source seal; recovery data was preserved.");
  }
}

// The installed Pi SQLite schema uses these primary keys. Unknown tables, key
// shapes and hidden columns fail closed rather than being silently omitted.
const TABLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["live_durable_schema", ["singleton"]], ["live_durable_metadata", ["singleton"]],
  ["live_record_ids", ["id"]], ["live_conversations", ["id"]], ["live_entries", ["id"]],
  ["live_tasks", ["id"]], ["live_submissions", ["id"]], ["live_documents", ["id"]],
  ["live_document_revisions", ["document_id", "seq"]],
];
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Hash schema and every logical row, including WAL contents, in one read-only
 * SQLite snapshot using the installed Chord adapter. Stable primary-key order
 * makes this independent of page layout and WAL checkpointing. Unlike hashing
 * database files, it sees committed WAL changes and does not require a write or
 * migration. The caller must stop *all* source writers before capture and keep
 * them stopped through use; a snapshot is not a lock. The source must be a Pi
 * store with the known schema, not an empty or unrelated database.
 *
 * This does not bind a context capture or archive plan to the digest, cover the
 * projection files or Brain, or prove the source may be removed. It is not an
 * authorization to bypass the return-collapse guard. Large rows (including image
 * inputs) are materialized by Pi's SQLite facade, with at most 128 rows per page.
 */
export async function captureDelegateSourceSeal(path: string, source: string): Promise<DelegateSourceSeal> {
  if (!/^gen-[\w-]+$/.test(source)) throw new Error("Invalid source generation for delegate seal.");
  const database = await openNodeSqliteDatabase(path, { mode: "read-only" });
  try {
    return await database.transaction(async (tx) => {
      const schema = await tx.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
        "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
      );
      const actual = schema.filter((row) => row.type === "table").map((row) => row.name).sort();
      const expected = TABLES.map(([name]) => name).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Unsupported delegate source tables; the source was preserved.");
      const version = await tx.get<{ version: number }>("SELECT version FROM live_durable_schema WHERE singleton = 1");
      if (version?.version !== 2) throw new Error("Unsupported delegate source schema version; the source was preserved.");
      const hash = createHash("sha256");
      const update = (value: unknown) => {
        const text = JSON.stringify(value);
        if (text === undefined) throw new Error("Unsupported delegate source value; the source was preserved.");
        hash.update(`${Buffer.byteLength(text)}:`).update(text);
      };
      update(["carto.delegate-source-seal", 1, source]);
      update(schema.map((row) => [row.type, row.name, row.tbl_name, row.sql]));
      for (const [table, keys] of TABLES) {
        const columns = await tx.all<{ name: string; type: string; pk: number; hidden: number }>(`PRAGMA table_xinfo(${quote(table)})`);
        const primary = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
        if (columns.length === 0 || columns.some((column) => column.hidden !== 0 || !["INTEGER", "TEXT"].includes(column.type.toUpperCase())) || JSON.stringify(primary) !== JSON.stringify(keys)) {
          throw new Error("Unsupported delegate source table shape; the source was preserved.");
        }
        const names = columns.map((column) => column.name);
        update([table, names]);
        let offset = 0;
        for (;;) {
          const rows = await tx.all<Record<string, unknown>>(`SELECT * FROM ${quote(table)} ORDER BY ${keys.map(quote).join(", ")} LIMIT 128 OFFSET ?`, offset);
          for (const row of rows) {
            update(columns.map((column) => {
              const value = row[column.name];
              const type = column.type.toUpperCase();
              if (value === null) return ["null"];
              if (type === "TEXT" && typeof value === "string") return ["text", value];
              if (type === "INTEGER" && typeof value === "number" && Number.isSafeInteger(value)) return ["integer", String(value)];
              if (type === "INTEGER" && typeof value === "bigint") return ["integer", value.toString()];
              throw new Error("Unsupported delegate source value; the source was preserved.");
            }));
          }
          offset += rows.length;
          if (rows.length < 128) break;
        }
        update(["rows", offset]);
      }
      return { version: 1 as const, algorithm: "sha256" as const, source, digest: hash.digest("hex") };
    });
  } finally {
    await database.close();
  }
}
