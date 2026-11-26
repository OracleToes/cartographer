/**
 * R4: global config, advertised-capacity discovery, the llama-swap provider,
 * and the placeholder headless driver. Everything here is offline: discovery
 * runs against injected fakes, the driver against the faux provider, and the
 * CLI against a fresh CARTO_HOME that never reaches the network.
 */
import "./agent-reminder.mjs";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test, { describe } from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { openBrain } from "../dist/runtime/brain-store.js";
import { loadGlobalConfig, parseConfig, parseModelRef, ConfigError, saveGlobalConfig, updateConfigModel } from "../dist/runtime/config.js";
import { advertisedCapacityOf, catalogModel, configuredModels, modelsForConfig, UNKNOWN_MAX_TOKENS } from "../dist/runtime/llama-swap-model.js";
import { runHeadless, applyCapacityRefresh } from "../dist/runtime/headless.js";
import { brainDatabasePath, wipeProjectBrain } from "../dist/runtime/paths.js";
import { openLiveSession, closeLiveSession, submitInput } from "../dist/runtime/live-session.js";
import { createServer } from "node:http";

const tempDir = () => mkdtempSync(join(tmpdir(), "carto-r4-"));
const FIXED_NOW = () => 1_700_000_000_000;

const fakeFetch = (body, { ok = true } = {}) => async () => ({ ok, json: async () => body });
const captureStream = () => {
  let text = "";
  const stream = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  return { stream, text: () => text };
};

