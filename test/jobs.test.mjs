import "./agent-reminder.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

import { emptyBrain } from "../dist/domain/records.js";
import { renderStateBlock } from "../dist/domain/state-block.js";
import { openBrain } from "../dist/runtime/brain-store.js";
import {
  createJobTable,
  readJob,
  sendJob,
  snapshotJobs,
  startJob,
  stopAllJobs,
  stopJob,
  summarizeJobs,
} from "../dist/runtime/jobs.js";
import { createTools } from "../dist/runtime/tools.js";
import { closeLiveSession, collapseLiveSession, openLiveSession } from "../dist/runtime/live-session.js";
import { JobsView } from "../dist/ui/jobs-view.js";
import { Sidebar } from "../dist/ui/sidebar.js";
import { JUMP_TARGETS } from "../dist/ui/jump.js";

const stripAnsi = (value) => value.replace(/\u001b\[[0-9;]*m/g, "");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "carto-jobs-"));
}

// Tiny interactive line-echo REPL running over stdin/stdout pipes.
const REPL_CMD = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
  "const rl = require('readline').createInterface({ input: process.stdin });" +
  "process.stdout.write('ready\\n');" +
  "rl.on('line', (line) => {" +
  "  if (line === 'quit') { console.log('bye'); process.exit(0); }" +
  "  if (line === 'err') { console.error('boom'); return; }" +
  "  console.log('echo:' + line);" +
  "});",
)}`;

test("jobs runtime: start, send, delta read, tailLines, and stop", async () => {
  const root = tempDir();
  const table = createJobTable({ root });
  try {
    const started = await startJob(table, { command: REPL_CMD, label: "echo repl", waitMs: 2000 });
    assert.equal(started.handle, "J1");
    assert.equal(started.label, "echo repl");
    assert.equal(started.status, "running");
    assert.match(started.output, /ready/);

    const sent = await sendJob(table, { handle: "J1", input: "hello world", waitMs: 2000 });
    assert.equal(sent.status, "running");
    assert.match(sent.output, /echo:hello world/);

    // Subsequent delta read returns nothing when no new output arrived.
    const emptyRead = await readJob(table, { handle: "J1" });
    assert.equal(emptyRead.output, "");

    // stderr is prefixed cleanly.
    const errRes = await sendJob(table, { handle: "J1", input: "err", waitMs: 2000 });
    assert.match(errRes.output, /\[stderr\] boom/);

    // tailLines replays buffered history without losing echoed stdin.
    const tail = await readJob(table, { handle: "J1", tailLines: 10 });
    assert.match(tail.output, /ready/);
    assert.match(tail.output, /> hello world/);
    assert.match(tail.output, /echo:hello world/);

    const stopped = await stopJob(table, "J1");
    assert.equal(stopped.status, "exited");
    assert.equal(summarizeJobs(table).length, 0);
  } finally {
    await stopAllJobs(table);
    rmSync(root, { recursive: true, force: true });
  }
});

test("jobs runtime: async non-blocking return, abort without killing, and shared person stdin", async () => {
  const root = tempDir();
  const table = createJobTable({ root });
  try {
    const started = await startJob(table, { command: REPL_CMD, label: "shared repl", waitMs: 2000 });
    assert.equal(started.handle, "J1");

    // Person types into the TUI (source: "user", non-blocking): both the echoed
    // stdin and the child's reply remain unread for the agent.
    await sendJob(table, { handle: "J1", input: "from-person", source: "user", waitMs: 0 });
    // Wait briefly via readJob for the child's reply to arrive.
    const agentRead = await readJob(table, { handle: "J1", waitMs: 1500 });
    assert.match(agentRead.output, /> from-person/);
    assert.match(agentRead.output, /echo:from-person/);

    // Aborting a read wait cancels the wait immediately without killing the job.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const aborted = await readJob(table, { handle: "J1", waitMs: 5000, abortSignal: ac.signal });
    assert.equal(aborted.status, "running");
    assert.equal(aborted.settled, false);

    // Job is still alive and responsive after the aborted wait.
    const afterAbort = await sendJob(table, { handle: "J1", input: "still-here", waitMs: 2000 });
    assert.match(afterAbort.output, /echo:still-here/);
  } finally {
    await stopAllJobs(table);
    rmSync(root, { recursive: true, force: true });
  }
});

test("state block renders compact jobs summary only when jobs exist", () => {
  const base = {
    person: "OracleToes",
    contextWindow: 100_000,
    systemTokens: 1000,
    transcriptTokens: 500,
    toolWorkTokens: 200,
    toolWorkSince: 0,
    sizes: { atlas: 0, ledger: 0, chat: 0, ephemera: 0 },
    mode: "edit",
    pending: [],
    stale: [],
    resolveHandle: () => undefined,
    pinned: [],
    marks: [],
    tree: { root: "/project", depth: 1, lines: [] },
  };

  const withoutJobs = renderStateBlock(base);
  assert.doesNotMatch(withoutJobs, /^jobs:/m);

  const withJobs = renderStateBlock({
    ...base,
    jobs: [
      { handle: "J1", label: "dev server", status: "running", exitCode: null, exitSignal: null, unreadLines: 5, quietMs: 4000, active: false },
      { handle: "J2", label: "repl", status: "running", exitCode: null, exitSignal: null, unreadLines: 0, quietMs: 2000, active: false },
      { handle: "J3", label: "build", status: "exited", exitCode: 0, exitSignal: null, unreadLines: 1, quietMs: 100, active: false },
    ],
  });
  assert.match(withJobs, /^jobs:\n/m);
  assert.match(withJobs, /J1 "dev server" · running · 5 unread lines \(quiet 4s\)/);
  assert.match(withJobs, /J2 "repl" · running · idle/);
  assert.match(withJobs, /J3 "build" · exited\(0\) · 1 unread line/);
});

test("proc tool has clean description and drives persistent jobs", async () => {
  const root = tempDir();
  const jobs = createJobTable({ root });
  try {
    const tools = createTools({
      root,
      brain: { read: async () => emptyBrain() },
      session: {
        person: "OracleToes",
        pending: [],
        tree: { anchor: root, depth: 2 },
        collapseRequested: null,
        generation: "gen-test",
        readOnly: false,
      },
      jobs,
    });
    const proc = tools.find((tool) => tool.name === "proc");
    assert.ok(proc, "proc tool is registered");
    assert.doesNotMatch(proc.description, /—/, "proc description uses no em dashes");
    assert.match(proc.description, /OracleToes/);

    const started = await proc.execute(
      { action: "start", command: REPL_CMD, label: "tool repl", waitMs: 2000 },
      {},
      { abortSignal: new AbortController().signal },
    );
    assert.match(started.output[0].text, /Started J1 "tool repl" \[running\]/);
    assert.match(started.output[0].text, /ready/);

    const sent = await proc.execute(
      { action: "send", handle: "J1", input: "ping", waitMs: 2000 },
      {},
      { abortSignal: new AbortController().signal },
    );
    assert.match(sent.output[0].text, /echo:ping/);

    const stopped = await proc.execute(
      { action: "stop", handle: "J1" },
      {},
      { abortSignal: new AbortController().signal },
    );
    assert.match(stopped.output[0].text, /Stopped J1/);
  } finally {
    await stopAllJobs(jobs);
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistent jobs survive context collapse and stop cleanly on shutdown", async () => {
  const root = tempDir();
  mkdirSync(join(root, ".brain"), { recursive: true });
  const brain = await openBrain(join(root, ".brain/brain.db"));
  const faux = fauxProvider({
    provider: "fake",
    models: [{ id: "m", contextWindow: 64_000, maxTokens: 4_000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const jobs = createJobTable({ root });
  const options = { root, brain, models, model: { provider: "fake", modelId: "m" }, jobs };
  let session = await openLiveSession(options);
  try {
    await startJob(session.jobs, { command: REPL_CMD, label: "survivor", waitMs: 2000 });
    assert.equal(summarizeJobs(session.jobs).length, 1);

    const outcome = await collapseLiveSession(session, options, "test collapse");
    session = outcome.session;
    assert.equal(session.jobs, jobs);
    assert.equal(summarizeJobs(session.jobs).length, 1);

    // Process is still alive after collapse!
    const ping = await sendJob(session.jobs, { handle: "J1", input: "post-collapse", waitMs: 2000 });
    assert.match(ping.output, /echo:post-collapse/);
  } finally {
    await stopAllJobs(jobs);
    await closeLiveSession(session);
    await brain.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("JobsView, Sidebar, and JumpOverlay wire the jobs book cleanly", async () => {
  const root = tempDir();
  const table = createJobTable({ root });
  try {
    await startJob(table, { command: REPL_CMD, label: "dev harness", waitMs: 2000 });
    await sendJob(table, { handle: "J1", input: "hi", source: "user", waitMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 120));

    const view = new JobsView();
    const events = [];
    view.onSend = (handle, text) => events.push(["send", handle, text]);
    view.onStart = (cmd) => events.push(["start", cmd]);
    view.onSignal = (handle, sig) => events.push(["signal", handle, sig]);
    view.onStop = (handle) => events.push(["stop", handle]);

    view.setData(snapshotJobs(table));
    const listText = stripAnsi(view.listPane.render(32).join("\n"));
    const detailText = stripAnsi(view.detailPane.render(80).join("\n"));
    assert.match(listText, /J1/);
    assert.match(listText, /dev harness/);
    assert.match(detailText, /ready/);
    assert.match(detailText, /> hi/);

    // Enter send mode, type a line, submit, then escape back to browse.
    view.handleInput("i");
    assert.equal(view.isTyping(), true);
    assert.equal(view.inputMode(), "send");
    for (const ch of "status") view.handleInput(ch);
    view.handleInput("\r");
    assert.deepEqual(events[0], ["send", "J1", "status"]);
    view.handleInput("\x1b");
    assert.equal(view.isTyping(), false);

    // Start mode via `n`.
    view.handleInput("n");
    assert.equal(view.inputMode(), "start");
    for (const ch of "echo ok") view.handleInput(ch);
    view.handleInput("\r");
    assert.deepEqual(events[1], ["start", "echo ok"]);
    assert.equal(view.isTyping(), false);

    // Signal (`s`) and stop (`d`).
    view.handleInput("s");
    view.handleInput("d");
    assert.deepEqual(events[2], ["signal", "J1", "SIGINT"]);
    assert.deepEqual(events[3], ["stop", "J1"]);

    // Sidebar renders the jobs book with count + unread dot, and JUMP_TARGETS maps `j`.
    const sidebar = new Sidebar();
    sidebar.setCounts({
      chat: 1,
      jobs: 1,
      jobsUnread: 1,
      contextTokens: 1000,
      atlas: 0,
      ledger: 0,
      marked: {},
      stale: {},
      staleTotal: 0,
      treeDirs: 0,
      treeFiles: 0,
      archive: 0,
      archivePinned: 0,
    });
    const sidebarText = stripAnsi(sidebar.render(28).join("\n"));
    assert.match(sidebarText, /jobs/);
    assert.ok(JUMP_TARGETS.some((target) => target.key === "j" && target.view === "jobs"));
  } finally {
    await stopAllJobs(table);
    rmSync(root, { recursive: true, force: true });
  }
});
