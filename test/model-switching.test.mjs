import "./agent-reminder.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { visibleWidth } from "@earendil-works/pi-tui";

import { openBrain } from "../dist/runtime/brain-store.js";
import { createInferenceAdmission } from "../dist/runtime/inference-admission.js";
import { loadGlobalConfig, saveGlobalConfig, updateConfigModel } from "../dist/runtime/config.js";
import { runHeadless } from "../dist/runtime/headless.js";
import { closeLiveSession, openLiveSession, submitInput, switchSessionModel, waitForRunEnd } from "../dist/runtime/live-session.js";
import { configuredModels } from "../dist/runtime/llama-swap-model.js";
import { indexModels, resolveIndexedModel } from "../dist/runtime/model-catalog.js";
import { ModelPicker } from "../dist/ui/model-picker.js";

const stripAnsi = (value) => value.replace(/\x1b\[[0-9;]*m/g, "");

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "carto-model-switch-"));
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
};

test("session inference admission serializes stream methods and cancels waiting requests", async () => {
  const faux = fauxProvider({ provider: "serial-test", models: [{ id: "one" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const admitted = createInferenceAdmission(models);
  const model = models.getModel("serial-test", "one");
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const hold = new Promise((resolve) => { releaseFirst = resolve; });
  faux.setResponses([
    async () => { markStarted(); await hold; return fauxAssistantMessage("first"); },
    () => fauxAssistantMessage("second"),
    () => { throw new Error("provider failed"); },
    () => fauxAssistantMessage("after failure"),
  ]);
  const context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
  const first = admitted.streamSimple(model, context);
  try {
    await started;
    const second = admitted.stream(model, context);
    const abort = new AbortController();
    const cancelled = admitted.streamSimple(model, context, { signal: abort.signal });
    abort.abort();
    assert.equal((await cancelled.result()).stopReason, "aborted");
    assert.equal(faux.state.callCount, 1, "neither waiting request reached the provider");
    releaseFirst();
    assert.equal((await first.result()).stopReason, "stop");
    assert.equal((await second.result()).stopReason, "stop");
    assert.equal(faux.state.callCount, 2);
    const failed = admitted.streamSimple(model, context);
    const following = admitted.stream(model, context);
    assert.equal((await failed.result()).stopReason, "error");
    assert.equal((await following.result()).stopReason, "stop", "a failed request releases the model");
    assert.equal(faux.state.callCount, 4);
  } finally { releaseFirst(); }
});

test("loadGlobalConfig honors modelOverride in memory without touching config.json; updateConfigModel updates only model", async () => {
  const home = mkdtempSync(join(tmpdir(), "carto-config-model-"));
  try {
    await saveGlobalConfig(
      {
        version: 1,
        model: "llama-swap/ModelA",
        llamaSwapEndpoint: "http://localhost:8888/v1",
        contextWindow: 65_536,
        collapseWarningPercent: 75,
        userName: "OracleToes",
      },
      home,
    );

    const overridden = await loadGlobalConfig({ home, modelOverride: "llama-swap/ModelB" });
    assert.equal(overridden.config.model, "llama-swap/ModelB");
    assert.equal(overridden.config.contextWindow, 65_536);
    const untouched = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(untouched.model, "llama-swap/ModelA");

    const updated = await updateConfigModel("llama-swap/ModelC", home);
    assert.equal(updated, true);
    const onDisk = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(onDisk.model, "llama-swap/ModelC");
    assert.equal(onDisk.llamaSwapEndpoint, "http://localhost:8888/v1");
    assert.equal(onDisk.contextWindow, 65_536);
    assert.equal(onDisk.collapseWarningPercent, 75);
    assert.equal(onDisk.userName, "OracleToes");

    // Repeating the same model is a clean no-op.
    assert.equal(await updateConfigModel("llama-swap/ModelC", home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reopening an existing generation store with a changed model updates pi.agent immediately without collapsing", async () => {
  const { root, brain, cleanup } = await fixture();
  const faux = fauxProvider({
    provider: "faux-test",
    models: [
      { id: "model-a", contextWindow: 32_768 },
      { id: "model-b", contextWindow: 131_072 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const seenModels = [];
  faux.setResponses([
    (_ctx, _opts, _state, model) => {
      seenModels.push(model.id);
      return fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-1" })], { stopReason: "toolUse" });
    },
    (_ctx, _opts, _state, model) => {
      seenModels.push(model.id);
      return fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-2" })], { stopReason: "toolUse" });
    },
  ]);

  let firstGeneration;
  const first = await openLiveSession({
    root,
    brain,
    models,
    model: { provider: "faux-test", modelId: "model-a" },
    person: "OracleToes",
    now: () => 1_700_000_000_000,
  });
  try {
    firstGeneration = first.generation;
    const sub = await submitInput(first, "turn on model a");
    await sub.wait(BACKGROUND_CONTEXT);
    await waitForRunEnd(first);
  } finally {
    await closeLiveSession(first);
  }

  // Reopen the SAME generation store after a config.json model swap.
  const second = await openLiveSession({
    root,
    brain,
    models,
    model: { provider: "faux-test", modelId: "model-b" },
    person: "OracleToes",
    now: () => 1_700_000_005_000,
  });
  try {
    assert.equal(second.generation, firstGeneration, "reopened the existing generation store without collapsing");
    const agent = await second.conversation.agent(BACKGROUND_CONTEXT);
    assert.deepEqual(agent.model, { provider: "faux-test", modelId: "model-b" });
    assert.equal(second.state.contextWindow, 131_072);
    const sub = await submitInput(second, "turn on model b");
    await sub.wait(BACKGROUND_CONTEXT);
    await waitForRunEnd(second);
    assert.deepEqual(seenModels, ["model-a", "model-b"]);
  } finally {
    await closeLiveSession(second);
    await cleanup();
  }
});

test("config model on restart is the model sent over HTTP, not the old generation's model", async () => {
  const home = mkdtempSync(join(tmpdir(), "carto-model-config-"));
  const root = mkdtempSync(join(tmpdir(), "carto-model-project-"));
  const requests = [];
  const propsRequests = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "Swift" }, { id: "DaisyRose" }] }));
    } else if (req.method === "GET" && req.url?.startsWith("/props")) {
      propsRequests.push(req.url);
      res.writeHead(409);
      res.end();
    } else if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (part) => { raw += part; });
      req.on("end", () => {
        requests.push(JSON.parse(raw));
        const frame = (delta, finish) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ role: "assistant", tool_calls: [{ index: 0, id: `sleep-${requests.length}`, type: "function", function: { name: "sleep", arguments: "{}" } }] }, null));
        res.end(`${frame({}, "tool_calls")}data: [DONE]\n\n`);
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const run = () => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["bin/carto.mjs", "--headless", "--root", root], {
      cwd: process.cwd(), env: { ...process.env, CARTO_HOME: home }, encoding: "utf8",
    }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout));
    child.stdin.end("hello\n");
  });
  try {
    await saveGlobalConfig({ version: 1, model: "llama-swap/Swift", llamaSwapEndpoint: endpoint }, home);
    assert.match(await run(), /llama-swap\/Swift/);
    await saveGlobalConfig({ version: 1, model: "llama-swap/DaisyRose", llamaSwapEndpoint: endpoint }, home);
    assert.match(await run(), /llama-swap\/DaisyRose/);
    assert.deepEqual(requests.map((request) => request.model), ["Swift", "DaisyRose"], "the actual HTTP model follows the config after reopening the same project");
    assert.ok(propsRequests.includes("/props?model=Swift&autoload=false"));
    assert.ok(propsRequests.includes("/props?model=DaisyRose&autoload=false"));
    assert.ok(propsRequests.every((url) => url.includes("autoload=false")), "window discovery never requests another model to load");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a prepared old-model request recovered from the Brain uses the configured model", async () => {
  const home = mkdtempSync(join(tmpdir(), "carto-recover-model-home-"));
  const root = mkdtempSync(join(tmpdir(), "carto-recover-model-project-"));
  const seen = [];
  let firstArrived;
  let secondArrived;
  const firstRequest = new Promise((resolve) => { firstArrived = resolve; });
  const secondRequest = new Promise((resolve) => { secondArrived = resolve; });
  let restarted = false;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: restarted ? "DaisyRose" : "Swift", context_length: 32000 }] }));
    } else if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (part) => { raw += part; });
      req.on("end", () => {
        const body = JSON.parse(raw);
        seen.push(body.model);
        if (!restarted) {
          firstArrived(); // Leave the request in flight so its checkpoint is durable.
          return;
        }
        const frame = (delta, finish) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ role: "assistant", tool_calls: [{ index: 0, id: "sleep-recovered", type: "function", function: { name: "sleep", arguments: "{}" } }] }, null));
        res.end(`${frame({}, "tool_calls")}data: [DONE]\n\n`);
        secondArrived();
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const start = () => {
    const child = spawn(process.execPath, ["bin/carto.mjs", "--headless", "--root", root], {
      cwd: process.cwd(), env: { ...process.env, CARTO_HOME: home }, stdio: ["pipe", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (part) => { errors += part; });
    const exited = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal, errors }));
    });
    return { child, exited };
  };
  let first;
  let second;
  try {
    await saveGlobalConfig({ version: 1, model: "llama-swap/Swift", llamaSwapEndpoint: endpoint }, home);
    first = start();
    first.child.stdin.write("keep the same conversation\n");
    await firstRequest;
    first.child.kill("SIGKILL");
    assert.equal((await first.exited).signal, "SIGKILL");

    // Recreate the exact durable boundary after prepare committed its request
    // checkpoint, before the scheduler reserved it. Do not modify any Brain
    // records or the checkpoint's model, cutoff, settings, or conversation.
    const context = join(root, ".brain", "context");
    const stores = readdirSync(context).filter((file) => file.endsWith(".sqlite"));
    assert.equal(stores.length, 1);
    const db = new DatabaseSync(join(context, stores[0]));
    try {
      const row = db.prepare("SELECT id, record FROM live_tasks WHERE kind = ? AND status = 'running'").get(JSON.stringify("pi.generation"));
      assert.ok(row, "generation checkpoint exists");
      const record = JSON.parse(row.record);
      assert.equal(record.state.checkpoint.phase, "request");
      assert.deepEqual(record.state.checkpoint.model, { provider: "llama-swap", modelId: "Swift" });
      record.state.status = "pending";
      delete record.restarts;
      db.prepare("UPDATE live_tasks SET status = 'pending', record = ? WHERE id = ?").run(JSON.stringify(record), row.id);
    } finally {
      db.close();
    }
    await saveGlobalConfig({ version: 1, model: "llama-swap/DaisyRose", llamaSwapEndpoint: endpoint }, home);
    restarted = true;
    second = start();
    await secondRequest;
    second.child.stdin.end();
    const outcome = await second.exited;
    assert.equal(outcome.code, 0, outcome.errors);
    assert.deepEqual(seen, ["Swift", "DaisyRose"], "the resumed request must not send the stale checkpoint's model");
    assert.deepEqual(readdirSync(context).filter((file) => file.endsWith(".sqlite")), stores, "the existing generation was preserved, not collapsed");
  } finally {
    first?.child.kill("SIGKILL");
    second?.child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("switchSessionModel mid-run lets the in-flight request finish and swaps at the next natural boundary", async () => {
  const { root, brain, cleanup } = await fixture();
  const faux = fauxProvider({
    provider: "faux-test",
    models: [
      { id: "model-a", contextWindow: 32_768 },
      { id: "model-b", contextWindow: 131_072 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);

  const seenModels = [];
  let releaseStep1;
  let step1Started;
  const step1Gate = new Promise((resolve) => {
    releaseStep1 = resolve;
  });
  const step1Ready = new Promise((resolve) => {
    step1Started = resolve;
  });

  faux.setResponses([
    async (_ctx, _opts, _state, model) => {
      seenModels.push(model.id);
      step1Started();
      await step1Gate;
      return fauxAssistantMessage(
        [fauxToolCall("bash", { command: "printf ok" }, { id: "call-boundary-1" })],
        { stopReason: "toolUse" },
      );
    },
    (_ctx, _opts, _state, model) => {
      seenModels.push(model.id);
      return fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-boundary-2" })], { stopReason: "toolUse" });
    },
  ]);

  const session = await openLiveSession({
    root,
    brain,
    models,
    model: { provider: "faux-test", modelId: "model-a" },
    person: "OracleToes",
    now: () => 1_700_000_000_000,
  });
  try {
    const submission = await submitInput(session, "run a step then continue");
    await step1Ready;

    // Switch models WHILE step 1 is actively in flight on model-a.
    const switched = await switchSessionModel(session, models, { provider: "faux-test", modelId: "model-b" });
    assert.equal(switched.changed, true);
    assert.equal(session.state.contextWindow, 131_072);

    // Let step 1 finish; step 2 (after the bash tool returns) must run on model-b.
    releaseStep1();
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    await waitForRunEnd(session);
    assert.equal(settled.status, "done");
    assert.deepEqual(seenModels, ["model-a", "model-b"]);
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("indexModels indexes all llama-swap /v1/models entries, resolves lookups, and retains cached models on error", async () => {
  let failNext = false;
  const fetchImpl = async (url) => {
    if (failNext) {
      return { ok: false, status: 503, async json() { return {}; } };
    }
    if (url.endsWith("/models")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: [
              { id: "Qwen3-Coder", context_length: 131_072 },
              { id: "ByteShape", context_window: 65_536 },
              { id: "org/DeepSeek-R1", meta: { n_ctx: 32_768 } },
            ],
          };
        },
      };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };

  const models = configuredModels(
    { version: 1, model: "llama-swap/ByteShape", llamaSwapEndpoint: "http://127.0.0.1:8888/v1" },
    { provider: "llama-swap", modelId: "ByteShape" },
    { fetchImpl },
  );

  const first = await indexModels(models, {
    refresh: true,
    active: { provider: "llama-swap", modelId: "ByteShape" },
  });
  assert.equal(first.errors.length, 0);
  assert.deepEqual(
    first.models.map((entry) => [entry.modelId, entry.contextWindow, entry.active]),
    [
      ["ByteShape", 65_536, true],
      ["org/DeepSeek-R1", 32_768, false],
      ["Qwen3-Coder", 131_072, false],
    ],
  );

  // Resolution accepts both provider/modelId and bare modelId (including ids containing `/`).
  assert.deepEqual(resolveIndexedModel(models, "llama-swap/Qwen3-Coder", "llama-swap"), {
    provider: "llama-swap",
    modelId: "Qwen3-Coder",
  });
  assert.deepEqual(resolveIndexedModel(models, "org/DeepSeek-R1", "llama-swap"), {
    provider: "llama-swap",
    modelId: "org/DeepSeek-R1",
  });
  assert.deepEqual(resolveIndexedModel(models, "qwen3-coder", "llama-swap"), {
    provider: "llama-swap",
    modelId: "Qwen3-Coder",
  });

  // Refresh errors are reported without discarding the previously indexed models.
  failNext = true;
  const second = await indexModels(models, {
    refresh: true,
    active: { provider: "llama-swap", modelId: "ByteShape" },
  });
  assert.equal(second.errors.length, 1);
  assert.equal(second.errors[0].provider, "llama-swap");
  assert.equal(second.models.length, 3);
});

test("headless /model lists indexed models and switches models at the next boundary", async () => {
  const { root, brain, cleanup } = await fixture();
  const faux = fauxProvider({
    provider: "faux-test",
    models: [
      { id: "model-a", contextWindow: 32_768 },
      { id: "model-b", contextWindow: 131_072 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const seenModels = [];
  faux.setResponses([
    (_ctx, _opts, _state, model) => {
      seenModels.push(model.id);
      return fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-h1" })], { stopReason: "toolUse" });
    },
  ]);

  const input = new PassThrough();
  let stdout = "";
  let stderr = "";
  const output = new Writable({ write(chunk, _enc, cb) { stdout += String(chunk); cb(); } });
  const error = new Writable({ write(chunk, _enc, cb) { stderr += String(chunk); cb(); } });
  const persisted = [];

  try {
    input.end("/model\n/model model-b\nhello after switch\n/quit\n");
    const code = await runHeadless({
      root,
      brain,
      models,
      model: { provider: "faux-test", modelId: "model-a" },
      input,
      output,
      error,
      onModelChange: (next) => {
        persisted.push(next);
      },
    });
    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /\* faux-test\/model-a/);
    assert.match(stdout, /faux-test\/model-b/);
    assert.match(stdout, /model → faux-test\/model-b/);
    assert.deepEqual(persisted, [{ provider: "faux-test", modelId: "model-b" }]);
    assert.deepEqual(seenModels, ["model-b"]);
  } finally {
    await cleanup();
  }
});

test("ModelPicker renders exact width, filters models, preserves query on refresh, and selects via Enter", () => {
  const picked = [];
  let refreshed = 0;
  let closed = 0;
  const picker = new ModelPicker({
    models: [
      { provider: "llama-swap", modelId: "ByteShape", contextWindow: 65_536, active: true },
      { provider: "llama-swap", modelId: "Qwen3-Coder", contextWindow: 131_072, active: false },
    ],
    activeLabel: "llama-swap/ByteShape",
    running: true,
  });
  picker.onSelect = (model) => picked.push(model);
  picker.onRefresh = () => {
    refreshed += 1;
  };
  picker.onClose = () => {
    closed += 1;
  };

  const initialLines = picker.render(72);
  for (const line of initialLines) assert.equal(visibleWidth(line), 72, "exact overlay width");
  const initialText = stripAnsi(initialLines.join("\n"));
  assert.match(initialText, /swaps at the next step/);
  assert.match(initialText, /● ByteShape/);
  assert.match(initialText, /Qwen3-Coder/);

  // Ctrl+R triggers refresh callback.
  picker.handleInput("\x12");
  assert.equal(refreshed, 1);

  // Typing filters; async setModels preserves the typed filter.
  for (const ch of "qwen") picker.handleInput(ch);
  picker.setModels(
    [
      { provider: "llama-swap", modelId: "ByteShape", contextWindow: 65_536, active: true },
      { provider: "llama-swap", modelId: "Qwen3-Coder", contextWindow: 131_072, active: false },
      { provider: "llama-swap", modelId: "DeepSeek-R1", contextWindow: 32_768, active: false },
    ],
    { loading: false },
  );
  const filteredText = stripAnsi(picker.render(72).join("\n"));
  assert.match(filteredText, /Qwen3-Coder/);
  assert.doesNotMatch(filteredText, /DeepSeek-R1/);

  // Enter selects the filtered match and closes.
  picker.handleInput("\r");
  assert.equal(closed, 1);
  assert.deepEqual(picked.map((m) => `${m.provider}/${m.modelId}`), ["llama-swap/Qwen3-Coder"]);
});
