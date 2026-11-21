import assert from "node:assert/strict";
import test from "node:test";

import { applyWrite } from "../dist/domain/brain.js";
import { projectContext } from "../dist/domain/projection.js";
import { emptyBrain } from "../dist/domain/records.js";

const at = (iso) => Date.parse(iso);
const timed = (id, author, text, iso) => ({ id, author, text, createdAt: at(iso), updatedAt: at(iso) });
const source = (path, freshness = "fresh") => ({ kind: "file", path, startLine: 10, endLine: 20, digest: "d", excerpt: "e", freshness });

test("the projection carries Atlas structure, handles, timestamps, never raw ids", () => {
  let brain = emptyBrain();
  brain = applyWrite(brain, { kind: "atlas.upsert", node: { id: "raw-node-id-1", title: "The collapse boundary", claim: "Collapse is person-triggered or agent-triggered", evidence: [source("MINI.md")], edges: [], createdAt: at("2026-11-16T04:00:00.000Z"), updatedAt: at("2026-11-16T04:30:00.000Z") } }, at("2026-11-16T04:30:00.000Z"));
  brain = applyWrite(brain, { kind: "atlas.upsert", node: { id: "raw-node-id-2", title: "Frozen", claim: "The projection never changes between collapses", evidence: [], edges: [{ kind: "depends-on", target: "raw-node-id-1" }], createdAt: at("2026-11-16T05:00:00.000Z"), updatedAt: at("2026-11-16T05:00:00.000Z") } }, at("2026-11-16T05:00:00.000Z"));
  const projection = projectContext(brain);
  assert.match(projection.text, /A1 The collapse boundary — 2026-11-16T04:30:00.000Z/);
  assert.match(projection.text, /A2 Frozen — 2026-11-16T05:00:00.000Z/);
  assert.match(projection.text, /evidence: MINI.md:10-20 \[fresh\]/);
  assert.match(projection.text, /→ depends-on A1/);
  assert.doesNotMatch(projection.text, /raw-node-id/);
});

test("chat text never appears in the projection", () => {
  let brain = emptyBrain();
  brain = applyWrite(brain, { kind: "chat.record", record: timed("raw-chat-id", "user", "the person's secret words", "2026-11-16T04:00:00.000Z") }, at("2026-11-16T04:00:00.000Z"));
  brain = applyWrite(brain, { kind: "chat.record", record: timed("raw-chat-id-2", "agent", "the agent's answer", "2026-11-16T04:01:00.000Z") }, at("2026-11-16T04:01:00.000Z"));
  const projection = projectContext(brain);
  assert.doesNotMatch(projection.text, /secret words|the agent's answer/);
  assert.doesNotMatch(projection.text, /raw-chat-id/);
});

test("an edge to a deleted node renders as (gone), never as a raw id", () => {
  let brain = emptyBrain();
  brain = applyWrite(brain, { kind: "atlas.upsert", node: { id: "n1", title: "old", claim: "old claim", evidence: [], edges: [], createdAt: at("2026-11-16T04:00:00.000Z"), updatedAt: at("2026-11-16T04:00:00.000Z") } }, at("2026-11-16T04:00:00.000Z"));
  brain = applyWrite(brain, { kind: "atlas.upsert", node: { id: "n2", title: "new", claim: "new claim", evidence: [], edges: [{ kind: "depends-on", target: "n1" }], createdAt: at("2026-11-16T04:01:00.000Z"), updatedAt: at("2026-11-16T04:01:00.000Z") } }, at("2026-11-16T04:01:00.000Z"));
  brain = applyWrite(brain, { kind: "delete", target: "atlas", id: "n1" }, at("2026-11-16T04:02:00.000Z"));
  const projection = projectContext(brain);
  assert.match(projection.text, /→ depends-on \(gone\)/);
  assert.doesNotMatch(projection.text, /\bn1\b/);
});

test("ledger answers render with evidence handles; empty brain renders the placeholder", () => {
  let brain = emptyBrain();
  assert.equal(projectContext(brain).text, "(the Brain is empty)");
  brain = applyWrite(brain, { kind: "ledger.upsert", entry: { id: "l1", kind: "goal", text: "finish R2", status: "answered", answer: { text: "projection lands", evidenceIds: [] }, createdAt: at("2026-11-16T04:00:00.000Z"), updatedAt: at("2026-11-16T04:05:00.000Z") } }, at("2026-11-16T04:05:00.000Z"));
  const projection = projectContext(brain);
  assert.match(projection.text, /L1 \[goal · answered\] finish R2 — 2026-11-16T04:05:00.000Z/);
  assert.match(projection.text, /→ answered: projection lands/);
});

test("pins render inline on their entries", () => {
  let brain = emptyBrain();
  brain = applyWrite(brain, { kind: "atlas.upsert", node: { id: "n1", title: "The collapse boundary", claim: "Collapse is person-triggered or agent-triggered", evidence: [], edges: [], createdAt: at("2026-11-16T04:00:00.000Z"), updatedAt: at("2026-11-16T04:00:00.000Z") } }, at("2026-11-16T04:00:00.000Z"));
  brain = applyWrite(brain, { kind: "pin.set", target: "atlas", id: "n1", pinned: "agent" }, at("2026-11-16T04:00:00.000Z"));
  const projection = projectContext(brain);
  assert.match(projection.text, /A1 The collapse boundary — 2026-11-16T04:00:00.000Z · \[pinned:agent\]/);
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
