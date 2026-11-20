import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openBrain } from "../dist/runtime/brain-store.js";
import { handleOf } from "../dist/domain/handles.js";

function tempBrain() {
  const directory = mkdtempSync(join(tmpdir(), "carto-brain-"));
  return { path: join(directory, "brain.sqlite"), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

const at = (n) => 1_700_000_000_000 + n * 1_000;
const chat = (id, text, createdAt) => ({ id, author: "user", text, createdAt, updatedAt: createdAt });

test("a fresh Brain opens empty, and a write survives reopening", async () => {
  const { path, cleanup } = tempBrain();
  try {
    const first = await openBrain(path);
    assert.equal((await first.read()).chat.length, 0);
    await first.apply({ kind: "chat.record", record: chat("c1", "remember this", at(1)) }, at(1));
    await first.close();

    const second = await openBrain(path);
    const brain = await second.read();
    assert.equal(brain.chat.length, 1);
    assert.equal(brain.chat[0].text, "remember this");
    assert.equal(handleOf(brain.handles, "chat", "c1"), "C1");
    await second.close();
  } finally {
    cleanup();
  }
});

test("delete is single-step and stays deleted across reopening", async () => {
  const { path, cleanup } = tempBrain();
  try {
    const store = await openBrain(path);
    await store.apply({ kind: "chat.record", record: chat("c1", "ephemeral", at(1)) }, at(1));
    await store.apply({ kind: "delete", target: "chat", id: "c1" }, at(2));
    await store.compact();
    await store.close();

    const again = await openBrain(path);
    assert.equal((await again.read()).chat.length, 0);
    await again.close();
  } finally {
    cleanup();
  }
});

test("a corrupt Brain document throws; it never reads as empty", async () => {
  const { path, cleanup } = tempBrain();
  try {
    const store = await openBrain(path);
    await store.close();
    writeFileSync(path, "not a sqlite database");
    await assert.rejects(openBrain(path));
  } finally {
    cleanup();
  }
});

test("compact runs secure-delete and VACUUM without error", async () => {
  const { path, cleanup } = tempBrain();
  try {
    const store = await openBrain(path);
    await store.apply({ kind: "chat.record", record: chat("c1", "x", at(1)) }, at(1));
    await store.compact();
    await store.close();
  } finally {
    cleanup();
  }
});
