import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

import { BrainStore } from "../dist/runtime/brain-store.js";
import {
  appendStateBlock,
  isStateBlockText,
  renderStateBlock,
  stripStateBlocks,
  STATE_BLOCK_MARKER,
} from "../dist/runtime/state-block.js";
import { LiveSession } from "../dist/runtime/live-session.js";
import { PromptStore } from "../dist/runtime/prompt-store.js";

const baseInput = {
  transcriptTokens: 700,
  toolWorkTokens: 100,
  systemTokens: 300,
  contextWindow: 32_768,
  parts: { ledger: 42, atlas: 0, chat: 0, pins: 0, wakes: 0 },
  pending: [],
  stale: [],
  wakes: [],
  tree: undefined,
};

test("the block renders every §21 item and marks estimates with ▤", () => {
  const block = renderStateBlock({
    ...baseInput,
    pending: [
      { handle: "L1", kind: "ledger", deleted: false },
      { handle: "P1", kind: "pin", deleted: true },
    ],
    stale: ["A1"],
    wakes: [{ handle: "W1", kind: "time", condition: "2026-12-01T00:00:00.000Z", status: "ready" }],
    tree: { root: "/project", depth: 2, lines: ["  docs/"] },
  });
  assert.match(block, /^<carto-state>/);
  assert.match(block, /^context ▤/m);
  assert.match(block, /ledger ▤42/);
  assert.match(block, /tool work ▤100/);
  assert.match(block, /transcript ▤700/);
  assert.match(block, /stable ▤258/);
  assert.match(block, /^pending L1 ledger$/m);
  assert.match(block, /^pending P1 pin · deleted$/m);
  assert.match(block, /^stale A1$/m);
  assert.match(block, /^wakes W1 time 2026-12-01T00:00:00.000Z · ready$/m);
  assert.match(block, /^tree \/project · depth 2$/m);
  assert.match(block, /^ {2}docs\/$/m);
  assert.match(block, /<\/carto-state>$/);
});

test("the context line carries ▤ before any provider count, and is exact with no delta", () => {
  const first = renderStateBlock(baseInput);
  assert.match(first.split("\n")[1], /^context ▤/);
  assert.doesNotMatch(first.split("\n")[1], /last reported/);

  const exact = renderStateBlock({ ...baseInput, lastReportedInput: 1_500 });
  assert.equal(exact.split("\n")[1], "context 1.5k/32.8k (5%) · last reported 1,500");

  const sinceDelta = renderStateBlock({ ...baseInput, lastReportedInput: 1_500, previousPromptTokens: 1_000 });
  assert.match(sinceDelta.split("\n")[1], /^context ▤1\.6k\/32\.8k \(5%\) · last reported 1,500 \(\+▤100 since\)$/);
});

test("the pending list counts overflow instead of dropping it", () => {
  const pending = Array.from({ length: 23 }, (_, index) => ({ handle: `P${index + 1}`, kind: "pin", deleted: false }));
  const block = renderStateBlock({ ...baseInput, pending });
  const lines = block.split("\n");
  assert.equal(lines.filter((line) => /^pending P\d+ pin$/.test(line)).length, 20);
  assert.match(block, /^pending \+3 more$/m);
});

test("stripStateBlocks removes markers and blocks from non-person roles only", () => {
  const block = `<carto-state>\nstale none\n</carto-state>`;
  const messages = [
    { role: "user", content: "please ship it" },
    { role: "user", content: STATE_BLOCK_MARKER },
    { role: "user", content: block },
    { role: "system", content: block },
    { role: "developer", content: `${STATE_BLOCK_MARKER}\n` },
    { role: "assistant", content: block },
    { role: "toolResult", content: [{ type: "text", text: STATE_BLOCK_MARKER }] },
  ];
  const stripped = stripStateBlocks(messages);
  assert.deepEqual(
    stripped.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );
  assert.equal(stripped[0].content, "please ship it");
});

test("appendStateBlock appends exactly one trailing user-role message", () => {
  const block = "<carto-state>\nstale none\n</carto-state>";
  const messages = [{ role: "user", content: "hello" }];
  const result = appendStateBlock(messages, block);
  assert.equal(result.length, 2);
  assert.equal(result[1].role, "user");
  assert.equal(result[1].content, block);
  assert.equal(messages.length, 1);
});