// Each test has its own temporary home, project, models, and HTTP server.
// Running independent cases concurrently avoids a serial headless/CLI tail.
describe("configuration and headless", { concurrency: 3 }, () => {
// ---------- config ----------

test("parseModelRef splits on the first slash; the model id keeps the rest", () => {
  assert.deepEqual(parseModelRef("llama-swap/ByteShape"), { provider: "llama-swap", modelId: "ByteShape" });
  assert.deepEqual(parseModelRef("llama-swap/unsloth/Qwen3.8-27B-GGUF"), { provider: "llama-swap", modelId: "unsloth/Qwen3.8-27B-GGUF" });
  assert.throws(() => parseModelRef("ByteShape"), ConfigError);
  assert.throws(() => parseModelRef("/ByteShape"), ConfigError);
  assert.throws(() => parseModelRef("llama-swap/"), ConfigError);
});

test("parseConfig rejects a bad version, model, endpoint, context window, and collapse warning", () => {
  assert.throws(() => parseConfig({ version: 2, model: "llama-swap/x" }), /version must be 1/);
  assert.throws(() => parseConfig({ version: 1, model: 42 }), /model must be a string/);
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", llamaSwapEndpoint: "not-a-url" }), /not a valid URL/);
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", llamaSwapEndpoint: "file:///etc/passwd" }), /must be http/);
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", contextWindow: -1 }), /at least 0/);
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", contextWindow: "many" }), /integer/);
  assert.equal(parseConfig({ version: 1, model: "llama-swap/x", contextWindow: 512 }).contextWindow, 512, "the pin is the person's number — any integer ≥ 0 wins");
  assert.equal(parseConfig({ version: 1, model: "llama-swap/x", contextWindow: 0 }).contextWindow, 0, "0 is the valid 'no pin' pin");
  assert.equal(parseConfig({ version: 1, model: "llama-swap/x", contextWindow: 75_000 }).contextWindow, 75_000);
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", collapseWarningPercent: 0 }), /from 1 to 100/);
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", collapseWarningPercent: 101 }), /from 1 to 100/);
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", collapseWarningPercent: 0.75 }), /from 1 to 100/);
  assert.throws(() => parseConfig({ version: 1, model: "llama-swap/x", collapseWarningPercent: "75" }), /from 1 to 100/);
  assert.equal(parseConfig({ version: 1, model: "llama-swap/x" }).collapseWarningPercent, undefined);
  assert.equal(parseConfig({ version: 1, model: "llama-swap/x", collapseWarningPercent: 1 }).collapseWarningPercent, 1);
  assert.equal(parseConfig({ version: 1, model: "llama-swap/x", collapseWarningPercent: 60 }).collapseWarningPercent, 60);
  assert.equal(parseConfig({ version: 1, model: "llama-swap/x", collapseWarningPercent: 100 }).collapseWarningPercent, 100);
});

test("the tree page size is validated and survives config loading and model changes", async () => {
  const home = tempDir();
  try {
    const base = { version: 1, model: "llama-swap/x" };
    assert.equal(parseConfig(base).treePageSize, undefined);
    for (const value of [0, -1, 1.5, 2001, "100", null]) {
      assert.throws(() => parseConfig({ ...base, treePageSize: value }), /treePageSize must be an integer/);
    }
    assert.equal(parseConfig({ ...base, treePageSize: 1 }).treePageSize, 1);
    assert.equal(parseConfig({ ...base, treePageSize: 2000 }).treePageSize, 2000);
    await saveGlobalConfig({ ...base, treePageSize: 37 }, home);
    assert.equal((await loadGlobalConfig({ home, contextWindowOverride: 4096 })).config.treePageSize, 37);
    await updateConfigModel("llama-swap/y", home);
    assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).treePageSize, 37);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("vision model IDs are validated, preserved, and applied on every catalog path", async () => {
  const home = tempDir();
  try {
    const config = { version: 1, model: "llama-swap/vision/model", llamaSwapEndpoint: "http://localhost:8888/v1", visionModels: ["vision/model"] };
    for (const visionModels of [null, "vision/model", [""], [" padded "], [2]]) {
      assert.throws(() => parseConfig({ ...config, visionModels }), /visionModels must be/);
    }
    await saveGlobalConfig(config, home);
    assert.deepEqual((await loadGlobalConfig({ home, modelOverride: "llama-swap/text" })).config.visionModels, ["vision/model"]);
    await updateConfigModel("llama-swap/text", home);
    assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).visionModels, ["vision/model"]);
    const models = configuredModels(config, { provider: "llama-swap", modelId: "vision/model" }, {
      fetchImpl: fakeFetch({ data: [{ id: "vision/model", context_length: 4096 }, { id: "text", context_length: 4096 }] }),
    });
    assert.deepEqual(models.getModel("llama-swap", "vision/model").input, ["text", "image"]);
    await models.refresh({ providers: ["llama-swap"] });
    assert.deepEqual(models.getModel("llama-swap", "vision/model").input, ["text", "image"]);
    assert.deepEqual(models.getModel("llama-swap", "text").input, ["text"]);
    const noCapacity = configuredModels(config, { provider: "llama-swap", modelId: "vision/model" }, {
      fetchImpl: async (url) => ({ ok: true, json: async () => url.includes("/props?") ? { n_ctx: 4096 } : { data: [{ id: "vision/model" }] } }),
    });
    await noCapacity.refresh({ providers: ["llama-swap"] });
    assert.deepEqual(noCapacity.getModel("llama-swap", "vision/model").input, ["text", "image"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the Brain ignores its own files in Git without changing project rules", () => {
  const root = tempDir();
  try {
    execFileSync("git", ["init", "-q", root]);
    const projectIgnore = "# project rules\n*.tmp\n";
    writeFileSync(join(root, ".gitignore"), projectIgnore);
    writeFileSync(join(root, "project.txt"), "project");
    const db = brainDatabasePath(root);
    writeFileSync(db, "private database");
    mkdirSync(join(root, ".brain", "context"));
    writeFileSync(join(root, ".brain", "context", "generation.sqlite"), "private context");
    writeFileSync(join(root, ".brain", "collapse-log.jsonl"), "private log");
    const ignore = join(root, ".brain", ".gitignore");
    const original = readFileSync(ignore, "utf8");
    assert.match(original, /^# Carto session data\n\*\n$/);
    assert.equal(brainDatabasePath(root), db);
    assert.equal(readFileSync(ignore, "utf8"), original);
    assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), projectIgnore);
    const status = execFileSync("git", ["-C", root, "status", "--short", "--untracked-files=all"], { encoding: "utf8" });
    assert.match(status, /\?\? project\.txt/);
    assert.match(status, /\?\? \.gitignore/);
    assert.doesNotMatch(status, /\.brain/);
    // Ignore rules protect untracked files, but never untrack a forced add.
    execFileSync("git", ["-C", root, "add", "-f", ".brain/brain.sqlite"]);
    assert.match(execFileSync("git", ["-C", root, "status", "--short"], { encoding: "utf8" }), /A  \.brain\/brain\.sqlite/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("existing Brain ignore rules are preserved and an unsafe symlink is refused", () => {
  const root = tempDir(), elsewhere = tempDir();
  try {
    mkdirSync(join(root, ".brain"));
    const ignore = join(root, ".brain", ".gitignore");
    writeFileSync(ignore, "# existing\n!important");
    brainDatabasePath(root);
    const updated = readFileSync(ignore, "utf8");
    assert.match(updated, /^# existing\n!important\n# Carto session data\n\*\n$/);
    brainDatabasePath(root);
    assert.equal(readFileSync(ignore, "utf8"), updated);
    rmSync(ignore);
    const target = join(elsewhere, "target");
    writeFileSync(target, "untouched");
    symlinkSync(target, ignore);
    assert.throws(() => brainDatabasePath(root), /regular file/);
    assert.equal(readFileSync(target, "utf8"), "untouched");
    rmSync(join(root, ".brain"), { recursive: true });
    symlinkSync(elsewhere, join(root, ".brain"));
    assert.throws(() => brainDatabasePath(root), /real directory/);
    assert.equal(readFileSync(target, "utf8"), "untouched");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
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
    const first = await loadGlobalConfig({ home, modelOverride: "llama-swap/ByteShape", llamaSwapEndpointOverride: "http://localhost:8888/v1/", contextWindowOverride: 75_000, collapseWarningPercentOverride: 80 });
    assert.equal(first.created, true);
    assert.equal(first.config.llamaSwapEndpoint, "http://localhost:8888/v1");
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.deepEqual(raw, { version: 1, model: "llama-swap/ByteShape", llamaSwapEndpoint: "http://localhost:8888/v1", contextWindow: 75_000, collapseWarningPercent: 80 });

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
    await saveGlobalConfig({ version: 1, model: "llama-swap/ByteShape", llamaSwapEndpoint: "http://localhost:8888/v1", contextWindow: 75_000, collapseWarningPercent: 80 }, home);
    const overridden = await loadGlobalConfig({ home, contextWindowOverride: 40_960, llamaSwapEndpointOverride: "http://example:9/v1", collapseWarningPercentOverride: 60 });
    assert.equal(overridden.config.contextWindow, 40_960);
    assert.equal(overridden.config.llamaSwapEndpoint, "http://example:9/v1");
    assert.equal(overridden.config.collapseWarningPercent, 60);
    const onDisk = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(onDisk.contextWindow, 75_000);
    assert.equal(onDisk.llamaSwapEndpoint, "http://localhost:8888/v1");
    assert.equal(onDisk.collapseWarningPercent, 80);
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
  assert.equal(pinnedHigh.contextWindow, 75_000, "the pin wins over an advertised window above it");
  assert.equal(pinnedHigh.maxTokens, 75_000);
  const pinnedLow = catalogModel({ id: "ByteShape", context_length: 65_536 }, 131_072, "http://x/v1");
  assert.equal(pinnedLow.contextWindow, 131_072, "the pin can raise the server above its advertised window");
  const silentPin = catalogModel({ id: "ByteShape" }, 75_000, "http://x/v1");
  assert.equal(silentPin.contextWindow, 75_000, "the pin serves a silent server");
  const advertised = catalogModel({ id: "ByteShape", context_length: 65_536 }, undefined, "http://x/v1");
  assert.deepEqual([advertised.contextWindow, advertised.maxTokens], [65_536, 65_536], "no pin: the server's advertised window is the truth");
  const zeroPin = catalogModel({ id: "ByteShape", context_length: 65_536 }, 0, "http://x/v1");
  assert.equal(zeroPin.contextWindow, 65_536, "a configured 0 means no pin, so the advertised window stands");
  const unknown = catalogModel({ id: "ByteShape" }, undefined, "http://x/v1");
  assert.deepEqual([unknown.contextWindow, unknown.maxTokens], [0, UNKNOWN_MAX_TOKENS], "no pin and no advertisement: the window is unknown and generation is uncapped");
  assert.equal(catalogModel({ context_length: 65_536 }, 75_000, "http://x/v1"), undefined);
  assert.equal(catalogModel({ id: "  " }, 75_000, "http://x/v1"), undefined);
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
  // These headless cases do not reopen the Brain; persistence is covered by
  // the Brain and recovery suites, while the live generation remains on disk.
  const brain = await openBrain(":memory:");
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
    assert.match(err.text(), /nothing arrived on stdin and there was no terminal to type into/);
  } finally {
    await cleanup();
  }
});

test("a wipe keeps headless open and the next message reaches a genuinely fresh session", async () => {
  const root = tempDir();
  mkdirSync(join(root, ".brain"));
  let brain = await openBrain(join(root, ".brain", "brain.sqlite"));
  const { faux, models, ref } = fauxFor();
  const out = captureStream();
  const contexts = [];
  await brain.apply({ kind: "chat.record", record: { id: "old", author: "user", text: "OLD_SECRET_MESSAGE", createdAt: 1, updatedAt: 1 } }, 1);
  await brain.archiveEphemeral({ id: "old-archive", layer: "ephemeral", ephemeral: { kind: "plainText", text: "old archive" } }, "gen-old", 1);
  faux.setResponses([
    (context) => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage([fauxToolCall("chat", { text: "fresh answer" }, { id: "fresh-chat" })], { stopReason: "toolUse" }); },
    () => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "fresh-sleep" })], { stopReason: "toolUse" }),
  ]);
  try {
    const code = await runHeadless({
      root, brain, models, model: ref, input: inputFrom(["/mode read-only", "/mode relaxed", "/wipe", "/wipe confirm", "/mode", "new question", "/quit"]), output: out.stream,
      resetProjectBrain: async () => { await brain.close(); await wipeProjectBrain(root); brain = await openBrain(join(root, ".brain", "brain.sqlite")); return { brain }; },
    });
    assert.equal(code, 0);
    assert.match(out.text(), /fresh session ready/);
    assert.match(out.text(), /mode: edit · file scope: strict/);
    assert.match(out.text(), /carto: fresh answer/);
    assert.ok(contexts.length > 0);
    assert.doesNotMatch(contexts[0], /OLD_SECRET_MESSAGE/);
    assert.match(contexts[0], /new question/);
    assert.deepEqual((await brain.read()).chat.map((entry) => entry.text), ["new question", "fresh answer"]);
    assert.equal((await brain.readArchive()).items.length, 0);
  } finally { await brain.close(); rmSync(root, { recursive: true, force: true }); }
});

test("headless waits for consecutive tree continuations and prints their chat", async () => {
  const { root, brain, cleanup } = await headlessFixture();
  const { faux, models, ref } = fauxFor();
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("tree", { depth: 1 }, { id: "tree-1" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxToolCall("tree", { depth: 2 }, { id: "tree-2" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxToolCall("chat", { text: "tree checked" }, { id: "tree-chat" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxToolCall("sleep", {}, { id: "tree-stop" })], { stopReason: "toolUse" }),
  ]);
  const out = captureStream();
  try {
    const code = await runHeadless({ root, brain, models, model: ref, input: inputFrom(["look", "/quit"]), output: out.stream, now: FIXED_NOW });
    assert.equal(code, 0);
    assert.match(out.text(), /carto: tree checked/);
    assert.match(out.text(), /carto · faux-test\/faux-model/);
  } finally {
    await cleanup();
  }
});

test("a turn with no chat tool call ends quietly: silence, never model prose", async () => {
  const { root, brain, cleanup } = await headlessFixture();
  const { faux, models, ref } = fauxFor();
  faux.setResponses([
    (context) => fauxAssistantMessage([{ type: "text", text: "some plain prose the person must not see" }]),
  ]);
  const out = captureStream();
  try {
    const code = await runHeadless({ root, brain, models, model: ref, input: inputFrom(["think out loud", "/quit"]), output: out.stream, now: FIXED_NOW });
    assert.equal(code, 0);
    assert.doesNotMatch(out.text(), /some plain prose/);
    // Nothing to say is a legitimate end of a turn, not a condition to report.
    assert.doesNotMatch(out.text(), /no chat message|status/);
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
    assert.match(out.text(), /swept gen-/);
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

test("bare llama-server (GGUF filename id) and /props fallback populate the configured model's context window", async () => {
  // 1) Bare llama-server returning a single owned_by: "llamacpp" entry with its GGUF filename.
  const bareServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "Qwen3-32B-Q4_K_M.gguf", owned_by: "llamacpp", meta: { n_ctx: 65_536 } }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolveListen) => bareServer.listen(0, "127.0.0.1", resolveListen));
  try {
    const { port } = bareServer.address();
    const models = configuredModels(
      { version: 1, model: "llama-swap/ByteShape", llamaSwapEndpoint: `http://127.0.0.1:${port}/v1` },
      { provider: "llama-swap", modelId: "ByteShape" },
    );
    await models.refresh({ providers: ["llama-swap"] });
    assert.equal(models.getModel("llama-swap", "ByteShape").contextWindow, 65_536, "lone llamacpp entry mirrors capacity onto route name");
  } finally {
    await new Promise((resolveClose) => bareServer.close(resolveClose));
  }

  // 2) Server whose /v1/models omits capacity but whose passive /props exposes default_generation_settings.n_ctx.
  const propsServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "ByteShape" }] }));
      return;
    }
    if (request.method === "GET" && request.url === "/props?model=ByteShape&autoload=false") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ default_generation_settings: { n_ctx: 49_152 } }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolveListen) => propsServer.listen(0, "127.0.0.1", resolveListen));
  try {
    const { port } = propsServer.address();
    const models = configuredModels(
      { version: 1, model: "llama-swap/ByteShape", llamaSwapEndpoint: `http://127.0.0.1:${port}/v1` },
      { provider: "llama-swap", modelId: "ByteShape" },
    );
    await models.refresh({ providers: ["llama-swap"] });
    assert.equal(models.getModel("llama-swap", "ByteShape").contextWindow, 49_152, "/props n_ctx fills in when /v1/models omits capacity");
  } finally {
    await new Promise((resolveClose) => propsServer.close(resolveClose));
  }
});

