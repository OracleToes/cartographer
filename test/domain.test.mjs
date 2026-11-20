import assert from "node:assert/strict";
import test from "node:test";

import { byCreatedAt, createEmptyBrain } from "../dist/domain/brain.js";
import { decide, DomainError } from "../dist/domain/commands.js";
import { projectContext, renderContextPlan } from "../dist/domain/context.js";
import { resolveHandle, resolveHandleOfKind } from "../dist/domain/handles.js";

const source = (freshness = "fresh") => ({
  kind: "file",
  path: "src/main.ts",
  startLine: 1,
  endLine: 2,
  digest: "digest-1",
  excerpt: "export const value = 1;",
  freshness,
});

test("a collapse rebuilds the handle table and keeps every deliberate record", () => {
  let brain = createEmptyBrain();
  brain = decide(brain, {
    kind: "chat.record",
    record: { id: "chat-1", author: "user", text: "Keep this chat", createdAt: 1, updatedAt: 1 },
  }).brain;
  brain = decide(brain, {
    kind: "ledger.upsert",
    entry: { id: "ledger-1", kind: "note", text: "One Ledger record", status: "open", answer: null, createdAt: 1, updatedAt: 1 },
  }).brain;
  brain = decide(brain, {
    kind: "atlas.upsert",
    node: { id: "atlas-1", title: "Main", claim: "Main exports value", evidence: [source()], edges: [], createdAt: 1, updatedAt: 1 },
  }).brain;
  brain = decide(brain, {
    kind: "pin.carry.add",
    pin: { id: "carry-1", item: "Keep one cycle", reason: "Needed next", source: source(), createdAt: 1 },
  }).brain;

  const result = decide(brain, { kind: "collapse.rotate" });

  assert.equal(result.brain.chat.length, 1);
  assert.equal(result.brain.ledger.length, 1);
  assert.equal(result.brain.atlas.length, 1);
  assert.equal(result.brain.carryPins.length, 1);
  assert.deepEqual(result.effects, []);
  assert.deepEqual(
    result.brain.handles.entries.map((entry) => entry.handle),
    ["L1", "C1", "A1", "P1"],
  );
});

test("delete removes a record in one step, for every target", () => {
  let brain = createEmptyBrain();
  brain = decide(brain, {
    kind: "chat.record",
    record: { id: "chat-1", author: "user", text: "Remove me", createdAt: 1, updatedAt: 1 },
  }).brain;
  brain = decide(brain, {
    kind: "ledger.upsert",
    entry: { id: "ledger-1", kind: "note", text: "Remove me", status: "open", answer: null, createdAt: 1, updatedAt: 1 },
  }).brain;
  brain = decide(brain, {
    kind: "atlas.upsert",
    node: { id: "atlas-1", title: "T", claim: "C", evidence: [source()], edges: [], createdAt: 1, updatedAt: 1 },
  }).brain;
  brain = decide(brain, {
    kind: "pin.user.add",
    pin: { id: "pin-1", item: "Remove me", reason: "Reason", source: source(), createdAt: 1 },
  }).brain;
  brain = decide(brain, {
    kind: "wake.upsert",
    wake: { id: "wake-1", kind: "time", condition: "100", status: "armed", reason: "Reason", createdAt: 1 },
  }).brain;

  for (const target of [
    { target: "chat", id: "chat-1" },
    { target: "ledger", id: "ledger-1" },
    { target: "atlas", id: "atlas-1" },
    { target: "user-pin", id: "pin-1" },
  ]) {
    brain = decide(brain, { kind: "record.delete", target }).brain;
  }

  assert.equal(brain.chat.length, 0);
  assert.equal(brain.ledger.length, 0);
  assert.equal(brain.atlas.length, 0);
  assert.equal(brain.userPins.length, 0);
  assert.equal(brain.wakes.length, 1);
  // Handles follow the records they name.
  assert.deepEqual(brain.handles.entries.map((entry) => entry.handle), ["W1"]);
});

