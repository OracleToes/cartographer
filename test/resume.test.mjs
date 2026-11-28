import "./agent-reminder.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { openBrain } from "../dist/runtime/brain-store.js";
import { runHeadless } from "../dist/runtime/headless.js";
import { configuredModels } from "../dist/runtime/llama-swap-model.js";
import {
  closeLiveSession,
  openLiveSession,
  resumeSession,
  sessionTranscript,
  submitInput,
  togglePause,
  waitForRunEnd,
} from "../dist/runtime/live-session.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "carto-resume-"));
  mkdirSync(join(root, ".brain"), { recursive: true });
  const brain = await openBrain(":memory:");
  return {
    root,
    brain,
    cleanup: async () => {
      await brain.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Each case owns its own project, Brain and provider (and any HTTP server).
// Overlap them to avoid a serial tail at the end of the full suite.
test.describe("resume", { concurrency: 3 }, () => {
test("resumeSession starts an idle agent with a fresh state block and records no person Chat", async () => {
  const { root, brain, cleanup } = await fixture();
  const faux = fauxProvider({
    provider: "faux-resume",
    models: [{ id: "m", contextWindow: 32_768 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);

  const seenBodies = [];
  faux.setResponses([
    (ctx) => {
      seenBodies.push(ctx.messages.map((m) => ({ role: m.role, content: m.content })));
      return fauxAssistantMessage(
        [
          fauxToolCall("chat", { text: "awake from state block" }, { id: "c1" }),
          fauxToolCall("sleep", {}, { id: "c2" }),
        ],
        { stopReason: "toolUse" },
      );
    },
  ]);

  const session = await openLiveSession({
    root,
    brain,
    models,
    model: { provider: "faux-resume", modelId: "m" },
  });
  try {
    const outcome = await resumeSession(session);
    assert.equal(outcome.kind, "started");
    assert.ok(outcome.submission);
    await outcome.submission.wait(BACKGROUND_CONTEXT);
    await waitForRunEnd(session);

    assert.equal(seenBodies.length, 1);
    const last = seenBodies[0].at(-1);
    assert.equal(last.role, "user");
    assert.match(String(last.content), /<carto-state>/);

    // Brain has only the agent's chat, never a fake person message.
    const saved = await brain.read();
    assert.equal(saved.chat.filter((c) => c.author === "user").length, 0);
    assert.equal(saved.chat.filter((c) => c.author === "agent").length, 1);
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

const frame = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

async function waitUntil(predicate, label) {
  for (let i = 0; i < 300; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("resumeSession unpauses a held mid-stream reply without injecting a state block, and is a non-action while running", async () => {
  const { root, brain, cleanup } = await fixture();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    requests += 1;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (requests > 1) {
      res.write(frame({ role: "assistant", content: "" }));
      res.write(frame({ tool_calls: [{ index: 0, id: `c-${requests}`, type: "function", function: { name: "sleep", arguments: "{}" } }] }));
      res.end(`${frame({}, "tool_calls")}data: [DONE]\n\n`);
      return;
    }
    res.write(frame({ role: "assistant", content: "Part one " }));
    void held.then(() => {
      res.write(frame({ content: "and part two." }));
      res.end(`${frame({}, "stop")}data: [DONE]\n\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const models = configuredModels(
    { version: 1, model: "llama-swap/ResumeTest", llamaSwapEndpoint: endpoint },
    { provider: "llama-swap", modelId: "ResumeTest" },
  );
  const session = await openLiveSession({
    root,
    brain,
    models,
    model: { provider: "llama-swap", modelId: "ResumeTest" },
  });
  try {
    const sub = await submitInput(session, "start working");
    await waitUntil(() => session.freeze.live(), "live response stream");

    // While running and not paused, resumeSession is a strict non-action.
    const noop = await resumeSession(session);
    assert.equal(noop.kind, "running");
    assert.equal(requests, 1);

    // Pause while in-flight freezes the stream; resumeSession unpauses it without
    // sending a state block or interrupting the held reply.
    const paused = await togglePause(session, true);
    assert.equal(paused.held, true);
    assert.equal(session.freeze.frozen(), true);

    const unpaused = await resumeSession(session);
    assert.equal(unpaused.kind, "unpaused");
    assert.equal(session.state.paused, false);
    assert.equal(session.freeze.frozen(), false);

    release();
    await sub.wait(BACKGROUND_CONTEXT);
    await waitForRunEnd(session);

    const transcript = JSON.stringify(await sessionTranscript(session));
    assert.ok(transcript.includes("Part one "), "first half preserved");
    assert.ok(transcript.includes("and part two."), "second half streamed through same response");
    assert.equal(requests, 2, "only the held response and its continuation turn ran");
  } finally {
    release();
    await closeLiveSession(session);
    await new Promise((done) => {
      server.closeAllConnections();
      server.close(done);
    });
    await cleanup();
  }
});

test("resumeSession wakes a sleeping agent immediately and unpauses an idle paused agent", async () => {
  const { root, brain, cleanup } = await fixture();
  const faux = fauxProvider({
    provider: "faux-resume-sleep",
    models: [{ id: "m", contextWindow: 32_768 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);

  let turns = 0;
  faux.setResponses([
    () => {
      turns += 1;
      return fauxAssistantMessage([fauxToolCall("sleep", { seconds: 600 }, { id: "s1" })], { stopReason: "toolUse" });
    },
    () => {
      turns += 1;
      return fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "s2" })], { stopReason: "toolUse" });
    },
  ]);

  const session = await openLiveSession({
    root,
    brain,
    models,
    model: { provider: "faux-resume-sleep", modelId: "m" },
  });
  try {
    // First turn puts the agent into a 600s sleep.
    const first = await resumeSession(session);
    assert.equal(first.kind, "started");
    await first.submission.wait(BACKGROUND_CONTEXT);
    await waitForRunEnd(session);
    assert.equal(turns, 1);

    // Pause while idle, then resumeSession unpauses AND wakes immediately.
    await togglePause(session, true);
    assert.equal(session.state.paused, true);
    const second = await resumeSession(session);
    assert.equal(second.kind, "started");
    assert.equal(session.state.paused, false);
    await second.submission.wait(BACKGROUND_CONTEXT);
    await waitForRunEnd(session);
    assert.equal(turns, 2);
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("headless /resume starts the agent without sending a person message", async () => {
  const { root, brain, cleanup } = await fixture();
  const faux = fauxProvider({
    provider: "faux-headless-resume",
    models: [{ id: "m", contextWindow: 32_768 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);

  faux.setResponses([
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall("chat", { text: "resumed in headless" }, { id: "h1" }),
          fauxToolCall("sleep", {}, { id: "h2" }),
        ],
        { stopReason: "toolUse" },
      ),
  ]);

  const input = new PassThrough();
  const out = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      out.push(String(chunk));
      cb();
    },
  });
  const error = new Writable({ write(_c, _e, cb) { cb(); } });

  try {
    const run = runHeadless({
      root,
      brain,
      models,
      model: { provider: "faux-headless-resume", modelId: "m" },
      input,
      output,
      error,
    });
    input.write("/resume\n/quit\n");
    input.end();
    const code = await run;
    assert.equal(code, 0);
    assert.match(out.join(""), /carto: resumed in headless/);
    assert.equal((await brain.read()).chat.filter((c) => c.author === "user").length, 0);
  } finally {
    await cleanup();
  }
});
});
