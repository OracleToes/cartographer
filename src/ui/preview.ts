/**
 * What the workspace looks like (§8), as text.
 *
 * The TUI is a terminal program: there is no screenshot of it, and a design
 * that cannot be looked at cannot be judged. So the drawing lives here, once,
 * and both the probe (`npm run ui`) and this file's own tests render it. It is
 * not a mock of the app — it is the same palette, the same commands and the
 * same components the app mounts, handed the state a session would hand them.
 *
 * Two frames: the transcript with the agent at work, and the archive layer
 * swapped in over the same workspace (§3.3).
 */
import { HeaderView, FooterView } from "./chrome.js";
import { Registry, type Command } from "./commands.js";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

import { TokenBarView, type ContextBarState } from "./context-bar.js";
import { Sidebar } from "./sidebar.js";
import { TranscriptView } from "./transcript.js";
import { ArchiveView } from "./archive-view.js";
import { ContextView, type ContextViewData } from "./context-view.js";
import { TreeView } from "./tree-view.js";
import { HelpPanel, type HelpExtra } from "./help-panel.js";
import { Palette } from "./palette.js";
import { bandLine, canvasLine, chromeLine, padLine, tokens, visibleWidth } from "./tokens.js";
import { sidebarWidth } from "./sidebar.js";
import { emptyBrain } from "../domain/records.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The transcript as it sits in the working column: a seam under the header, the
 * entries, and the context's frame. Only the preview needs the frame, because
 * only the preview draws without an `Editor`.
 */
class PreviewTranscript extends TranscriptView {
  render(width: number): string[] {
    const top = `${tokens.rule("─")}${tokens.faint(" message ")}${tokens.rule("─".repeat(Math.max(0, width - 10)))}`;
    const bottom = tokens.rule("─".repeat(width));
    return [...super.render(width), "", top, ` ${tokens.faint("type to work · ⏎ sends · ⇧⇥ changes how it lands")}`, bottom];
  }
}

/** Every line exactly `width` cells: a frame that does not is a frame that lies about the layout. */
export const frame = (lines: string[], width: number): string => {
  const body = lines.map((line) => {
    const clipped = line.length === 0 ? "" : line;
    const pad = Math.max(0, width - visibleWidth(clipped));
    return pad === 0 ? clipped : `${clipped}${" ".repeat(pad)}`;
  });
  return body.join("\n");
};

export interface PreviewOptions {
  width?: number;
  /** Show the archive layer instead of the transcript. */
  archive?: boolean;
}

/** The commands the preview draws its footer from: the same set the app registers, without the effects. */
function previewRegistry(): Registry {
  const noop = () => undefined;
  const commands: Command[] = [
    { id: "stop", group: "the run", label: "stop", key: "ctrl+x", run: noop, available: () => true },
    { id: "pause", group: "the run", label: "pause the run", key: "ctrl+v", run: noop, available: () => true },
    { id: "send-mode", group: "the run", label: "send mode: steer", key: "shift+tab", run: noop, available: () => true },
    { id: "fold", group: "the transcript", label: "fold the cards", key: "ctrl+e", run: noop, available: () => true },
    { id: "jump", group: "anywhere", label: "jump", key: "ctrl+o", run: noop, available: () => true },
    { id: "palette", group: "anywhere", label: "palette", key: "ctrl+p", run: noop, available: () => true },
    { id: "sidebar", group: "the workspace", label: "sidebar", key: "ctrl+h", run: noop, available: () => true },
    { id: "compose", group: "the message", label: "write the message in your editor", key: "ctrl+g", run: noop, available: () => true },
    { id: "ctrl-c", group: "the message", label: "clear the line, twice to leave", key: "ctrl+c", run: noop, available: () => true },
  ];
  return new Registry(commands);
}

