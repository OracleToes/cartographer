import assert from "node:assert/strict";
import test from "node:test";

import { applyWrite } from "../dist/domain/brain.js";
import { projectContext } from "../dist/domain/projection.js";
import { emptyBrain } from "../dist/domain/records.js";

const at = (iso) => Date.parse(iso);
const timed = (id, author, text, iso) => ({ id, author, text, createdAt: at(iso), updatedAt: at(iso) });

test("the projection carries Atlas structure, handles, timestamps, never raw ids", () => {
  let brain = emptyBrain();
  brain = applyWrite(brain, { kind: "atlas.upsert", node: { id: "raw-node-id-1", title: "The collapse boundary", text: "Collapse is person-triggered or agent-triggered", links: [], attachments: [{ kind: "file", path: "MINI.md" }], createdAt: at("2026-11-16T04:00:00.000Z"), updatedAt: at("2026-11-16T04:30:00.000Z") } }, at("2026-11-16T04:30:00.000Z"));
  brain = applyWrite(brain, { kind: "atlas.upsert", node: { id: "raw-node-id-2", title: "Frozen", text: "The projection never changes between collapses", links: ["raw-node-id-1"], attachments: [], createdAt: at("2026-11-16T05:00:00.000Z"), updatedAt: at("2026-11-16T05:00:00.000Z") } }, at("2026-11-16T05:00:00.000Z"));
  const projection = projectContext(brain);
  assert.match(projection.text, /A1 The collapse boundary — 2026-11-16T04:30:00.000Z/);
  assert.match(projection.text, /A2 Frozen — 2026-11-16T05:00:00.000Z/);
  assert.match(projection.text, /attach: MINI\.md/);
  assert.match(projection.text, /link: A1/);
  assert.doesNotMatch(projection.text, /raw-node-id/);
});

