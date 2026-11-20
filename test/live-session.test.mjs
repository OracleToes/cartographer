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
import { closeLiveSession, interruptRun, openLiveSession, submitInput } from "../dist/runtime/live-session.js";
import { createTools } from "../dist/runtime/tools.js";
import { STATE_BLOCK_MARKER } from "../dist/domain/state-block.js";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "carto-live-"));
  mkdirSync(join(root, ".brain"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "verify-me.ts"), "export const answer = 42;\n");
  const brain = await openBrain(join(root, ".brain", "brain.sqlite"));
  return { root, brain, cleanup: async () => { await brain.close(); rmSync(root, { recursive: true, force: true }); } };
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
  const { root, brain, cleanup } = await fixture();
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

    const records = (await brain.read()).chat;
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
    await cleanup();
  }
});

test("the continuation loop: a text-only answer is continued with a marker, stripped on the next request", async () => {
  const { root, brain, cleanup } = await fixture();
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
    await cleanup();
  }
});

test("inspect feeds atlas evidence; the digest verifies end to end", async () => {
  const { root, brain, cleanup } = await fixture();
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
    const nodes = (await brain.read()).atlas;
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].evidence[0].digest, fileDigest);
    assert.equal(nodes[0].evidence[0].freshness, "fresh");
    assert.match(blockOf(captured[2]).content, /pending:\n  A1 · atlas create/);
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("the tree tool moves the anchor and the block renders it there", async () => {
  const { root, brain, cleanup } = await fixture();
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
    await cleanup();
  }
});

test("the boundary holds: .brain is unreadable, escapes are rejected", async () => {
  const { root, brain, cleanup } = await fixture();
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
  await cleanup();
});

