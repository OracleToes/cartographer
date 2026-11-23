import test from "node:test";
import assert from "node:assert/strict";
import { padLine, visibleWidth, tokens } from "../dist/ui/tokens.js";
import { Sidebar } from "../dist/ui/sidebar.js";
import { TokenBarView } from "../dist/ui/context-bar.js";
import { Registry } from "../dist/ui/commands.js";
import { previewArchive, previewContext, previewTranscript, previewTree } from "../dist/ui/preview.js";
import { TranscriptView, chatKeyOf, createStatusNotifier, formatToolArgs, retainAfterCollapse } from "../dist/ui/transcript.js";
import { ContextView } from "../dist/ui/context-view.js";
import { ArchiveView } from "../dist/ui/archive-view.js";
import { AtlasView } from "../dist/ui/atlas-view.js";
import { LedgerView } from "../dist/ui/ledger-view.js";
import { emptyBrain } from "../dist/domain/records.js";
import { applyWrite } from "../dist/domain/brain.js";
import { promptHandles } from "../dist/ui/prompt-handles.js";
import { renderStateBlock } from "../dist/domain/state-block.js";
import { JumpOverlay, JUMP_TARGETS } from "../dist/ui/jump.js";

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

test("Sidebar renders the transcript, the context, the tree, and both books with counts", () => {
  const sidebar = new Sidebar();
  sidebar.setCounts({
    chat: 3,
    contextTokens: 1250,
    treeDirs: 2,
    treeFiles: 6,
    atlas: 5,
    ledger: 2,
    marked: {},
    stale: { atlas: 1 },
    staleTotal: 1,
    archive: 4,
    archivePinned: 1,
  });
  sidebar.setActiveBook("context");

  const lines = sidebar.render(30);
  const rendered = plain(lines.join("\n"));

  // The workspace's three rows, then the Brain's: names, not old book slugs.
  assert.ok(rendered.includes("transcript"));
  assert.ok(rendered.includes("context"));
  assert.ok(rendered.includes("tree"));
  assert.ok(rendered.includes("atlas"));
  assert.ok(rendered.includes("ledger"));
  assert.ok(rendered.includes("1.3k"), "the context's figure is the compact token count");
  assert.ok(rendered.includes("2/6"), "the tree's figure is folders/files");
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
  const contextRow = lines.findIndex((line) => line.includes("context"));
  assert.ok(chatRow >= 0 && contextRow >= 0, "the rows render at the pane's own width");

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
  assert.ok(click(contextRow)?.handled);
  assert.equal(selected, "context");
});

test("collapse retains dialogue and pinned work, without swept halves or duplicate Chat", () => {
  const entries = [
    { kind: "person", text: "hello", handle: "U1" },
    { kind: "agent", text: "hi", recordId: "chat-1", handle: "C1" },
    { kind: "reasoning", id: "think", sourceId: "think-id", text: "swept thought" },
    { kind: "output", id: "out", sourceId: "out-id", text: "kept output" },
    { kind: "tool", id: "tool-result-pin", sourceId: "call1", resultId: "result1", name: "read", args: "swept arguments", output: "old result" },
    { kind: "tool", id: "tool-call-pin", sourceId: "call2", resultId: "result2", name: "bash", args: "kept arguments", output: "swept result", failed: true },
    { kind: "status", text: "stopped: toolUse" },
    { kind: "agent", text: "hi", recordId: "chat-1" },
    { kind: "person", text: "hello", handle: "U2" },
  ];
  const pins = [
    { id: "out-id", kind: "plainText", text: "kept output", pinned: "user", createdAt: 1 },
    { id: "result1", kind: "readResult", text: "refreshed result", pinned: "user", createdAt: 1 },
    { id: "call2", kind: "toolCall", text: "kept arguments", pinned: "agent", createdAt: 1 },
  ];
  const first = retainAfterCollapse(entries, pins);
  assert.deepEqual(first.filter((entry) => entry.kind === "person").map((entry) => entry.text), ["hello", "hello"], "identical person messages are distinct");
  assert.equal(first.filter((entry) => entry.kind === "agent").length, 1, "the same Chat record is kept only once");
  assert.equal(first[0].handle, undefined, "old generation U handles are not reused");
  const view = new TranscriptView();
  view.setEntries(first);
  const text = view.toPlainText();
  assert.match(text, /kept output/);
  assert.match(text, /refreshed result/);
  assert.match(text, /kept arguments/);
  assert.doesNotMatch(text, /swept thought|swept arguments|swept result|stopped: toolUse/);
  const second = retainAfterCollapse([...first, { kind: "agent", text: "hi", recordId: "chat-1" }, { kind: "person", text: "next" }], [pins[0]]);
  assert.equal(second.filter((entry) => entry.kind === "agent").length, 1);
  assert.equal(second.filter((entry) => entry.kind === "tool").length, 0, "unpinned work disappears on the next collapse");
  assert.deepEqual(second.filter((entry) => entry.kind === "person").map((entry) => entry.text), ["hello", "hello", "next"]);
});

test("notifications flash transiently instead of accumulating in the transcript", () => {
  let clock = 1_000;
  const flashes = [];
  const notify = createStatusNotifier((text, duration) => flashes.push({ text, duration }), () => clock);
  const transcript = new TranscriptView();
  transcript.setEntries([{ kind: "person", text: "hello" }]);
  notify("that entry is not a Brain record");
  notify("that entry is not a Brain record");
  assert.deepEqual(flashes, [{ text: "that entry is not a Brain record", duration: 3_000 }]);
  assert.equal(transcript.toPlainText(), "you: hello");
  notify("another notice");
  clock += 3_001;
  notify("that entry is not a Brain record");
  assert.equal(flashes.length, 3, "different or later notifications can still be shown");
  assert.equal(transcript.toPlainText(), "you: hello");
});

