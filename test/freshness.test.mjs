import "./agent-reminder.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyWrite } from "../dist/domain/brain.js";
import { staleAtlasNodeIds } from "../dist/domain/freshness.js";
import { emptyBrain } from "../dist/domain/records.js";
import { openBrain } from "../dist/runtime/brain-store.js";
import { refreshFreshness } from "../dist/runtime/collapse.js";
import { checkEvidenceFiles, observeEvidenceFiles } from "../dist/runtime/evidence-files.js";

const at = (n) => 1_700_000_000_000 + n * 1_000;

test("scoped evidence checks contents and resolved targets without claiming conformance", () => {
  const directory = mkdtempSync(join(tmpdir(), "carto-evidence-"));
  try {
    const source = join(directory, "source.ts");
    const second = join(directory, "second.ts");
    const alias = join(directory, "alias.ts");
    writeFileSync(source, "first");
    writeFileSync(second, "first");
    symlinkSync(source, alias);
    utimesSync(source, new Date(at(1)), new Date(at(1)));
    const saved = observeEvidenceFiles(directory, ["source.ts", "alias.ts"], "strict");
    assert.equal(checkEvidenceFiles(directory, saved, "strict").status, "current-for-listed-inputs");
    writeFileSync(source, "other");
    utimesSync(source, new Date(at(1)), new Date(at(1)));
    assert.deepEqual(checkEvidenceFiles(directory, saved, "strict").files.map((item) => item.status), ["changed", "changed"]);
    writeFileSync(source, "first");
    unlinkSync(alias);
    symlinkSync(second, alias);
    const changedTarget = checkEvidenceFiles(directory, saved, "strict");
    assert.equal(changedTarget.status, "stale");
    assert.deepEqual(changedTarget.files.map((item) => item.status), ["current", "changed"]);
    unlinkSync(source);
    const missing = checkEvidenceFiles(directory, saved, "strict");
    assert.equal(missing.status, "stale");
    assert.deepEqual(missing.files.map((item) => item.status), ["unknown", "changed"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("missing, invalid, inaccessible and incomplete file evidence never becomes current", () => {
  const directory = mkdtempSync(join(tmpdir(), "carto-evidence-"));
  const outside = mkdtempSync(join(tmpdir(), "carto-outside-"));
  try {
    mkdirSync(join(directory, ".brain"));
    writeFileSync(join(directory, ".brain", "secret"), "secret");
    writeFileSync(join(outside, "external"), "external");
    symlinkSync(join(outside, "external"), join(directory, "link"));
    const unavailable = observeEvidenceFiles(directory, ["missing", ".brain/secret", ".", "link"], "strict");
    assert.ok(unavailable.files.every((item) => "unavailable" in item));
    assert.equal(checkEvidenceFiles(directory, unavailable, "strict").status, "unknown");
    const relaxed = observeEvidenceFiles(directory, ["link"], "relaxed");
    assert.equal(checkEvidenceFiles(directory, relaxed, "relaxed").status, "current-for-listed-inputs");
    assert.equal(checkEvidenceFiles(directory, relaxed, "strict").status, "unknown");
    assert.equal(checkEvidenceFiles(directory, observeEvidenceFiles(directory, [], "strict"), "strict").status, "unknown");
    assert.equal(checkEvidenceFiles(directory, { version: 1, scope: "strict", files: [{ path: "x", resolved: "/x", sha256: "fake" }] }, "strict").status, "unknown");
    assert.equal(checkEvidenceFiles(directory, { ...relaxed, files: [relaxed.files[0], relaxed.files[0]] }, "relaxed").status, "unknown");
    const disappeared = observeEvidenceFiles(directory, ["link"], "relaxed");
    unlinkSync(join(outside, "external"));
    assert.equal(checkEvidenceFiles(directory, disappeared, "relaxed").status, "unknown");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("attachment drift: a file newer than the entry was written is stale; an older one is fresh; a missing one is stale", () => {
  const directory = mkdtempSync(join(tmpdir(), "carto-freshness-"));
  try {
    const file = join(directory, "cited.md");
    writeFileSync(file, "content");
    let brain = emptyBrain();
    brain = applyWrite(brain, {
      kind: "atlas.upsert",
      node: { id: "a1", title: "t", text: "c", links: [], attachments: [{ kind: "file", path: file }], createdAt: at(1), updatedAt: at(1) },
    }, at(1));

    // Fresh: file written before the node was written.
    utimesSync(file, new Date(at(1) - 10_000), new Date(at(1) - 10_000));
    assert.deepEqual(staleAtlasNodeIds(brain, (p) => (p === file ? at(1) - 10_000 : null)), []);

    // Stale: file newer than the node.
    utimesSync(file, new Date(at(1) + 10_000), new Date(at(1) + 10_000));
    assert.deepEqual(staleAtlasNodeIds(brain, (p) => (p === file ? at(1) + 10_000 : null)), ["a1"]);

    // Stale: file missing — mtime null.
    assert.deepEqual(staleAtlasNodeIds(brain, () => null), ["a1"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("non-file attachments carry no signal and are never checked", () => {
  let brain = emptyBrain();
  brain = applyWrite(brain, {
    kind: "atlas.upsert",
    node: {
      id: "a1",
      title: "t",
      text: "c",
      links: [],
      attachments: [{ kind: "record", id: "l1" }],
      createdAt: at(1),
      updatedAt: at(1),
    },
  }, at(1));
  assert.deepEqual(staleAtlasNodeIds(brain, () => null), []);
});

test("a refresh at rebuild marks drifted nodes stale and clears fresh ones; handles survive", async () => {
  const directory = mkdtempSync(join(tmpdir(), "carto-brain-"));
  try {
    const cited = join(directory, "cited.md");
    writeFileSync(cited, "content");
    utimesSync(cited, new Date(at(1) - 10_000), new Date(at(1) - 10_000));
    const store = await openBrain(join(directory, "brain.sqlite"));
    const finalized = await store.apply(
      {
        kind: "atlas.upsert",
        node: { id: "a1", title: "t", text: "c", links: [], attachments: [{ kind: "file", path: cited }], createdAt: at(1), updatedAt: at(1) },
      },
      at(1),
    );
    const handleBefore = (await store.read()).handles.entries.find((entry) => entry.id === "a1")?.handle;

    // The file drifts after the entry was written.
    writeFileSync(cited, "newer content");
    utimesSync(cited, new Date(at(2)), new Date(at(2)));

    const refreshed = await refreshFreshness(directory, await store.read(), store.apply.bind(store), at(2));
    assert.equal(refreshed.atlas[0].stale, true);
    assert.equal(refreshed.handles.entries.find((entry) => entry.id === "a1")?.handle, handleBefore);

    // An update re-asserts the entry and clears the stale marker.
    await store.apply({ kind: "atlas.stale", id: "a1", stale: true }, at(3));
    const updated = await store.apply(
      { kind: "atlas.upsert", node: { id: "a1", title: "t", text: "c", links: [], attachments: [{ kind: "file", path: cited }], createdAt: at(1), updatedAt: at(4) } },
      at(4),
    );
    assert.equal(updated.atlas[0].stale, undefined);
    await store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
