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

    const { live, archive, removed } = reconcileGenerations(root);
    assert.equal(live?.generation, "gen-20261116T010000Z-aaaa01");
    assert.equal(archive, null);
    assert.deepEqual(removed, ["gen-20261116T020000Z-crashed"]);
    assert.equal(existsSync(paths.store), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("at most one sealed generation survives; older remainders are purged", () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T010000Z-aaaa01", 1_700_000_000);
    fakeGeneration(root, "gen-20261116T020000Z-bbbb02", 1_700_000_100);
    fakeGeneration(root, "gen-20261116T030000Z-cccc03", 1_700_000_200);
    const { live, archive, removed } = reconcileGenerations(root);
    assert.equal(live?.generation, "gen-20261116T030000Z-cccc03");
    assert.equal(archive?.generation, "gen-20261116T020000Z-bbbb02");
    assert.deepEqual(removed, ["gen-20261116T010000Z-aaaa01"]);
    assert.equal(existsSync(generationPaths(root, "gen-20261116T010000Z-aaaa01").store), false);
    // The archive is sealed read-only.
    assert.equal((statSync(generationPaths(root, "gen-20261116T020000Z-bbbb02").store).mode & 0o222) === 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collapse seals the live store, creates the new generation, and purges the expired archive after exports", async () => {
  const root = tempRoot();
  try {
    const live = fakeGeneration(root, "gen-20261116T020000Z-live001", 1_700_000_100);
    const archive = fakeGeneration(root, "gen-20261116T010000Z-gone999", 1_700_000_000);
    const store = openBrain(join(root, ".brain", "brain.sqlite"));
    store.apply({ kind: "chat.record", record: { id: "c1", author: "user", text: "before collapse", createdAt: at(1), updatedAt: at(1) } }, at(1));

    const log = [];
    const report = await collapse(root, store, {
      exportPinnedArchiveRecords: (generation, brainStore) => {
        // The export must see the archive's files still present.
        log.push([generation, existsSync(archive.store), brainStore.read().chat.length]);
      },
    });

    assert.equal(report.sealed, "gen-20261116T020000Z-live001");
    assert.equal(report.purged, "gen-20261116T010000Z-gone999");
    assert.equal(existsSync(archive.store), false);
    assert.equal(existsSync(archive.markdown), false);
    assert.equal(existsSync(archive.sidecar), false);
    assert.deepEqual(log, [["gen-20261116T010000Z-gone999", true, 1]]);
    // The old live store is sealed read-only.
    assert.equal((statSync(live.store).mode & 0o222) === 0, true);
    // The new generation exists with a snapshot and carries the Brain's content.
    assert.notEqual(report.generation, report.sealed);
    const newPaths = generationPaths(root, report.generation);
    assert.equal(existsSync(newPaths.markdown), true);
    const markdown = readFileSync(newPaths.markdown, "utf8");
    assert.match(markdown, /Ledger|Atlas|Pins|Wakes|\(the Brain is empty\)/);
    store.close();
  } finally {
    chmodSync(join(root, ".brain", "context", "gen-20261116T020000Z-live001.sqlite"), 0o644);
    chmodSync(join(root, ".brain", "context", "gen-20261116T020000Z-live001.projection.md"), 0o644);
    chmodSync(join(root, ".brain", "context", "gen-20261116T020000Z-live001.projection.json"), 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the frozen snapshot is byte-stable and sealed with its store at collapse", async () => {
  const root = tempRoot();
  try {
    fakeGeneration(root, "gen-20261116T020000Z-live002", 1_700_000_100);
    const store = openBrain(join(root, ".brain", "brain.sqlite"));
    const report = await collapse(root, store);
    chmodSync(join(root, ".brain", "context", `${report.sealed}.sqlite`), 0o644);
    chmodSync(join(root, ".brain", "context", `${report.sealed}.projection.md`), 0o644);
    chmodSync(join(root, ".brain", "context", `${report.sealed}.projection.json`), 0o644);
    const first = readFileSync(join(root, ".brain", "context", `${report.generation}.projection.md`), "utf8");
    // A second collapse creates a new generation; the first snapshot must not move.
    const second = await collapse(root, store);
    const again = readFileSync(join(root, ".brain", "context", `${report.generation}.projection.md`), "utf8");
    assert.equal(again, first);
    assert.notEqual(second.generation, report.generation);
    store.close();
  } finally {
    for (const name of ["gen-20261116T020000Z-live002.sqlite", "gen-20261116T020000Z-live002.projection.md", "gen-20261116T020000Z-live002.projection.json"]) {
      try { chmodSync(join(root, ".brain", "context", name), 0o644); } catch { /* sealed already or gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
