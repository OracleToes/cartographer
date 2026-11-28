import { personChatBindings, userText } from "../domain/chat-identity.js";
/**
 * The workspace (§8).
 *
 * Posting's anatomy, in Carto's names: one header line that says where you are,
 * a full-height sidebar on the left, one working area in front, one context bar
 * spanning the bottom, and one footer that lists the keys that work *here*.
 * Everything the person can press is declared once, in `commands.ts`; the
 * footer, `f1`, and `^p` are all drawn from it, so no two of them can disagree.
 *
 * The books are layers of the same workspace, not separate screens:
 *
 * - the **transcript** is the boot view and the only place you type;
 * - the **atlas** and the **ledger** are the Brain, read, and marked from there;
 * - the **context** is the prompt the model reads, and the only place surgery happens;
 * - the **archive** is a layer over the working area, toggled by `ctrl+t`, the
 *   sidebar's layer row, or the palette (§3.3) — it is the person's, and no
 *   handle names it to the agent.
 *
 * The context bar is the one thing that is never not there: one row, spanning
 * the whole width, its width the server's own capacity.
 *
 * State is one explicit value; behaviour is functions over it (§8). Pi
 * performs; Carto adds only the composition.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { snapshotPaths } from "../runtime/projection-files.js";
import { WIPE_REQUESTED } from "../runtime/paths.js";
import { assertPinnableFile } from "../runtime/workspace.js";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EditableRecord } from "../domain/record-editor.js";
import type { ArchivedItem } from "../domain/archive.js";
import { archivedEphemeralText, editArchivedEphemeral as validateArchivedEphemeralEdit } from "../domain/archive-editor.js";

import {
  Editor,
  ProcessTerminal,
  TuiAltScreen,
  type Component,
  type OverlayHandle,
  type ScrollView,
} from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ConversationTranscript, LiveDoc, type LiveState } from "@earendil-works/pi-durable";

import {
  applyOmitNow,
  applyRecordActionNow,
  readLiveWorkEdit,
  editLiveWork,
  readLiveChatEdit,
  editLiveChat,
  chatRecordForLiveWork,
  closeLiveSession,
  collapseLiveSession,
  interruptRun,
  openLiveSession,
  setProjectModes,
  resumeSession,
  sessionTranscript,
  submitInput,
  switchSessionModel,
  togglePause,
  waitForRunEnd,
  type LiveSession,
  type LiveSessionOptions,
} from "../runtime/live-session.js";
import type { ModelRef } from "../runtime/config.js";
import { formatModelRef, indexModels, listIndexedModels, resolveIndexedModel } from "../runtime/model-catalog.js";
import { applyCapacityRefresh } from "../runtime/headless.js";
import { createTools } from "../runtime/tools.js";
import {
  createJobTable,
  onJobsChange,
  sendJob,
  snapshotJobs,
  startJob,
  stopAllJobs,
  stopJob,
  summarizeJobs,
} from "../runtime/jobs.js";
import { ephemeralItemId, generationPaths, readGenerationEphemera, refreshFreshness, rewriteHeadSnapshot } from "../runtime/collapse.js";
import { formatArchiveSummary, formatCollapseHistory, readCollapseLog } from "../runtime/collapse-log.js";
import { restoreEphemeral } from "../runtime/live-session.js";
import { bashTool as cartoBashTool, cartoInstructions, liveStaleMarks, renderLiveStateBlock } from "../runtime/carto-extension.js";
import { projectTreeBlock, projectTreeView, type TreeEntry } from "../runtime/project-tree.js";
import { isMarkerMessage, splitContextMessages, stripStateBlocks, STATE_BLOCK_MARKER, type MessageLike as BlockMessageLike } from "../domain/state-block.js";
import type { BrainStore } from "../runtime/brain-store.js";
import { handleOf } from "../domain/handles.js";

import { FooterView, HeaderView, nextSendMode, sendModeLabel, type Layer, type SendMode, type ViewMode } from "./chrome.js";
import { Registry, copySelectionCommand, copySlashCommand, stopCommand, type Command } from "./commands.js";
import { RunActivity } from "./run-activity.js";
import { TokenBarView, type ContextBarState } from "./context-bar.js";
import { copyWithFallback, createSelectionCopier, describeFallback } from "./clipboard.js";
import { composeInEditor, ctrlC, editSourceFile, CTRL_C_ARM_WINDOW_MS, type EditorOutcome } from "./compose.js";
import { flattenEntry } from "./dump.js";
import { HelpPanel, keyText, type HelpExtra } from "./help-panel.js";
import { JumpOverlay, JUMP_TARGETS } from "./jump.js";
import { ModelPicker } from "./model-picker.js";
import { Palette, SourceEditConfirmation, WipeConfirmation, selectTheme, type PaletteCommand } from "./palette.js";
import { Sidebar, sidebarWidth, type BookKind, type SidebarCounts } from "./sidebar.js";
import { TranscriptView, createStatusNotifier, formatToolArgs, frozenTranscript, isCard, orderTranscript, type CardEntry, type TranscriptEntry } from "./transcript.js";
import { AtlasView } from "./atlas-view.js";
import { LedgerView } from "./ledger-view.js";
import { JobsView } from "./jobs-view.js";
import { ContextView, type ContextDialogueMessage, type ContextToolItem, type ContextWorkItem } from "./context-view.js";
import { ArchiveView } from "./archive-view.js";
import { TreeView } from "./tree-view.js";
import { rawPalette, surfaceLine, tokens } from "./tokens.js";
import { Column, Fill, Inset, margin, PaneScrollView, Row, type Viewport } from "./frame.js";
import { promptHandles, promptItemsOf, toolRowHandle, type PromptHandles, type PromptItem } from "./prompt-handles.js";
import { enablePromptPathCompletion } from "./prompt-completion.js";

export interface CartoTuiOptions extends LiveSessionOptions {
  /** When true, the provider catalog is re-discovered before boot and after every settled run (llama-swap advertises capacity once the model has loaded). */
  refreshCapacity?: boolean;
  /** Called after the person switches models in the UI so the host can persist or track the selection. */
  onModelChange?: (model: ModelRef) => Promise<void> | void;
  /** Host notice shown when a wiped workspace reopens. */
  startupNotice?: string;
}

interface PendingItem {
  text: string;
  at: number;
  mode: SendMode;
}

interface TuiState {
  session: LiveSession;
  model: ModelRef;
  sendMode: SendMode;
  view: ViewMode;
  /** The layer over the working area. `archive` is the person's, and only the person's (§3.3). */
  layer: Layer;
  /** Submissions and observed Pi runs, including autonomous ones. */
  activity: RunActivity;
  readonly running: boolean;
  /** The person's submitted lines awaiting placement in the context, in order. */
  pending: PendingItem[];
  collapsing: boolean;
  /** Why the agent stopped collapsing by itself; shown in the transcript until the person speaks. */
  notes: string[];
  /** Counts collapses, so a submission one withdrew does not report itself as a failure. */
  collapseEpoch: number;
  sidebarVisible: boolean;
  overlayOpen: boolean;
  overlayHandle: OverlayHandle | undefined;
  /** Live watch on the in-flight partial (`pi.live`); stopped at collapse and shutdown, re-armed on the new session. */
  liveWatch: { stop(): Promise<unknown> } | undefined;
  /** Cheap change signature so the 1.5s timer does not bust the render cache when nothing moved. */
  sig: string;
  /**
   * When the last Ctrl-C found the line empty, if it did. A second press inside
   * the window leaves; anything else lets the arming lapse (see `compose.ts`).
   */
  ctrlCArmedAt: number | undefined;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const suffix = (generation: string): string => generation.slice(-6);

function countSidebar(
  brainState: Awaited<ReturnType<BrainStore["read"]>>,
  root: string,
  contextTokens: number = 0,
  archive?: { total: number; pinned: number },
  tree?: { anchor: string; depth: number; limit?: number; offset?: number },
  jobs?: { total: number; unread: number },
): SidebarCounts {
  const marks = liveStaleMarks(brainState, root);
  const stale: Partial<Record<"atlas" | "ledger" | "chat" | "context", number>> = {};
  for (const mark of marks) {
    if (mark.kind === "atlas") {
      stale.atlas = (stale.atlas ?? 0) + 1;
    }
  }
  const marked: Partial<Record<BookKind, number>> = {};
  for (const record of brainState.chat) if (record.mark !== undefined) marked.chat = (marked.chat ?? 0) + 1;
  for (const node of brainState.atlas) if (node.mark !== undefined) marked.atlas = (marked.atlas ?? 0) + 1;
  for (const entry of brainState.ledger) if (entry.mark !== undefined) marked.ledger = (marked.ledger ?? 0) + 1;
  // The tree's figures are the rows the view shows, counted from the same
  // projection it renders, so the sidebar and the pane cannot disagree.
  let treeDirs = 0;
  let treeFiles = 0;
  if (tree !== undefined) {
    const projection = projectTreeView(root, tree.anchor, tree.depth, brainState, tree);
    const walk = (entry: TreeEntry, level: number): void => {
      if (level > projection.depth) return;
      for (const child of entry.children ?? []) {
        if (child.directory) treeDirs += 1;
        else treeFiles += 1;
        walk(child, level + 1);
      }
    };
    walk(projection.entry, 1);
  }
  return {
    chat: brainState.chat.length,
    jobs: jobs?.total ?? 0,
    jobsUnread: jobs?.unread ?? 0,
    contextTokens,
    atlas: brainState.atlas.length,
    ledger: brainState.ledger.length,
    marked,
    stale,
    staleTotal: marks.length,
    treeDirs,
    treeFiles,
    archive: archive?.total ?? 0,
    archivePinned: archive?.pinned ?? 0,
  };
}

interface ContextEntryLike {
  id?: number;
  kind?: string;
  data?: unknown;
  model?: unknown;
  partKeys?: readonly string[] | undefined;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  timestamp?: number;
  /** pi-ai's stop reason for the landed assistant turn: stop, length, toolUse, error, aborted… */
  stopReason?: string;
}

/** The call a result answers, if the message says. */
function toolCallIdOf(message: MessageLike): string | undefined {
  const id = (message as { toolCallId?: unknown }).toolCallId;
  return typeof id === "string" ? id : undefined;
}

function messageOf(entry: ContextEntryLike): MessageLike | undefined {
  if (!Array.isArray(entry.model) || entry.model.length === 0) return undefined;
  const message = entry.model[0];
  return message !== null && typeof message === "object" ? (message as MessageLike) : undefined;
}

function timestampOf(message: MessageLike): number {
  return typeof message.timestamp === "number" ? message.timestamp : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Tool arguments pretty-printed for the card body; a partial object stringifies to the partial JSON, never a throw. */
function prettyArgs(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2) ?? "{}";
  } catch {
    return String(value);
  }
}

/**
 * The in-flight partial (`pi.live`) as foldable cards: the streaming
 * thinking/text blocks in content order, then the current round's tool slots.
 */
function liveCardsOf(live: LiveState | undefined, handles: PromptHandles): CardEntry[] {
  const cards: CardEntry[] = [];
  if (live === undefined) return cards;
  const attempt = live.generation?.attempt ?? 0;
  const handleOf = (key: string | number): { handle?: string } => {
    const handle = handles.ephemeral(String(key));
    return handle === undefined ? {} : { handle };
  };
  const slots = new Map((live.tools ?? []).map((slot) => [slot.callId, slot]));
  const seenCalls = new Set<string>();
  const message = live.generation?.message as { content?: unknown } | undefined;
  if (message !== undefined && Array.isArray(message.content)) {
    (message.content as unknown[]).forEach((part, index) => {
      if (!isRecord(part)) return;
      const id = `live-${attempt}-${index}`;
      if (part.type === "thinking" && typeof part.thinking === "string") {
        if (part.thinking.length > 0) cards.push({ kind: "reasoning", id, live: true, text: part.thinking, ...handleOf(id) });
      } else if (part.type === "text" && typeof part.text === "string") {
        if (part.text.length > 0) cards.push({ kind: "output", id, live: true, text: part.text, ...handleOf(id) });
      } else if (part.type === "toolCall") {
        const callId = typeof part.id === "string" ? part.id : undefined;
        if (callId !== undefined) seenCalls.add(callId);
        const slot = callId === undefined ? undefined : slots.get(callId);
        const name = typeof part.name === "string" ? part.name : (slot?.name ?? "");
        const rawArgs = typeof (part as Record<string, unknown>).rawArguments === "string"
          ? ((part as Record<string, unknown>).rawArguments as string)
          : undefined;
        const args = rawArgs ?? formatToolArgs(part.arguments, name);
        const status = slot?.status ?? (name.length > 0 ? "running" : "pending");
        cards.push({ kind: "tool", id, live: true, name, args, status, ...handleOf(callId ?? id) });
      }
    });
  }
  for (const slot of live.tools ?? []) {
    if (seenCalls.has(slot.callId)) continue;
    const output = typeof slot.output === "string" && slot.output.length > 0 ? slot.output : undefined;
    cards.push({
      kind: "tool",
      id: `livetool-${slot.callId}`,
      live: true,
      name: slot.name,
      args: "",
      // A slot whose call has not streamed into the message yet is still the
      // call it is, so it is numbered by the call's id like any other.
      ...handleOf(slot.callId),
      ...(output === undefined ? {} : { output }),
      status: slot.status,
    });
  }
  return cards;
}

/**
 * The numbering for a generation, as the transcript shows it: the prompt's
 * landed items, then the in-flight partial after them, numbered once. A card in
 * flight therefore takes the next handle rather than restarting at `X1`, which
 * is what the person sees in the two views at the same moment.
 */
function generationHandles(live: LiveState | undefined, landed: readonly PromptItem[], headEphemera: number): PromptHandles {
  if (live === undefined) return promptHandles(landed, headEphemera);
  const partial: PromptItem[] = [];
  const content = (live.generation?.message as { content?: unknown } | undefined)?.content;
  if (Array.isArray(content)) {
    content.forEach((part, index) => {
      if (!isRecord(part)) return;
      const id = `live-${index}`;
      if (part.type === "thinking") partial.push({ kind: "reasoning", key: id });
      else if (part.type === "text") partial.push({ kind: "text", key: id });
      else if (part.type === "toolCall" && typeof part.id === "string") partial.push({ kind: "call", key: id });
    });
  }
  const streamed = new Set<string>();
  for (const part of (Array.isArray(content) ? content : []) as unknown[]) {
    if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string") streamed.add(part.id);
  }
  for (const slot of live.tools ?? []) {
    if (streamed.has(slot.callId)) continue;
    partial.push({ kind: "call", key: slot.callId });
  }
  return promptHandles([...landed, ...partial], headEphemera);
}

