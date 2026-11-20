import test from "node:test";
import assert from "node:assert/strict";
import { padLine, visibleWidth, tokens } from "../dist/ui/tokens.js";
import { Sidebar } from "../dist/ui/sidebar.js";
import { ContextView } from "../dist/ui/context-view.js";
import { AtlasView } from "../dist/ui/atlas-view.js";
import { LedgerView } from "../dist/ui/ledger-view.js";
import { emptyBrain } from "../dist/domain/records.js";

test("padLine pads accurately with and without ANSI escape sequences", () => {
  const plain = "hello";
  assert.equal(padLine(plain, 10), "hello     ");
  assert.equal(visibleWidth(padLine(plain, 10)), 10);

  const colored = tokens.accent("hello");
  const paddedColored = padLine(colored, 10);
  assert.equal(visibleWidth(paddedColored), 10);
  assert.ok(paddedColored.includes("hello"));

  const truncated = padLine("hello world this is long", 5);
  assert.equal(visibleWidth(truncated), 5);
});

test("Sidebar renders chat, context, atlas, and ledger with tokens and counts", () => {
  const sidebar = new Sidebar();
  sidebar.setCounts({
    chat: 3,
    contextTokens: 1250,
    atlas: 5,
    ledger: 2,
    stale: { atlas: 1 },
    staleTotal: 1,
  });
  sidebar.setActiveBook("context");

  const lines = sidebar.render(30);
  const rendered = lines.join("\n");

  assert.ok(rendered.includes("chat"));
  assert.ok(rendered.includes("context"));
  assert.ok(rendered.includes("atlas"));
  assert.ok(rendered.includes("ledger"));
  assert.ok(rendered.includes("1.3k") || rendered.includes("1.2k") || rendered.includes("1250") || rendered.includes("1k"));

  // Check that every line has the exact requested visible width
  for (const line of lines) {
    assert.equal(visibleWidth(line), 30, `Line "${line}" should have visible width 30`);
  }
});

test("ContextView navigation, tool folding, and detail scrolling", () => {
  const view = new ContextView();
  const brain = emptyBrain();
  view.setData({
    brain,
    systemPrompt: "You are Cartographer.",
    tools: [
      {
        name: "chat",
        description: "Post a message to chat",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
      {
        name: "atlas_upsert",
        description: "Upsert a node in Atlas",
        parameters: { type: "object" },
      },
    ],
    transcriptMessages: [{ role: "user", content: "Hello cartographer" }],
    toolWorkItems: [{ toolCallId: "call_1", toolName: "read", args: { path: "src/index.ts" }, result: "const x = 1;" }],
    stateBlockText: "=== STATE BLOCK ===",
  });

  // Check initial rail render width consistency
  let lines = view.render(80);
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80, `Line should have visible width 80`);
  }

  // Navigate rail down to tools
  view.handleInput("j"); // to PROJECTION
  view.handleInput("j"); // to TOOLS

  // Open tools in content pane
  view.handleInput("\r"); // enter -> focus shifts to content
  lines = view.render(80);
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80, `Line should have visible width 80`);
  }

  // Toggle first tool folding
  view.handleInput(" "); // space -> collapses first tool
  lines = view.render(80);
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80);
  }

  // Navigate to second tool and collapse it
  view.handleInput("j");
  view.handleInput("\r"); // enter toggles too
  lines = view.render(80);
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80);
  }

  // Navigate back to rail
  view.handleInput("h"); // back to rail

  // Move to transcript and open
  view.handleInput("j"); // transcript
  view.handleInput("l"); // open content pane
  view.handleInput("j"); // scroll content down
  view.handleInput("k"); // scroll content up
  view.handleInput("G"); // scroll to bottom
  view.handleInput("g"); // scroll to top

  lines = view.render(80);
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80);
  }
});

test("AtlasView two-pane navigation and detail scrolling", () => {
  const atlas = new AtlasView();
  const brain = emptyBrain();
  brain.atlas.push({
    id: 1,
    title: "Entrypoint",
    claim: "Entrypoint of the application",
    evidence: [{ path: "src/index.ts", digest: "abc", startLine: 1, endLine: 10 }],
    edges: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  brain.handles.entries.push({ kind: "atlas", id: 1, handle: "&1", timestamp: Date.now() });

  atlas.setData(brain, []);

  let lines = atlas.render(80);
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80);
  }

  // Switch to detail pane
  atlas.handleInput("l");
  atlas.handleInput("j"); // scroll detail down
  atlas.handleInput("k"); // scroll detail up
  atlas.handleInput("h"); // back to list

  lines = atlas.render(80);
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80);
  }
});

test("LedgerView two-pane navigation and detail scrolling", () => {
  const ledger = new LedgerView();
  const brain = emptyBrain();
  brain.ledger.push({
    id: 1,
    kind: "goal",
    text: "Refactor UI components with two-pane layout",
    status: "open",
    answer: null,
    evidence: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  brain.userPins.push({
    item: "!1",
    reason: "important",
    createdAt: Date.now(),
  });
  brain.handles.entries.push({ kind: "ledger", id: 1, handle: "!1", timestamp: Date.now() });

  ledger.setData(brain);

  let lines = ledger.render(80);
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80);
  }

  // Switch to detail pane
  ledger.handleInput("l");
  ledger.handleInput("j"); // scroll detail down
  ledger.handleInput("k"); // scroll detail up
  ledger.handleInput("h"); // back to list

  lines = ledger.render(80);
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80);
  }
});