test("the projection carries structure, not dialogue", () => {
  let brain = createEmptyBrain();
  brain = decide(brain, {
    kind: "chat.record",
    record: { id: "chat-1", author: "user", text: "A private message the model should never see twice", createdAt: 1, updatedAt: 1 },
  }).brain;
  const plan = projectContext(brain, { budget: 10_000 });
  const rendered = renderContextPlan(plan);

  assert.equal(plan.blocks.length, 0);
  assert.equal(plan.references.length, 1);
  assert.doesNotMatch(rendered, /private message the model/);
  // Chat text reaches the model as a tool result, never as context projection.
  assert.doesNotMatch(rendered, /## Chat/);
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

  const plan = projectContext(brain, { budget: 1000 });
  const fresh = plan.blocks.find((block) => block.id === "user-pin:pin-1");
  const stale = plan.blocks.find((block) => block.id === "user-pin:pin-2:stale");

  assert.match(fresh?.text ?? "", /exact fresh text/);
  assert.match(stale?.text ?? "", /Stale pin/);
  assert.doesNotMatch(stale?.text ?? "", /old text must not enter/);
  assert.deepEqual(plan.omissions, [{ id: "user-pin:pin-2", label: "P2", reason: "stale" }]);
});

test("fresh context uses public handles, typed order, edges, and UTC timestamps", () => {
  let brain = createEmptyBrain();
  brain = {
    ...brain,
    ledger: [
      { id: "ledger:new-private", kind: "note", text: "Second Ledger record", status: "open", answer: null, createdAt: 20, updatedAt: 25 },
      { id: "ledger:old-private", kind: "goal", text: "First Ledger record", status: "open", answer: null, createdAt: 10, updatedAt: 10 },
    ],
    chat: [
      { id: "chat:later-private", author: "agent", text: "Later Agent Chat", createdAt: 40, updatedAt: 40 },
      { id: "chat:first-private", author: "user", text: "First Person Chat", createdAt: 30, updatedAt: 35 },
    ],
    atlas: [
      {
        id: "atlas:private-one",
        title: "Context order",
        claim: "Atlas follows the Ledger.",
        evidence: [source()],
        edges: [{ kind: "replaces", target: "atlas:private-two" }],
        createdAt: 50,
        updatedAt: 55,
      },
      {
        id: "atlas:private-two",
        title: "Second Atlas",
        claim: "This is linked.",
        evidence: [source()],
        edges: [],
        createdAt: 60,
        updatedAt: 60,
      },
    ],
    userPins: [{ id: "pin:private", item: "Pinned context", reason: "Keep it", source: source(), createdAt: 70 }],
    wakes: [{ id: "wake:private", kind: "time", condition: "100", status: "armed", reason: "Test wake", createdAt: 90 }],
  };

  const plan = projectContext(brain, { budget: 10_000 });
  const rendered = renderContextPlan(plan);
  const orderedSections = plan.blocks.map((block) => block.section);

  assert.deepEqual(orderedSections, ["ledger", "ledger", "atlas", "atlas", "pin", "wake"]);
  assert.deepEqual(
    plan.blocks.filter((block) => block.section === "ledger").map((block) => block.handle),
    ["L1", "L2"],
  );
  assert.match(plan.blocks.find((block) => block.handle === "A1")?.text ?? "", /Edges: replaces A2/);
  assert.match(plan.blocks.find((block) => block.handle === "A1")?.text ?? "", /1970-01-01T00:00:00.055Z/);
  assert.match(rendered, /L1 Ledger/);
  assert.doesNotMatch(rendered, /ledger:old-private|chat:first-private|atlas:private-one|pin:private|wake:private/);
  assert.ok(plan.references.every((reference) => !("id" in reference)));
});

test("only armed and ready wakes reach the projection", () => {
  let brain = createEmptyBrain();
  for (const [id, status] of [
    ["wake:armed", "armed"],
    ["wake:ready", "ready"],
    ["wake:consumed", "consumed"],
    ["wake:cancelled", "cancelled"],
  ]) {
    brain = decide(brain, {
      kind: "wake.upsert",
      wake: { id, kind: "time", condition: "100", status, reason: `Wake ${status}`, createdAt: 1 },
    }).brain;
  }

  const plan = projectContext(brain, { budget: 10_000 });
  const woken = plan.blocks.filter((block) => block.section === "wake").map((block) => block.handle);

  assert.equal(woken.length, 2);
});

test("a stale atlas claim is omitted from the projection and flagged for inspection", () => {
  let brain = createEmptyBrain();
  brain = decide(brain, {
    kind: "atlas.upsert",
    node: { id: "atlas-1", title: "Stale claim", claim: "Old claim text", evidence: [source("stale")], edges: [], createdAt: 1, updatedAt: 1 },
  }).brain;

  const plan = projectContext(brain, { budget: 10_000 });
  const block = plan.blocks.find((candidate) => candidate.section === "atlas");

  assert.match(block?.text ?? "", /Atlas · stale/);
  assert.doesNotMatch(block?.text ?? "", /Old claim text/);
  assert.deepEqual(plan.omissions, [{ id: "atlas:atlas-1", label: "A1", reason: "stale" }]);
});

test("a handle stays with its record across ordinary edits and new records", () => {
  let brain = createEmptyBrain();
  brain = decide(brain, {
    kind: "ledger.upsert",
    entry: { id: "ledger:first", kind: "goal", text: "First goal", status: "open", answer: null, createdAt: 10, updatedAt: 10 },
  }).brain;
  brain = decide(brain, {
    kind: "ledger.upsert",
    entry: { id: "ledger:second", kind: "note", text: "Second note", status: "open", answer: null, createdAt: 20, updatedAt: 20 },
  }).brain;
  const first = projectContext(brain, { budget: 10_000 });
  assert.deepEqual(first.blocks.filter((block) => block.section === "ledger").map((block) => block.handle), ["L1", "L2"]);

  brain = decide(brain, {
    kind: "ledger.upsert",
    entry: { id: "ledger:first", kind: "goal", text: "First goal, edited", status: "open", answer: null, createdAt: 10, updatedAt: 30 },
  }).brain;
  brain = decide(brain, {
    kind: "ledger.upsert",
    entry: { id: "ledger:third", kind: "question", text: "Third item", status: "open", answer: null, createdAt: 40, updatedAt: 40 },
  }).brain;

  const second = projectContext(brain, { budget: 10_000 });
  assert.deepEqual(second.blocks.filter((block) => block.section === "ledger").map((block) => block.handle), ["L1", "L2", "L3"]);
  assert.match(second.blocks.find((block) => block.handle === "L1")?.text ?? "", /First goal, edited/);
});

test("a collapse renumbers handles and keeps the records", () => {
  let brain = createEmptyBrain();
  for (const [index, id] of ["a", "b", "c"].entries()) {
    brain = decide(brain, {
      kind: "ledger.upsert",
      entry: { id: `ledger:${id}`, kind: "note", text: id, status: "open", answer: null, createdAt: index + 1, updatedAt: index + 1 },
    }).brain;
  }
  brain = decide(brain, { kind: "record.delete", target: { target: "ledger", id: "ledger:b" } }).brain;
  const plan = projectContext(brain, { budget: 10_000 });
  assert.deepEqual(plan.blocks.filter((block) => block.section === "ledger").map((block) => block.handle), ["L1", "L3"]);

  const collapsed = decide(brain, { kind: "collapse.rotate" }).brain;
  assert.equal(collapsed.ledger.length, 2);
  assert.deepEqual(collapsed.handles.entries.map((entry) => entry.handle), ["L1", "L2"]);
});

test("a public handle resolves to its private ID and an unknown handle fails", () => {
  let brain = createEmptyBrain();
  brain = decide(brain, {
    kind: "atlas.upsert",
    node: { id: "atlas:private", title: "T", claim: "C", evidence: [source()], edges: [], createdAt: 1, updatedAt: 1 },
  }).brain;

  assert.deepEqual(resolveHandle(brain.handles, "a1"), { kind: "atlas", id: "atlas:private" });
  assert.equal(resolveHandle(brain.handles, "A9"), undefined);
  assert.throws(() => resolveHandleOfKind(brain.handles, "A1", ["ledger"]), /does not name/);
});

test("an unknown command kind fails explicitly instead of being ignored", () => {
  assert.throws(() => decide(createEmptyBrain(), { kind: "nope.unknown" }), DomainError);
  assert.throws(() => decide(createEmptyBrain(), { kind: "record.delete", target: { target: "nope", id: "x" } }), DomainError);
});

test("records stay in creation order regardless of input order", () => {
  const brain = {
    ...createEmptyBrain(),
    ledger: [
      { id: "ledger:b", kind: "note", text: "b", status: "open", answer: null, createdAt: 2, updatedAt: 2 },
      { id: "ledger:a", kind: "note", text: "a", status: "open", answer: null, createdAt: 1, updatedAt: 1 },
    ],
  };
  assert.deepEqual(byCreatedAt(brain.ledger).map((entry) => entry.id), ["ledger:a", "ledger:b"]);
});
