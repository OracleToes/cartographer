import test from "node:test";
import assert from "node:assert/strict";
import { padLine, visibleWidth, tokens } from "../dist/ui/tokens.js";
import { Sidebar } from "../dist/ui/sidebar.js";
import { TokenBarView } from "../dist/ui/context-bar.js";
import { Registry } from "../dist/ui/commands.js";
import { previewArchive, previewPrompt, previewTranscript } from "../dist/ui/preview.js";
import { TranscriptView, formatToolArgs } from "../dist/ui/transcript.js";
import { ContextView } from "../dist/ui/context-view.js";
import { AtlasView } from "../dist/ui/atlas-view.js";
import { LedgerView } from "../dist/ui/ledger-view.js";
import { emptyBrain } from "../dist/domain/records.js";

/** A rendered line without its ANSI styling, so tests assert on words, not escape codes. */
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

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

test("a line already the width is left whole — no ellipsis, no eaten characters", () => {
  // The defect this guards: `>=` sent an exactly-wide line through
  // `truncateToWidth`, which reserves room for its ellipsis, so three
  // characters vanished from the middle of a paragraph that was never too long.
  const exact = "x".repeat(40);
  assert.equal(padLine(exact, 40), exact);
  assert.equal(padLine(tokens.accent(exact), 40), tokens.accent(exact));
  assert.ok(!padLine(tokens.accent(exact), 40).includes("…"));
});

