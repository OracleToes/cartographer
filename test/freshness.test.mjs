import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyWrite } from "../dist/domain/brain.js";
import { freshnessMarks } from "../dist/domain/freshness.js";
import { emptyBrain } from "../dist/domain/records.js";
import { openBrain } from "../dist/runtime/brain-store.js";
import { refreshFreshness } from "../dist/runtime/collapse.js";

const at = (n) => 1_700_000_000_000 + n * 1_000;
const digestOf = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("a matching digest marks fresh, a mismatch or a missing file marks stale", () => {
  const directory = mkdtempSync(join(tmpdir(), "carto-digest-"));
  try {
    const file = join(directory, "cited.md");
    writeFileSync(file, "the evidence");
    const digest = digestOf(file);
    let brain = emptyBrain();
    brain = applyWrite(brain, { kind: "atlas.upsert", node: { id: "a1", title: "t", claim: "c", evidence: [{ kind: "file", path: file, startLine: 1, endLine: 1, digest, excerpt: "e", freshness: "unknown" }], edges: [], createdAt: at(1), updatedAt: at(1) } }, at(1));

    assert.equal(freshnessMarks(brain, (p) => (p === file ? digest : null)).marks[0].freshness, "fresh");
    assert.equal(freshnessMarks(brain, (p) => (p === file ? "deadbeef" : null)).marks[0].freshness, "stale");
    assert.equal(freshnessMarks(brain, () => null).marks[0].freshness, "stale");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a refresh at rebuild flips changed evidence to stale and keeps handles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "carto-brain-"));
  try {
    const cited = join(directory, "cited.md");
    writeFileSync(cited, "content");
    const store = openBrain(join(directory, "brain.sqlite"));
    store.apply({ kind: "atlas.upsert", node: { id: "a1", title: "t", claim: "c", evidence: [{ kind: "file", path: cited, startLine: 1, endLine: 1, digest: "not-the-digest", excerpt: "e", freshness: "unknown" }], edges: [], createdAt: at(1), updatedAt: at(1) } }, at(1));

    const handleBefore = store.read().handles.entries.find((entry) => entry.id === "a1")?.handle;
    const refreshed = await refreshFreshness(directory, store.read(), store.apply.bind(store), at(2));
    assert.equal(refreshed.atlas[0].evidence[0].freshness, "stale");
    assert.equal(refreshed.handles.entries.find((entry) => entry.id === "a1")?.handle, handleBefore);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("context-kind references keep their freshness; they verify by hand", () => {
  let brain = emptyBrain();
  brain = applyWrite(brain, { kind: "atlas.upsert", node: { id: "a1", title: "t", claim: "c", evidence: [{ kind: "context", contextId: "gen", excerpt: "e", freshness: "stale" }], edges: [], createdAt: at(1), updatedAt: at(1) } }, at(1));
  assert.equal(freshnessMarks(brain, () => null).marks.length, 0);
});
