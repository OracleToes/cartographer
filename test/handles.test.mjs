import assert from "node:assert/strict";
import test from "node:test";

import { emptyBrain } from "../dist/domain/records.js";
import { findByHandle, handleOf, rebuildHandles, reconcileHandles } from "../dist/domain/handles.js";

const at = (n) => 1_700_000_000_000 + n * 1_000;

function brainWith() {
  const brain = emptyBrain();
  brain.chat.push({ id: "chat-b", author: "agent", text: "later", createdAt: at(20), updatedAt: at(20) });
  brain.chat.push({ id: "chat-a", author: "user", text: "earlier", createdAt: at(10), updatedAt: at(10) });
  brain.ledger.push({ id: "ledger-1", kind: "goal", text: "goal", status: "open", answer: null, createdAt: at(30), updatedAt: at(30) });
  return brain;
}

test("rebuildHandles assigns contiguous prefixes in creation order", () => {
  const brain = brainWith();
  const handles = rebuildHandles(brain);
  // chat-a (t=10) < chat-b (t=20) < ledger-1 (t=30); each prefix counts from 1.
  assert.deepEqual(
    handles.entries.map((entry) => [entry.kind, entry.handle]),
    [["chat", "C1"], ["chat", "C2"], ["ledger", "L1"]],
  );
  assert.equal(handleOf(handles, "chat", "chat-a"), "C1");
  assert.equal(handleOf(handles, "chat", "chat-b"), "C2");
  // A handle resolves back to its record; an unknown one resolves to nothing.
  assert.equal(findByHandle(handles, "L1")?.id, "ledger-1");
  assert.equal(findByHandle(handles, "W9"), undefined);
});

test("reconcileHandles keeps existing handles, drops vanished records, numbers newcomers", () => {
  const brain = brainWith();
  brain.handles = rebuildHandles(brain);
  const staleChatA = handleOf(brain.handles, "chat", "chat-a");

  // Delete chat-a; its handle must not be reused while chat-b keeps C2.
  brain.chat = brain.chat.filter((record) => record.id !== "chat-a");
  let next = reconcileHandles(brain);
  assert.equal(handleOf(next.handles, "chat", "chat-b"), "C2");
  assert.equal(findByHandle(next.handles, staleChatA), undefined);

  // A newcomer takes the next free number, not a reused one.
  const withNew = { ...next, chat: [...next.chat, { id: "chat-c", author: "agent", text: "new", createdAt: at(40), updatedAt: at(40) }] };
  next = reconcileHandles(withNew);
  assert.equal(handleOf(next.handles, "chat", "chat-c"), "C3");
});

