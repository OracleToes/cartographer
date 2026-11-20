import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CartoProject } from "../dist/runtime/project.js";

const config = { version: 1, model: "openai/gpt-4.1-mini" };

test("a collapse seals the previous store as the archive and rotates the live generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-project-"));
  const project = await CartoProject.open(root, config);
  try {
    const first = await project.view();
    assert.equal(first.archivePresent, false);
    const firstGeneration = project.liveGeneration;

    await project.collapse();
    const second = await project.view();
    assert.notEqual(project.liveGeneration, firstGeneration);
    assert.equal(second.archivePresent, true);

    const files = await readdir(join(root, ".brain", "context"));
    assert.equal(files.filter((name) => name.endsWith(".sqlite")).length, 2);
    // The archive is sealed read-only; the live store is not.
    const { mode } = await import("node:fs/promises").then(({ stat }) => stat(join(root, ".brain", "context", `${firstGeneration}.sqlite`)));
    assert.equal(mode & 0o222, 0);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a collapse keeps the Brain and renumbers handles from 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-collapse-handles-"));
  const project = await CartoProject.open(root, config);
  try {
    await project.upsertLedger({ id: "ledger:keep", kind: "goal", status: "open", text: "Keep this goal", answer: null });
    await project.collapse();
    const view = await project.view();
    assert.equal(view.brain.ledger.length, 1);
    assert.deepEqual(
      view.context.blocks.filter((block) => block.section === "ledger").map((block) => block.handle),
      ["L1"],
    );
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a llama-swap model opens and rotates durable local sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-llama-swap-project-"));
  const project = await CartoProject.open(root, {
    version: 1,
    model: "llama-swap/Flint",
    llamaSwapEndpoint: "http://localhost:8888/v1",
  });
  try {
    const before = project.liveGeneration;
    await project.collapse();
    assert.notEqual(project.liveGeneration, before);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("opening a project removes an orphaned context SQLite sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-orphan-context-sidecar-"));
  const context = join(root, ".brain", "context");
  const orphan = "00000000-0000-4000-8000-000000000000";
  const project = await CartoProject.open(root, config);
  try {
    await writeFile(join(context, `${orphan}.sqlite-wal`), "orphan", "utf8");
    await project.close();
    const reopened = await CartoProject.open(root, config);
    try {
      const files = await readdir(context);
      assert.equal(files.includes(`${orphan}.sqlite-wal`), false);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing live store rebuilds from the Brain instead of failing", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-missing-live-context-"));
  const first = await CartoProject.open(root, config);
  await first.upsertLedger({ id: "ledger:keep", kind: "goal", status: "open", text: "Survives the file loss", answer: null });
  const generation = first.liveGeneration;
  await first.close();
  await rm(join(root, ".brain", "context", `${generation}.sqlite`));

  const reopened = await CartoProject.open(root, config);
  try {
    const view = await reopened.view();
    assert.equal(view.brain.ledger.length, 1);
    assert.notEqual(reopened.liveGeneration, generation);
  } finally {
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("opening a project purges context stores beyond the live one and its archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-beyond-grace-"));
  const context = join(root, ".brain", "context");
  const project = await CartoProject.open(root, config);
  const live = project.liveGeneration;
  await project.close();
  // Two older generations from crashes, both beyond one collapse of grace.
  const { utimes, writeFile } = await import("node:fs/promises");
  const staleA = "00000000-0000-4000-8000-00000000000a";
  const staleB = "00000000-0000-4000-8000-00000000000b";
  await writeFile(join(context, `${staleA}.sqlite`), "", "utf8");
  await writeFile(join(context, `${staleB}.sqlite`), "", "utf8");
  await utimes(join(context, `${staleA}.sqlite`), new Date(1_000_000_000_000), new Date(1_000_000_000_000));
  await utimes(join(context, `${staleB}.sqlite`), new Date(1_500_000_000_000), new Date(1_500_000_000_000));

  const reopened = await CartoProject.open(root, config);
  try {
    const files = await readdir(context);
    assert.equal(files.includes(`${live}.sqlite`), true);
    // Only the two newest survive; one of the stale pair, or the live one,
    // is kept as the potential archive. The other is gone.
    assert.equal(files.filter((name) => name.endsWith(".sqlite")).length, 2);
  } finally {
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a project restart reopens its current live generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-restart-project-"));
  const first = await CartoProject.open(root, config);
  const generation = first.liveGeneration;
  await first.close();

  const reopened = await CartoProject.open(root, config);
  try {
    assert.equal(reopened.liveGeneration, generation);
    assert.equal((await reopened.view()).archivePresent, false);
  } finally {
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a carry pin persists across a restart and reaches the projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-reopen-carry-project-"));
  const first = await CartoProject.open(root, config);
  try {
    await first.brainStore.apply({
      kind: "pin.carry.add",
      pin: {
        id: "carry:restart",
        item: "Keep this selected context item.",
        reason: "It must survive the restart.",
        source: { kind: "context", contextId: first.liveGeneration, excerpt: "Exact selected text.", freshness: "fresh" },
        createdAt: Date.now(),
      },
    });
  } finally {
    await first.close();
  }

  const reopened = await CartoProject.open(root, config);
  try {
    const view = await reopened.view();
    assert.deepEqual(view.brain.carryPins.map((pin) => pin.id), ["carry:restart"]);
    assert.ok(view.context.blocks.some((block) => block.id === "carry-pin:carry:restart" && block.text.includes("Exact selected text.")));
  } finally {
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the next collapse removes the older archive and keeps its Pins", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-retention-project-"));
  const project = await CartoProject.open(root, config);
  try {
    const firstLive = project.liveGeneration;

    await project.collapse();
    const secondLive = project.liveGeneration;
    assert.notEqual(secondLive, firstLive);
    await project.addUserContextPin("Keep this item", "The person pinned it.");

    await project.collapse();
    assert.notEqual(project.liveGeneration, secondLive);
    assert.equal((await project.view()).brain.userPins.length, 1);

    const files = await readdir(join(root, ".brain", "context"));
    assert.ok(!files.includes(`${firstLive}.sqlite`));
    assert.equal(files.filter((name) => name.endsWith(".sqlite")).length, 2);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a carry pin is a Brain record: it survives collapses until explicitly removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-carry-project-"));
  const project = await CartoProject.open(root, config);
  try {
    await project.brainStore.apply({
      kind: "pin.carry.add",
      pin: {
        id: "carry:keep",
        item: "Selected context item",
        reason: "It is needed until further notice.",
        source: { kind: "context", contextId: project.liveGeneration, excerpt: "Keep this selected context item.", freshness: "fresh" },
        createdAt: Date.now(),
      },
    });

    await project.collapse();
    await project.collapse();
    const view = await project.view();
    assert.equal(view.brain.carryPins.length, 1);
    assert.ok(view.context.blocks.some((block) => block.id === "carry-pin:carry:keep"));
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("changed file evidence becomes stale before the next context projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-freshness-project-"));
  await writeFile(join(root, "evidence.txt"), "first fact\n", "utf8");
  const project = await CartoProject.open(root, config);
  try {
    await project.addUserFilePin("First fact", "Keep this evidence.", "evidence.txt", 1, 1);
    await writeFile(join(root, "evidence.txt"), "revised fact\n", "utf8");
    await project.refreshEvidence();
    const view = await project.view();
    assert.equal(view.brain.userPins[0]?.source.freshness, "stale");
    assert.ok(view.context.blocks.some((block) => block.text.includes("Stale pin")));
    assert.ok(!view.context.blocks.some((block) => block.text.includes("first fact")));
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delete is a single step and does not touch the live context", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-delete-now-project-"));
  const project = await CartoProject.open(root, config);
  try {
    await project.brainStore.apply({
      kind: "chat.record",
      record: { id: "chat:remove", author: "agent", text: "Remove this.", createdAt: 1, updatedAt: 1 },
    });
    await project.collapse();
    const secondLive = project.liveGeneration;
    const archived = (await readdir(join(root, ".brain", "context"))).filter((name) => name.endsWith(".sqlite")).length;
    assert.equal(archived, 2);

    await project.deleteNow("chat", "chat:remove");
    const after = await project.view();

    assert.equal(project.liveGeneration, secondLive);
    assert.equal(after.brain.chat.some((entry) => entry.id === "chat:remove"), false);
    // The frozen projection still names the record until the next collapse.
    const files = await readdir(join(root, ".brain", "context"));
    assert.equal(files.filter((name) => name.endsWith(".sqlite")).length, 2);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the person can edit deliberate Agent Chat before a later context projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-edit-agent-chat-"));
  const project = await CartoProject.open(root, config);
  try {
    await project.addAgentChat("First corrective instruction.");
    const chat = (await project.view()).brain.chat[0];
    assert.ok(chat);
    await project.editChat(chat.id, "Corrected steering instruction.");
    const after = await project.view();
    assert.equal(after.brain.chat[0]?.author, "agent");
    assert.equal(after.brain.chat[0]?.text, "Corrected steering instruction.");
    assert.ok(after.brain.chat[0].updatedAt >= after.brain.chat[0].createdAt);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a pin is removed in one step, selected by its short handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-pin-handle-project-"));
  const project = await CartoProject.open(root, config);
  try {
    await project.addUserContextPin("Pinned item", "Keep this for now.");
    const before = await project.view();
    const handle = before.brain.handles.entries.find((entry) => entry.kind === "pin")?.handle;
    assert.equal(handle, "P1");
    const liveBefore = project.liveGeneration;

    await project.removePinHandleNow("p1");
    const after = await project.view();
    assert.equal(after.brain.userPins.length, 0);
    assert.equal(project.liveGeneration, liveBefore);
    assert.equal(after.brain.handles.entries.filter((entry) => entry.kind === "pin").length, 0);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("short handles are durable across a project restart and unchanged by edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-handle-restart-"));
  let project = await CartoProject.open(root, config);
  let handle;
  try {
    await project.upsertLedger({ id: "ledger:one", kind: "goal", status: "open", text: "First goal", answer: null });
    await project.upsertLedger({ id: "ledger:two", kind: "note", status: "open", text: "Second note", answer: null });
    const before = await project.view();
    handle = before.brain.handles.entries.find((entry) => entry.kind === "ledger")?.handle;
    assert.equal(handle, "L1");
    assert.deepEqual(
      before.context.blocks.filter((block) => block.section === "ledger").map((block) => block.handle),
      ["L1", "L2"],
    );
  } finally {
    await project.close();
  }

  project = await CartoProject.open(root, config);
  try {
    const reopened = await project.view();
    assert.equal(reopened.brain.handles.entries.find((entry) => entry.id === "ledger:one")?.handle, "L1");
    await project.upsertLedger({ id: "ledger:one", kind: "goal", status: "open", text: "First goal, edited", answer: null });
    const edited = await project.view();
    assert.deepEqual(
      edited.context.blocks.filter((block) => block.section === "ledger").map((block) => block.handle),
      ["L1", "L2"],
    );
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a carry pin refresh marks a changed file source stale, and survives a reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-carry-stale-"));
  const text = "original carry source\n";
  await writeFile(join(root, "carry.txt"), text, "utf8");
  const project = await CartoProject.open(root, config);
  try {
    await project.brainStore.apply({
      kind: "pin.carry.add",
      pin: {
        id: "carry:test",
        item: "Original carry fact",
        reason: "Keep it.",
        source: {
          kind: "file",
          path: "carry.txt",
          startLine: 1,
          endLine: 1,
          digest: createHash("sha256").update(text).digest("hex"),
          excerpt: text.trim(),
          freshness: "fresh",
        },
        createdAt: Date.now(),
      },
    });
    await writeFile(join(root, "carry.txt"), "revised carry source\n", "utf8");
    await project.refreshEvidence();
    assert.equal((await project.view()).brain.carryPins[0]?.source.freshness, "stale");
  } finally {
    await project.close();
  }

  const reopened = await CartoProject.open(root, config);
  try {
    assert.equal((await reopened.view()).brain.carryPins[0]?.source.freshness, "stale");
  } finally {
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the projection snapshot is written once per generation, sealed with it, and purged with it", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-projection-snapshot-"));
  const context = join(root, ".brain", "context");
  const project = await CartoProject.open(root, config);
  const generation = project.liveGeneration;
  const md = join(context, `${generation}.projection.md`);
  try {
    const frozen = await readFile(md, "utf8");
    assert.match(frozen, /^# Carto context/);

    // A Brain write never touches the frozen snapshot.
    await project.upsertLedger({ id: "ledger:keep", kind: "goal", status: "open", text: "Survives the freeze", answer: null });
    assert.equal(await readFile(md, "utf8"), frozen);

    await project.collapse();
    const firstMode = (await stat(md)).mode;
    assert.equal(firstMode & 0o222, 0, "the archived snapshot is sealed read-only");

    // The rebuilt projection carries the record the freeze was protecting.
    const rebuilt = await readFile(join(context, `${project.liveGeneration}.projection.md`), "utf8");
    assert.match(rebuilt, /Survives the freeze/);

    // The next collapse purges the generation that had its one collapse of grace, snapshots included.
    await project.collapse();
    await assert.rejects(stat(md), /ENOENT/);
    await assert.rejects(stat(join(context, `${generation}.projection.json`)), /ENOENT/);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pending writes are named by handle and cleared at collapse", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-pending-writes-"));
  const project = await CartoProject.open(root, config);
  try {
    await project.upsertLedger({ id: "ledger:one", kind: "goal", status: "open", text: "Track this goal", answer: null });
    assert.deepEqual(project.pendingState.writes, [{ handle: "L1", kind: "ledger", deleted: false }]);

    await project.collapse();
    assert.deepEqual(project.pendingState.writes, []);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});
