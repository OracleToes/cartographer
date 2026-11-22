import assert from "node:assert/strict";
import test from "node:test";

import {
  STATE_BLOCK_MARKER,
  appendStateBlock,
  renderStateBlock,
  splitContextMessages,
  stripStateBlocks,
} from "../dist/domain/state-block.js";

const input = (overrides = {}) => ({
  contextWindow: 32_768,
  lastReportedInput: 9_841,
  systemTokens: 5_900,
  transcriptTokens: 3_800,
  toolWorkTokens: 2_700,
  toolWorkSince: 2_569,
  sizes: { atlas: 1_200, ledger: 640, chat: 980 },
  pending: [
    { kind: "atlas", action: "upsert", id: "a3" },
    { kind: "chat", action: "record", id: "c7" },
  ],
  pinned: [
    { handle: "L2", author: "user" },
    { handle: "A6", author: "agent" },
  ],
  marks: [
    { handle: "A8", action: "archive", author: "user" },
    { handle: "C3", action: "delete", author: "agent" },
  ],
  stale: ["A5 (stale)"],
  resolveHandle: (kind, id) => ({ "atlas:a3": "A3", "chat:c7": "C7" })[`${kind}:${id}`],
  mode: "edit",
  tree: { root: "/project", depth: 2, lines: ["./", "src/  24K", "  cli.ts  3K  A9"] },
  ...overrides,
});

test("the block carries the confirmed contents and the delimiters", () => {
  const block = renderStateBlock(input());
  assert.match(block, /^<carto-state>\n/);
  assert.match(block, /\n<\/carto-state>$/);
  assert.match(block, /context: ~12,410 \/ 32,768 tokens \(last reported 9,841 \+ tool work since \+2,569\)/);
  assert.match(block, /space: system\+tools ~5,900 · transcript ~3,800 · tool work ~2,700 · atlas ~1,200 · ledger ~640 · chat ~980/);
  assert.match(block, /pending:\n  A3 · atlas upsert\n  C7 · chat record/);
  // A mark carries its action and its author (§4.1).
  assert.match(block, /marks:\n  A8 archive \[u\]\n  C3 delete \[a\]/);
  assert.match(block, /pinned:\n  L2 \[u\]\n  A6 \[a\]/);
  assert.match(block, /stale:\n  A5 \(stale\)/);
  assert.match(block, /tree: \/project \(depth 2\)/);
  // The mode is stated in the block's own words (§6.1).
  assert.match(block, /^<carto-state>\n\[EDIT MODE\]\n/);
  assert.match(renderStateBlock(input({ mode: "read only" })), /^<carto-state>\n\[READ ONLY MODE\]\n/);
});

test("empty pending, marks, and stale say none; missing provider report is explicit", () => {
  const block = renderStateBlock(input({ pending: [], stale: [], pinned: [], marks: [], lastReportedInput: undefined }));
  assert.match(block, /pending: none/);
  assert.match(block, /marks: none/);
  assert.match(block, /pinned: none/);
  assert.match(block, /stale: none/);
  assert.match(block, /context: ~[\d,]+ \/ 32,768 tokens \(not yet reported by the provider\)/);
});

test("an unknown window renders as unknown, never as a number; a pin or advertisement renders normally", () => {
  const unknown = renderStateBlock(input({ contextWindow: 0 }));
  assert.match(unknown, /context: ~12,410 tokens \(last reported 9,841 \+ tool work since \+2,569; window unknown\)/);
  assert.doesNotMatch(unknown, /32,768|0 tokens \//);
  const unknownUnreported = renderStateBlock(input({ contextWindow: 0, lastReportedInput: undefined }));
  assert.match(unknownUnreported, /context: ~[\d,]+ tokens \(window unknown\)/);
  const known = renderStateBlock(input({ contextWindow: 131_072 }));
  assert.match(known, /context: ~12,410 \/ 131,072 tokens/);
});

test("marker messages are dropped from payloads; everything else survives", () => {
  const messages = [
    { role: "user", content: "a real person message" },
    { role: "user", content: STATE_BLOCK_MARKER },
    { role: "user", content: [{ type: "text", text: STATE_BLOCK_MARKER }] },
    { role: "assistant", content: [{ type: "text", text: "reasoning" }] },
  ];
  const stripped = stripStateBlocks(messages);
  assert.equal(stripped.length, 2);
  assert.deepEqual(stripped.map((m) => m.role), ["user", "assistant"]);
});

test("splitContextMessages attributes system, tool work and transcript additively", () => {
  const messages = [
    { role: "system", content: "You are Carto.", sections: { Rules: "Be brief." }, toolsAdded: [{ name: "chat" }], timestamp: 1 },
    { role: "user", content: "hello", timestamp: 2 },
    { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "chat", arguments: { text: "hi" } }], timestamp: 3 },
    { role: "toolResult", toolCallId: "t1", toolName: "chat", content: [{ type: "text", text: "Chat message saved." }], isError: false, timestamp: 4 },
    { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 5 },
  ];
  const { systemTokens, transcriptTokens, toolWorkTokens } = splitContextMessages(messages);
  assert.ok(systemTokens > 0);
  assert.ok(toolWorkTokens > 0);
  assert.ok(transcriptTokens > 0);
  // Attribution is exclusive: a bucket with nothing in it reports zero, not a share of the rest.
  const userOnly = splitContextMessages([{ role: "user", content: "hello" }]);
  assert.deepEqual([userOnly.systemTokens, userOnly.toolWorkTokens], [0, 0]);
  assert.ok(userOnly.transcriptTokens > 0);
  const toolOnly = splitContextMessages([{ role: "toolResult", toolCallId: "t", toolName: "x", content: [{ type: "text", text: "result" }], isError: false }]);
  assert.deepEqual([toolOnly.systemTokens, toolOnly.transcriptTokens], [0, 0]);
  assert.ok(toolOnly.toolWorkTokens > 0);
});

test("appendStateBlock strips markers and leaves the block last", () => {
  const block = "<carto-state>\ncontext: test\n</carto-state>";
  const messages = [
    { role: "user", content: "hello" },
    { role: "user", content: STATE_BLOCK_MARKER },
  ];
  const appended = appendStateBlock(messages, block, 1_700_000_000_000);
  assert.equal(appended.length, 2);
  assert.equal(appended[0].role, "user");
  assert.equal(appended[1].content, block);
  assert.equal(appended[1].timestamp, 1_700_000_000_000);
});