test("TranscriptView mouse click folds and unfolds cards", () => {
  const transcript = new TranscriptView();
  transcript.setEntries([
    {
      kind: "tool",
      id: "tool-1",
      name: "read",
      args: '{"path": "src/index.ts"}',
      output: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"),
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

  const click = (y) => transcript.handleMouse({
    type: "click", button: "left", x: 8, y, screenX: 8, screenY: y,
    width: 80, height: 50, shift: false, alt: false, ctrl: false,
  });
  let shown = plain(rendered.join("\n"));
  assert.match(shown, /16 lines more/);
  assert.doesNotMatch(shown, /line 40\b/);

  // Any body row expands a long card. The next body tap returns to preview.
  assert.ok(click(2)?.handled);
  shown = plain(transcript.render(80).join("\n"));
  assert.match(shown, /line 40\b/);
  assert.match(shown, /· full/);
  assert.ok(click(2)?.handled);
  shown = plain(transcript.render(80).join("\n"));
  assert.match(shown, /16 lines more/);
  assert.doesNotMatch(shown, /line 40\b/);

  // The hidden-lines rule is another body row, not a separate sticky state.
  const rule = transcript.render(80).findIndex((line) => plain(line).includes("lines more"));
  click(rule);
  assert.match(plain(transcript.render(80).join("\n")), /line 40\b/);
  click(0);
  assert.equal(transcript.render(80).length, initialLineCount, "header collapses even from full");
  click(0);
  shown = plain(transcript.render(80).join("\n"));
  assert.match(shown, /16 lines more/, "reopening returns to preview");
  assert.doesNotMatch(shown, /line 40\b/);

  click(2);
  transcript.toggleAllCards();
  assert.equal(transcript.render(80).length, initialLineCount);
  transcript.toggleAllCards();
  assert.match(plain(transcript.render(80).join("\n")), /16 lines more/, "bulk fold also resets the full view");
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
  // Updates to the same streaming card keep the person's chosen view.
  transcript.setLive([{ kind: "output", id: "live-1-0", live: true, text: [...body, "line 41"].join("\n") }]);
  shown = plain(transcript.render(80).join("\n"));
  assert.match(shown, /line 1\b/);
  transcript.handleMouse({ type: "click", button: "left", x: 8, y: 2, screenX: 8, screenY: 2, width: 80, height: 50, shift: false, alt: false, ctrl: false });
  shown = plain(transcript.render(80).join("\n"));
  assert.match(shown, /33 lines earlier/);
  assert.match(shown, /line 41\b/);
  transcript.handleMouse({ type: "click", button: "left", x: 8, y: 0, screenX: 8, screenY: 0, width: 80, height: 50, shift: false, alt: false, ctrl: false });
  assert.equal(transcript.render(80).length, 1, "the live card's header collapses it");
  transcript.handleMouse({ type: "click", button: "left", x: 8, y: 0, screenX: 8, screenY: 0, width: 80, height: 50, shift: false, alt: false, ctrl: false });
  assert.match(plain(transcript.render(80).join("\n")), /33 lines earlier/);
});

test("a short card stays open on a body click and collapses on its header", () => {
  const transcript = new TranscriptView();
  transcript.setEntries([{ kind: "output", id: "short", text: "short body" }]);
  const click = (y) => transcript.handleMouse({ type: "click", button: "left", x: 8, y, screenX: 8, screenY: y, width: 80, height: 10, shift: false, alt: false, ctrl: false });
  transcript.render(80);
  click(0);
  assert.match(plain(transcript.render(80).join("\n")), /short body/);
  click(1);
  assert.equal(transcript.render(80).length, 2, "a short body click does not fold or mark it full");
  assert.doesNotMatch(plain(transcript.render(80).join("\n")), /· full/);
  click(0);
  assert.equal(transcript.render(80).length, 1);
});

test("every item in the prompt carries its own handle, and a bash result takes S", () => {
  // §5.4 and §5.5: a person's message is `U`, an ephemeral item is `X`, and a
  // tool result is an item of its own — `R`, or `S` when the shell produced it,
  // because a result is what gets pinned and quoted, not the call that asked.
  const handles = promptHandles([
    { kind: "person", key: "1" },
    { kind: "reasoning", key: "2-0" },
    { kind: "call", key: "2-1" },
    { kind: "result", key: "3" },
    { kind: "call", key: "4-0" },
    { kind: "result", key: "5", tool: "bash" },
    { kind: "text", key: "2-2" },
  ]);
  assert.equal(handles.person("1"), "U1");
  assert.equal(handles.ephemeral("2-0"), "X1");
  assert.equal(handles.ephemeral("2-1"), "X2");
  assert.equal(handles.result("3"), "R1", "a tool result has a handle like any other item");
  assert.equal(handles.ephemeral("2-2"), "X4", "and the other items are still counted in prompt order");
  assert.equal(handles.result("5"), "S1", "a bash result is the subdivision of R that gets quoted");

  // The transcript draws them: a person's line, a card, and a tool row that
  // carries the handle of the result it holds.
  const transcript = new TranscriptView();
  transcript.setEntries([
    { kind: "person", text: "make the dice soft", handle: "U1" },
    { kind: "tool", id: "t", handle: "S1", name: "bash", args: "npm test", output: "ok" },
  ]);
  const shown = plain(transcript.render(80).join("\n"));
  assert.ok(shown.includes("U1"), "a person's line carries its handle");
  assert.ok(shown.includes("S1"), "a card carries the handle of the item it is");
});

test("the context view is the prefill: head, body, tail, every entry folds and starts closed", () => {
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
  brain.atlas.push({ id: "a1", title: "The Brain is the persistent record", text: "…", links: [], attachments: [], mark: { action: "archive", author: "user" }, createdAt: 0, updatedAt: 0 });
  brain.ledger.push({ id: "l1", kind: "goal", text: "Keep the prefill in one order", status: "open", answer: null, mark: { action: "delete", author: "agent" }, createdAt: 1, updatedAt: 1 });
  brain.chat.push({ id: "c1", author: "agent", text: "The context view is the prefill now.", createdAt: 2, updatedAt: 2 });
  view.setData({
    brain,
    systemPrompt: "You are Carto.",
    // The frozen head holds all three records, so all three are rows.
    projectionText: [
      "Atlas — what you understand about the project",
      "A1 The Brain is the persistent record — 1970-01-01T00:00:00.000Z",
      "",
      "Ledger — what you are working on",
      "L1 [goal · open] Keep the prefill in one order — 1970-01-01T00:00:00.001Z",
      "",
      "Chat — what you and you have said to each other",
      "C1 [you] — 1970-01-01T00:00:00.002Z",
      "  The context view is the prefill now.",
    ].join("\n"),
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

  // Nothing starts open: the prompt is a list of one-line rows, and the `│`
  // gutter appears only beside a body that has been opened.
  assert.ok(!shown.includes("│"), "every entry starts closed");
  assert.ok(shown.includes("You are Carto."), "a closed row carries its one-line summary");
  // Any mark on a Brain record is visible on its closed row (§4.1).
  assert.ok(shown.includes("archive on collapse · you"), "a user archive mark is shown on the row");
  assert.ok(shown.includes("delete on collapse · agent"), "an agent delete mark is shown on the row");

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
  // The cursor starts on the system prompt, so one press opens the body.
  wide.handleInput("\r");
  let promptLines = wide.render(100).map(plain).filter((line) => line.includes("│"));
  for (const line of promptLines) assert.ok(!line.includes("…"), `an open body is not clipped: ${line}`);
  assert.equal(promptLines.join(" ").replace(/\s+/g, " ").includes("rather than trail off"), true, "the whole paragraph is there");
  for (const width of [72, 100, 140]) {
    for (const line of wide.render(width)) assert.equal(visibleWidth(line), width, "the pane's width holds at every size");
  }

  // An entry folds and unfolds independently of cursor wrapping.
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
  folding.handleInput("\r"); // close the entry
  assert.equal(gutter(), false, "enter closes the entry");
  folding.handleInput("\r"); // and opens it again
  assert.equal(gutter(), true, "enter opens it again");

  // `toggleAll` is the same action for the whole context: close what is open,
  // and open what is closed — with no class of row left out of it.
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
  const archives = [];
  const collapses = [];
  view.onDelete = (part, id, now) => marks.push({ part, id, now });
  view.onArchive = (part, id, now) => archives.push({ part, id, now });
  view.onCollapse = () => collapses.push(true);
  // Walk down to the person's line: the head's Brain records and tools are
  // markable too, so the walk reaches them first and names each of them.
  for (let step = 0; step < 20; step += 1) {
    view.handleInput("j");
    view.handleInput("d");
    if (marks.some((mark) => mark.part === "transcript")) break;
  }
  assert.ok(marks.some((mark) => mark.part === "atlas" && mark.id === "a1"), "an atlas record in the head can be marked");
  assert.ok(marks.some((mark) => mark.part === "ledger" && mark.id === "l1"), "a ledger record in the head can be marked");
  assert.ok(marks.some((mark) => mark.part === "chat" && mark.id === "c1"), "a chat record in the head can be marked");
  const onPerson = marks.find((mark) => mark.part === "transcript");
  assert.ok(onPerson !== undefined, "the person's line can be marked");
  assert.equal(onPerson.id, 2, "the mark names the entry it is on, not a phantom");
  for (const mark of marks) assert.equal(mark.now, false, "no `!` yet, so the marks wait for the collapse");
  // `!` arms the next mark to be applied now rather than at the collapse.
  marks.length = 0;
  view.handleInput("!");
  view.handleInput("d");
  assert.ok(marks.length > 0 && marks.every((mark) => mark.now === true), "an armed mark applies now");

  // Ephemera is swept by default: the first `a` only highlights, the second
  // archives immediately, and `u` can cancel the confirmation.
  archives.length = 0;
  view.handleInput("a");
  assert.equal(archives.length, 0);
  view.handleInput("u");
  view.handleInput("a");
  assert.equal(archives.length, 0);
  view.handleInput("a");
  assert.ok(archives.length > 0 && archives.every((mark) => mark.now === true));
  archives.length = 0;
  view.handleInput("!");
  view.handleInput("a");
  assert.ok(archives.length > 0 && archives.every((mark) => mark.now === true), "`!a` applies immediately");

  view.handleInput("c");
  assert.equal(collapses.length, 1, "`c` collapses");
});

test("the two books are two panes: the list names the entry, l focuses its detail, h returns", () => {
  // Atlas and Ledger share the two-pane shape (§2.1): a list on the left, the
  // selected entry's detail on the right, and one keystroke between them. The
  // break this names is a pane switch that moves focus without showing it —
  // the detail must say [FOCUSED] when it has the keys, and stop saying it
  // when the list takes them back.
  const atlas = new AtlasView();
  const atlasBrain = emptyBrain();
  atlasBrain.atlas.push({
    id: "a1",
    title: "Entrypoint",
    text: "Entrypoint of the application",
    links: [],
    attachments: [{ kind: "file", path: "src/index.ts" }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  atlasBrain.handles.entries.push({ kind: "atlas", id: "a1", handle: "A1", timestamp: Date.now() });
  atlas.setData(atlasBrain, []);

  const ledger = new LedgerView();
  const ledgerBrain = emptyBrain();
  ledgerBrain.ledger.push({
    id: "l1",
    kind: "goal",
    text: "Refactor UI components with two-pane layout",
    status: "open",
    answer: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  ledgerBrain.handles.entries.push({ kind: "ledger", id: "l1", handle: "L1", timestamp: Date.now() });
  ledger.setData(ledgerBrain);

  for (const [name, view, shown] of [["atlas", atlas, "Entrypoint"], ["ledger", ledger, "Refactor UI"]]) {
    // The list names the entry under its handle, and every line is the frame's width.
    let lines = view.render(100);
    for (const line of lines) assert.equal(visibleWidth(line), 100, `${name}: every line is the frame's width`);
    assert.ok(plain(lines.join("\n")).includes(shown), `${name}: the list shows the entry`);

    // l focuses the detail pane and the detail says so; j/k scroll it.
    view.handleInput("l");
    view.handleInput("j");
    view.handleInput("k");
    lines = view.render(100);
    for (const line of lines) assert.equal(visibleWidth(line), 100, `${name}: still exact after the pane switch`);
    assert.ok(plain(lines.join("\n")).includes("[FOCUSED]"), `${name}: the focused detail says so`);

    // h hands the keys back to the list.
    view.handleInput("h");
    assert.ok(!plain(view.render(100).join("\n")).includes("[FOCUSED]"), `${name}: the list takes the keys back`);

    // A wheel over the view is handled, not dropped.
    const wheel = view.handleMouse({
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
    assert.ok(wheel?.handled, `${name}: the wheel is handled`);
  }
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

test("Atlas and Ledger have no pin: p does nothing there, since only the archive pins a Brain entry", () => {
  const ledger = new LedgerView();
  const brain = emptyBrain();
  brain.ledger.push({ id: "l-a", kind: "note", text: "no pin here", status: "open", answer: null, createdAt: 1, updatedAt: 1 });
  brain.handles.entries.push({ kind: "ledger", id: "l-a", handle: "L1", timestamp: 1 });
  ledger.setData(brain);
  assert.equal(ledger.pinSelected, undefined, "no pin act on the ledger");
  const before = plain(ledger.render(100).join("\n"));
  ledger.handleInput("p");
  assert.equal(plain(ledger.render(100).join("\n")), before, "and the key changes nothing");
  assert.doesNotMatch(plain(ledger.render(100).join("\n")), /p pin/, "the header does not offer it");
});

test("a click never pins; block selection acts with the same keys on Chat blocks and cards", () => {
  const transcript = new TranscriptView();
  const acts = [];
  transcript.onTogglePin = (part, id) => acts.push(["pin", part, id]);
  transcript.onArchive = (part, id, now) => acts.push(["archive", part, id, now]);
  transcript.onDelete = (part, id, now) => acts.push(["delete", part, id, now]);
  transcript.onWithdrawMark = (part, id) => acts.push(["withdraw", part, id]);
  transcript.setEntries([
    { kind: "person", text: "you said this", recordId: "c-p" },
    { kind: "agent", text: "a durable agent statement", recordId: "c-a", handle: "C3" },
    { kind: "tool", id: "ctx-1-0", name: "read", args: "{}", sourceId: "gen:1:t0", resultId: "gen:1:r0" },
    { kind: "agent", text: "boot burst, no record" },
  ]);
  const lines = transcript.render(120);
  assert.ok(plain(lines.join("\n")).includes("C3"), "a Chat block wears its handle");

  const click = transcript.handleMouse({ type: "click", x: 5, y: 2, screenX: 5, screenY: 2, width: 120, height: 20, shift: false, alt: false, ctrl: false });
  assert.equal(click, undefined, "a click on a Chat block is not handled: pinning is a key");
  assert.deepEqual(acts, []);

  assert.equal(transcript.startSelecting(), true);
  assert.ok(plain(transcript.render(120).join("\n")).split("\n").some((line) => line.startsWith("▌")), "the selected block carries a cursor in the margin");
  // The cursor starts on the last block that has an item behind it: the card.
  transcript.pinSelected();
  assert.deepEqual(acts.pop(), ["pin", "tool-work", "gen:1:r0"], "a card is its result, the item a pin keeps");
  transcript.handleInput("k");
  transcript.pinSelected();
  assert.equal(transcript.selectedPart(), "chat", "a Chat block has no pin to offer");
  transcript.pinSelected();
  assert.deepEqual(acts, [], "and p on it does nothing");
  transcript.markSelected("delete");
  assert.deepEqual(acts.pop(), ["delete", "chat", "c-a", false]);
  transcript.toggleApplyNow();
  transcript.markSelected("archive");
  assert.deepEqual(acts.pop(), ["archive", "chat", "c-a", true], "! applies the next mark now");
  transcript.withdrawSelected();
  assert.deepEqual(acts.pop(), ["withdraw", "chat", "c-a"]);
  transcript.handleInput("g");
  transcript.markSelected("archive");
  assert.deepEqual(acts.pop(), ["archive", "chat", "c-p", false], "a person's line is a record too");
  transcript.handleInput("G");
  transcript.markSelected("archive");
  assert.deepEqual(acts, [], "an ephemeral card asks before it archives");
  transcript.markSelected("archive");
  assert.deepEqual(acts.pop(), ["archive", "tool-work", "gen:1:r0", true]);
  let left = false;
  transcript.onLeave = () => { left = true; };
  transcript.handleInput("\u001b");
  assert.ok(left, "escape leaves selection");
  transcript.stopSelecting();
  assert.equal(transcript.isSelecting(), false);
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

  // Fill stays visible while the current prompt's cached, processed and
  // remaining regions advance independently. Progress changes invalidate the
  // render cache even if no transcript entry has changed.
  Object.assign(state.session.state, { prefillActive: true, prefillTotal: 16000, prefilledTokens: 6000, prefillCached: 2000, prefillRate: 100, decodeRate: 20 });
  const reading = plain(bar.render(130)[0]);
  assert.match(reading, /8,000 \/ 32,768/);
  assert.match(reading, /prefill 6,000\/16,000/);
  assert.match(reading, /P 100\.0 D 20\.0 tok\/s/);
  assert.match(reading, /█/);
  assert.match(reading, /▓/);
  state.session.state.prefilledTokens = 9000;
  assert.match(plain(bar.render(130)[0]), /prefill 9,000\/16,000/);
  state.session.state.prefillTotal = undefined;
  assert.match(plain(bar.render(130)[0]), /prefill \?/);
  state.session.state.prefillActive = false;

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

  // When two views bind the same key, an unavailable command yields to the
  // later available one rather than blocking it.
  let sharedRan = 0;
  let layer = "context";
  const shared = new Registry([
    { id: "first", group: "a", label: "first", key: "d", run: () => { sharedRan += 100; }, available: () => layer === "context" },
    { id: "second", group: "b", label: "second", key: "d", run: () => { sharedRan += 200; }, available: () => layer === "archive" },
  ]);
  layer = "archive";
  assert.equal(shared.dispatch("d"), true);
  assert.equal(sharedRan, 200, "an unavailable binding lets a later binding on the same key run");

  // `^p` is in the registry but quiet, so it never crowds the footer.
  assert.deepEqual(registry.footer().map((command) => command.id), ["fold"]);
  assert.equal(registry.dispatch("\u0010"), true);
  assert.equal(ran, 11);
});

test("jump is one keystroke: a listed letter lands, anything else lands nowhere", () => {
  // §8: the overlay is a reminder of the keys, not a second scheme, so every
  // target's letter is the same letter `ctrl+o <letter>` takes. A letter that
  // is listed but does not jump would be a key the overlay lies about.
  const landed = [];
  const overlay = new JumpOverlay();
  overlay.onJump = (key) => landed.push(key);

  assert.equal(new Set(JUMP_TARGETS.map((target) => target.key)).size, JUMP_TARGETS.length, "no two views share a letter");
  for (const target of JUMP_TARGETS) {
    overlay.handleInput(target.key);
    assert.equal(landed.at(-1), target.key, `${target.key} lands on ${target.view}`);
  }

  // Anything not on the list is not a destination, and closing is not jumping.
  const before = landed.length;
  overlay.handleInput("z");
  overlay.handleInput("\u001b");
  assert.equal(landed.length, before, "an unlisted letter and esc land nowhere");

  // The frame names every destination it offers, one row each.
  const shown = plain(overlay.render(60).join("\n"));
  for (const target of JUMP_TARGETS) {
    assert.ok(shown.includes(target.label), `${target.label} is drawn`);
    assert.ok(shown.includes(target.description.slice(0, 12)), `${target.label}'s description is drawn`);
  }
});

test("the drawn workspace is exact to its width, and the archive is a layer over it", () => {
  const width = 104;
  const transcript = previewTranscript(width);
  const context = previewContext(width);
  const archive = previewArchive(width);
  const tree = previewTree(width);

  for (const [name, frame] of [["transcript", transcript], ["context", context], ["archive", archive], ["tree", tree]]) {
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

test("the archive marks first and applies now only on the second press, and says so between them", async () => {
  const view = new ArchiveView();
  const marked = [];
  const applied = [];
  view.onDelete = (id) => marked.push(id);
  view.onApplyNow = (id, action) => applied.push(`${action}:${id}`);
  view.setData({
    version: 1,
    items: [
      { id: "1", layer: "ephemeral", ephemeral: { kind: "plainText", text: "the first thing" }, sweptAtGeneration: "g", sweptAtCollapse: 1, sweptAt: 10 },
      { id: "2", layer: "ephemeral", ephemeral: { kind: "plainText", text: "the second thing" }, sweptAtGeneration: "g", sweptAtCollapse: 1, sweptAt: 20 },
    ],
  });

  assert.equal(view.deleteSelected(), "marked", "the first press marks it for delete");
  assert.deepEqual(marked, ["2"], "and the mark names the item the cursor is on");
  assert.deepEqual(applied, [], "nothing is applied by the first press");
  assert.match(view.render(80).join("\n"), /d again: delete now/, "the arming is visible, or the key looks broken");
  assert.equal(view.deleteSelected(), "applied", "the second press applies the mark now");
  assert.deepEqual(applied, ["delete:2"], "deleting the item the cursor named");

  // Moving the cursor withdraws the arm: a person who moved on did not mean it.
  view.deleteSelected();
  view.handleInput("j");
  view.handleInput("k");
  assert.equal(view.deleteSelected(), "marked", "the arm did not survive a move");
  assert.deepEqual(applied, ["delete:2"], "and nothing else was applied");
});

test("an archive mark is drawn with its action and its author, so it is not invisible", () => {
  const view = new ArchiveView();
  view.setData({
    version: 1,
    items: [
      {
        id: "1",
        layer: "ephemeral",
        ephemeral: { kind: "plainText", text: "marked by the agent" },
        sweptAtGeneration: "g",
        sweptAtCollapse: 1,
        sweptAt: 10,
        mark: { action: "restore", author: "agent" },
      },
    ],
  });
  const frame = view.render(90).join("\n");
  assert.match(frame, /→ restore at the next collapse · agent/, "the row says what the collapse will do, and who decided it");
  view.setData({ version: 1, items: [
    { id: "long-id", layer: "ephemeral", ephemeral: { kind: "readResult", text: "one" }, sweptAtGeneration: "g", sweptAtCollapse: 1, sweptAt: 20, pinned: "user", mark: { action: "delete", author: "user" } },
    { id: "2", layer: "ephemeral", ephemeral: { kind: "plainText", text: "two" }, sweptAtGeneration: "g", sweptAtCollapse: 1, sweptAt: 10, mark: { action: "restore", author: "agent" } },
  ] });
  const narrow = plain(view.render(40).join("\n"));
  assert.match(narrow, /→ delete at the next collapse/, "a pin does not hide the delete mark");
  assert.match(narrow, /→ restore at the next collapse/, "the other marked item is visible too");
});

test("the archive's u withdraws the mark on the selected item, and refuses when there is none", () => {
  // The app's `u` calls withdrawSelected and reports the false: a key that looks
  // dead when the item carries no mark, rather than one that does nothing and
  // says nothing. Both halves are the guard — the mark is withdrawn where one
  // stands, and nowhere else.
  const view = new ArchiveView();
  const withdrawn = [];
  view.onWithdrawMark = (id) => withdrawn.push(id);
  view.setData({
    version: 1,
    items: [
      { id: "1", layer: "ephemeral", ephemeral: { kind: "plainText", text: "marked" }, sweptAtGeneration: "g", sweptAtCollapse: 1, sweptAt: 20, mark: { action: "restore", author: "agent" } },
      { id: "2", layer: "ephemeral", ephemeral: { kind: "plainText", text: "bare" }, sweptAtGeneration: "g", sweptAtCollapse: 1, sweptAt: 10 },
    ],
  });

  assert.equal(view.withdrawSelected(), true, "a mark on the selection is withdrawn");
  assert.deepEqual(withdrawn, ["1"], "and it names the item the cursor is on");

  view.handleInput("j");
  assert.equal(view.withdrawSelected(), false, "an item with no mark refuses");
  assert.deepEqual(withdrawn, ["1"], "and nothing else is withdrawn");

  // The key route takes the same path, so the footer's `u` is not decoration.
  view.handleInput("k");
  view.handleInput("u");
  assert.deepEqual(withdrawn, ["1", "1"], "u withdraws the selected item's mark");
});

test("the archive keeps a restored item's type and the author of its pin", () => {
  const frame = plain(previewArchive(110));
  assert.ok(frame.includes("you"), "a pin says who placed it");
  assert.ok(frame.includes("restore"), "restoring is on the layer, in the footer");
  assert.ok(frame.includes("ledger") && frame.includes("atlas") && frame.includes("toolResult"), "records keep their kind and swept items keep theirs");
});

test("marked Chat entries in the transcript show their pending action", () => {
  const view = new TranscriptView();
  view.setEntries([
    { kind: "agent", recordId: "1", handle: "C1", text: "first", mark: { action: "delete", author: "user" } },
    { kind: "agent", recordId: "2", handle: "C2", text: "second", mark: { action: "archive", author: "agent" } },
  ]);
  const frame = plain(view.render(80).join("\n"));
  assert.match(frame, /delete on collapse · you/);
  assert.match(frame, /archive on collapse · agent/);
  view.setEntries([{ kind: "agent", recordId: "1", handle: "C1", text: "first" }]);
  assert.doesNotMatch(plain(view.render(80).join("\n")), /on collapse/);
});

test("a Brain delete mark appears on the Context row until withdrawn", () => {
  let brain = emptyBrain();
  brain = applyWrite(brain, { kind: "chat.record", record: { id: "c1", author: "agent", text: "remember this", createdAt: 1, updatedAt: 1 } }, 1);
  const view = new ContextView();
  const refresh = () => view.setData({ brain, systemPrompt: "system", tools: [], transcriptMessages: [], toolWorkItems: [], stateBlockText: "state" });
  refresh();
  view.handleInput("j");
  view.onDelete = (part, id, now) => {
    assert.deepEqual({ part, id, now }, { part: "chat", id: "c1", now: false });
    brain = applyWrite(brain, { kind: "mark.set", target: "chat", id, action: "delete", author: "user" }, 2);
    refresh();
  };
  view.handleInput("d");
  assert.match(plain(view.render(40).join("\n")), /delete on collapse · you/);
  assert.equal(brain.chat.length, 1, "the mark does not delete the record yet");
  brain = applyWrite(brain, { kind: "mark.clear", target: "chat", id: "c1", author: "user" }, 3);
  refresh();
  assert.doesNotMatch(plain(view.render(40).join("\n")), /delete on collapse/);
});

test("ephemeral delete and archive confirmation are visible and cancellable", () => {
  let brain = emptyBrain();
  const view = new ContextView();
  const id = "generation:7:t0";
  const refresh = () => view.setData({ brain, systemPrompt: "system", tools: [], transcriptMessages: [], toolWorkItems: [{ id, kind: "reasoning", text: "some thought" }], stateBlockText: "state" });
  const archived = [];
  view.onArchive = (part, target, now) => archived.push({ part, target, now });
  view.onDelete = (_part, target) => { brain = applyWrite(brain, { kind: "ephemeral.delete-mark", id: target, marked: true }, 1); refresh(); };
  view.onWithdrawMark = (_part, target) => { brain = applyWrite(brain, { kind: "ephemeral.delete-mark", id: target, marked: false }, 1); refresh(); };
  refresh();
  view.handleInput("j");
  view.handleInput("d");
  assert.match(plain(view.render(50).join("\n")), /delete on collapse/);
  view.handleInput("u");
  assert.doesNotMatch(plain(view.render(50).join("\n")), /delete on collapse/);
  view.handleInput("a");
  assert.equal(archived.length, 0);
  const highlighted = view.render(80).find((line) => plain(line).includes("some thought"));
  assert.match(highlighted, /\x1b\[/, "confirmation has styled ink");
  view.handleInput("u");
  view.handleInput("a");
  assert.equal(archived.length, 0, "withdraw cancelled the first confirmation");
  view.handleInput("a");
  assert.deepEqual(archived, [{ part: "tool-work", target: id, now: true }]);
});

test("every marked Brain record is indicated in Context and in its book", () => {
  let brain = emptyBrain();
  brain = applyWrite(brain, { kind: "atlas.upsert", node: { id: "a", title: "a very long atlas title that should not hide the mark", text: "body", links: [], attachments: [], pinned: "user", createdAt: 1, updatedAt: 1 } }, 1);
  brain = applyWrite(brain, { kind: "ledger.upsert", entry: { id: "l", kind: "note", text: "a very long ledger entry that should not hide the mark", status: "open", answer: null, pinned: "agent", createdAt: 2, updatedAt: 2 } }, 2);
  brain = applyWrite(brain, { kind: "chat.record", record: { id: "c", author: "agent", text: "chat", createdAt: 3, updatedAt: 3 } }, 3);
  const view = new ContextView();
  for (const action of ["delete", "archive"]) {
    for (const author of ["user", "agent"]) {
      for (const [target, id] of [["atlas", "a"], ["ledger", "l"], ["chat", "c"]]) {
        brain = applyWrite(brain, { kind: "mark.set", target, id, action, author }, 4);
      }
      view.setData({ brain, systemPrompt: "system", tools: [], transcriptMessages: [], toolWorkItems: [], stateBlockText: "state" });
      const rows = view.render(40).map(plain);
      for (const handle of ["A1", "L1", "C1"]) {
        const row = rows.find((line) => new RegExp(`\\b${handle}\\b`).test(line));
        assert.ok(row?.includes(`${action} on collapse · ${author === "user" ? "you" : "agent"}`), `${handle}: ${action} by ${author}`);
      }
      const atlas = new AtlasView();
      atlas.setData(brain, []);
      const ledger = new LedgerView();
      ledger.setData(brain);
      for (const [book, handle] of [[atlas, "A1"], [ledger, "L1"]]) {
        for (const width of [40, 100]) {
          const row = book.render(width).map(plain).find((line) => line.includes(`[${handle}]`) && line.includes("◆"));
          assert.ok(row?.includes(action), `${handle}: ${action} visible at width ${width}`);
        }
      }
    }
  }
});

test("the context cursor wraps between entries and survives refreshes and deletions", () => {
  const data = () => ({
    brain: emptyBrain(),
    systemPrompt: "you are carto",
    tools: [],
    transcriptMessages: [{ id: "u1", entry: 9, order: -1, role: "user", text: "hello" }],
    toolWorkItems: [
      { id: "g1:7:t0", entry: 7, order: 0, kind: "reasoning", text: "thinking one" },
      { id: "g1:7:c1", entry: 7, order: 1, kind: "toolCall", name: "tree", args: "{}" },
      { id: "g1:8:r", entry: 8, order: 99, kind: "toolResult", output: "result one" },
    ],
    stateBlockText: "<carto-state>\n</carto-state>",
  });
  const view = new ContextView();
  view.setData(data());
  const onHeading = () => {
    const row = view.rows[view.cursor];
    return row === undefined || !("node" in row);
  };

  // Walking either way must never land on a section heading: the heading is
  // drawn without a cursor, so landing on one made the cursor disappear.
  for (let press = 0; press < 12; press += 1) {
    view.handleInput("j");
    assert.equal(onHeading(), false, `j ${press + 1} landed on an entry`);
  }
  for (let press = 0; press < 12; press += 1) {
    view.handleInput("k");
    assert.equal(onHeading(), false, `k ${press + 1} landed on an entry`);
  }

  // The edges wrap, skipping the section headings in both directions.
  view.handleInput("g");
  const first = view.cursor;
  view.handleInput("G");
  const last = view.cursor;
  view.handleInput("j");
  assert.equal(view.cursor, first, "j at the last entry wraps to the first");
  view.handleInput("k");
  assert.equal(view.cursor, last, "k at the first entry wraps to the last");

  // The app re-renders this view on a timer while a run is going. That refresh
  // used to reset the cursor to the top; it must hold the entry instead.
  view.handleInput("g");
  view.handleInput("j");
  view.handleInput("j");
  const before = view.rows[view.cursor];
  view.setData(data());
  const after = view.rows[view.cursor];
  assert.ok(before !== undefined && "node" in before && after !== undefined && "node" in after);
  assert.equal(after.node.id, before.node.id, "the cursor held its entry across the refresh");
  assert.equal(view.cursor, view.rows.findIndex((row) => "node" in row && row.node.id === after.node.id));

  const changed = data();
  changed.toolWorkItems.unshift({ id: "g1:6:t0", entry: 6, order: 0, kind: "reasoning", text: "new earlier item" });
  view.setData(changed);
  const shifted = view.rows[view.cursor];
  assert.ok(shifted !== undefined && "node" in shifted);
  assert.equal(shifted.node.id, before.node.id, "a new earlier row does not move the selection to a different item");
  let target;
  view.onDelete = (part, id, now) => { target = { part, id, now }; };
  view.handleInput("!");
  view.handleInput("d");
  assert.deepEqual(target, { part: "tool-work", id: before.node.target.id, now: true });

  // Remove the last body entry as an apply-now action would; the state block
  // still follows it, but the cursor should move up to the preceding entry.
  view.handleInput("G");
  view.handleInput("k");
  assert.equal(view.rows[view.cursor].node.id, "msg-u1");
  view.handleInput("k");
  const preceding = view.rows[view.cursor].node.id;
  view.handleInput("j");
  const removed = data();
  removed.transcriptMessages = [];
  view.onDelete = () => view.setData(removed);
  view.handleInput("!");
  view.handleInput("d");
  assert.equal(view.rows[view.cursor].node.id, preceding, "deleting the last body entry selects its predecessor");
});

test("a moving cursor is scrolled into view rather than off the pane", () => {
  const view = new ContextView();
  const revealed = [];
  view.onReveal = (start, end) => revealed.push([start, end]);
  view.setData({
    brain: emptyBrain(),
    systemPrompt: "you are carto",
    tools: [],
    transcriptMessages: [{ id: "u1", entry: 9, order: -1, role: "user", text: "hello" }],
    toolWorkItems: [
      { id: "g1:7:t0", entry: 7, order: 0, kind: "reasoning", text: "thinking one" },
      { id: "g1:7:c1", entry: 7, order: 1, kind: "toolCall", name: "tree", args: "{}" },
    ],
    stateBlockText: "<carto-state>\n</carto-state>",
  });
  const lines = view.render(100);
  assert.equal(revealed.length, 0, "nothing is revealed before there is a row to reveal");

  view.handleInput("j");
  assert.equal(revealed.length, 1, "a move asks the pane to show the row");
  const [start, end] = revealed.at(-1);
  assert.ok(start >= 0 && end > start && end <= lines.length, "the range is real rendered lines");

  view.handleInput("G");
  const final = revealed.at(-1);
  assert.equal(final[1], lines.length, "the last entry's range ends at the last line");
});

test("the body is the order the model reads, even when the ids are sweep keys", () => {
  // The sweep names an item `generation:entry:part` for the archive, and that id
  // is what a pin uses. It carries no order: parsing it as a number yields 0,
  // which used to float every piece of tool work above the person's message.
  // Order comes from the entry and the part, which is what the app supplies.
  const view = new ContextView();
  view.setData({
    brain: emptyBrain(),
    systemPrompt: "you are carto",
    tools: [],
    transcriptMessages: [
      // Entry 9: what the person said, so it comes last of the three.
      { id: "u1", entry: 9, order: -1, role: "user", text: "let's build a dice roller" },
    ],
    toolWorkItems: [
      { id: "gen-20261121T120000Z-ab12:7:t0", entry: 7, order: 0, kind: "reasoning", text: "start with the tree" },
      { id: "gen-20261121T120000Z-ab12:7:c1", entry: 7, order: 1, kind: "toolCall", name: "tree", args: '{ "depth": 3 }' },
      { id: "gen-20261121T120000Z-ab12:8:r", entry: 8, order: Number.MAX_SAFE_INTEGER, kind: "toolResult", output: "Anchored at src, depth 3." },
    ],
    stateBlockText: "<carto-state>\n</carto-state>",
  });
  const frame = plain(view.render(110).join("\n"));
  const at = (needle) => {
    const index = frame.indexOf(needle);
    assert.notEqual(index, -1, `${needle} is in the body`);
    return index;
  };
  // The model reads: thinking, the call, its result, then the message that came
  // after. A closed row carries the item's own summary, so the order is read off
  // the rows themselves — the call's arguments name its row where its label
  // alone could be confused with the thinking above it.
  assert.ok(at("start with the tree") < at('"depth": 3'), "thinking precedes the call it produced");
  assert.ok(at('"depth": 3') < at("Anchored at src"), "the call precedes its result");
  assert.ok(at("Anchored at src") < at("dice roller"), "and the person's message is last, where it arrived");
  assert.ok(at("start with the tree") < at("dice roller"), "tool work never jumps above an earlier message");
});

test("a pinned file is in the head, under the tree's handle, with the person who pinned it", () => {
  const view = new ContextView();
  view.setData({
    brain: { ...emptyBrain(), files: [{ path: "notes.md", pinned: "user", createdAt: 1 }] },
    person: "OracleToes",
    systemPrompt: "you are carto",
    tools: [],
    transcriptMessages: [],
    toolWorkItems: [],
    stateBlockText: "<carto-state>\n</carto-state>",
    treeHandles: { "notes.md": "F7" },
  });
  const frame = plain(view.render(110).join("\n"));
  assert.ok(frame.includes("notes.md"), "the file is in the head");
  assert.match(frame, /F7/, "under the handle the tree gave it");
  assert.match(frame, /pinned by OracleToes/, "and says whose pin it is");
});

test("a pin reads the same in the block and in the view: P and the handle of what it marks", () => {
  // One pinned item, added the way the Brain adds one, so its handle comes from
  // the handle table and both renderings have to agree on the name (§5.4).
  let brain = emptyBrain();
  brain = applyWrite(brain, { kind: "ephemeral.pin", item: { id: "gen:1:t0", text: "kept", kind: "reasoning", createdAt: 1, pinned: "user" } }, 1);
  const handle = brain.handles.entries.find((entry) => entry.id === "gen:1:t0").handle;

  const block = renderStateBlock({
    person: "OracleToes",
    contextWindow: 32768,
    lastReportedInput: 9000,
    systemTokens: 500,
    transcriptTokens: 300,
    toolWorkTokens: 200,
    toolWorkSince: 20,
    sizes: { atlas: 0, ledger: 0, chat: 0, ephemera: 100, files: 0 },
    pending: [],
    pinned: [{ handle, author: "user" }],
    marks: [],
    stale: [],
    resolveHandle: (kind, id) => (kind === "ephemera" && id === "gen:1:t0" ? handle : undefined),
    mode: "edit",
    tree: { root: "/project", depth: 1, lines: [] },
  });
  assert.match(block, new RegExp(`pins:\\n  P ${handle} · placed by OracleToes`));

  const view = new ContextView();
  view.setData({
    brain,
    systemPrompt: "you are carto",
    tools: [],
    transcriptMessages: [],
    toolWorkItems: [],
    stateBlockText: block,
    person: "OracleToes",
  });
  // Same person, same handle: the view and the block agree on both.
  assert.match(plain(view.render(120).join("\n")), new RegExp(`P ${handle} OracleToes`), "the view names the pin the block names");
});

test("the tree view shows the harness's own facts: handles, attached notes, pins, deep sizes", () => {
  const frame = previewTree(110);
  const shown = plain(frame);

  // Handles come from the same minting the block uses, so a file the tree lists
  // wears the handle the `read` tool would take.
  assert.match(shown, /F1\b/, "files carry their handles");
  assert.match(shown, /D1\b/, "directories carry theirs");

  // A note attached to a file, and the node's handle, on the file's own row: this
  // is the fact that makes the tree more than a listing.
  assert.ok(shown.includes("A1") && shown.includes("brain.ts"), "an attached Atlas node is named on the file it attaches to");
  assert.ok(shown.includes("A2") && shown.includes("handles.ts"), "and so is the second one");

  // The pin on the row itself, not merely somewhere in the frame: the head is
  // holding this file's bytes, and `P` beside its handle is how the row says so.
  const pinnedRow = shown.split("\n").find((line) => line.includes("brain.ts"));
  assert.ok(pinnedRow !== undefined, "the pinned file is in the tree");
  assert.match(pinnedRow, /brain\.ts\s+P\b/, "the pinned file's own row carries P");

  // The detail pane teaches the interface rather than only describing the row,
  // and a file's pane names the move from one file to what holds it.
  assert.match(shown, /read F\d/, "the pane names the call the file's handle is for");
  assert.match(shown, /tree D\d+ depth \d+/, "and the call that moves the anchor");

  // A directory's size counts its whole subtree: it is a cost, not a listing.
  assert.match(shown, /\d+(\.\d+)?[KMG]?\s+src/, "directories carry a deep size");
});

test("the tree pins the file under the cursor with p, and a directory or a filter never does", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { TreeView } = await import("../dist/ui/tree-view.js");
  const root = mkdtempSync(join(tmpdir(), "carto-tree-pin-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export {};\n");
  const view = new TreeView();
  view.setData({ root, anchor: { anchor: root, depth: 3 }, brain: emptyBrain() });
  view.render(100);
  const asked = [];
  view.onTogglePin = (path, directory) => asked.push([path, directory]);

  // The first row is the directory: the callback hears it so it can say so, and nothing is pinned.
  view.handleInput("p");
  assert.deepEqual(asked, [[join(root, "src"), true]]);
  view.handleInput("j");
  view.handleInput("p");
  assert.deepEqual(asked[1], [join(root, "src", "a.ts"), false], "a file is named by the absolute path the tree shows");
  assert.match(plain(view.render(110).join("\n")), /p pin/, "the header names the key");

  // While `/` takes text, p is a letter of the filter.
  view.handleInput("/");
  assert.equal(view.isFiltering(), true);
  view.handleInput("p");
  assert.equal(asked.length, 2);
});

test("Atlas and Ledger mark, withdraw and apply now from the list and from the detail pane", () => {
  for (const [name, View, seed] of [
    ["atlas", AtlasView, (brain) => brain.atlas.push({ id: "n1", title: "node", text: "t", links: [], attachments: [], createdAt: 1, updatedAt: 1 })],
    ["ledger", LedgerView, (brain) => brain.ledger.push({ id: "n1", kind: "note", text: "t", status: "open", answer: null, createdAt: 1, updatedAt: 1 })],
  ]) {
    const brain = emptyBrain();
    seed(brain);
    const view = new View();
    if (name === "atlas") view.setData(brain, []); else view.setData(brain);
    const heard = [];
    view.controls.onMark = (id, action, now) => heard.push(["mark", id, action, now]);
    view.controls.onWithdraw = (id) => heard.push(["withdraw", id]);

    view.handleInput("a");
    view.handleInput("d");
    view.handleInput("u");
    assert.deepEqual(heard, [["mark", "n1", "archive", false], ["mark", "n1", "delete", false], ["withdraw", "n1"]], `${name}: the list's keys`);

    // `!` arms the next mark only, says so in the header, and is spent by it.
    heard.length = 0;
    view.handleInput("!");
    assert.match(plain(view.render(100).join("\n")), /applies NOW/, `${name}: the header says the next mark is immediate`);
    view.handleInput("a");
    view.handleInput("a");
    assert.deepEqual(heard, [["mark", "n1", "archive", true], ["mark", "n1", "archive", false]], `${name}: arming is spent by one mark`);

    // The detail pane has the same keys; paging moved to ctrl+d / ctrl+u.
    heard.length = 0;
    view.handleInput("l");
    view.handleInput("d");
    assert.deepEqual(heard, [["mark", "n1", "delete", false]], `${name}: the detail pane marks too`);
    view.handleInput("h");

    // A filter takes letters, so a mark key is not a mark while it is open.
    heard.length = 0;
    view.handleInput("/");
    assert.equal(view.isFiltering(), true);
    view.handleInput("a");
    view.handleInput("d");
    assert.deepEqual(heard, [], `${name}: a filter swallows the letters`);
  }
});

test("a person's line said since the freeze is one row, the body's, and it acts on its Chat record", () => {
  const view = new ContextView();
  const brain = emptyBrain();
  brain.handles = {
    counters: { C: 3 },
    entries: [
      { kind: "chat", id: "c1", handle: "C1", timestamp: 1 },
      { kind: "chat", id: "c2", handle: "C2", timestamp: 2 },
      { kind: "chat", id: "c3", handle: "C3", timestamp: 3 },
    ],
  };
  brain.chat.push({ id: "c1", author: "user", text: "said before the collapse", createdAt: 1, updatedAt: 1 });
  brain.chat.push({ id: "c2", author: "user", text: "said just now", createdAt: 2, updatedAt: 2 });
  brain.chat.push({ id: "c3", author: "agent", text: "the agent answered", createdAt: 3, updatedAt: 3 });
  const marked = [];
  view.onDelete = (part, id) => marked.push([part, id]);
  view.setData({
    brain,
    systemPrompt: "system",
    // The frozen head holds only the first record.
    projectionText: "Chat — what you and x have said to each other\nC1 [x] — 1970-01-01T00:00:00.001Z\n  said before the collapse",
    tools: [],
    transcriptMessages: [{ id: 5, entry: 5, order: -1, role: "user", text: "said just now" }],
    toolWorkItems: [],
    stateBlockText: "state",
  });
  const shown = view.render(100).map(plain).join("\n");
  assert.equal(shown.split("said just now").length - 1, 1, "the live line is shown once");
  assert.ok(shown.includes("said before the collapse"), "the frozen record is in the head");
  assert.ok(!shown.includes("the agent answered"), "the agent's own is not in the head yet, so it is not listed there");
  // The body row is the record: the cursor on it pins that record.
  for (let step = 0; step < 12; step += 1) {
    view.handleInput("j");
    view.handleInput("d");
  }
  assert.ok(marked.some(([part, id]) => part === "chat" && id === "c2"), "a mark on the live line reaches the Chat record");
  assert.ok(!marked.some(([part]) => part === "transcript"), "and not a swept copy");
});

// ── The context view shows what the model reads, and nothing standing in for it ──

const FROZEN_HEAD = [
  "Atlas — what you understand about the project",
  "A1 Plan — 1970-01-01T00:00:00.000Z",
  "  the frozen words",
  "",
  "Pinned files — read again at this collapse",
  "notes.md · pinned by OracleToes",
  "  line one of the file",
  "  ",
  "  line three of the file",
  "src/gone.ts · pinned by you",
  "  (this file could not be read at the collapse)",
  "",
  "Pinned — what OracleToes kept in front of you",
  "X1 [reasoning] a thought kept",
  "  across two lines",
].join("\n");

function frozenBrain() {
  const brain = emptyBrain();
  brain.handles = {
    counters: { A: 1, X: 1 },
    entries: [
      { kind: "atlas", id: "a1", handle: "A1", timestamp: 0 },
      { kind: "ephemera", id: "gen:1:t0", handle: "X1", timestamp: 1 },
    ],
  };
  brain.atlas.push({ id: "a1", title: "Plan", text: "rewritten since the freeze", links: [], attachments: [], createdAt: 0, updatedAt: 5 });
  brain.ephemera.push({ id: "gen:1:t0", text: "a thought kept\nacross two lines", kind: "reasoning", createdAt: 1, pinned: "user" });
  brain.files = [{ path: "notes.md", pinned: "user", createdAt: 1 }, { path: "src/gone.ts", pinned: "agent", createdAt: 1 }];
  return brain;
}

function contextOf(extra = {}) {
  const view = new ContextView();
  view.setData({
    brain: frozenBrain(),
    person: "OracleToes",
    systemPrompt: "you are carto",
    projectionText: FROZEN_HEAD,
    tools: [],
    transcriptMessages: [],
    toolWorkItems: [],
    stateBlockText: "<carto-state>\n[EDIT MODE]\n</carto-state>",
    ...extra,
  });
  view.toggleAll();
  return view;
}

test("a pinned file's row is the file's lines as the head holds them, in both views", () => {
  const view = contextOf();
  const human = plain(view.render(100).join("\n"));
  assert.ok(human.includes("line one of the file") && human.includes("line three of the file"), "the person reads the file itself");
  assert.ok(!human.includes("read again at every collapse"), "no sentence about the file stands in for it");
  assert.ok(!human.includes("(read at the next collapse"), "and no promise of a reading");
  // What the file's row does not say it was reading is not invented for the other.
  assert.ok(human.includes("(this file could not be read at the collapse)"), "a file the collapse could not read says so, in the head's own words");
  view.handleInput("\t");
  const real = plain(view.render(100).join("\n"));
  assert.ok(real.includes("notes.md · pinned by OracleToes"), "the model's view has the header line as written");
  assert.ok(real.includes("  line one of the file"), "and the file's text as indented in the head");
});

test("a file pinned since the freeze is not in the head's rows; the tail carries the highlight, and a file unpinned since is still shown", () => {
  const brain = frozenBrain();
  brain.files = [{ path: "notes.md", pinned: "user", createdAt: 1 }, { path: "later.md", pinned: "user", createdAt: 2 }];
  const view = contextOf({ brain, treeHandles: { "notes.md": "F1", "later.md": "F7" } });
  const shown = plain(view.render(100).join("\n"));
  assert.ok(!shown.includes("later.md"), "the head does not hold it, so the head does not list it");
  assert.ok(!/Not in the model's context yet|does not hold it/.test(shown), "and no row stands in for it with a sentence");
  assert.match(shown, /◆ pin on collapse · F7/, "the tail, where the state block lists the pins, is highlighted");
  assert.ok(shown.includes("src/gone.ts"), "a file the head still holds is shown although the pin is gone");
  assert.match(shown, /unpinned since the freeze/, "with the reason it is leaving");
});

test("`p` toggles a file the head holds, pinned or not: unpinned, its row stays and p pins it again", () => {
  const brain = frozenBrain();
  brain.files = [{ path: "notes.md", pinned: "user", createdAt: 1 }];
  const view = contextOf({ brain });
  const pressed = [];
  view.onTogglePin = (part, id) => pressed.push([part, id]);
  for (let step = 0; step < 40; step += 1) {
    view.handleInput("p");
    view.handleInput("j");
  }
  const files = pressed.filter(([part]) => part === "files").map(([, id]) => id);
  assert.ok(files.includes("notes.md"), "p on a pinned file's row reaches the pin toggle");
  assert.ok(files.includes("src/gone.ts"), "and so does p on the row of a file whose pin was taken off since the freeze, which pins it again");
  assert.match(plain(view.render(100).join("\n")), /unpinned since the freeze/, "that row says it is leaving until then");
});

test("a record is the head's bytes, even after the Brain's copy changed; a pinned item is too", () => {
  const view = contextOf();
  const human = plain(view.render(100).join("\n"));
  assert.ok(human.includes("the frozen words"), "the atlas row shows what the model reads");
  assert.ok(!human.includes("rewritten since the freeze"), "not the Brain's newer text");
  assert.ok(human.includes("a thought kept") && human.includes("across two lines"), "a pinned item's frozen lines, all of them");
  view.handleInput("\t");
  const real = plain(view.render(100).join("\n"));
  assert.ok(!real.includes("not in the frozen projection"), "a frozen pinned item is not called missing");
  assert.ok(real.includes("X1 [reasoning] a thought kept"), "its row is the head's own line");
});

test("a record gone from the Brain since the freeze is still in the view, for the model still reads it", () => {
  const brain = frozenBrain();
  brain.atlas = [];
  const shown = plain(contextOf({ brain }).render(100).join("\n"));
  assert.ok(shown.includes("the frozen words"));
  assert.match(shown, /gone from the Brain since the freeze/);
});

test("a record written since the freeze is not in the head, so the head does not show it", () => {
  const brain = frozenBrain();
  brain.handles.entries.push({ kind: "ledger", id: "l9", handle: "L9", timestamp: 9 });
  brain.ledger.push({ id: "l9", kind: "goal", text: "a goal written later", status: "open", answer: null, createdAt: 9, updatedAt: 9 });
  const view = contextOf({ brain });
  const human = plain(view.render(100).join("\n"));
  assert.ok(!human.includes("a goal written later"), "the context does not hold it yet");
  view.handleInput("\t");
  assert.ok(!plain(view.render(100).join("\n")).includes("a goal written later"), "in neither view");
});

test("an item pinned since the freeze is highlighted where it is, in the body, and has no head row", () => {
  const view = contextOf({
    toolWorkItems: [{ id: "g:2:t0", entry: 2, order: 0, kind: "output", text: "keep this one", pinned: "user" }],
  });
  const shown = plain(view.render(100).join("\n"));
  assert.equal(shown.split("keep this one").length - 1, 1, "listed once: in the body, where the model has it");
  assert.match(shown, /◆ pin on collapse · OracleToes/, "highlighted the way a row marked for delete is");
  assert.match(shown, /◆ pin on collapse · X1/, "and the tail names the pin that waits");
});

test("the model's own text is a body row with its words; the system prompt and tail are shown as sent", () => {
  const view = contextOf({
    toolWorkItems: [{ id: "g:2:t0", entry: 2, order: 0, kind: "output", text: "plain words the model wrote" }],
  });
  const human = plain(view.render(100).join("\n"));
  assert.ok(human.includes("plain words the model wrote"), "an assistant text row has its text");
  assert.ok(!/result\s+\(empty\)/.test(human), "and is not an empty result");
  view.handleInput("\t");
  const real = plain(view.render(100).join("\n"));
  assert.ok(real.includes("you are carto"), "the system prompt is shown as sent");
  assert.ok(!human.includes("what is true right now: mode"), "the tail's row is the block, not a description of it");
  // §5.1: the system prompt first, then the Brain.
  assert.ok(real.indexOf("you are carto") < real.indexOf("A1"), "the system prompt comes before the atlas");
});

test("the token count includes a head that was rendered from the Brain when no frozen file exists", () => {
  const count = (projectionText) => {
    const view = new ContextView();
    view.setData({ brain: frozenBrain(), person: "OracleToes", systemPrompt: "s", ...(projectionText === undefined ? {} : { projectionText }), tools: [], transcriptMessages: [], toolWorkItems: [], stateBlockText: "" });
    return Number(/~([\d,]+) tokens/.exec(plain(view.render(100)[0]))[1].replace(/,/g, ""));
  };
  assert.ok(count(undefined) > count(""), "the fallback head is counted");
});

test("the system message is the instructions first and the frozen projection second (§5.1)", async () => {
  const { createCartoExtension, cartoInstructions } = await import("../dist/runtime/carto-extension.js");
  const extension = createCartoExtension({
    root: "/nonexistent-root",
    brain: { read: async () => emptyBrain() },
    session: { person: "OracleToes", pending: [], tree: { anchor: "", depth: 1 }, collapseRequested: null, readOnly: false, generation: "g" },
    markdownPath: "/nonexistent-root/projection.md",
  });
  const keys = extension.sections.map((entry) => entry.key);
  assert.deepEqual(keys, ["carto-instructions", "carto-context"], "pi puts an agent's own instructions last, so they are a section here");
  const first = await extension.sections[0].render({}, {});
  assert.equal(first, cartoInstructions("OracleToes"));
});

test("Chat the head holds is drawn before the generation's work, whatever the entries' times say", () => {
  // A reloaded generation: its entries are all newer than the Chat the head holds,
  // and two of them (a system entry, a result) carry no time of their own.
  const frame = [{ id: 1, t: 0 }, { id: 2, t: 5_000 }, { id: 3, t: 6_000 }, { id: 9, t: 0 }];
  const head = ["c-first", "c-second"];
  const first = chatKeyOf({ id: "c-first", createdAt: 1_000 }, head, frame);
  const second = chatKeyOf({ id: "c-second", createdAt: 2_000 }, head, frame);
  assert.ok(first < second, "in the head's own order");
  for (const entryId of [1, 2, 3, 9]) assert.ok(second < entryId, `before entry ${entryId}`);
  // Not in the head: after the last entry written before it. An entry with no time anchors nothing.
  assert.equal(chatKeyOf({ id: "later", createdAt: 5_500 }, head, frame), 2.5);
  assert.equal(chatKeyOf({ id: "older", createdAt: 100 }, [], frame), 0.5, "older than every entry: before them all, not after a timeless one");
});

test("the frame paints every cell: fills are solid, resets re-arm the surface, and the chrome is exact to its width", async () => {
  const { Fill, margin } = await import("../dist/ui/frame.js");
  const { fillLine } = await import("../dist/ui/tokens.js");
  const { HeaderView, FooterView } = await import("../dist/ui/chrome.js");

  const fill = new Fill("#06080b", () => 7);
  const lines = fill.render(12);
  assert.equal(lines.length, 7, "as tall as the screen; the layout clips it to its room");
  for (const line of lines) assert.equal(visibleWidth(line), 12);
  assert.equal(fill.render(12), lines, "cached while the size is unchanged");

  // The editor's cursor ends in a full reset; without re-arming, the rest of the row would be the terminal's.
  const withCursor = fillLine("ab\x1b[7mc\x1b[0mdef", 10, "#131a23");
  const bg = withCursor.slice(0, withCursor.indexOf("a"));
  assert.ok(bg.startsWith("\x1b[48"), "the row begins on the surface");
  assert.ok(withCursor.includes(`\x1b[0m${bg}`), "a full reset is followed by the surface again");

  assert.ok(margin.wide({ width: 120, height: 40 }) && !margin.narrow({ width: 120, height: 40 }));
  assert.ok(margin.narrow({ width: 80, height: 40 }) && !margin.wide({ width: 80, height: 40 }));
  assert.ok(!margin.wide({ width: 50, height: 40 }) && !margin.narrow({ width: 50, height: 40 }), "no margin on a very small terminal");
  assert.ok(margin.edge({ width: 80, height: 24 }) && !margin.gap({ width: 80, height: 24 }), "the breathing rows wait for rows to spare");

  const header = new HeaderView({
    project: "a-very-long-project-name-that-must-be-cut-to-fit-the-zone-it-has",
    modelLabel: "llama-swap/model",
    session: { generation: "gen-7b21ee", state: { contextWindow: 32_768, readOnly: true, paused: false } },
    view: "chat",
    layer: "context",
    running: true,
    windowUnknown: false,
  });
  for (const width of [40, 70, 120]) {
    const [line] = header.render(width);
    assert.equal(visibleWidth(line), width, `header at ${width}`);
    assert.ok(line.startsWith("\x1b[48"), "the header is painted from its first cell");
  }
  const footer = new FooterView(() => [{ key: "^x", label: "stop" }, { key: "^p", label: "palette" }]);
  const [keys] = footer.render(60);
  assert.equal(visibleWidth(keys), 60);
  assert.ok(plain(keys).startsWith(" ^x"), "the key bar is inset one cell");
});

test("the frame's stacks are laid out once per frame: a long pane is not re-rendered at every level of nesting", async () => {
  const { Row, Column } = await import("../dist/ui/frame.js");
  const { renderLayoutFrame } = await import("../node_modules/@earendil-works/pi-tui/dist/layout.js");
  // Frames are requested for every chunk the model streams, and the context bar
  // is repainted by them; a layout that composites the whole transcript again at
  // every nesting level made each frame ~50x slower and the bar lag the stream.
  const spy = {
    calls: 0,
    invalidate() {},
    render(width) {
      this.calls += 1;
      return Array.from({ length: 400 }, () => "x".repeat(width));
    },
  };
  const inner = new Row([{ component: new Row([{ component: new Column([{ component: spy, basis: 0, grow: 1 }]), basis: 0, grow: 1 }]), basis: 0, grow: 1 }]);
  const frame = renderLayoutFrame(new Column([{ component: inner, basis: 0, grow: 1 }]), 80, 24, () => {});
  assert.equal(spy.calls, 1, "rendered once, by the layout pass");
  assert.equal(frame.lines.length, 24);
});
