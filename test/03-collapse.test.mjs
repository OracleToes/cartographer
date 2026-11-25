// Run the independent small suites in this worker to avoid a fifth Node startup.
import "./agent-reminder.mjs";
import "./fast-suite.mjs";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { applyWrite } from "../dist/domain/brain.js";
import { emptyBrain } from "../dist/domain/records.js";
import { openBrain } from "../dist/runtime/brain-store.js";
import { createTools } from "../dist/runtime/tools.js";
import { assertPinnableFile } from "../dist/runtime/workspace.js";
import { collapse, discoverGenerations, reconcileGenerations, recoverCollapse, generationPaths, rewriteHeadSnapshot } from "../dist/runtime/collapse.js";
import { writeSnapshot } from "../dist/runtime/projection-files.js";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { readGenerationEphemera } from "../dist/runtime/collapse.js";
import { projectContext } from "../dist/domain/projection.js";
import { frozenTranscript } from "../dist/ui/transcript.js";

const at = (n) => 1_700_000_000_000 + n * 1_000;

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "carto-collapse-"));
}

/** A fake live generation: a store file plus its frozen snapshot. */
function fakeGeneration(root, generation, mtimeSeconds) {
  const paths = generationPaths(root, generation);
  const database = new DatabaseSync(paths.store);
  database.exec("CREATE TABLE live_entries (id INTEGER, head INTEGER, record TEXT)");
  database.close();
  const brain = emptyBrain();
  writeSnapshot(root, generation, projectContext(brain), at(1));
  const when = new Date(mtimeSeconds * 1000);
  for (const path of [paths.store, paths.markdown, paths.sidecar]) utimesSync(path, when, when);
  return paths;
}

