import "./agent-reminder.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyWrite } from "../dist/domain/brain.js";
import { staleAtlasNodeIds } from "../dist/domain/freshness.js";
import { emptyBrain } from "../dist/domain/records.js";
import { openBrain } from "../dist/runtime/brain-store.js";
import { refreshFreshness } from "../dist/runtime/collapse.js";

const at = (n) => 1_700_000_000_000 + n * 1_000;

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
