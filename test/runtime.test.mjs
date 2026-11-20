import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BrainStore } from "../dist/runtime/brain-store.js";
import { ConfigError, loadGlobalConfig, parseConfig, parseModelRef } from "../dist/runtime/config.js";
import { modelsForConfig } from "../dist/runtime/llama-swap-model.js";

async function temporaryDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
}

test("a model override creates the global configuration and later loads it", async () => {
  const home = await temporaryDirectory("carto-home-");
  try {
    const first = await loadGlobalConfig({ home, modelOverride: "faux/faux-1" });
    const override = await loadGlobalConfig({ home, modelOverride: "faux/faux-2" });
    const later = await loadGlobalConfig({ home });
    const written = JSON.parse(await readFile(join(home, "config.json"), "utf8"));

    assert.deepEqual(first, { version: 1, model: "faux/faux-1" });
    assert.deepEqual(override, { ...first, model: "faux/faux-2" });
    assert.deepEqual(later, first);
    assert.deepEqual(written, first);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a missing configuration needs a model override", async () => {
  const home = await temporaryDirectory("carto-home-");
  try {
    await assert.rejects(() => loadGlobalConfig({ home }), ConfigError);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a llama-swap model persists its endpoint and registers with Pi", async () => {
  const home = await temporaryDirectory("carto-home-");
  try {
    const first = await loadGlobalConfig({
      home,
      modelOverride: "llama-swap/Flint",
      llamaSwapEndpointOverride: "http://localhost:8888/v1/",
    });
    const later = await loadGlobalConfig({ home });
    const models = modelsForConfig(first, parseModelRef(first.model));
    const model = models.getModel("llama-swap", "Flint");

    assert.deepEqual(first, {
      version: 1,
      model: "llama-swap/Flint",
      llamaSwapEndpoint: "http://localhost:8888/v1",
    });
    assert.deepEqual(later, first);
    assert.equal(model.baseUrl, "http://localhost:8888/v1");
    assert.equal(model.compat.supportsDeveloperRole, false);
    assert.equal(model.compat.supportsReasoningEffort, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a corrected model override repairs a legacy endpoint saved as a model", async () => {
  const home = await temporaryDirectory("carto-home-");
  try {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        model: "http://localhost:8888/v1/Flint",
        collapseMode: "request",
      }),
      "utf8",
    );

    const recovered = await loadGlobalConfig({
      home,
      modelOverride: "llama-swap/Flint",
      llamaSwapEndpointOverride: "http://localhost:8888/v1",
    });
    const written = JSON.parse(await readFile(join(home, "config.json"), "utf8"));

    assert.deepEqual(recovered, {
      version: 1,
      model: "llama-swap/Flint",
      llamaSwapEndpoint: "http://localhost:8888/v1",
    });
    assert.deepEqual(written, recovered);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a llama-swap request has no Authorization header and uses llama.cpp-compatible fields", async () => {
  let received;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    received = { path: request.url, headers: request.headers, body: JSON.parse(text) };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "Flint",
        choices: [{ index: 0, delta: { content: "Flint is ready." }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await listen(server);
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const config = parseConfig({
      version: 1,
      model: "llama-swap/Flint",
      llamaSwapEndpoint: `http://127.0.0.1:${address.port}/v1`,
    });
    const models = modelsForConfig(config, parseModelRef(config.model));
    const model = models.getModel("llama-swap", "Flint");
    assert.ok(model !== undefined);

    const reply = await models.complete(
      model,
      {
        systemPrompt: "Work carefully.",
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        tools: [],
      },
      { maxTokens: 12, reasoningEffort: "high" },
    );

    assert.deepEqual(reply.content, [{ type: "text", text: "Flint is ready." }]);
    assert.deepEqual(received.path, "/v1/chat/completions");
    assert.equal(received.headers.authorization, undefined);
    assert.equal(received.body.model, "Flint");
    assert.equal(received.body.messages[0].role, "system");
    assert.equal(received.body.max_tokens, 12);
    assert.equal(received.body.max_completion_tokens, undefined);
    assert.equal(received.body.reasoning_effort, undefined);
    assert.equal(received.body.store, undefined);
    assert.equal(received.body.stream_options, undefined);
  } finally {
    await closeServer(server);
  }
});

test("model URLs and llama-swap endpoints with a non-llama-swap model are rejected", () => {
  assert.throws(() => parseModelRef("http://localhost:8888/v1/Flint"), ConfigError);
  assert.throws(
    () => parseConfig({ version: 1, model: "openai/gpt-4.1", llamaSwapEndpoint: "http://localhost:8888/v1" }),
    ConfigError,
  );
});

test("Pi Durable stores one current Carto Brain document", async () => {
  const root = await temporaryDirectory("carto-brain-");
  const path = join(root, ".brain", "brain.sqlite");
  const store = await BrainStore.open(path);
  try {
    await store.apply({
      kind: "chat.record",
      record: { id: "chat-1", author: "user", text: "hello", createdAt: 1, updatedAt: 1 },
    });
    await store.vacuum();
    const brain = await store.read();

    assert.deepEqual(brain.chat.map((entry) => entry.text), ["hello"]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Brain document without a handle table starts with an empty one", async () => {
  const root = await temporaryDirectory("carto-handle-upgrade-");
  const path = join(root, ".brain", "brain.sqlite");
  const store = await BrainStore.open(path);
  try {
    await store.apply({ kind: "handles.sync" });
    const brain = await store.read();
    assert.deepEqual(brain.handles, { counters: {}, entries: [] });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
