import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

import { BrainStore } from "../dist/runtime/brain-store.js";
import { LiveSession } from "../dist/runtime/live-session.js";

test("a Pi model tool call writes deliberate Chat while plain output stays out of Chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-model-tool-"));
  const brain = await BrainStore.open(join(root, ".brain", "brain.sqlite"));
  const models = createModels();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("chat", { text: "A deliberate Carto reply." }),
        fauxToolCall("pin", {
          action: "add",
          item: "Selected working-context item",
          reason: "Carry it once.",
          source: { kind: "context", excerpt: "Selected working-context item" },
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Temporary plain model output."),
  ]);
  const session = await LiveSession.open({
    path: join(root, ".brain", "context", "live.sqlite"),
    model: { provider: "faux", modelId: "faux-1" },
    projectRoot: root,
    brain,
    models,
  });
  try {
    await session.submit("Please respond.", "test-request");
    const current = await brain.read();
    assert.deepEqual(current.chat.map((entry) => [entry.author, entry.text]), [["agent", "A deliberate Carto reply."]]);
    assert.equal(current.carryPins[0]?.source.kind, "context");
    assert.equal(current.carryPins[0]?.item, "Selected working-context item");
    assert.equal(faux.state.callCount, 2);
  } finally {
    await session.close();
    await brain.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Carto tools use public handles and never expose private record IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-handle-tools-"));
  const brain = await BrainStore.open(join(root, ".brain", "brain.sqlite"));
  await brain.apply({
    kind: "ledger.upsert",
    entry: { id: "ledger:private", kind: "goal", text: "Original goal", status: "open", answer: null, createdAt: 1, updatedAt: 1 },
  });
  const models = createModels();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("ledger", { handle: "L1", kind: "goal", text: "Edited from a handle", status: "open" }),
        fauxToolCall("pin", {
          action: "add",
          item: "Handle test pin",
          reason: "Check P1",
          source: { kind: "context", excerpt: "Handle test pin" },
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  const session = await LiveSession.open({
    path: join(root, ".brain", "context", "live.sqlite"),
    model: { provider: "faux", modelId: "faux-1" },
    projectRoot: root,
    brain,
    models,
  });
  try {
    await session.submit("Edit L1 and add a pin.", "handle-request");
    const current = await brain.read();
    assert.equal(current.ledger.length, 1);
    assert.equal(current.ledger[0]?.id, "ledger:private");
    assert.equal(current.ledger[0]?.text, "Edited from a handle");
    assert.equal(current.handles.entries.find((entry) => entry.kind === "ledger")?.handle, "L1");
    assert.equal(current.carryPins.length, 1);
    const entries = (await session.view()).activity.map((item) => item.text).join("\n");
    assert.doesNotMatch(entries, /ledger:private|carry:/);
    assert.match(entries, /L1/);
  } finally {
    await session.close();
    await brain.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("idle start work creates no Person Chat record", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-idle-start-"));
  const brain = await BrainStore.open(join(root, ".brain", "brain.sqlite"));
  const models = createModels();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("The agent started useful work.")]);
  const session = await LiveSession.open({
    path: join(root, ".brain", "context", "live.sqlite"),
    model: { provider: "faux", modelId: "faux-1" },
    projectRoot: root,
    brain,
    models,
  });
  try {
    await session.continueOrStart("idle-start");
    assert.equal((await brain.read()).chat.length, 0);
    assert.equal(faux.state.callCount, 1);
    assert.ok((await session.view()).activity.some((item) => item.text.includes("started useful work")));
  } finally {
    await session.close();
    await brain.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Pi Durable time wake survives as a durable task and delivers its Brain state", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-wake-"));
  const brain = await BrainStore.open(join(root, ".brain", "brain.sqlite"));
  const wakeId = "wake:test";
  const until = Date.now() - 1_000;
  await brain.apply({
    kind: "wake.upsert",
    wake: {
      id: wakeId,
      kind: "time",
      condition: String(until),
      status: "armed",
      reason: "test durable delivery",
      createdAt: Date.now(),
    },
  });
  const session = await openSession(root, brain);
  try {
    await session.ensureTimeWake(wakeId, until);
    await eventually(async () => (await brain.read()).wakes.find((wake) => wake.id === wakeId)?.status === "ready");
    assert.equal((await brain.read()).activity.kind, "woken");
  } finally {
    await session.close();
    await brain.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Pi Durable path wake resumes from a project path fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-path-wake-"));
  await writeFile(join(root, "watched.txt"), "before\n", "utf8");
  const brain = await BrainStore.open(join(root, ".brain", "brain.sqlite"));
  const wakeId = "wake:path";
  await brain.apply({
    kind: "wake.upsert",
    wake: {
      id: wakeId,
      kind: "path",
      condition: "watched.txt",
      status: "armed",
      reason: "test path wake",
      createdAt: Date.now(),
    },
  });
  let session = await openSession(root, brain);
  try {
    await session.ensurePathWake(wakeId, "watched.txt");
    await session.close();
    session = await openSession(root, brain);
    await writeFile(join(root, "watched.txt"), "after\n", "utf8");
    await eventually(async () => (await brain.read()).wakes.find((wake) => wake.id === wakeId)?.status === "ready", 4_000);
  } finally {
    await session.close();
    await brain.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Pi Durable folder wake detects a direct child file change", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-folder-wake-"));
  await mkdir(join(root, "watched"));
  await writeFile(join(root, "watched", "child.txt"), "before\n", "utf8");
  const brain = await BrainStore.open(join(root, ".brain", "brain.sqlite"));
  const wakeId = "wake:folder";
  await brain.apply({
    kind: "wake.upsert",
    wake: {
      id: wakeId,
      kind: "path",
      condition: "watched",
      status: "armed",
      reason: "test folder wake",
      createdAt: Date.now(),
    },
  });
  const session = await openSession(root, brain);
  try {
    await session.ensurePathWake(wakeId, "watched");
    await writeFile(join(root, "watched", "child.txt"), "after\n", "utf8");
    await eventually(async () => (await brain.read()).wakes.find((wake) => wake.id === wakeId)?.status === "ready", 4_000);
  } finally {
    await session.close();
    await brain.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a project-root path wake ignores Carto Brain files but sees direct project entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-root-wake-"));
  const brain = await BrainStore.open(join(root, ".brain", "brain.sqlite"));
  const wakeId = "wake:root";
  await brain.apply({
    kind: "wake.upsert",
    wake: {
      id: wakeId,
      kind: "path",
      condition: ".",
      status: "armed",
      reason: "watch the project root",
      createdAt: Date.now(),
    },
  });
  const session = await openSession(root, brain);
  try {
    await session.ensurePathWake(wakeId, ".");
    await writeFile(join(root, ".brain", "ignored.txt"), "Carto data\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    assert.equal((await brain.read()).wakes.find((wake) => wake.id === wakeId)?.status, "armed");

    await writeFile(join(root, "project-file.txt"), "project data\n", "utf8");
    await eventually(async () => (await brain.read()).wakes.find((wake) => wake.id === wakeId)?.status === "ready", 4_000);
  } finally {
    await session.close();
    await brain.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("selected carry pins stay with one live generation and become stale when their file changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-carry-"));
  const text = "original carry source\n";
  await writeFile(join(root, "carry.txt"), text, "utf8");
  const brain = await BrainStore.open(join(root, ".brain", "brain.sqlite"));
  const pin = {
    id: "carry:test",
    item: "Original carry fact",
    reason: "Keep it for the next generation.",
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
  };
  let session = await LiveSession.open({
    path: join(root, ".brain", "context", "live.sqlite"),
    model: { provider: "openai", modelId: "gpt-4.1-mini" },
    projectRoot: root,
    brain,
    initialCarryPins: [pin],
  });
  try {
    assert.equal((await session.liveCarryPins())[0]?.id, pin.id);
    await writeFile(join(root, "carry.txt"), "revised carry source\n", "utf8");
    await session.refreshCarryPins();
    assert.equal((await session.liveCarryPins())[0]?.source.freshness, "stale");

    await session.close();
    session = await openSession(root, brain);
    assert.equal((await session.liveCarryPins())[0]?.source.freshness, "stale");
  } finally {
    await session.close();
    await brain.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function openSession(root, brain) {
  return LiveSession.open({
    path: join(root, ".brain", "context", "live.sqlite"),
    model: { provider: "openai", modelId: "gpt-4.1-mini" },
    projectRoot: root,
    brain,
  });
}

async function eventually(check, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for the durable wake.");
}
