import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { openBrain } from "../dist/runtime/brain-store.js";
import { closeLiveSession, openLiveSession, submitInput } from "../dist/runtime/live-session.js";
import { createTools } from "../dist/runtime/tools.js";
import { STATE_BLOCK_MARKER } from "../dist/domain/state-block.js";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "carto-live-"));
  mkdirSync(join(root, ".brain"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "verify-me.ts"), "export const answer = 42;\n");
  const brain = openBrain(join(root, ".brain", "brain.sqlite"));
  return { root, brain, cleanup: () => { brain.close(); rmSync(root, { recursive: true, force: true }); } };
};
const fauxSetup = () => {
  const faux = fauxProvider({ provider: "faux-test", models: [{ id: "faux-model", contextWindow: 100_000 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const captured = [];
  const factory = (build) => (context) => {
    captured.push(structuredClone(context.messages));
    return build(context);
  };
  return { faux, models, captured, factory, ref: { provider: "faux-test", modelId: "faux-model" } };
};

const blockOf = (messages) => messages.find((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("<carto-state>"));
const flatten = (messages) => JSON.stringify(messages);

test("a full turn: chat tool writes the Brain, pending lists it, the block is trailing and marker-free", async () => {
  const { root, brain, cleanup } = fixture();
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("chat", { text: "hello person" }, { id: "call-1" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-2" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref, now: () => 1_700_000_000_000 });
  try {
    const submission = await submitInput(session, "say hi");
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, "done");

    const records = brain.read().chat;
    assert.equal(records.length, 1);
    assert.equal(records[0].text, "hello person");
    assert.equal(records[0].author, "agent");
    assert.deepEqual(session.state.pending, [{ kind: "chat", action: "record", id: "chat:call-1" }]);

    assert.equal(captured.length, 2);
    // Request 1: the block is the trailing user message; nothing pending yet.
    const firstBlock = blockOf(captured[0]);
    assert.ok(firstBlock, "first request carries the block");
    assert.equal(captured[0].at(-1), firstBlock);
    assert.match(firstBlock.content, /pending: none/);
    assert.ok(!flatten(captured[0]).includes(STATE_BLOCK_MARKER));
    // Request 2 (after the chat tool result): pending names the write by handle.
    const secondBlock = blockOf(captured[1]);
    assert.ok(secondBlock, "second request carries the block");
    assert.match(secondBlock.content, /pending:\n  C1 · chat record/);
    // Exactly one block at the tail; the transcript itself never accumulates blocks.
    assert.equal(captured[1].filter((message) => typeof message.content === "string" && message.content.includes("<carto-state>")).length, 1);
    assert.ok(!flatten(captured[1]).includes(STATE_BLOCK_MARKER), "marker never reaches the provider");
  } finally {
    await closeLiveSession(session);
    cleanup();
  }
});

test("the continuation loop: a text-only answer is continued with a marker, stripped on the next request", async () => {
  const { root, brain, cleanup } = fixture();
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxText("first pass, no tools")], {}, )),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-sleep" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref, now: () => 1_700_000_000_000 });
  try {
    const submission = await submitInput(session, "think out loud");
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, "done");
    assert.equal(captured.length, 2, "the text-only answer triggered exactly one continuation");
    // The continuation request carries the block, no marker anywhere.
    const continuationBlock = blockOf(captured[1]);
    assert.ok(continuationBlock);
    assert.ok(!flatten(captured[1]).includes(STATE_BLOCK_MARKER));
    // The transcript holds the marker, not the block: the store keeps markers only.
    const transcript = await session.conversation.context(BACKGROUND_CONTEXT);
    const raw = JSON.stringify(transcript.entries);
    assert.ok(raw.includes(STATE_BLOCK_MARKER), "the store kept the byte-sized marker");
    assert.ok(!raw.includes("<carto-state>\\ncontext:"), "the store never held the block");
  } finally {
    await closeLiveSession(session);
    cleanup();
  }
});

test("inspect feeds atlas evidence; the digest verifies end to end", async () => {
  const { root, brain, cleanup } = fixture();
  const { faux, models, captured, factory, ref } = fauxSetup();
  const fileDigest = sha256(readFileSync(join(root, "src", "verify-me.ts")));
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("inspect", { path: "src/verify-me.ts", startLine: 1, endLine: 1 }, { id: "call-inspect" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("atlas", {
      title: "The answer",
      claim: "The answer is 42.",
      evidence: [{ path: "src/verify-me.ts", startLine: 1, endLine: 1, digest: fileDigest, excerpt: "export const answer = 42;" }],
    }, { id: "call-atlas" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-sleep" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref, now: () => 1_700_000_000_000 });
  try {
    const submission = await submitInput(session, "remember this fact");
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, "done");
    const nodes = brain.read().atlas;
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].evidence[0].digest, fileDigest);
    assert.equal(nodes[0].evidence[0].freshness, "fresh");
    assert.match(blockOf(captured[2]).content, /pending:\n  A1 · atlas create/);
  } finally {
    await closeLiveSession(session);
    cleanup();
  }
});

test("the tree tool moves the anchor and the block renders it there", async () => {
  const { root, brain, cleanup } = fixture();
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("tree", { anchor: "src", depth: 1 }, { id: "call-tree" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-sleep" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref, now: () => 1_700_000_000_000 });
  try {
    const submission = await submitInput(session, "look at src");
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, "done");
    assert.equal(session.state.tree.anchor, join(realpathSync(root), "src"));
    assert.equal(session.state.tree.depth, 1);
    assert.match(blockOf(captured[1]).content, new RegExp(`tree: ${join(realpathSync(root), "src").replace(/[/\\]/g, "\\$&")} \\(depth 1\\)`));
  } finally {
    await closeLiveSession(session);
    cleanup();
  }
});

test("the boundary holds: .brain is unreadable, escapes are rejected", async () => {
  const { root, brain, cleanup } = fixture();
  const tools = createTools({ root, brain, session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test" } });
  const api = { callId: "call-x", now: () => 1_700_000_000_000, conversationId: "c", taskId: "t" };
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  await assert.rejects(byName.inspect.execute({ path: ".brain/brain.sqlite", startLine: 1, endLine: 1 }, api, {}), /\.brain/);
  const edit = byName.edit.execute({ path: "../escape.txt", oldText: "", newText: "x" }, api, {});
  await assert.rejects(edit, /outside the project root/);
  const editBrain = byName.edit.execute({ path: ".brain/brain.sqlite", oldText: "", newText: "x" }, api, {});
  await assert.rejects(editBrain, /\.brain/);
  const tree = byName.tree.execute({ anchor: "..", depth: 1 }, api, {});
  await assert.rejects(tree, /anchor escapes/);
  cleanup();
});

test("inspect reports .brain access as an explicit failure", async () => {
  const { root, brain, cleanup } = fixture();
  const tools = createTools({ root, brain, session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test" } });
  const api = { callId: "call-y", now: () => 1_700_000_000_000, conversationId: "c", taskId: "t" };
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  await assert.rejects(byName.inspect.execute({ path: ".brain/brain.sqlite", startLine: 1, endLine: 1 }, api, {}), /\.brain/);
  const range = await byName.inspect.execute({ path: "src/verify-me.ts", startLine: 1, endLine: 1 }, api, {});
  const output = range.output.map((part) => part.text).join("");
  assert.match(output, /digest: [0-9a-f]{64}/);
  assert.match(output, /src\/verify-me\.ts:1-1 \(of 2 lines\)/);
  cleanup();
});

test("unknown handles are explicit errors, never guesses", async () => {
  const { root, brain, cleanup } = fixture();
  const tools = createTools({ root, brain, session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test" } });
  const api = { callId: "call-z", now: () => 1_700_000_000_000, conversationId: "c", taskId: "t" };
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const goodDigest = sha256(readFileSync(join(root, "src", "verify-me.ts")));
  await assert.rejects(
    byName.atlas.execute({ handle: "Z9", title: "t", claim: "c", evidence: [{ path: "src/verify-me.ts", startLine: 1, endLine: 1, digest: goodDigest, excerpt: "export const answer = 42;" }] }, api, {}),
    /does not name/,
  );
  await assert.rejects(
    byName.pin.execute({ action: "remove", handle: "Q4" }, api, {}),
    /does not name/,
  );
  cleanup();
});
