import "./agent-reminder.mjs";
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

test("structured book edits validate JSON and reject concurrent changes", async () => {
  const { path, cleanup } = tempBrain();
  const store = await openBrain(path);
  try {
    const node = { id: "a1", title: "old", text: "detail", links: [], attachments: [], createdAt: at(1), updatedAt: at(1) };
    const entry = { id: "l1", kind: "question", text: "question", status: "open", answer: null, createdAt: at(1), updatedAt: at(1) };
    await store.apply({ kind: "atlas.upsert", node }, at(1));
    await store.apply({ kind: "ledger.upsert", entry }, at(1));
    const original = { kind: "atlas", value: (await store.read()).atlas[0] };
    const updated = { ...original.value, title: "new", attachments: [{ kind: "file", path: "src/a.ts" }] };
    await store.editBookRecord(original, JSON.stringify(updated), at(2));
    assert.equal((await store.read()).atlas[0].title, "new");
    assert.equal((await store.read()).atlas[0].updatedAt, at(2));
    await assert.rejects(store.editBookRecord(original, JSON.stringify(updated), at(3)), /changed or disappeared/);
    const ledger = { kind: "ledger", value: (await store.read()).ledger[0] };
    await assert.rejects(store.editBookRecord(ledger, "{", at(2)), SyntaxError);
    await assert.rejects(store.editBookRecord(ledger, JSON.stringify({ ...entry, status: "broken" }), at(2)), /Invalid ledger/);
    await assert.rejects(store.editBookRecord(ledger, JSON.stringify({ ...entry, id: "other" }), at(2)), /id and createdAt/);
    await store.editBookRecord(ledger, JSON.stringify({ ...entry, status: "answered", answer: { text: "yes" } }), at(3));
    assert.equal((await store.read()).ledger[0].answer.text, "yes");
    await store.applyRecordAction({ kind: "ledger", id: "l1", action: "archive", generation: "g", now: at(4) });
    const archived = (await store.readArchive()).items[0];
    await store.editArchivedRecord(archived, JSON.stringify({ ...archived.record.value, text: "archived change" }), at(5));
    assert.equal((await store.readArchive()).items[0].record.value.text, "archived change");
    await assert.rejects(store.editArchivedRecord(archived, JSON.stringify(archived.record.value), at(6)), /changed or disappeared/);
    await store.applyArchive({ kind: "restore", id: archived.id });
    assert.equal((await store.read()).ledger[0].text, "archived change");
  } finally { await store.close(); cleanup(); }
});

test("archived tool calls edit JSON arguments while preserving restore identity", async () => {
  const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const { archivedEphemeralText } = await import("../dist/domain/archive-editor.js");
  const { path, cleanup } = tempBrain();
  const store = await openBrain(path);
  try {
    const model = [fauxAssistantMessage([fauxToolCall("read", { path: "old" }, { id: "call-a" })], { stopReason: "toolUse" })];
    await store.archiveEphemeral({ id: "item", layer: "ephemeral", ephemeral: { kind: "toolCall", text: 'read {"path":"old"}', model } }, "g", at(1));
    const item = (await store.readArchive()).items[0];
    assert.match(archivedEphemeralText(item), /old/);
    await assert.rejects(store.editArchivedEphemeral(item, "[]"), /JSON object/);
    await store.editArchivedEphemeral(item, '{"path":"new"}');
    const updated = (await store.readArchive()).items[0];
    assert.equal(updated.ephemeral.text, 'read {"path":"new"}');
    assert.equal(updated.ephemeral.model[0].content[0].id, "call-a");
    assert.equal(updated.ephemeral.model[0].content[0].arguments.path, "new");
  } finally { await store.close(); cleanup(); }
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

test("applying a record's mark now moves it to the archive or deletes it, in one step", async () => {
  // §4.1: applying an action now is the mark's own application. An archived
  // record leaves the Brain and is in the archive — moved, not copied — and a
  // deleted one leaves the Brain and goes nowhere. A record that is not there
  // changes nothing: the person may have acted on it a moment ago.
  const { path, cleanup } = tempBrain();
  try {
    const store = await openBrain(path);
    await store.apply({ kind: "chat.record", record: chat("c1", "keep me in the archive", at(1)) }, at(1));
    await store.apply({ kind: "chat.record", record: chat("c2", "gone for good", at(2)) }, at(2));

    const archived = await store.applyRecordAction({ kind: "chat", id: "c1", action: "archive", generation: "gen-now", now: at(3) });
    assert.equal(archived.found, true);
    assert.equal(archived.brain.chat.length, 1, "the archived record is not in the Brain any more");
    const items = (await store.readArchive()).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].record?.kind, "chat");
    assert.equal(items[0].record?.value.text, "keep me in the archive");
    assert.equal(items[0].sweptAtGeneration, "gen-now");

    const deleted = await store.applyRecordAction({ kind: "chat", id: "c2", action: "delete", generation: "gen-now", now: at(4) });
    assert.equal(deleted.found, true);
    assert.equal(deleted.brain.chat.length, 0, "a deleted record is gone, not archived");
    assert.equal((await store.readArchive()).items.length, 1, "a delete archives nothing");

    const missing = await store.applyRecordAction({ kind: "chat", id: "c2", action: "archive", generation: "gen-now", now: at(5) });
    assert.equal(missing.found, false);
    assert.equal((await store.readArchive()).items.length, 1, "and a record that is not there changes nothing");

    await store.close();
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

test("compact runs secure-delete and VACUUM and loses nothing", async () => {
  const { path, cleanup } = tempBrain();
  try {
    const store = await openBrain(path);
    await store.apply({ kind: "chat.record", record: chat("c1", "remembered", at(1)) }, at(1));
    await store.compact();
    const brain = await store.read();
    assert.equal(brain.chat.length, 1);
    assert.equal(brain.chat[0].text, "remembered");
    await store.close();
  } finally {
    cleanup();
  }
});
