import "./agent-reminder.mjs";
import assert from "node:assert/strict";
import { chmodSync, existsSync, utimesSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { InboxDoc } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { openBrain } from "../dist/runtime/brain-store.js";
import { handleOf } from "../dist/domain/handles.js";
import { personChatBindings } from "../dist/domain/chat-identity.js";
import {
  applyOmitNow,
  applyRecordActionNow,
  readLiveWorkEdit,
  editLiveWork,
  closeLiveSession,
  interruptRun,
  openLiveSession,
  restoreEphemeral,
  sessionTranscript,
  submitInput,
  togglePause,
  waitForRunEnd,
} from "../dist/runtime/live-session.js";
import { configuredModels } from "../dist/runtime/llama-swap-model.js";
import { ephemeralItemId, generationPaths, readGenerationEphemera } from "../dist/runtime/collapse.js";
import { createTools } from "../dist/runtime/tools.js";
import { STATE_BLOCK_MARKER } from "../dist/domain/state-block.js";
import { RestCallDoc, RestDoc, SleepTask } from "../dist/runtime/sleep-task.js";

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "carto-live-"));
  mkdirSync(join(root, ".brain"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "verify-me.ts"), "export const answer = 42;\n");
  // These cases reopen the durable session, not the Brain. Persistence of the
  // Brain itself is exercised separately; keep the real live store on disk.
  const brain = await openBrain(":memory:");
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

