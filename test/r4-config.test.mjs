/**
 * R4: global config, advertised-capacity discovery, the llama-swap provider,
 * and the placeholder headless driver. Everything here is offline: discovery
 * runs against injected fakes, the driver against the faux provider, and the
 * CLI against a fresh CARTO_HOME that never reaches the network.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { openBrain } from "../dist/runtime/brain-store.js";
import { loadGlobalConfig, parseConfig, parseModelRef, ConfigError, saveGlobalConfig } from "../dist/runtime/config.js";
import { advertisedCapacityOf, catalogModel, resolveContextWindow, configuredModels, modelsForConfig, UNKNOWN_MAX_TOKENS } from "../dist/runtime/llama-swap-model.js";
import { runHeadless, applyCapacityRefresh } from "../dist/runtime/headless.js";
import { openLiveSession, closeLiveSession } from "../dist/runtime/live-session.js";
import { createServer } from "node:http";

const tempDir = () => mkdtempSync(join(tmpdir(), "carto-r4-"));
const FIXED_NOW = () => 1_700_000_000_000;

const fakeFetch = (body, { ok = true } = {}) => async () => ({ ok, json: async () => body });
const captureStream = () => {
  let text = "";
  const stream = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  return { stream, text: () => text };
};

// ---------- config ----------

test("parseModelRef splits on the first slash; the model id keeps the rest", () => {
  assert.deepEqual(parseModelRef("llama-swap/ByteShape"), { provider: "llama-swap", modelId: "ByteShape" });
  assert.deepEqual(parseModelRef("llama-swap/unsloth/Qwen3.8-27B-GGUF"), { provider: "llama-swap", modelId: "unsloth/Qwen3.8-27B-GGUF" });
  assert.throws(() => parseModelRef("ByteShape"), ConfigError);
  assert.throws(() => parseModelRef("/ByteShape"), ConfigError);
  assert.throws(() => parseModelRef("llama-swap/"), ConfigError);
});

test("parseConfig rejects a bad version, model, endpoint, and context window", () => {
  assert.throws(() => parseConfig({ version: 2, model: "llama-swap/x" }), /version must be 1/);
  assert.throws(() => parseConfig({ version: 1, model: 42 }), /model must be a string/);
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", llamaSwapEndpoint: "not-a-url" }), /not a valid URL/);
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", llamaSwapEndpoint: "file:///etc/passwd" }), /must be http/);
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", contextWindow: 512 }), /at least 1024/);
  assert.equal(parseConfig({ version: 1, model: "llama-swap/x", contextWindow: 75_000 }).contextWindow, 75_000);
});

test("a missing config without --model fails with the one-liner that creates it", async () => {
  const home = tempDir();
  try {
    await assert.rejects(loadGlobalConfig({ home }), (error) => {
      assert.equal(error.name, "ConfigError");
      assert.match(error.message, /--model llama-swap\/ByteShape/);
      return true;
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a missing config with --model is created; a later load reads it back", async () => {
  const home = tempDir();
  try {
    const first = await loadGlobalConfig({ home, modelOverride: "llama-swap/ByteShape", llamaSwapEndpointOverride: "http://localhost:8888/v1/", contextWindowOverride: 75_000 });
    assert.equal(first.created, true);
    assert.equal(first.config.llamaSwapEndpoint, "http://localhost:8888/v1");
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.deepEqual(raw, { version: 1, model: "llama-swap/ByteShape", llamaSwapEndpoint: "http://localhost:8888/v1", contextWindow: 75_000 });

    const second = await loadGlobalConfig({ home });
    assert.equal(second.created, false);
    assert.deepEqual(second.config, first.config);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("overrides against an existing config apply in memory; the file is untouched", async () => {
  const home = tempDir();
  try {
    await saveGlobalConfig({ version: 1, model: "llama-swap/ByteShape", llamaSwapEndpoint: "http://localhost:8888/v1", contextWindow: 75_000 }, home);
    const overridden = await loadGlobalConfig({ home, contextWindowOverride: 40_960, llamaSwapEndpointOverride: "http://example:9/v1" });
    assert.equal(overridden.config.contextWindow, 40_960);
    assert.equal(overridden.config.llamaSwapEndpoint, "http://example:9/v1");
    const onDisk = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(onDisk.contextWindow, 75_000);
    assert.equal(onDisk.llamaSwapEndpoint, "http://localhost:8888/v1");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a corrupt config names its path and the parse failure", async () => {
  const home = tempDir();
  try {
    writeFileSync(join(home, "config.json"), "{ not json");
    await assert.rejects(loadGlobalConfig({ home }), (error) => {
      assert.match(error.message, /config\.json/);
      assert.match(error.message, /not valid JSON/);
      return true;
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- advertised capacity ----------

test("capacity advertisement is read from context_length, then context_window, then legacy meta.n_ctx", () => {
  const base = { id: "ByteShape" };
  assert.deepEqual(advertisedCapacityOf({ ...base, context_length: 131_072 }), { capacity: 131_072, source: "context_length" });
  assert.deepEqual(advertisedCapacityOf({ ...base, context_window: 98_304 }), { capacity: 98_304, source: "context_window" });
  assert.deepEqual(advertisedCapacityOf({ ...base, meta: { n_ctx: 65_536 } }), { capacity: 65_536, source: "meta.n_ctx" });
  assert.equal(advertisedCapacityOf(base), undefined);
  assert.equal(advertisedCapacityOf("junk"), undefined);
});

test("a listing entry maps to a Model: the configured pin wins, then the advertised window, else unknown", () => {
  const pinnedHigh = catalogModel({ id: "ByteShape", context_length: 131_072 }, 75_000, "http://x/v1");
  assert.equal(pinnedHigh.contextWindow, 75_000, "the pin wins over an advertised window below it");
  assert.equal(pinnedHigh.maxTokens, 75_000);
  const pinnedLow = catalogModel({ id: "ByteShape", context_length: 65_536 }, 131_072, "http://x/v1");
  assert.equal(pinnedLow.contextWindow, 131_072, "the pin can raise the server above its advertised window");
  const silentPin = catalogModel({ id: "ByteShape" }, 75_000, "http://x/v1");
  assert.equal(silentPin.contextWindow, 75_000, "the pin serves a silent server");
  const advertised = catalogModel({ id: "ByteShape", context_length: 65_536 }, undefined, "http://x/v1");
  assert.deepEqual([advertised.contextWindow, advertised.maxTokens], [65_536, 65_536], "no pin: the server's advertised window is the truth");
  const unknown = catalogModel({ id: "ByteShape" }, undefined, "http://x/v1");
  assert.deepEqual([unknown.contextWindow, unknown.maxTokens], [0, UNKNOWN_MAX_TOKENS], "no pin and no advertisement: the window is unknown and generation is uncapped");
  assert.equal(catalogModel({ context_length: 65_536 }, 75_000, "http://x/v1"), undefined);
  assert.equal(catalogModel({ id: "  " }, 75_000, "http://x/v1"), undefined);
});

test("the pin always wins — advertised capacity neither caps nor lowers it; unknown when both are absent", () => {
  assert.equal(resolveContextWindow(75_000, undefined), 75_000);
  assert.equal(resolveContextWindow(75_000, 65_536), 75_000);
  assert.equal(resolveContextWindow(75_000, 131_072), 75_000);
  assert.equal(resolveContextWindow(75_000, 0), 75_000);
  assert.equal(resolveContextWindow(undefined, 65_536), 65_536);
  assert.equal(resolveContextWindow(undefined, undefined), 0);
  assert.equal(resolveContextWindow(undefined, 0), 0);
});

// ---------- the llama-swap provider ----------

const swapConfig = { version: 1, model: "llama-swap/ByteShape", llamaSwapEndpoint: "http://localhost:8888/v1", contextWindow: 75_000 };

test("only llama-swap is wired; anything else fails plainly", () => {
  assert.throws(() => modelsForConfig(swapConfig, { provider: "openrouter", modelId: "x" }), /llama-swap provider only/);
  assert.throws(() => modelsForConfig({ version: 1, model: "llama-swap/x" }, { provider: "llama-swap", modelId: "x" }), /llamaSwapEndpoint/);
});

const swapConfigNoPin = { version: 1, model: "llama-swap/ByteShape", llamaSwapEndpoint: "http://localhost:8888/v1" };

test("the registry serves the pin when set, else the advertised window, else unknown — via pi's refresh", async () => {
  const models = configuredModels(swapConfig, { provider: "llama-swap", modelId: "ByteShape" });
  const baseline = models.getModel("llama-swap", "ByteShape");
  assert.equal(baseline.contextWindow, 75_000);
  assert.equal(baseline.baseUrl, "http://localhost:8888/v1");
  assert.equal(baseline.api, "openai-completions");

  // A pin serves cold and warm alike: the server's advertisement never overrides it.
  const cold = configuredModels(swapConfig, { provider: "llama-swap", modelId: "ByteShape" }, { fetchImpl: fakeFetch({ data: [{ id: "ByteShape" }] }) });
  await cold.refresh({ providers: ["llama-swap"] });
  assert.equal(cold.getModel("llama-swap", "ByteShape").contextWindow, 75_000);
  const warm = configuredModels(swapConfig, { provider: "llama-swap", modelId: "ByteShape" }, { fetchImpl: fakeFetch({ data: [{ id: "ByteShape", context_length: 131_072 }] }) });
  await warm.refresh({ providers: ["llama-swap"] });
  assert.equal(warm.getModel("llama-swap", "ByteShape").contextWindow, 75_000, "the pin wins over the server's advertisement, both directions");

  // No pin: the advertised window arrives with the load and is used.
  const honest = configuredModels(swapConfigNoPin, { provider: "llama-swap", modelId: "ByteShape" }, { fetchImpl: fakeFetch({ data: [{ id: "ByteShape", meta: { n_ctx: 65_536 } }] }) });
  const silentBefore = honest.getModel("llama-swap", "ByteShape");
  assert.equal(silentBefore.contextWindow, 0, "before any advertisement the window is unknown");
  assert.equal(silentBefore.maxTokens, UNKNOWN_MAX_TOKENS, "unknown window means an uncapped max_tokens");
  await honest.refresh({ providers: ["llama-swap"] });
  assert.equal(honest.getModel("llama-swap", "ByteShape").contextWindow, 65_536);

  const missingWindow = configuredModels({ version: 1, model: "llama-swap/x", llamaSwapEndpoint: "http://localhost:8888/v1" }, { provider: "llama-swap", modelId: "x" });
  assert.equal(missingWindow.getModel("llama-swap", "x").contextWindow, 0, "no pin, no advertisement: unknown, never invented");
});

test("a failed refresh retains the previous catalog (pi's retain-on-failure)", async () => {
  let calls = 0;
  const stateful = async () => {
    calls += 1;
    if (calls === 1) return { ok: true, json: async () => ({ data: [{ id: "ByteShape", context_length: 65_536 }] }) };
    return { ok: false, status: 503, json: async () => ({}) };
  };
  const models = configuredModels(swapConfigNoPin, { provider: "llama-swap", modelId: "ByteShape" }, { fetchImpl: stateful });
  await models.refresh({ providers: ["llama-swap"] });
  assert.equal(models.getModel("llama-swap", "ByteShape").contextWindow, 65_536);
  const second = await models.refresh({ providers: ["llama-swap"] });
  assert.equal(second.errors.size, 1, "the failure lands in the error map, visibly");
  assert.equal(models.getModel("llama-swap", "ByteShape").contextWindow, 65_536, "the previous catalog stands");
});

// ---------- the headless driver (faux provider, scripted) ----------

const headlessFixture = async () => {
  const root = tempDir();
  mkdirSync(join(root, ".brain"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "verify-me.ts"), "export const answer = 42;\n");
  const brain = await openBrain(join(root, ".brain", "brain.sqlite"));
  return { root, brain, cleanup: async () => { await brain.close(); rmSync(root, { recursive: true, force: true }); } };
};
const fauxFor = (contextWindow = 100_000) => {
  const faux = fauxProvider({ provider: "faux-test", models: [{ id: "faux-model", contextWindow }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, ref: { provider: "faux-test", modelId: "faux-model" } };
};
const inputFrom = (lines) => Readable.from([lines.join("\n") + "\n"]);

test("stdin that is not a terminal and carries no lines announces itself instead of dying silently", async () => {
  const { root, brain, cleanup } = await headlessFixture();
  const { models, ref } = fauxFor();
  const out = captureStream();
  const err = captureStream();
  try {
    // Readable.from with an immediately-ended stream, like a closed stdin:
    const code = await runHeadless({ root, brain, models, model: ref, input: Readable.from([]), output: out.stream, error: err.stream, now: FIXED_NOW });
    assert.equal(code, 0);
    assert.match(err.text(), /stdin is not a terminal/);
  } finally {
    await cleanup();
  }
});

test("a person line comes back only as chat words, prefixed; a bare reply says so", async () => {
  const { root, brain, cleanup } = await headlessFixture();
  const { faux, models, ref } = fauxFor();
  const factory = (build) => (context) => build(context);
  faux.setResponses([
    factory(() => fauxAssistantMessage([fauxToolCall("chat", { text: "hello person" }, { id: "call-1" })], { stopReason: "toolUse" })),
    factory(() => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "call-sleep" })], { stopReason: "toolUse" })),
  ]);
  const out = captureStream();
  try {
    const code = await runHeadless({ root, brain, models, model: ref, input: inputFrom(["say hi", "/quit"]), output: out.stream, now: FIXED_NOW });
    assert.equal(code, 0);
    assert.match(out.text(), /carto: hello person/);
    assert.match(out.text(), /carto · headless · faux-test\/faux-model/);
  } finally {
    await cleanup();
  }
});

test("a turn with no chat tool call reports (no chat message), never model prose", async () => {
  const { root, brain, cleanup } = await headlessFixture();
  const { faux, models, ref } = fauxFor();
  faux.setResponses([
    (context) => fauxAssistantMessage([{ type: "text", text: "some plain prose the person must not see" }]),
  ]);
  const out = captureStream();
  try {
    const code = await runHeadless({ root, brain, models, model: ref, input: inputFrom(["think out loud", "/quit"]), output: out.stream, now: FIXED_NOW });
    assert.equal(code, 0);
    assert.match(out.text(), /\(no chat message\)/);
    assert.doesNotMatch(out.text(), /some plain prose/);
  } finally {
    await cleanup();
  }
});

test("/collapse runs the ceremony on the spot and reports it; /quit ends before later lines", async () => {
  const { root, brain, cleanup } = await headlessFixture();
  const { models, ref } = fauxFor();
  const out = captureStream();
  try {
    const code = await runHeadless({ root, brain, models, model: ref, input: inputFrom(["/collapse", "/quit"]), output: out.stream, now: FIXED_NOW });
    assert.equal(code, 0);
    assert.match(out.text(), /context collapsed and rebuilt from the Brain/);
    assert.match(out.text(), /sealed gen-/);
  } finally {
    await cleanup();
  }
});

test("applyCapacityRefresh follows the provider catalog: lowers the window, prints one line, idempotent", async () => {
  const { root, brain, cleanup } = await headlessFixture();
  const { faux, models, ref } = fauxFor(100_000);
  const session = await openLiveSession({ root, brain, models, model: ref, now: FIXED_NOW });
  assert.equal(session.state.contextWindow, 100_000);
  const out = captureStream();
  try {
    let catalog = { contextWindow: 100_000 };
    const stubModels = {
      refresh: async () => undefined,
      getModel: () => catalog,
    };
    const refresh = async () => { catalog = { contextWindow: 65_536 }; };
    await applyCapacityRefresh(session, refresh, stubModels, "faux-test", "faux-model", out.stream);
    assert.equal(session.state.contextWindow, 65_536);
    assert.match(out.text(), /context window 100,000 → 65,536 \(advertised by the server\)/);
    await applyCapacityRefresh(session, async () => undefined, stubModels, "faux-test", "faux-model", out.stream);
    assert.equal(out.text().match(/context window/g).length, 1, "no repeat line while nothing changes");
  } finally {
    await closeLiveSession(session);
    await cleanup();
  }
});

test("pi's catalog refresh over a real HTTP socket lowers the model's advertised window", async () => {
  // A deterministic stand-in for llama-swap: answers /v1/models with the
  // capacity once the model "has loaded" (second call), mirroring llama-swap.
  let calls = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      calls += 1;
      const listing = calls >= 2 ? { data: [{ id: "ByteShape", context_length: 65_536 }] } : { data: [{ id: "ByteShape" }] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(listing));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  try {
    const swapConfigLocal = { version: 1, model: "llama-swap/ByteShape", llamaSwapEndpoint: `http://127.0.0.1:${port}/v1` };
    const models = configuredModels(swapConfigLocal, { provider: "llama-swap", modelId: "ByteShape" });
    await models.refresh({ providers: ["llama-swap"] });
    assert.equal(models.getModel("llama-swap", "ByteShape").contextWindow, 0, "cold: the window is unknown");
    await models.refresh({ providers: ["llama-swap"] });
    assert.equal(models.getModel("llama-swap", "ByteShape").contextWindow, 65_536, "after load: advertised");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

// ---------- the CLI, end to end without a server ----------

const cliEnv = (home) => ({ ...process.env, CARTO_HOME: home });
const runCli = (args, { home, input } = {}) => {
  const child = execFileSync(process.execPath, ["bin/carto.mjs", ...args], {
    cwd: join(process.cwd()),
    env: cliEnv(home ?? tempDir()),
    input: input ?? "",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child;
};
const projectRoot = () => {
  const root = tempDir();
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
};

test("--help exits 0 and names the config file and the workspace TUI", () => {
  // The line driver is no longer "the interface"; help must say plainly what
  // boots by default and how to force the driver.
  const help = runCli(["--help"]);
  assert.match(help, /~\/\.carto\/config\.json/);
  assert.match(help, /workspace TUI/);
  assert.match(help, /--headless/);
  assert.match(help, /--model llama-swap\/ByteShape/);
});

test("no config and no --model: exit 1 and the one-liner that creates it", () => {
  const home = tempDir();
  try {
    let failed = null;
    try {
      runCli([], { home });
    } catch (error) {
      failed = error;
    }
    assert.ok(failed, "expected a non-zero exit");
    assert.equal(failed.status, 1);
    assert.match(String(failed.stderr), /--model llama-swap\/ByteShape/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--model creates the config; a bare run then boots the headless driver and exits at stdin EOF", () => {
  const home = tempDir();
  const root = projectRoot();
  try {
    const first = runCli(
      ["--model", "llama-swap/ByteShape", "--endpoint", "http://127.0.0.1:9/v1", "--context-window", "75000", "--root", root],
      { home, input: "" },
    );
    void first;
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(raw.model, "llama-swap/ByteShape");
    assert.equal(raw.contextWindow, 75_000);
    const second = runCli(["--root", root], { home, input: "" });
    assert.match(second, /carto · headless · llama-swap\/ByteShape/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unsupported provider fails plainly, before any request is made", () => {
  const home = tempDir();
  const root = projectRoot();
  try {
    let failed = null;
    try {
      runCli(["--model", "openrouter/some-model", "--root", root], { home });
    } catch (error) {
      failed = error;
    }
    assert.ok(failed);
    assert.equal(failed.status, 1);
    assert.match(String(failed.stderr), /llama-swap provider only/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
