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
import { TokenBarView, type ContextBarState } from "./context-bar.js";
import { Sidebar } from "./sidebar.js";
import { TranscriptView } from "./transcript.js";
import { ArchiveView } from "./archive-view.js";
import { HelpPanel, type HelpExtra } from "./help-panel.js";
import { Palette } from "./palette.js";
import { tokens, visibleWidth } from "./tokens.js";

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * The transcript as it sits in the working column: a seam under the header, the
 * entries, and the prompt's frame. Only the preview needs the frame, because
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
    { id: "send-mode", group: "the run", label: "send mode: steer", key: "shift+tab", run: noop, available: () => true },
    { id: "fold", group: "the transcript", label: "fold the cards", key: "ctrl+e", run: noop, available: () => true },
    { id: "jump", group: "anywhere", label: "jump", key: "ctrl+o", run: noop, available: () => true },
    { id: "palette", group: "anywhere", label: "palette", key: "ctrl+p", run: noop, available: () => true },
    { id: "sidebar", group: "the workspace", label: "sidebar", key: "ctrl+h", run: noop, available: () => true },
    { id: "quit", group: "anywhere", label: "quit", key: "ctrl+c", run: noop, available: () => true },
  ];
  return new Registry(commands);
}

export function previewTranscript(width = 110): string {
  const header = new HeaderView({
    project: "cartographer",
    modelLabel: "llama-swap/ByteShape",
    session: { generation: "gen-7b21ee", state: { contextWindow: 32_768, readOnly: false } },
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
    pinned: { chat: 2, atlas: 1 },
    marked: {},
    stale: {},
    staleTotal: 0,
    archive: 3,
    archivePinned: 1,
  });
  sidebar.setActiveBook("chat");

  const transcript = new PreviewTranscript();
  transcript.setEntries([
    { kind: "person", text: "the collapse still rebuilds from the brain but the transcript loses the tool cards. look at how the cards are keyed." },
    {
      kind: "agent",
      text: "Found it. The cards were keyed by the live attempt, so a rebuild replaced them instead of folding them. They are keyed by the context entry now.",
      recordId: "12",
      pinned: "user",
    },
    { kind: "reasoning", id: "r1", text: "The live cards used the attempt number in their id. A rebuild after the round landed produced different ids, so the fold state was discarded and the card came back open. Keying by the entry and the part index makes the id stable across the boundary." },
    { kind: "tool", id: "t1", name: "read", args: "path: src/ui/transcript.ts\noffset: 120\nlimit: 40" },
    { kind: "tool", id: "t2", name: "edit", args: "path: src/ui/transcript.ts\nold: live-<attempt>\nnew: ctx-<entry>-<part>" },
    { kind: "status", text: "collapsed and rebuilt from the Brain (7b21ee → 9d40c1)" },
    { kind: "output", id: "o1", text: "Both views agree now: the footer draws the keys that are live, f1 lists every one of them, and the palette is the long tail." },
  ]);
  transcript.setLive([
    { kind: "reasoning", id: "live-2-0", live: true, text: "Checking the fold state survives the boundary by running the view tests, then reading the bar's figures against the server's own count." },
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

  const mainWidth = width - 24;
  const headerLines = header.render(mainWidth);
  const sidebarLines = sidebar.render(24);
  const transcriptLines = transcript.render(mainWidth);
  // The header belongs to the working column, and the sidebar runs beside it
  // from the very top: the pane is the height of the screen, not of the books.
  const column = [...headerLines, ...transcriptLines];
  const rows = beside(sidebarLines, 24, column, mainWidth);
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
    session: { generation: "gen-9d40c1", state: { contextWindow: 32_768, readOnly: false } },
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
    pinned: { chat: 2 },
    marked: {},
    stale: {},
    staleTotal: 0,
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
      },
    ],
  });
  const barState: ContextBarState = {
    session: { state: { contextWindow: 32_768, lastReportedInput: 9_120, toolWorkAtLastReport: 0 } },
    parts: { system: 6_400, transcript: 1_800, toolWork: 900 },
  };

  const sidebarLines = sidebar.render(24);
  const archiveLines = [...header.render(width - 24), "", ...archive.render(width - 24)];
  const rows = beside(sidebarLines, 24, archiveLines, width - 24);
  const footer = new FooterView(() => [
    { key: "↑↓", label: "move" },
    { key: "p", label: "pin" },
    { key: "r", label: "restore" },
    { key: "x", label: "delete for good" },
    { key: "^t", label: "context layer" },
  ]);
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
    palette
      .render(width)
      .map((line) => line.replace(/\x1b_pi:[a-z]+\x07/g, ""))
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, (escape) => escape)),
    width,
  );
}

/**
 * The sidebar and the working column, stacked the way the app's HStack lays them
 * out: each line is the pane's line, and the panes are padded to their widths.
 */
function beside(left: string[], leftWidth: number, right: string[], rightWidth: number): string[] {
  const rows: string[] = [];
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    rows.push(frame([left[index] ?? ""], leftWidth) + frame([right[index] ?? ""], rightWidth));
  }
  return rows;
}

/** Every preview, for `npm run ui` and for the tests. */
export const previews = (width = 110): Record<string, string> => ({
  transcript: previewTranscript(width),
  archive: previewArchive(width),
  help: previewHelp(88),
  palette: previewPalette(64),
});

export { plain };