export function previewTranscript(width = 110): string {
  const header = new HeaderView({
    project: "cartographer",
    modelLabel: "llama-swap/ByteShape",
    session: { generation: "gen-7b21ee", state: { contextWindow: 32_768, readOnly: false, paused: false } },
    view: "chat",
    layer: "context",
    running: true,
    windowUnknown: false,
  });
  const sidebar = new Sidebar();
  sidebar.setCounts({
    chat: 9,
    contextTokens: 18_430,
    atlas: 6,
    ledger: 4,
    marked: {},
    stale: {},
    staleTotal: 0,
    treeDirs: 4,
    treeFiles: 22,
    archive: 3,
    archivePinned: 1,
  });
  sidebar.setActiveBook("chat");

  const transcript = new PreviewTranscript();
  transcript.setEntries([
    { kind: "person", text: "the collapse still rebuilds from the brain but the transcript loses the tool cards. look at how the cards are keyed.", handle: "U1" },
    {
      kind: "agent",
      text: "Found it. The cards were keyed by the live attempt, so a rebuild replaced them instead of folding them. They are keyed by the context entry now.",
      recordId: "12",
      handle: "C1",
    },
    { kind: "reasoning", id: "r1", handle: "X1", text: "The live cards used the attempt number in their id. A rebuild after the round landed produced different ids, so the fold state was discarded and the card came back open. Keying by the entry and the part index makes the id stable across the boundary." },
    { kind: "tool", id: "t1", handle: "X2", name: "read", args: "path: src/ui/transcript.ts\noffset: 120\nlimit: 40" },
    // The edit's result answers the edit's call, so it carries the same handle.
    { kind: "tool", id: "t2", handle: "X3", name: "edit", args: "path: src/ui/transcript.ts\nold: live-<attempt>\nnew: ctx-<entry>-<part>", output: "applied 2 replacements to src/ui/transcript.ts" },
    { kind: "status", text: "collapsed and rebuilt from the Brain (7b21ee → 9d40c1)" },
    { kind: "output", id: "o1", handle: "X4", text: "Both views agree now: the footer draws the keys that are live, f1 lists every one of them, and the palette is the long tail." },
  ]);
  transcript.setLive([
    { kind: "reasoning", id: "live-2-0", live: true, handle: "X5", text: "Checking the fold state survives the boundary by running the view tests, then reading the bar's figures against the server's own count." },
  ]);

  const footer = new FooterView(() =>
    previewRegistry().footer().map((command) => ({
      key: command.key === "shift+tab" ? "⇧⇥" : `^${(command.key ?? "").slice(-1)}`,
      label: command.label,
    })),
  );

  const barState: ContextBarState = {
    session: { state: { contextWindow: 32_768, lastReportedInput: 16_240, toolWorkAtLastReport: 1_100 } },
    parts: { system: 6_400, transcript: 4_200, toolWork: 1_900 },
  };

  // The bands, in the order the app stacks them: header, the panes (sidebar
  // beside the working area, prompt in it), key bar, context bar.
  const rows = workspace(header, sidebar.render(sidebarWidth), (mainWidth) => transcript.render(mainWidth), width);
  return [
    ...rows,
    frame(footer.render(width), width),
    frame(new TokenBarView(barState).render(width), width),
  ].join("\n");
}

export function previewArchive(width = 110): string {
  const header = new HeaderView({
    project: "cartographer",
    modelLabel: "llama-swap/ByteShape",
    session: { generation: "gen-9d40c1", state: { contextWindow: 32_768, readOnly: false, paused: false } },
    view: "chat",
    layer: "archive",
    running: false,
    windowUnknown: false,
  });
  const sidebar = new Sidebar();
  sidebar.setCounts({
    chat: 9,
    contextTokens: 18_430,
    atlas: 6,
    ledger: 4,
    marked: {},
    stale: {},
    staleTotal: 0,
    treeDirs: 4,
    treeFiles: 22,
    archive: 3,
    archivePinned: 1,
  });
  sidebar.setActiveBook("chat");
  sidebar.setLayer("archive");

  const archive = new ArchiveView();
  archive.setData({
    version: 1,
    items: [
      {
        id: "1",
        layer: "record",
        record: {
          kind: "ledger",
          value: {
            id: "7",
            kind: "note",
            text: "A read result is re-read at collapse, never held from the tool call.",
            status: "open",
            answer: null,
            links: [],
            createdAt: 0,
            updatedAt: 0,
          },
        },
        sweptAtGeneration: "gen-7b21ee",
        sweptAtCollapse: 4,
        sweptAt: 3,
      },
      {
        id: "2",
        layer: "record",
        record: {
          kind: "atlas",
          value: {
            id: "3",
            title: "The Brain is the persistent record",
            text: "The context is rebuilt from it at every collapse.",
            links: [],
            attachments: [],
            createdAt: 0,
            updatedAt: 0,
          },
        },
        sweptAtGeneration: "gen-7b21ee",
        sweptAtCollapse: 4,
        sweptAt: 2,
        pinned: "user",
      },
      {
        id: "3",
        layer: "ephemeral",
        ephemeral: { kind: "toolResult", text: "grep -rn \"archive\" src/ — 41 matches across 9 files" },
        sweptAtGeneration: "gen-7b21ee",
        sweptAtCollapse: 3,
        sweptAt: 1,
        // A mark waiting for the next collapse: the row says what will happen
        // and who decided it, because a mark nobody can see reads as nothing.
        mark: { action: "restore", author: "user" },
      },
    ],
  });
  const barState: ContextBarState = {
    session: { state: { contextWindow: 32_768, lastReportedInput: 9_120, toolWorkAtLastReport: 0 } },
    parts: { system: 6_400, transcript: 1_800, toolWork: 900 },
  };

  const sidebarLines = sidebar.render(sidebarWidth);
  const rows = workspace(header, sidebarLines, (mainWidth) => archive.render(mainWidth), width);
  const footer = new FooterView(() => [
    { key: "↑↓", label: "move" },
    { key: "p", label: "pin" },
    // A mark, not the act: restore and delete both wait for the collapse unless
    // the person applies them now (`!`, then the key), and the footer says so (§4.1).
    { key: "r", label: "mark for restore" },
    { key: "d", label: "mark for delete" },
    { key: "!", label: "apply now" },
    { key: "^t", label: "context layer" },
  ]);
  return [...rows, frame(footer.render(width), width), frame(new TokenBarView(barState).render(width), width)].join("\n");
}