test("isStateBlockText matches only the marker and complete blocks", () => {
  assert.equal(isStateBlockText(STATE_BLOCK_MARKER), true);
  assert.equal(isStateBlockText("<carto-state>\nstale none\n</carto-state>"), true);
  assert.equal(isStateBlockText("<carto-state>unclosed"), false);
  assert.equal(isStateBlockText("person text <carto-state/>"), false);
  assert.equal(isStateBlockText(""), false);
});

test("the state block is injected per request and the transcript keeps only markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-state-block-"));
  const projectionPath = join(root, "g.projection.md");
  const partsPath = join(root, "g.projection.json");
  await writeFile(projectionPath, "# Carto context\n", "utf8");
  await writeFile(partsPath, JSON.stringify({ parts: { ledger: 0, atlas: 0, chat: 0, pins: 0, wakes: 0 } }), "utf8");
  const brain = await BrainStore.open(join(root, ".brain", "brain.sqlite"));
  const models = createModels();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  models.setProvider(faux.provider);
  const seen = [];
  faux.setResponses([
    (context) => {
      seen.push(context.messages);
      return fauxAssistantMessage([fauxToolCall("chat", { text: "Working on it." })], { stopReason: "toolUse" });
    },
    (context) => {
      seen.push(context.messages);
      return fauxAssistantMessage("done, and resting");
    },
    (context) => {
      // The onYield marker continuation; answered with sleep not needed here.
      seen.push(context.messages);
      return fauxAssistantMessage([fauxToolCall("sleep", {})], { stopReason: "toolUse" });
    },
  ]);
  const session = await LiveSession.open({
    path: join(root, ".brain", "context", "live.sqlite"),
    model: { provider: "faux", modelId: "faux-1" },
    projectRoot: root,
    brain,
    models,
    promptStore: new PromptStore(),
    stateBlock: { projectionPath, partsPath, pendingWrites: () => [{ handle: "L1", kind: "ledger", deleted: false }] },
  });
  try {
    await session.submit("please do the thing", "state-block-request");
    assert.equal(seen.length, 3);
    for (const messages of seen) {
      const blocks = messages.filter((message) => typeof message.content === "string" && message.content.startsWith("<carto-state>"));
      assert.equal(blocks.length, 1, "exactly one block per request");
      assert.equal(messages.at(-1), blocks[0], "the block is the trailing message");
      assert.equal(blocks[0].role, "user");
    }
    assert.match(seen[0].at(-1).content, /pending L1 ledger/);
    assert.match(seen[1].at(-1).content, /pending L1 ledger/);
    // markers never accumulate: earlier full blocks are stripped
    for (const messages of seen) {
      assert.equal(messages.filter((message) => typeof message.content === "string" && message.content.trim() === STATE_BLOCK_MARKER).length, 0);
    }
  } finally {
    await session.close();
    await brain.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a sleep tool call ends the run without another model request", async () => {
  const root = await mkdtemp(join(tmpdir(), "carto-sleep-"));
  const projectionPath = join(root, "g.projection.md");
  const partsPath = join(root, "g.projection.json");
  await writeFile(projectionPath, "# Carto context\n", "utf8");
  await writeFile(partsPath, JSON.stringify({ parts: { ledger: 0, atlas: 0, chat: 0, pins: 0, wakes: 0 } }), "utf8");
  const brain = await BrainStore.open(join(root, ".brain", "brain.sqlite"));
  const models = createModels();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("sleep", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("this must never be sent"),
  ]);
  const session = await LiveSession.open({
    path: join(root, ".brain", "context", "live.sqlite"),
    model: { provider: "faux", modelId: "faux-1" },
    projectRoot: root,
    brain,
    models,
    stateBlock: { projectionPath, partsPath, pendingWrites: () => [] },
  });
  try {
    await session.submit("wrap it up", "sleep-request");
    assert.equal(faux.state.callCount, 1);
  } finally {
    await session.close();
    await brain.close();
    await rm(root, { recursive: true, force: true });
  }
});
