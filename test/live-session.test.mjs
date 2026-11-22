import assert from "node:assert/strict";
import { utimesSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { openBrain } from "../dist/runtime/brain-store.js";
import { closeLiveSession, interruptRun, openLiveSession, readTreeNext, submitInput } from "../dist/runtime/live-session.js";
import { createTools } from "../dist/runtime/tools.js";
import { STATE_BLOCK_MARKER } from "../dist/domain/state-block.js";

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
    assert.match(firstBlock.content, /since the rebuild: nothing written/);
    assert.ok(!flatten(captured[0]).includes(STATE_BLOCK_MARKER));
    // Request 2 (after the chat tool result): pending names the write by handle.
    const secondBlock = blockOf(captured[1]);
    assert.ok(secondBlock, "second request carries the block");
    assert.match(secondBlock.content, /since the rebuild:\n  C1 · said to the person/);
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

test("read feeds atlas attachments; the node carries the reference", async () => {
  const { root, brain, cleanup } = await fixture();
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("read", { path: "src/verify-me.ts", offset: 1, limit: 1 }, { id: "call-read" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("atlas", {
      title: "The answer",
      text: "The answer is 42.",
      attachments: [{ kind: "file", path: "src/verify-me.ts" }],
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
    assert.deepEqual(nodes[0].attachments, [{ kind: "file", path: "src/verify-me.ts" }]);
    assert.match(blockOf(captured[2]).content, /since the rebuild:\n  A1 · written/);
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("the tree tool ends its turn, and the host starts the next one at the new anchor", async () => {
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
    // §6.3: the tree call ends the turn, and nothing runs on after it by
    // itself — the agent does not act on the tree it had before it asked.
    assert.equal(captured.length, 1, "the tree call ended the run");
    assert.equal(session.state.treeReadNext, true, "and left the request for its next turn");

    // The host takes that request, which is the next turn: the block the agent
    // reads there is rendered at the anchor it just set.
    const next = await readTreeNext(session);
    assert.equal(next?.status, "done");
    assert.equal(captured.length, 2, "the host started exactly one more turn");
    assert.match(blockOf(captured[1]).content, /T1 tree: src \(depth 1\)/);
    assert.equal(session.state.treeReadNext, false, "and the request is spent");
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("the boundary holds: .brain is unreadable, escapes are rejected", async () => {
  const { root, brain, cleanup } = await fixture();
  const tools = createTools({ root, brain, session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", readOnly: false } });
  const api = { callId: "call-x", now: () => 1_700_000_000_000, conversationId: "c", taskId: "t", env: new NodeExecutionEnv({ cwd: root }) };
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  await assert.rejects(byName.read.execute({ path: ".brain/brain.sqlite", offset: 1, limit: 1 }, api, {}), /\.brain/);
  const edit = byName.edit.execute({ path: "../escape.txt", edits: [{ oldText: "", newText: "x" }] }, api, {});
  await assert.rejects(edit, /outside the project root/);
  const editBrain = byName.edit.execute({ path: ".brain/brain.sqlite", edits: [{ oldText: "", newText: "x" }] }, api, {});
  await assert.rejects(editBrain, /\.brain/);
  const createBrain = byName.create.execute({ path: ".brain/new.txt", content: "x" }, api, {});
  await assert.rejects(createBrain, /\.brain/);
  const tree = byName.tree.execute({ anchor: "..", depth: 1 }, api, {});
  await assert.rejects(tree, /an anchor stays inside the project root/);
  const treeGit = byName.tree.execute({ anchor: ".git", depth: 1 }, api, {});
  await assert.rejects(treeGit, /the tree does not show/);
  const validTree = await byName.tree.execute({ anchor: "src", depth: 1 }, api, {});
  assert.match(validTree.output[0].text, /^Anchored at .*, depth 1\./);
  assert.doesNotMatch(validTree.output[0].text, /\n/);
  // §6.3: tree ends the turn, so the very next thing the agent reads is the
  // block with the tree it asked for — not the tree it had before.
  assert.equal(validTree.control?.terminate, true, "the tree call ends the turn");
  await cleanup();
});

test("the file tools are the package's: read takes offset and limit", async () => {
  const { root, brain, cleanup } = await fixture();
  const tools = createTools({ root, brain, session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", readOnly: false } });
  const api = { callId: "call-whole", now: () => 1_700_000_000_000, conversationId: "c", taskId: "t", env: new NodeExecutionEnv({ cwd: root }) };
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const whole = await byName.read.execute({ path: "src/verify-me.ts" }, api, {});
  const output = whole.output.map((part) => part.text).join("");
  assert.match(output, /export const answer = 42;/);
  const limited = await byName.read.execute({ path: "src/verify-me.ts", offset: 2, limit: 1 }, api, {});
  const limitedOut = limited.output.map((part) => part.text).join("");
  assert.doesNotMatch(limitedOut, /export const answer/);
  await cleanup();
});

test("create refuses a path that exists; edit never creates", async () => {
  const { root, brain, cleanup } = await fixture();
  const tools = createTools({ root, brain, session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", readOnly: false } });
  const api = { callId: "call-create", now: () => 1_700_000_000_000, conversationId: "c", taskId: "t", env: new NodeExecutionEnv({ cwd: root }) };
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const created = await byName.create.execute({ path: "src/new-file.ts", content: "export const x = 1;\n" }, api, {});
  assert.match(created.output[0].text, /Successfully wrote/);
  await assert.rejects(byName.create.execute({ path: "src/new-file.ts", content: "replaced" }, api, {}), /already exists/);
  await assert.rejects(byName.edit.execute({ path: "src/missing.ts", edits: [{ oldText: "", newText: "x" }] }, api, {}), /not_found|not a file/i);
  await cleanup();
});

test("read only mode refuses create and edit, and the block says so", async () => {
  const { root, brain, cleanup } = await fixture();
  const session = { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", readOnly: true };
  const tools = createTools({ root, brain, session });
  const api = { callId: "call-ro", now: () => 1_700_000_000_000, conversationId: "c", taskId: "t", env: new NodeExecutionEnv({ cwd: root }) };
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  await assert.rejects(byName.create.execute({ path: "src/ro.ts", content: "x" }, api, {}), /read only mode/);
  await assert.rejects(
    byName.edit.execute({ path: "src/verify-me.ts", edits: [{ oldText: "42", newText: "43" }] }, api, {}),
    /read only mode/,
  );
  // The tools stay offered; only the call refuses.
  assert.ok(byName.create !== undefined && byName.edit !== undefined && byName.read !== undefined);
  await cleanup();
});

test("unknown handles are explicit errors, never guesses", async () => {
  const { root, brain, cleanup } = await fixture();
  const tools = createTools({ root, brain, session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", readOnly: false } });
  const api = { callId: "call-z", now: () => 1_700_000_000_000, conversationId: "c", taskId: "t" };
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  await assert.rejects(
    byName.atlas.execute({ handle: "Z9", title: "t", text: "c" }, api, {}),
    /No Atlas record here has the handle Z9/,
  );
  await assert.rejects(
    byName.pin.execute({ action: "pin", handle: "Q4" }, api, {}),
    /No Brain record here has the handle Q4/,
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
      text: "The answer is 42.",
      attachments: [{ kind: "file", path: "src/verify-me.ts" }],
    }, { id: "call-atlas" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("collapse", {}, { id: "call-collapse" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession(options());
  const previousGeneration = session.generation;
  try {
    const submission = await submitInput(session, "remember this, then reset");
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, "done", "the collapse tool ends the run; no continuation follows a terminate");
    const reason = session.takeCollapseRequest();
    assert.equal(reason, "the agent collapsed");

    const { collapseLiveSession } = await import("../dist/runtime/live-session.js");
    const outcome = await collapseLiveSession(session, options(), reason);
    assert.equal(outcome.reason, reason);
    assert.notEqual(outcome.report.generation, previousGeneration);
    assert.equal(outcome.report.swept, previousGeneration);
    assert.deepEqual(outcome.report.dropped, []);
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
    // The old store is deleted whole, not sealed (§3.4).
    const { generationPaths } = await import("../dist/runtime/collapse.js");
    const oldStore = generationPaths(root, previousGeneration).store;
    assert.equal((await import("node:fs")).existsSync(oldStore), false);
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

test("drift rides the collapse: the frozen projection carries the marks", async () => {
  const { root, brain, cleanup } = await fixture();
  const { faux, models, captured, factory, ref } = fauxSetup();
  const options = () => ({ root, brain, models, model: ref, now: () => 1_700_000_000_000 });
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("read", { path: "src/verify-me.ts", offset: 1, limit: 1 }, { id: "call-read" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("atlas", {
      title: "The answer",
      text: "The answer is 42.",
      attachments: [{ kind: "file", path: "src/verify-me.ts" }],
    }, { id: "call-atlas" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("collapse", {}, { id: "call-collapse" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession(options());
  try {
    const first = await submitInput(session, "learn this");
    await first.wait(BACKGROUND_CONTEXT);
    // The file drifts (and is touched) after the entry was written.
    const driftPath = join(root, "src", "verify-me.ts");
    writeFileSync(driftPath, "export const answer = 43;\n");
    const drift = new Date(1_700_001_000_000);
    utimesSync(driftPath, drift, drift);
    const reason = session.takeCollapseRequest();
    const { collapseLiveSession } = await import("../dist/runtime/live-session.js");
    const outcome = await collapseLiveSession(session, options(), reason ?? "person-triggered");
    const { renderLiveStateBlock } = await import("../dist/runtime/carto-extension.js");
    const block = await renderLiveStateBlock(
      { root, brain, session: outcome.session.state, markdownPath: outcome.session.markdownPath, now: () => 1_700_000_000_000 },
      [],
    );
    assert.match(block, /stale:\n  A1 · the file changed after this note/);
    const fresh = outcome.session;
    faux.setResponses([factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-sleep-3" })], { stopReason: "toolUse" }))]);
    const again = await submitInput(fresh, "and now?");
    await again.wait(BACKGROUND_CONTEXT);
    assert.match(blockOf(captured.at(-1)).content, /stale:\n  A1 · the file changed after this note/);
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
  assert.equal(outcome.report.swept, previousGeneration);
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

test("the tree is addressable: a directory handle anchors it, a file handle does not", async () => {
  const { root, brain, cleanup } = await fixture();
  const session = { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", readOnly: false };
  const tools = createTools({ root, brain, session });
  const api = { callId: "call-t", now: () => 1_700_000_000_000, conversationId: "c", taskId: "t", env: new NodeExecutionEnv({ cwd: root }) };
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  try {
    // Which handle is the directory, and which the file, is the tree's business:
    // ask it, rather than hard-coding a number the rendering decides (§5.4).
    const { projectTreeBlock } = await import("../dist/runtime/project-tree.js");
    const block = projectTreeBlock(root, root, 2, await brain.read());
    const dirHandle = [...block.handles].find(([path]) => path.endsWith("src"))?.[1];
    const fileHandle = [...block.handles].find(([path]) => /\.(ts|md|json)$/.test(path))?.[1];
    assert.ok(dirHandle !== undefined && fileHandle !== undefined, "the tree handed out both kinds");

    const moved = await byName.tree.execute({ handle: dirHandle }, api, {});
    assert.equal(moved.control?.terminate, true, "and it ends the turn like any other tree call");
    assert.ok(session.tree.anchor.endsWith("src"), "the tree anchored where the directory is");

    await assert.rejects(byName.tree.execute({ handle: fileHandle }, api, {}), /not a directory/);
  } finally {
    await cleanup();
  }
});

test("no product tool carries a bound its own description does not state", async () => {
  const { root, brain, cleanup } = await fixture();
  try {
    const tools = createTools({
      root,
      brain,
      session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", readOnly: false },
    });
    const BOUND_KEYS = ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"];
    const boundsOf = (schema, path, found = []) => {
      if (schema === null || typeof schema !== "object") return found;
      for (const [key, value] of Object.entries(schema)) {
        if (BOUND_KEYS.includes(key) && value !== undefined) found.push({ path, key, value });
        boundsOf(value, `${path}.${key}`, found);
      }
      return found;
    };

    // §1: a bound is part of how a tool works and is said so in that tool's own
    // description and nowhere else. So any bound left on a parameter has to be
    // a number the description states — and an empty string is not a length.
    for (const tool of tools) {
      for (const bound of boundsOf(tool.parameters, tool.name)) {
        assert.notEqual(bound.value, 0, `${tool.name}${bound.path} carries a ${bound.key} of 0, which asks nothing and only constrains`);
        assert.ok(
          (tool.description ?? "").includes(String(bound.value)),
          `${tool.name}${bound.path} carries ${bound.key}=${bound.value}, and its description does not state it`,
        );
      }
    }
  } finally {
    await cleanup();
  }
});