test("capacity discovery addresses the active model without asking llama-swap to load it", async () => {
  let active = "org/Swift";
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.endsWith("/v1/models")) return { ok: true, async json() { return { data: [{ id: "org/Swift" }, { id: "DaisyRose" }] }; } };
    return { ok: false, status: 409, async json() { return {}; } };
  };
  const models = configuredModels(
    { version: 1, model: "llama-swap/org/Swift", llamaSwapEndpoint: "http://localhost:8888/v1" },
    { provider: "llama-swap", modelId: active },
    { fetchImpl, activeModelId: () => active },
  );
  await models.refresh({ providers: ["llama-swap"], force: true });
  active = "DaisyRose";
  await models.refresh({ providers: ["llama-swap"], force: true });
  const props = urls.filter((url) => new URL(url).pathname === "/props").map((url) => new URL(url).searchParams);
  assert.deepEqual(props.map((query) => [query.get("model"), query.get("autoload")]), [["org/Swift", "false"], ["DaisyRose", "false"]]);
  assert.equal(models.getModel("llama-swap", "DaisyRose").contextWindow, 0, "a cold model's capacity remains unknown");
});

test("cold llama-swap discovers the context window mid-first-run as soon as the model responds", async () => {
  const { root, brain, cleanup } = await headlessFixture();
  let loaded = false;
  let releaseStream;
  const held = new Promise((resolve) => { releaseStream = resolve; });
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      const listing = loaded ? { data: [{ id: "ByteShape", context_length: 65_536 }] } : { data: [{ id: "ByteShape" }] };
      response.end(JSON.stringify(listing));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      request.resume();
      request.on("end", () => {
        loaded = true;
        response.writeHead(200, { "content-type": "text/event-stream" });
        // Send a prefill progress frame and hold the stream open so we can verify
        // that capacity discovery completes WHILE the first turn is still prefilling.
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }], prompt_progress: { total: 1000, cache: 200, processed: 600, time_ms: 500 } })}\n\n`);
        void held.then(() => {
          const call = { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "sleep", arguments: "{}" } }] };
          response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: call, finish_reason: null }] })}\n\n`);
          response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        });
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  const models = configuredModels(
    { version: 1, model: "llama-swap/ByteShape", llamaSwapEndpoint: `http://127.0.0.1:${port}/v1` },
    { provider: "llama-swap", modelId: "ByteShape" },
  );
  await models.refresh({ providers: ["llama-swap"] });
  const session = await openLiveSession({ root, brain, models, model: { provider: "llama-swap", modelId: "ByteShape" }, now: FIXED_NOW });
  const out = captureStream();
  try {
    assert.equal(session.state.contextWindow, 0, "cold startup begins with window unknown");
    let refreshed;
    const discovered = new Promise((resolve) => { refreshed = resolve; });
    session.state.onResponse = () => {
      if (session.state.contextWindow <= 0) {
        void applyCapacityRefresh(
          session,
          () => models.refresh({ providers: ["llama-swap"] }).then(() => undefined),
          models,
          "llama-swap",
          "ByteShape",
          out.stream,
        ).then(refreshed);
      }
    };
    const submission = await submitInput(session, "hello");
    await discovered;
    assert.equal(session.state.contextWindow, 65_536, "window is discovered while the first response is still streaming");
    assert.equal(session.state.prefillActive, true, "discovered before generation even starts");
    releaseStream();
    await submission.wait(BACKGROUND_CONTEXT);
  } finally {
    releaseStream();
    await closeLiveSession(session);
    await new Promise((resolveClose) => {
      server.closeAllConnections();
      server.close(resolveClose);
    });
    await cleanup();
  }
});

