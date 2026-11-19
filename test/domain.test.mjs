import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyBrain } from "../dist/domain/brain.js";
import { decide, DomainError } from "../dist/domain/commands.js";
import { projectContext } from "../dist/domain/context.js";

const source = (freshness = "fresh") => ({
  kind: "file",
  path: "src/main.ts",
  startLine: 1,
  endLine: 2,
  digest: "digest-1",
  excerpt: "export const value = 1;",
  freshness,
});

test("collapse keeps deliberate records and purges marked records", () => {
  let brain = createEmptyBrain();
  brain = { ...brain, context: { liveGeneration: "g1", archiveGeneration: "g0" } };
  brain = decide(brain, {
    kind: "chat.record",
    record: { id: "chat-1", author: "user", text: "Keep this chat", createdAt: 1 },
  }).brain;
  brain = decide(brain, {
    kind: "ledger.upsert",
    entry: { id: "ledger-1", kind: "note", text: "Remove this note", status: "open", answer: null, createdAt: 1, updatedAt: 1 },
  }).brain;
  brain = decide(brain, {
    kind: "atlas.upsert",
    node: { id: "atlas-1", title: "Main", claim: "Main exports value", evidence: [source()], links: [], createdAt: 1, updatedAt: 1 },
  }).brain;
  brain = decide(brain, {
    kind: "pin.carry.add",
    pin: { id: "carry-1", item: "Keep one cycle", reason: "Needed next", source: source(), createdAt: 1 },
  }).brain;
  brain = decide(brain, { kind: "deletion.mark", mark: { target: "ledger", id: "ledger-1", markedAt: 2 } }).brain;

  const result = decide(brain, { kind: "collapse.rotate", newLiveGeneration: "g2" });

  assert.equal(result.brain.context.liveGeneration, "g2");
  assert.equal(result.brain.context.archiveGeneration, "g1");
  assert.deepEqual(result.brain.carryPins, []);
  assert.equal(result.brain.chat.length, 1);
  assert.equal(result.brain.atlas.length, 1);
  assert.equal(result.brain.ledger.length, 0);
  assert.deepEqual(result.effects, [{ kind: "remove-archive", generation: "g0" }]);
});

test("a collapse needs a current live generation", () => {
  assert.throws(() => decide(createEmptyBrain(), { kind: "collapse.rotate", newLiveGeneration: "g1" }), DomainError);
});

test("context keeps user pins and warns about stale evidence without old text", () => {
  let brain = createEmptyBrain();
  brain = decide(brain, {
    kind: "pin.user.add",
    pin: { id: "pin-1", item: "exact fresh text", reason: "User keeps this", source: source(), createdAt: 1 },
  }).brain;
  brain = decide(brain, {
    kind: "pin.user.add",
    pin: { id: "pin-2", item: "old text must not enter", reason: "Refresh this", source: source("stale"), createdAt: 1 },
  }).brain;

  const plan = projectContext(brain, { budget: 1000, userMessage: "Tell me about main" });
  const fresh = plan.blocks.find((block) => block.id === "user-pin:pin-1");
  const stale = plan.blocks.find((block) => block.id === "user-pin:pin-2:stale");

  assert.match(fresh?.text ?? "", /exact fresh text/);
  assert.match(stale?.text ?? "", /Stale pin/);
  assert.doesNotMatch(stale?.text ?? "", /old text must not enter/);
  assert.deepEqual(plan.omissions, [{ id: "user-pin:pin-2", reason: "stale" }]);
});
