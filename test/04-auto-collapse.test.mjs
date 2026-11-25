/**
 * The agent keeps its own context small: the 75% warning, a collapse the agent
 * or the model's limits ask for being carried out and resumed without a person,
 * the bound on repeating it, and the person's messages surviving it. Offline:
 * the faux provider scripts every response, and each case owns its project.
 */
import "./agent-reminder.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test, { describe } from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";
import { Registry, stopCommand } from "../dist/ui/commands.js";
import { RunActivity } from "../dist/ui/run-activity.js";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { openBrain } from "../dist/runtime/brain-store.js";
import { runHeadless } from "../dist/runtime/headless.js";
import {
  closeLiveSession,
  collapseLiveSession,
  interruptRun,
  openLiveSession,
  sessionTranscript,
  submitInput,
  waitForRunEnd,
} from "../dist/runtime/live-session.js";

const OVERFLOW = "400 request (70000 tokens) exceeds the available context size (64000 tokens), try increasing it";
const NOW = () => 1_700_000_000_000;

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "carto-auto-"));
  mkdirSync(join(root, ".brain"), { recursive: true });
  const brain = await openBrain(":memory:");
  return { root, brain, cleanup: async () => { await brain.close(); rmSync(root, { recursive: true, force: true }); } };
};
const fauxFor = ({ contextWindow = 100_000, maxTokens } = {}) => {
  const faux = fauxProvider({ provider: "faux-test", models: [{ id: "faux-model", contextWindow, ...(maxTokens === undefined ? {} : { maxTokens }) }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const captured = [];
  const factory = (build) => async (context) => {
    captured.push(structuredClone(context.messages));
    return build(context);
  };
  return { faux, models, captured, factory, ref: { provider: "faux-test", modelId: "faux-model" } };
};
const sleepCall = (factory) => factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: `sleep-${Math.random()}` })], { stopReason: "toolUse" }));
const collapseCall = (factory, message = "Collapsing context and continuing from the Brain.") =>
  factory(() => fauxAssistantMessage([fauxToolCall("collapse", { message }, { id: `collapse-${Math.random()}` })], { stopReason: "toolUse" }));