/** The context, over a small but complete Brain: all three sections, real handles. */
export function previewContext(width = 110): string {
  const brain = emptyBrain();
  brain.handles = {
    counters: { A: 2, L: 1, C: 1 },
    entries: [
      { kind: "atlas", id: "a1", handle: "A1", timestamp: 0 },
      { kind: "atlas", id: "a2", handle: "A2", timestamp: 1 },
      { kind: "ledger", id: "l1", handle: "L1", timestamp: 2 },
      { kind: "chat", id: "c1", handle: "C1", timestamp: 3 },
    ],
  };
  brain.atlas.push(
    { id: "a1", title: "The Brain is the persistent record", text: "The context is rebuilt from it at every collapse.", links: [], attachments: [{ kind: "file", path: "src/domain/brain.ts" }], createdAt: 0, updatedAt: 0 },
    { id: "a2", title: "The context bar is the server's own capacity", text: "Not a budget: a picture.", links: [], attachments: [], createdAt: 1, updatedAt: 1 },
  );
  brain.ledger.push({ id: "l1", kind: "goal", text: "Rebuild the workspace UI in Posting's idiom", status: "open", answer: null, createdAt: 2, updatedAt: 2 });
  brain.chat.push({ id: "c1", author: "agent", text: "The context view is the prefill now: head, body, tail.", createdAt: 3, updatedAt: 3 });
  // One pinned item, so the preview shows the head carrying what the person
  // kept in front of the agent rather than only the Brain's own records.
  brain.ephemera.push({
    id: "gen-9d40c1:12:t0",
    text: "The archive is the person's, and the agent never learns it exists.",
    kind: "reasoning",
    createdAt: 4,
    pinned: "user",
  });
  const data: ContextViewData = {
    brain,
    person: "OracleToes",
    systemPrompt: "You are Carto: the working attention on one project, kept for OracleToes.\nYour plain text is your own thinking; it reaches no one.",
    projectionText: "Atlas — what you understand about the project\nA1 The Brain is the persistent record — 1970-01-01T00:00:00.000Z\n  The context is rebuilt from it at every collapse.\n  attach: src/domain/brain.ts\nA2 The context bar is the server's own capacity — 1970-01-01T00:00:00.001Z\n  Not a budget: a picture.\n\nLedger — what you are working on\nL1 [goal · open] Rebuild the workspace UI in Posting's idiom — 1970-01-01T00:00:00.002Z",
    tools: [
      { name: "chat", description: "Say something to OracleToes. This is the only channel that reaches them.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "read", description: "Read a file: its handle from the tree, or a path inside the project.", parameters: { type: "object", properties: { path: { type: "string" } } } },
    ],
    transcriptMessages: [
      { id: 2, role: "user", text: "the context view is the prefill now, not a rail of six parts" },
    ],
    toolWorkItems: [
      { id: "3-0", kind: "reasoning", text: "The rail was a table of contents over a view that is already ordered; the order is the thing to show." },
      { id: "4-0", kind: "toolCall", name: "read", args: "path: src/ui/context-view.ts" },
      { id: "5-0", kind: "toolResult", callId: "4-0", output: "export class ContextView implements Component, Focusable {" },
      { id: "6-0", kind: "toolCall", name: "chat", args: "text: Both regions read in the order the model reads them." },
    ],
    stateBlockText:
      "<carto-state>\n[EDIT MODE]\ncontext: ~14,220 / 32,768 tokens · no provider count yet\nsession-observed writes (not exhaustive): none\nstale: nothing\nT1 tree: . (depth 2)\n  src/  24K  D1\npins:\n  P X1 · placed by OracleToes\nmarks: none\n</carto-state>",
  };
  const view = new ContextView();
  view.setData(data);
  const header = new HeaderView({
    project: "cartographer",
    modelLabel: "llama-swap/ByteShape",
    session: { generation: "gen-7b21ee", state: { contextWindow: 32_768, readOnly: false, paused: false } },
    view: "context",
    layer: "context",
    running: false,
    windowUnknown: false,
  });
  const sidebar = new Sidebar();
  sidebar.setCounts({ chat: 1, contextTokens: 14_220, atlas: 2, ledger: 1, marked: {}, stale: {}, staleTotal: 0, treeDirs: 4, treeFiles: 22, archive: 0, archivePinned: 0 });
  sidebar.setActiveBook("context");
  const footer = new FooterView(() => [
    { key: "↑↓", label: "move" },
    { key: "⏎", label: "fold" },
    { key: "⇥", label: "raw" },
    { key: "a", label: "mark archive" },
    { key: "d", label: "mark delete" },
    { key: "!", label: "apply now" },
    { key: "c", label: "collapse" },
    { key: "esc", label: "chat" },
  ]);
  const barState: ContextBarState = {
    session: { state: { contextWindow: 32_768, lastReportedInput: 13_100, toolWorkAtLastReport: 0 } },
    parts: { system: 7_200, transcript: 3_400, toolWork: 2_600 },
  };
  const rows = workspace(header, sidebar.render(sidebarWidth), (mainWidth) => view.render(mainWidth), width);
  return [...rows, frame(footer.render(width), width), frame(new TokenBarView(barState).render(width), width)].join("\n");
}

/**
 * The Tree view, over a throwaway project on disk.
 *
 * The tree reads the filesystem, so a drawn-in fixture would not be the tree the
 * app shows. This builds a small project, gives it a Brain that attaches a note
 * to one file and pins another, and renders the real view.
 */
export function previewTree(width = 110): string {
  const root = mkdtempSync(join(tmpdir(), "carto-preview-tree-"));
  const write = (path: string, text: string): void => {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text);
  };
  write("src/domain/brain.ts", "export const brain = 1;\n");
  write("src/domain/records.ts", "export const records = 1;\n");
  write("src/domain/handles.ts", "export const handles = 1;\n");
  write("src/ui/tree-view.ts", "export class TreeView {}\n");
  write("src/ui/app.ts", "export const app = 1;\n");
  write("test/tree.test.mjs", "// the tree's tests\n");
  write("README.md", "# cartographer\n");
  write("package.json", '{ "name": "carto" }\n');

  const brain = emptyBrain();
  brain.handles = {
    counters: { A: 2, L: 0, C: 0 },
    entries: [
      { kind: "atlas", id: "a1", handle: "A1", timestamp: 0 },
      { kind: "atlas", id: "a2", handle: "A2", timestamp: 1 },
    ],
  };
  brain.atlas.push(
    {
      id: "a1",
      title: "The Brain is the persistent record",
      text: "The context is rebuilt from it at every collapse, so nothing outside it survives.",
      links: ["a2"],
      attachments: [{ kind: "file", path: "src/domain/brain.ts" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "a2",
      title: "Handles are minted by what shows them",
      text: "A file's handle comes from the tree, and a file the tree does not show has no handle.",
      links: [],
      attachments: [{ kind: "file", path: "src/domain/handles.ts" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  );
  // One pinned file, so the head's promise is visible; one that is stale, so the
  // mark the agent acts on is visible too.
  brain.files.push(
    { path: "src/domain/brain.ts", pinned: "user", createdAt: 0 },
    { path: "src/ui/tree-view.ts", pinned: "agent", createdAt: 1 },
  );

  const view = new TreeView();
  view.setData({ root, anchor: { anchor: root, depth: 3 }, brain });
  // Three rows down is the first file: the pane then shows the facts for a file
  // — its handle's tool calls, the pin, the note attached to it — rather than a
  // directory's size.
  for (const key of ["j", "j", "j"]) view.handleInput(key);

  const header = new HeaderView({
    project: "cartographer",
    modelLabel: "llama-swap/ByteShape",
    session: { generation: "gen-7b21ee", state: { contextWindow: 32_768, readOnly: false, paused: false } },
    view: "tree",
    layer: "context",
    running: false,
    windowUnknown: false,
  });
  const sidebar = new Sidebar();
  sidebar.setCounts({
    chat: 1,
    contextTokens: 14_220,
    atlas: 2,
    ledger: 0,
    marked: {},
    stale: {},
    staleTotal: 0,
    treeDirs: 4,
    treeFiles: 6,
    archive: 0,
    archivePinned: 0,
  });
  sidebar.setActiveBook("tree");
  const footer = new FooterView(() => [
    { key: "↑↓", label: "move" },
    { key: "h/l", label: "fold" },
    { key: "t", label: "note" },
    { key: "f", label: "pinned" },
    { key: "/", label: "filter" },
  ]);
  const rows = workspace(header, sidebar.render(sidebarWidth), (mainWidth) => view.render(mainWidth), width);
  const barState: ContextBarState = {
    session: { state: { contextWindow: 32_768, lastReportedInput: 13_100, toolWorkAtLastReport: 0 } },
    parts: { system: 7_200, transcript: 3_400, toolWork: 2_600 },
  };
  rmSync(root, { recursive: true, force: true });
  return [...rows, frame(footer.render(width), width), frame(new TokenBarView(barState).render(width), width)].join("\n");
}

export function previewHelp(width = 88): string {
  const panel = new HelpPanel(previewRegistry().all(), (): HelpExtra[] => [
    { group: "type it", key: "/copy", label: "copy the transcript" },
    { group: "type it", key: "/copy-session", label: "a full diagnostic dump" },
  ]);
  return frame(panel.render(width), width);
}

export function previewPalette(width = 64): string {
  const palette = new Palette([
    { id: "jump", group: "anywhere", label: "jump to a view", key: "ctrl+o", run: () => undefined },
    { id: "palette", group: "anywhere", label: "palette", key: "ctrl+p", run: () => undefined },
    { id: "collapse", group: "the run", label: "collapse now", run: () => undefined },
    { id: "send", group: "the run", label: "send: steer", run: () => undefined },
    { id: "archive", group: "the workspace", label: "Layer: the archive", run: () => undefined },
    { id: "readonly", group: "the workspace", label: "Mode: read only", run: () => undefined },
  ]);
  // The input renders with a software cursor marker; a frame of text has no cursor.
  return frame(
    palette.render(width).map((line) => line.replaceAll(CURSOR_MARKER, "")),
    width,
  );
}

/**
 * The sidebar and the working column, stacked the way the app's HStack lays them
 * out: each line is the pane's line, and the panes are padded to their widths.
 */
/**
 * The app's frame as text: the header across the top on the chrome, a seam of
 * chrome, then the sidebar's panel and the working pane side by side with a
 * column of chrome between them. Both panes are painted to the foot of the
 * tallest, as the app's `Fill` does.
 */
function workspace(header: HeaderView, sidebarLines: string[], main: (width: number) => string[], width: number): string[] {
  const mainWidth = width - sidebarWidth - 1;
  const mainLines = main(mainWidth);
  const count = Math.max(sidebarLines.length, mainLines.length);
  const rows: string[] = [...header.render(width), chromeLine("", width)];
  for (let index = 0; index < count; index += 1) {
    const left = sidebarLines[index] ?? bandLine("", sidebarWidth);
    const right = mainLines[index];
    const rightCell = right !== undefined && right.startsWith("\u001b[48") ? padLine(right, mainWidth) : canvasLine(right ?? "", mainWidth);
    rows.push(frame([left], sidebarWidth) + chromeLine("", 1) + rightCell);
  }
  return rows;
}

/** Every preview, for `npm run ui` and for the tests. */
export const previews = (width = 110): Record<string, string> => ({
  transcript: previewTranscript(width),
  context: previewContext(width),
  tree: previewTree(width),
  archive: previewArchive(width),
  help: previewHelp(88),
  palette: previewPalette(64),
});

export { stripTerminalSequences as plain } from "@earendil-works/pi-tui";
