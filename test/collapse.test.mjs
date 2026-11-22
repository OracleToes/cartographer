import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyWrite } from "../dist/domain/brain.js";
import { emptyBrain } from "../dist/domain/records.js";
import { openBrain } from "../dist/runtime/brain-store.js";
import { collapse, discoverGenerations, reconcileGenerations, generationPaths } from "../dist/runtime/collapse.js";
import { writeSnapshot } from "../dist/runtime/projection-files.js";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { readGenerationEphemera } from "../dist/runtime/collapse.js";
import { projectContext } from "../dist/domain/projection.js";

const at = (n) => 1_700_000_000_000 + n * 1_000;

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "carto-collapse-"));
}

/** A fake live generation: a store file plus its frozen snapshot. */
function fakeGeneration(root, generation, mtimeSeconds) {
  const paths = generationPaths(root, generation);
  writeFileSync(paths.store, "fake store bytes");
  const brain = emptyBrain();
  writeSnapshot(root, generation, projectContext(brain), at(1));
  const when = new Date(mtimeSeconds * 1000);
  for (const path of [paths.store, paths.markdown, paths.sidecar]) utimesSync(path, when, when);
  return paths;
}

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

test("a head generation missing its snapshot never existed as frozen; it is deleted", () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T010000Z-aaaa01", 1_700_000_000);
    const paths = generationPaths(root, "gen-20261116T020000Z-crashed");
    writeFileSync(paths.store, "bytes"); // store, but no snapshot: crashed mid-creation
    utimesSync(paths.store, new Date(1_700_000_200_000), new Date(1_700_000_200_000));

    const { live, removed } = reconcileGenerations(root);
    assert.equal(live?.generation, "gen-20261116T010000Z-aaaa01");
    assert.deepEqual(removed, ["gen-20261116T020000Z-crashed"]);
    assert.equal(existsSync(paths.store), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the live generation keeps its store; older remainders are deleted", () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T010000Z-aaaa01", 1_700_000_000);
    fakeGeneration(root, "gen-20261116T020000Z-bbbb02", 1_700_000_100);
    fakeGeneration(root, "gen-20261116T030000Z-cccc03", 1_700_000_200);
    const { live, removed } = reconcileGenerations(root);
    assert.equal(live?.generation, "gen-20261116T030000Z-cccc03");
    assert.deepEqual(removed, ["gen-20261116T020000Z-bbbb02", "gen-20261116T010000Z-aaaa01"]);
    assert.equal(existsSync(generationPaths(root, "gen-20261116T010000Z-aaaa01").store), false);
    // The archive is Carto's own database, not a sealed store: nothing is left read-only.
    assert.equal(existsSync(generationPaths(root, "gen-20261116T020000Z-bbbb02").store), false);
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
    assert.match(markdown, /Ledger — what you are working on|Atlas — what you understand|\(the Brain is empty/);
    await store.close();
  } finally {
    for (const name of ["gen-20261116T020000Z-live001.sqlite", "gen-20261116T020000Z-live001.projection.md", "gen-20261116T020000Z-live001.projection.json"]) {
      try { chmodSync(join(root, ".brain", "context", name), 0o644); } catch { /* gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record marked for archive leaves the Brain and lands in the archive", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live004", 1_700_000_100);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
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

test("a record marked for delete is deleted for real at the collapse and leaves nothing behind", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live007", 1_700_000_100);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
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

test("grace is one collapse: an item swept at a collapse survives the next one and is dropped by the one after", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live005", 1_700_000_100);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    await store.apply({ kind: "chat.record", record: { id: "c1", author: "user", text: "swept once", createdAt: at(1), updatedAt: at(1) } }, at(1));
    await store.apply({ kind: "mark.set", target: "chat", id: "c1", action: "archive", author: "user" }, at(2));

    const first = await collapse(root, store);
    assert.deepEqual(first.archived, ["c1"]);
    assert.deepEqual(first.dropped, [], "nothing is dropped by the collapse that swept it");

    const second = await collapse(root, store);
    assert.deepEqual(second.dropped, [], "it lives through the collapse after the sweep");
    assert.equal((await store.readArchive()).items.length, 1);

    const third = await collapse(root, store);
    assert.equal(third.dropped.length, 1, "the collapse after that drops it");
    assert.equal((await store.readArchive()).items.length, 0);
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pinned archive item is never dropped; a restore puts it back as its type", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live006", 1_700_000_100);
    const store = await openBrain(join(root, ".brain", "brain.sqlite"));
    await store.apply({ kind: "ledger.upsert", entry: { id: "l1", kind: "note", text: "a note", status: "open", answer: null, createdAt: at(1), updatedAt: at(1) } }, at(1));
    await store.apply({ kind: "mark.set", target: "ledger", id: "l1", action: "archive", author: "agent" }, at(2));
    await collapse(root, store);
    const item = (await store.readArchive()).items[0];
    assert.ok(item !== undefined);
    await store.applyArchive({ kind: "pin", id: item.id, pinned: "user" });

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

    const report = await collapse(root, store);
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
    assert.match(markdown, /Pinned — what the person kept in front of you/);
    assert.match(markdown, /X1 \[reasoning\] this one is worth keeping/);
    assert.equal((await store.read()).ephemera.length, 1, "the pin survives the collapse it carried it through");
    await store.close();
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
    assert.equal((await store.readArchive()).items.length, 0, "it leaves the archive");
    // It went back to the live context, which the store is not: the Brain holds
    // no pin for it, because restoring does not also pin (§3.3).
    assert.equal((await store.read()).ephemera.length, 0, "restoring does not pin it into the head");
    await store.close();
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
