import "./agent-reminder.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openBrain } from "../dist/runtime/brain-store.js";
import { prepareReturnSweepRecords } from "../dist/runtime/delegate-sweep-records.js";
import { delegateReturnChat, prepareDelegation, startDelegation, returnDelegation } from "../dist/runtime/delegation-record.js";
import { applyWrite } from "../dist/domain/brain.js";
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

test("Chat and pinned work edits validate, preserve identities, and reject stale originals", async () => {
  const { path, cleanup } = tempBrain();
  const store = await openBrain(path);
  try {
    const record = chat("chat-one", "old", at(1));
    await store.apply({ kind: "chat.record", record }, at(1));
    await store.editBookRecord({ kind: "chat", value: record }, JSON.stringify({ ...record, text: "new" }), at(2));
    assert.equal((await store.read()).chat[0].text, "new");
    await assert.rejects(store.editBookRecord({ kind: "chat", value: record }, JSON.stringify(record), at(3)), /changed or disappeared/);
    const updated = (await store.read()).chat[0];
    await assert.rejects(store.editBookRecord({ kind: "chat", value: updated }, JSON.stringify({ ...updated, author: "agent" }), at(3)), /author cannot/);
    const pin = { id: "pin", kind: "toolCall", text: 'read {"path":"old"}', createdAt: at(1), pinned: "user", entity: { callId: "call" } };
    await store.apply({ kind: "ephemeral.pin", item: pin }, at(1));
    await assert.rejects(store.editPinnedEphemeral(pin, "[]"), /JSON object/);
    await store.editPinnedEphemeral(pin, '{"path":"new"}');
    assert.deepEqual((await store.read()).ephemera[0], { ...pin, text: 'read {"path":"new"}' });
    await assert.rejects(store.editPinnedEphemeral(pin, "{}"), /changed or disappeared/);
    const readPin = { ...pin, id: "result", kind: "readResult", text: "data", entity: { callId: "call", path: "src/file" } };
    await store.apply({ kind: "ephemeral.pin", item: readPin }, at(1));
    await assert.rejects(store.editPinnedEphemeral(readPin, "new"), /source file/);
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

test("return record planning matches the Brain sweep and refuses overwriting archive or restored records", async () => {
  const { path, cleanup } = tempBrain();
  const store = await openBrain(path);
  try {
    await store.apply({ kind: "chat.record", record: chat("old", "restore me", at(1)) }, at(1));
    await store.applyRecordAction({ kind: "chat", id: "old", action: "archive", generation: "gen-old", now: at(2) });
    await store.applyArchive({ kind: "mark", id: "record:chat:old", action: "restore", author: "user" });
    await store.archiveEphemeral({ id: "past-work", layer: "ephemeral", ephemeral: { kind: "personMessage", text: "later" } }, "gen-old", at(2));
    await store.applyArchive({ kind: "mark", id: "past-work", action: "restore", author: "user" });
    for (const id of ["archive", "delete"]) {
      await store.apply({ kind: "chat.record", record: chat(id, id, at(3)) }, at(3));
      await store.apply({ kind: "mark.set", target: "chat", id, action: id, author: "user" }, at(4));
    }
    const expected = { brain: await store.read(), archive: await store.readArchive() };
    const incoming = [{ id: "live-work", layer: "ephemeral", ephemeral: { kind: "plainText", text: "delegate work" } }];
    const original = structuredClone(expected);
    const plan = prepareReturnSweepRecords(expected.brain, expected.archive, incoming, [], at(5));
    assert.deepEqual(expected, original, "planning does not mutate either snapshot");
    assert.deepEqual(plan.nextBrain.chat.map((record) => record.id), ["old"]);
    assert.ok(plan.incoming.some((item) => item.id === "record:chat:archive" && item.record.value.mark === undefined));
    assert.ok(!plan.incoming.some((item) => item.id === "record:chat:delete"));
    assert.deepEqual(plan.pendingEphemeralRestores.map((item) => item.id), ["past-work"]);
    assert.throws(() => prepareReturnSweepRecords(expected.brain, expected.archive, [incoming[0], incoming[0]], [], at(5)), /archive identity conflicts/);
    assert.throws(() => prepareReturnSweepRecords(expected.brain, expected.archive, [{ ...incoming[0], id: "past-work" }], [], at(5)), /archive identity conflicts/);
    const colliding = structuredClone(expected.brain);
    colliding.chat.push(chat("old", "different", at(1)));
    assert.throws(() => prepareReturnSweepRecords(colliding, expected.archive, incoming, [], at(5)), /restore conflicts with the Brain/);
    const repeated = structuredClone(expected.brain);
    repeated.chat.push(repeated.chat[0]);
    assert.throws(() => prepareReturnSweepRecords(repeated, expected.archive, incoming, [], at(5)), /Ambiguous Brain record/);
    await store.beginCollapse("gen-source", "gen-next");
    const applied = await store.applyCollapse({ source: "gen-source", generation: "gen-next", expected, writes: plan.writes, incoming: plan.incoming, now: at(5) });
    assert.deepEqual(applied.brain, plan.nextBrain);
    assert.deepEqual(applied.restored, plan.restored);
    assert.equal(applied.archive.items.find((item) => item.id === "past-work").restorePending, true);
    assert.ok(applied.archive.items.some((item) => item.id === "record:chat:archive"));
    assert.ok(applied.archive.items.some((item) => item.id === "live-work"));
  } finally { await store.close(); cleanup(); }
});

test("report Chat commits with its handoff and sweep and remains checked during recovery", async () => {
  const { path, cleanup } = tempBrain();
  let store = await openBrain(path);
  try {
    await store.apply({ kind: "chat.record", record: chat("old", "restore me", at(1)) }, at(1));
    await store.applyRecordAction({ kind: "chat", id: "old", action: "archive", generation: "gen-old", now: at(2) });
    await store.applyArchive({ kind: "mark", id: "record:chat:old", action: "restore", author: "user" });
    const expected = { brain: await store.read(), archive: await store.readArchive() };
    const handoff = { active: null };
    prepareDelegation(handoff, { id: "delegate:9", role: "capture", instruction: "Inspect", doneWhen: "Report" });
    startDelegation(handoff, "delegate:9", 2);
    const report = { status: "done", findings: "found", changes: "none", checks: "none", uncertainty: "none", remaining: "none", mainMessage: "Exact report message" };
    returnDelegation(handoff, "delegate:9", { kind: "delegate", report });
    const content = JSON.stringify(handoff);
    const returnChat = delegateReturnChat(content, "delegate:9", "gen-source", at(5));
    const chatStep = { write: { kind: "chat.record", record: returnChat }, now: at(5) };
    const recordSource = applyWrite(expected.brain, chatStep.write, chatStep.now);
    const plan = prepareReturnSweepRecords(recordSource, expected.archive, [], [], at(5));
    const transfer = { source: "gen-source", destination: "gen-next", documentId: 1, revision: 1, content, returnChat };
    const change = { source: "gen-source", generation: "gen-next", expected, writes: [chatStep, ...plan.writes], incoming: plan.incoming, delegationTransfer: transfer, now: at(5) };
    await store.beginCollapse(change.source, change.generation);
    await assert.rejects(store.applyCollapse({ ...change, writes: [] }), /return Chat write is missing/);
    await assert.rejects(store.applyCollapse({ ...change, writes: [chatStep, chatStep] }), /return Chat write is missing/);
    await assert.rejects(store.applyCollapse({ ...change, delegationTransfer: { ...transfer, returnChat: { ...returnChat, text: "forged" } } }), /return Chat conflicts/);
    await assert.rejects(store.applyCollapse({ ...change, incoming: [{ id: "conflict", layer: "record", record: { kind: "chat", value: returnChat } }] }), /return Chat conflicts/);
    assert.deepEqual(await store.read(), expected.brain);
    assert.equal((await store.readCollapseJournal()).committed, false);
    assert.equal(await store.readDelegationTransfer(), undefined);
    const applied = await store.applyCollapse(change);
    assert.deepEqual(applied.brain, plan.nextBrain, "projection planning and committed Chat order agree");
    assert.deepEqual(applied.brain.chat.map((record) => record.id), [returnChat.id, "old"]);
    assert.equal((await store.readCollapseJournal()).committed, true);
    assert.deepEqual(await store.readDelegationTransfer(), transfer);
    await store.close();
    store = await openBrain(path);
    await assert.rejects(store.applyCollapse(change), /no matching uncommitted journal/);
    assert.equal((await store.read()).chat.filter((record) => record.id === returnChat.id).length, 1);
    await store.apply({ kind: "chat.update", id: returnChat.id, text: "changed", updatedAt: at(5) }, at(5));
    await assert.rejects(store.recoverCollapseJournal(async () => { throw new Error("must not reach cleanup"); }), /return Chat changed/);
    assert.equal((await store.readCollapseJournal()).committed, true);
    await store.apply({ kind: "chat.update", id: returnChat.id, text: returnChat.text, updatedAt: at(5) }, at(5));
    await assert.rejects(store.recoverCollapseJournal(async () => { throw new Error("simulated crash before cleanup"); }), /simulated crash/);
    assert.equal((await store.readCollapseJournal()).committed, true);
    await store.recoverCollapseJournal(async (journal, retained) => {
      assert.equal(journal.committed, true);
      assert.deepEqual(retained, transfer);
    });
    assert.equal(await store.readCollapseJournal(), undefined);
    assert.deepEqual(await store.readDelegationTransfer(), transfer);
  } finally { await store.close(); cleanup(); }
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