// Each case uses a separate temporary project and database.
test.describe("collapse and recovery", { concurrency: 3 }, () => {
test("discovery orders newest first and pairs store with snapshot", () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T010000Z-aaaa01", 1_700_000_000);
    fakeGeneration(root, "gen-20261116T020000Z-bbbb02", 1_700_000_100);
    const generations = discoverGenerations(root);
    assert.equal(generations.length, 2);
    assert.equal(generations[0].generation, "gen-20261116T020000Z-bbbb02");
    assert.equal(generations[0].hasStore && generations[0].hasMarkdown && generations[0].hasSidecar, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unjournaled store missing its snapshot is preserved for recovery", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T010000Z-aaaa01", 1_700_000_000);
    const paths = generationPaths(root, "gen-20261116T020000Z-crashed");
    writeFileSync(paths.store, "bytes"); // store, but no snapshot: crashed mid-creation
    utimesSync(paths.store, new Date(1_700_000_200_000), new Date(1_700_000_200_000));

    const brain = await openBrain(join(root, ".brain", "brain.sqlite"));
    await assert.rejects(reconcileGenerations(root, brain), /missing its snapshot/);
    await brain.close();
    assert.equal(readFileSync(paths.store, "utf8"), "bytes");
    assert.equal(existsSync(generationPaths(root, "gen-20261116T010000Z-aaaa01").store), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multiple unjournaled stores are preserved rather than guessed away", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T010000Z-aaaa01", 1_700_000_000);
    fakeGeneration(root, "gen-20261116T020000Z-bbbb02", 1_700_000_100);
    fakeGeneration(root, "gen-20261116T030000Z-cccc03", 1_700_000_200);
    const brain = await openBrain(join(root, ".brain", "brain.sqlite"));
    await assert.rejects(reconcileGenerations(root, brain), /Multiple unjournaled/);
    await brain.close();
    for (const generation of ["gen-20261116T010000Z-aaaa01", "gen-20261116T020000Z-bbbb02", "gen-20261116T030000Z-cccc03"]) {
      assert.equal(existsSync(generationPaths(root, generation).store), true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collapse creates the new generation, sweeps the old store into the archive, and deletes it whole", async () => {
  const root = tempRoot();
  try {
    const live = fakeGeneration(root, "gen-20261116T020000Z-live001", 1_700_000_100);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    await store.apply({ kind: "chat.record", record: { id: "c1", author: "user", text: "before collapse", createdAt: at(1), updatedAt: at(1) } }, at(1));

    const report = await collapse(root, store);

    assert.equal(report.swept, "gen-20261116T020000Z-live001");
    assert.notEqual(report.swept, report.generation);
    // The old store is gone, not sealed: a real deletion (§3.4).
    assert.equal(existsSync(live.store), false);
    assert.equal(existsSync(live.markdown), false);
    // The new generation exists with a snapshot and carries the Brain's content.
    const newPaths = generationPaths(root, report.generation);
    assert.equal(existsSync(newPaths.markdown), true);
    const markdown = readFileSync(newPaths.markdown, "utf8");
    assert.match(markdown, /Chat — what you and .* have said to each other\nC1 \[.*\] — .*\n  before collapse/);
    await store.close();
  } finally {
    for (const name of ["gen-20261116T020000Z-live001.sqlite", "gen-20261116T020000Z-live001.projection.md", "gen-20261116T020000Z-live001.projection.json"]) {
      try { chmodSync(join(root, ".brain", "context", name), 0o644); } catch { /* gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("collapse preserves an unreadable live store instead of sweeping it as empty", async () => {
  const root = tempRoot();
  try {
    const live = fakeGeneration(root, "gen-20261116T020000Z-corrupt", 1_700_000_100);
    const bytes = "not a sqlite database: recover me";
    writeFileSync(live.store, bytes);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    try {
      await assert.rejects(collapse(root, store));
      assert.equal(readFileSync(live.store, "utf8"), bytes);
      assert.deepEqual((await store.readArchive()).items, []);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record marked for archive leaves the Brain and lands in the archive", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live004", 1_700_000_100);
    const store = await openBrain(":memory:");
    await store.apply({ kind: "chat.record", record: { id: "c1", author: "user", text: "keep me", createdAt: at(1), updatedAt: at(1) } }, at(1));
    await store.apply({ kind: "mark.set", target: "chat", id: "c1", action: "archive", author: "user" }, at(2));

    const report = await collapse(root, store);

    assert.deepEqual(report.archived, ["c1"]);
    // The head the new generation is built from does not carry the swept record
    // (§2: the context is rebuilt from the Brain alone, nothing hidden by a mark).
    const head = readFileSync(generationPaths(root, report.generation).markdown, "utf8");
    assert.equal(head.includes("keep me"), false);
    const brain = await store.read();
    assert.equal(brain.chat.length, 0, "archiving moves the record out of the Brain (§4.1)");
    const archive = await store.readArchive();
    const item = archive.items.find((candidate) => candidate.layer === "record");
    assert.ok(item !== undefined);
    assert.equal(item.record?.kind, "chat");
    // The sweep was stamped with the generation the collapse was working on.
    assert.equal(typeof item.sweptAtGeneration, "string");
    assert.equal(item.sweptAtCollapse, 1);
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the agent can mark Atlas, Ledger, and Chat records for archive at collapse", async () => {
  const root = tempRoot();
  let store;
  try {
    fakeGeneration(root, "gen-20261116T020000Z-agentarchive", 1_700_000_100);
    store = await openBrain(":memory:");
    await store.apply({ kind: "atlas.upsert", node: { id: "a1", title: "Done", text: "atlas work", links: [], attachments: [], createdAt: at(1), updatedAt: at(1) } }, at(1));
    await store.apply({ kind: "ledger.upsert", entry: { id: "l1", kind: "note", text: "ledger work", status: "open", answer: null, createdAt: at(1), updatedAt: at(1) } }, at(1));
    await store.apply({ kind: "chat.record", record: { id: "c1", author: "agent", text: "chat work", createdAt: at(1), updatedAt: at(1) } }, at(1));
    const session = { person: "OracleToes", pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-20261116T020000Z-agentarchive", readOnly: false };
    const mark = createTools({ root, brain: store, session }).find((tool) => tool.name === "mark");
    const api = { now: () => at(2) };
    for (const handle of ["A1", "L1", "C1"]) await mark.execute({ handle, action: "archive" }, api, {});
    const before = await store.read();
    for (const record of [before.atlas[0], before.ledger[0], before.chat[0]]) {
      assert.deepEqual(record.mark, { action: "archive", author: "agent" });
    }
    const report = await collapse(root, store);
    const after = await store.read();
    assert.equal(after.atlas.length + after.ledger.length + after.chat.length, 0);
    const paths = generationPaths(root, report.generation);
    const sidecar = JSON.parse(readFileSync(paths.sidecar, "utf8"));
    const head = frozenTranscript(readFileSync(paths.markdown, "utf8"), after, sidecar.chat, new Map(), "OracleToes");
    assert.equal(head.some((entry) => entry.text === "chat work"), false, "archived Chat is absent from the new prompt and transcript");
    const archived = (await store.readArchive()).items.filter((item) => item.layer === "record");
    assert.deepEqual(archived.map((item) => item.record.kind).sort(), ["atlas", "chat", "ledger"]);
  } finally {
    if (store !== undefined) await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record marked for delete is deleted for real at the collapse and leaves nothing behind", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live007", 1_700_000_100);
    const store = await openBrain(":memory:");
    await store.apply({ kind: "chat.record", record: { id: "c1", author: "agent", text: "gone at collapse", createdAt: at(1), updatedAt: at(1) } }, at(1));
    await store.apply({ kind: "mark.set", target: "chat", id: "c1", action: "delete", author: "user" }, at(2));

    const report = await collapse(root, store);

    assert.deepEqual(report.archived, [], "a delete mark archives nothing");
    assert.equal((await store.read()).chat.length, 0);
    assert.equal((await store.readArchive()).items.length, 0, "a deleted record is not kept in the archive");
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unpinned item swept at a collapse is dropped at the next collapse", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live005", 1_700_000_100);
    const store = await openBrain(":memory:");
    await store.apply({ kind: "chat.record", record: { id: "c1", author: "user", text: "swept once", createdAt: at(1), updatedAt: at(1) } }, at(1));
    await store.apply({ kind: "mark.set", target: "chat", id: "c1", action: "archive", author: "user" }, at(2));

    const first = await collapse(root, store);
    assert.deepEqual(first.archived, ["c1"]);
    assert.deepEqual(first.dropped, [], "nothing is dropped by the collapse that swept it");

    assert.equal((await store.readArchive()).items.length, 1, "it remains available during the following period");
    const second = await collapse(root, store);
    assert.equal(second.dropped.length, 1, "the next collapse drops the old item");
    assert.equal((await store.readArchive()).items.length, 0);
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("items archived between collapses expire at the next collapse, while new sweep items wait", async () => {
  const root = tempRoot();
  try {
    const generation = "gen-20261116T020000Z-live0aa";
    fakeGeneration(root, generation, 1_700_000_100);
    const store = await openBrain(":memory:");
    try {
      const record = (id) => ({ id, author: "user", text: id, createdAt: at(1), updatedAt: at(1) });
      await store.apply({ kind: "chat.record", record: record("immediate") }, at(1));
      await store.applyRecordAction({ kind: "chat", id: "immediate", action: "archive", generation, now: at(2) });
      await store.archiveEphemeral({ id: "ephemeral-now", layer: "ephemeral", ephemeral: { kind: "plainText", text: "archived now" } }, generation, at(2));
      await store.apply({ kind: "chat.record", record: record("new-sweep") }, at(1));
      await store.apply({ kind: "mark.set", target: "chat", id: "new-sweep", action: "archive", author: "user" }, at(2));
      const report = await collapse(root, store);
      assert.deepEqual(new Set(report.dropped), new Set(["record:chat:immediate", "ephemeral-now"]));
      const remaining = (await store.readArchive()).items;
      assert.deepEqual(remaining.map((item) => item.record?.value.id), ["new-sweep"], "the current collapse's sweep is not dropped immediately");
      const next = await collapse(root, store);
      assert.deepEqual(next.dropped, ["record:chat:new-sweep"]);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pinned archive item is never dropped; a restore puts it back as its type", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live006", 1_700_000_100);
    const store = await openBrain(":memory:");
    await store.apply({ kind: "ledger.upsert", entry: { id: "l1", kind: "note", text: "a note", status: "open", answer: null, createdAt: at(1), updatedAt: at(1) } }, at(1));
    await store.apply({ kind: "mark.set", target: "ledger", id: "l1", action: "archive", author: "agent" }, at(2));
    await collapse(root, store);
    const item = (await store.readArchive()).items[0];
    assert.ok(item !== undefined);
    assert.deepEqual(await store.readArchiveCounts(), { total: 1, pinned: 0 });
    await store.applyArchive({ kind: "pin", id: item.id, pinned: "user" });
    assert.deepEqual(await store.readArchiveCounts(), { total: 1, pinned: 1 });

    await collapse(root, store);
    await collapse(root, store);
    assert.equal((await store.readArchive()).items.length, 1, "a pin suspends grace");

    const restored = await store.applyArchive({ kind: "restore", id: item.id });
    assert.equal(restored.item?.record?.kind, "ledger");
    assert.equal((await store.readArchive()).items.length, 0);
    // It is a Brain record again, of its original type (§3.3).
    const brain = await store.read();
    assert.equal(brain.ledger.length, 1);
    assert.equal(brain.ledger[0].text, "a note");
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an old pinned archive item expires on the first collapse after unpinning", async () => {
  const root = tempRoot();
  try {
    const generation = "gen-20261116T020000Z-live0ab";
    fakeGeneration(root, generation, 1_700_000_100);
    const store = await openBrain(":memory:");
    try {
      await store.archiveEphemeral({ id: "pinned-old", layer: "ephemeral", ephemeral: { kind: "plainText", text: "kept" } }, generation, at(1));
      await store.applyArchive({ kind: "pin", id: "pinned-old", pinned: "user" });
      assert.deepEqual((await collapse(root, store)).dropped, []);
      assert.deepEqual((await collapse(root, store)).dropped, []);
      await store.applyArchive({ kind: "pin", id: "pinned-old", pinned: null });
      assert.deepEqual((await collapse(root, store)).dropped, ["pinned-old"]);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore is a mark: the item waits in the archive, and the next collapse returns it as its type", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live00b", 1_700_000_100);
    const store = await openBrain(":memory:");
    await store.apply({ kind: "ledger.upsert", entry: { id: "l1", kind: "note", text: "a marked note", status: "open", answer: null, createdAt: at(1), updatedAt: at(1) } }, at(1));
    await store.apply({ kind: "mark.set", target: "ledger", id: "l1", action: "archive", author: "agent" }, at(2));
    await collapse(root, store);
    const item = (await store.readArchive()).items[0];
    assert.ok(item !== undefined);

    // Marked, not moved: §4.1 says the mark is what the collapse applies.
    await store.applyArchive({ kind: "mark", id: item.id, action: "restore", author: "user" });
    const waiting = (await store.readArchive()).items;
    assert.equal(waiting.length, 1, "the item is still in the archive until a collapse runs");
    assert.deepEqual(waiting[0].mark, { action: "restore", author: "user" });
    assert.equal((await store.read()).ledger.length, 0, "and it is not in the Brain yet");

    const report = await collapse(root, store);
    assert.equal(report.restored.length, 1, "the collapse applied the mark");
    assert.equal((await store.readArchive()).items.length, 0, "it leaves the archive");
    const brain = await store.read();
    assert.equal(brain.ledger.length, 1, "and it is a Brain record again");
    assert.equal(brain.ledger[0].text, "a marked note", "of its original type");
    assert.match(readFileSync(generationPaths(root, report.generation).markdown, "utf8"), /a marked note/, "the restored record is in the frozen model head");
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a marked item does not run out of grace while the mark stands", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live00c", 1_700_000_100);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    await store.apply({ kind: "ledger.upsert", entry: { id: "l1", kind: "note", text: "holds its place", status: "open", answer: null, createdAt: at(1), updatedAt: at(1) } }, at(1));
    await store.apply({ kind: "mark.set", target: "ledger", id: "l1", action: "archive", author: "agent" }, at(2));
    await collapse(root, store);
    const item = (await store.readArchive()).items[0];
    await store.applyArchive({ kind: "mark", id: item.id, action: "delete", author: "user" });
    await store.applyArchive({ kind: "mark", id: item.id, action: null, author: "user" });
    assert.equal((await store.readArchive()).items[0].mark, undefined, "the person withdrew their own mark");

    await store.applyArchive({ kind: "mark", id: item.id, action: "restore", author: "agent" });
    const second = await collapse(root, store);
    assert.deepEqual(second.dropped, [], "a mark holds the item through its grace");
    assert.equal((await store.readArchive()).items.length, 0, "and the collapse applies it");
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mark the person placed is theirs to withdraw; the agent may not", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live00d", 1_700_000_100);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    await store.apply({ kind: "ledger.upsert", entry: { id: "l1", kind: "note", text: "the person's call", status: "open", answer: null, createdAt: at(1), updatedAt: at(1) } }, at(1));
    await store.apply({ kind: "mark.set", target: "ledger", id: "l1", action: "archive", author: "user" }, at(2));
    // The same rule on the Brain's own marks: only the person withdraws theirs.
    await assert.rejects(
      store.apply({ kind: "mark.clear", target: "ledger", id: "l1", author: "agent" }, at(3)),
      /person/i,
      "the agent cannot withdraw a mark the person placed",
    );
    await store.apply({ kind: "mark.clear", target: "ledger", id: "l1", author: "user" }, at(4));
    assert.equal((await store.read()).ledger[0].mark, undefined, "the person withdrew their own");

    await store.apply({ kind: "mark.set", target: "ledger", id: "l1", action: "archive", author: "agent" }, at(5));
    await collapse(root, store);
    const item = (await store.readArchive()).items[0];
    await store.applyArchive({ kind: "mark", id: item.id, action: "delete", author: "user" });
    const refused = await store.applyArchive({ kind: "mark", id: item.id, action: null, author: "agent" });
    assert.equal(refused.refused, true, "the agent cannot withdraw the person's archive mark either");
    assert.deepEqual((await store.readArchive()).items[0].mark, { action: "delete", author: "user" });
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A real generation store: what pi writes, so the sweep reads what a session
 * actually leaves behind rather than a fixture shaped like the reader.
 */
async function realGeneration(root, generation, mtimeSeconds, rows, brain = emptyBrain()) {
  const paths = generationPaths(root, generation);
  const database = await openNodeSqliteDatabase(paths.store);
  await database.exec(
    "CREATE TABLE live_entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL)",
  );
  for (const [index, record] of rows.entries()) {
    await database.run(
      "INSERT INTO live_entries (id, conversation_id, commit_seq, record) VALUES (?, 1, ?, ?)",
      index + 1,
      index + 1,
      JSON.stringify(record),
    );
  }
  await database.close();
  // The snapshot is the one the session would have frozen: the Brain as it
  // stands, so a pinned item is in the head the way it would really be.
  writeSnapshot(root, generation, projectContext(brain), at(1));
  const when = new Date(mtimeSeconds * 1000);
  for (const path of [paths.store, paths.markdown, paths.sidecar]) utimesSync(path, when, when);
  return paths;
}

test("an interrupted collapse recovers on the correct side of the durable commit", async () => {
  for (const committed of [false, true]) {
    const root = tempRoot();
    let store;
    try {
      const generation = "gen-20261116T020000Z-source01";
      const source = await realGeneration(root, generation, 1_700_000_100, [
        { kind: "pi.user", model: [{ role: "user", content: "preserve this message" }] },
      ]);
      store = await openBrain(join(root, ".brain", "brain.sqlite"));
      const interrupted = { ...store, applyCollapse: async (change) => {
        if (committed) await store.applyCollapse(change);
        throw new Error("simulated crash");
      } };
      await assert.rejects(collapse(root, interrupted), /simulated crash/);
      const journal = await store.readCollapseJournal();
      assert.equal(journal.committed, committed);
      assert.equal(journal.source, generation);
      assert.ok(existsSync(source.store), "the source is intact at the crash point");
      await store.close();
      store = await openBrain(join(root, ".brain", "brain.sqlite"));
      const reconciled = await reconcileGenerations(root, store);
      assert.equal(reconciled.live.generation, committed ? journal.destination : generation);
      assert.equal(await store.readCollapseJournal(), undefined);
      if (committed) {
        assert.equal(existsSync(source.store), false);
        assert.ok(existsSync(generationPaths(root, journal.destination).store));
        assert.ok((await store.readArchive()).items.some((item) => item.ephemeral?.text === "preserve this message"));
      } else {
        assert.ok(existsSync(source.store));
        assert.equal(existsSync(generationPaths(root, journal.destination).store), false);
        assert.ok((await readGenerationEphemera(source.store, generation)).some((item) => item.ephemeral?.text === "preserve this message"));
        assert.equal((await store.readArchive()).items.length, 0);
      }
    } finally {
      if (store) await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("collapse refuses a snapshot made stale by concurrent Brain or archive changes", async () => {
  for (const changed of ["brain", "archive"]) {
    const root = tempRoot();
    try {
      const sourceId = `gen-20261116T020000Z-${changed}change`;
      const source = await realGeneration(root, sourceId, 1_700_000_100, [
        { kind: "pi.user", model: [{ role: "user", content: "keep this live" }] },
      ]);
      const store = await openBrain(join(root, ".brain", "brain.sqlite"));
      try {
        const racing = { ...store, applyCollapse: async (change) => {
          if (changed === "brain") {
            await store.apply({ kind: "ledger.upsert", entry: { id: "concurrent", kind: "note", text: "new note", status: "open", answer: null, createdAt: at(1), updatedAt: at(1) } }, at(1));
          } else {
            await store.archiveEphemeral({ id: "concurrent", layer: "ephemeral", ephemeral: { kind: "plainText", text: "new archive item" } }, sourceId, at(1));
          }
          return store.applyCollapse(change);
        } };
        await assert.rejects(collapse(root, racing), /changed during collapse/);
        assert.equal((await store.readCollapseJournal()).committed, false);
        const result = await reconcileGenerations(root, store);
        assert.equal(result.live.generation, sourceId);
        assert.ok(existsSync(source.store));
        if (changed === "brain") assert.equal((await store.read()).ledger[0].text, "new note");
        else assert.ok((await store.readArchive()).items.some((item) => item.id === "concurrent"));
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a failed Brain transaction cannot mark an uncommitted sweep as committed", async () => {
  const root = tempRoot();
  try {
    const source = "gen-20261116T020000Z-source05";
    const destination = "gen-20261116T030000Z-dest0005";
    await realGeneration(root, source, 1_700_000_100, []);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    try {
      await store.beginCollapse(source, destination);
      const bad = { kind: "plainText", text: "cannot be serialized" };
      bad.data = bad;
      await assert.rejects(store.applyCollapse({ source, generation: destination, expected: { brain: await store.read(), archive: await store.readArchive() }, writes: [], incoming: [{ id: "bad", layer: "ephemeral", ephemeral: bad }], now: at(1) }));
      assert.equal((await store.readCollapseJournal()).committed, false);
      assert.equal((await store.readArchive()).items.length, 0);
      await recoverCollapse(root, store);
      assert.ok(existsSync(generationPaths(root, source).store));
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery discards an incomplete destination when the sweep has not committed", async () => {
  const root = tempRoot();
  try {
    const sourceId = "gen-20261116T020000Z-source03";
    const destination = "gen-20261116T030000Z-dest0003";
    const source = await realGeneration(root, sourceId, 1_700_000_100, [
      { kind: "pi.user", model: [{ role: "user", content: "still here" }] },
    ]);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    try {
      await store.beginCollapse(sourceId, destination);
      writeFileSync(generationPaths(root, destination).markdown, "partial destination");
      const result = await reconcileGenerations(root, store);
      assert.equal(result.live.generation, sourceId);
      assert.ok(existsSync(source.store));
      assert.equal(existsSync(generationPaths(root, destination).markdown), false);
      assert.equal(await store.readCollapseJournal(), undefined);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciliation cannot mistake a still-running collapse for a crash", async () => {
  const root = tempRoot();
  try {
    const sourceId = "gen-20261116T020000Z-source04";
    const source = await realGeneration(root, sourceId, 1_700_000_100, [
      { kind: "pi.user", model: [{ role: "user", content: "concurrent recovery" }] },
    ]);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    try {
      let reached;
      let release;
      const arrived = new Promise((resolve) => { reached = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      const slowed = { ...store, applyCollapse: async (change) => {
        reached();
        await gate;
        return store.applyCollapse(change);
      } };
      const collapsing = collapse(root, slowed);
      await arrived;
      try {
        await assert.rejects(reconcileGenerations(root, store), /still running/);
        assert.ok(existsSync(source.store));
      } finally {
        release();
      }
      const report = await collapsing;
      assert.notEqual(report.generation, sourceId);
      assert.ok((await store.readArchive()).items.some((item) => item.ephemeral?.text === "concurrent recovery"));
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery does not interfere with a collapse owned by another live process", async () => {
  const root = tempRoot();
  try {
    const sourceId = "gen-20261116T020000Z-source06";
    const destination = "gen-20261116T030000Z-dest0006";
    const source = await realGeneration(root, sourceId, 1_700_000_100, []);
    const path = join(root, ".brain", "brain.sqlite");
    const store = await openBrain(path);
    try {
      await store.beginCollapse(sourceId, destination);
      const db = await openNodeSqliteDatabase(path);
      try { await db.run("UPDATE collapse_journal SET owner_pid = ? WHERE id = 1", process.ppid); }
      finally { await db.close(); }
      await assert.rejects(recoverCollapse(root, store), /Another process/);
      assert.ok(existsSync(source.store));
      assert.notEqual(await store.readCollapseJournal(), undefined);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery preserves the source if a committed destination is missing", async () => {
  const root = tempRoot();
  try {
    const source = await realGeneration(root, "gen-20261116T020000Z-source02", 1_700_000_100, [
      { kind: "pi.user", model: [{ role: "user", content: "do not delete" }] },
    ]);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    try {
      const interrupted = { ...store, applyCollapse: async (change) => {
        await store.applyCollapse(change);
        throw new Error("simulated crash");
      } };
      await assert.rejects(collapse(root, interrupted), /simulated crash/);
      const journal = await store.readCollapseJournal();
      rmSync(generationPaths(root, journal.destination).store);
      await assert.rejects(recoverCollapse(root, store), /complete generation/);
      assert.ok(existsSync(source.store));
      assert.ok((await store.readArchive()).items.some((item) => item.ephemeral?.text === "do not delete"));
      assert.equal((await store.readCollapseJournal()).committed, true);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a collapse sweeps the store's ephemera into the archive, item by item, and deletes the store", async () => {
  const root = tempRoot();
  try {
    const live = await realGeneration(root, "gen-20261116T020000Z-live008", 1_700_000_100, [
      { kind: "pi.user", model: [{ role: "user", content: "make the dice soft" }] },
      {
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "the corner needs a spring" },
              { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/die.ts" } },
            ],
          },
        ],
      },
      { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "export class Die {}" }] }] },
    ]);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));

    const reported = await readGenerationEphemera(live.store, "gen-20261116T020000Z-live008");
    assert.ok(reported.length >= 2, "the sweep reads the entries the store holds");
    assert.ok(reported.every((item) => item.layer === "ephemeral"));

    await collapse(root, store);

    // The store is gone, so the archive is the only place the text still exists
    // (§3.4), and it holds what was there rather than a summary of it.
    assert.equal(existsSync(live.store), false);
    const items = (await store.readArchive()).items;
    const texts = items.flatMap((item) => (item.ephemeral === undefined ? [] : [item.ephemeral.text]));
    assert.ok(texts.some((text) => text.includes("the corner needs a spring")), "reasoning is kept as reasoning");
    assert.ok(texts.some((text) => text.includes("make the dice soft")), "the person's message is kept");
    const read = items.find((item) => item.ephemeral?.kind === "readResult");
    assert.ok(read !== undefined, "a read's result keeps its own kind, so a restore can make it true again");
    assert.deepEqual(
      read.ephemeral.data,
      { callId: "call-1", tool: "read", path: "src/die.ts" },
      "the entity that produced it rides on it, path included: a restore needs to know what was read",
    );
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unpinned ephemeral is swept; a pinned one is carried into the head instead", async () => {
  const root = tempRoot();
  try {
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    const pinId = "gen-20261116T020000Z-live009:1:t0";
    await store.apply(
      {
        kind: "ephemeral.pin",
        item: { id: pinId, text: "this one is worth keeping", kind: "reasoning", createdAt: at(1), pinned: "user" },
      },
      at(1),
    );
    // The store holds that item, and the frozen prefill was written with the
    // pin in it, which is where a pinned item lives (§5.1).
    await realGeneration(
      root,
      "gen-20261116T020000Z-live009",
      1_700_000_100,
      [
        {
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "this one is worth keeping" },
                { type: "thinking", thinking: "this one is not" },
              ],
            },
          ],
        },
      ],
      await store.read(),
    );

    const report = await collapse(root, store, { person: "OracleToes" });
    const paths = generationPaths(root, report.generation);
    const sidecar = JSON.parse(readFileSync(paths.sidecar, "utf8"));
    const head = frozenTranscript(readFileSync(paths.markdown, "utf8"), await store.read(), sidecar.chat, new Map(sidecar.ephemeralItems.map(({ handle, item }) => [handle, item])), "OracleToes");
    assert.deepEqual(head.map((entry) => entry.text), ["this one is worth keeping"], "the transcript follows the new head, not the swept store");
    assert.equal(head[0].sourceId, pinId);
    const archived = (await store.readArchive()).items;
    assert.equal(
      archived.some((item) => item.ephemeral?.text === "this one is worth keeping"),
      false,
      "a pin keeps its item out of the archive",
    );
    assert.equal(
      archived.some((item) => item.ephemeral?.text === "this one is not"),
      true,
      "the pin protects the one item, not the store it was in",
    );
    // It went on into the rebuilt head, after Chat, under a handle of its own.
    const markdown = readFileSync(generationPaths(root, report.generation).markdown, "utf8");
    assert.match(markdown, /Pinned — what OracleToes kept in front of you/);
    assert.match(markdown, /X1 \[reasoning\] this one is worth keeping/);
    assert.equal((await store.read()).ephemera.length, 1, "the pin survives the collapse it carried it through");
    await store.close();
    const reopened = await openBrain(join(root, ".brain", "brain.sqlite"));
    try {
      const reopenedSidecar = JSON.parse(readFileSync(paths.sidecar, "utf8"));
      const reopenedHead = frozenTranscript(readFileSync(paths.markdown, "utf8"), await reopened.read(), reopenedSidecar.chat, new Map(reopenedSidecar.ephemeralItems.map(({ handle, item }) => [handle, item])), "OracleToes");
      assert.deepEqual(reopenedHead, head, "reopening recovers the same head and actionable item identity");
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deferred ephemeral deletion bypasses archive and removes a pin", async () => {
  const root = tempRoot();
  try {
    const generation = "gen-20261116T020000Z-live014";
    await realGeneration(root, generation, 1_700_000_100, [
      { kind: "pi.user", model: [{ role: "user", content: "delete me" }] },
      { kind: "pi.user", model: [{ role: "user", content: "archive me" }] },
    ]);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    try {
      const items = await readGenerationEphemera(generationPaths(root, generation).store, generation);
      const target = items.find((item) => item.ephemeral?.text === "delete me");
      assert.ok(target);
      await store.apply({ kind: "ephemeral.pin", item: { id: target.id, text: "delete me", kind: "personMessage", pinned: "user", createdAt: at(1) } }, at(1));
      await store.apply({ kind: "ephemeral.delete-mark", id: target.id, marked: true }, at(2));
      await collapse(root, store);
      assert.ok(!(await store.readArchive()).items.some((item) => item.ephemeral?.text === "delete me"));
      assert.ok((await store.readArchive()).items.some((item) => item.ephemeral?.text === "archive me"));
      const brain = await store.read();
      assert.ok(!brain.ephemera.some((item) => item.id === target.id));
      assert.ok(!brain.ephemeralDeletes.includes(target.id));
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Chat is swept like any Brain record: a recorded message is not archived as a line, and a carried one is not in the head", async () => {
  const root = tempRoot();
  try {
    await realGeneration(root, "gen-20261116T020000Z-live0c1", 1_700_000_100, [
      { kind: "pi.user", model: [{ role: "user", content: "said and recorded" }] },
      { kind: "pi.user", model: [{ role: "user", content: "carried on" }] },
      { kind: "pi.user", model: [{ role: "user", content: "never recorded" }] },
    ]);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    try {
      for (const [id, text, n] of [["c1", "said and recorded", 1], ["c2", "carried on", 2]]) {
        await store.apply({ kind: "chat.record", record: { id, author: "user", text, createdAt: at(n), updatedAt: at(n) } }, at(n));
      }
      const report = await collapse(root, store, { person: "OracleToes", carriedTexts: ["carried on"] });
      const archived = (await store.readArchive()).items.map((item) => item.ephemeral?.text).filter((text) => text !== undefined);
      assert.deepEqual(archived, ["never recorded"], "only the line with no record behind it is swept as a line");
      assert.equal((await store.read()).chat.length, 2, "no Chat leaves the Brain without a mark");
      const head = readFileSync(generationPaths(root, report.generation).markdown, "utf8");
      assert.match(head, /said and recorded/);
      assert.doesNotMatch(head, /carried on/, "the carried message is the new generation's first turn, so it is not also in the head");

      // A rebuild in the middle of the generation keeps to the Chat the head held.
      const later = applyWrite(await store.read(), { kind: "chat.record", record: { id: "c3", author: "user", text: "said since the freeze", createdAt: at(5), updatedAt: at(5) } }, at(5));
      rewriteHeadSnapshot(root, report.generation, later, "OracleToes", at(6));
      const rebuilt = readFileSync(generationPaths(root, report.generation).markdown, "utf8");
      assert.match(rebuilt, /said and recorded/);
      assert.doesNotMatch(rebuilt, /said since the freeze|carried on/, "the body holds what was said since; the head waits for the next collapse");
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a carried Chat identity excludes only that record from the frozen head", async () => {
  const root = tempRoot();
  try {
    await realGeneration(root, "gen-20261116T020000Z-live0c2", 1_700_000_100, []);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    try {
      for (const [id, n] of [["first", 1], ["second", 2]]) {
        await store.apply({ kind: "chat.record", record: { id, author: "user", text: "same", createdAt: at(n), updatedAt: at(n) } }, at(n));
      }
      const report = await collapse(root, store, { person: "OracleToes", carriedChatIds: ["first"] });
      const sidecar = JSON.parse(readFileSync(generationPaths(root, report.generation).sidecar, "utf8"));
      assert.deepEqual(sidecar.chat, ["second"]);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoring an ephemeral returns it to the archive's absence and the live context's keeping, without pinning it", async () => {
  const root = tempRoot();
  try {
    await realGeneration(root, "gen-20261116T020000Z-live00a", 1_700_000_100, [
      { kind: "pi.user", model: [{ role: "user", content: "a line worth recovering" }] },
    ]);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    await collapse(root, store);
    const item = (await store.readArchive()).items.find((candidate) => candidate.ephemeral?.text === "a line worth recovering");
    assert.ok(item !== undefined, "the sweep put it in the archive");

    const restored = await store.applyArchive({ kind: "restore", id: item.id });
    assert.equal(restored.item?.ephemeral?.kind, "personMessage", "it comes back as the kind it was");
    assert.equal((await store.readArchive()).items.length, 1, "the source stays until the live context acknowledges it");
    await store.applyArchive({ kind: "restore-complete", id: item.id });
    assert.equal((await store.readArchive()).items.length, 0, "the acknowledgement removes the source");
    // It went back to the live context, which the store is not: the Brain holds
    // no pin for it, because restoring does not also pin (§3.3).
    assert.equal((await store.read()).ephemera.length, 0, "restoring does not pin it into the head");
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applying one archive action leaves other pending marks untouched", async () => {
  const root = tempRoot();
  try {
    await realGeneration(root, "gen-20261116T020000Z-live010", 1_700_000_100, [
      { kind: "pi.user", model: [{ role: "user", content: "first" }] },
      { kind: "pi.user", model: [{ role: "user", content: "second" }] },
    ]);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    try {
      await collapse(root, store);
      const items = (await store.readArchive()).items;
      const first = items.find((item) => item.ephemeral?.text === "first");
      const second = items.find((item) => item.ephemeral?.text === "second");
      assert.ok(first && second);
      await store.applyArchive({ kind: "mark", id: second.id, action: "delete", author: "user" });
      await store.applyArchive({ kind: "drop", id: first.id });
      const remaining = (await store.readArchive()).items;
      assert.equal(remaining.length, 1);
      assert.deepEqual(remaining[0].mark, { action: "delete", author: "user" });
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a collapse keeps an ephemeral restore in the archive until acknowledgement", async () => {
  const root = tempRoot();
  try {
    await realGeneration(root, "gen-20261116T020000Z-live011", 1_700_000_100, [
      { kind: "pi.user", model: [{ role: "user", content: "recover after crash" }] },
    ]);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    try {
      await collapse(root, store);
      const item = (await store.readArchive()).items.find((candidate) => candidate.ephemeral?.text === "recover after crash");
      assert.ok(item);
      await store.applyArchive({ kind: "mark", id: item.id, action: "restore", author: "user" });
      const report = await collapse(root, store);
      assert.equal(report.restored.some((candidate) => candidate.id === item.id), true);
      assert.equal((await store.readArchive()).items.some((candidate) => candidate.id === item.id), true);
      await store.applyArchive({ kind: "restore-complete", id: item.id });
      assert.equal((await store.readArchive()).items.some((candidate) => candidate.id === item.id), false);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the live generation's frozen prefill stays byte-stable, and the old one goes with its store", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live002", 1_700_000_100);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    const report = await collapse(root, store);
    const snapshot = join(root, ".brain", "context", `${report.generation}.projection.md`);
    const first = readFileSync(snapshot, "utf8");
    // Nothing patches the projection between collapses (§5.6).
    assert.equal(readFileSync(snapshot, "utf8"), first);
    // A second collapse creates a new generation and deletes the old one whole,
    // its frozen prefill included (§3.4).
    const second = await collapse(root, store);
    assert.equal(existsSync(snapshot), false);
    assert.notEqual(second.generation, report.generation);
    assert.equal(existsSync(join(root, ".brain", "context", `${second.generation}.projection.md`)), true);
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pinned file is read again at the collapse, so the head holds the file and not a quotation", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live011", 1_700_000_100);
    writeFileSync(join(root, "notes.md"), "first draft\n");
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    await store.apply({ kind: "file.pin", path: "notes.md", pinned: "user" }, at(1));

    // The file moves on after the pin: the collapse must carry the new text,
    // because a pin is a promise the head holds the file (§5.1, §5.5).
    writeFileSync(join(root, "notes.md"), "second draft\n");
    const report = await collapse(root, store, { person: "OracleToes" });

    const markdown = readFileSync(generationPaths(root, report.generation).markdown, "utf8");
    assert.ok(markdown.includes("second draft"), "the head holds the file as it now stands");
    assert.ok(!markdown.includes("first draft"), "and not the text from before the pin");
    assert.match(markdown, /notes\.md · pinned by OracleToes/, "the pin says who placed it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pins follow project symlinks outside the project and refresh at collapse, but never read Brain links", async () => {
  const root = tempRoot();
  const outside = tempRoot();
  const alias = `${root}-alias`;
  let store;
  try {
    symlinkSync(root, alias, "dir");
    writeFileSync(join(root, "notes.md"), "linked project markdown\n");
    writeFileSync(join(outside, "private.md"), "outside secret\n");
    symlinkSync(join(root, "notes.md"), join(root, "inside.md"));
    symlinkSync(join(root, "notes.md"), join(root, "retargeted.md"));
    symlinkSync(join(outside, "private.md"), join(root, "outside.md"));
    fakeGeneration(alias, "gen-20261116T020000Z-link01", 1_700_000_100);
    writeFileSync(join(root, ".brain", "secret.md"), "brain secret\n");
    symlinkSync(join(root, ".brain", "secret.md"), join(root, "brain.md"));
    store = await openBrain(join(root, ".brain", "brain.sqlite"));
    const state = { pending: [], tree: { anchor: alias, depth: 1 }, collapseRequested: null, generation: "gen-link", person: "OracleToes", readOnly: false };
    const pin = createTools({ root: alias, brain: store, session: state }).find((tool) => tool.name === "pin");
    const { projectTreeBlock } = await import("../dist/runtime/project-tree.js");
    const handles = projectTreeBlock(alias, alias, 1, await store.read()).handles;
    const api = { now: Date.now };
    await pin.execute({ action: "pin", handle: handles.get(join(alias, "notes.md")) }, api, {});
    await pin.execute({ action: "pin", handle: handles.get(join(alias, "inside.md")) }, api, {});
    await pin.execute({ action: "pin", handle: handles.get(join(alias, "retargeted.md")) }, api, {});
    rmSync(join(root, "retargeted.md"));
    symlinkSync(join(outside, "private.md"), join(root, "retargeted.md"));
    assert.doesNotThrow(() => assertPinnableFile(alias, join(alias, "outside.md")), "the Tree view can pin this link too");
    await pin.execute({ action: "pin", handle: handles.get(join(alias, "outside.md")) }, api, {});
    await assert.rejects(pin.execute({ action: "pin", handle: handles.get(join(alias, "brain.md")) }, api, {}), /\.brain/);
    // A pre-existing forbidden pin is retained as stale, not read.
    await store.apply({ kind: "file.pin", path: join(alias, "brain.md"), pinned: "user" }, at(1));
    const report = await collapse(alias, store);
    const markdown = readFileSync(generationPaths(alias, report.generation).markdown, "utf8");
    assert.equal((markdown.match(/linked project markdown/g) ?? []).length, 2);
    assert.equal((markdown.match(/outside secret/g) ?? []).length, 2);
    assert.doesNotMatch(markdown, /brain secret/);
    assert.equal((markdown.match(/this file could not be read at the collapse/g) ?? []).length, 1);
    const files = (await store.read()).files;
    assert.equal(files.find((file) => file.path === join(alias, "inside.md")).stale, undefined);
    assert.equal(files.find((file) => file.path === join(alias, "outside.md")).stale, undefined);
    assert.equal(files.find((file) => file.path === join(alias, "retargeted.md")).stale, undefined);
    writeFileSync(join(outside, "private.md"), "outside updated\n");
    const next = await collapse(alias, store);
    const updated = readFileSync(generationPaths(alias, next.generation).markdown, "utf8");
    assert.equal((updated.match(/outside updated/g) ?? []).length, 2);
    assert.doesNotMatch(updated, /outside secret|brain secret/);
    rmSync(join(outside, "private.md"));
    const missing = await collapse(alias, store);
    const afterRemoval = readFileSync(generationPaths(alias, missing.generation).markdown, "utf8");
    assert.equal((afterRemoval.match(/this file could not be read at the collapse/g) ?? []).length, 3);
    assert.equal((await store.read()).files.find((file) => file.path === join(alias, "outside.md")).stale, true);
  } finally {
    await store?.close();
    rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a pinned file that is gone is carried as stale, not dropped in silence", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live012", 1_700_000_100);
    writeFileSync(join(root, "gone.md"), "here for now\n");
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    await store.apply({ kind: "file.pin", path: "gone.md", pinned: "user" }, at(1));
    rmSync(join(root, "gone.md"));

    const report = await collapse(root, store, { person: "OracleToes" });
    const brain = await store.read();
    assert.equal(brain.files[0]?.stale, true, "the pin records that the file is gone");

    const markdown = readFileSync(generationPaths(root, report.generation).markdown, "utf8");
    assert.match(markdown, /gone\.md · pinned by OracleToes · \[stale/, "the head says so where the file would be");
    assert.match(markdown, /could not be read at the collapse/, "and says what is missing rather than nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pinned read result is refreshed at the collapse, and says so when the file is gone", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "src.txt"), "the first thing\n");
    const live = fakeGeneration(root, "gen-20261116T020000Z-live013", 1_700_000_100);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    // A pinned result of a `read`, carrying the path it read (§5.5).
    await store.apply(
      {
        kind: "ephemeral.pin",
        item: {
          id: `${"gen-20261116T020000Z-live013"}:e1:r`,
          text: "the first thing\n",
          kind: "readResult",
          createdAt: at(1),
          pinned: "user",
          entity: { callId: "call-1", tool: "read", path: "src.txt" },
        },
      },
      at(1),
    );

    writeFileSync(join(root, "src.txt"), "the second thing\n");
    const report = await collapse(root, store);
    const markdown = readFileSync(generationPaths(root, report.generation).markdown, "utf8");
    assert.ok(markdown.includes("the second thing"), "the pin kept the file, not the reading");

    // The file disappears: the pin keeps the text it last had and the item is
    // still there, rather than a pin quietly vanishing (§5.5).
    rmSync(join(root, "src.txt"));
    const second = await collapse(root, store);
    const after = readFileSync(generationPaths(root, second.generation).markdown, "utf8");
    assert.ok(after.includes("the second thing"), "the last true reading survives");
    void live;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
});