// Independent cases own separate projects and harnesses.
test.describe("live session (continued)", { concurrency: 2 }, () => {
test("the bash tool runs through the conversation's environment: a real command, real stdout", async () => {
  const { root, brain, cleanup } = await fixture();
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("bash", { command: "printf carto-bash-ok" }, { id: "call-bash-1" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-bash-sleep" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref, person: "OracleToes", now: () => 1_700_000_000_000 });
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
  const session = await openLiveSession({ root, brain, models, model: ref, person: "OracleToes", now: () => 1_700_000_000_000 });
  const started = Date.now();
  try {
    const submission = await submitInput(session, "wait on something long");
    // Give the bash task a moment to actually start, then interrupt. The wait
    // only has to outlast the spawn; `sleep 30` is what proves the interrupt
    // cut the command rather than waiting it out.
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
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
  const session = { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", person: "OracleToes", readOnly: false };
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

test("tree tools use the handles actually sent even if a later scan renumbers files", async () => {
  const { root, brain, cleanup } = await fixture();
  const session = { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", person: "OracleToes", readOnly: false };
  const tools = Object.fromEntries(createTools({ root, brain, session }).map((tool) => [tool.name, tool]));
  const api = { callId: "call-snapshot", now: Date.now, conversationId: "c", taskId: "t", env: new NodeExecutionEnv({ cwd: root }) };
  try {
    const { projectTreeBlock } = await import("../dist/runtime/project-tree.js");
    const before = projectTreeBlock(root, root, 2, await brain.read());
    session.requestTreeHandles = before.handles;
    const file = join(root, "src", "verify-me.ts");
    const handle = before.handles.get(file);
    writeFileSync(join(root, "src", "aaa.ts"), "different content");
    const after = projectTreeBlock(root, root, 3, await brain.read());
    assert.notEqual(after.handles.get(file), handle);
    const read = await tools.read.execute({ path: handle }, api, {});
    assert.match(read.output.map((part) => part.text).join(""), /answer = 42/);
    await assert.rejects(tools.read.execute({ path: "F999" }, api, {}), /not a file handle/);
    const dir = before.handles.get(join(root, "src"));
    await tools.tree.execute({ handle: dir }, api, {});
    assert.equal(session.tree.anchor, join(root, "src"));
  } finally { await cleanup(); }
});

test("no product tool carries a bound its own description does not state", async () => {
  const { root, brain, cleanup } = await fixture();
  try {
    const tools = createTools({
      root,
      brain,
      session: { pending: [], tree: { anchor: root, depth: 2 }, collapseRequested: null, generation: "gen-test", person: "OracleToes", readOnly: false },
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

test("timed sleep creation survives replay and respects an already queued message", async () => {
  const tool = createTools({
    root: ".", brain: {},
    session: { person: "OracleToes", pending: [], tree: { anchor: ".", depth: 1 }, collapseRequested: null, generation: "test", readOnly: false },
  }).find((item) => item.name === "sleep");
  const rest = { active: null, legacyAllowed: true };
  const receipts = new Map();
  const inbox = { items: [] };
  const created = [];
  let taskId = 1;
  const api = {
    get taskId() { return taskId; },
    conversationId: 2,
    commit: async (fn) => fn({
      doc: async (token, id) => {
        if (token === RestDoc) return rest;
        if (token === InboxDoc) return inbox;
        assert.equal(token, RestCallDoc);
        if (!receipts.has(id)) receipts.set(id, { handled: false });
        return receipts.get(id);
      },
      createTask: async (definition, input, taskOptions) => {
        assert.equal(definition, SleepTask);
        assert.equal(taskOptions?.background, true, "timed rests are background tasks so waitForIdle does not wait for them");
        created.push(input);
        return 40 + created.length;
      },
    }),
  };
  await tool.execute({ seconds: 5 }, api, BACKGROUND_CONTEXT);
  await tool.execute({ seconds: 5 }, api, BACKGROUND_CONTEXT);
  assert.deepEqual(created, [{ seconds: 5, tracked: true }], "replay did not create another task");
  assert.equal(rest.active, 41);

  // The person can write before the tool reaches its creation commit, even
  // with text that happens to equal Carto's internal marker.
  inbox.items.push({ mode: "followUp", content: STATE_BLOCK_MARKER });
  taskId = 2;
  await tool.execute({ seconds: 7 }, api, BACKGROUND_CONTEXT);
  assert.equal(created.length, 1);
  assert.equal(rest.active, null);
  inbox.items.length = 0;
  await tool.execute({ seconds: 7 }, api, BACKGROUND_CONTEXT);
  assert.equal(created.length, 1, "replay cannot revive a rest ended by the queued input");

  taskId = 3;
  await tool.execute({ seconds: 9 }, api, BACKGROUND_CONTEXT);
  assert.equal(created.length, 2, "a later sleep remains possible");
  assert.equal(rest.active, 42);
});

test("a timed wake commits admission and completion together and does not revive a cancelled rest", async () => {
  let rest = { active: 42, legacyAllowed: false };
  let messages = 0;
  let completed = false;
  let crash = true;
  const runtime = {
    taskId: 42,
    conversationId: 1,
    now: () => 123,
    conversation: async () => ({ submit: async (tx, submission) => {
      assert.equal(submission.content, STATE_BLOCK_MARKER);
      tx.messages += 1;
    } }),
    commit: async (callback) => {
      const candidate = { ...rest };
      const tx = { messages: 0, doc: async (token) => { assert.equal(token, RestDoc); return candidate; } };
      const result = await callback(tx);
      if (crash) throw new Error("crash before durable commit");
      rest = candidate;
      messages += tx.messages;
      completed = result.status === "terminal";
    },
  };
  const task = { input: { seconds: 10, tracked: true } };
  await assert.rejects(SleepTask.definition.phases.wake(task, runtime, BACKGROUND_CONTEXT), /crash/);
  assert.equal(messages, 0);
  assert.equal(completed, false);
  assert.equal(rest.active, 42);
  crash = false;
  await SleepTask.definition.phases.wake(task, runtime, BACKGROUND_CONTEXT);
  assert.equal(messages, 1);
  assert.equal(completed, true);
  assert.equal(rest.active, null);
  await SleepTask.definition.phases.wake(task, runtime, BACKGROUND_CONTEXT);
  assert.equal(messages, 1, "replay or a cancelled rest cannot queue another wake");
});

test("a timed rest is durable: it sleeps in the store, survives a reopen, and the agent goes on", async () => {
  const { root, brain, cleanup } = await fixture();
  // A clock the test moves and timers it fires, so a rest of ten seconds costs
  // nothing and the wait cannot be mistaken for a real timer (§10).
  let clock = 1_700_000_000_000;
  const clockNow = () => clock;
  const timers = [];
  const setTimer = (callback, delayMs) => {
    const timer = { due: clockNow() + delayMs, callback };
    timers.push(timer);
    return () => {
      const at = timers.indexOf(timer);
      if (at >= 0) timers.splice(at, 1);
    };
  };
  const fireDue = async () => {
    for (;;) {
      const due = timers.filter((timer) => timer.due <= clock).sort((left, right) => left.due - right.due)[0];
      if (due === undefined) return;
      timers.splice(timers.indexOf(due), 1);
      due.callback();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", { seconds: 10 }, { id: "call-rest" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("tree", { anchor: "src", depth: 1 }, { id: "call-after-rest" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-done" })], { stopReason: "toolUse" })),
  ]);
  let session = await openLiveSession({ root, brain, models, model: ref, now: clockNow, setTimer });
  try {
    const submission = await submitInput(session, "rest for a while");
    await submission.wait(BACKGROUND_CONTEXT);

    // §10: the wait is durable, so it is a sleeping task in the store, and the
    // run never reached the model again while it rested.
    // The after-run hook asks for the rest once the run's inputs have settled, so
    // this waits for it rather than reading a half-finished run end.
    const asleep = async () => {
      const deadline = Date.now() + 1000;
      for (;;) {
        const tasks = (await session.harness.inspect(BACKGROUND_CONTEXT)).tasks;
        const rest = tasks.filter((task) => task.state.kind === "sleeping" && task.record.kind === "carto.sleep");
        if (rest.length > 0 || Date.now() > deadline) return rest;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    assert.equal((await asleep()).length, 1, "the rest is a sleep in the store");
    assert.equal(captured.length, 1, "and the agent did not act again while it rested");
    const due = (await asleep())[0].state.until;
    assert.equal(due, clock + 10_000, "for as long as the call asked");

    // The host goes away and comes back mid-rest.
    await closeLiveSession(session);
    session = await openLiveSession({ root, brain, models, model: ref, now: clockNow, setTimer });
    assert.equal((await asleep()).length, 1, "the rest survives the reopen");

    // The clock passes the rest and the host's timer fires: the rest ends, and
    // nothing is left pending.
    clock = due + 1;
    session.harness.resume();
    await fireDue();
    await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const deadline = Date.now() + 2000;
    while (captured.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(captured.length, 3, "the rest ended and the tree call also continued by itself");
    assert.match(blockOf(captured[1]).content, /<carto-state>/, "starting from the state block, as any turn does");
    assert.match(blockOf(captured[2]).content, /T1 tree: src \(depth 1\)/, "the wake's tree call refreshed the next block");
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});



test("a message ends a rest early, and the rest does not then start a second turn", async () => {
  const { root, brain, cleanup } = await fixture();
  let clock = 1_700_000_000_000;
  const timers = [];
  const setTimer = (callback, delayMs) => {
    const timer = { due: clock + delayMs, callback };
    timers.push(timer);
    return () => {
      const at = timers.indexOf(timer);
      if (at >= 0) timers.splice(at, 1);
    };
  };
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", { seconds: 600 }, { id: "call-rest" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-after" })], { stopReason: "toolUse" })),
  ]);
  let session = await openLiveSession({ root, brain, models, model: ref, now: () => clock, setTimer });
  try {
    await (await submitInput(session, "rest for ten minutes")).wait(BACKGROUND_CONTEXT);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(captured.length, 1);

    // The rest holds nothing: the conversation is free while the agent sleeps,
    // so the person's message is a turn of its own rather than a queued one.
    const inspection = await session.harness.inspect(BACKGROUND_CONTEXT);
    const queued = inspection.submissions;
    assert.equal(queued.length, 0, "nothing is waiting on the rest");
    const rest = inspection.tasks.find((task) => task.record.kind === "carto.sleep");
    assert.ok(rest, "the timed rest is actually pending before the message");

    const reply = await submitInput(session, "never mind, do this instead");
    assert.equal((await reply.wait(BACKGROUND_CONTEXT)).status, "done", "the message got its turn at once");
    assert.equal(captured.length, 2, "and the agent answered it");
    await session.harness.waitForTask(rest.record.id, BACKGROUND_CONTEXT);
    assert.ok(!(await session.harness.inspect(BACKGROUND_CONTEXT)).tasks.some((task) => task.record.kind === "carto.sleep"), "the rest is no longer pending");

    // Cancellation remains effective across restart, even when the old due
    // time comes and passes.
    await closeLiveSession(session);
    session = await openLiveSession({ root, brain, models, model: ref, now: () => clock, setTimer });
    clock += 601_000;
    session.harness.resume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const timer of timers.filter((candidate) => candidate.due <= clock)) timer.callback();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(captured.length, 2, "and the rest ended quietly, with no second start");
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("applying a deletion now rebuilds the context in place: no collapse, no sweep, no rotation", async () => {
  const { root, brain, cleanup } = await fixture();
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("chat", { text: "first thing said" }, { id: "call-chat" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-stop" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref });
  try {
    await (await submitInput(session, "say something")).wait(BACKGROUND_CONTEXT);
    const generation = session.state.generation;
    const entries = await sessionTranscript(session);
    const chatEntry = entries.find((entry) => JSON.stringify(entry.model ?? []).includes("first thing said"));
    assert.ok(chatEntry !== undefined, "the chat is in the context");

    // §4.1: applying a delete now changes the model's view at once, and the
    // store still holds the entry — the text is gone from the view before it is
    // gone from disk.
    assert.equal(await applyOmitNow(session, String(chatEntry.id)), true);
    const after = await sessionTranscript(session);
    assert.ok(after.some((entry) => entry.id === chatEntry.id), "the entry is still in the store");

    const view = await session.conversation.context(BACKGROUND_CONTEXT);
    assert.equal(
      JSON.stringify(view.messages).includes("first thing said"),
      false,
      "and it is out of the model's view",
    );

    // The rebuild is not a collapse: nothing was swept, and the generation is
    // the same one, so the head prefix is untouched (§4.1, §5.6).
    assert.equal(session.state.generation, generation, "no rotation");
    assert.equal(existsSync(generationPaths(root, generation).markdown), true, "the same generation's snapshot is the one in use");
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("apply-now removes only the selected work row from the prompt, view and later sweep", async () => {
  const { root, brain, cleanup } = await fixture();
  const { models, ref } = fauxSetup();
  const session = await openLiveSession({ root, brain, models, model: ref });
  try {
    await session.conversation.submit({
      type: "write",
      entry: {
        kind: "test.work",
        model: [fauxAssistantMessage([
          { type: "thinking", thinking: "remove this thought" },
          fauxText("keep this text"),
          fauxText("remove this text too"),
        ])],
      },
    }, BACKGROUND_CONTEXT);
    const original = (await sessionTranscript(session)).find((entry) => entry.kind === "test.work");
    assert.ok(original);
    assert.equal(await applyOmitNow(session, ephemeralItemId(session.generation, original.id, "t0")), true);
    let current = await sessionTranscript(session);
    assert.ok(!JSON.stringify(current.find((entry) => entry.id === original.id).model).includes("remove this thought"));
    assert.ok(JSON.stringify(current).includes("keep this text"));
    assert.equal(await applyOmitNow(session, ephemeralItemId(session.generation, original.id, "x1")), true);
    const view = await session.conversation.context(BACKGROUND_CONTEXT);
    assert.ok(!JSON.stringify(view.messages).includes("remove this text too"));
    assert.ok(JSON.stringify(view.messages).includes("keep this text"));
    assert.ok(JSON.stringify(view.entries).includes("remove this thought"), "the store remains append-only");

    const swept = await readGenerationEphemera(generationPaths(root, session.generation).store, session.generation);
    const sweptText = JSON.stringify(swept);
    assert.ok(!sweptText.includes("remove this thought") && !sweptText.includes("remove this text too"));
    assert.ok(sweptText.includes("keep this text"));
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("live work edits keep identities across further edits, removal, reopening and sweep", async () => {
  const { root, brain, cleanup } = await fixture();
  const { models, ref } = fauxSetup();
  let session = await openLiveSession({ root, brain, models, model: ref });
  try {
    await session.conversation.submit({ type: "write", entry: { kind: "test.edit-work", model: [fauxAssistantMessage([
      fauxText("same"), fauxText("same"), fauxToolCall("read", { path: "old" }, { id: "edit-call" }),
    ], { stopReason: "toolUse" })] } }, BACKGROUND_CONTEXT);
    await session.conversation.submit({ type: "write", entry: { kind: "test.edit-result", model: [{
      role: "toolResult", toolCallId: "edit-call", toolName: "read", content: [{ type: "text", text: "old result" }], isError: false, timestamp: Date.now(),
    }] } }, BACKGROUND_CONTEXT);
    const entries = await sessionTranscript(session);
    const entry = entries.find((item) => item.kind === "test.edit-work");
    const result = entries.find((item) => item.kind === "test.edit-result");
    const id = (key) => ephemeralItemId(session.generation, entry.id, key);
    const resultId = ephemeralItemId(session.generation, result.id, "r");
    const stale = await readLiveWorkEdit(session, id("x1"));
    await editLiveWork(session, stale, "changed sibling");
    await assert.rejects(editLiveWork(session, stale, "stale"), /changed/);
    await editLiveWork(session, await readLiveWorkEdit(session, id("c2")), '{"path":"new"}');
    await assert.rejects(editLiveWork(session, await readLiveWorkEdit(session, id("c2")), "[]"), /JSON object/);
    await editLiveWork(session, await readLiveWorkEdit(session, resultId), "new result");
    assert.equal(await applyOmitNow(session, id("x0")), true);
    await closeLiveSession(session);
    session = await openLiveSession({ root, brain, models, model: ref });
    const current = (await sessionTranscript(session)).find((item) => item.kind === "test.edit-work");
    assert.deepEqual(current.partKeys, ["x1", "c2"]);
    assert.equal(current.model[0].content[0].text, "changed sibling");
    const swept = await readGenerationEphemera(generationPaths(root, session.generation).store, session.generation);
    assert.ok(!swept.some((item) => item.id === id("x0")));
    assert.equal(swept.find((item) => item.id === id("x1")).ephemeral.text, "changed sibling");
    const saved = swept.find((item) => item.id === resultId).ephemeral.model;
    assert.equal(saved[0].content[0].arguments.path, "new");
    assert.equal(saved[1].content[0].text, "new result");
  } finally {
    await closeLiveSession(session).catch(() => undefined);
    await cleanup();
  }
});

test("the head stays byte-identical across Brain writes and a projection read failure", async () => {
  const { root, brain, cleanup } = await fixture();
  const { faux, models, captured, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("chat", { text: "first note" }, { id: "call-head-1" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-head-2" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("chat", { text: "second note" }, { id: "call-head-3" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-head-4" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref, person: "OracleToes", now: () => 1_700_000_000_000 });
  // The head as pi carries it: every system entry's sections and tool set.
  const headOf = (messages) => JSON.stringify(
    messages.filter((message) => message.role === "system").map((message) => ({ sections: message.sections, tools: message.toolsAdded })),
  );
  try {
    const first = await submitInput(session, "first turn");
    await first.wait(BACKGROUND_CONTEXT);
    const head = headOf(captured[0]);
    assert.ok(head.includes("carto-context"), "the first request carried the frozen projection");

    // The projection file goes away: the next read must keep the shown bytes,
    // not re-project the Brain (which the agent has since written to).
    const markdown = generationPaths(root, session.generation).markdown;
    chmodSync(markdown, 0o644);
    rmSync(markdown);

    const second = await submitInput(session, "second turn");
    await second.wait(BACKGROUND_CONTEXT);
    assert.equal(headOf(captured.at(-1)), head, "the head is byte-identical across Brain writes and a projection read failure");
  } finally {
    await closeLiveSession(session).catch(() => undefined);
    await cleanup();
  }
});

test("sibling work identities survive repeated removals, including identical parts", async () => {
  const { root, brain, cleanup } = await fixture();
  const { models, ref } = fauxSetup();
  const session = await openLiveSession({ root, brain, models, model: ref });
  try {
    await session.conversation.submit({ type: "write", entry: {
      kind: "test.stable",
      model: [fauxAssistantMessage([fauxText("same"), fauxText("same"), fauxText("last")])],
    } }, BACKGROUND_CONTEXT);
    const entry = (await sessionTranscript(session)).find((item) => item.kind === "test.stable");
    const id = (key) => ephemeralItemId(session.generation, entry.id, key);
    await brain.apply({ kind: "ephemeral.pin", item: { id: id("x1"), kind: "plainText", text: "same", pinned: "user", createdAt: Date.now() } }, Date.now());
    assert.equal(await applyOmitNow(session, id("x0")), true);
    const after = (await sessionTranscript(session)).find((item) => item.id === entry.id);
    assert.deepEqual(after.partKeys, ["x1", "x2"]);
    let swept = await readGenerationEphemera(generationPaths(root, session.generation).store, session.generation);
    assert.ok(swept.some((item) => item.id === id("x1") && item.ephemeral.text === "same"));
    assert.ok(swept.some((item) => item.id === id("x2") && item.ephemeral.text === "last"));
    assert.equal(await applyOmitNow(session, id("x2")), true);
    swept = await readGenerationEphemera(generationPaths(root, session.generation).store, session.generation);
    assert.ok(swept.some((item) => item.id === id("x1")));
    assert.ok(!swept.some((item) => item.id === id("x2")));
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("applying Chat actions removes only the selected live person or agent contribution", async () => {
  const { root, brain, cleanup } = await fixture();
  const { faux, models, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([
      fauxText("keep this sibling"),
      fauxToolCall("chat", { text: "same agent answer" }, { id: "chat-first" }),
      fauxToolCall("chat", { text: "same agent answer" }, { id: "chat-second" }),
    ], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "stop-first" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "stop-second" })], { stopReason: "toolUse" })),
  ]);
  let session = await openLiveSession({ root, brain, models, model: ref, person: "OracleToes" });
  try {
    await (await submitInput(session, [{ type: "text", text: "same " }, { type: "text", text: "question" }])).wait(BACKGROUND_CONTEXT);
    await (await submitInput(session, "same question")).wait(BACKGROUND_CONTEXT);
    const people = (await brain.read()).chat.filter((record) => record.author === "user");
    assert.equal(people.length, 2);
    let entries = await sessionTranscript(session);
    let bindings = personChatBindings(entries, (await brain.read()).chat, new Set());
    const first = entries.find((entry) => bindings.get(entry.id) === people[0].id);
    const second = entries.find((entry) => bindings.get(entry.id) === people[1].id);
    assert.ok(first && second && first.id !== second.id, "equal text has separate durable identities");

    assert.equal(await applyRecordActionNow(session, brain, root, "chat", people[1].id, "delete"), true);
    entries = await sessionTranscript(session);
    assert.equal(entries.find((entry) => entry.id === second.id).model.length, 0);
    assert.equal(entries.find((entry) => entry.id === first.id).model[0].role, "user");
    assert.ok((await brain.read()).chat.some((record) => record.id === people[0].id));
    assert.ok(!(await brain.read()).chat.some((record) => record.id === people[1].id));

    assert.equal(await applyRecordActionNow(session, brain, root, "chat", "chat:chat-first", "delete"), true);
    entries = await sessionTranscript(session);
    const model = JSON.stringify(entries.map((entry) => entry.model));
    assert.ok(!model.includes('"id":"chat-first"'));
    assert.ok(model.includes('"id":"chat-second"'));
    assert.ok(model.includes("keep this sibling"));
    assert.ok((await brain.read()).chat.some((record) => record.id === "chat:chat-second"));

    await closeLiveSession(session);
    session = await openLiveSession({ root, brain, models, model: ref, person: "OracleToes" });
    entries = await sessionTranscript(session);
    bindings = personChatBindings(entries, (await brain.read()).chat, new Set());
    assert.equal(bindings.get(first.id), people[0].id, "identity survives reopening");
    assert.equal(await applyRecordActionNow(session, brain, root, "chat", people[0].id, "archive"), true);
    assert.equal((await sessionTranscript(session)).find((entry) => entry.id === first.id).model.length, 0);
    assert.ok((await brain.readArchive()).items.some((item) => item.record?.value?.id === people[0].id));
  } finally {
    await closeLiveSession(session).catch(() => undefined);
    await cleanup();
  }
});

// ---------- §4.1: a Brain record's action applies now, and the head follows ----------

test("applying a Brain record's mark now moves it out and re-freezes the head, with no collapse", async () => {
  const { root, brain, cleanup } = await fixture();
  const { models, ref } = fauxSetup();
  // Two notes, written before the session opens, so the frozen head is built
  // with both of them in it — the state the person is looking at.
  await brain.apply(
    {
      kind: "atlas.upsert",
      node: { id: "a1", title: "First note", text: "the first understanding", links: [], attachments: [], createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 },
    },
    1_700_000_000_000,
  );
  await brain.apply(
    {
      kind: "atlas.upsert",
      node: { id: "a2", title: "Second note", text: "the second understanding", links: [], attachments: [], createdAt: 1_700_000_001_000, updatedAt: 1_700_000_001_000 },
    },
    1_700_000_001_000,
  );
  const session = await openLiveSession({ root, brain, models, model: ref, person: "OracleToes" });
  try {
    const before = await brain.read();
    const secondHandle = handleOf(before.handles, "atlas", "a2");
    assert.ok(secondHandle !== undefined, "the second note has a handle");
    const headBefore = readFileSync(session.markdownPath, "utf8");
    assert.ok(headBefore.includes("First note") && headBefore.includes("Second note"), "the frozen head holds both notes");

    // §4.1: the act applied now. The record leaves the Brain and the head is
    // re-frozen for the generation that is still open, so the person is shown
    // the prompt the model now reads.
    assert.equal(await applyRecordActionNow(session, brain, root, "atlas", "a1", "archive"), true);
    const after = await brain.read();
    assert.equal(after.atlas.length, 1, "the record left the Brain");
    assert.equal(handleOf(after.handles, "atlas", "a2"), secondHandle, "and the surviving record kept its handle");
    assert.ok((await brain.readArchive()).items.some((item) => item.record?.kind === "atlas"), "it is in the archive");
    const headAfter = readFileSync(session.markdownPath, "utf8");
    assert.ok(!headAfter.includes("First note"), "so it is out of the head the model reads");
    assert.ok(headAfter.includes(`${secondHandle} Second note`), "and the rest of the head is still there, under the handle it had");

    // A rebuild, not a collapse: the generation did not move.
    assert.equal(session.state.generation, session.generation, "no rotation");
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

// ---------- §9: the pause holds the reply, it does not interrupt it ----------
//
// The gate lives at the provider's response body, so the only honest way to test
// it is over a real socket: a stand-in server writes half a reply, the pause
// lands, and the same HTTP response has to finish the sentence afterwards. The
// faux provider never calls `fetch`, so it cannot show any of this.

/** One chat-completions frame; `finish` closes the reply the way the server does. */
const frame = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "ByteShape", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const sse = (pieces, { finish = true } = {}) => {
  const body = pieces.map((piece) => frame({ content: piece })).join("");
  return finish ? `${body}${frame({}, "stop")}data: [DONE]\n\n` : body;
};

/**
 * A llama-swap stand-in. The first request is a reply that stops mid-sentence:
 * it writes `before` and waits to be released before writing `after`, so the
 * pause has a live body to hold. Later requests — the turns the harness starts
 * on its own — answer with `sleep`, which is how a turn honestly ends (§10);
 * without that a stand-in that never calls a tool answers forever.
 */
const pausedServer = async (before, after) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const seen = [];
  const bodies = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    const number = seen.length + 1;
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { bodies.push(JSON.parse(body)); });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (number > 1) {
      // A turn that ends: one tool call and a finish.
      const call = { tool_calls: [{ index: 0, id: `call-${number}`, type: "function", function: { name: "sleep", arguments: "{}" } }] };
      response.write(frame({ role: "assistant", content: "" }));
      response.write(frame(call));
      response.end(`${frame({}, "tool_calls")}data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 700 } }, timings: { prompt_per_second: 125, predicted_per_second: 25, predicted_n: 20 } })}\n\ndata: [DONE]\n\n`);
      seen.push(`turn ${number}: sleep`);
      return;
    }
    seen.push("turn 1: the paused reply");
    // The opening frame, the first half of the sentence, and then the wait: the
    // reply is open and unfinished, which is what a pause needs to find.
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }], prompt_progress: { total: 1000, cache: 700, processed: 850, time_ms: 1000 } })}\n\n`);
    response.write(sse(before, { finish: false }));
    void held.then(() => response.end(sse(after)));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    release: () => release(),
    requests: () => seen.length,
    bodies: () => bodies,
    // Keep-alive sockets from the client would otherwise hold close() open.
    close: () => new Promise((done) => {
      server.closeAllConnections();
      server.close(done);
    }),
  };
};

const waitUntil = async (predicate, label) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
};

test("interrupting a paused stream releases the gate and stops the run", async () => {
  const { root, brain, cleanup } = await fixture();
  const stand = await pausedServer(["started "], ["must not continue"]);
  const ref = { provider: "llama-swap", modelId: "ByteShape" };
  const models = configuredModels({ version: 1, model: "llama-swap/ByteShape", llamaSwapEndpoint: stand.endpoint }, ref);
  const session = await openLiveSession({ root, brain, models, model: ref });
  let timer;
  try {
    const submission = await submitInput(session, "start then stop");
    await waitUntil(() => session.freeze.live(), "the response body");
    assert.equal((await togglePause(session, true)).held, true);
    stand.release();
    const interrupted = await Promise.race([
      interruptRun(session),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("paused interrupt did not settle")), 1500); }),
    ]);
    assert.equal(interrupted, true);
    assert.equal(session.freeze.frozen(), false);
    const result = await submission.wait(BACKGROUND_CONTEXT);
    assert.notEqual(result.status, "running");
    await waitForRunEnd(session);
    assert.equal(stand.requests(), 1, "the interrupted reply did not resume into another turn");
    assert.doesNotMatch(JSON.stringify(await sessionTranscript(session)), /must not continue/);
    assert.equal(await interruptRun(session), false, "stopping an idle session is a no-op");
  } finally {
    clearTimeout(timer);
    stand.release();
    await closeLiveSession(session).catch(() => undefined);
    await stand.close();
    await cleanup();
  }
});

test("a pause holds the reply mid-sentence and the same response finishes it: nothing is re-requested", async () => {
  const { root, brain, cleanup } = await fixture();
  const stand = await pausedServer(["The answer is "], ["forty-two."]);
  const config = { version: 1, model: "llama-swap/ByteShape", llamaSwapEndpoint: stand.endpoint };
  const models = configuredModels(config, { provider: "llama-swap", modelId: "ByteShape" });
  const ref = { provider: "llama-swap", modelId: "ByteShape" };
  let session = await openLiveSession({ root, brain, models, model: ref });
  const progress = [];
  session.state.onTelemetry = () => progress.push({ active: session.state.prefillActive, total: session.state.prefillTotal, done: session.state.prefilledTokens, rate: session.state.prefillRate });
  try {
    const submission = await submitInput(session, "what is the answer?");
    // The response body is open: this is the moment ^v finds something to hold.
    await waitUntil(() => session.freeze.live(), "the response body");

    const paused = await togglePause(session);
    assert.equal(paused.held, true, "a live body is held, not interrupted");
    assert.equal(session.freeze.frozen(), true);
    assert.equal(session.state.paused, true);

    // §9: the pause commits and discards nothing. The reply's second half has
    // not been written yet, and while the gate is shut it must not reach the
    // context even once the server sends it.
    stand.release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const heldEntries = await sessionTranscript(session);
    assert.equal(
      JSON.stringify(heldEntries).includes("forty-two"),
      false,
      "while paused the reply has not gone on, even though the server has already sent the rest",
    );

    const resumed = await togglePause(session);
    assert.equal(resumed.resumed, true, "the held stream let go");
    assert.equal(session.state.paused, false);

    // With no tool call in the reply the run would end here, so the stand-in
    // answers a second turn too — but it must be the SAME request that carries
    // the second half of the sentence to the context.
    await submission.wait(BACKGROUND_CONTEXT);
    const entries = await sessionTranscript(session);
    const context = JSON.stringify(entries);
    assert.ok(context.includes("The answer is "), "the first half is in the context");
    assert.ok(context.includes("forty-two."), "and the same response carried the second half");
    assert.equal(stand.requests(), 2, "two requests in all: the paused one, and the turn that ended the run");
    assert.ok(!JSON.stringify(entries).includes("The answer is The answer is"), "the reply was not replayed");
    assert.ok(stand.bodies().every((body) => body.return_progress === true && body.timings_per_token === true));
    assert.ok(progress.some((event) => event.active && event.total === 1000 && event.done === 850 && event.rate === 150), "raw progress reaches the session");
    assert.equal(session.state.lastReportedInput, 1000, "cached tokens count toward the occupied context");
    assert.equal(session.state.lastReportedOutput, 20);
    assert.equal(session.state.prefillRate, 125);
    assert.equal(session.state.decodeRate, 25);
    await closeLiveSession(session);
    session = await openLiveSession({ root, brain, models, model: ref });
    assert.equal(session.state.lastReportedInput, 1000, "the measured fill survives reopening");
    assert.equal(session.state.lastReportedOutput, 20);
  } finally {
    await closeLiveSession(session);
    await stand.close();
    await cleanup();
  }
});

test("pausing while nothing is in flight lands on the next round, and unpausing lets go", async () => {
  const { root, brain, cleanup } = await fixture();
  const { faux, models, factory, ref } = fauxSetup();
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("chat", { text: "hello person" }, { id: "call-chat" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-stop" })], { stopReason: "toolUse" })),
  ]);
  const session = await openLiveSession({ root, brain, models, model: ref });
  try {
    // §9 in the small: the flag, the same-state answer, and the words. No run
    // is in flight here, so the pause says the agent starts nothing of its own.
    const paused = await togglePause(session);
    assert.equal(paused.paused, true);
    assert.equal(paused.changed, true);
    assert.equal(paused.held, false, "no body was in flight to hold");
    assert.match(paused.line, /starts nothing of its own/);
    assert.equal(session.state.paused, true);

    const again = await togglePause(session, true);
    assert.equal(again.changed, false, "asking for the state it is already in changes nothing");
    assert.match(again.line, /already paused/);

    const resumed = await togglePause(session, false);
    assert.equal(resumed.resumed, false, "there was no held body");
    assert.match(resumed.line, /on again/);
    assert.equal(session.state.paused, false);

    // The pause is not told to the agent (§9). Nothing was written to the
    // context by pausing: the store holds only what the turn below writes.
    const before = await sessionTranscript(session);
    await togglePause(session, true);
    await togglePause(session, false);
    const after = await sessionTranscript(session);
    assert.deepEqual(
      after.map((entry) => String(entry.id)),
      before.map((entry) => String(entry.id)),
      "a pause and an unpause write nothing to the context, so the agent is never told it happened",
    );
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});
});