test("the head holds every Chat record, the person's and the agent's, in the order said, under handles", () => {
  let brain = emptyBrain();
  brain = applyWrite(brain, { kind: "chat.record", record: timed("raw-chat-id", "user", "the person's words\nover two lines", "2026-11-16T04:00:00.000Z") }, at("2026-11-16T04:00:00.000Z"));
  brain = applyWrite(brain, { kind: "chat.record", record: timed("raw-chat-id-2", "agent", "the agent's answer", "2026-11-16T04:01:00.000Z") }, at("2026-11-16T04:01:00.000Z"));
  const projection = projectContext(brain, new Map(), "OracleToes");
  assert.match(projection.text, /C1 \[OracleToes\] — 2026-11-16T04:00:00.000Z\n  the person's words\n  over two lines/);
  assert.match(projection.text, /C2 \[you\] — 2026-11-16T04:01:00.000Z\n  the agent's answer/);
  assert.ok(projection.text.indexOf("C1") < projection.text.indexOf("C2"));
  assert.doesNotMatch(projection.text, /raw-chat-id/);
  assert.ok(projection.sizes.chat > 0, "the head's Chat is sized like the other parts");
  // A deleted record is not in the head: only a delete removes Chat, and it is gone.
  const gone = projectContext(applyWrite(brain, { kind: "delete", target: "chat", id: "raw-chat-id" }, 1), new Map(), "OracleToes");
  assert.doesNotMatch(gone.text, /the person's words/);
  // A head keeps to the records it was asked to hold, and says which they are.
  const only = projectContext(brain, new Map(), "OracleToes", { chat: new Set(["raw-chat-id-2"]) });
  assert.doesNotMatch(only.text, /the person's words/);
  assert.deepEqual(only.chatIds, ["raw-chat-id-2"]);
  assert.deepEqual(projection.chatIds, ["raw-chat-id", "raw-chat-id-2"]);
});

test("a link to a deleted node renders as (gone), never as a raw id", () => {
  let brain = emptyBrain();
  brain = applyWrite(brain, { kind: "atlas.upsert", node: { id: "n1", title: "old", text: "old text", links: [], attachments: [], createdAt: at("2026-11-16T04:00:00.000Z"), updatedAt: at("2026-11-16T04:00:00.000Z") } }, at("2026-11-16T04:00:00.000Z"));
  brain = applyWrite(brain, { kind: "atlas.upsert", node: { id: "n2", title: "new", text: "new text", links: ["n1"], attachments: [], createdAt: at("2026-11-16T04:01:00.000Z"), updatedAt: at("2026-11-16T04:01:00.000Z") } }, at("2026-11-16T04:01:00.000Z"));
  brain = applyWrite(brain, { kind: "delete", target: "atlas", id: "n1" }, at("2026-11-16T04:02:00.000Z"));
  const projection = projectContext(brain);
  assert.match(projection.text, /link: \(gone\)/);
  assert.doesNotMatch(projection.text, /\bn1\b/);
});

test("ledger answers render; empty brain renders the placeholder", () => {
  let brain = emptyBrain();
  assert.match(projectContext(brain).text, /^\(the Brain is empty/);
  brain = applyWrite(brain, { kind: "ledger.upsert", entry: { id: "l1", kind: "goal", text: "finish R2", status: "answered", answer: { text: "projection lands" }, createdAt: at("2026-11-16T04:00:00.000Z"), updatedAt: at("2026-11-16T04:05:00.000Z") } }, at("2026-11-16T04:05:00.000Z"));
  const projection = projectContext(brain);
  assert.match(projection.text, /L1 \[goal · answered\] finish R2 — 2026-11-16T04:05:00.000Z/);
  assert.match(projection.text, /→ answered: projection lands/);
});

test("pins render inline on their entries", () => {
  let brain = emptyBrain();
  brain = applyWrite(brain, { kind: "atlas.upsert", node: { id: "n1", title: "The collapse boundary", text: "Collapse is person-triggered or agent-triggered", links: [], attachments: [], createdAt: at("2026-11-16T04:00:00.000Z"), updatedAt: at("2026-11-16T04:00:00.000Z") } }, at("2026-11-16T04:00:00.000Z"));
  brain = applyWrite(brain, { kind: "mark.set", target: "atlas", id: "n1", action: "archive", author: "agent" }, at("2026-11-16T04:00:00.000Z"));
  brain = applyWrite(brain, { kind: "pin.set", target: "atlas", id: "n1", pinned: "agent" }, at("2026-11-16T04:00:00.000Z"));
  const projection = projectContext(brain);
  assert.match(projection.text, /A1 The collapse boundary — 2026-11-16T04:00:00.000Z · \[pinned by you\]/);
  assert.doesNotMatch(projection.text, /Pins/);
});

test("the projection omits nothing: all 50 ledger entries render in the frozen text", () => {
  let brain = emptyBrain();
  for (let index = 0; index < 50; index += 1) {
    const minute = String(index).padStart(2, "0");
    brain = applyWrite(brain, { kind: "ledger.upsert", entry: { id: `l${index}`, kind: "note", text: `note ${index} ${"x".repeat(80)}`, status: "open", answer: null, createdAt: at(`2026-11-16T04:${minute}:00.000Z`), updatedAt: at(`2026-11-16T04:${minute}:00.000Z`) } }, at("2026-11-16T04:00:00.000Z"));
  }
  const { text: frozen } = projectContext(brain);
  for (let index = 0; index < 50; index += 1) {
    assert.ok(frozen.includes(`note ${index} `), `entry ${index} must render; no omission list exists`);
  }
});

test("a pinned ephemeral item is in the head after Chat, under its own handle, with no raw id", () => {
  let brain = emptyBrain();
  brain = applyWrite(
    brain,
    { kind: "ephemeral.pin", item: { id: "gen:7:t0", text: "keep this thought", kind: "reasoning", createdAt: at("2026-01-01T00:00:00Z"), pinned: "user" } },
    at("2026-01-01T00:00:01Z"),
  );
  brain = applyWrite(brain, { kind: "chat.record", record: timed("c1", "user", "said this", "2025-12-31T00:00:00Z") }, at("2026-01-01T00:00:02Z"));

  const projection = projectContext(brain, new Map(), "OracleToes");
  const text = projection.text;
  assert.match(text, /Pinned — what OracleToes kept in front of you/);
  assert.match(text, /X1 \[reasoning\] keep this thought/);
  assert.ok(text.indexOf("said this") < text.indexOf("keep this thought"), "Chat comes before what was pinned after it");
  assert.equal(text.includes("gen:7:t0"), false, "the storage id never reaches the model");
  assert.ok(projection.sizes.ephemera > 0, "the part reports its size, so the person can see what it costs");
});

test("an unpinned partial is not in the head: a restored item waits for its pin", () => {
  let brain = emptyBrain();
  brain = applyWrite(
    brain,
    { kind: "ephemeral.pin", item: { id: "gen:7:t0", text: "restored but unpinned", kind: "reasoning", createdAt: at("2026-01-01T00:00:00Z") } },
    at("2026-01-01T00:00:01Z"),
  );
  assert.equal(projectContext(brain).text.includes("restored but unpinned"), false);
});