export async function runTui(options: CartoTuiOptions): Promise<number> {
  const brain = options.brain;
  let activeModel: ModelRef = { ...options.model };
  const refresh = async () => {
    await options.models.refresh({ providers: [activeModel.provider] }).catch(() => undefined);
  };
  if (options.refreshCapacity === true) await refresh();

  const jobs = options.jobs ?? createJobTable({ root: options.root, ...(options.now === undefined ? {} : { now: options.now }) });
  const session = await openLiveSession({ ...options, jobs });
  const state: TuiState = {
    session,
    model: activeModel,
    sendMode: "steer",
    view: "chat",
    layer: "context",
    activity: new RunActivity(),
    get running() { return this.activity.running; },
    pending: [],
    collapsing: false,
    notes: [],
    collapseEpoch: 0,
    sidebarVisible: true,
    overlayOpen: false,
    overlayHandle: undefined,
    sig: "",
    liveWatch: undefined,
    ctrlCArmedAt: undefined,
  };

  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, undefined, undefined, {
    copySelection: createSelectionCopier(),
    searchMatchStyle: tokens.searchMatch,
    searchCurrentMatchStyle: tokens.searchCurrentMatch,
    searchNavigationButtonStyle: (text, hovered) =>
      hovered ? tokens.selectedBg(tokens.accent(text)) : tokens.muted(text),
    scrollToEndIndicator: () => tokens.selectedBg(` ${tokens.accent("↓")} ${tokens.text("jump to latest")} `),
  });

  const project = basename(options.root.replace(/[/\\]+$/, ""));
  const modelLabel = () => formatModelRef(state.model);
  const sessionOptions = (): LiveSessionOptions => ({ ...options, model: state.model, jobs });
  const headerState = {
    project,
    modelLabel: modelLabel(),
    session: state.session,
    view: state.view,
    layer: state.layer,
    running: state.running,
    windowUnknown: state.session.state.contextWindow <= 0,
  };
  const header = new HeaderView(headerState);
  const barState: ContextBarState = { session: headerState.session, parts: { system: 0, transcript: 0, toolWork: 0 } };
  const tokenBar = new TokenBarView(barState);
  // Pi reports raw llama.cpp progress between durable transcript updates.
  // Repaint the bar on those events, without rebuilding the whole transcript;
  // when a cold server first answers and the window is still unknown, re-query
  // the catalog immediately so the bar populates during the first run.
  const bindTelemetry = (session: LiveSession) => {
    session.state.onTelemetry = () => tui.requestRender();
    session.state.onResponse = () => {
      if (options.refreshCapacity === true && !shutdownRequested && session === state.session && session.state.contextWindow <= 0) {
        void refreshAdvertisedWindow().catch(() => undefined);
      }
    };
  };
  bindTelemetry(state.session);
  const transcript = new TranscriptView({ project });
  const sidebar = new Sidebar(() => Math.max(0, terminal.rows - 4
    - (terminal.rows >= 20 ? 2 : 0) - (terminal.rows >= 26 ? 2 : 0)));
  const transcriptScroll = new PaneScrollView(transcript, { follow: "end", primary: true, overscroll: "chain" });
  /**
   * The prompt's frame: Posting puts the name of the thing at the top of it, so
   * the box says what it is for. One rule above, `message` in it, one rule below.
   */
  class PromptEditor extends Editor {
    /** The prompt is a raised surface: its own step, so the cells the text does not cover are not the terminal's. */
    override render(width: number): string[] {
      return super.render(width).map((line) => surfaceLine(line, width));
    }

    protected override renderTopBorder(width: number, hiddenLineCount: number): string {
      const label = " message ";
      const filler = Math.max(0, width - label.length - 1);
      const scroll = hiddenLineCount > 0 ? `↑${hiddenLineCount} ` : "";
      return `${tokens.rule("─")}${tokens.faint(` ${scroll}${label.trim()} `)}${tokens.rule("─".repeat(Math.max(0, filler - scroll.length)))}`;
    }

    protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
      const scroll = hiddenLineCount > 0 ? `↓${hiddenLineCount} ` : "";
      return tokens.rule("─".repeat(width - scroll.length)) + tokens.faint(scroll);
    }
  }

  const editorTheme = { borderColor: (line: string) => tokens.rule(line), selectList: selectTheme };
  const editor = new PromptEditor(tui, editorTheme, { paddingX: 2 });
  enablePromptPathCompletion(editor, options.root);

  const atlasView = new AtlasView();
  const ledgerView = new LedgerView();
  const jobsView = new JobsView();
  const contextView = new ContextView();
  const treeView = new TreeView();
  const archiveView = new ArchiveView();

  // Each pannable view gets its own scroll view with a dynamic-size scrollbar
  // matching its surface; Atlas, Ledger, and Jobs mount their list and detail
  // panes in independent ScrollViews on wide viewports.
  const atlasListScroll = new PaneScrollView(atlasView.listPane, { primary: false, overscroll: "contain", backgroundHex: rawPalette.panel });
  const atlasDetailScroll = new PaneScrollView(atlasView.detailPane, { primary: false, overscroll: "contain", backgroundHex: rawPalette.surface });
  const atlasNarrowScroll = new PaneScrollView(atlasView, { primary: false, overscroll: "contain" });
  atlasView.attachScrolls(atlasListScroll, atlasDetailScroll);
  atlasView.onFocus = () => tui.setFocus(atlasView);

  const ledgerListScroll = new PaneScrollView(ledgerView.listPane, { primary: false, overscroll: "contain", backgroundHex: rawPalette.panel });
  const ledgerDetailScroll = new PaneScrollView(ledgerView.detailPane, { primary: false, overscroll: "contain", backgroundHex: rawPalette.surface });
  const ledgerNarrowScroll = new PaneScrollView(ledgerView, { primary: false, overscroll: "contain" });
  ledgerView.attachScrolls(ledgerListScroll, ledgerDetailScroll);
  ledgerView.onFocus = () => tui.setFocus(ledgerView);

  const jobsListScroll = new PaneScrollView(jobsView.listPane, { primary: false, overscroll: "contain" });
  const jobsDetailScroll = new PaneScrollView(jobsView.detailPane, { primary: false, follow: "end", overscroll: "contain" });
  const jobsNarrowScroll = new PaneScrollView(jobsView, { primary: false, overscroll: "contain" });
  jobsView.attachScrolls(jobsListScroll, jobsDetailScroll);
  jobsView.onFocus = () => tui.setFocus(jobsView);
  jobsView.onChange = () => tui.requestRender();

  const contextScroll = new PaneScrollView(contextView, { primary: false, overscroll: "contain" });
  const treeScroll = new PaneScrollView(treeView, { primary: false, overscroll: "contain" });
  // A ScrollView does not follow a child's cursor, and the tree is taller than
  // the pane in any real project: keep the selected row in view, with a row of
  // context on either side rather than the cursor pinned to an edge.
  treeView.onCursorLine = (line) => {
    const viewport = treeScroll.viewportHeight;
    if (viewport <= 0) return;
    const top = treeScroll.scrollTop;
    if (line < top + 1) treeScroll.scrollTo(line - 1);
    else if (line >= top + viewport - 1) treeScroll.scrollTo(line - (viewport - 2));
  };
  const archiveScroll = new PaneScrollView(archiveView, { primary: false, overscroll: "contain" });
  archiveView.onFocus = () => tui.setFocus(archiveView);
  archiveView.onReveal = (line) => {
    const height = archiveScroll.viewportHeight;
    if (height <= 0) return;
    const top = archiveScroll.scrollTop;
    if (line < top + 1) archiveScroll.scrollTo(Math.max(0, line - 1));
    else if (line >= top + height - 1) archiveScroll.scrollTo(Math.max(0, line - height + 2));
  };

  sidebar.onSelect = (book) => void switchToView(book);
  sidebar.onToggleLayer = (layer) => void switchLayer(layer);

  const refreshSidebar = async () => {
    const brainState = await brain.read();
    const archive = await brain.readArchiveCounts().catch(() => ({ total: 0, pinned: 0 }));
    const contextTokens = barState.parts.system + barState.parts.transcript + barState.parts.toolWork;
    const jobSummaries = summarizeJobs(jobs);
    sidebar.setCounts(
      countSidebar(
        brainState,
        options.root,
        contextTokens,
        archive,
        // The same anchor and depth the `tree` tool last set: the sidebar counts
        // what the view shows, not a second tree of its own.
        state.session.state.tree,
        {
          total: jobSummaries.length,
          unread: jobSummaries.filter((job) => job.unreadLines > 0).length,
        },
      ),
    );
    sidebar.setActiveBook(state.view);
    sidebar.setLayer(state.layer);
    tui.requestRender();
  };

  await refreshSidebar();

  // A UI notice is not a message in the conversation. Pi owns the transient
  // display; repeated keypresses do not create a pile of identical flashes.
  const pushStatus = createStatusNotifier((text, duration) => tui.flash(text, duration));

  const frozenItemsOf = async (): Promise<ReadonlyMap<string, import("../domain/records.js").PinnedEphemeral>> => {
    const sidecar = await readFile(snapshotPaths(options.root, state.session.generation).sidecar, "utf8")
      .then((text) => JSON.parse(text) as { ephemeralItems?: Array<{ handle: string; item: import("../domain/records.js").PinnedEphemeral }> })
      .catch(() => ({} as { ephemeralItems?: Array<{ handle: string; item: import("../domain/records.js").PinnedEphemeral }> }));
    return sidecar.ephemeralItems === undefined ? state.session.state.headEphemera ?? new Map() : new Map(sidecar.ephemeralItems.map(({ handle, item }) => [handle, item]));
  };

  const syncContextView = async (brainState: Awaited<ReturnType<BrainStore["read"]>>) => {
    const session = state.session;
    // The generation whose store these entries are in: an item's pin id is built
    // from it, so the pin names the item the sweep will name (§3.1).
    const generation = state.session.generation;
    const productTools = createTools({
      root: options.root,
      brain,
      session: state.session.state,
      jobs,
    });
    // The tools the model is offered, as the extension registers them: `bash`
    // is the one with Carto's sentence in its description, not the package's.
    const allTools: ContextToolItem[] = [...productTools, cartoBashTool()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    // The frozen projection is the actual snapshot the model reads — the
    // exact bytes, never a re-render of the live records. The extension
    // falls back to a Brain render only when the file is missing.
    const projectionText = await readFile(state.session.markdownPath, "utf8").catch(() => undefined);

    const entries = (await sessionTranscript(state.session)) as unknown as ContextEntryLike[];
    // The payload the request would carry: the transcript, markers stripped,
    // exactly as beforeRequest builds it. The view shows this, never a guess.
    const messages = stripStateBlocks(
      entries
        .map(messageOf)
        .filter((message): message is MessageLike => message !== undefined) as unknown as BlockMessageLike[],
    );
    const headIdsForContext = await readFile(snapshotPaths(options.root, generation).sidecar, "utf8")
      .then((text) => (JSON.parse(text) as { chat?: string[] }).chat ?? brainState.chat.map((record) => record.id))
      .catch(() => brainState.chat.map((record) => record.id));
    const personBindings = personChatBindings(entries, brainState.chat, new Set(headIdsForContext));
    const transcriptMessages: ContextDialogueMessage[] = [];
    const toolWorkItems: ContextWorkItem[] = [];

    // A tool's name is not on its result, only the call's id; walking the calls
    // first is what lets a result say which tool produced it.
    const callNames = new Map<string, { name: string; path?: string }>();
    for (const entry of entries) {
      for (const message of (entry.model ?? []) as unknown[]) {
        if (!isRecord(message) || !Array.isArray(message.content)) continue;
        for (const part of message.content) {
          if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
            const args = part.arguments;
            const path =
              isRecord(args) && typeof args.path === "string" ? args.path : undefined;
            callNames.set(part.id, { name: part.name, ...(path === undefined ? {} : { path }) });
          }
        }
      }
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const message = messageOf(entry);
      if (message === undefined) continue;
      const role = message.role ?? "user";
      const id = entry.id ?? i;
      const ts = message.timestamp;
      if (role === "user") {
        const textContent = userText(message.content);
        if (textContent && !isMarkerMessage(message as BlockMessageLike)) {
          // The entry number is the order; the id may be composite for other
          // kinds, so the view is told where the body sits rather than guessing.
          transcriptMessages.push({ id, targetId: ephemeralItemId(generation, id, "x0"), entry: i, order: -1, role, text: textContent, timestamp: ts, recordId: personBindings.get(id) ?? null });
        }
      } else if (role === "assistant") {
        const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
        // Counted per entry, the same way the sweep counts them, so `t0` means
        // one thing on both sides. A tool call is named by its part: it has an
        // id of its own and does not need counting.
        for (let j = 0; j < content.length; j++) {
          const part = content[j];
          if (!isRecord(part)) continue;
          const partKey = entry.partKeys?.[j];
          if (partKey === undefined) continue;
          if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
            toolWorkItems.push({ id: ephemeralItemId(generation, id, partKey), entry: i, order: j, kind: "reasoning", text: part.thinking });
          } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
            toolWorkItems.push({ id: ephemeralItemId(generation, id, partKey), entry: i, order: j, kind: "output", text: part.text });
          } else if (part.type === "toolCall" && typeof part.name === "string") {
            // Every call is a call the model receives, `chat` included: the
            // person's view of it is Chat, the model's is a call with arguments.
            toolWorkItems.push({
              id: ephemeralItemId(generation, id, partKey),
              entry: i,
              order: j,
              kind: "toolCall",
              name: part.name,
              args: prettyArgs(part.arguments),
            });
          }
        }
      } else if (role === "toolResult") {
        const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
        // One result is one item: its text parts are one message to the model.
        const texts = content.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []));
        {
          const hasImage = content.some((part) => isRecord(part) && part.type === "image");
          const toolText = [...texts, ...(hasImage ? ["[image]"] : [])].join("\n");
          // A result names the call it answers, and the call names the tool
          // and what it was pointed at: that is how the sweep, and a pin, know
          // a result is a `read`'s and of what file (§5.5).
          const callId = toolCallIdOf(message);
          const call = callId === undefined ? undefined : callNames.get(callId);
          toolWorkItems.push({
            id: ephemeralItemId(generation, id, "r"),
            entry: i,
            // A result answers the call that precedes it, so it sits after
            // every part of the entry it answers.
            order: Number.MAX_SAFE_INTEGER,
            kind: "toolResult",
            output: toolText,
            tool: call?.name,
            ...(callId === undefined || call === undefined
              ? {}
              : { payload: { callId, ...(call.name === undefined ? {} : { tool: call.name }), ...(call.path === undefined ? {} : { path: call.path }) } }),
          });
        }
      }
    }

    // Preview the same live identities without changing request-time session state.
    const promptItems = promptItemsOf(entries, generation);
    const promptItemHandles = promptHandles(promptItems, state.session.state.headEphemeraCount ?? 0);
    const previewItems = new Map<string, import("../domain/records.js").PinnedEphemeral>();
    for (const item of promptItems) {
      if (item.item === undefined) continue;
      const handle = item.kind === "person" ? promptItemHandles.person(item.key) : item.kind === "result" ? promptItemHandles.result(item.key) : promptItemHandles.ephemeral(item.key);
      if (handle !== undefined) previewItems.set(handle, item.item);
    }
    const stateBlock = await renderLiveStateBlock(
      { root: options.root, brain, session: state.session.state, jobs, markdownPath: state.session.markdownPath },
      messages,
      undefined,
      undefined,
      previewItems,
    );

    // A timer refresh may have begun before a mark was written. Read the Brain
    // again immediately before drawing, so that stale refresh cannot hide it.
    brainState = await brain.read();
    // Numbered by the same function the transcript uses, over the same entries,
    // so a handle means one thing in both views (§5.4).
    const handles = promptItemHandles;
    // A pin the person placed before the collapse is a promise the item stays,
    // so the row says it is pinned rather than waiting to be pinned again.
    for (const item of toolWorkItems) {
      const held = brainState.ephemera.find((carried) => carried.id === String(item.id));
      if (held === undefined) continue;
      item.pinned = held.pinned;
    }
    const headEphemera = await frozenItemsOf();
    if (session !== state.session || state.collapsing) return;
    contextView.setData({
      brain: brainState,
      systemPrompt: cartoInstructions(state.session.state.person),
      person: state.session.state.person,
      // Never replace a missing frozen snapshot with today's mutable Brain.
      // Keep the last snapshot of this generation if one was read already.
      projectionText: projectionText ?? (lastFrozen?.generation === generation ? lastFrozen.text : ""),
      headEphemera,
      tools: allTools,
      transcriptMessages,
      toolWorkItems,
      handles,
      stateBlockText: stateBlock,
      // The tree's own numbering, so a pinned file is named in the head by the
      // handle the tree shows it under (§5.4) and not by a second count.
      treeHandles: Object.fromEntries(treeOf(brainState).handles),
    });
    if (sidebar.setContextSections(contextView.promptSections())) tui.requestRender();
  };

  /** The tree the person is looking at, from the session's anchor and depth. */
  const treeOf = (brainState: Awaited<ReturnType<BrainStore["read"]>>) =>
    projectTreeBlock(options.root, state.session.state.tree.anchor, state.session.state.tree.depth, brainState, state.session.state.tree);

  /** Focus follows the view: Posting's rule, and the reason the footer can be honest. */
  const focusCurrent = () => {
    if (!state.sidebarVisible) {
      // nop: the sidebar is not focusable
    }
    if (state.layer === "archive") {
      tui.setFocus(archiveView);
      return;
    }
    if (state.view === "chat") tui.setFocus(transcript.isSelecting() ? transcript : editor);
    else if (state.view === "jobs") tui.setFocus(jobsView);
    else if (state.view === "atlas") tui.setFocus(atlasView);
    else if (state.view === "ledger") tui.setFocus(ledgerView);
    else if (state.view === "tree") tui.setFocus(treeView);
    else tui.setFocus(contextView);
  };

  const switchToView = async (view: ViewMode) => {
    if (view !== "chat") transcript.stopSelecting();
    if (view !== "jobs") jobsView.exitTyping();
    state.view = view;
    headerState.view = view;
    sidebar.setActiveBook(view);
    focusCurrent();
    const brainState = await brain.read();

    if (view === "jobs") {
      jobsView.setData(snapshotJobs(jobs));
    } else if (view === "atlas") {
      atlasView.setData(brainState, liveStaleMarks(brainState, options.root));
    } else if (view === "ledger") {
      ledgerView.setData(brainState);
    } else if (view === "tree") {
      treeView.setData({ root: options.root, anchor: state.session.state.tree, brain: brainState });
    } else if (view === "context") {
      await syncContextView(brainState);
    }
    await refreshSidebar();
    tui.requestRender();
  };

  /**
   * The archive layer (§3.3): the same workspace, the person's layer instead of
   * the agent-facing one. Toggling it never re-reads the archive twice; the app
   * owns the state and both the sidebar and the header show it.
   */
  const refreshArchive = async () => {
    archiveView.setData(await brain.readArchive());
    tui.requestRender();
  };
  const switchLayer = async (layer: Layer) => {
    if (layer === "archive") transcript.stopSelecting();
    state.layer = layer;
    headerState.layer = layer;
    sidebar.setLayer(layer);
    if (layer === "archive") {
      await refreshArchive();
    } else if (state.view === "jobs") {
      jobsView.setData(snapshotJobs(jobs));
    } else if (state.view === "context") {
      await syncContextView(await brain.read());
    } else if (state.view === "atlas") {
      const fresh = await brain.read();
      atlasView.setData(fresh, liveStaleMarks(fresh, options.root));
    } else if (state.view === "ledger") {
      ledgerView.setData(await brain.read());
    } else if (state.view === "tree") {
      treeView.setData({ root: options.root, anchor: state.session.state.tree, brain: await brain.read() });
    }
    focusCurrent();
    await refreshSidebar();
    tui.requestRender();
  };
  const toggleLayer = () => switchLayer(state.layer === "archive" ? "context" : "archive");

  atlasView.onBack = () => void switchToView("chat");
  ledgerView.onBack = () => void switchToView("chat");
  jobsView.onBack = () => void switchToView("chat");
  jobsView.onStart = (command) => {
    void startJob(jobs, { command, waitMs: 0 })
      .then((res) => pushStatus(`started ${res.handle} "${res.label}"`))
      .catch((error) => pushStatus(`start failed: ${errorText(error)}`));
  };
  jobsView.onSend = (handle, input) => {
    void sendJob(jobs, { handle, input, source: "user", waitMs: 0 })
      .catch((error) => pushStatus(`send failed: ${errorText(error)}`));
  };
  jobsView.onSignal = (handle, signal) => {
    void sendJob(jobs, { handle, signal, source: "user", waitMs: 0 })
      .then(() => pushStatus(`sent ${signal} to ${handle}`))
      .catch((error) => pushStatus(`signal failed: ${errorText(error)}`));
  };
  jobsView.onStop = (handle) => {
    void stopJob(jobs, handle)
      .then(() => pushStatus(`stopped ${handle}`))
      .catch((error) => pushStatus(`stop failed: ${errorText(error)}`));
  };
  const unsubJobs = onJobsChange(jobs, () => {
    if (shutdownRequested) return;
    jobsView.setData(snapshotJobs(jobs));
    void refreshSidebar().catch(() => undefined);
    tui.requestRender();
  });
  contextView.onBack = () => void switchToView("chat");
  treeView.onBack = () => void switchToView("chat");
  treeView.onPage = (offset) => {
    state.session.state.tree = { ...state.session.state.tree, offset };
    void (async () => {
      const fresh = await brain.read();
      treeView.setData({ root: options.root, anchor: state.session.state.tree, brain: fresh });
      await syncContextView(fresh);
      await refreshSidebar();
      tui.requestRender();
    })().catch((error: unknown) => pushStatus(`tree page failed: ${errorText(error)}`));
  };
  contextView.onCollapse = () => void runCollapse("context surgery");
  // Keep the cursor on screen as it walks: the view knows which rendered lines
  // its row occupies, and the pane is the only thing that can scroll to them.
  contextView.onReveal = (start, end) => {
    const top = contextScroll.scrollTop;
    const height = contextScroll.viewportHeight;
    if (start < top) contextScroll.scrollTo(start);
    else if (end > top + height) contextScroll.scrollTo(Math.max(0, end - height));
  };

  /**
   * The person's archive operations (§3.3). There is no tool for any of these,
   * and no handle that names an archived item: the agent does not know the
   * archive exists.
   */
  // Serialize the person's actions, including the two presses of delete. A
  // fast second press must not race the mark or an older refresh.
  let archiveActionQueue: Promise<void> = Promise.resolve();
  const queueArchiveAction = (action: () => Promise<void>) => {
    archiveActionQueue = archiveActionQueue.then(action).catch((error: unknown) => {
      pushStatus(`archive action failed: ${errorText(error)}`);
      tui.requestRender();
    });
  };
  archiveView.onTogglePin = (id) => {
    queueArchiveAction(async () => {
      const archive = await brain.readArchive();
      const item = archive.items.find((candidate) => candidate.id === id);
      if (item === undefined) return;
      await brain.applyArchive({ kind: "pin", id, pinned: item.pinned === undefined ? "user" : null });
      pushStatus(`${item.pinned === undefined ? "pinned" : "unpinned"} an archived item`);
      await refreshArchive();
      await refreshSidebar();
    });
  };
  /** Mark one archived item for restore, applied by the next collapse (§4.1). */
  archiveView.onRestore = (id) => {
    queueArchiveAction(async () => {
      const result = await brain.applyArchive({ kind: "mark", id, action: "restore", author: "user" });
      pushStatus(
        result.refused
          ? "that item is marked by the agent, and that mark is the agent's to withdraw"
          : "marked for restore: it comes back at the next collapse",
      );
      await refreshArchive();
      tui.requestRender();
    });
  };
  /**
   * Apply an archive mark now (§4.1).
   *
   * Restoring an ephemeral item before the collapse it belongs to still rebuilds,
   * because the item's home is a live store and the only one being built is the
   * next generation's. That is the honest cost of putting it back early, and the
   * status line says so rather than pretending the head was untouched.
   */
  archiveView.onApplyNow = (id, action) => {
    queueArchiveAction(async () => {
      if (action === "delete") {
        const marked = (await brain.readArchive()).items.find((item) => item.id === id);
        if (marked?.mark?.action !== "delete" || marked.mark.author !== "user") {
          pushStatus("delete was not marked; the item remains in the archive");
          return;
        }
        await brain.applyArchive({ kind: "drop", id });
        pushStatus("an archived item is deleted for good");
        await refreshArchive();
        await refreshSidebar();
        tui.requestRender();
        return;
      }
      const pending = (await brain.readArchive()).items.find((item) => item.id === id);
      if (pending === undefined) return;
      if (pending.record === undefined) {
        // An ephemeral item's home is the live context, so it is written there
        // first and only then taken out of the archive: a store that will not
        // take it leaves it in the archive, where it still is, rather than
        // nowhere (§3.3).
        if (!(await restoreEphemeral(state.session, pending))) {
          pushStatus("the live context would not take it back; it is still in the archive");
          tui.requestRender();
          return;
        }
      }
      const completion = pending.record === undefined
        ? await brain.applyArchive({ kind: "restore-complete", id, expected: pending })
        : await brain.applyArchive({ kind: "restore", id });
      if (completion.refused || completion.item === undefined) {
        pushStatus("archive item changed or disappeared during restore; no stale archive acknowledgement was made");
      } else {
        pushStatus(pending.record === undefined ? "put an item back into the live context" : "restored a record to the Brain");
      }
      await refreshArchive();
      await rebuildTranscript();
      await refreshSidebar();
      if (state.view === "tree") treeView.setData({ root: options.root, anchor: state.session.state.tree, brain: await brain.read() });
      if (state.view === "context") await syncContextView(await brain.read());
      tui.requestRender();
    });
  };
  /** Withdraw the mark on an archived item: the item stays where it is (§4.1). */
  archiveView.onWithdrawMark = (id) => {
    queueArchiveAction(async () => {
      const result = await brain.applyArchive({ kind: "mark", id, action: null, author: "user" });
      pushStatus(result.refused ? "that mark is the agent's, and it stays until the agent withdraws it" : "mark withdrawn");
      await refreshArchive();
      tui.requestRender();
    });
  };
  /** Mark one archived item for delete; the next collapse is what deletes it (§4.1). */
  archiveView.onDelete = (id) => {
    queueArchiveAction(async () => {
      const result = await brain.applyArchive({ kind: "mark", id, action: "delete", author: "user" });
      pushStatus(
        result.refused
          ? "that item is marked by the agent, and that mark is the agent's to withdraw"
          : "marked for delete: it goes at the next collapse, and `d` again applies it now",
      );
      await refreshArchive();
      tui.requestRender();
    });
  };

  // Block selection in the transcript acts through the Context view's own
  // handlers: a Chat block is its Brain record, a card is an ephemeral item, and
  // a pin or a mark means the same thing here as on that view's row (§3.2, §4.1).
  // A card's id names an item in the live store until it is pinned and carried,
  // and then the Brain's copy.
  const blockPart = async (part: "chat" | "tool-work" | "ephemera", id: string): Promise<"chat" | "tool-work" | "ephemera"> =>
    part !== "tool-work" || !(await brain.read()).ephemera.some((item) => item.id === id) ? part : "ephemera";
  const onBlock = (act: (part: "chat" | "tool-work" | "ephemera") => void, part: "chat" | "tool-work" | "ephemera", id: string) =>
    void blockPart(part, id)
      .then(act)
      .catch((error: unknown) => {
        pushStatus(`that block could not be changed: ${errorText(error)}`);
        tui.requestRender();
      });
  transcript.onTogglePin = (part, id) =>
    onBlock(async (routed) => {
      // A pin keeps the text the Context view drew for the row, and that view
      // draws only while it is open: bring it up to date first.
      if (routed === "tool-work") await syncContextView(await brain.read());
      contextView.onTogglePin?.(routed, id);
    }, part, id);
  transcript.onArchive = (part, id, now) => onBlock((routed) => contextView.onArchive?.(routed, id, now), part, id);
  transcript.onDelete = (part, id, now) => onBlock((routed) => contextView.onDelete?.(routed, id, now), part, id);
  transcript.onWithdrawMark = (part, id) => onBlock((routed) => contextView.onWithdrawMark?.(routed, id), part, id);
  transcript.onReveal = (start, end) => {
    const top = transcriptScroll.scrollTop;
    const height = transcriptScroll.viewportHeight;
    // Moving the cursor is reading back: stay where it is rather than snapping to the end.
    if (start < top) transcriptScroll.scrollTo(start, { disableFollow: true });
    else if (end > top + height) transcriptScroll.scrollTo(Math.max(0, end - height), { disableFollow: true });
  };
  const enterBlockSelection = () => {
    if (!transcript.startSelecting()) {
      pushStatus("nothing in the transcript to select yet");
      tui.requestRender();
      return;
    }
    focusCurrent();
    tui.requestRender();
  };
  const leaveBlockSelection = () => {
    transcript.stopSelecting();
    transcriptScroll.scrollToEnd();
    focusCurrent();
    tui.requestRender();
  };
  transcript.onLeave = leaveBlockSelection;

  /** Redraw whichever view shows Brain state from the Brain as it now stands. */
  const refreshBrainViews = async () => {
    const fresh = await brain.read();
    if (state.view === "atlas") atlasView.setData(fresh, liveStaleMarks(fresh, options.root));
    if (state.view === "ledger") ledgerView.setData(fresh);
    if (state.view === "tree") treeView.setData({ root: options.root, anchor: state.session.state.tree, brain: fresh });
    if (state.view === "context") await syncContextView(fresh);
  };

  /**
   * Pin or unpin a file from the tree (§3.2). The person may pin or unpin any
   * file, and a file the agent pinned is theirs to take off: one press unpins
   * whoever's pin it is, like every other row. The pin is keyed by the absolute
   * path the tree names, the key the agent's `pin` tool writes, so one file is
   * one pin whichever side placed it.
   */
  treeView.onTogglePin = (path: string, directory: boolean) => {
    void (async () => {
      if (directory) {
        pushStatus("a directory holds no bytes to keep; pin a file in it");
        tui.requestRender();
        return;
      }
      const brainState = await brain.read();
      const held = brainState.files.find((file) => resolve(options.root, file.path) === path);
      const shown = relative(options.root, path);
      if (held === undefined) {
        assertPinnableFile(options.root, path);
        await brain.apply({ kind: "file.pin", path, pinned: "user" }, Date.now());
        pushStatus(`pinned ${shown} (you): the head reads it at the next collapse`);
      } else {
        await brain.apply({ kind: "file.pin", path: held.path, pinned: null }, Date.now());
        pushStatus(held.pinned === "user" ? `unpinned ${shown}` : `took the agent's pin off ${shown}`);
      }
      await refreshBrainViews();
      await refreshSidebar();
      tui.requestRender();
    })().catch((error: unknown) => {
      pushStatus(`pin failed: ${errorText(error)}`);
      tui.requestRender();
    });
  };
  /**
   * Pin or unpin one ephemeral item in the live context (§3.1, §3.2). This is
   * the person's action, and the only thing that keeps an item through a
   * collapse: an unpinned ephemeral is swept, and the archive is where it goes.
   */
  const toggleEphemeralPin = async (brainState: Awaited<ReturnType<BrainStore["read"]>>, rowId: string) => {
    const held = brainState.ephemera.find((item) => item.id === rowId);
    if (held !== undefined) {
      // The person may remove either author's pin.
      await brain.apply({ kind: "ephemeral.unpin", id: held.id }, Date.now());
      pushStatus("unpinned an item in the live context");
      await refreshSidebar();
      if (state.view === "context") await syncContextView(await brain.read());
      tui.requestRender();
      return;
    }
    // The item is in the generation's store, not the Brain: read it from the
    // context the way the Context view drew it and keep that text, because the
    // store it came from is about to be gone and pinning keeps the text, not a
    // live view of it (§5.5).
    const frozen = [...(await frozenItemsOf()).values()].find((item) => item.id === rowId);
    if (frozen !== undefined) {
      if (frozen.containsImage) { pushStatus("image results cannot be pinned yet"); return; }
      await brain.apply({ kind: "ephemeral.pin", item: { ...frozen, pinned: "user" } }, Date.now());
      pushStatus("pinned an item in the frozen head");
      await refreshSidebar();
      if (state.view === "context") await syncContextView(await brain.read());
      tui.requestRender();
      return;
    }
    const live = promptItemsOf(await sessionTranscript(state.session) as unknown as ContextEntryLike[], state.session.generation)
      .find((candidate) => candidate.item?.id === rowId)?.item;
    if (live === undefined) {
      pushStatus("that item is no longer in the live context");
      return;
    }
    if (live.containsImage) { pushStatus("image results cannot be pinned yet"); return; }
    await brain.apply({ kind: "ephemeral.pin", item: { ...live, pinned: "user" } }, Date.now());
    pushStatus("pinned an item in the live context");
    await refreshSidebar();
    if (state.view === "context") await syncContextView(await brain.read());
    tui.requestRender();
  };

  contextView.onTogglePin = (partId: string, itemId: string | number) => {
    void (async () => {
      const brainState = await brain.read();
      // A Brain entry has no pin on the context layer: a pin only stops a
      // sweep, and the Brain is not swept. Its pins live in the archive (§3.2).
      if (partId === "atlas" || partId === "ledger" || partId === "chat" || partId === "transcript") {
        pushStatus("a Brain entry is pinned only in the archive layer (ctrl+t)");
        tui.requestRender();
        return;
      }
      if (partId === "files") {
        // The head's file row toggles (§3.2). A pinned file is unpinned by the
        // person, whoever pinned it; a row the head still holds after its pin was
        // taken off pins it again, as the person's, under the same path.
        const path = String(itemId);
        const held = brainState.files.find((file) => file.path === path);
        if (held === undefined) {
          try { assertPinnableFile(options.root, path); }
          catch (error) {
            pushStatus(`pin failed: ${errorText(error)}`);
            tui.requestRender();
            return;
          }
          await brain.apply({ kind: "file.pin", path, pinned: "user" }, Date.now());
          pushStatus(`pinned ${path} (you): the head keeps it, read again at every collapse`);
        } else {
          await brain.apply({ kind: "file.pin", path, pinned: null }, Date.now());
          pushStatus(held.pinned === "user" ? `unpinned ${path}` : `took the agent's pin off ${path}`);
        }
        await syncContextView(await brain.read());
        await refreshSidebar();
        tui.requestRender();
        return;
      }
      if (partId === "ephemera" || partId === "tool-work") {
        await toggleEphemeralPin(brainState, String(itemId));
        return;
      }
      // A tool row is the prompt's to describe, not the person's to pin: there
      // is no entry to keep, only a schema in the system prompt.
      if (partId !== "tool-work") return;
    })();
  };

  /**
   * Context surgery (§4.1): `a` marks one entry for archive, `d` marks it for
   * delete, `!` arms apply-now, `u` withdraws a mark, and `c` collapses. A mark
   * is not the act — the entry stays visible until a collapse applies it — and
   * apply-now is the act, done at once.
   */
  const markRecord = async (partId: string, itemId: string | number, action: "archive" | "delete", now: boolean) => {
    // A mark on a Brain record, whichever view the person pointed at it from
    // (§4.1). A chat record arrives from the transcript; the rest arrive by the
    // id the Context view drew them under.
    const brainState = await brain.read();
    const found =
      partId === "chat" && brainState.chat.find((record) => String(record.id) === String(itemId)) !== undefined
        ? ({ kind: "chat", id: String(itemId) } as const)
        : partId === "ledger" && brainState.ledger.find((entry) => String(entry.id) === String(itemId)) !== undefined
          ? ({ kind: "ledger", id: String(itemId) } as const)
          : partId === "atlas" && brainState.atlas.find((node) => String(node.id) === String(itemId)) !== undefined
            ? ({ kind: "atlas", id: String(itemId) } as const)
            : undefined;
    if (found !== undefined) {
      if (!now) {
        await brain.apply({ kind: "mark.set", target: found.kind, id: found.id, action, author: "user" }, Date.now());
        pushStatus(`marked ${found.kind} record for ${action} at the next collapse`);
      } else {
        // §4.1: applying now is the mark's own application, done at once. A
        // Brain record leaves the Brain here — into the archive, or out of
        // existence — and the head is re-frozen from the Brain as it now stands.
        // That rebuild is the cost the section names: the bytes before the
        // changed entry are untouched, and everything after them is paid for
        // again. Nothing is swept, no grace is spent, and the generation does
        // not move, because this is not a collapse.
        const applied = await applyRecordActionNow(state.session, brain, options.root, found.kind, found.id, action);
        pushStatus(
          applied
            ? `${action === "archive" ? "archived" : "deleted"} the ${found.kind} record now, and rebuilt the head from the change`
            : `that ${found.kind} record is already gone`,
        );
      }
      await rebuildTranscript();
      await syncContextView(await brain.read());
      await refreshBrainViews();
      await refreshSidebar();
      tui.requestRender();
      return;
    }
    if (partId === "chat" || partId === "ledger" || partId === "atlas") {
      pushStatus(`that ${partId} record is no longer in the Brain`);
      tui.requestRender();
      return;
    }
    if (partId === "transcript" || partId === "tool-work" || partId === "ephemera") {
      const id = String(itemId);
      const held = brainState.ephemera.find((pin) => pin.id === id);
      if (partId === "ephemera") {
        const frozen = [...(await frozenItemsOf()).values()].find((item) => item.id === id);
        const item = held ?? frozen;
        if (item === undefined) {
          pushStatus("that item is no longer in the frozen head");
          return;
        }
        if (action === "delete" && !now) {
          await brain.apply({ kind: "ephemeral.delete-mark", id, marked: true }, Date.now());
        } else {
          const session = state.session;
          const live = (await readGenerationEphemera(generationPaths(options.root, session.generation).store, session.generation)).find((candidate) => candidate.id === id);
          if (action === "archive") {
            await brain.archiveEphemeral(live ?? { id, layer: "ephemeral", ephemeral: { kind: item.kind, text: item.text, ...(item.entity === undefined ? {} : { data: item.entity }) } }, session.generation, Date.now());
          }
          if (live !== undefined && !(await applyOmitNow(session, id))) {
            pushStatus("the live item could not be removed; its pin is unchanged");
            return;
          }
          let next = await brain.apply({ kind: "ephemeral.unpin", id }, Date.now());
          next = await brain.apply({ kind: "ephemeral.delete-mark", id, marked: false }, Date.now());
          rewriteHeadSnapshot(options.root, session.generation, next, session.state.person, Date.now());
        }
        await rebuildTranscript();
        await syncContextView(await brain.read());
        await refreshSidebar();
        tui.requestRender();
        return;
      }
      if (action === "archive") {
        // Copy before omitting: a failed or interrupted live write may leave a
        // duplicate, but can never destroy the only copy.
        const session = state.session;
        const item = (await readGenerationEphemera(generationPaths(options.root, session.generation).store, session.generation)).find((candidate) => candidate.id === id);
        if (item === undefined) {
          pushStatus("that item is no longer in the live context");
        } else {
          await brain.archiveEphemeral(item, session.generation, Date.now());
          const applied = await applyOmitNow(session, id);
          if (applied) {
            await brain.apply({ kind: "ephemeral.delete-mark", id, marked: false }, Date.now());
            if (held !== undefined) {
              const next = await brain.apply({ kind: "ephemeral.unpin", id }, Date.now());
              rewriteHeadSnapshot(options.root, session.generation, next, session.state.person, Date.now());
            }
          }
          pushStatus(applied ? "archived the item now" : "copied to the archive; the live item could not be removed");
        }
      } else if (now) {
        const applied = await applyOmitNow(state.session, id);
        if (applied) {
          await brain.apply({ kind: "ephemeral.delete-mark", id, marked: false }, Date.now());
          if (held !== undefined) {
            const next = await brain.apply({ kind: "ephemeral.unpin", id }, Date.now());
            rewriteHeadSnapshot(options.root, state.session.generation, next, state.session.state.person, Date.now());
          }
        }
        pushStatus(applied ? "deleted from the model's view; bytes remain until collapse" : "that item is no longer in the live context");
      } else {
        await brain.apply({ kind: "ephemeral.delete-mark", id, marked: true }, Date.now());
        pushStatus("marked the item for deletion at collapse");
      }
      await rebuildTranscript();
      await syncContextView(await brain.read());
      await refreshSidebar();
      tui.requestRender();
      return;
    }
    pushStatus("that entry is the prompt's to describe, not a record to mark");
    tui.requestRender();
  };
  let contextActionQueue: Promise<void> = Promise.resolve();
  const queueContextAction = (action: () => Promise<void>) => {
    if (state.collapsing) {
      pushStatus("collapsing — hold on");
      tui.requestRender();
      return;
    }
    contextActionQueue = contextActionQueue.then(action).catch((error: unknown) => {
      pushStatus(`context action failed: ${errorText(error)}`);
      tui.requestRender();
    });
  };
  contextView.onDelete = (partId, itemId, now) => queueContextAction(() => markRecord(partId, itemId, "delete", now));
  contextView.onArchive = (partId, itemId, now) => queueContextAction(() => markRecord(partId, itemId, "archive", now));

  /**
   * Withdraw a mark on a Brain record, or leave the record alone if the mark is
   * the agent's. The person withdraws their own marks; the Brain refuses the
   * rest, and this is where that refusal is put into words (§4.1).
   */
  const withdrawRecordMark = async (target: "chat" | "ledger" | "atlas", id: string) => {
    try {
      await brain.apply({ kind: "mark.clear", target, id, author: "user" }, Date.now());
      pushStatus("mark withdrawn");
    } catch {
      pushStatus("that mark is the agent's, and it stays until the agent withdraws it");
    }
    await rebuildTranscript();
    await syncContextView(await brain.read());
    await refreshBrainViews();
    await refreshSidebar();
    tui.requestRender();
  };

  // Atlas and Ledger give the person the same four acts the Context view has,
  // routed into the same functions: one mark means one thing in every view.
  for (const [book, view] of [["atlas", atlasView], ["ledger", ledgerView]] as const) {
    view.controls.onMark = (id, action, now) => queueContextAction(() => markRecord(book, id, action, now));
    view.controls.onWithdraw = (id) => queueContextAction(() => withdrawRecordMark(book, id));
  }

  contextView.onWithdrawMark = (partId, itemId) => {
    queueContextAction(async () => {
      const brainState = await brain.read();
      if (partId === "transcript" || partId === "tool-work" || partId === "ephemera") {
        await brain.apply({ kind: "ephemeral.delete-mark", id: String(itemId), marked: false }, Date.now());
        await rebuildTranscript();
        await syncContextView(await brain.read());
        tui.requestRender();
        return;
      }
      const kind =
        partId === "chat" && brainState.chat.some((record) => String(record.id) === String(itemId))
          ? "chat"
          : partId === "ledger" && brainState.ledger.some((entry) => String(entry.id) === String(itemId))
            ? "ledger"
            : partId === "atlas" && brainState.atlas.some((node) => String(node.id) === String(itemId))
              ? "atlas"
              : undefined;
      if (kind === undefined) {
        pushStatus(partId === "ephemera" ? "an item kept in the context carries no mark; a pin is what holds it" : "nothing here carries a mark");
        tui.requestRender();
        return;
      }
      await withdrawRecordMark(kind, String(itemId));
    });
  };
  // ── The screen ────────────────────────────────────────────────────────────
  // Surfaces, darkest outermost (frame.ts): the chrome — margin, header row,
  // key bar, context bar — then the two panes raised out of it, the sidebar and
  // the working area, then the prompt. Posting's map of a screen: a header row
  // across the top, the panes under it, the keys that work here, and a bar
  // along the very bottom.
  //
  // pi-tui paints only what a component renders, so every gap is a `Fill`: the
  // margin, the seam between the panes, each pane's floor below a short list.
  // A pane that is shorter than its room would otherwise show the terminal's
  // own background through it.
  const rows = () => terminal.rows;
  const chrome = (size: number, visible?: (viewport: Viewport) => boolean) => ({
    component: new Fill(rawPalette.chrome, rows),
    basis: size,
    ...(visible === undefined ? {} : { visible }),
  });
  const pane = (size: number, hex: string = rawPalette.background) => ({ component: new Fill(hex, rows), basis: size });
  const footer = new FooterView(() => footerHints());
  // A scrolling view takes the height of its content, up to the room there is,
  // and the pane's own colour fills the rest.
  const scrolled = (component: Component, visible: () => boolean) => ({ component, basis: "auto" as const, shrink: 1, minSize: 3, visible });
  const bookSplit = (
    headerPane: Component,
    listScroll: ScrollView,
    detailScroll: ScrollView,
    narrowScroll: ScrollView,
    listBasis: number,
    listFloorHex: string = rawPalette.panel,
    detailFloorHex: string = rawPalette.surface,
  ) =>
    new Column([
      {
        component: new Column([
          { component: headerPane, basis: 2 },
          {
            component: new Row([
              {
                component: new Column([
                  { component: listScroll, basis: "auto", shrink: 1, minSize: 1 },
                  { ...pane(0, listFloorHex), grow: 1 },
                ]),
                basis: listBasis,
                minSize: 24,
                shrink: 1,
              },
              pane(2),
              {
                component: new Column([
                  { component: detailScroll, basis: "auto", shrink: 1, minSize: 1 },
                  { ...pane(0, detailFloorHex), grow: 1 },
                ]),
                basis: 0,
                grow: 1,
                minSize: 30,
              },
            ]),
            basis: 0,
            grow: 1,
            minSize: 3,
          },
        ]),
        basis: 0,
        grow: 1,
        minSize: 3,
        visible: (viewport: Viewport) => viewport.width >= 72,
      },
      {
        component: new Column([
          { component: narrowScroll, basis: "auto", shrink: 1, minSize: 3 },
          { ...pane(0), grow: 1 },
        ]),
        basis: 0,
        grow: 1,
        minSize: 3,
        visible: (viewport: Viewport) => viewport.width < 72,
      },
    ]);
  const atlasSplit = bookSplit(atlasView.headerPane, atlasListScroll, atlasDetailScroll, atlasNarrowScroll, 36);
  const ledgerSplit = bookSplit(ledgerView.headerPane, ledgerListScroll, ledgerDetailScroll, ledgerNarrowScroll, 38);
  const jobsSplit = bookSplit(
    jobsView.headerPane,
    jobsListScroll,
    jobsDetailScroll,
    jobsNarrowScroll,
    32,
    rawPalette.background,
    rawPalette.background,
  );
  const inSplitBook = () => state.layer === "context" && (state.view === "atlas" || state.view === "ledger" || state.view === "jobs");
  const workArea = new Column([
    scrolled(transcriptScroll, () => state.view === "chat" && state.layer === "context"),
    { component: jobsSplit, basis: 0, grow: 1, minSize: 3, visible: () => state.view === "jobs" && state.layer === "context" },
    { component: atlasSplit, basis: 0, grow: 1, minSize: 3, visible: () => state.view === "atlas" && state.layer === "context" },
    { component: ledgerSplit, basis: 0, grow: 1, minSize: 3, visible: () => state.view === "ledger" && state.layer === "context" },
    scrolled(treeScroll, () => state.view === "tree" && state.layer === "context"),
    scrolled(contextScroll, () => state.view === "context" && state.layer === "context"),
    scrolled(archiveScroll, () => state.layer === "archive"),
    { ...pane(0), grow: 1, visible: () => !inSplitBook() },
  ]);
  const inChatLayer = () => state.view === "chat" && state.layer === "context";
  const inJobsLayer = () => state.view === "jobs" && state.layer === "context";
  // The working pane: a row of air above the content, the prompt (only where
  // you type) across its foot, and a row below it where there is no prompt. The
  // views indent themselves, so there is no column of air either side: every
  // extra column is another box composited onto every row of every frame.
  const workPane = new Column([
    pane(1),
    { component: workArea, basis: 0, grow: 1, minSize: 3 },
    { component: editor, basis: "auto", minSize: 3, visible: inChatLayer },
    { component: jobsView.inputPane, basis: "auto", minSize: 1, visible: inJobsLayer },
    { ...pane(1), visible: () => !inChatLayer() && !inJobsLayer() },
  ]);
  // The panes' row, margins included: one cell of chrome either side on a
  // narrow terminal, two on a wide one. The sidebar's margin, its panel below the
  // list and the seam to the working pane are drawn by one `Inset`, because each
  // separate box in this row is another composite of every one of its rows on
  // every frame, and the working pane's lines are the costly ones to re-read.
  const sidebarIn = (cells: number, visible: (viewport: Viewport) => boolean) => ({
    component: new Inset(sidebar, cells, 1, rawPalette.panel, rawPalette.chrome, rows),
    basis: cells + sidebarWidth + 1,
    visible: (viewport: Viewport) => state.sidebarVisible && visible(viewport),
  });
  const bareIn = (cells: number, visible: (viewport: Viewport) => boolean) => ({
    ...chrome(cells),
    visible: (viewport: Viewport) => !state.sidebarVisible && visible(viewport),
  });
  const panes = new Row([
    sidebarIn(2, margin.wide),
    sidebarIn(1, margin.narrow),
    sidebarIn(0, margin.none),
    bareIn(2, margin.wide),
    bareIn(1, margin.narrow),
    { component: workPane, basis: 0, grow: 1, minSize: 20 },
    { ...chrome(2), visible: margin.wide },
    { ...chrome(1), visible: margin.narrow },
  ]);
  // The header and bottom bands take the same horizontal margin.
  const framed = (inner: Component) =>
    new Row([
      { ...chrome(2), visible: margin.wide },
      { ...chrome(1), visible: margin.narrow },
      { component: inner, basis: 0, grow: 1, minSize: 20 },
      { ...chrome(2), visible: margin.wide },
      { ...chrome(1), visible: margin.narrow },
    ]);
  const screen = new Column([
    chrome(1, margin.edge),
    { component: framed(header), basis: 1 },
    chrome(1, margin.gap),
    { component: panes, basis: 0, grow: 1, minSize: 6 },
    chrome(1, margin.gap),
    { component: framed(new Column([{ component: footer, basis: 1 }, { component: tokenBar, basis: 2 }])), basis: 3 },
    chrome(1, margin.edge),
  ]);

  tui.setLayoutRoot(screen);
  tui.start();
  tui.setFocus(editor);

  // ── Input ─────────────────────────────────────────────────────────────────
  let activeModelPicker: ModelPicker | undefined;
  const closeOverlay = () => {
    activeModelPicker = undefined;
    state.overlayHandle?.hide();
    state.overlayHandle = undefined;
    state.overlayOpen = false;
    focusCurrent();
    tui.requestRender();
  };

  let shutdownRequested = false;
  let resolveRun: ((code: number) => void) | undefined;
  const runDone = new Promise<number>((resolve) => {
    resolveRun = resolve;
  });
  let liveTimer: ReturnType<typeof setInterval> | undefined;
  const shutdown = async (code: number): Promise<void> => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    unsubJobs();
    if (liveTimer !== undefined) clearInterval(liveTimer);
    tui.stop();
    await state.liveWatch?.stop().catch(() => undefined);
    state.liveWatch = undefined;
    try {
      if (code === WIPE_REQUESTED) {
        // A queued admission/collapse must finish before closing its session.
        await admission;
        await interruptRun(state.session);
        await contextActionQueue;
        await transcriptRebuild?.catch(() => undefined);
        await capacityRefreshFlight?.catch(() => undefined);
      }
      await stopAllJobs(jobs);
      await closeLiveSession(state.session, code === WIPE_REQUESTED);
      resolveRun?.(code);
    } catch (error) {
      process.stderr.write(`Carto could not close cleanly; no wipe was attempted: ${errorText(error)}\n`);
      resolveRun?.(1);
    }
  };

  /**
   * Rebuild from the frozen projection and current context entries, in prompt
   * order. The Brain supplies marks and identities, not additional history.
   * Re-renders are skipped when nothing moved.
   */
  const shownBookSig: { atlas: string; ledger: string } = { atlas: "", ledger: "" };
  let shownSidebarSig = "";
  let lastFrozen: { generation: string; text: string } | undefined;
  const performTranscriptRebuild = async (): Promise<void> => {
    // The session is closed on the way out, and a rebuild in flight at that
    // moment reads a closed harness: there is nothing left to draw, and the
    // frame is about to go away with the terminal.
    if (shutdownRequested) return;
    try {
      const brainState = await brain.read();
      const entries = (await sessionTranscript(state.session)) as unknown as ContextEntryLike[];

      const visibleMessages: BlockMessageLike[] = [];
      for (const entry of entries) {
        const message = messageOf(entry);
        if (message === undefined) continue;
        visibleMessages.push(message as unknown as BlockMessageLike);
      }

      const person: Array<{ key: number; entry: TranscriptEntry }> = [];
      const landedTexts: Array<{ text: string; t: number }> = [];
      const toolErrors = new Map<string, boolean>();
      const toolOutputs = new Map<string, { text: string; resultId: string; entryKey: string; order: number }>();
      const assistantParts: Array<{ entryId: number; parts: unknown[]; partKeys?: readonly string[] | undefined; stopReason?: string }> = [];
      // One order, one numbering, both views (§5.4).
      const promptItems = promptItemsOf(entries, state.session.generation);
      for (const entry of entries) {
        const id = typeof entry.id === "number" ? entry.id : 0;
        const message = messageOf(entry);
        if (message === undefined) continue;
        const role = typeof message.role === "string" ? message.role : "";
        if (role === "user") {
          const text = userText(message.content);
          if (text.trim() === STATE_BLOCK_MARKER || text.trim().length === 0) continue;
          const t = timestampOf(message);
          person.push({ key: id, entry: { kind: "person", text } });
          landedTexts.push({ text, t });
        } else if (role === "assistant" && Array.isArray(message.content)) {
          const parts = message.content as unknown[];
          const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
          if (parts.length > 0) assistantParts.push({ entryId: id, parts, partKeys: entry.partKeys, ...(stopReason === undefined ? {} : { stopReason }) });
        } else if (role === "toolResult" && isRecord(message)) {
          const callId = (message as Record<string, unknown>).toolCallId;
          if (typeof callId === "string") {
            if ((message as Record<string, unknown>).isError === true) toolErrors.set(callId, true);
            let out = "";
            if (Array.isArray(message.content)) {
              for (const p of message.content) {
                if (isRecord(p) && typeof p.text === "string") out += p.text;
                else if (isRecord(p) && p.type === "image") out += `${out ? "\n" : ""}[image]`;
              }
            } else if (typeof message.content === "string") {
              out = message.content;
            }
            toolOutputs.set(callId, { text: out, resultId: ephemeralItemId(state.session.generation, id, "r"), entryKey: String(id), order: id });
          }
        }
      }
      const handles = promptHandles(promptItems, state.session.state.headEphemeraCount ?? 0);
      // Now that the items are numbered, each row takes its own: a person's
      // line is `U1`, a card is the `X` of the item it renders, and a result is
      // the `R` or `S` of the result it is.
      const handleFor = (key: string): { handle?: string } => {
        const handle = handles.ephemeral(key);
        return handle === undefined ? {} : { handle };
      };
      for (const item of person) {
        const handle = handles.person(String(item.key));
        if (handle !== undefined && item.entry.kind === "person") item.entry.handle = handle;
      }

      // The working, as cards: reasoning, plain model text, and tool calls, in
      // the order the model produced them. Landed cards default folded.
      const cards: Array<{ key: number; entry: TranscriptEntry }> = [];
      const agent: Array<{ key: number; entry: TranscriptEntry }> = [];
      // The landed stop reason of each assistant turn — one quiet line per
      // turn, warn-toned when the turn was cut short (length) or failed.
      // Always present, so a truncated generation is glanceable.
      const stops: Array<{ key: number; entry: TranscriptEntry }> = [];
      for (const { entryId, parts, partKeys, stopReason } of assistantParts) {
        if (stopReason !== undefined) {
          const warn = stopReason === "length" || stopReason === "error" || stopReason === "aborted";
          stops.push({
            key: entryId + (parts.length + 1) * 0.0001,
            entry: { kind: "status", text: `stopped: ${stopReason}`, ...(warn ? { tone: "warn" as const } : {}) },
          });
        }
        parts.forEach((part, partIndex) => {
          if (!isRecord(part)) return;
          const key = entryId + (partIndex + 1) * 0.0001;
          const itemHandle = handleFor(`${entryId}-${partIndex}`);
          const partKey = partKeys?.[partIndex];
          const source = partKey === undefined ? {} : { sourceId: ephemeralItemId(state.session.generation, entryId, partKey) };
          if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim().length > 0) {
            cards.push({ key, entry: { kind: "reasoning", id: `ctx-${entryId}-${partIndex}`, text: part.thinking, ...itemHandle, ...source } });
          } else if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
            cards.push({ key, entry: { kind: "output", id: `ctx-${entryId}-${partIndex}`, text: part.text, ...itemHandle, ...source } });
          } else if (part.type === "toolCall" && typeof part.name === "string") {
            const callId = typeof part.id === "string" ? part.id : undefined;
            const output = callId !== undefined ? toolOutputs.get(callId) : undefined;
            if (part.name === "chat" && callId !== undefined && output !== undefined && toolErrors.get(callId) !== true && isRecord(part.arguments) && typeof part.arguments.text === "string") {
              const record = brainState.chat.find((candidate) => candidate.id === `chat:${callId}`);
              const chatHandle = record === undefined ? undefined : handleOf(brainState.handles, "chat", record.id);
              agent.push({ key: key + 0.00001, entry: { kind: "agent", text: part.arguments.text, ...(record === undefined ? source : { recordId: record.id, mark: record.mark }), ...(chatHandle === undefined ? {} : { handle: chatHandle }) } });
            }
            cards.push({
              key,
              entry: {
                kind: "tool",
                id: `ctx-${entryId}-${partIndex}`,
                name: part.name,
                args: formatToolArgs(part.arguments, part.name),
                ...itemHandle,
                ...source,
              },
            });
            if (output !== undefined) {
              const handle = toolRowHandle(handles, `${entryId}-${partIndex}`, output.entryKey);
              cards.push({
                key: output.order,
                entry: {
                  kind: "tool", id: `result-${output.entryKey}`, name: part.name, args: "",
                  output: output.text, resultId: output.resultId,
                  ...(handle === undefined ? {} : { handle }),
                  ...(callId !== undefined && toolErrors.get(callId) === true ? { failed: true } : {}),
                },
              });
            }
          }
        });
      }

      for (const { entry } of cards) {
        if (!isCard(entry)) continue;
        const id = entry.resultId ?? entry.sourceId;
        if (id !== undefined && brainState.ephemeralDeletes?.includes(id)) entry.deleteMarked = true;
      }

      // The head is the frozen projection, not a retained transcript or the
      // archive. Its sidecar supplies the record identities behind those bytes.
      const sidecar = await readFile(snapshotPaths(options.root, state.session.generation).sidecar, "utf8")
        .then((text) => JSON.parse(text) as { chat?: string[]; ephemeralItems?: Array<{ handle: string; item: import("../domain/records.js").PinnedEphemeral }> })
        .catch(() => ({} as { chat?: string[]; ephemeralItems?: Array<{ handle: string; item: import("../domain/records.js").PinnedEphemeral }> }));
      const headChat = Array.isArray(sidecar.chat) ? sidecar.chat : [];
      const headItems = sidecar.ephemeralItems === undefined
        ? state.session.state.headEphemera ?? new Map()
        : new Map(sidecar.ephemeralItems.map(({ handle, item }) => [handle, item]));
      const projection = await readFile(state.session.markdownPath, "utf8").catch(() => undefined);
      if (projection !== undefined) lastFrozen = { generation: state.session.generation, text: projection };
      const head = frozenTranscript(
        projection ?? (lastFrozen?.generation === state.session.generation ? lastFrozen.text : ""),
        brainState, headChat, headItems, state.session.state.person,
      );

      // A live person line is its Chat record when one was recorded on submit.
      // Head records are already represented above and cannot claim a body line.
      const bindings = personChatBindings(entries, brainState.chat, new Set(Array.isArray(sidecar.chat) ? headChat : brainState.chat.map((record) => record.id)));
      for (const item of person) {
        if (item.entry.kind !== "person") continue;
        const id = bindings.get(item.key);
        if (id === undefined) {
          item.entry = { ...item.entry, sourceId: ephemeralItemId(state.session.generation, item.key, "x0") };
        } else {
          item.entry = { ...item.entry, recordId: id, mark: brainState.chat.find((record) => record.id === id)?.mark };
        }
      }

      // Clear pending items whose placement we can now see: same text, an
      // entry placed at or after the submit. Best effort, matches oldest first.
      if (state.pending.length > 0) {
        const remaining: PendingItem[] = [];
        const pool = [...landedTexts];
        for (const item of state.pending) {
          const index = pool.findIndex((landed) => landed.text === item.text && landed.t >= item.at - 5_000);
          if (index !== -1) {
            pool.splice(index, 1);
          } else {
            remaining.push(item);
          }
        }
        state.pending = remaining;
      }

      // Token estimates: split context messages into system, transcript,
      // toolWork — strictly matching the same estimates the state block reports,
      // split the same way. Cheap next to the Brain read above.
      const blockMessages = visibleMessages.filter((message) => !isMarkerMessage(message));
      const parts = splitContextMessages(blockMessages);
      barState.parts = { system: parts.systemTokens, transcript: parts.transcriptTokens, toolWork: parts.toolWorkTokens };

      const sig = [
        state.session.generation,
        JSON.stringify(head),
        JSON.stringify(person),
        JSON.stringify(cards),
        JSON.stringify(stops),
        JSON.stringify(agent),
        state.pending.map((item) => item.text).join("\u0001"),
        state.notes.join("\u0002"),
        String(Math.round(parts.systemTokens)),
        String(Math.round(parts.transcriptTokens)),
        String(Math.round(parts.toolWorkTokens)),
        String(state.session.state.lastReportedInput ?? ""),
        String(state.session.state.contextWindow),
      ].join("|");
      if (sig !== state.sig) {
        state.sig = sig;
        const notes = state.notes.map((text, index) => ({
          key: Number.MAX_SAFE_INTEGER - state.notes.length + index,
          entry: { kind: "status", text, tone: "warn" } as TranscriptEntry,
        }));
        const live = [...person, ...cards, ...stops, ...agent, ...notes];
        transcript.setEntries(
          orderTranscript(head, live),
          state.pending.map((item) => ({ text: item.text, mode: item.mode })),
        );
        headerState.windowUnknown = state.session.state.contextWindow <= 0;
        tui.requestRender();
      }

      // The sidebar map stays current on every view, using the exact same
      // ordered nodes as the Context view rather than a second projection.
      await syncContextView(brainState);

      // The books follow the Brain on this same drain: Chat streams, and the
      // agent writes Atlas and Ledger mid-run, so the open book and the
      // sidebar's counts move when the Brain does rather than when the person
      // next opens the view. One hash of what the books show decides it, so a
      // quiet Brain costs a read and a digest, and only a changed one redraws.
      const brainSig = createHash("sha1")
        .update(JSON.stringify([brainState.chat, brainState.ledger, brainState.atlas, brainState.files, brainState.ephemera]))
        .digest("hex");
      if (state.layer === "context" && (state.view === "atlas" || state.view === "ledger") && shownBookSig[state.view] !== brainSig) {
        shownBookSig[state.view] = brainSig;
        if (state.view === "atlas") atlasView.setData(brainState, liveStaleMarks(brainState, options.root));
        else ledgerView.setData(brainState);
        tui.requestRender();
      }
      if (brainSig !== shownSidebarSig) {
        shownSidebarSig = brainSig;
        await refreshSidebar();
      }
    } catch (error) {
      // Shutdown closed the session under us; every other failure is a real
      // one and stays visible.
      if (!shutdownRequested) throw error;
    }
  };
  let transcriptRebuild: Promise<void> | undefined;
  let rebuildRequested = false;
  const rebuildTranscript = (duringCollapse = false): Promise<void> => {
    // Timers and delayed watcher callbacks must not read a closing session.
    // Collapse itself explicitly drains the preceding rebuild before snapshotting.
    if (state.collapsing && !duringCollapse) return Promise.resolve();
    rebuildRequested = true;
    if (transcriptRebuild !== undefined) return transcriptRebuild;
    transcriptRebuild = (async () => {
      do {
        rebuildRequested = false;
        await performTranscriptRebuild();
      } while (rebuildRequested);
    })().finally(() => { transcriptRebuild = undefined; });
    return transcriptRebuild;
  };

  const startLiveWatch = async (): Promise<void> => {
    const session = state.session;
    const watch = await session.conversation.watch(BACKGROUND_CONTEXT).catch(() => undefined);
    if (watch === undefined) return;
    if (shutdownRequested || session !== state.session) {
      await watch.stop().catch(() => undefined);
      return;
    }
    state.liveWatch = watch;
    const observeRun = (value: typeof watch.value) => {
      if (session !== state.session) return;
      const live = value.docs[LiveDoc.definition.kind] as LiveState | undefined;
      state.activity.observeRun(live?.run !== undefined);
      headerState.running = state.running;
      tui.requestRender();
    };
    // The run may already be active before the new watch is acquired.
    observeRun(watch.value);
    const entryStream = new ConversationTranscript((query, limit, ctx) =>
      session.conversation.entries(query, limit, undefined, ctx),
    );
    let lastItems: readonly unknown[] | undefined = watch.value === undefined ? undefined : entryStream.merge(watch.value).items;
    let cachedPromptItems: PromptItem[] | undefined;
    let hadLive = false;
    watch.start(async (call) => {
      if (shutdownRequested || call.kind !== "value" || session !== state.session) return;
      observeRun(call.value);
      const merged = entryStream.merge(call.value);
      const entriesChanged = merged.items !== lastItems;
      lastItems = merged.items;
      if (entriesChanged || cachedPromptItems === undefined) {
        // Reload landed contributions only when committed entries change (including
        // apply-now edits), rather than re-reading SQLite on every streaming token.
        const landedEntries = (await sessionTranscript(session).catch(() => [])) as unknown as ContextEntryLike[];
        cachedPromptItems = promptItemsOf(landedEntries, session.generation);
      }
      if (shutdownRequested || session !== state.session) return;
      const live = (call.value.docs[LiveDoc.definition.kind] as LiveState | undefined) ?? LiveDoc.definition.initial();
      // The partial continues the prompt's numbering rather than starting a
      // second one: a card in flight is the next item after everything the
      // generation already holds, and it wears the handle of the item it is.
      const cards = liveCardsOf(live, generationHandles(live, cachedPromptItems, session.state.headEphemeraCount ?? 0));
      transcript.setLive(cards);
      tui.requestRender();
      const hasLive = cards.length > 0 || live.generation !== undefined || (live.tools?.length ?? 0) > 0;
      if (entriesChanged || (hadLive && !hasLive)) {
        setImmediate(() => {
          void rebuildTranscript().catch(() => undefined);
        });
      }
      hadLive = hasLive;
      // The agent runs without a line from the person — a rest wakes it — so a
      // collapse it asked for is carried out here, when its run has ended.
      if (live.run === undefined && session.state.collapseRequested !== null) {
        void serviceCollapseRequest().catch(() => undefined);
      }
    });
  };

  // Submissions and collapses take turns. A message that arrives while the
  // context is being rebuilt waits for the new session instead of landing in the
  // one being closed, and is the next thing the rebuilt agent reads.
  let admission: Promise<unknown> = Promise.resolve();
  const admitting = <T>(work: () => Promise<T>): Promise<T> => {
    const run = admission.then(work, work);
    admission = run.catch(() => undefined);
    return run;
  };

  const runCollapse = (reason: string, automatic = false, trigger?: "agent" | "automatic"): Promise<void> => {
    if (state.collapsing) return Promise.resolve();
    state.collapsing = true;
    return admitting(() => collapseNow(reason, automatic, trigger));
  };

  /**
   * Take the collapse the agent asked for, or the model's limits forced, and
   * carry it out — or, when the last automatic collapse got nowhere, say so and
   * stop. Called from every place a run can end, because a run can end with no
   * line of the person's behind it.
   */
  const serviceCollapseRequest = async (): Promise<void> => {
    if (state.collapsing || shutdownRequested) return;
    const verdict = state.session.reviewCollapseRequest();
    if (verdict.kind === "none") return;
    if (verdict.kind === "stop") {
      state.notes.push(verdict.explanation);
      pushStatus("collapse stopped: it would only repeat itself — see the transcript");
      await rebuildTranscript();
      tui.requestRender();
      return;
    }
    await runCollapse(verdict.reason, true, verdict.trigger);
  };

  const collapseNow = async (reason: string, automatic: boolean, trigger?: "agent" | "automatic") => {
    const previous = state.session.generation;
    pushStatus(`collapsing context at ${suffix(previous)}: ${reason}…`);
    // The person's collapse drops what is queued. An automatic one carries it:
    // the queue is read from the store, and what has not landed is re-sent.
    if (!automatic && state.pending.length > 0) {
      pushStatus(`${state.pending.length} queued message(s) dropped by the collapse`);
      state.pending = [];
    }
    transcript.setLive([]);
    await state.liveWatch?.stop().catch(() => undefined);
    state.liveWatch = undefined;
    try {
      // A queued edit can be waiting for a run boundary. Interrupt first so
      // collapse does not deadlock waiting for that edit to land. An automatic
      // collapse comes after the run ended, and must read the queue before
      // anything withdraws it.
      if (!automatic) await interruptRun(state.session);
      await contextActionQueue;
      // Drain any refresh already underway, then take a fresh landed view after
      // the run and queued edits have settled. Delayed watcher callbacks cannot
      // start another rebuild while the session is being replaced.
      await rebuildTranscript(true);
      transcript.setLive([]);
      const outcome = await collapseLiveSession(
        state.session,
        sessionOptions(),
        reason,
        {},
        { automatic, ...(trigger === undefined ? {} : { trigger }) },
      );
      state.collapseEpoch += 1;
      state.session = outcome.session;
      state.activity.observeRun(false);
      headerState.running = state.running;
      headerState.session = outcome.session;
      barState.session = outcome.session;
      bindTelemetry(outcome.session);
      void startLiveWatch();
      pushStatus(`collapsed and rebuilt from the Brain (${suffix(previous)} → ${suffix(outcome.report.generation)})`);
      if (automatic) {
        const carried = outcome.carried === 0 ? "" : ` · ${outcome.carried} queued message(s) carried over`;
        pushStatus(`${reason}${carried}${outcome.resumed ? " · the agent goes on" : " · paused, so it waits"}`);
      }
      // What the archive did is the person's business, so it is said. Nothing
      // here reaches the agent: the archive is not in any of its views (§3.3).
      if (outcome.report.restored.length > 0) pushStatus(`${outcome.report.restored.length} item(s) came back out of the archive`);
      if (outcome.report.deleted.length > 0) pushStatus(`${outcome.report.deleted.length} archived item(s) deleted for good`);
      if (outcome.report.dropped.length > 0) pushStatus(`${outcome.report.dropped.length} archived item(s) past their grace, gone`);
      await refreshSidebar();
      await refreshArchive();
    } catch (error) {
      state.collapseEpoch += 1;
      pushStatus(`collapse failed: ${errorText(error)}`);
      // The ceremony closes the old session before touching generation files.
      // Reopen through journal recovery rather than continuing with a closed
      // harness (or guessing which generation survived).
      try {
        await closeLiveSession(state.session).catch(() => undefined);
        const recovered = await openLiveSession(sessionOptions());
        state.session = recovered;
        state.activity.observeRun(false);
        headerState.running = state.running;
        headerState.session = recovered;
        barState.session = recovered;
        bindTelemetry(recovered);
        void startLiveWatch();
      } catch (recoveryError) {
        tui.stop();
        process.stderr.write(`Collapse recovery failed: ${errorText(recoveryError)}. Generation files were preserved.\n`);
        shutdownRequested = true;
        resolveRun?.(1);
      }
    } finally {
      state.collapsing = false;
      headerState.running = state.running;
      await rebuildTranscript();
      tui.requestRender();
      // A run that started during the rebuild may already have asked again.
      if (state.session.state.collapseRequested !== null) void serviceCollapseRequest().catch(() => undefined);
    }
  };

  let capacityRefreshFlight: Promise<void> | undefined;
  const refreshAdvertisedWindow = async () => {
    if (capacityRefreshFlight !== undefined) return capacityRefreshFlight;
    const work = (async () => {
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          const line = String(chunk).trim();
          if (line.length > 0) pushStatus(line);
          callback();
        },
      });
      await applyCapacityRefresh(state.session, refresh, options.models, state.model.provider, state.model.modelId, sink);
      if (shutdownRequested) return;
      headerState.windowUnknown = state.session.state.contextWindow <= 0;
      tui.requestRender();
      await rebuildTranscript();
    })();
    capacityRefreshFlight = work;
    try {
      await work;
    } finally {
      if (capacityRefreshFlight === work) capacityRefreshFlight = undefined;
    }
  };

  const runSubmission = async (message: string) => {
    // A collapse in progress is no reason to refuse the message: it is admitted
    // as soon as the new session exists.
    const epoch = state.collapseEpoch;
    state.notes = [];
    state.activity.beginSubmission();
    headerState.running = state.running;
    tui.requestRender();
    try {
      const whenBusy = state.sendMode === "after run" ? "followUp" : "steer";
      const submission = await admitting(async () => {
        if (state.sendMode === "now") await interruptRun(state.session);
        return submitInput(state.session, message, whenBusy);
      });
      await rebuildTranscript();
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      await waitForRunEnd(state.session);
      // A collapse that withdrew or outlived this run says what happened itself.
      if (settled.status !== "done" && epoch === state.collapseEpoch && !state.collapsing && state.session.state.collapseRequested === null) {
        pushStatus(`the run ended with status "${settled.status}"`);
      }
    } catch (error) {
      if (epoch === state.collapseEpoch && !state.collapsing) pushStatus(`the run failed: ${errorText(error)}`);
    }
    state.activity.endSubmission();
    headerState.running = state.running;
    // The run settled after the person left: the session is closed, and every
    // read below would raise against a harness that is already gone.
    if (shutdownRequested) return;
    await rebuildTranscript();
    await serviceCollapseRequest();
    // A timed sleep no longer needs anything here: the rest is a durable task
    // (§10), so the next turn begins from the store, even after a restart, and
    // the watch on the live generation shows it when it happens.
    if (options.refreshCapacity === true) await refreshAdvertisedWindow();
    await refreshSidebar();
    tui.requestRender();
  };

  /** Person-owned modes are persisted before they take effect. */
  const toggleReadOnly = () => {
    try {
      const settings = setProjectModes(state.session, { readOnly: !state.session.state.readOnly });
      tui.flash(settings.readOnly ? "read only mode — create and edit will refuse" : "edit mode — the agent may change files", 1_800);
      tui.requestRender();
    } catch (error) { pushStatus(`mode not changed: ${errorText(error)}`); }
  };
  const togglePathScope = () => {
    try {
      const settings = setProjectModes(state.session, { pathScope: state.session.state.pathScope === "relaxed" ? "strict" : "relaxed" });
      tui.flash(settings.pathScope === "relaxed" ? "relaxed scope — read and edit may access outside the project" : "strict scope — file tools stay inside the project", 1_800);
      tui.requestRender();
    } catch (error) { pushStatus(`scope not changed: ${errorText(error)}`); }
  };
  const copyTranscript = async () => {
    const text = transcript.toPlainText();
    const result = await copyWithFallback(text, "transcript");
    pushStatus(`transcript: ${result.where}; ${describeFallback(result)} (${text.split("\n").length} lines)`);
    return result;
  };

  const copySession = async () => {
    const brainState = await brain.read();
    const archiveState = await brain.readArchive().catch(() => ({ version: 1 as const, items: [] }));
    const collapses = readCollapseLog(options.root);
    const entries = (await sessionTranscript(state.session)) as unknown as ContextEntryLike[];
    const lines: string[] = [
      `# carto session dump — ${new Date().toISOString()}`,
      `project: ${options.root}`,
      `generation: ${state.session.generation} · collapses recorded: ${collapses.length}`,
      `model: ${modelLabel()} · ${state.session.state.contextWindow > 0 ? `window ${state.session.state.contextWindow.toLocaleString("en-US")}` : "window unknown"}`,
      `last provider report: ${state.session.state.lastReportedInput?.toLocaleString("en-US") ?? "none"} + tool work since +${state.session.state.toolWorkAtLastReport.toLocaleString("en-US")}`,
      `atlas ${brainState.atlas.length} · ledger ${brainState.ledger.length} · chat ${brainState.chat.length} · pinned files ${brainState.files.length} · archive ${archiveState.items.length}`,
    ];
    if (collapses.length > 0) {
      lines.push("", `## collapse history (${collapses.length} recorded; oldest first)`, formatCollapseHistory(collapses));
    }
    if (state.session.state.lastStateBlock !== undefined && state.session.state.lastStateBlock.trim().length > 0) {
      lines.push("", "## live <carto-state> (last sent to model)", state.session.state.lastStateBlock);
    }
    lines.push(
      "",
      "## transcript (what the person saw)",
      transcript.toPlainText(),
      "",
      "## context (what the model sees; oldest first; state-block markers stripped)",
    );
    for (const entry of entries) {
      const flat = flattenEntry(entry as { kind?: string; id?: number; model?: unknown });
      if (flat === undefined) continue;
      if (flat.body.trim() === STATE_BLOCK_MARKER) continue;
      lines.push("", `#${flat.id} ${flat.kind} · role ${flat.role} · ${flat.timestamp === undefined ? "?" : new Date(flat.timestamp).toISOString()}`, flat.body);
    }
    lines.push("", "## archive (waiting out grace)", formatArchiveSummary(archiveState));
    const text = lines.join("\n");
    const result = await copyWithFallback(text, "session");
    pushStatus(`session: ${result.where}; ${describeFallback(result)} (${text.split("\n").length} lines)`);
    return result;
  };

  /**
   * Pause or unpause the run (§9). The one implementation is in the runtime,
   * because the headless driver answers the same act; this only says what
   * happened and redraws.
   */
  const runPause = async () => {
    try {
      const outcome = await togglePause(state.session);
      // A pause is a transient UI notice, never a message to the agent.
      pushStatus(outcome.line);
    } catch (error) {
      pushStatus(`pause failed: ${errorText(error)}`);
    }
    await rebuildTranscript();
    tui.requestRender();
  };

  /**
   * Start or resume the agent without sending a person message (`ctrl+r` / `/resume`).
   * Unpauses a held stream without injecting a state block; non-action when
   * already running; otherwise sends a fresh `<carto-state/>` marker.
   */
  const runResume = async () => {
    if (state.collapsing) {
      pushStatus("collapsing — hold on");
      tui.requestRender();
      return;
    }
    if (state.running && !state.session.state.paused) return;
    const epoch = state.collapseEpoch;
    try {
      const outcome = await resumeSession(state.session);
      if (outcome.kind === "running") return;
      if (outcome.kind === "unpaused") {
        pushStatus(outcome.line);
        await rebuildTranscript();
        tui.requestRender();
        return;
      }
      if (outcome.submission === undefined) return;
      state.notes = [];
      state.activity.beginSubmission();
      headerState.running = state.running;
      pushStatus(outcome.line);
      tui.requestRender();
      try {
        const settled = await outcome.submission.wait(BACKGROUND_CONTEXT);
        await waitForRunEnd(state.session);
        if (settled.status !== "done" && epoch === state.collapseEpoch && !state.collapsing && state.session.state.collapseRequested === null) {
          pushStatus(`the run ended with status "${settled.status}"`);
        }
      } catch (error) {
        if (epoch === state.collapseEpoch && !state.collapsing) pushStatus(`the run failed: ${errorText(error)}`);
      }
      state.activity.endSubmission();
      headerState.running = state.running;
      if (shutdownRequested) return;
      await rebuildTranscript();
      await serviceCollapseRequest();
      if (options.refreshCapacity === true) await refreshAdvertisedWindow();
      await refreshSidebar();
      tui.requestRender();
    } catch (error) {
      if (!shutdownRequested) pushStatus(`resume failed: ${errorText(error)}`);
      tui.requestRender();
    }
  };

  const submitMessage = (message: string) => {
    // A line written while the agent is held in its stream lets go of that
    // stream first (§9): the held reply ends here, and this line is the next
    // thing the agent reads. Sending while merely paused is not this — nothing
    // is held, so there is nothing to let go, and the run continues (§9: "send
    // while paused behaves as if the run had not been paused").
    if (state.session.freeze.frozen()) {
      state.session.freeze.abandon();
      pushStatus("the held reply ends here — your line is the next thing");
    }
    state.pending.push({ text: message, at: Date.now(), mode: state.sendMode });
    void rebuildTranscript().catch(() => undefined);
    // Nothing awaits a submission: the run outlives the frame that started it
    // and settles after the person may have left, so a failure here is the
    // status line's business, never the process's.
    void runSubmission(message).catch((error: unknown) => {
      if (!shutdownRequested) pushStatus(`the run failed: ${errorText(error)}`);
    });
  };

  const switchModel = async (next: ModelRef) => {
    const label = formatModelRef(next);
    if (next.provider === state.model.provider && next.modelId === state.model.modelId) {
      pushStatus(`already using ${label}`);
      tui.requestRender();
      return;
    }
    try {
      await switchSessionModel(state.session, options.models, next);
      activeModel = { ...next };
      state.model = activeModel;
      headerState.modelLabel = modelLabel();
      headerState.windowUnknown = state.session.state.contextWindow <= 0;
      try {
        await options.onModelChange?.(next);
      } catch (persistError) {
        pushStatus(`model → ${label} (could not save config: ${errorText(persistError)})`);
        await rebuildTranscript();
        tui.requestRender();
        return;
      }
      pushStatus(state.running ? `model → ${label} (takes effect at the next step)` : `model → ${label}`);
      await rebuildTranscript();
      tui.requestRender();
    } catch (error) {
      pushStatus(`model switch failed: ${errorText(error)}`);
      tui.requestRender();
    }
  };

  const handleModelSlash = async (argument: string) => {
    const query = argument.trim();
    if (query.length === 0) {
      showModelPicker();
      return;
    }
    let resolved = resolveIndexedModel(options.models, query, state.model.provider);
    if (resolved === undefined) {
      await indexModels(options.models, { refresh: true, active: state.model });
      if (shutdownRequested) return;
      resolved = resolveIndexedModel(options.models, query, state.model.provider);
    }
    if (resolved !== undefined) {
      await switchModel(resolved);
      return;
    }
    showModelPicker(query);
  };

  editor.onSubmit = (text: string) => {
    const message = text.trim();
    if (message.length === 0) return;
    editor.addToHistory(message);
    const copy = copySlashCommand(message);
    if (copy !== undefined) {
      void (copy === "transcript" ? copyTranscript() : copySession()).catch((error: unknown) => {
        if (!shutdownRequested) pushStatus(`copy failed: ${errorText(error)}`);
      });
      return;
    }
    if (message === "/wipe") {
      showWipeConfirmation();
      return;
    }
    if (message === "/resume") {
      void runResume();
      return;
    }
    if (message === "/model" || message.startsWith("/model ")) {
      void handleModelSlash(message.slice("/model".length)).catch((error: unknown) => {
        if (!shutdownRequested) pushStatus(`model switch failed: ${errorText(error)}`);
      });
      return;
    }
    submitMessage(message);
  };

  /**
   * Ctrl-C, as bash does it: a line with text on it is cleared and nothing else
   * happens; an empty line arms leaving, and a second press inside the window
   * leaves. The arming is not a mode — it lapses, so an old stray Ctrl-C can
   * never turn the next one into a quit.
   */
  const pressCtrlC = () => {
    const typed = editor.getExpandedText();
    const decision = ctrlC({ typed, armedAt: state.ctrlCArmedAt, now: Date.now() });
    state.ctrlCArmedAt = decision.armedAt;
    if (decision.outcome.action === "cleared") {
      editor.setText("");
      tui.requestRender();
      return;
    }
    if (decision.outcome.action === "armed") {
      tui.flash(
        state.running ? "press ^c again to leave — the run stops with the session" : "press ^c again to leave",
        Math.min(decision.outcome.windowMs, CTRL_C_ARM_WINDOW_MS),
      );
      tui.requestRender();
      return;
    }
    void shutdown(0);
  };

  /**
   * Ctrl-G: write the message in `$VISUAL`/`$EDITOR` (§8's editor note in
   * `compose.ts`). The TUI is taken down first, because the editor needs the
   * terminal in its own mode; it is brought back up afterwards, and the file's
   * text becomes the prompt. Nothing is sent — the person still presses enter.
   *
   * A key the person wants and an editor that is not there are both worth
   * saying plainly, so a failure flashes the reason instead of looking dead.
   */
  const composeInPrompt = async () => {
    const before = editor.getExpandedText();
    // A stopped TUI must always come back: if the editor throws on the way out,
    // leaving `tui` stopped would hand the person a dead terminal with no way
    // to type, which is worse than a failed edit.
    let outcome: EditorOutcome;
    let stopped = false;
    try {
      tui.stop();
      stopped = true;
      outcome = await composeInEditor(before);
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (stopped) tui.start();
      tui.setFocus(editor);
      void rebuildTranscript().catch(() => undefined);
      tui.requestRender();
    }
    if (!outcome.ok) {
      tui.flash(`no editor: ${outcome.error}`, 4_000);
      tui.requestRender();
      return;
    }
    if (outcome.text === before) {
      // Leaving the file as it was is not an edit: the prompt is left alone, so
      // a glance in the editor cannot rewrite what was already on the line.
      return;
    }
    editor.setText(outcome.text);
    tui.requestRender();
  };

  // ── Commands ─────────────────────────────────────────────────────────────
  // One registry. The footer, `f1` and `^p` are views of this list; see
  // `commands.ts`. Order matters twice: input matching goes in declaration
  // order, and the footer shows the first ones that fit.
  const inChat = () => state.layer === "context" && state.view === "chat";
  const inView = (view: ViewMode) => state.layer === "context" && state.view === view;
  const onArchive = () => state.layer === "archive" && !archiveView.isFiltering();
  /** The book the person is in, when it is Atlas or Ledger. */
  const bookOf = () => (state.view === "atlas" ? atlasView : state.view === "ledger" ? ledgerView : undefined);
  /** A book is open and not taking a `/` filter, so its command keys are commands. */
  const bookIsOpen = () => state.layer === "context" && bookOf() !== undefined && bookOf()?.isFiltering() === false;

  /** The active view owns selection; text entry and filters must keep their keys. */
  const selectedText = (): string | undefined => {
    if (state.layer === "archive") return archiveView.isFiltering() ? undefined : archiveView.selectedText();
    switch (state.view) {
      case "chat": return transcript.selectedText();
      case "context": return contextView.selectedText();
      case "atlas": return atlasView.isFiltering() ? undefined : atlasView.selectedText();
      case "ledger": return ledgerView.isFiltering() ? undefined : ledgerView.selectedText();
      case "tree": return treeView.isFiltering() ? undefined : treeView.selectedText();
      case "jobs": return jobsView.isTyping() ? undefined : jobsView.selectedText();
    }
  };

  /** Select a durable book record by identity, never by its rendered text. */
  const selectedBookRecord = async (): Promise<{ record: EditableRecord; archived?: ArchivedItem }> => {
    let kind: "atlas" | "ledger" | "chat" | undefined;
    let id: string | undefined;
    if (state.layer === "archive") {
      const id = archiveView.isFiltering() ? undefined : archiveView.selectedItem()?.id;
      const archived = (await brain.readArchive()).items.find((item) => item.id === id);
      if (archived?.record === undefined) throw new Error("No archived record is selected.");
      return { record: archived.record as EditableRecord, archived };
    }
    if (state.view === "atlas" && !atlasView.isFiltering()) { kind = "atlas"; id = atlasView.selectedId(); }
    else if (state.view === "ledger" && !ledgerView.isFiltering()) { kind = "ledger"; id = ledgerView.selectedId(); }
    else if (state.view === "context") {
      const target = contextView.selectedEntry()?.target;
      if (target?.part === "atlas" || target?.part === "ledger" || target?.part === "chat") { kind = target.part; id = String(target.id); }
    } else if (state.view === "chat") {
      const target = transcript.selectedTarget();
      if (target?.part === "chat") { kind = "chat"; id = target.id; }
    }
    if (kind === undefined || id === undefined) throw new Error("No editable record is selected.");
    const current = await brain.read();
    if (kind === "atlas") {
      const value = current.atlas.find((item) => item.id === id);
      if (value !== undefined) return { record: { kind, value } };
    } else if (kind === "ledger") {
      const value = current.ledger.find((item) => item.id === id);
      if (value !== undefined) return { record: { kind, value } };
    } else {
      const value = current.chat.find((item) => item.id === id);
      if (value !== undefined) return { record: { kind, value } };
    }
    throw new Error("The selected record is no longer in the Brain.");
  };

  const editSelectedBookRecord = async (selectedRecord?: EditableRecord) => {
    const selected = selectedRecord === undefined ? await selectedBookRecord() : { record: selectedRecord, archived: undefined };
    const session = state.session;
    if (selected.archived?.restorePending === true) {
      await editScratch(JSON.stringify(selected.record.value, null, 2) + "\n");
      return;
    }
    const inFrozenChat = async () => {
      const sidecar = JSON.parse(await readFile(snapshotPaths(options.root, session.generation).sidecar, "utf8")) as { chat?: unknown };
      return Array.isArray(sidecar.chat) && sidecar.chat.includes(selected.record.value.id);
    };
    let liveChat: Awaited<ReturnType<typeof readLiveChatEdit>> | undefined;
    if (selected.archived === undefined && selected.record.kind === "chat" && !(await inFrozenChat().catch(() => false))) {
      try { liveChat = await readLiveChatEdit(session, selected.record.value); }
      catch { await editScratch(JSON.stringify(selected.record.value, null, 2) + "\n"); return; }
    }
    const before = JSON.stringify(selected.record.value, null, 2) + "\n";
    let outcome: EditorOutcome;
    let stopped = false;
    try {
      tui.stop(); stopped = true;
      outcome = await composeInEditor(before);
    } catch (error) {
      outcome = { ok: false, error: errorText(error) };
    } finally {
      if (stopped) tui.start();
      focusCurrent();
      tui.requestRender();
    }
    if (!outcome.ok) { pushStatus(`editor failed: ${outcome.error}`); tui.requestRender(); return; }
    if (outcome.text === before) return;
    try {
      if (selected.archived !== undefined) {
        await brain.editArchivedRecord(selected.archived, outcome.text, Date.now());
        await refreshArchive();
        pushStatus(`Edited archived ${selected.record.kind}.`);
      } else {
        if (selected.record.kind === "chat" && (state.session !== session || state.collapsing)) throw new Error("The Chat context changed while the editor was open.");
        if (liveChat !== undefined) {
          await editLiveChat(session, liveChat, outcome.text, Date.now());
          pushStatus("Edited the Chat record and live context.");
        } else {
          if (selected.record.kind === "chat" && !(await inFrozenChat())) throw new Error("The Chat context changed while the editor was open.");
          await brain.editBookRecord(selected.record, outcome.text, Date.now());
          pushStatus(`Edited ${selected.record.kind}; the frozen head refreshes at collapse.`);
        }
        await refreshBrainViews();
        await rebuildTranscript();
      }
      await refreshSidebar();
    } catch (error) {
      // Never discard text when validation fails or another writer wins.
      try {
        const dir = await mkdtemp(join(tmpdir(), "carto-edit-recovery-"));
        const path = join(dir, "record.json");
        await writeFile(path, outcome.text, { encoding: "utf8", mode: 0o600 });
        pushStatus(`Edit failed: ${errorText(error)} Draft saved at ${path}`);
      } catch (saveError) {
        pushStatus(`Edit failed: ${errorText(error)}; saving the draft failed: ${errorText(saveError)}`);
      }
    }
    tui.requestRender();
  };

  const editArchivedEphemeral = async () => {
    const id = archiveView.selectedItem()?.id;
    const item = (await brain.readArchive()).items.find((candidate) => candidate.id === id);
    if (item?.ephemeral === undefined) throw new Error("The selected archive item is no longer available.");
    let before: string;
    try {
      before = archivedEphemeralText(item);
      validateArchivedEphemeralEdit(item, before);
    } catch {
      await editScratch(item.ephemeral.text);
      return;
    }
    let outcome: EditorOutcome;
    let stopped = false;
    try {
      tui.stop(); stopped = true;
      outcome = await composeInEditor(before);
    } catch (error) {
      outcome = { ok: false, error: errorText(error) };
    } finally {
      if (stopped) tui.start();
      focusCurrent();
      tui.requestRender();
    }
    if (!outcome.ok) { pushStatus(`editor failed: ${outcome.error}`); tui.requestRender(); return; }
    if (outcome.text === before) return;
    try {
      await brain.editArchivedEphemeral(item, outcome.text);
      await refreshArchive();
      pushStatus("Edited the archived item and its restore payload.");
    } catch (error) {
      try {
        const dir = await mkdtemp(join(tmpdir(), "carto-edit-recovery-"));
        const path = join(dir, "archive-draft.txt");
        await writeFile(path, outcome.text, { encoding: "utf8", mode: 0o600 });
        pushStatus(`Edit not applied: ${errorText(error)} Draft saved at ${path}`);
      } catch (saveError) {
        pushStatus(`Edit not applied: ${errorText(error)}; saving the draft failed: ${errorText(saveError)}`);
      }
    }
    tui.requestRender();
  };

  const selectedLiveWorkId = (): string | undefined => {
    if (state.layer !== "context") return undefined;
    const target = state.view === "chat" ? transcript.selectedTarget() : state.view === "context" ? contextView.selectedEntry()?.target : undefined;
    return target?.part === "tool-work" || target?.part === "ephemera" || target?.part === "transcript" ? String(target.id) : undefined;
  };

  const editSelectedLiveWork = async (id: string) => {
    const session = state.session;
    const chat = await chatRecordForLiveWork(session, id);
    if (chat !== undefined) { await editSelectedBookRecord({ kind: "chat", value: chat }); return; }
    const pin = (await brain.read()).ephemera.find((item) => item.id === id);
    if (pin?.kind === "readResult" && pin.entity?.path !== undefined) {
      // A read pin is refreshed from the file at collapse, so editing its
      // cached quotation would be silently overwritten.
      editSource(resolve(options.root, pin.entity.path));
      return;
    }
    if (pin !== undefined && !id.startsWith(`${session.generation}:`)) {
      let before = pin.text;
      if (pin.kind === "toolCall") {
        const separator = pin.text.indexOf(" ");
        if (separator < 1) { await editScratch(pin.text); return; }
        try { before = JSON.stringify(JSON.parse(pin.text.slice(separator + 1)), null, 2) + "\n"; }
        catch { await editScratch(pin.text); return; }
      }
      let outcome: EditorOutcome;
      let stopped = false;
      try { tui.stop(); stopped = true; outcome = await composeInEditor(before); }
      catch (error) { outcome = { ok: false, error: errorText(error) }; }
      finally { if (stopped) tui.start(); focusCurrent(); tui.requestRender(); }
      if (!outcome.ok) { pushStatus(`editor failed: ${outcome.error}`); return; }
      if (outcome.text === before) return;
      try {
        if (state.session !== session || state.collapsing) throw new Error("The session changed while the editor was open.");
        await brain.editPinnedEphemeral(pin, outcome.text);
        await rebuildTranscript();
        pushStatus("Edited the pin; its new content enters the head at collapse.");
      } catch (error) {
        try {
          const dir = await mkdtemp(join(tmpdir(), "carto-edit-recovery-"));
          const path = join(dir, pin.kind === "toolCall" ? "pin.json" : "pin.txt");
          await writeFile(path, outcome.text, { encoding: "utf8", mode: 0o600 });
          pushStatus(`Edit not applied: ${errorText(error)} Draft saved at ${path}`);
        } catch (saveError) { pushStatus(`Edit not applied: ${errorText(error)}; saving the draft failed: ${errorText(saveError)}`); }
      }
      tui.requestRender();
      return;
    }
    if ([...(await frozenItemsOf()).values()].some((item) => item.id === id)) {
      await editScratch(selectedText() ?? "");
      return;
    }
    let snapshot: Awaited<ReturnType<typeof readLiveWorkEdit>>;
    try { snapshot = await readLiveWorkEdit(session, id); }
    catch { await editScratch(selectedText() ?? ""); return; }
    let outcome: EditorOutcome;
    let stopped = false;
    try {
      tui.stop(); stopped = true;
      outcome = await composeInEditor(snapshot.text);
    } catch (error) {
      outcome = { ok: false, error: errorText(error) };
    } finally {
      if (stopped) tui.start();
      focusCurrent();
      tui.requestRender();
    }
    if (!outcome.ok) { pushStatus(`editor failed: ${outcome.error}`); return; }
    if (outcome.text === snapshot.text) return;
    try {
      if (state.session !== session || state.collapsing) throw new Error("The session changed while the editor was open.");
      await editLiveWork(session, snapshot, outcome.text);
      await rebuildTranscript();
      pushStatus("Edited the live context item.");
    } catch (error) {
      try {
        const dir = await mkdtemp(join(tmpdir(), "carto-edit-recovery-"));
        const path = join(dir, snapshot.kind === "call" ? "work.json" : "work.txt");
        await writeFile(path, outcome.text, { encoding: "utf8", mode: 0o600 });
        pushStatus(`Edit failed: ${errorText(error)} Draft saved at ${path}`);
      } catch (saveError) {
        pushStatus(`Edit failed: ${errorText(error)}; saving the draft failed: ${errorText(saveError)}`);
      }
    }
    tui.requestRender();
  };

  const selectedSourcePath = (): string | undefined => {
    if (state.layer !== "context") return undefined;
    if (state.view === "tree" && !treeView.isFiltering()) {
      const entry = treeView.selectedEntry();
      return entry === undefined || entry.directory ? undefined : entry.path;
    }
    if (state.view === "context") {
      const node = contextView.selectedEntry();
      const target = node?.target;
      if (target?.part === "files") return resolve(options.root, String(target.id));
      if (node?.kind === "system") return fileURLToPath(new URL("../../src/runtime/carto-extension.ts", import.meta.url));
      if (target?.part === "tools" && ["create", "chat", "atlas", "ledger", "pin", "mark", "tree", "collapse", "sleep", "proc"].includes(String(target.id))) {
        return fileURLToPath(new URL("../../src/runtime/tools.ts", import.meta.url));
      }
    }
    return undefined;
  };

  const editSource = (path: string) => {
    if (state.overlayOpen) return;
    state.overlayOpen = true;
    const dialog = new SourceEditConfirmation(path);
    dialog.onClose = closeOverlay;
    dialog.onConfirm = () => {
      closeOverlay();
      void (async () => {
        let stopped = false;
        try {
          tui.stop(); stopped = true;
          const result = await editSourceFile(path);
          pushStatus(result.ok ? `Editor closed: ${path}` : `Editor: ${result.error}`);
        } catch (error) {
          pushStatus(`Editor failed: ${errorText(error)}`);
        } finally {
          if (stopped) tui.start();
          focusCurrent();
          await refreshBrainViews().catch(() => undefined);
          tui.requestRender();
        }
      })();
    };
    state.overlayHandle = tui.showOverlay(dialog, { width: 78, anchor: "center" });
    tui.setFocus(dialog);
    tui.requestRender();
  };

  /** Runtime-generated selections have no writable record; keep a scratch file instead. */
  const selectedScratchText = (): string | undefined => {
    if (state.layer !== "context") return undefined;
    if (state.view === "context" && contextView.selectedEntry()?.kind === "state") return contextView.selectedText();
    if (state.view === "jobs" && !jobsView.isTyping()) return jobsView.selectedText();
    if (state.view === "tree" && !treeView.isFiltering() && treeView.selectedEntry()?.directory) return treeView.selectedText();
    return undefined;
  };

  const editScratch = async (text: string) => {
    const dir = await mkdtemp(join(tmpdir(), "carto-scratch-"));
    const path = join(dir, "scratch.txt");
    await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
    let stopped = false;
    try {
      tui.stop(); stopped = true;
      const result = await editSourceFile(path);
      pushStatus(result.ok ? `Scratch copy saved at ${path}; the original is unchanged.` : `Scratch at ${path}: ${result.error}`);
    } finally {
      if (stopped) tui.start();
      focusCurrent();
      tui.requestRender();
    }
  };

  const copySelected = async (text: string) => {
    try {
      const result = await copyWithFallback(text, "selection");
      pushStatus(`selection — ${result.where}; ${describeFallback(result)}`);
    } catch (error) {
      pushStatus(`selection copy failed: ${errorText(error)}`);
    }
  };

  const commands = new Registry([
    {
      id: "help",
      group: "anywhere",
      label: "shortcuts",
      key: "f1",
      run: () => showHelp(),
      available: () => true,
    },
    {
      id: "palette",
      group: "anywhere",
      label: "palette",
      key: "ctrl+p",
      run: () => showPalette(),
      available: () => true,
    },
    {
      id: "jump",
      group: "anywhere",
      label: "jump to a view",
      key: "ctrl+o",
      run: () => showJump(),
      available: () => true,
    },
    {
      // Bash-like, and the person's ask: ^c clears the line it finds text on,
      // and leaves when pressed again on an empty one. Both presses are the
      // same key, so both are one command; `^c stop` is `ctrl+x` and is not
      // this (§9: stopping is an interrupt, leaving is leaving).
      id: "ctrl-c",
      group: "the message",
      label: "clear the line, twice to leave",
      key: "ctrl+c",
      run: () => pressCtrlC(),
      available: () => true,
    },
    {
      id: "compose",
      group: "the message",
      label: "write the message in your editor",
      hint: "$VISUAL, else $EDITOR",
      key: "ctrl+g",
      run: () => void composeInPrompt(),
      // Only where there is a message to write, and only with the terminal to
      // itself: an editor opened over an overlay would fight it for the screen.
      available: () => inChat() && !transcript.isSelecting() && !state.overlayOpen,
    },
    {
      id: "edit-record",
      group: "the record",
      label: "edit selected record",
      hint: "$VISUAL, else $EDITOR; JSON",
      key: "ctrl+g",
      run: () => void editSelectedBookRecord().catch((error: unknown) => { pushStatus(`edit failed: ${errorText(error)}`); tui.requestRender(); }),
      available: () => !state.overlayOpen && (
        (state.layer === "archive" && !archiveView.isFiltering() && archiveView.selectedItem()?.record !== undefined) ||
        (state.layer === "context" && (
          (state.view === "atlas" && !atlasView.isFiltering() && atlasView.selectedId() !== undefined) ||
          (state.view === "ledger" && !ledgerView.isFiltering() && ledgerView.selectedId() !== undefined) ||
          (state.view === "context" && ["atlas", "ledger", "chat"].includes(contextView.selectedEntry()?.target?.part ?? "")) ||
          (state.view === "chat" && transcript.selectedTarget()?.part === "chat")
        ))
      ),
    },
    {
      id: "edit-archived-ephemeral",
      group: "the record",
      label: "edit selected archived item",
      hint: "tool-call arguments use JSON",
      key: "ctrl+g",
      run: () => void editArchivedEphemeral().catch((error: unknown) => { pushStatus(`edit failed: ${errorText(error)}`); tui.requestRender(); }),
      available: () => !state.overlayOpen && state.layer === "archive" && !archiveView.isFiltering() && archiveView.selectedItem()?.ephemeral !== undefined,
    },
    {
      id: "edit-live-work",
      group: "the record",
      label: "edit selected live work",
      hint: "tool-call arguments use JSON",
      key: "ctrl+g",
      run: () => { const id = selectedLiveWorkId(); if (id !== undefined) void editSelectedLiveWork(id).catch((error: unknown) => { pushStatus(`edit failed: ${errorText(error)}`); tui.requestRender(); }); },
      available: () => !state.overlayOpen && selectedLiveWorkId() !== undefined,
    },
    {
      id: "edit-source",
      group: "the record",
      label: "edit selected source file",
      hint: "confirmation required",
      key: "ctrl+g",
      run: () => { const path = selectedSourcePath(); if (path !== undefined) editSource(path); },
      available: () => !state.overlayOpen && selectedSourcePath() !== undefined,
    },
    {
      id: "edit-scratch",
      group: "the record",
      label: "open a scratch copy",
      hint: "does not change runtime state",
      key: "ctrl+g",
      run: () => { const text = selectedScratchText(); if (text !== undefined) void editScratch(text).catch((error: unknown) => { pushStatus(`scratch failed: ${errorText(error)}`); tui.requestRender(); }); },
      available: () => !state.overlayOpen && selectedScratchText() !== undefined,
    },
    {
      id: "edit-unavailable",
      group: "the record",
      label: "open selected item as a scratch copy",
      hint: "does not change the original",
      key: "ctrl+g",
      run: () => { const text = selectedText(); if (text !== undefined) void editScratch(text).catch((error: unknown) => { pushStatus(`scratch failed: ${errorText(error)}`); tui.requestRender(); }); },
      available: () => !state.overlayOpen && selectedText() !== undefined,
    },
    {
      id: "quit",
      group: "anywhere",
      label: "quit",
      // No key of its own: ^c twice is how a person leaves, and a separate
      // binding that also quit would be a second way to lose a run by accident.
      run: () => void shutdown(0),
      available: () => true,
    },
    {
      id: "wipe",
      group: "the workspace",
      label: "wipe project session and start fresh",
      hint: "permanently delete .brain; confirmation required",
      run: () => showWipeConfirmation(),
      available: () => true,
    },
    stopCommand(() => {
      // Admissions also serialize collapse: a stop pressed during replacement
      // targets the newly opened session rather than a closing harness.
      void admitting(() => interruptRun(state.session))
        .then(
          (interrupted) => pushStatus(interrupted ? "interrupt sent — the run stops" : "no run to stop"),
          (error: unknown) => pushStatus(`interrupt failed: ${errorText(error)}`),
        )
        .then(() => rebuildTranscript())
        .catch(() => undefined);
    }),
    {
      id: "resume",
      group: "the run",
      label: "resume",
      hint: "start or resume with a fresh state block (or let a held reply finish)",
      key: "ctrl+r",
      run: () => void runResume(),
      available: () => !state.running || state.session.state.paused,
    },
    {
      id: "pause",
      group: "the run",
      // The label says what pressing it does, so the palette reads as an act
      // and the footer reads as one line (§9).
      label: state.session.state.paused ? "let the run go on" : "pause the run",
      hint: "holds the reply where it is; a line you send ends it",
      key: "ctrl+v",
      run: () => void runPause(),
      available: () => true,
    },
    {
      id: "send-mode",
      group: "the run",
      label: "send mode",
      hint: "steer · after run · now",
      key: "shift+tab",
      run: () => {
        state.sendMode = nextSendMode(state.sendMode);
        tui.flash(`send mode: ${sendModeLabel(state.sendMode)}`, 1_200);
        tui.requestRender();
      },
      available: () => inChat(),
    },
    {
      id: "collapse",
      group: "the run",
      label: "collapse now",
      run: () => void runCollapse("person requested (palette)"),
      available: () => true,
    },
    {
      id: "model",
      group: "the run",
      label: "switch model",
      hint: "pick a model from the provider catalog",
      key: "ctrl+l",
      quiet: true,
      run: () => showModelPicker(),
      available: () => true,
    },
    {
      id: "prompt-fold",
      group: "the context",
      label: "fold every entry",
      hint: "enter folds one entry or a whole section",
      key: "shift+e",
      run: () => {
        contextView.toggleAll();
        tui.requestRender();
      },
      available: () => state.view === "context" && state.layer === "context",
    },
    {
      id: "fold-all",
      group: "the transcript",
      label: "fold the cards",
      key: "ctrl+e",
      run: () => {
        transcript.toggleAllCards();
        tui.requestRender();
      },
      available: () => inChat(),
    },
    // Block selection: Escape from the prompt walks the transcript a block at a
    // time, and the keys are the ones every other view has (§3.2, §4.1). They
    // are commands in the same list, so the footer, `f1` and the palette name
    // them; the cursor keys are the view's own.
    {
      id: "block-select",
      group: "the transcript",
      label: "select a block",
      hint: "walk the Chat and cards with j/k; y copies, and eligible items can be pinned or marked",
      key: "escape",
      run: () => enterBlockSelection(),
      // Escape closes the prompt's completion list first.
      available: () => inChat() && !transcript.isSelecting() && !editor.isShowingAutocomplete(),
    },
    {
      id: "block-leave",
      group: "the transcript",
      label: "back to the prompt",
      key: "escape",
      run: () => leaveBlockSelection(),
      available: () => inChat() && transcript.isSelecting(),
    },
    {
      id: "block-pin",
      group: "the transcript",
      label: "pin or unpin the card",
      hint: "a pinned item in the live context goes on into the next collapse; Chat has no pin",
      key: "p",
      run: () => transcript.pinSelected(),
      available: () => inChat() && (transcript.selectedPart() === "tool-work" || transcript.selectedPart() === "ephemera"),
    },
    {
      id: "block-mark-archive",
      group: "the transcript",
      label: "mark for archive",
      hint: "the next collapse moves it to the archive; `!` first applies it now",
      key: "a",
      run: () => transcript.markSelected("archive"),
      available: () => inChat() && transcript.selectedPart() !== undefined,
    },
    {
      id: "block-mark-delete",
      group: "the transcript",
      label: "mark for delete",
      hint: "the next collapse removes it for good; `!` first applies it now",
      key: "d",
      run: () => transcript.markSelected("delete"),
      available: () => inChat() && transcript.selectedPart() !== undefined,
    },
    {
      id: "block-apply-now",
      group: "the transcript",
      label: "apply now",
      hint: "the next mark is applied at once, rebuilding in place",
      key: "!",
      run: () => {
        transcript.toggleApplyNow();
        tui.requestRender();
      },
      available: () => inChat() && transcript.isSelecting(),
    },
    {
      id: "block-withdraw",
      group: "the transcript",
      label: "withdraw the mark",
      key: "u",
      quiet: true,
      run: () => transcript.withdrawSelected(),
      available: () => inChat() && transcript.isSelecting(),
    },
    {
      id: "read-only",
      group: "the workspace",
      label: "read only mode",
      hint: "flips whether the agent may change files",
      run: () => toggleReadOnly(),
      available: () => true,
    },
    {
      id: "path-scope",
      group: "the workspace",
      label: "strict / relaxed file scope",
      hint: "relaxed lets read and edit use paths outside the project",
      run: () => togglePathScope(),
      available: () => true,
    },
    {
      id: "sidebar",
      group: "the workspace",
      label: "sidebar",
      key: "ctrl+h",
      run: () => {
        state.sidebarVisible = !state.sidebarVisible;
        focusCurrent();
        tui.requestRender();
      },
      available: () => true,
    },
    {
      id: "pin-context-row",
      group: "the workspace",
      label: "pin or unpin the entry under the cursor",
      hint: "a pinned item in the live context goes on into the next collapse; a Brain entry is pinned only in the archive",
      key: "p",
      // The Context view matches the key itself, because it knows where the
      // cursor is; the palette comes here, so it does the same act.
      run: () => contextView.pinSelected(),
      available: () => state.view === "context" && state.layer === "context",
    },
    // The same acts on the other views of the Brain (§4.1, §3.2). The views match
    // these keys too, because they know where the cursor is; the palette comes
    // here, and the footer and `f1` read them. Each is unavailable while the
    // view is taking a `/` filter, because then the key is a letter of it.
    {
      id: "pin-tree-file",
      group: "the workspace",
      label: "pin or unpin the file under the cursor",
      hint: "a pinned file is read again at every collapse, so the head holds it as it stands",
      key: "p",
      run: () => treeView.pinSelected(),
      available: () => inView("tree") && !treeView.isFiltering(),
    },
    {
      id: "book-mark-archive",
      group: "the context",
      label: "mark for archive",
      hint: "the next collapse moves it to the archive; `!` first applies it now",
      key: "a",
      run: () => bookOf()?.controls.mark(bookOf()?.selectedId(), "archive"),
      available: () => bookIsOpen(),
    },
    {
      id: "book-mark-delete",
      group: "the context",
      label: "mark for delete",
      hint: "the next collapse removes it for good; `!` first applies it now",
      key: "d",
      run: () => bookOf()?.controls.mark(bookOf()?.selectedId(), "delete"),
      available: () => bookIsOpen(),
    },
    {
      id: "book-apply-now",
      group: "the context",
      label: "apply now",
      hint: "the next mark is applied at once, rebuilding in place",
      key: "!",
      run: () => {
        bookOf()?.controls.toggleApplyNow();
        tui.requestRender();
      },
      available: () => bookIsOpen(),
    },
    {
      id: "book-withdraw",
      group: "the context",
      label: "withdraw the mark",
      key: "u",
      quiet: true,
      run: () => bookOf()?.controls.withdraw(bookOf()?.selectedId()),
      available: () => bookIsOpen(),
    },
    {
      id: "collapse-from-view",
      group: "the run",
      label: "collapse now (applies the marks)",
      hint: "the same collapse the Context view's `c` runs",
      key: "c",
      run: () => void runCollapse("context surgery"),
      available: () => bookIsOpen() || (inView("tree") && !treeView.isFiltering()),
    },
    // The two marks the agent's `mark` tool can place, and the act that applies
    // either of them at once (§4.1). They are declared here for the same reason
    // the archive's are: the footer, `f1` and the palette all read one list, so
    // the person can find every operation the agent has.
    {
      id: "context-mark-archive",
      group: "the context",
      label: "mark for archive",
      hint: "the next collapse moves it to the archive; `!` first applies it now",
      key: "a",
      run: () => contextView.markSelected("archive"),
      available: () => state.view === "context" && state.layer === "context",
    },
    {
      id: "context-mark-delete",
      group: "the context",
      label: "mark for delete",
      hint: "the next collapse removes it for good; `!` first applies it now",
      key: "d",
      run: () => contextView.markSelected("delete"),
      available: () => state.view === "context" && state.layer === "context",
    },
    {
      id: "context-apply-now",
      group: "the context",
      label: "apply now",
      hint: "the next mark is applied at once, rebuilding in place",
      key: "!",
      run: () => {
        contextView.toggleApplyNow();
        tui.requestRender();
      },
      available: () => state.view === "context" && state.layer === "context",
    },
    {
      id: "context-withdraw",
      group: "the context",
      label: "withdraw the mark",
      key: "u",
      // A withdrawal is the quiet half of the pair: `f1` and the palette carry
      // it, and the footer spends its width on the marks themselves.
      quiet: true,
      run: () => contextView.withdrawSelected(),
      available: () => state.view === "context" && state.layer === "context",
    },
    {
      id: "archive",
      group: "the workspace",
      label: "the archive layer",
      hint: "the person's, never the agent's",
      key: "ctrl+t",
      run: () => void toggleLayer(),
      available: () => true,
    },
    // What the person can do on the archive layer, named where every other act
    // is named: the footer, `f1` and the palette all read this list.
    {
      id: "archive-filter",
      group: "the archive",
      label: "filter the archive",
      hint: "search content and metadata; enter or escape ends editing",
      key: "/",
      run: () => { archiveView.handleInput("/"); tui.requestRender(); },
      available: onArchive,
    },
    {
      id: "archive-detail",
      group: "the archive",
      label: "open or close full item",
      hint: "scroll to read the complete content and stored fields",
      key: "enter",
      run: () => { archiveView.handleInput("\r"); tui.requestRender(); },
      available: onArchive,
    },
    {
      id: "archive-now",
      group: "the archive",
      label: "apply restore now",
      hint: "then r; deleting now always takes two d presses",
      key: "!",
      run: () => { archiveView.handleInput("!"); tui.requestRender(); },
      available: onArchive,
    },
    {
      id: "archive-pin",
      group: "the archive",
      label: "pin or unpin the item",
      hint: "a pinned item is never dropped",
      // The archive view matches these itself, because it knows the cursor; they
      // are declared here so the footer, `f1` and the palette name them (§3.3:
      // the same UI, so the same list).
      key: "p",
      run: () => archiveView.pinSelected(),
      available: onArchive,
    },
    {
      id: "archive-restore",
      group: "the archive",
      label: "mark it for restore",
      hint: "at the next collapse; `!r` restores it now",
      key: "r",
      run: () => {
        archiveView.restoreSelected();
        tui.requestRender();
      },
      available: onArchive,
    },
    {
      id: "archive-withdraw",
      group: "the archive",
      label: "withdraw the mark",
      key: "u",
      run: () => {
        if (!archiveView.withdrawSelected()) pushStatus("nothing is marked here");
        tui.requestRender();
      },
      available: onArchive,
    },
    {
      id: "archive-delete",
      group: "the archive",
      label: "mark it for delete",
      hint: "takes a second press to delete now",
      key: "d",
      run: () => {
        // One act behind one implementation: the key, the palette and `f1` all
        // come here, so the two presses cannot be had from a second route.
        if (archiveView.deleteSelected() === "marked") pushStatus("marked for delete; `d` again applies it now");
        tui.requestRender();
      },
      available: onArchive,
    },
    {
      id: "view-chat",
      group: "go to",
      label: "the transcript",
      run: () => void switchToView("chat"),
      available: () => !inChat(),
    },
    {
      id: "view-jobs",
      group: "go to",
      label: "jobs",
      hint: "persistent piped processes and live console",
      run: () => void switchToView("jobs"),
      available: () => !inView("jobs"),
    },
    {
      id: "jobs-send",
      group: "jobs",
      label: "send stdin",
      key: "i",
      run: () => {
        jobsView.enterSend();
        tui.requestRender();
      },
      available: () => inView("jobs") && !jobsView.isTyping() && jobsView.selectedJob()?.status === "running",
    },
    {
      id: "jobs-start",
      group: "jobs",
      label: "start job",
      key: "n",
      run: () => {
        jobsView.enterStart();
        tui.requestRender();
      },
      available: () => inView("jobs") && !jobsView.isTyping(),
    },
    {
      id: "jobs-signal",
      group: "jobs",
      label: "SIGINT",
      key: "s",
      run: () => {
        jobsView.signalSelected("SIGINT");
        tui.requestRender();
      },
      available: () => inView("jobs") && !jobsView.isTyping() && jobsView.selectedJob()?.status === "running",
    },
    {
      id: "jobs-stop",
      group: "jobs",
      label: "stop job",
      key: "d",
      run: () => {
        jobsView.stopSelected();
        tui.requestRender();
      },
      available: () => inView("jobs") && !jobsView.isTyping() && jobsView.selectedJob() !== undefined,
    },
    {
      id: "view-atlas",
      group: "go to",
      label: "the atlas",
      run: () => void switchToView("atlas"),
      available: () => !inView("atlas"),
    },
    {
      id: "view-ledger",
      group: "go to",
      label: "the ledger",
      run: () => void switchToView("ledger"),
      available: () => !inView("ledger"),
    },
    {
      id: "view-tree",
      group: "go to",
      label: "the tree",
      hint: "the project under its handles, as the harness sees it",
      run: () => void switchToView("tree"),
      available: () => !inView("tree"),
    },
    {
      id: "view-context",
      group: "go to",
      label: "the context",
      hint: "what the model reads, and surgery on it",
      run: () => void switchToView("context"),
      available: () => !inView("context"),
    },
    copySelectionCommand(selectedText, (text) => void copySelected(text)),
    {
      id: "copy",
      group: "the record",
      label: "copy the transcript",
      key: "ctrl+y",
      run: () => void copyTranscript().catch((error: unknown) => pushStatus(`copy failed: ${errorText(error)}`)),
      available: () => true,
    },
    {
      id: "copy-session",
      group: "the record",
      label: "copy a full session dump",
      run: () => void copySession().catch((error: unknown) => pushStatus(`copy failed: ${errorText(error)}`)),
      available: () => true,
    },
    {
      id: "back",
      group: "anywhere",
      label: "back to the transcript",
      key: "escape",
      run: () => void switchToView("chat"),
      available: () => state.layer === "context" && state.view !== "chat" && !(state.view === "jobs" && jobsView.isTyping()),
    },
  ] satisfies Command[]);

  function footerHints(): Array<{ key: string; label: string }> {
    return commands.footer().map((command) => ({
      key: keyText(command.key ?? ""),
      label: command.key === "shift+tab" ? `${command.label}: ${sendModeLabel(state.sendMode)}` : command.label,
    }));
  }

  const helpExtras = (): HelpExtra[] => [
    { group: "type it", key: "ctrl+shift+f", label: "search the viewport" },
    { group: "type it", key: "/copy", label: "copy the transcript" },
    { group: "type it", key: "/copy-session", label: "full diagnostic dump of the session" },
    { group: "type it", key: "/help", label: "the command list in the transcript" },
    { group: "type it", key: "/model", label: "pick or switch the model (/model <name>)" },
    { group: "type it", key: "/resume", label: "start or resume the agent with a fresh state block" },
    { group: "type it", key: "/wipe", label: "confirm permanent deletion of this project's Carto state" },
    { group: "type it", key: "/pause", label: "hold the run where it is (/pause off lets it go on)" },
  ];

  const showHelp = () => {
    if (state.overlayOpen) return;
    state.overlayOpen = true;
    const panel = new HelpPanel(commands.all(), helpExtras);
    panel.onClose = closeOverlay;
    state.overlayHandle = tui.showOverlay(panel, { width: "70%", maxHeight: "80%", anchor: "center" });
    tui.setFocus(panel);
    tui.requestRender();
  };

  const paletteCommands = (): PaletteCommand[] => {
    const list: PaletteCommand[] = commands.all()
      .filter((command) => {
        try {
          return command.available();
        } catch {
          return false;
        }
      })
      .map((command) => ({
        id: command.id,
        group: command.group,
        label: command.id === "model" ? `Model: ${modelLabel()}` : command.label,
        ...(command.key === undefined ? {} : { key: command.key }),
        ...(command.hint === undefined ? {} : { hint: command.hint }),
        run: () => command.run(),
      }));
    // Conditional, dynamically-named entries, as Posting does: the palette names
    // the layer it would take you to, not a fixed string.
    list.push({
      id: "layer-name",
      group: "the workspace",
      label: state.layer === "archive" ? "Layer: back to the context" : "Layer: the archive",
      run: () => void toggleLayer(),
    });
    list.push({
      id: "send-mode-name",
      group: "the run",
      label: `Send: ${sendModeLabel(state.sendMode)}`,
      run: () => {
        state.sendMode = nextSendMode(state.sendMode);
        tui.requestRender();
      },
    });
    list.push({
      id: "read-only-name",
      group: "the workspace",
      label: state.session.state.readOnly ? "Mode: back to editing" : "Mode: read only",
      run: () => toggleReadOnly(),
    });
    list.push({
      id: "path-scope-name",
      group: "the workspace",
      label: state.session.state.pathScope === "relaxed" ? "File scope: strict" : "File scope: relaxed",
      run: () => togglePathScope(),
    });
    return list;
  };

  const showPalette = () => {
    if (state.overlayOpen) return;
    state.overlayOpen = true;
    const palette = new Palette(paletteCommands());
    palette.onClose = closeOverlay;
    state.overlayHandle = tui.showOverlay(palette, { width: 64, anchor: "bottom-center", offsetY: -3 });
    tui.setFocus(palette);
    tui.requestRender();
  };

  const showWipeConfirmation = () => {
    if (state.overlayOpen || shutdownRequested) return;
    state.overlayOpen = true;
    const dialog = new WipeConfirmation(options.root);
    dialog.onClose = closeOverlay;
    dialog.onConfirm = () => { closeOverlay(); void shutdown(WIPE_REQUESTED); };
    state.overlayHandle = tui.showOverlay(dialog, { width: 78, anchor: "center" });
    tui.setFocus(dialog);
    tui.requestRender();
  };

  const showModelPicker = (initialQuery?: string) => {
    if (state.overlayOpen) return;
    state.overlayOpen = true;
    const picker = new ModelPicker({
      models: listIndexedModels(options.models, state.model),
      activeLabel: modelLabel(),
      running: state.running,
      loading: true,
      ...(initialQuery === undefined ? {} : { initialQuery }),
    });
    activeModelPicker = picker;
    const refreshCatalog = () => {
      picker.setLoading(true);
      tui.requestRender();
      void indexModels(options.models, { refresh: true, active: state.model }).then((result) => {
        if (shutdownRequested || activeModelPicker !== picker) return;
        const firstError = result.errors[0];
        picker.setModels(result.models, {
          activeLabel: modelLabel(),
          running: state.running,
          loading: false,
          ...(firstError === undefined ? {} : { error: `${firstError.provider}: ${firstError.message}` }),
        });
        tui.requestRender();
      });
    };
    picker.onClose = closeOverlay;
    picker.onRefresh = refreshCatalog;
    picker.onSelect = (picked) => {
      void switchModel({ provider: picked.provider, modelId: picked.modelId });
    };
    state.overlayHandle = tui.showOverlay(picker, { width: 72, anchor: "bottom-center", offsetY: -3 });
    tui.setFocus(picker);
    refreshCatalog();
  };

  const showJump = () => {
    if (state.overlayOpen) return;
    state.overlayOpen = true;
    const jump = new JumpOverlay(JUMP_TARGETS);
    jump.onClose = closeOverlay;
    jump.onJump = (key) => {
      const target = JUMP_TARGETS.find((candidate) => candidate.key === key);
      if (target === undefined) return;
      if (state.layer === "archive") void switchLayer("context");
      void switchToView(target.view);
    };
    state.overlayHandle = tui.showOverlay(jump, { width: 52, anchor: "center" });
    tui.setFocus(jump);
    tui.requestRender();
  };

  tui.addInputListener((data) => {
    // Pi dispatches motion to the pane under the pointer, not to the one it
    // left. Observe coordinates without consuming them so the sidebar can
    // dismiss its hover when the pointer enters another pane or overlay.
    const mouse = /^\x1b\[<\d+;(\d+);(\d+)[Mm]$/.exec(data);
    if (mouse !== null && sidebar.pointerMoved(Number(mouse[1]) - 1, Number(mouse[2]) - 1)) tui.requestRender();
    if (state.overlayOpen) return undefined;
    // The registry sees keys first: a command that is not available returns the
    // keystroke untouched, so the focused view still gets it.
    if (commands.dispatch(data)) return { consume: true };
    return undefined;
  });

  liveTimer = setInterval(() => {
    void rebuildTranscript().catch(() => undefined);
    // The tree is live too: the agent moves the anchor with the `tree` tool
    // mid-run, and the person watching the view should see it move rather than
    // find out at the next collapse.
    if (state.view === "tree") {
      void brain
        .read()
        .then((brainState) => {
          treeView.setData({ root: options.root, anchor: state.session.state.tree, brain: brainState });
          tui.requestRender();
        })
        .catch(() => undefined);
    }
  }, 1_500);

  void startLiveWatch();
  await rebuildTranscript();
  if (options.startupNotice !== undefined) tui.flash(options.startupNotice, 6_000);
  return runDone;
}
