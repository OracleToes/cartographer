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

test("a fresh Brain opens empty, and a write survives reopening", () => {
  const { path, cleanup } = tempBrain();
  try {
    const first = openBrain(path);
    assert.equal(first.read().chat.length, 0);
    first.apply({ kind: "chat.record", record: chat("c1", "remember this", at(1)) }, at(1));
    first.close();

    const second = openBrain(path);
    const brain = second.read();
    assert.equal(brain.chat.length, 1);
    assert.equal(brain.chat[0].text, "remember this");
    assert.equal(handleOf(brain.handles, "chat", "c1"), "C1");
    second.close();
  } finally {
    cleanup();
  }
});

test("delete is single-step and stays deleted across reopening", () => {
  const { path, cleanup } = tempBrain();
  try {
    const store = openBrain(path);
    store.apply({ kind: "chat.record", record: chat("c1", "ephemeral", at(1)) }, at(1));
    store.apply({ kind: "delete", target: "chat", id: "c1" }, at(2));
    store.compact();
    store.close();

    const again = openBrain(path);
    assert.equal(again.read().chat.length, 0);
    again.close();
  } finally {
    cleanup();
  }
});

test("a corrupt Brain document throws; it never reads as empty", () => {
  const { path, cleanup } = tempBrain();
  try {
    const store = openBrain(path);
    store.close();
    writeFileSync(path, "not a sqlite database");
    assert.throws(() => openBrain(path));
  } finally {
    cleanup();
  }
});

test("compact runs secure-delete and VACUUM without error", () => {
  const { path, cleanup } = tempBrain();
  try {
    const store = openBrain(path);
    store.apply({ kind: "chat.record", record: chat("c1", "x", at(1)) }, at(1));
    assert.doesNotThrow(() => store.compact());
    store.close();
  } finally {
    cleanup();
  }
});
