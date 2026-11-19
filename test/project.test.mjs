import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CartoProject } from "../dist/runtime/project.js";

const config = { version: 1, model: "openai/gpt-4.1-mini", collapseMode: "request" };

test("a project rotates one live context into one archive on confirmed collapse", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-project-"));
  const project = await CartoProject.open(root, config);
  try {
    const first = await project.view();
    assert.ok(first.brain.context.liveGeneration);
    assert.equal(first.brain.context.archiveGeneration, null);

    await project.requestCollapse();
    assert.equal((await project.view()).brain.activity.kind, "waiting-for-collapse");

    await project.confirmCollapse();
    const second = await project.view();
    assert.ok(second.brain.context.liveGeneration);
    assert.notEqual(second.brain.context.liveGeneration, first.brain.context.liveGeneration);
    assert.equal(second.brain.context.archiveGeneration, first.brain.context.liveGeneration);
    assert.equal(second.brain.activity.kind, "idle");

    const files = await readdir(join(root, ".brain", "context"));
    assert.equal(files.filter((name) => name.endsWith(".sqlite")).length, 2);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("agent collapse mode rotates without a person confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-agent-collapse-"));
  const project = await CartoProject.open(root, { ...config, collapseMode: "agent" });
  try {
    const before = await project.view();
    await project.requestCollapse("The agent needs a new live context.");
    const after = await project.view();
    assert.notEqual(after.brain.context.liveGeneration, before.brain.context.liveGeneration);
    assert.equal(after.brain.context.archiveGeneration, before.brain.context.liveGeneration);
    assert.equal(after.brain.activity.kind, "idle");
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
    collapseMode: "agent",
  });
  try {
    const before = await project.view();
    await project.requestCollapse("Rotate the local model session.");
    const after = await project.view();
    assert.notEqual(after.brain.context.liveGeneration, before.brain.context.liveGeneration);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a pending requested collapse blocks new messages until the person confirms or cancels it", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-collapse-request-"));
  const project = await CartoProject.open(root, config);
  try {
    await project.requestCollapse();
    await assert.rejects(() => project.sendUserMessage("Continue working."), /Confirm or cancel/);
    await project.cancelCollapse();
    assert.equal((await project.view()).brain.activity.kind, "idle");
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

test("a project restart refuses to replace a missing referenced live context", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-missing-live-context-"));
  const first = await CartoProject.open(root, config);
  const generation = (await first.view()).brain.context.liveGeneration;
  await first.close();
  await rm(join(root, ".brain", "context", `${generation}.sqlite`));

  try {
    await assert.rejects(() => CartoProject.open(root, config), /referenced live context is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project restart reopens its current live generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-restart-project-"));
  const first = await CartoProject.open(root, config);
  const generation = (await first.view()).brain.context.liveGeneration;
  await first.close();

  const reopened = await CartoProject.open(root, config);
  try {
    const view = await reopened.view();
    assert.equal(view.brain.context.liveGeneration, generation);
    assert.equal(view.brain.context.archiveGeneration, null);
  } finally {
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a project restart retains the carry selection of its current live generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-reopen-carry-project-"));
  const first = await CartoProject.open(root, config);
  try {
    const contextId = (await first.view()).brain.context.liveGeneration;
    await first.brainStore.apply({
      kind: "pin.carry.add",
      pin: {
        id: "carry:restart",
        item: "Keep this selected context item.",
        reason: "It must survive the restart.",
        source: { kind: "context", contextId, excerpt: "Exact selected text.", freshness: "fresh" },
        createdAt: Date.now(),
      },
    });
    await first.requestCollapse();
    await first.confirmCollapse();
  } finally {
    await first.close();
  }

  const reopened = await CartoProject.open(root, config);
  try {
    const view = await reopened.view();
    assert.deepEqual(view.liveCarryPins.map((pin) => pin.id), ["carry:restart"]);
    assert.ok(view.context.blocks.some((block) => block.id === "carry-pin:carry:restart" && block.text.includes("Exact selected text.")));
  } finally {
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the next confirmed collapse removes the older archive and keeps a user archive pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-retention-project-"));
  const project = await CartoProject.open(root, config);
  try {
    const initial = await project.view();
    const firstLive = initial.brain.context.liveGeneration;
    assert.ok(firstLive);

    await project.requestCollapse();
    await project.confirmCollapse();
    const afterFirst = await project.view();
    const secondLive = afterFirst.brain.context.liveGeneration;
    assert.equal(afterFirst.brain.context.archiveGeneration, firstLive);
    await project.addUserContextPin("Keep this archive item", "The person selected it before expiry.");

    await project.requestCollapse();
    await project.confirmCollapse();
    const afterSecond = await project.view();
    assert.equal(afterSecond.brain.context.archiveGeneration, secondLive);
    assert.notEqual(afterSecond.brain.context.liveGeneration, secondLive);
    assert.equal(afterSecond.brain.userPins.length, 1);

    const files = await readdir(join(root, ".brain", "context"));
    assert.ok(!files.includes(`${firstLive}.sqlite`));
    assert.equal(files.filter((name) => name.endsWith(".sqlite")).length, 2);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a carry pin is selected into one new live generation only", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-carry-project-"));
  const project = await CartoProject.open(root, config);
  try {
    const source = {
      kind: "context",
      contextId: (await project.view()).brain.context.liveGeneration,
      excerpt: "Keep this selected context item.",
      freshness: "fresh",
    };
    await project.brainStore.apply({
      kind: "pin.carry.add",
      pin: {
        id: "carry:one-cycle",
        item: "Selected context item",
        reason: "It is needed in the next live generation.",
        source,
        createdAt: Date.now(),
      },
    });

    await project.requestCollapse();
    await project.confirmCollapse();
    const first = await project.view();
    assert.equal(first.brain.carryPins.length, 0);
    assert.deepEqual(first.liveCarryPins.map((pin) => pin.id), ["carry:one-cycle"]);
    assert.ok(first.context.blocks.some((block) => block.id === "carry-pin:carry:one-cycle"));

    await project.requestCollapse();
    await project.confirmCollapse();
    const second = await project.view();
    assert.deepEqual(second.liveCarryPins, []);
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an approved patch applies only after its stored approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-patch-project-"));
  await writeFile(join(root, "note.txt"), "before\n", "utf8");
  const project = await CartoProject.open(root, config);
  try {
    const base = createHash("sha256").update("before\n").digest("hex");
    const patch = [
      "diff --git a/note.txt b/note.txt",
      "index 3e17f77..9c39ca6 100644",
      "--- a/note.txt",
      "+++ b/note.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    await project.recordChangeProposal({
      id: "change:test",
      rationale: "Update the note.",
      patch,
      base: [{ path: "note.txt", digest: base }],
      status: "proposed",
      createdAt: Date.now(),
      resolvedAt: null,
    });
    assert.equal(await readFile(join(root, "note.txt"), "utf8"), "before\n");

    await project.approveChange("change:test");
    assert.equal(await readFile(join(root, "note.txt"), "utf8"), "after\n");
    assert.equal((await project.view()).brain.changes[0]?.status, "applied");
  } finally {
    await project.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an approved patch becomes conflicted when its saved base changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-conflict-project-"));
  await writeFile(join(root, "note.txt"), "before\n", "utf8");
  const project = await CartoProject.open(root, config);
  try {
    const base = createHash("sha256").update("before\n").digest("hex");
    const patch = [
      "diff --git a/note.txt b/note.txt",
      "index 3e17f77..9c39ca6 100644",
      "--- a/note.txt",
      "+++ b/note.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    await project.recordChangeProposal({
      id: "change:conflict",
      rationale: "Update the note.",
      patch,
      base: [{ path: "note.txt", digest: base }],
      status: "proposed",
      createdAt: Date.now(),
      resolvedAt: null,
    });
    await writeFile(join(root, "note.txt"), "changed elsewhere\n", "utf8");

    await project.approveChange("change:conflict");

    assert.equal(await readFile(join(root, "note.txt"), "utf8"), "changed elsewhere\n");
    assert.equal((await project.view()).brain.changes[0]?.status, "conflicted");
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

test("Delete now starts a fresh context and discards old live and archive files", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-delete-now-project-"));
  const project = await CartoProject.open(root, config);
  try {
    await project.brainStore.apply({
      kind: "chat.record",
      record: { id: "chat:remove", author: "agent", text: "Remove this now.", createdAt: 1, updatedAt: 1 },
    });
    const first = await project.view();
    const firstLive = first.brain.context.liveGeneration;
    await project.requestCollapse();
    await project.confirmCollapse();
    const second = await project.view();
    const secondLive = second.brain.context.liveGeneration;
    assert.equal(second.brain.context.archiveGeneration, firstLive);

    await project.deleteNow("chat", "chat:remove");
    const after = await project.view();
    const files = await readdir(join(root, ".brain", "context"));

    assert.notEqual(after.brain.context.liveGeneration, secondLive);
    assert.equal(after.brain.context.archiveGeneration, null);
    assert.equal(after.brain.chat.some((entry) => entry.id === "chat:remove"), false);
    assert.equal(files.includes(`${firstLive}.sqlite`), false);
    assert.equal(files.includes(`${secondLive}.sqlite`), false);
    assert.equal(files.filter((name) => name.endsWith(".sqlite")).length, 1);
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

test("a pin removal handle defers to collapse and Remove now restarts the live context", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-pin-handle-project-"));
  const project = await CartoProject.open(root, config);
  try {
    await project.addUserContextPin("Pinned item", "Keep this for now.");
    const before = await project.view();
    const pin = before.brain.userPins[0];
    assert.ok(pin);
    const handle = before.brain.handles.entries.find((entry) => entry.kind === "pin")?.handle;
    assert.equal(handle, "P1");

    await project.removePinHandleAtCollapse("p1");
    const marked = await project.view();
    assert.equal(marked.brain.userPins.length, 1);
    assert.equal(marked.brain.deletionMarks.length, 1);
    assert.equal(marked.context.blocks.some((block) => block.section === "pin"), false);

    await project.requestCollapse();
    await project.confirmCollapse();
    assert.equal((await project.view()).brain.userPins.length, 0);

    await project.addUserContextPin("Second pin", "Remove it now.");
    const liveBefore = (await project.view()).brain.context.liveGeneration;
    const secondHandle = (await project.view()).brain.handles.entries.find((entry) => entry.kind === "pin")?.handle;
    assert.equal(secondHandle, "P1");
    await project.removePinHandleNow("P1");
    const after = await project.view();
    assert.equal(after.brain.userPins.length, 0);
    assert.notEqual(after.brain.context.liveGeneration, liveBefore);
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