// A provider that refuses the request: the scripted factory throws, and faux turns that into the error message pi sees.
const overflow = (factory) => factory(() => { throw new Error(OVERFLOW); });
const flat = (messages) => JSON.stringify(messages);
const blockOf = (messages) => messages.find((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("<carto-state>"));
const textOf = (message) => typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");

/** Open, send one line, wait for the whole chain of runs to end. */
const ask = async (session, text) => {
  const submission = await submitInput(session, text);
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  await waitForRunEnd(session);
  return settled;
};
const options = ({ root, brain, models, ref }, extra = {}) => ({ root, brain, models, model: ref, now: NOW, ...extra });
/** Carry out the collapse the session asked for, as a host does. */
const carryOut = async (session, opts) => {
  const verdict = session.reviewCollapseRequest();
  assert.equal(verdict.kind, "collapse", `expected a collapse, got ${JSON.stringify(verdict)}`);
  const outcome = await collapseLiveSession(session, opts, verdict.reason, {}, { automatic: true, trigger: verdict.trigger });
  await waitForRunEnd(outcome.session);
  return outcome;
};
const userTexts = async (session) =>
  (await session.conversation.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "user").map(textOf).filter((text) => !text.includes("<carto-state>"));

describe("automatic collapse", { concurrency: 4 }, () => {
  test("Ctrl-X can stop an autonomously resumed post-collapse run", async () => {
    const env = await fixture();
    const { faux, models, factory, ref } = fauxFor();
    faux.setResponses([
      collapseCall(factory),
      factory(() => fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" }, { id: "post-collapse-bash" })], { stopReason: "toolUse" })),
    ]);
    const opts = options({ ...env, models, ref });
    const first = await openLiveSession(opts);
    let next;
    try {
      await ask(first, "collapse then work");
      const verdict = first.reviewCollapseRequest();
      assert.equal(verdict.kind, "collapse");
      const outcome = await collapseLiveSession(first, opts, verdict.reason, {}, { automatic: true, trigger: verdict.trigger });
      next = outcome.session;
      assert.equal(outcome.resumed, true);
      let live;
      for (let i = 0; i < 200; i++) {
        live = await next.harness.snapshot(LiveDoc, next.conversation.id, BACKGROUND_CONTEXT);
        if (live?.run !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(live?.run, "the new generation has a run without a UI submission");
      const activity = new RunActivity();
      activity.observeRun(true);
      assert.equal(activity.running, true);
      let stopped;
      const registry = new Registry([stopCommand(() => { stopped = interruptRun(next); })]);
      assert.equal(registry.dispatch("\x18"), true);
      assert.equal(await stopped, true);
      await waitForRunEnd(next);
      assert.equal((await next.harness.snapshot(LiveDoc, next.conversation.id, BACKGROUND_CONTEXT))?.run, undefined);
    } finally {
      await closeLiveSession(next ?? first).catch(() => undefined);
      await env.cleanup();
    }
  });

  test("the block warns at 75 percent of a known window and reports an unknown one honestly", async () => {
    for (const [contextWindow, expect] of [[1000, "warn"], [1_000_000, "fill"], [0, "unknown"]]) {
      const env = await fixture();
      const { faux, models, captured, factory, ref } = fauxFor({ contextWindow });
      faux.setResponses([sleepCall(factory)]);
      const session = await openLiveSession(options({ ...env, models, ref }));
      try {
        assert.equal(session.state.contextWindow, contextWindow);
        await ask(session, "how full are you");
        const block = blockOf(captured[0]).content;
        if (expect === "warn") assert.match(block, /context fill: ~\d+% · \[COLLAPSE NEEDED\] Write down what you need to continue/);
        if (expect === "fill") {
          assert.match(block, /context fill: ~\d+%/);
          assert.doesNotMatch(block, /COLLAPSE NEEDED/);
        }
        if (expect === "unknown") {
          assert.match(block, /the window is unknown/);
          assert.doesNotMatch(block, /context fill:|COLLAPSE NEEDED/);
        }
      } finally {
        await closeLiveSession(session);
        await env.cleanup();
      }
    }
  });

  test("a configured collapseWarningPercent drives both the state block warning and the stall bound", async () => {
    const env = await fixture();
    // With a 10,000-token window, the baseline system/tool prompt is well under 75% (around 15-30%).
    const { faux, models, captured, factory, ref } = fauxFor({ contextWindow: 10_000 });
    faux.setResponses([
      collapseCall(factory),
      factory(() => fauxAssistantMessage([fauxToolCall("chat", { text: "did a step" }, { id: "chat-step" })], { stopReason: "toolUse" })),
      collapseCall(factory),
    ]);
    const opts = options({ ...env, models, ref }, { collapseWarningPercent: 10, treePageSize: 7 });
    const first = await openLiveSession(opts);
    let second;
    try {
      assert.equal(first.state.collapseWarningPercent, 10);
      assert.equal(first.state.tree.limit, 7);
      await ask(first, "check the lower threshold");
      assert.match(blockOf(captured[0]).content, /context fill: ~\d+% · \[COLLAPSE NEEDED\]/, "warns at the configured 10% threshold, well below 75%");
      // After automatic collapse, the new generation starts above the configured 10% warning fill,
      // so even after doing a step, asking to collapse again is caught by the stall bound.
      second = (await carryOut(first, opts)).session;
      assert.equal(second.state.collapseWarningPercent, 10, "the configured threshold survives collapse");
      assert.equal(second.state.tree.limit, 7, "the configured tree page size survives collapse");
      assert.equal(second.reviewCollapseRequest().kind, "stop");
    } finally {
      await closeLiveSession(second ?? first).catch(() => undefined);
      await env.cleanup();
    }
  });

  test("an agent-requested collapse rebuilds from the Brain and resumes on a state block, no message needed", async () => {
    const env = await fixture();
    const { faux, models, captured, factory, ref } = fauxFor();
    faux.setResponses([
      collapseCall(factory),
      factory(() => fauxAssistantMessage([fauxToolCall("chat", { text: "back, from the Brain alone" }, { id: "chat-after" })], { stopReason: "toolUse" })),
      sleepCall(factory),
    ]);
    const opts = options({ ...env, models, ref });
    const session = await openLiveSession(opts);
    let next;
    try {
      await ask(session, "please reset the context, zebra");
      assert.equal(captured.length, 1, "the collapse tool ends the run; nothing continues in the old context");
      const outcome = await carryOut(session, opts);
      next = outcome.session;
      assert.equal(outcome.resumed, true);
      assert.equal(outcome.carried, 0);
      assert.notEqual(outcome.session.generation, session.generation);
      assert.equal(captured.length, 3, "the new generation worked on its own: a chat, then a rest");
      assert.ok(blockOf(captured[1]), "the first request after the rebuild is a state block");
      // The old context's turns are gone, but what the person said is Chat: it
      // is a Brain record and the rebuilt head holds it, once (§2.3, §3.2).
      assert.equal(flat(captured[1]).split("zebra").length - 1, 1, "the person's words come back once, from the Brain");
      assert.deepEqual((await env.brain.read()).chat.map((record) => [record.author, record.text]), [
        ["user", "please reset the context, zebra"],
        ["agent", "Collapsing context and continuing from the Brain."],
        ["agent", "back, from the Brain alone"],
      ]);
      assert.equal(next.state.rebuiltAutomatically, true);
      // Agent collapse writes its required agent Chat message, not a duplicate System notice,
      // and appends a diagnostic collapse-log entry with last <carto-state> and body trace.
      const { readCollapseLog, formatCollapseHistory } = await import("../dist/runtime/collapse-log.js");
      const history = readCollapseLog(env.root);
      assert.equal(history.length, 1);
      assert.equal(history[0].trigger, "agent");
      assert.equal(history[0].fromGeneration, session.generation);
      assert.equal(history[0].toGeneration, next.generation);
      assert.match(history[0].lastStateBlock ?? "", /<carto-state>/);
      assert.ok(history[0].bodyEntries.some((entry) => entry.body.includes("please reset the context, zebra")));
      const formatted = formatCollapseHistory(history);
      assert.match(formatted, /collapse #1/);
      assert.match(formatted, /trigger: agent/);
      assert.match(formatted, /last <carto-state> before collapse/);
    } finally {
      await closeLiveSession(next ?? session).catch(() => undefined);
      await env.cleanup();
    }
  });

  test("a person's own collapse starts nothing: only an automatic one resumes", async () => {
    const env = await fixture();
    const { faux, models, captured, ref } = fauxFor();
    void faux;
    const opts = options({ ...env, models, ref });
    const session = await openLiveSession(opts);
    const outcome = await collapseLiveSession(session, opts, "person requested");
    try {
      assert.equal(outcome.resumed, false);
      assert.equal(outcome.carried, 0);
      assert.equal(outcome.session.state.rebuiltAutomatically, false);
      assert.equal(captured.length, 0);
      assert.equal((await env.brain.read()).chat.filter((record) => record.author === "system").length, 0, "manual collapse writes no system Chat notice");
    } finally {
      await closeLiveSession(outcome.session);
      await env.cleanup();
    }
  });

  test("a length stop below the output limit is the one bounded recovery: collapse, then resume", async () => {
    const env = await fixture();
    const { faux, models, captured, factory, ref } = fauxFor();
    faux.setResponses([
      factory(() => fauxAssistantMessage([fauxText("The")], { stopReason: "length" })),
      sleepCall(factory),
    ]);
    const opts = options({ ...env, models, ref });
    const session = await openLiveSession(opts);
    let next;
    try {
      await ask(session, "work on the thing");
      assert.equal(captured.length, 1, "no marker continuation after a length stop that may be the context");
      assert.match(session.state.collapseRequested, /length limit with room left in its output/);
      const outcome = await carryOut(session, opts);
      next = outcome.session;
      assert.equal(captured.length, 2);
      assert.equal(outcome.carried, 0, "the person's message was answered; only a state block resumes");
      assert.ok(blockOf(captured[1]));
    } finally {
      await closeLiveSession(next ?? session).catch(() => undefined);
      await env.cleanup();
    }
  });

  test("a length stop at the intended limit is an ordinary answer and continues without a collapse", async () => {
    const env = await fixture();
    const { faux, models, captured, factory, ref } = fauxFor({ maxTokens: 5 });
    faux.setResponses([
      factory(() => fauxAssistantMessage([fauxText("a long enough line to reach the limit of five tokens")], { stopReason: "length" })),
      sleepCall(factory),
    ]);
    const session = await openLiveSession(options({ ...env, models, ref }));
    try {
      assert.equal(session.state.desiredMaxOutput, 5);
      await ask(session, "write a lot");
      assert.equal(captured.length, 2, "continued with a state block, as any answer is");
      assert.equal(session.state.collapseRequested, null);
      assert.equal(session.reviewCollapseRequest().kind, "none");
    } finally {
      await closeLiveSession(session);
      await env.cleanup();
    }
  });

  test("a provider overflow error asks for a collapse, and the message it killed is carried, not lost", async () => {
    const env = await fixture();
    const { faux, models, captured, factory, ref } = fauxFor();
    faux.setResponses([overflow(factory), sleepCall(factory)]);
    const opts = options({ ...env, models, ref });
    const session = await openLiveSession(opts);
    let next;
    try {
      const settled = await ask(session, "ask about the quokka");
      assert.equal(settled.status, "unanswered");
      assert.match(session.state.collapseRequested, /the context overflowed: .*exceeds the available context size/);
      const outcome = await carryOut(session, opts);
      next = outcome.session;
      assert.equal(outcome.carried, 1);
      assert.equal(captured.length, 2);
      assert.match(flat(captured[1]), /ask about the quokka/);
      assert.deepEqual((await userTexts(next)).filter((text) => text.includes("quokka")), ["ask about the quokka"]);
      // Forced automatic collapse records a System Chat notice before freezing the new head.
      const systemChats = (await env.brain.read()).chat.filter((record) => record.author === "system");
      assert.equal(systemChats.length, 1, "automatic overflow collapse records one system Chat message");
      assert.match(systemChats[0].text, /Automatic context collapse \(the context overflowed:/);
      assert.match(flat(captured[1]), /\[system\]/, "the rebuilt frozen head carries the [system] Chat notice");
    } finally {
      await closeLiveSession(next ?? session).catch(() => undefined);
      await env.cleanup();
    }
  });

  test("messages queued behind a failing run are carried in order, once each", async () => {
    const env = await fixture();
    const { faux, models, captured, factory, ref } = fauxFor();
    let live;
    faux.setResponses([
      factory(async () => {
        await submitInput(live, "second, queued while it failed", "followUp");
        throw new Error(OVERFLOW);
      }),
      sleepCall(factory),
      sleepCall(factory),
    ]);
    const opts = options({ ...env, models, ref });
    const session = await openLiveSession(opts);
    live = session;
    let next;
    try {
      await ask(session, "first, the one that failed");
      const outcome = await carryOut(session, opts);
      next = outcome.session;
      assert.equal(outcome.carried, 2);
      assert.equal(captured.length, 3);
      assert.deepEqual(
        (await userTexts(next)).filter((text) => /first|second/.test(text)),
        ["first, the one that failed", "second, queued while it failed"],
      );
      const records = (await env.brain.read()).chat.filter((record) => record.author === "user");
      const identities = (await sessionTranscript(next)).filter((entry) => entry.kind === "carto.user").map((entry) => entry.data.chatRecordId);
      assert.deepEqual(identities, records.map((record) => record.id), "failed and queued inputs retain their original identities");
      const sidecar = JSON.parse(readFileSync(next.markdownPath.replace(/\.md$/, ".json"), "utf8"));
      assert.ok(records.every((record) => !sidecar.chat.includes(record.id)), "carried records are in the body, not duplicated in the head");
    } finally {
      await closeLiveSession(next ?? session).catch(() => undefined);
      await env.cleanup();
    }
  });

  test("a pause is kept through the collapse: the person's message is delivered, a state block is not", async () => {
    const env = await fixture();
    const { faux, models, captured, factory, ref } = fauxFor();
    faux.setResponses([overflow(factory), sleepCall(factory)]);
    const opts = options({ ...env, models, ref });
    const session = await openLiveSession(opts);
    let next;
    try {
      await ask(session, "a question from before the pause");
      session.state.paused = true;
      const outcome = await carryOut(session, opts);
      next = outcome.session;
      assert.equal(next.state.paused, true);
      assert.equal(outcome.carried, 1, "the person's own words are never held back");
      assert.equal(captured.length, 2);
    } finally {
      await closeLiveSession(next ?? session).catch(() => undefined);
      await env.cleanup();
    }
  });

  test("a rebuilt generation that works may collapse again; one that does nothing is stopped", async () => {
    const env = await fixture();
    const { faux, models, captured, factory, ref } = fauxFor();
    faux.setResponses([
      collapseCall(factory),
      factory(() => fauxAssistantMessage([fauxToolCall("chat", { text: "did something" }, { id: "chat-work" })], { stopReason: "toolUse" })),
      collapseCall(factory),
      collapseCall(factory),
    ]);
    const opts = options({ ...env, models, ref });
    const first = await openLiveSession(opts);
    const sessions = [first];
    try {
      await ask(first, "reset");
      const second = (await carryOut(first, opts)).session;
      sessions.push(second);
      // The second generation did a step before asking again: allowed.
      assert.equal(second.reviewCollapseRequest().kind, "collapse");
      assert.equal(captured.length, 3);
      second.state.collapseRequested = "the agent collapsed";
      const third = (await carryOut(second, opts)).session;
      sessions.push(third);
      // The third did nothing before asking: stopped, with the reason said.
      const verdict = third.reviewCollapseRequest();
      assert.equal(verdict.kind, "stop");
      assert.match(verdict.explanation, /^Collapse stopped: the context was rebuilt from the Brain, then ended again/);
      assert.match(verdict.explanation, /the agent collapsed/);
      assert.equal(third.state.collapseRequested, null);
      assert.equal(third.reviewCollapseRequest().kind, "none", "the request is taken once");
      assert.equal(captured.length, 4, "nothing more was requested of the model after the stop");
    } finally {
      for (const session of sessions) await closeLiveSession(session).catch(() => undefined);
      await env.cleanup();
    }
  });

  test("a rebuilt context that still overflows stops after the one retry instead of looping", async () => {
    const env = await fixture();
    const { faux, models, captured, factory, ref } = fauxFor();
    faux.setResponses([overflow(factory), overflow(factory), sleepCall(factory)]);
    const opts = options({ ...env, models, ref });
    const first = await openLiveSession(opts);
    let second;
    try {
      await ask(first, "a request that is too big");
      second = (await carryOut(first, opts)).session;
      assert.equal(captured.length, 2, "exactly one retry in the rebuilt context");
      const verdict = second.reviewCollapseRequest();
      assert.equal(verdict.kind, "stop");
      assert.match(verdict.reason, /exceeds the available context size/);
      assert.equal(captured.length, 2);
      assert.equal(faux.getPendingResponseCount(), 1, "the model was not asked again");
    } finally {
      await closeLiveSession(second ?? first).catch(() => undefined);
      await env.cleanup();
    }
  });

  test("the person speaking again clears the stall, so the next collapse is judged afresh", async () => {
    const env = await fixture();
    const { faux, models, factory, ref } = fauxFor();
    faux.setResponses([collapseCall(factory), collapseCall(factory), collapseCall(factory)]);
    const opts = options({ ...env, models, ref });
    const first = await openLiveSession(opts);
    let second;
    try {
      await ask(first, "reset");
      second = (await carryOut(first, opts)).session;
      assert.equal(second.state.rebuiltAutomatically, true);
      await submitInput(second, "try again, I changed something").then((submission) => submission.wait(BACKGROUND_CONTEXT));
      await waitForRunEnd(second);
      assert.equal(second.state.rebuiltAutomatically, false);
      assert.equal(second.reviewCollapseRequest().kind, "collapse");
    } finally {
      await closeLiveSession(second ?? first).catch(() => undefined);
      await env.cleanup();
    }
  });
});

describe("automatic collapse in the headless driver", { concurrency: 4 }, () => {
  const captureStream = () => {
    let text = "";
    const stream = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
    return { stream, text: () => text };
  };
  const lines = (list) => { const stream = new PassThrough(); stream.end(`${list.join("\n")}\n`); return stream; };
  const chat = (factory, text) => factory(() => fauxAssistantMessage([fauxToolCall("chat", { text }, { id: `chat-${text}` })], { stopReason: "toolUse" }));

  test("the agent's collapse is carried out and it goes on by itself", async () => {
    const env = await fixture();
    const { faux, models, captured, factory, ref } = fauxFor();
    faux.setResponses([collapseCall(factory), chat(factory, "resumed after the collapse"), sleepCall(factory)]);
    const out = captureStream();
    try {
      const code = await runHeadless({ ...options({ ...env, models, ref }), input: lines(["begin", "/quit"]), output: out.stream });
      assert.equal(code, 0);
      assert.match(out.text(), /context collapsed and rebuilt from the Brain/);
      assert.match(out.text(), /the agent collapsed — the agent goes on/);
      assert.match(out.text(), /carto: resumed after the collapse/);
      assert.equal(captured.length, 3);
    } finally {
      await env.cleanup();
    }
  });

  test("an overflow is recovered once, says so, and carries the message instead of reporting a dead run", async () => {
    const env = await fixture();
    const { faux, models, captured, factory, ref } = fauxFor();
    faux.setResponses([overflow(factory), chat(factory, "recovered"), sleepCall(factory)]);
    const out = captureStream();
    const err = captureStream();
    try {
      await runHeadless({ ...options({ ...env, models, ref }), input: lines(["a heavy question", "/quit"]), output: out.stream, error: err.stream });
      assert.match(out.text(), /the context overflowed: .*exceeds the available context size.*1 unanswered message\(s\) carried over — the agent goes on/);
      assert.match(out.text(), /system: Automatic context collapse \(the context overflowed:/);
      assert.match(out.text(), /carto: recovered/);
      assert.doesNotMatch(err.text(), /nothing was left to do/);
      assert.match(flat(captured[1]), /a heavy question/);
    } finally {
      await env.cleanup();
    }
  });

  test("a rebuild that gets nowhere is reported and not repeated", async () => {
    const env = await fixture();
    const { faux, models, captured, factory, ref } = fauxFor();
    faux.setResponses([overflow(factory), overflow(factory), sleepCall(factory)]);
    const out = captureStream();
    const err = captureStream();
    try {
      const code = await runHeadless({ ...options({ ...env, models, ref }), input: lines(["too big", "/quit"]), output: out.stream, error: err.stream });
      assert.equal(code, 0);
      assert.match(err.text(), /Collapse stopped: the context was rebuilt from the Brain, then ended again/);
      assert.equal(captured.length, 2);
      assert.equal(out.text().match(/context collapsed and rebuilt/g).length, 1);
    } finally {
      await env.cleanup();
    }
  });

  test("a timed wake that asks to collapse is carried out with no line from the person", async () => {
    const env = await fixture();
    let clock = 1_700_000_000_000;
    const timers = [];
    const setTimer = (callback, delayMs) => {
      const timer = { due: clock + delayMs, callback };
      timers.push(timer);
      return () => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); };
    };
    const { faux, models, captured, factory, ref } = fauxFor();
    faux.setResponses([
      factory(() => fauxAssistantMessage([fauxToolCall("sleep", { seconds: 10 }, { id: "rest" })], { stopReason: "toolUse" })),
      collapseCall(factory),
      chat(factory, "woke, collapsed, and went on"),
      sleepCall(factory),
    ]);
    const input = new PassThrough();
    const out = captureStream();
    const done = runHeadless({ ...options({ ...env, models, ref }, { now: () => clock, setTimer }), input, output: out.stream });
    try {
      input.write("rest a while\n");
      const deadline = Date.now() + 5000;
      while (!/carto: woke, collapsed, and went on/.test(out.text()) && Date.now() < deadline) {
        clock += 11_000;
        for (const due of timers.filter((timer) => timer.due <= clock)) {
          timers.splice(timers.indexOf(due), 1);
          due.callback();
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.match(out.text(), /carto: woke, collapsed, and went on/);
      assert.match(out.text(), /context collapsed and rebuilt from the Brain/);
      assert.equal(captured.length, 4);
    } finally {
      input.end("/quit\n");
      await done;
      await env.cleanup();
    }
  });
});