test("inspect reports .brain access as an explicit failure", async () => {
  const { root, brain, cleanup } = await fixture();
  const tools = createTools({ root, brain, session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test" } });
  const api = { callId: "call-y", now: () => 1_700_000_000_000, conversationId: "c", taskId: "t" };
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  await assert.rejects(byName.inspect.execute({ path: ".brain/brain.sqlite", startLine: 1, endLine: 1 }, api, {}), /\.brain/);
  const range = await byName.inspect.execute({ path: "src/verify-me.ts", startLine: 1, endLine: 1 }, api, {});
  const output = range.output.map((part) => part.text).join("");
  assert.match(output, /digest: [0-9a-f]{64}/);
  assert.match(output, /src\/verify-me\.ts:1-1 \(of 2 lines\)/);
  await cleanup();
});

test("unknown handles are explicit errors, never guesses", async () => {
  const { root, brain, cleanup } = await fixture();
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
  await cleanup();
});

test("an agent-triggered collapse: the run ends, the ceremony runs, the fresh context carries the Brain", async () => {
  const { root, brain, cleanup } = await fixture();
  const { faux, models, captured, factory, ref } = fauxSetup();
  const options = () => ({ root, brain, models, model: ref, now: () => 1_700_000_000_000 });
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("atlas", {
      title: "The answer",
      claim: "The answer is 42.",
      evidence: [{ path: "src/verify-me.ts", startLine: 1, endLine: 1, digest: sha256(readFileSync(join(root, "src", "verify-me.ts"))), excerpt: "export const answer = 42;" }],
    }, { id: "call-atlas" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("collapse", { reason: "the map and the books diverged" }, { id: "call-collapse" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession(options());
  const previousGeneration = session.generation;
  try {
    const submission = await submitInput(session, "remember this, then reset");
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, "done", "the collapse tool ends the run; no continuation follows a terminate");
    assert.equal(session.state.collapseRequested, "the map and the books diverged");
    const reason = session.takeCollapseRequest();
    assert.equal(reason, "the map and the books diverged");

    const { collapseLiveSession } = await import("../dist/runtime/live-session.js");
    const outcome = await collapseLiveSession(session, options(), reason);
    assert.equal(outcome.reason, reason);
    assert.notEqual(outcome.report.generation, previousGeneration);
    assert.equal(outcome.report.sealed, previousGeneration);
    assert.equal(outcome.report.purged, undefined);
    // The Brain survived; handles were rebuilt, not carried over.
    const nodes = (await brain.read()).atlas;
    assert.equal(nodes.length, 1);
    const { handleOf } = await import("../dist/domain/handles.js");
    assert.equal(handleOf((await brain.read()).handles, "atlas", nodes[0].id), "A1");
    // The fresh session starts empty and its tree wiring is the root again.
    assert.deepEqual(outcome.session.state.pending, []);
    assert.equal(outcome.session.state.tree.anchor, realpathSync(root));
    assert.equal(outcome.session.markdownPath.includes(outcome.report.generation), true);
    assert.equal(readFileSync(outcome.session.markdownPath, "utf8").includes("A1 The answer"), true);
    // The old store is sealed read-only.
    const { generationPaths } = await import("../dist/runtime/collapse.js");
    const oldStore = generationPaths(root, previousGeneration).store;
    assert.equal((await import("node:fs")).statSync(oldStore).mode & 0o444, 0o444);
    // The fresh session is functional.
    faux.setResponses([factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-sleep-2" })], { stopReason: "toolUse" }))]);
    const second = await submitInput(outcome.session, "still here?");
    const secondSettled = await second.wait(BACKGROUND_CONTEXT);
    assert.equal(secondSettled.status, "done");
    assert.equal(captured.length, 3, "one request per scripted response, across the collapse");
    await closeLiveSession(outcome.session);
  } finally {
    await closeLiveSession(session).catch(() => undefined);
    await cleanup();
  }
});

test("stale evidence rides the collapse: the frozen projection carries the marks", async () => {
  const { root, brain, cleanup } = await fixture();
  const { faux, models, captured, factory, ref } = fauxSetup();
  const options = () => ({ root, brain, models, model: ref, now: () => 1_700_000_000_000 });
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("inspect", { path: "src/verify-me.ts", startLine: 1, endLine: 1 }, { id: "call-inspect" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("atlas", {
      title: "The answer",
      claim: "The answer is 42.",
      evidence: [{ path: "src/verify-me.ts", startLine: 1, endLine: 1, digest: sha256(readFileSync(join(root, "src", "verify-me.ts"))), excerpt: "export const answer = 42;" }],
    }, { id: "call-atlas" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("collapse", { reason: "rebuild" }, { id: "call-collapse" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession(options());
  try {
    const first = await submitInput(session, "learn this");
    await first.wait(BACKGROUND_CONTEXT);
    // The evidence file drifts after the claim was written.
    writeFileSync(join(root, "src", "verify-me.ts"), "export const answer = 43;\n");
    const reason = session.takeCollapseRequest();
    const { collapseLiveSession } = await import("../dist/runtime/live-session.js");
    const outcome = await collapseLiveSession(session, options(), reason ?? "person-triggered");
    const { renderLiveStateBlock } = await import("../dist/runtime/carto-extension.js");
    const block = await renderLiveStateBlock(
      { root, brain, session: outcome.session.state, markdownPath: outcome.session.markdownPath, now: () => 1_700_000_000_000 },
      [],
    );
    assert.match(block, /stale:\n  A1 \(evidence changed\)/);
    const fresh = outcome.session;
    faux.setResponses([factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-sleep-3" })], { stopReason: "toolUse" }))]);
    const again = await submitInput(fresh, "and now?");
    await again.wait(BACKGROUND_CONTEXT);
    assert.match(blockOf(captured.at(-1)).content, /stale:\n  A1 \(evidence changed\)/);
    await closeLiveSession(fresh);
  } finally {
    await closeLiveSession(session).catch(() => undefined);
    await cleanup();
  }
});

test("a person-triggered collapse with no run in flight: interrupt is a no-op and the rebuild happens", async () => {
  const { root, brain, cleanup } = await fixture();
  const { faux, models, ref } = fauxSetup();
  const options = () => ({ root, brain, models, model: ref, now: () => 1_700_000_000_000 });
  void faux;
  const session = await openLiveSession(options());
  const previousGeneration = session.generation;
  const { collapseLiveSession } = await import("../dist/runtime/live-session.js");
  const outcome = await collapseLiveSession(session, options(), "person pressed collapse");
  assert.equal(outcome.report.sealed, previousGeneration);
  assert.notEqual(outcome.session.generation, previousGeneration);
  assert.deepEqual(outcome.session.state.pending, []);
  await closeLiveSession(outcome.session);
  await cleanup();
});

test("the bash tool runs through the conversation's environment: a real command, real stdout", async () => {
  const { root, brain, cleanup } = await fixture();
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("bash", { command: "printf carto-bash-ok" }, { id: "call-bash-1" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-bash-sleep" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref, now: () => 1_700_000_000_000 });
  try {
    const submission = await submitInput(session, "run a command");
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, "done");
    const flat = flatten(captured.at(-1));
    assert.match(flat, /carto-bash-ok/, "the tool result carries the command's stdout");
  } finally {
    await closeLiveSession(session).catch(() => undefined);
    await cleanup();
  }
});

test("interrupting a run whose bash call is open settles the run instead of orphaning the command", async () => {
  const { root, brain, cleanup } = await fixture();
  const { faux, models, factory, ref } = fauxSetup();
  // bash sleeps 30s; the interrupt must cut the run at its boundary instead.
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" }, { id: "call-bash-interrupt" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref, now: () => 1_700_000_000_000 });
  const started = Date.now();
  try {
    const submission = await submitInput(session, "wait on something long");
    // Give the bash task a moment to actually start, then interrupt.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    await interruptRun(session);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.notEqual(settled.status, "running");
    assert.ok(Date.now() - started < 20_000, "the interrupt cut the run; it did not wait out the sleep");
  } finally {
    await closeLiveSession(session).catch(() => undefined);
    await cleanup();
  }
});