test("Sidebar renders the transcript, the prompt, and both books with counts", () => {
  const sidebar = new Sidebar();
  sidebar.setCounts({
    chat: 3,
    contextTokens: 1250,
    atlas: 5,
    ledger: 2,
    pinned: { atlas: 1 },
    marked: {},
    stale: { atlas: 1 },
    staleTotal: 1,
    archive: 4,
    archivePinned: 1,
  });
  sidebar.setActiveBook("context");

  const lines = sidebar.render(30);
  const rendered = plain(lines.join("\n"));

  // The workspace's two rows, then the Brain's: names, not old book slugs.
  assert.ok(rendered.includes("transcript"));
  assert.ok(rendered.includes("prompt"));
  assert.ok(rendered.includes("atlas"));
  assert.ok(rendered.includes("ledger"));
  assert.ok(rendered.includes("1.3k"), "the prompt's figure is the compact token count");
  assert.ok(rendered.includes("WORKSPACE") && rendered.includes("BRAIN"), "rows are grouped under quiet headings");
  assert.ok(rendered.includes("layer"), "the archive layer toggle sits in the pane, apart from the books");

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

  // Rows are found where they rendered, not guessed: the pane's layout may change.
  const lines = sidebar.render(28).map((line) => plain(line));
  const chatRow = lines.findIndex((line) => line.includes("transcript"));
  const promptRow = lines.findIndex((line) => line.includes("prompt"));
  assert.ok(chatRow >= 0 && promptRow >= 0, "the rows render at the pane's own width");

  const click = (y) =>
    sidebar.handleMouse({
      type: "click",
      button: "left",
      x: 5,
      y,
      screenX: 5,
      screenY: y,
      width: 28,
      height: 18,
      shift: false,
      alt: false,
      ctrl: false,
    });

  assert.ok(click(chatRow)?.handled);
  assert.equal(selected, "chat");
  assert.ok(click(promptRow)?.handled);
  assert.equal(selected, "context");
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

  // The header deepens rather than toggling: open, then full, then back to open.
  const clickHeader = () =>
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
  clickHeader();
  assert.ok(plain(transcript.render(80).join("\n")).includes("· full"), "a second click on the header opens the card fully");
  clickHeader();
  assert.ok(!plain(transcript.render(80).join("\n")).includes("· full"), "and a third returns it to open");

  // A click in the body closes the card, from any state.
  const bodyClick = transcript.handleMouse({
    type: "click",
    button: "left",
    x: 8,
    y: 2,
    screenX: 8,
    screenY: 2,
    width: 80,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.ok(bodyClick?.handled);
  rendered = transcript.render(80);
  assert.equal(rendered.length, initialLineCount, "a body click folds the card back to one line");
});

test("a streaming card keeps its tail, and the rule that counts the hidden lines shows them", () => {
  const transcript = new TranscriptView();
  const body = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  transcript.setLive([{ kind: "output", id: "live-1-0", live: true, text: body.join("\n") }]);

  let shown = plain(transcript.render(80).join("\n"));
  assert.ok(shown.includes("⋯ 32 lines earlier"), "the window says exactly what it is hiding");
  assert.ok(shown.includes("line 40"), "the newest line is on screen");
  assert.ok(!shown.includes("line 1\n"), "and the oldest is not");

  // The rule is the control: one click on it and the whole card is there.
  const ruleRow = transcript.render(80).findIndex((line) => plain(line).includes("lines earlier"));
  assert.ok(ruleRow > 0);
  const res = transcript.handleMouse({
    type: "click",
    button: "left",
    x: 8,
    y: ruleRow,
    screenX: 8,
    screenY: ruleRow,
    width: 80,
    height: 50,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.ok(res?.handled);
  shown = plain(transcript.render(80).join("\n"));
  assert.ok(!/\d+ lines earlier/.test(shown), "the rule is gone once nothing is hidden");
  assert.ok(shown.includes("line 1 ") || shown.includes("line 1\n") || /line 1\b/.test(shown), "the first line is on screen");
});

test("the prompt view is the prefill: head, body, tail, leaves unfoldable", () => {
  const view = new ContextView();
  const brain = emptyBrain();
  brain.handles = {
    counters: { A: 1, L: 1, C: 1 },
    entries: [
      { kind: "atlas", id: "a1", handle: "A1", timestamp: 0 },
      { kind: "ledger", id: "l1", handle: "L1", timestamp: 1 },
      { kind: "chat", id: "c1", handle: "C1", timestamp: 2 },
    ],
  };
  brain.atlas.push({ id: "a1", title: "The Brain is the persistent record", text: "…", links: [], attachments: [], createdAt: 0, updatedAt: 0 });
  brain.ledger.push({ id: "l1", kind: "goal", text: "Keep the prefill in one order", status: "open", answer: null, createdAt: 1, updatedAt: 1 });
  brain.chat.push({ id: "c1", author: "agent", text: "The prompt view is the prefill now.", createdAt: 2, updatedAt: 2 });
  view.setData({
    brain,
    systemPrompt: "You are Carto.",
    projectionText: "Atlas\nA1 The Brain is the persistent record — 1970-01-01T00:00:00.000Z",
    tools: [{ name: "read", description: "Read a file.", parameters: { type: "object" } }],
    transcriptMessages: [{ id: 2, role: "user", text: "show me the prompt" }],
    toolWorkItems: [
      { id: "3-0", kind: "reasoning", text: "the order is the thing to show" },
      { id: "4-0", kind: "toolCall", name: "read", args: "path: src/ui/context-view.ts" },
      { id: "5-0", kind: "toolResult", output: "export class ContextView" },
    ],
    stateBlockText: "<carto-state>\n[EDIT MODE]\n</carto-state>",
  });

  let lines = view.render(90);
  for (const line of lines) assert.equal(visibleWidth(line), 90, "every line is the pane's width");
  let shown = plain(lines.join("\n"));

  // The three regions of the prefill, in order (§5), not a rail of parts.
  const head = shown.indexOf("HEAD");
  const body = shown.indexOf("BODY");
  const tail = shown.indexOf("TAIL");
  assert.ok(head >= 0 && head < body && body < tail, "head, then body, then tail");

  // Handles are on everything (§5.4), and each prefix means what the spec says.
  for (const handle of ["H", "Y1", "A1", "L1", "C1", "U1", "X1", "B"]) {
    assert.ok(new RegExp(`\\b${handle}\\b`).test(shown), `the ${handle} handle is rendered`);
  }

  // A leaf is never folded: the system prompt's body is shown, not its title.
  assert.ok(shown.includes("You are Carto."), "a leaf renders whole");

  // The open body is a paragraph, not a preview: at the width it is drawn at,
  // nothing is clipped and no line carries an ellipsis for want of room.
  const longPrompt = "Everything you can see carries a short handle, and a handle is how you point at a thing, which is why a sentence of any length has to wrap rather than trail off.";
  const wide = new ContextView();
  wide.setData({
    brain: emptyBrain(),
    systemPrompt: longPrompt,
    projectionText: "",
    tools: [],
    transcriptMessages: [{ id: 2, role: "user", text: longPrompt }],
    toolWorkItems: [],
    stateBlockText: "",
  });
  let promptLines = wide.render(100).map(plain).filter((line) => line.includes("│"));
  for (const line of promptLines) assert.ok(!line.includes("…"), `an open body is not clipped: ${line}`);
  assert.equal(promptLines.join(" ").replace(/\s+/g, " ").includes("rather than trail off"), true, "the whole paragraph is there");
  for (const width of [72, 100, 140]) {
    for (const line of wide.render(width)) assert.equal(visibleWidth(line), width, "the pane's width holds at every size");
  }

  // A section heading folds everything under it; pressing again opens it.
  const folding = new ContextView();
  folding.setData({
    brain: emptyBrain(),
    systemPrompt: "line one\nline two",
    projectionText: "",
    tools: [],
    transcriptMessages: [],
    toolWorkItems: [],
    stateBlockText: "",
  });
  // A closed row keeps a one-line summary, so the fold is read off the gutter,
  // not off the words: `│` only appears beside an open body.
  const gutter = () => plain(folding.render(80).join("\n")).includes("│");
  folding.handleInput("\r"); // open the system prompt
  assert.equal(gutter(), true, "enter opens an entry");
  folding.handleInput("k"); // the HEAD heading
  folding.handleInput("\r"); // close everything under it
  assert.equal(gutter(), false, "a heading closes the section");
  folding.handleInput("\r"); // and opens it again
  assert.equal(gutter(), true, "and opens it again");

  // `toggleAll` is the same action for the whole prompt: close what is open,
  // and leave a leaf alone, because a leaf is the one thing that stays whole.
  folding.toggleAll();
  assert.equal(gutter(), false, "everything foldable closes at once");
  assert.ok(plain(folding.render(80).join("\n")).includes("line one"), "a closed entry keeps its summary");
  folding.toggleAll();
  assert.equal(gutter(), true, "and opens again");

  // Folding, and `tab` between the human and the real view of schema-shaped content.
  view.handleInput("j"); // the system row (head's first entry)
  lines = view.render(90);
  view.handleInput("\t");
  shown = plain(view.render(90).join("\n"));
  assert.ok(shown.includes("as the model receives it"), "tab swaps to the real view");
  view.handleInput("\t");

  // A mark is a mark, not a deletion (§4.1): `d` reports it and `!` arms it.
  const marks = [];
  const collapses = [];
  view.onDelete = (part, id, now) => marks.push({ part, id, now });
  view.onCollapse = () => collapses.push(true);
  // Walk down to the person's line: the head's tool entry is markable too, so
  // the walk takes whatever it lands on until the marks name the transcript.
  for (let step = 0; step < 20; step += 1) {
    view.handleInput("j");
    view.handleInput("d");
    if (marks.some((mark) => mark.part === "transcript")) break;
  }
  const onPerson = marks.find((mark) => mark.part === "transcript");
  assert.ok(onPerson !== undefined, "the person's line can be marked");
  assert.equal(onPerson.id, 2, "the mark names the entry it is on, not a phantom");
  for (const mark of marks) assert.equal(mark.now, false, "no `!` yet, so the marks wait for the collapse");
  // `!` arms the next mark to be applied now rather than at the collapse.
  marks.length = 0;
  view.handleInput("!");
  view.handleInput("d");
  assert.ok(marks.length > 0 && marks.every((mark) => mark.now === true), "an armed mark applies now");
  view.handleInput("!");
  view.handleInput("c");
  assert.equal(collapses.length, 1, "`c` collapses");
});

test("AtlasView two-pane navigation, mouse interaction, and detail scrolling", () => {
  const atlas = new AtlasView();
  const brain = emptyBrain();
  brain.atlas.push({
    id: 1,
    title: "Entrypoint",
    text: "Entrypoint of the application",
    links: [],
    attachments: [{ kind: "file", path: "src/index.ts" }],
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
  const formatted = formatToolArgs({ path: "src/app.ts", offset: 10, limit: 20 }, "read");
  assert.ok(formatted.includes("path: src/app.ts"));
  assert.ok(formatted.includes("offset: 10"));
  assert.ok(formatted.includes("limit: 20"));

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
      args: "path: src/app.ts\noffset: 1",
      live: true,
      status: "running",
    },
  ]);

  const rendered = transcript.render(80);
  const headerLine = rendered[0];
  assert.ok(headerLine.includes("read"), "a tool card is called by its tool's name");
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
    text: "claim",
    links: [],
    attachments: [],
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
  assert.match(plain(lines.join("\n")), /⊙ you/, "the pin renders on the agent block, and says who placed it");
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

test("the context bar spans the bottom, reports the server's window, and greys what is no longer live", () => {
  const state = {
    // The report already counted the tool work, so nothing accrues after it.
    session: { state: { contextWindow: 32_768, lastReportedInput: 8_000, toolWorkAtLastReport: 2_000 } },
    parts: { system: 4_000, transcript: 2_000, toolWork: 2_000 },
  };
  const bar = new TokenBarView(state);
  const lines = bar.render(60);
  assert.equal(lines.length, 1, "the bar is one row");
  assert.equal(visibleWidth(lines[0]), 60, "it spans the whole width");
  assert.match(plain(lines[0]), /8,000 \/ 32,768/);

  // Before any measurement: an estimate, announced as one, against no capacity.
  state.session.state.contextWindow = 0;
  state.session.state.lastReportedInput = undefined;
  bar.invalidate();
  assert.match(plain(bar.render(60)[0]), /window unknown/);

  // A server that stopped: the last values stay, greyed rather than dropped.
  state.session.state.contextWindow = 32_768;
  state.session.state.lastReportedInput = 8_000;
  state.session.state.serverLost = true;
  bar.invalidate();
  assert.match(plain(bar.render(60)[0]), /8,000 \/ 32,768/);
});

test("the command registry drives the footer, and a key only fires where it is available", () => {
  let ran = 0;
  let chat = false;
  const registry = new Registry([
    {
      id: "fold",
      group: "the transcript",
      label: "fold the cards",
      key: "ctrl+e",
      run: () => {
        ran += 1;
      },
      available: () => chat,
    },
    {
      id: "palette",
      group: "anywhere",
      label: "palette",
      key: "ctrl+p",
      quiet: true,
      run: () => {
        ran += 10;
      },
      available: () => true,
    },
  ]);

  assert.equal(registry.dispatch("\u0005"), false, "an unavailable command releases the key to the view");
  assert.equal(ran, 0);
  chat = true;
  assert.equal(registry.dispatch("\u0005"), true);
  assert.equal(ran, 1);

  // `^p` is in the registry but quiet, so it never crowds the footer.
  assert.deepEqual(registry.footer().map((command) => command.id), ["fold"]);
  assert.equal(registry.dispatch("\u0010"), true);
  assert.equal(ran, 11);
});

test("the drawn workspace is exact to its width, and the archive is a layer over it", () => {
  const width = 104;
  const transcript = previewTranscript(width);
  const prompt = previewPrompt(width);
  const archive = previewArchive(width);

  for (const [name, frame] of [["transcript", transcript], ["prompt", prompt], ["archive", archive]]) {
    for (const line of frame.split("\n")) {
      assert.equal(visibleWidth(line), width, `${name}: every line is the frame's width — "${plain(line)}"`);
    }
  }

  const shown = plain(transcript);
  assert.ok(shown.includes("cartographer"), "the header names the project");
  assert.ok(shown.includes("WORKSPACE") && shown.includes("BRAIN") && shown.includes("layer"), "the sidebar's groups and its layer");
  assert.ok(shown.includes("you") && shown.includes("carto"), "the two voices");
  assert.ok(shown.includes("thinking") && shown.includes("read"), "the agent's work is cards, named by their tool");
  assert.ok(/\/ 32,768/.test(shown), "the context bar closes the frame");

  // The archive is the same UI over the other layer (§3.3), not a separate screen.
  const layer = plain(archive);
  assert.ok(layer.includes("ARCHIVE"), "the layer says what it is");
  assert.ok(layer.includes("restore") || layer.includes("delete for good"), "the person's keys are the footer's");
});
