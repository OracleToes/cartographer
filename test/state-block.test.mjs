import "./agent-reminder.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { emptyBrain } from "../dist/domain/records.js";
import {
  STATE_BLOCK_MARKER,
  appendStateBlock,
  renderStateBlock,
  splitContextMessages,
  stripStateBlocks,
} from "../dist/domain/state-block.js";
import { latestToolFailures } from "../dist/domain/state-engine.js";
import { newGenerationWork, renderLiveStateBlock } from "../dist/runtime/carto-extension.js";

const input = (overrides = {}) => ({
  // The name the agent reads for the person at the keyboard: a name, never a role.
  person: "OracleToes",
  contextWindow: 32_768,
  lastReportedInput: 9_841,
  systemTokens: 5_900,
  transcriptTokens: 3_800,
  toolWorkTokens: 2_700,
  toolWorkSince: 2_569,
  sizes: { atlas: 1_200, ledger: 640, chat: 980, ephemera: 0 },
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
  stale: [{ handle: "A5", why: "the file changed after this note" }],
  resolveHandle: (kind, id) => ({ "atlas:a3": "A3", "chat:c7": "C7" })[`${kind}:${id}`],
  mode: "edit",
  tree: { root: "/project", depth: 2, lines: ["./", "src/  24K  D1", "  cli.ts  3K  F1  A9"] },
  ...overrides,
});

test("the block carries the confirmed contents and the delimiters", () => {
  const block = renderStateBlock(input());
  assert.match(block, /^<carto-state>\n/);
  assert.match(block, /\n<\/carto-state>$/);
  assert.match(block, /context: ~12,410 \/ 32,768 tokens · the provider counted 9,841 input, tool work since \+2,569/);
  assert.match(block, /context fill: ~37%/);
  assert.doesNotMatch(block, /\[COLLAPSE NEEDED\]/);
  assert.match(block, /space: system and tools ~5,900 · transcript ~3,800 · tool work ~2,700 · atlas ~1,200 · ledger ~640 · chat ~980/);
  // A pending line adds the write; the handle's letter already says the book.
  assert.match(block, /session-observed writes \(not exhaustive\):\n  A3 · written\n  C7 · said to OracleToes/);
  // A mark carries its action, when it lands, and its author (§4.1).
  assert.match(block, /marks:\n  A8 · archive at the next collapse · marked by OracleToes\n  C3 · delete at the next collapse · marked by you/);
  // §5.4: a pin is named by its own letter and the handle of what it marks.
  assert.match(block, /pins:\n  P L2 · placed by OracleToes\n  P A6 · placed by you/);
  assert.match(block, /stale:\n  A5 · the file changed after this note/);
  // Each stale entry carries its own reason: a pinned file that is gone is not
  // the same fact as an Atlas note whose file moved on (§5.5).
  const mixed = renderStateBlock(
    input({
      stale: [
        { handle: "A5", why: "the file changed after this note" },
        { handle: "F3", why: "pinned, and the file is gone" },
      ],
    }),
  );
  assert.match(mixed, /  F3 · pinned, and the file is gone/);
  assert.match(block, /T1 tree: \/project \(depth 2\)/);
  // The mode is stated in the block's own words (§6.1).
  assert.match(block, /^<carto-state>\n\[EDIT MODE\]\n/);
  assert.match(renderStateBlock(input({ mode: "read only" })), /^<carto-state>\n\[READ ONLY MODE\]\n/);
});

test("live items in the state block contain only their handles and types", () => {
  const working = [
    { handle: "X15", kind: "plainText", text: "a private preview" },
    { handle: "X16", kind: "toolCall", text: '{"path":"physics.js"}' },
    { handle: "R6", kind: "readResult", text: "the file contents" },
  ];
  const block = renderStateBlock(input({ working }));
  assert.match(block, /live items:\n  X15 · plainText\n  X16 · toolCall\n  R6 · readResult\npins:/);
  assert.doesNotMatch(block, /a private preview|physics\.js|the file contents/);
  assert.doesNotMatch(renderStateBlock(input({ working: [] })), /live items:/);
});

test("empty pending, marks, and stale say none; missing provider report is explicit", () => {
  const block = renderStateBlock(input({ pending: [], stale: [], pinned: [], marks: [], lastReportedInput: undefined }));
  assert.match(block, /session-observed writes \(not exhaustive\): none/);
  assert.match(block, /marks: none/);
  assert.match(block, /pins: none/);
  assert.match(block, /stale: nothing/);
  assert.match(block, /context: ~[\d,]+ \/ 32,768 tokens · no provider count yet/);
});