// ---------- the CLI, end to end without a server ----------

const cliEnv = (home) => ({ ...process.env, CARTO_HOME: home });
const runCli = (args, { home, input } = {}) => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, ["bin/carto.mjs", ...args], {
    cwd: join(process.cwd()),
    env: cliEnv(home ?? tempDir()),
    encoding: "utf8",
  }, (error, stdout, stderr) => {
    if (error) {
      error.status = error.code;
      error.stderr = stderr;
      reject(error);
    } else resolve(stdout);
  });
  child.stdin.end(input ?? "");
});
const projectRoot = () => {
  const root = tempDir();
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
};

// The four CLI tests each boot a child process, and each owns its own
// CARTO_HOME, so they share no state: run them at once rather than paying four
// process spawns one after another, which the suite's budget cannot afford.
describe("the CLI, end to end, run concurrently", { concurrency: 4 }, () => {
  test("--help exits 0 and names the config file and the workspace TUI", async () => {
    // The line driver is no longer "the interface"; help must say plainly what
    // boots by default and how to force the driver.
    const help = await runCli(["--help"]);
    assert.match(help, /~\/\.carto\/config\.json/);
    assert.match(help, /workspace TUI/);
    assert.match(help, /--headless/);
    assert.match(help, /--model llama-swap\/ByteShape/);
    assert.match(help, /--collapse-warning <n>/);
    assert.match(help, /collapseWarningPercent/);
    assert.match(help, /--user <name>/);
    assert.match(help, /userName/);
  });

  test("no config and no --model: exit 1 and the one-liner that creates it", async () => {
    const home = tempDir();
    try {
      let failed = null;
      try {
        await runCli([], { home });
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

  test("--model and --user create the config and boot the headless driver at stdin EOF", async () => {
    const home = tempDir();
    const root = projectRoot();
    try {
      const first = await runCli(
        ["--model", "llama-swap/ByteShape", "--endpoint", "http://127.0.0.1:9/v1", "--context-window", "75000", "--collapse-warning", "65", "--user", "OracleToes", "--root", root],
        { home, input: "" },
      );
      assert.match(first, /carto · llama-swap\/ByteShape/);
      const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
      assert.equal(raw.model, "llama-swap/ByteShape");
      assert.equal(raw.contextWindow, 75_000);
      assert.equal(raw.collapseWarningPercent, 65);
      assert.equal(raw.userName, "OracleToes", "--user is persisted instead of the login name");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("wipe requires confirmation, closes storage, removes all project state, and leaves files and global config", async () => {
    const home = tempDir(), root = projectRoot();
    const brainDir = join(root, ".brain");
    mkdirSync(brainDir);
    writeFileSync(join(root, "src", "keep"), "project file");
    writeFileSync(join(brainDir, "settings.json"), JSON.stringify({ version: 1, readOnly: true, pathScope: "relaxed" }));
    const brain = await openBrain(join(brainDir, "brain.sqlite"));
    await brain.apply({ kind: "chat.record", record: { id: "old-chat", author: "user", text: "old session", createdAt: 1, updatedAt: 1 } }, 1);
    await brain.archiveEphemeral({ id: "old-archive", layer: "ephemeral", ephemeral: { kind: "plainText", text: "old archive" } }, "gen-old", 1);
    await brain.close();
    const args = ["--model", "llama-swap/ByteShape", "--endpoint", "http://127.0.0.1:9/v1", "--root", root, "--headless"];
    try {
      const cancelled = await runCli(args, { home, input: "/wipe confirm\n/wipe\n/help\n/wipe confirm\n/quit\n" });
      assert.match(cancelled, /wipe cancelled/);
      assert.ok(existsSync(join(brainDir, "brain.sqlite")));
      assert.ok(existsSync(join(brainDir, "settings.json")));
      const done = await runCli(args, { home, input: "/wipe\n/wipe confirm\n/mode\n/mode read-only\n/quit\n" });
      assert.match(done, /wiped .*\.brain; fresh session ready/);
      assert.match(done, /mode: edit · file scope: strict/);
      assert.match(done, /mode: read-only · file scope: strict/);
      assert.equal(existsSync(brainDir), true, "a fresh session is open before quit");
      assert.match(readFileSync(join(brainDir, ".gitignore"), "utf8"), /\n\*\n$/);
      assert.equal(readFileSync(join(root, "src", "keep"), "utf8"), "project file");
      assert.ok(existsSync(join(home, "config.json")));
      const fresh = await openBrain(join(brainDir, "brain.sqlite"));
      try {
        assert.equal((await fresh.read()).chat.length, 0);
        assert.equal((await fresh.readArchive()).items.length, 0);
      } finally { await fresh.close(); }
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  });

  test("wipe refuses a symlinked .brain without touching its target", async () => {
    const root = tempDir(), elsewhere = tempDir();
    try {
      writeFileSync(join(elsewhere, "keep"), "safe");
      symlinkSync(elsewhere, join(root, ".brain"));
      await assert.rejects(wipeProjectBrain(root), /real directory/);
      assert.equal(readFileSync(join(elsewhere, "keep"), "utf8"), "safe");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
  });

  test("an unsupported provider fails plainly, before any request is made", async () => {
    const home = tempDir();
    const root = projectRoot();
    try {
      let failed = null;
      try {
        await runCli(["--model", "openrouter/some-model", "--root", root], { home });
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
});
});
