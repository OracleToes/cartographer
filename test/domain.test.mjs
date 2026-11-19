import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyBrain } from "../dist/domain/brain.js";
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

test("a context plan uses the active generation carry selection", () => {
  let brain = createEmptyBrain();
  brain = decide(brain, {
    kind: "pin.carry.add",
    pin: { id: "carry:future", item: "Future carry", reason: "For the next collapse", source: source(), createdAt: 1 },
  }).brain;
  const selected = {
    id: "carry:selected",
    item: "Selected live carry",
    reason: "It entered this live generation.",
    source: { kind: "context", contextId: "old-generation", excerpt: "Exact selected working context.", freshness: "fresh" },
    createdAt: 1,
  };

  const plan = projectContext(brain, { budget: 1000, carryPins: [selected, ...brain.carryPins] });

  assert.ok(plan.blocks.some((block) => block.id === "carry-pin:carry:selected" && block.text.includes("Exact selected working context.")));
  assert.ok(plan.blocks.some((block) => block.id === "carry-pin:carry:future"));
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

  const plan = projectContext(brain, { budget: 1000, userMessage: "Tell me about main", at: 1_700_000_000_000 });
  const fresh = plan.blocks.find((block) => block.id === "user-pin:pin-1");
  const stale = plan.blocks.find((block) => block.id === "user-pin:pin-2:stale");

  assert.match(fresh?.text ?? "", /exact fresh text/);
  assert.match(stale?.text ?? "", /Stale pin/);
  assert.doesNotMatch(stale?.text ?? "", /old text must not enter/);
  assert.deepEqual(plan.omissions, [{ id: "user-pin:pin-2", label: "P2", reason: "stale" }]);
});

test("fresh Carto context uses public handles, typed order, links, and UTC timestamps", () => {
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
        claim: "Atlas follows Chat.",
        evidence: [source()],
        links: ["atlas:private-two", "ledger:old-private"],
        createdAt: 50,
        updatedAt: 55,
      },
      {
        id: "atlas:private-two",
        title: "Second Atlas",
        claim: "This is linked.",
        evidence: [source()],
        links: [],
        createdAt: 60,
        updatedAt: 60,
      },
    ],
    userPins: [{ id: "pin:private", item: "Pinned context", reason: "Keep it", source: source(), createdAt: 70 }],
    handoff: {
      intent: "Finish order tests",
      activeLedgerIds: ["ledger:old-private"],
      openQuestionIds: ["ledger:new-private"],
      relevantAtlasIds: ["atlas:private-two"],
      nextAction: "Run the test.",
      note: "",
      updatedAt: 80,
    },
    wakes: [{ id: "wake:private", kind: "time", condition: "100", status: "armed", reason: "Test wake", createdAt: 90 }],
  };

  const plan = projectContext(brain, { budget: 10_000, userMessage: "Current work", at: 100 });
  const rendered = renderContextPlan(plan);
  const orderedSections = plan.blocks.map((block) => block.section);

  assert.deepEqual(orderedSections, ["rules", "ledger", "ledger", "chat", "chat", "atlas", "atlas", "pin", "handoff", "active", "message"]);
  assert.deepEqual(
    plan.blocks.filter((block) => block.section === "ledger").map((block) => block.handle),
    ["L1", "L2"],
  );
  assert.deepEqual(
    plan.blocks.filter((block) => block.section === "chat").map((block) => block.handle),
    ["C1", "C2"],
  );
  assert.match(plan.blocks.find((block) => block.handle === "A1")?.text ?? "", /Links: A2, L1/);
  assert.match(plan.blocks.find((block) => block.handle === "H1")?.text ?? "", /Open Ledger: L1/);
  assert.match(plan.blocks.find((block) => block.handle === "C1")?.text ?? "", /1970-01-01T00:00:00.030Z/);
  assert.match(rendered, /L1 Ledger/);
  assert.match(rendered, /C1 Person Chat/);
  assert.doesNotMatch(rendered, /ledger:old-private|chat:first-private|atlas:private-one|pin:private|wake:private/);
  assert.ok(plan.references.every((reference) => !("id" in reference)));
});

test("an immediate context restart discards old live and archive generations", () => {
  const brain = {
    ...createEmptyBrain(),
    context: { liveGeneration: "live", archiveGeneration: "archive" },
  };
  const result = decide(brain, { kind: "context.restart", newLiveGeneration: "fresh" });

  assert.deepEqual(result.brain.context, { liveGeneration: "fresh", archiveGeneration: null });
  assert.deepEqual(result.effects, [
    { kind: "discard-context", generation: "live" },
    { kind: "discard-context", generation: "archive" },
  ]);
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

test("a hidden record keeps its handle and a collapse renumbers the new generation", () => {
  let brain = { ...createEmptyBrain(), context: { liveGeneration: "g1", archiveGeneration: null } };
  for (const [index, id] of ["a", "b", "c"].entries()) {
    brain = decide(brain, {
      kind: "chat.record",
      record: { id: `chat:${id}`, author: "user", text: id, createdAt: index + 1, updatedAt: index + 1 },
    }).brain;
  }
  brain = decide(brain, { kind: "deletion.mark", mark: { target: "chat", id: "chat:b", markedAt: 5 } }).brain;
  const plan = projectContext(brain, { budget: 10_000 });
  assert.deepEqual(plan.blocks.filter((block) => block.section === "chat").map((block) => block.handle), ["C1", "C3"]);

  const collapsed = decide(brain, { kind: "collapse.rotate", newLiveGeneration: "g2" }).brain;
  assert.equal(collapsed.chat.length, 2);
  assert.deepEqual(collapsed.handles.entries.map((entry) => entry.handle), ["C1", "C2"]);
});

test("a public handle resolves to its private ID and an unknown handle fails", () => {
  let brain = createEmptyBrain();
  brain = decide(brain, {
    kind: "atlas.upsert",
    node: { id: "atlas:private", title: "T", claim: "C", evidence: [source()], links: [], createdAt: 1, updatedAt: 1 },
  }).brain;

  assert.deepEqual(resolveHandle(brain.handles, "a1"), { kind: "atlas", id: "atlas:private" });
  assert.equal(resolveHandle(brain.handles, "A9"), undefined);
  assert.throws(() => resolveHandleOfKind(brain.handles, "A1", ["ledger"]), /does not name/);
});
