import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectContext } from "../dist/domain/context.js";
import { BrainStore } from "../dist/runtime/brain-store.js";
import { importLegacyBrain, readLegacyBrain } from "../dist/runtime/legacy-import.js";

test("the optional legacy importer copies plain Atlas and Ledger records without trusting old evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-legacy-import-"));
  const directory = join(root, ".brain");
  await mkdir(directory);
  await writeFile(
    join(directory, "carto-ledger.json"),
    JSON.stringify({
      version: 1,
      items: [
        { id: "g1", kind: "goal", text: "Keep Mini small", status: "open", added: "2025-01-01T00:00:00.000Z" },
        { id: "n2", kind: "note", text: "An old decision", status: "done", outcome: "It was accepted." },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(directory, "carto-atlas.json"),
    JSON.stringify({
      version: 1,
      nodes: [
        { id: "c1", name: "Runtime layout", gist: "The old runtime had many parts.", links: ["project_notes"] },
        { id: "c2", name: "Project notes", gist: "The old Atlas had project notes." },
      ],
    }),
    "utf8",
  );

  const legacy = await readLegacyBrain(root, 1_700_000_000_000);
  const store = await BrainStore.open(join(directory, "brain.sqlite"));
  try {
    const first = await importLegacyBrain(store, legacy);
    const second = await importLegacyBrain(store, legacy);
    const brain = await store.read();

    assert.deepEqual(first, second);
    assert.equal(brain.ledger.length, 2);
    assert.equal(brain.atlas.length, 2);
    assert.equal(brain.ledger.find((entry) => entry.text === "An old decision")?.status, "closed");
    assert.equal(brain.ledger.find((entry) => entry.text === "An old decision")?.answer?.text, "It was accepted.");
    assert.equal(brain.atlas[0]?.evidence[0]?.freshness, "stale");
    assert.ok(brain.atlas[0]?.links.includes(brain.atlas[1]?.id));

    const plan = projectContext(brain, { budget: 10_000 });
    assert.ok(!plan.blocks.some((block) => block.text.includes("The old runtime had many parts.")));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
