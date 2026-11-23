import assert from "node:assert/strict";
import test from "node:test";

import { applyWrite, BrainError } from "../dist/domain/brain.js";
import { emptyBrain } from "../dist/domain/records.js";
import { handleOf } from "../dist/domain/handles.js";

const at = (n) => 1_700_000_000_000 + n * 1_000;
const chat = (id, author, text, createdAt) => ({ id, author, text, createdAt, updatedAt: createdAt });
const ledger = (id, kind, text, createdAt) => ({ id, kind, text, status: "open", answer: null, createdAt, updatedAt: createdAt });
const node = (id, title, text, createdAt, links = [], attachments = []) => ({ id, title, text, links, attachments, createdAt, updatedAt: createdAt });

test("chat.record appends and handles are assigned", () => {
  const brain = applyWrite(emptyBrain(), { kind: "chat.record", record: chat("c1", "user", "hello", at(1)) }, at(1));
  assert.equal(brain.chat.length, 1);
  assert.equal(handleOf(brain.handles, "chat", "c1"), "C1");
});

test("chat.update replaces text and stamps updatedAt; unknown id throws", () => {
  const brain = applyWrite(emptyBrain(), { kind: "chat.record", record: chat("c1", "user", "hello", at(1)) }, at(1));
  const updated = applyWrite(brain, { kind: "chat.update", id: "c1", text: "edited", updatedAt: at(2) }, at(2));
  assert.equal(updated.chat[0].text, "edited");
  assert.equal(updated.chat[0].updatedAt, at(2));
  assert.throws(() => applyWrite(brain, { kind: "chat.update", id: "nope", text: "x", updatedAt: at(2) }, at(2)), BrainError);
});

test("ledger.upsert creates then replaces", () => {
  let brain = applyWrite(emptyBrain(), { kind: "ledger.upsert", entry: ledger("g1", "instruction", "keep the tests green", at(1)) }, at(1));
  assert.equal(brain.ledger[0].kind, "instruction");
  brain = applyWrite(brain, { kind: "ledger.upsert", entry: ledger("g1", "instruction", "keep the build green", at(2)) }, at(2));
  assert.equal(brain.ledger.length, 1);
  assert.equal(brain.ledger[0].text, "keep the build green");
});

test("atlas.upsert stores links as written; unconnected nodes float freely", () => {
  const brain = applyWrite(emptyBrain(), { kind: "atlas.upsert", node: node("a1", "title", "c", at(1), ["ghost"]) }, at(1));
  assert.equal(brain.atlas[0].links.length, 1);
  assert.equal(brain.atlas[0].links[0], "ghost");
  const floating = applyWrite(brain, { kind: "atlas.upsert", node: node("a2", "solo", "c", at(2)) }, at(2));
  assert.equal(floating.atlas.length, 2);
  assert.equal(floating.atlas[1].links.length, 0);
});

test("links survive deletion as written (no cascade); stale is a marker on the entry", () => {
  let brain = applyWrite(emptyBrain(), { kind: "atlas.upsert", node: node("a1", "one", "c", at(1)) }, at(1));
  brain = applyWrite(brain, { kind: "atlas.upsert", node: node("a2", "two", "c", at(2), ["a1"]) }, at(2));
  brain = applyWrite(brain, { kind: "delete", target: "atlas", id: "a1" }, at(3));
  // No cascade: the link to the deleted node stays as written; the agent tends it.
  assert.equal(brain.atlas.length, 1);
  assert.equal(brain.atlas[0].links.length, 1);
  assert.equal(brain.atlas[0].links[0], "a1");

  brain = applyWrite(brain, { kind: "atlas.stale", id: "a2", stale: true }, at(6));
  assert.equal(brain.atlas[0].stale, true);
  brain = applyWrite(brain, { kind: "atlas.stale", id: "a2", stale: false }, at(7));
  assert.equal(brain.atlas[0].stale, undefined);
  assert.ok(!("stale" in brain.atlas[0]), "a cleared stale mark removes the key, not a phantom undefined");

  // An update re-asserts the entry: the stale marker is collapse-time truth and is cleared.
  brain = applyWrite(brain, { kind: "atlas.stale", id: "a2", stale: true }, at(8));
  brain = applyWrite(brain, { kind: "atlas.upsert", node: node("a2", "two", "c", at(9), ["a1"], []) }, at(9));
  assert.equal(brain.atlas[0].stale, undefined);
});

test("deletion is single-step in every layer; unknown IDs throw", () => {
  for (const target of ["chat", "ledger", "atlas"]) {
    assert.throws(
      () => applyWrite(emptyBrain(), { kind: "delete", target, id: "ghost" }, at(1)),
      BrainError,
      `delete ${target} of unknown id`,
    );
  }
});

