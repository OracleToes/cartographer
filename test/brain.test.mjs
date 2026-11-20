import assert from "node:assert/strict";
import test from "node:test";

import { applyWrite, BrainError } from "../dist/domain/brain.js";
import { emptyBrain } from "../dist/domain/records.js";
import { handleOf } from "../dist/domain/handles.js";

const at = (n) => 1_700_000_000_000 + n * 1_000;
const source = () => ({ kind: "context", contextId: "gen", excerpt: "excerpt", freshness: "fresh" });
const chat = (id, author, text, createdAt) => ({ id, author, text, createdAt, updatedAt: createdAt });
const ledger = (id, kind, text, createdAt) => ({ id, kind, text, status: "open", answer: null, createdAt, updatedAt: createdAt });
const node = (id, title, claim, createdAt, edges = []) => ({ id, title, claim, evidence: [source()], edges, createdAt, updatedAt: createdAt });

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

test("ledger.upsert creates then replaces; instructions and progress are Ledger kinds", () => {
  let brain = applyWrite(emptyBrain(), { kind: "ledger.upsert", entry: ledger("g1", "instruction", "keep the tests green", at(1)) }, at(1));
  assert.equal(brain.ledger[0].kind, "instruction");
  brain = applyWrite(brain, { kind: "ledger.upsert", entry: ledger("g1", "instruction", "keep the build green", at(2)) }, at(2));
  assert.equal(brain.ledger.length, 1);
  assert.equal(brain.ledger[0].text, "keep the build green");
  assert.equal(ledger("p1", "progress", "made progress", at(3)).kind, "progress");
});

test("atlas.upsert stores edges as written; unconnected nodes float freely", () => {
  const brain = applyWrite(emptyBrain(), { kind: "atlas.upsert", node: node("a1", "title", "claim", at(1), [{ kind: "depends-on", target: "ghost" }]) }, at(1));
  assert.equal(brain.atlas[0].edges.length, 1);
  assert.equal(brain.atlas[0].edges[0].target, "ghost");
  const floating = applyWrite(brain, { kind: "atlas.upsert", node: node("a2", "solo", "claim", at(2)) }, at(2));
  assert.equal(floating.atlas.length, 2);
  assert.equal(floating.atlas[1].edges.length, 0);
});

test("edges survive deletion as written (no cascade); pins live in both layers", () => {
  let brain = applyWrite(emptyBrain(), { kind: "atlas.upsert", node: node("a1", "one", "c", at(1)) }, at(1));
  brain = applyWrite(brain, { kind: "atlas.upsert", node: node("a2", "two", "c", at(2), [{ kind: "depends-on", target: "a1" }]) }, at(2));
  brain = applyWrite(brain, { kind: "delete", target: "atlas", id: "a1" }, at(3));
  // No cascade: the edge to the deleted node stays as written; the agent tends it.
  assert.equal(brain.atlas.length, 1);
  assert.equal(brain.atlas[0].edges.length, 1);
  assert.equal(brain.atlas[0].edges[0].target, "a1");

  brain = applyWrite(brain, { kind: "pin.add", layer: "user", pin: { id: "p1", item: "a2", reason: "keep", source: source(), createdAt: at(4) } }, at(4));
  brain = applyWrite(brain, { kind: "pin.add", layer: "carry", pin: { id: "p2", item: "a2 claim", reason: "keep", source: source(), createdAt: at(5) } }, at(5));
  assert.equal(handleOf(brain.handles, "pin", "p1"), "P1");
  assert.equal(handleOf(brain.handles, "pin", "p2"), "P2");
  brain = applyWrite(brain, { kind: "pin.remove", id: "p1" }, at(6));
  assert.equal(brain.userPins.length, 0);
  assert.equal(brain.carryPins.length, 1);
});

test("deletion is single-step in every layer; unknown IDs throw", () => {
  for (const target of ["chat", "ledger", "atlas", "user-pin", "carry-pin"]) {
    assert.throws(
      () => applyWrite(emptyBrain(), { kind: "delete", target, id: "ghost" }, at(1)),
      BrainError,
      `delete ${target} of unknown id`,
    );
  }
});

test("wake.arm and wake.setStatus; unknown id throws", () => {
  let brain = applyWrite(emptyBrain(), { kind: "wake.arm", wake: { id: "w1", kind: "time", condition: "1780000000000", status: "armed", reason: "check the build", createdAt: at(1) } }, at(1));
  assert.equal(brain.wakes[0].status, "armed");
  assert.equal(handleOf(brain.handles, "wake", "w1"), "W1");
  brain = applyWrite(brain, { kind: "wake.setStatus", id: "w1", status: "cancelled" }, at(2));
  assert.equal(brain.wakes[0].status, "cancelled");
  assert.throws(() => applyWrite(brain, { kind: "wake.setStatus", id: "ghost", status: "cancelled" }, at(2)), BrainError);
});
