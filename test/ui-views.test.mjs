import test from "node:test";
import assert from "node:assert/strict";
import { padLine, visibleWidth, tokens } from "../dist/ui/tokens.js";
import { Sidebar } from "../dist/ui/sidebar.js";
import { TranscriptView, formatToolArgs } from "../dist/ui/transcript.js";
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
  assert.match(rendered, /~1k/, "the context token count renders deterministically as ~Math.round(tokens/1000)k");

  // Check that every line has the exact requested visible width
  for (const line of lines) {
    assert.equal(visibleWidth(line), 30, `Line "${line}" should have visible width 30`);
  }
});

test("Sidebar mouse click switches view", () => {
  const sidebar = new Sidebar();
  let selected = "";
  sidebar.onSelect = (view) => {
    selected = view;
  };

  const pressRes = sidebar.handleMouse({
    type: "press",
    button: "left",
    x: 5,
    y: 3, // chat
    screenX: 5,
    screenY: 3,
    width: 22,
    height: 12,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.ok(pressRes?.handled);

  const clickRes = sidebar.handleMouse({
    type: "click",
    button: "left",
    x: 5,
    y: 4, // context
    screenX: 5,
    screenY: 4,
    width: 22,
    height: 12,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.equal(selected, "context");
  assert.ok(clickRes?.handled);
});

test("TranscriptView mouse click folds and unfolds cards", () => {
  const transcript = new TranscriptView();
  transcript.setEntries([
    {
      kind: "tool",
      id: "tool-1",
      name: "read",
      args: '{"path": "src/index.ts"}',
      output: "line 1\nline 2\nline 3\nline 4\nline 5",
    },
  ]);

  let rendered = transcript.render(80);
  const initialLineCount = rendered.length;

  // Click on the tool card header (line 0)
  const pressRes = transcript.handleMouse({
    type: "press",
    button: "left",
    x: 5,
    y: 0,
    screenX: 5,
    screenY: 0,
    width: 80,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.ok(pressRes?.handled);

  const clickRes = transcript.handleMouse({
    type: "click",
    button: "left",
    x: 5,
    y: 0,
    screenX: 5,
    screenY: 0,
    width: 80,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.ok(clickRes?.handled);

  // Now the card is unfolded and line count increased
  rendered = transcript.render(80);
  assert.ok(rendered.length > initialLineCount);
  assert.ok(rendered.join("\n").includes("line 1"));

  // Click again to fold
  transcript.handleMouse({
    type: "click",
    button: "left",
    x: 5,
    y: 0,
    screenX: 5,
    screenY: 0,
    width: 80,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
  });

  rendered = transcript.render(80);
  assert.equal(rendered.length, initialLineCount);
});

test("ContextView navigation, tool folding, and mouse interactions", () => {
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
    transcriptMessages: [
      { id: "t-1", role: "user", text: "Hello cartographer" },
      { id: "t-2", role: "assistant [chat]", text: "ping" },
    ],
    toolWorkItems: [
      { id: "w-1", kind: "toolCall", name: "read", args: "path: src/index.ts" },
    ],
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

  // Mouse wheel scroll in context view
  const wheelRes = view.handleMouse({
    type: "wheel",
    button: "wheel-down",
    wheelDelta: 1,
    x: 40,
    y: 5,
    screenX: 40,
    screenY: 5,
    width: 80,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.ok(wheelRes?.handled);

  // Test Surgery callbacks: onDelete, onCollapse, and ! now modifier
  let deletedItem = null;
  let collapsed = false;
  view.onDelete = (partId, itemId, now) => {
    deletedItem = { partId, itemId, now };
  };
  view.onCollapse = () => {
    collapsed = true;
  };

  // Move to transcript and delete with ! (now)
  view.handleInput("h"); // back to rail
  // selectedPartIndex is at transcript (3)
  view.handleInput("l"); // focus content pane
  view.handleInput("!"); // arm now
  view.handleInput("d"); // delete message
  assert.ok(deletedItem);
  assert.equal(deletedItem.partId, "transcript");
  assert.equal(deletedItem.itemId, "t-1", "the delete targets the selected transcript message, not a phantom");
  assert.equal(deletedItem.now, true);

  // Trigger collapse
  view.handleInput("c");
  assert.equal(collapsed, true);
});

test("AtlasView two-pane navigation, mouse interaction, and detail scrolling", () => {
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

  // Mouse wheel scrolling
  const wheelRes = atlas.handleMouse({
    type: "wheel",
    button: "wheel-down",
    wheelDelta: 1,
    x: 40,
    y: 5,
    screenX: 40,
    screenY: 5,
    width: 80,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.ok(wheelRes?.handled);
});

test("LedgerView two-pane navigation, mouse interaction, and detail scrolling", () => {
  const ledger = new LedgerView();
  const brain = emptyBrain();
  brain.ledger.push({
    id: 1,
    kind: "goal",
    text: "Refactor UI components with two-pane layout",
    status: "open",
    answer: null,
    evidence: [],
    pinned: "agent",
    createdAt: Date.now(),
    updatedAt: Date.now(),
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

  // Mouse wheel scrolling
  const wheelRes = ledger.handleMouse({
    type: "wheel",
    button: "wheel-down",
    wheelDelta: 1,
    x: 40,
    y: 5,
    screenX: 40,
    screenY: 5,
    width: 80,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.ok(wheelRes?.handled);
});

test("formatToolArgs formats progressively based on tool name availability", () => {
  // 1. Tool name empty/unknown: raw JSON output
  const rawPartial = '{"path": "src/app.ts", "start';
  assert.equal(formatToolArgs(rawPartial, ""), rawPartial);
  assert.equal(formatToolArgs({ path: "src/app.ts" }, ""), '{\n  "path": "src/app.ts"\n}');

  // 2. Tool name known: formats object fields human-readably
  const formatted = formatToolArgs({ path: "src/app.ts", startLine: 10, endLine: 20 }, "read");
  assert.ok(formatted.includes("path: src/app.ts"));
  assert.ok(formatted.includes("startLine: 10"));
  assert.ok(formatted.includes("endLine: 20"));

  // 3. Multiline command formatting
  const formattedBash = formatToolArgs({ command: "git status\ngit diff" }, "bash");
  assert.ok(formattedBash.includes("command:\n  git status\n  git diff"));
});

test("TranscriptView displays tool name in card header when known", () => {
  const transcript = new TranscriptView();
  transcript.setLive([
    {
      kind: "tool",
      id: "live-tool-1",
      name: "read",
      args: "path: src/app.ts\nstartLine: 1",
      live: true,
      status: "running",
    },
  ]);

  const rendered = transcript.render(80);
  const headerLine = rendered[0];
  assert.ok(headerLine.includes("tool read"));
  assert.ok(headerLine.includes("running"));
});

test("the p key toggles the pin on the selected entry (ledger and atlas)", () => {
  const ledger = new LedgerView();
  const brain = emptyBrain();
  brain.ledger.push({
    id: "l-a",
    kind: "note",
    text: "pin me",
    status: "open",
    answer: null,
    evidence: [],
    pinned: "agent",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  brain.handles.entries.push({ kind: "ledger", id: "l-a", handle: "L1", timestamp: Date.now() });
  let toggled = null;
  ledger.onTogglePin = (id) => { toggled = id; };
  ledger.setData(brain);
  ledger.handleInput("p");
  assert.equal(toggled, "l-a");

  const atlas = new AtlasView();
  const atlasBrain = emptyBrain();
  atlasBrain.atlas.push({
    id: "n-a",
    title: "pin me",
    claim: "claim",
    edges: [],
    evidence: [],
    pinned: "user",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  atlasBrain.handles.entries.push({ kind: "atlas", id: "n-a", handle: "A1", timestamp: Date.now() });
  let atlasToggled = null;
  atlas.onTogglePin = (id) => { atlasToggled = id; };
  atlas.setData(atlasBrain, []);
  atlas.handleInput("p");
  assert.equal(atlasToggled, "n-a");
});

test("an agent block in the transcript renders the pin badge and click toggles the pin", () => {
  const transcript = new TranscriptView();
  let toggled = null;
  transcript.onTogglePin = (id) => { toggled = id; };
  transcript.setEntries([
    { kind: "agent", text: "a durable agent statement", recordId: "c-a", pinned: "user" },
    { kind: "agent", text: "another agent statement", recordId: "c-b" },
  ]);
  const lines = transcript.render(120);
  assert.match(lines.join("\n"), /pin·u/, "the pin badge renders on the agent block");
  assert.ok(transcript.length >= 2, "two agent blocks rendered");

  // Click the first agent block (line 0 is its first line)
  const click = transcript.handleMouse({
    type: "click",
    x: 5,
    y: 0,
    screenX: 5,
    screenY: 0,
    width: 120,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.ok(click?.handled, "agent block click is handled");
  assert.equal(toggled, "c-a");

  // The second agent block (line 2) toggles its own pin
  const click2 = transcript.handleMouse({
    type: "click",
    x: 5,
    y: 2,
    screenX: 5,
    screenY: 2,
    width: 120,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.ok(click2?.handled, "second agent block click is handled");
  assert.equal(toggled, "c-b");
});
