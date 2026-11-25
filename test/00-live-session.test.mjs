import "./agent-reminder.mjs";
import assert from "node:assert/strict";
import { existsSync, utimesSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { openBrain } from "../dist/runtime/brain-store.js";
import { handleOf } from "../dist/domain/handles.js";
import {
  applyOmitNow,
  applyRecordActionNow,
  closeLiveSession,
  interruptRun,
  openLiveSession,
  restoreEphemeral,
  sessionTranscript,
  setProjectModes,
  submitInput,
  togglePause,
  waitForRunEnd,
} from "../dist/runtime/live-session.js";
import { configuredModels } from "../dist/runtime/llama-swap-model.js";
import { ephemeralItemId, generationPaths, readGenerationEphemera } from "../dist/runtime/collapse.js";
import { createTools } from "../dist/runtime/tools.js";
import { STATE_BLOCK_MARKER } from "../dist/domain/state-block.js";

const fixture = async ({ inMemoryBrain = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "carto-live-"));
  mkdirSync(join(root, ".brain"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "verify-me.ts"), "export const answer = 42;\n");
  const brain = await openBrain(inMemoryBrain ? ":memory:" : join(root, ".brain", "brain.sqlite"));
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

// Every case owns its own temp project, Brain, harness and faux provider.
// Running the independent cases concurrently avoids a long serial tail.
test.describe("live session", { concurrency: 4 }, () => {
test("a new generation reads existing file pins rather than reporting them unreadable", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const { models, ref } = fauxSetup();
  const outside = mkdtempSync(join(tmpdir(), "carto-pin-outside-"));
  writeFileSync(join(root, "notes.md"), "a readable markdown pin\n");
  writeFileSync(join(outside, "external.md"), "a readable external pin\n");
  symlinkSync(join(outside, "external.md"), join(root, "external.md"));
  await brain.apply({ kind: "file.pin", path: join(root, "notes.md"), pinned: "user" }, Date.now());
  await brain.apply({ kind: "file.pin", path: join(root, "external.md"), pinned: "user" }, Date.now());
  let session;
  try {
    session = await openLiveSession({ root, brain, models, model: ref, person: "OracleToes" });
    const snapshot = readFileSync(session.markdownPath, "utf8");
    assert.match(snapshot, /a readable markdown pin/);
    assert.match(snapshot, /a readable external pin/);
    assert.doesNotMatch(snapshot, /could not be read/);
  } finally {
    if (session) await closeLiveSession(session);
    await cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the continuation loop: a text-only answer is continued with a marker, stripped on the next request", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxText("first pass, no tools")], {}, )),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-sleep" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref, person: "OracleToes", now: () => 1_700_000_000_000 });
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

test("a turn records chat, reads, and writes Atlas with marker-free trailing state", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([
      fauxToolCall("read", { path: "src/verify-me.ts", offset: 1, limit: 1 }, { id: "call-read" }),
      fauxToolCall("chat", { text: "hello person" }, { id: "call-1" }),
      fauxToolCall("atlas", {
        title: "The answer",
        text: "The answer is 42.",
        attachments: [{ kind: "file", path: "src/verify-me.ts" }],
      }, { id: "call-atlas" }),
    ], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-sleep" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref, person: "OracleToes", now: () => 1_700_000_000_000 });
  try {
    const submission = await submitInput(session, "remember this fact");
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, "done");
    const current = await brain.read();
    assert.equal(current.atlas.length, 1);
    assert.deepEqual(current.atlas[0].attachments, [{ kind: "file", path: "src/verify-me.ts" }]);
    // The person's words are Chat, recorded as they were sent (§2.3), then the agent's.
    assert.deepEqual(current.chat.map((record) => [record.author, record.text]), [
      ["user", "remember this fact"],
      ["agent", "hello person"],
    ]);
    assert.ok(session.state.pending.some((item) => item.kind === "chat" && item.action === "record" && item.id === "chat:call-1"));
    assert.equal(captured.length, 2);
    const firstBlock = blockOf(captured[0]);
    assert.ok(firstBlock);
    assert.equal(captured[0].at(-1), firstBlock);
    assert.match(firstBlock.content, /since the rebuild: nothing written/);
    assert.ok(!flatten(captured[0]).includes(STATE_BLOCK_MARKER));
    const secondBlock = blockOf(captured[1]);
    assert.ok(secondBlock);
    assert.match(flatten(captured[1]), /export const answer = 42/);
    assert.match(secondBlock.content, /since the rebuild:/);
    assert.match(secondBlock.content, /C2 · said to OracleToes/);
    assert.equal(captured[1].filter((message) => typeof message.content === "string" && message.content.includes("<carto-state>")).length, 1);
    assert.ok(!flatten(captured[1]).includes(STATE_BLOCK_MARKER));
    assert.match(secondBlock.content, /A1 · written/);
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("the agent pins live ephemera by visible handles and carries them across collapse", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([
      fauxThinking("a useful thought"), fauxText("a useful note"),
      fauxToolCall("read", { path: "src/verify-me.ts" }, { id: "read-for-pin" }),
      fauxToolCall("bash", { command: "printf shell-result" }, { id: "bash-for-pin" }),
    ], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage(["U1", "X1", "X2", "X3", "R1", "S1"].map((handle) => fauxToolCall("pin", { handle, action: "pin" }, { id: `pin-${handle}` })), { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "sleep-after-pin" })], { stopReason: "toolUse" })),
  ]);
  const options = { root, brain, models, model: ref, person: "OracleToes" };
  let session = await openLiveSession(options);
  try {
    const submission = await submitInput(session, "keep this line");
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
    const block = blockOf(captured[1]).content;
    for (const handle of ["U1", "X1", "X2", "X3", "R1", "S1"]) assert.ok(block.includes(`${handle} ·`), `${handle} appears in the state block`);
    const pins = (await brain.read()).ephemera;
    assert.deepEqual(pins.map((item) => item.kind).sort(), ["personMessage", "plainText", "readResult", "reasoning", "toolCall", "toolResult"]);
    assert.ok(pins.every((item) => item.pinned === "agent"));
    const reading = pins.find((item) => item.kind === "readResult");
    assert.equal(reading.entity.path, "src/verify-me.ts");
    const kept = pins.find((item) => item.kind === "reasoning");
    await brain.apply({ kind: "ephemeral.pin", item: { ...kept, pinned: "user" } }, Date.now());
    const pinTool = createTools({ root, brain, session: session.state }).find((tool) => tool.name === "pin");
    for (const action of ["pin", "unpin"]) {
      await assert.rejects(pinTool.execute({ action, handle: "X1" }, { now: Date.now }, {}), /only OracleToes/i);
    }
    await pinTool.execute({ action: "unpin", handle: "X2" }, { now: Date.now }, {});
    assert.ok(!(await brain.read()).ephemera.some((item) => item.kind === "plainText"));
    await pinTool.execute({ action: "pin", handle: "X2" }, { now: Date.now }, {});
    writeFileSync(join(root, "src", "verify-me.ts"), "updated file\n");
    const { collapseLiveSession } = await import("../dist/runtime/live-session.js");
    const outcome = await collapseLiveSession(session, options, "person collapse");
    session = outcome.session;
    const after = (await brain.read()).ephemera;
    assert.equal(after.length, 6);
    assert.equal(after.find((item) => item.id === reading.id).text, "updated file\n");
    assert.equal(after.find((item) => item.id === kept.id).pinned, "user");
    const archivedIds = new Set((await brain.readArchive()).items.map((item) => item.id));
    assert.ok(after.every((item) => !archivedIds.has(item.id)));
    assert.equal(session.state.headEphemera.size, 6);
    assert.equal(session.state.headEphemeraCount, Math.max(...[...session.state.headEphemera.keys()].map((handle) => Number(handle.slice(1)))));
    faux.setResponses([
      factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "sleep-in-new-generation" })], { stopReason: "toolUse" })),
    ]);
    const next = await submitInput(session, "new body");
    assert.equal((await next.wait(BACKGROUND_CONTEXT)).status, "done");
    assert.ok([...session.state.headEphemera.keys()].every((handle) => !session.state.liveEphemera.has(handle)));
    const [headHandle, headItem] = [...session.state.headEphemera].find(([, item]) => item.pinned === "agent");
    const headPin = createTools({ root, brain, session: session.state }).find((tool) => tool.name === "pin");
    await headPin.execute({ action: "unpin", handle: headHandle }, { now: Date.now }, {});
    await closeLiveSession(session);
    session = await openLiveSession(options);
    const reopenedPin = createTools({ root, brain, session: session.state }).find((tool) => tool.name === "pin");
    await reopenedPin.execute({ action: "pin", handle: headHandle }, { now: Date.now }, {});
    assert.ok((await brain.read()).ephemera.some((item) => item.id === headItem.id));
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("successive tree calls continue automatically with the freshly anchored state block", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("tree", { anchor: "src", depth: 1 }, { id: "call-tree-1" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("tree", { anchor: root, depth: 2 }, { id: "call-tree-2" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-sleep" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref, person: "OracleToes", now: () => 1_700_000_000_000 });
  try {
    const settled = await (await submitInput(session, "look at src")).wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, "done");
    await waitForRunEnd(session);
    assert.equal(captured.length, 3, "both tree calls continued without a host intervention");
    assert.match(blockOf(captured[1]).content, /T1 tree: src \(depth 1\)/);
    assert.match(blockOf(captured[2]).content, /T1 tree: \. \(depth 2\)/);
    assert.equal(session.state.tree.anchor, realpathSync(root));
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("configured tree pages reach the agent and the next page's handles read the right file", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  writeFileSync(join(root, "src", "a.ts"), "page payload\n");
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("tree", { offset: 1 }, { id: "page-next" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("read", { path: "F1" }, { id: "page-read" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "page-sleep" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref, treePageSize: 1, person: "OracleToes" });
  try {
    await (await submitInput(session, "page through the tree")).wait(BACKGROUND_CONTEXT);
    await waitForRunEnd(session);
    assert.equal(captured.length, 3);
    assert.match(blockOf(captured[0]).content, /next: tree offset 1/);
    assert.doesNotMatch(blockOf(captured[0]).content, /a\.ts/);
    assert.match(blockOf(captured[1]).content, /src\/.*\(context\)/);
    assert.match(blockOf(captured[1]).content, /a\.ts.*F1/);
    assert.match(flatten(captured[2]), /page payload/);
    assert.equal(session.state.tree.limit, 1);
    assert.equal(session.state.tree.offset, 1);
  } finally { await closeLiveSession(session); await cleanup(); }
});

test("the boundary holds: .brain is unreadable, escapes are rejected", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const tools = createTools({ root, brain, session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", person: "OracleToes", readOnly: false } });
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
  assert.match(validTree.output[0].text, /^Anchored at .*, depth 1, offset 0\./);
  assert.doesNotMatch(validTree.output[0].text, /\n/);
  // §6.3: tree ends the turn, so the very next thing the agent reads is the
  // block with the tree it asked for — not the tree it had before.
  assert.equal(validTree.control?.terminate, true, "the tree call ends the turn");
  await cleanup();
});

test("project modes persist independently through reopening and collapse", async () => {
  const a = await fixture({ inMemoryBrain: true });
  const b = await fixture({ inMemoryBrain: true });
  const { models, ref } = fauxSetup();
  const options = { root: a.root, brain: a.brain, models, model: ref, person: "OracleToes" };
  let session = await openLiveSession(options);
  let other;
  try {
    assert.equal(session.state.readOnly, false);
    assert.equal(session.state.pathScope, "strict");
    setProjectModes(session, { readOnly: true });
    setProjectModes(session, { pathScope: "relaxed" });
    other = await openLiveSession({ ...options, root: b.root, brain: b.brain });
    assert.equal(other.state.readOnly, false);
    assert.equal(other.state.pathScope, "strict");
    const { collapseLiveSession } = await import("../dist/runtime/live-session.js");
    session = (await collapseLiveSession(session, options, "person collapse")).session;
    assert.equal(session.state.readOnly, true);
    assert.equal(session.state.pathScope, "relaxed");
    await closeLiveSession(session);
    session = await openLiveSession(options);
    assert.equal(session.state.readOnly, true);
    assert.equal(session.state.pathScope, "relaxed");
    setProjectModes(session, { readOnly: false });
    assert.equal(session.state.pathScope, "relaxed");
    assert.deepEqual(JSON.parse(readFileSync(join(a.root, ".brain", "settings.json"), "utf8")), { version: 1, readOnly: false, pathScope: "relaxed" });
    writeFileSync(join(a.root, ".brain", "settings.json"), "invalid");
    assert.throws(() => setProjectModes(session, { readOnly: true }), /Invalid project settings/);
    assert.equal(session.state.readOnly, false);
  } finally {
    await closeLiveSession(session);
    if (other) await closeLiveSession(other);
    await a.cleanup(); await b.cleanup();
  }
});

test("a pinned external read refreshes on collapse in relaxed scope", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const outside = mkdtempSync(join(tmpdir(), "carto-read-pin-"));
  const file = join(outside, "outside file.txt");
  writeFileSync(file, "fresh external content\n");
  const { models, ref } = fauxSetup();
  const options = { root, brain, models, model: ref, person: "OracleToes" };
  let session = await openLiveSession(options);
  try {
    setProjectModes(session, { pathScope: "relaxed" });
    await brain.apply({ kind: "ephemeral.pin", item: { id: "external-reading", text: "old", kind: "readResult", entity: { callId: "read-outside", tool: "read", path: `@${file}` }, createdAt: Date.now(), pinned: "user" } }, Date.now());
    const { collapseLiveSession } = await import("../dist/runtime/live-session.js");
    session = (await collapseLiveSession(session, options, "person collapse")).session;
    assert.equal((await brain.read()).ephemera.find((item) => item.id === "external-reading").text, "fresh external content\n");
    assert.equal(session.state.pathScope, "relaxed");
  } finally { await closeLiveSession(session); await cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test("file scope guards normalized and symlinked paths while relaxed read/edit work outside", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const outside = mkdtempSync(join(tmpdir(), "carto-outside-"));
  const file = join(outside, "other file.txt");
  writeFileSync(file, "before\n");
  mkdirSync(join(outside, ".brain"));
  writeFileSync(join(outside, ".brain", "secret"), "secret");
  symlinkSync(file, join(root, "external-link"));
  symlinkSync(join(root, ".brain"), join(root, "brain-link"));
  symlinkSync(join(outside, "missing"), join(root, "dangling"));
  const state = { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", person: "OracleToes", readOnly: false, pathScope: "strict" };
  const byName = Object.fromEntries(createTools({ root, brain, session: state }).map((tool) => [tool.name, tool]));
  const api = { callId: "scope-test", now: Date.now, conversationId: "c", taskId: "t", env: new NodeExecutionEnv({ cwd: root }) };
  const edit = (path) => byName.edit.execute({ path, edits: [{ oldText: "before", newText: "after" }] }, api, {});
  const read = (path) => byName.read.execute({ path }, api, {});
  try {
    for (const path of [file, `@${file}`, pathToFileURL(file).href, "external-link"]) await assert.rejects(read(path), /outside the project root/);
    await assert.rejects(edit("external-link"), /outside the project root/);
    await assert.rejects(byName.create.execute({ path: "dangling", content: "no" }, api, {}), /unresolved symlink/);
    state.pathScope = "relaxed";
    assert.match(JSON.stringify(await read(`@${file.replace(" ", "\u00a0")}`)), /before/);
    await edit(pathToFileURL(file).href);
    assert.equal(readFileSync(file, "utf8"), "after\n");
    for (const path of ["brain-link/brain.sqlite", join(outside, ".brain", "secret"), `@${join(root, ".brain", "brain.sqlite")}`]) await assert.rejects(read(path), /\.brain/);
    await assert.rejects(byName.create.execute({ path: join(outside, "new"), content: "no" }, api, {}), /outside the project root/);
    state.readOnly = true;
    await assert.rejects(byName.edit.execute({ path: file, edits: [{ oldText: "after", newText: "no" }] }, api, {}), /read only mode/);
    assert.match(JSON.stringify(await read(file)), /after/);
  } finally { await cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test("the file tools are the package's: read takes offset and limit", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const tools = createTools({ root, brain, session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", person: "OracleToes", readOnly: false } });
  const api = { callId: "call-whole", now: () => 1_700_000_000_000, conversationId: "c", taskId: "t", env: new NodeExecutionEnv({ cwd: root }) };
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  // The full read is covered by the model turn above; this checks the offset
  // boundary without paying for a second identical package read.
  const limited = await byName.read.execute({ path: "src/verify-me.ts", offset: 2, limit: 1 }, api, {});
  const limitedOut = limited.output.map((part) => part.text).join("");
  assert.doesNotMatch(limitedOut, /export const answer/);
  await cleanup();
});

test("create refuses a path that exists; edit never creates", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const tools = createTools({ root, brain, session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", person: "OracleToes", readOnly: false } });
  const api = { callId: "call-create", now: () => 1_700_000_000_000, conversationId: "c", taskId: "t", env: new NodeExecutionEnv({ cwd: root }) };
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const created = await byName.create.execute({ path: "src/new-file.ts", content: "export const x = 1;\n" }, api, {});
  assert.match(created.output[0].text, /Successfully wrote/);
  await assert.rejects(byName.create.execute({ path: "src/new-file.ts", content: "replaced" }, api, {}), /already exists/);
  await assert.rejects(byName.edit.execute({ path: "src/missing.ts", edits: [{ oldText: "", newText: "x" }] }, api, {}), /not_found|not a file/i);
  await cleanup();
});

test("read only mode refuses create and edit, and the block says so", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const session = { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", person: "OracleToes", readOnly: true };
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
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const tools = createTools({ root, brain, session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", person: "OracleToes", readOnly: false } });
  const api = { callId: "call-z", now: () => 1_700_000_000_000, conversationId: "c", taskId: "t" };
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  await assert.rejects(
    byName.atlas.execute({ handle: "Z9", title: "t", text: "c" }, api, {}),
    /No Atlas record here has the handle Z9/,
  );
  await assert.rejects(
    byName.pin.execute({ action: "pin", handle: "Q4" }, api, {}),
    /Q4 is not a file in the tree/,
  );
  await cleanup();
});

test("ephemeral restore puts the actual text in model context, is idempotent, and rejects unsupported kinds", async () => {
  const { root, brain, cleanup } = await fixture();
  const { models, ref } = fauxSetup();
  const session = await openLiveSession({ root, brain, models, model: ref, now: () => 1_700_000_000_000 });
  try {
    const item = { id: "restore-test", layer: "ephemeral", ephemeral: { kind: "personMessage", text: "actual restored content" } };
    assert.equal(await restoreEphemeral(session, item), true);
    assert.equal(await restoreEphemeral(session, item), true);
    const view = await session.conversation.context(BACKGROUND_CONTEXT);
    const indices = view.entries.map((entry, index) => entry.kind === "carto.restored" ? index : -1).filter((index) => index >= 0);
    assert.equal(indices.length, 1);
    assert.equal(view.contributions[indices[0]][0].content, "actual restored content");
    assert.equal(await restoreEphemeral(session, { ...item, id: "unsupported", ephemeral: { kind: "toolResult", text: "must not disappear" } }), false);
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("a committed ephemeral restore survives a crash and is retried on reopen", async () => {
  const { root, brain, cleanup } = await fixture();
  const { models, ref } = fauxSetup();
  const options = { root, brain, models, model: ref };
  let session = await openLiveSession(options);
  try {
    await session.conversation.submit({ type: "write", entry: { kind: "test.recovery", model: [{ role: "user", content: "recover after restart", timestamp: Date.now() }] } }, BACKGROUND_CONTEXT);
    await closeLiveSession(session);
    session = undefined;
    const { collapse } = await import("../dist/runtime/collapse.js");
    await collapse(root, brain);
    const item = (await brain.readArchive()).items.find((candidate) => candidate.ephemeral?.text === "recover after restart");
    assert.ok(item);
    await brain.applyArchive({ kind: "mark", id: item.id, action: "restore", author: "user" });
    await collapse(root, brain); // crash after commit, before opening the new session
    assert.equal((await brain.readArchive()).items.find((candidate) => candidate.id === item.id)?.restorePending, true);
    session = await openLiveSession(options);
    assert.ok(!(await brain.readArchive()).items.some((candidate) => candidate.id === item.id));
    assert.ok(JSON.stringify((await session.conversation.context(BACKGROUND_CONTEXT)).messages).includes("recover after restart"));
  } finally {
    if (session) await closeLiveSession(session);
    await cleanup();
  }
});

test("work restores retain their actual Pi messages and tool result pairing", async () => {
  const { root, brain, cleanup } = await fixture();
  const { models, ref } = fauxSetup();
  const session = await openLiveSession({ root, brain, models, model: ref });
  try {
    await session.conversation.submit({ type: "write", entry: { kind: "test.work.restore", model: [
      fauxAssistantMessage([fauxText("recover output"), fauxToolCall("read", { path: "src/verify-me.ts" }, { id: "original-call" })], { stopReason: "toolUse" }),
    ] } }, BACKGROUND_CONTEXT);
    await session.conversation.submit({ type: "write", entry: { kind: "test.result.restore", model: [{
      role: "toolResult", toolCallId: "original-call", toolName: "read", content: [{ type: "text", text: "recover result" }], isError: false, timestamp: Date.now(),
    }] } }, BACKGROUND_CONTEXT);
    const swept = await readGenerationEphemera(generationPaths(root, session.generation).store, session.generation);
    const output = swept.find((item) => item.ephemeral?.text === "recover output");
    const result = swept.find((item) => item.ephemeral?.text === "recover result");
    assert.ok(output && result);
    assert.equal(await restoreEphemeral(session, output), true);
    assert.equal(await restoreEphemeral(session, result), true);
    const view = await session.conversation.context(BACKGROUND_CONTEXT);
    const restored = view.entries.map((entry, index) => ({ entry, model: view.contributions[index] })).filter(({ entry }) => entry.kind === "carto.restored");
    assert.equal(restored.length, 3);
    assert.equal(restored[0].model[0].content[0].text, "recover output");
    const call = restored[1].model[0].content[0];
    assert.notEqual(call.id, "original-call");
    assert.equal(restored[2].model[0].toolCallId, call.id);
    assert.equal(restored[2].model[0].content[0].text, "recover result");
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("an agent-triggered collapse: the run ends, the ceremony runs, the fresh context carries the Brain", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const { faux, models, captured, factory, ref } = fauxSetup();
  const options = () => ({ root, brain, models, model: ref, now: () => 1_700_000_000_000 });
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("collapse", { message: "Saved notes to Atlas; collapsing now." }, { id: "call-collapse" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession(options());
  const previousGeneration = session.generation;
  try {
    // Atlas writes through a model call are exercised by the read/Atlas case;
    // the collapse contract only needs a real record already in the Brain.
    await brain.apply({ kind: "atlas.upsert", node: {
      id: "collapse-node", title: "The answer", text: "The answer is 42.", links: [],
      attachments: [{ kind: "file", path: "src/verify-me.ts" }],
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
    } }, 1_700_000_000_000);
    const submission = await submitInput(session, "reset");
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
    const brainAfter = await brain.read();
    const nodes = brainAfter.atlas;
    assert.equal(nodes.length, 1);
    assert.ok(
      brainAfter.chat.some((record) => record.author === "agent" && record.text === "Saved notes to Atlas; collapsing now."),
      "collapse records its required message into Chat",
    );
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
    assert.equal(captured.length, 2, "one request per scripted response, across the collapse");
    await closeLiveSession(outcome.session);
  } finally {
    await closeLiveSession(session).catch(() => undefined);
    await cleanup();
  }
});

test("drift rides the collapse: the frozen projection carries the marks", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const { faux, models, captured, factory, ref } = fauxSetup();
  const options = () => ({ root, brain, models, model: ref, now: () => 1_700_000_000_000 });
  const session = await openLiveSession(options());
  try {
    // The read-to-Atlas tool chain is covered above. Seed its result directly
    // here so this case exercises drift and its propagation, not that chain a
    // second time.
    await brain.apply({ kind: "atlas.upsert", node: {
      id: "drift-node", title: "The answer", text: "The answer is 42.", links: [],
      attachments: [{ kind: "file", path: "src/verify-me.ts" }],
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
    } }, 1_700_000_000_000);
    // The file drifts (and is touched) after the entry was written.
    const driftPath = join(root, "src", "verify-me.ts");
    writeFileSync(driftPath, "export const answer = 43;\n");
    const drift = new Date(1_700_001_000_000);
    utimesSync(driftPath, drift, drift);
    const { collapseLiveSession } = await import("../dist/runtime/live-session.js");
    const outcome = await collapseLiveSession(session, options(), "person-triggered");
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

});

test("the person's message is recorded as Chat once, and a collapse brings it back in the head", async () => {
  const { root, brain, cleanup } = await fixture({ inMemoryBrain: true });
  const { faux, models, factory, ref } = fauxSetup();
  faux.setResponses([factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-sleep" })], { stopReason: "toolUse" }))]);
  const session = await openLiveSession({ root, brain, models, model: ref, person: "OracleToes", now: () => 1_700_000_000_000 });
  try {
    await (await submitInput(session, "  keep this across a collapse")).wait(BACKGROUND_CONTEXT);
    const records = (await brain.read()).chat;
    assert.equal(records.length, 1, "one message, one record");
    assert.deepEqual([records[0].author, records[0].text, records[0].createdAt], ["user", "  keep this across a collapse", 1_700_000_000_000]);
    // Blank input is not a message.
    await submitInput(session, "   ").then((submission) => submission.wait(BACKGROUND_CONTEXT)).catch(() => undefined);
    assert.equal((await brain.read()).chat.length, 1);
  } finally {
    await closeLiveSession(session).catch(() => undefined);
    await cleanup();
  }
});