test("an unknown window renders as unknown, never as a number; a pin or advertisement renders normally", () => {
  const unknown = renderStateBlock(input({ contextWindow: 0 }));
  assert.match(unknown, /context: ~12,410 tokens · the provider counted 9,841 input, tool work since \+2,569 · the window is unknown/);
  assert.doesNotMatch(unknown, /context fill:|\[COLLAPSE NEEDED\]/);
  assert.doesNotMatch(unknown, /32,768|0 tokens \//);
  const unknownUnreported = renderStateBlock(input({ contextWindow: 0, lastReportedInput: undefined }));
  assert.match(unknownUnreported, /context: ~[\d,]+ tokens · the window is unknown until the server advertises one/);
  const known = renderStateBlock(input({ contextWindow: 131_072 }));
  assert.match(known, /context: ~12,410 \/ 131,072 tokens/);
});

test("fullness warns at the configured threshold (default 75 percent), including the last response's output", () => {
  const base = { contextWindow: 1000, lastReportedInput: 700, toolWorkSince: 25 };
  const below = renderStateBlock(input({ ...base, lastReportedOutput: 24 }));
  assert.match(below, /context fill: ~74%/);
  assert.doesNotMatch(below, /\[COLLAPSE NEEDED\]/);
  const warning = renderStateBlock(input({ ...base, lastReportedOutput: 25 }));
  assert.match(warning, /context: ~750 \/ 1,000 tokens · the provider counted 700 input, 25 output/);
  assert.match(warning, /context fill: ~75% · \[COLLAPSE NEEDED\]/);
  assert.match(warning, /Write down what you need to continue/);
  const estimated = renderStateBlock(input({ contextWindow: 1000, lastReportedInput: undefined, systemTokens: 250, transcriptTokens: 250, toolWorkTokens: 250 }));
  assert.match(estimated, /context fill: ~75% · \[COLLAPSE NEEDED\]/);

  // A custom threshold overrides the default in both directions.
  const lowered = renderStateBlock(input({ ...base, lastReportedOutput: 0, collapseWarningPercent: 70 }));
  assert.match(lowered, /context fill: ~72% · \[COLLAPSE NEEDED\]/);
  const raised = renderStateBlock(input({ ...base, lastReportedOutput: 25, collapseWarningPercent: 80 }));
  assert.match(raised, /context fill: ~75%/);
  assert.doesNotMatch(raised, /\[COLLAPSE NEEDED\]/);
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

test("state guidance is conditional and capability-aware", () => {
  const clean = renderStateBlock(input());
  assert.doesNotMatch(clean, /\nflow:|\nattention:/);
  assert.match(clean, /file scope: strict/);
  assert.match(renderStateBlock(input({ pathScope: "relaxed", mode: "read only" })), /file scope: relaxed/);
  const stale = [
    { handle: "A1", why: "attachment unavailable", kind: "atlas" },
    { handle: "F1", why: "file newer", kind: "file-modified" },
    { handle: "R1", why: "read newer", kind: "read-modified" },
    { handle: "F2", why: "file unavailable", kind: "file-unavailable" },
  ];
  const block = renderStateBlock(input({ stale, hasFilePins: true }));
  assert.match(block, /A1 · attachment unavailable; inspect the attachment/);
  assert.match(block, /F1 · file newer; read current content if in scope, or collapse/);
  assert.match(block, /R1 · read newer; read current content if in scope, or collapse/);
  assert.match(block, /F2 · file unavailable; check the path and scope/);
  assert.match(block, /file pins: the frozen head may differ from live pins; collapse refreshes it/);
  assert.equal(renderStateBlock(input({ stale, hasFilePins: true })), block);
  const limited = renderStateBlock(input({ stale, capabilities: [], contextWindow: 1000, lastReportedInput: 900, toolWorkSince: 0, hasFilePins: true }));
  assert.match(limited, /\[CONTEXT WARNING\]/);
  assert.doesNotMatch(limited, /COLLAPSE NEEDED|collapse refreshes|inspect the attachment|read current content/);
});

test("only failures in the latest completed visible tool round are reported", () => {
  const call = (id, name) => ({ type: "toolCall", id, name });
  const assistant = (...content) => ({ role: "assistant", content });
  const result = (toolCallId, isError) => ({ role: "toolResult", toolCallId, isError });
  const round = [assistant(call("a", "read"), call("b", "bash")), result("a", true), result("b", false)];
  const handles = new Map([["a", "R1"]]);
  assert.deepEqual(latestToolFailures(round, handles), ["Last completed tool round: `read` failed (R1). Inspect the result before relying on that operation."]);
  assert.deepEqual(latestToolFailures(round, handles), latestToolFailures(round, handles));
  assert.deepEqual(latestToolFailures([...round, assistant(call("c", "edit"))], handles), latestToolFailures(round, handles), "an incomplete later round does not replace a completed one");
  assert.deepEqual(latestToolFailures([...round, assistant(call("c", "edit")), result("c", false)], handles), []);
  assert.deepEqual(latestToolFailures([assistant(call("a", "read"), call("b", "edit")), result("a", true)]), []);
  assert.deepEqual(latestToolFailures([assistant(call("a", "read")), result("a", undefined)]), []);
  assert.deepEqual(latestToolFailures([result("a", true)]), []);
  assert.deepEqual(latestToolFailures([assistant(call("a", "read"), call("b", "edit")), result("a", true), result("b", true)]).length, 2);
  assert.deepEqual(latestToolFailures([assistant(call("a", "read"), { type: "toolCall", name: "edit" }), result("a", true)]), []);
  assert.deepEqual(latestToolFailures([...round, assistant(call("a", "edit")), result("a", true)]), []);
  assert.deepEqual(latestToolFailures([assistant(call("a", "read")), result("a", true), result("a", false)]), []);
});

test("live drift guidance stays visible and does not guess from shell commands or Brain counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "carto-flow-"));
  const outside = mkdtempSync(join(tmpdir(), "carto-flow-outside-"));
  try {
    const filePath = join(root, "dice.js");
    const snapPath = join(root, "snapshot.md");
    writeFileSync(filePath, "const x = 1;\n");
    writeFileSync(join(outside, "external.md"), "external\n");
    symlinkSync(join(outside, "external.md"), join(root, "linked.md"));
    writeFileSync(snapPath, "# frozen\n");
    // Ensure snapshot is older than the modified pinned file on disk.
    const past = new Date(Date.now() - 5_000);
    utimesSync(snapPath, past, past);
    const now = new Date();
    utimesSync(filePath, now, now);

    const brain = {
      ...emptyBrain(),
      atlas: [{ id: "a1", kind: "project", title: "Dice", body: "Soft die", links: [], attachments: [], createdAt: 1, updatedAt: 1 }],
      chat: Array.from({ length: 8 }, (_, idx) => ({
        id: `c${idx}`,
        author: idx % 2 === 0 ? "user" : "agent",
        text: `msg ${idx}`,
        createdAt: idx + 1,
        updatedAt: idx + 1,
      })),
      files: [{ path: "dice.js", pinned: "agent", createdAt: 1 }, { path: "linked.md", pinned: "user", createdAt: 1 }],
      ephemera: [{ id: "read-pin", kind: "readResult", text: "old", entity: { callId: "read-old", tool: "read", path: "dice.js" }, pinned: "user", createdAt: Date.now() - 10_000 }],
    };
    const session = {
      person: "OracleToes",
      contextWindow: 40_960,
      collapseWarningPercent: 75,
      paused: false,
      pending: [],
      tree: { anchor: root, depth: 2 },
      collapseRequested: null,
      readOnly: false,
      generation: "gen-flow",
      lastReportedInput: undefined,
      desiredMaxOutput: 4000,
      work: newGenerationWork(),
      rebuiltAutomatically: false,
      toolWorkAtLastReport: 0,
      toolWorkAtLastRequest: 77,
      liveEphemera: new Map([
        ["X1", { id: "reasoning", kind: "reasoning", text: "unrepeated reasoning" }],
        ["R1", { id: "read-pin", kind: "readResult", text: "unrepeated result" }],
      ]),
    };

    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "node test_sim.js" } }] },
      { role: "assistant", content: [{ type: "toolCall", id: "2", name: "bash", arguments: { command: "sed -n '1,60p' dice.js" } }] },
      { role: "assistant", content: [{ type: "toolCall", id: "3", name: "bash", arguments: { command: "python3 -c \"open('dice.js','w').write('x')\"" } }] },
    ];

    const block = await renderLiveStateBlock(
      { root, brain: { read: async () => brain }, session, markdownPath: snapPath },
      messages,
    );
    assert.equal(session.toolWorkAtLastRequest, 77, "a UI preview must not alter the in-flight request accounting baseline");
    assert.match(block, /live items:\n  X1 · reasoning\n  R1 · readResult\npins:/);
    assert.doesNotMatch(block, /unrepeated reasoning|unrepeated result/);
    assert.match(block, /linked\.md · pinned copy in head may be older than disk; read current content if in scope, or collapse/);
    assert.doesNotMatch(block, /linked\.md · pinned file is missing/);
    assert.match(block, /R1 · pinned reading may be older than its file; read current content if in scope, or collapse/);
    assert.doesNotMatch(block, /\nattention:|Last `bash`|Brain has 0 writes|Atlas has only|Ledger is empty/);
    const repeated = await renderLiveStateBlock(
      { root, brain: { read: async () => brain }, session, markdownPath: snapPath }, messages,
    );
    assert.equal(repeated, block, "preview does not consume a condition");
    utimesSync(filePath, past, past);
    utimesSync(join(outside, "external.md"), past, past);
    const cleared = await renderLiveStateBlock(
      { root, brain: { read: async () => brain }, session, markdownPath: snapPath }, messages,
    );
    assert.doesNotMatch(cleared, /pinned copy in head may be older/);
    rmSync(filePath);
    const missing = await renderLiveStateBlock(
      { root, brain: { read: async () => brain }, session, markdownPath: snapPath }, messages,
    );
    assert.match(missing, /pinned file is missing or inaccessible; check the path and scope/);
    assert.match(missing, /R1 · pinned reading’s file is missing or inaccessible; check the path and scope/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
