import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BrainStore } from "../dist/runtime/brain-store.js";
import { ConfigError, loadGlobalConfig } from "../dist/runtime/config.js";

async function temporaryDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

test("a model override creates the global configuration and later loads it", async () => {
  const home = await temporaryDirectory("carto-home-");
  try {
    const first = await loadGlobalConfig({ home, modelOverride: "faux/faux-1" });
    const override = await loadGlobalConfig({ home, modelOverride: "faux/faux-2" });
    const later = await loadGlobalConfig({ home });
    const written = JSON.parse(await readFile(join(home, "config.json"), "utf8"));

    assert.deepEqual(first, { version: 1, model: "faux/faux-1", collapseMode: "request" });
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

test("Pi Durable stores one current Mini Brain document", async () => {
  const root = await temporaryDirectory("carto-brain-");
  const path = join(root, ".brain", "brain.sqlite");
  const store = await BrainStore.open(path);
  try {
    await store.apply({ kind: "context.initialize", liveGeneration: "g1" });
    await store.apply({
      kind: "chat.record",
      record: { id: "chat-1", author: "user", text: "hello", createdAt: 1 },
    });
    await store.vacuum();
    const brain = await store.read();

    assert.equal(brain.context.liveGeneration, "g1");
    assert.deepEqual(brain.chat.map((entry) => entry.text), ["hello"]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
