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
