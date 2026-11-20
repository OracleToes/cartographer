import assert from "node:assert/strict";
import test from "node:test";

import { disclosureLines } from "../dist/runtime/ui.js";

const streamed = {
  id: "activity-1",
  kind: "model",
  label: "Model output",
  text: "one\ntwo\nthree\nfour\nfive\nsix\nseven",
  streaming: true,
  completed: false,
};

test("a long live disclosure follows its newest five rows and expands upward", () => {
  assert.deepEqual(disclosureLines(streamed, 5, false, 120), ["three", "four", "five", "six", "seven"]);
  assert.deepEqual(disclosureLines(streamed, 5, true, 120), ["one", "two", "three", "four", "five", "six", "seven"]);
});

test("a completed transient disclosure folds to one line but remains expandable", () => {
  const completed = { ...streamed, completed: true, streaming: false };
  assert.deepEqual(disclosureLines(completed, 5, false, 120), ["one"]);
  assert.deepEqual(disclosureLines(completed, 5, true, 120), ["one", "two", "three", "four", "five", "six", "seven"]);
});

const { parseCommand } = await import("../dist/runtime/ui.js");

test("person commands accept short handles only", () => {
  assert.deepEqual(parseCommand("/delete C2"), { kind: "delete", handle: "C2" });
  assert.deepEqual(parseCommand("/unpin P3"), { kind: "unpin", handle: "P3" });
  assert.deepEqual(parseCommand("/cancel-wake W1"), { kind: "cancel-wake", handle: "W1", reason: "The person cancelled this wake." });
  // A private durable ID is never a valid command argument.
  assert.throws(() => parseCommand("/delete chat:private"), /Unknown or incomplete command/);
  assert.throws(() => parseCommand("/delete user:0f2c"), /Unknown or incomplete command/);
});

test("Ledger, Atlas, and wake commands take an optional handle", () => {
  assert.deepEqual(parseCommand("/ledger L1 | goal | open | Ship it | Done"), {
    kind: "ledger",
    handle: "L1",
    kindName: "goal",
    status: "open",
    text: "Ship it",
    answer: "Done",
    evidence: [],
  });
  assert.equal(parseCommand("/ledger note | open | A new note")?.handle, null);
  assert.deepEqual(parseCommand("/atlas A2 | Title | Claim | src/main.ts:1-2 | replaces:A1,depends-on:L1"), {
    kind: "atlas",
    handle: "A2",
    title: "Title",
    claim: "Claim",
    path: "src/main.ts",
    startLine: 1,
    endLine: 2,
    edges: [
      { kind: "replaces", handle: "A1" },
      { kind: "depends-on", handle: "L1" },
    ],
  });
  assert.deepEqual(parseCommand("/wake W1 | time | 2030-01-01T00:00:00Z | Check back"), {
    kind: "wake",
    handle: "W1",
    wakeKind: "time",
    condition: "2030-01-01T00:00:00Z",
    reason: "Check back",
  });
  assert.deepEqual(parseCommand("/wake path | src | Watch the folder"), {
    kind: "wake",
    handle: null,
    wakeKind: "path",
    condition: "src",
    reason: "Watch the folder",
  });
});
