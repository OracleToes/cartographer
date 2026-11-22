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
 * - the **atlas** and the **ledger** are the Brain, read and pinned;
 * - the **context** is the real prompt, and the only place surgery happens;
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
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { basename } from "node:path";

import {
  Editor,
  HStack,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  VStack,
  type Component,
  type OverlayHandle,
} from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, type LiveState } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";

import {
  closeLiveSession,
  collapseLiveSession,
  interruptRun,
  openLiveSession,
  sessionTranscript,
  restThenResume,
  submitInput,
  type LiveSession,
  type LiveSessionOptions,
} from "../runtime/live-session.js";
import { applyCapacityRefresh } from "../runtime/headless.js";
import { createTools } from "../runtime/tools.js";
import { CARTO_INSTRUCTIONS, liveStaleMarks, renderLiveStateBlock } from "../runtime/carto-extension.js";
import { isMarkerMessage, splitContextMessages, stripStateBlocks, STATE_BLOCK_MARKER, type MessageLike as BlockMessageLike } from "../domain/state-block.js";
import type { BrainStore } from "../runtime/brain-store.js";

import { FooterView, HeaderView, nextSendMode, sendModeLabel, type Layer, type SendMode, type ViewMode } from "./chrome.js";
import { Registry, type Command } from "./commands.js";
import { TokenBarView, type ContextBarState } from "./context-bar.js";
import { copyWithFallback, createSelectionCopier } from "./clipboard.js";
import { flattenEntry } from "./dump.js";
import { HelpPanel, keyText, type HelpExtra } from "./help-panel.js";
import { JumpOverlay, JUMP_TARGETS } from "./jump.js";
import { Palette, selectTheme, type PaletteCommand } from "./palette.js";
import { Sidebar, sidebarWidth, type BookKind, type SidebarCounts } from "./sidebar.js";
import { TranscriptView, formatToolArgs, type CardEntry, type TranscriptEntry } from "./transcript.js";
import { AtlasView } from "./atlas-view.js";
import { LedgerView } from "./ledger-view.js";
import { ContextView, type ContextDialogueMessage, type ContextToolItem, type ContextWorkItem } from "./context-view.js";
import { ArchiveView } from "./archive-view.js";
import { ruleLine, tokens } from "./tokens.js";

export interface CartoTuiOptions extends LiveSessionOptions {
  /** When true, the provider catalog is re-discovered before boot and after every settled run (llama-swap advertises capacity once the model has loaded). */
  refreshCapacity?: boolean;
}

interface PendingItem {
  text: string;
  at: number;
  mode: SendMode;
}

interface TuiState {
  session: LiveSession;
  /** Render exclusion: agent records already shown (boot history, or sealed by a collapse). Persists across collapses. */
  sealedAgentIds: Set<string>;
  sendMode: SendMode;
  view: ViewMode;
  /** The layer over the working area. `archive` is the person's, and only the person's (§3.3). */
  layer: Layer;
  /** True while at least one submission is in flight; drives the header and the footer's live hint. */
  running: boolean;
  /** The person's submitted lines awaiting placement in the context, in order. */
  pending: PendingItem[];
  /** Transcript prefix frozen at the last collapse; rendered before everything from this generation. */
  sealed: TranscriptEntry[];
  /** Status lines with their time; merged into the live segment by the rebuild. */
  statusLog: Array<{ t: number; entry: TranscriptEntry }>;
  inFlight: number;
  collapsing: boolean;
  sidebarVisible: boolean;
  overlayOpen: boolean;
  overlayHandle: OverlayHandle | undefined;
  /** Live watch on the in-flight partial (`pi.live`); stopped at collapse and shutdown, re-armed on the new session. */
  liveWatch: { stop(): Promise<unknown> } | undefined;
  rebuilding: boolean;
  /** Cheap change signature so the 1.5s timer does not bust the render cache when nothing moved. */
  sig: string;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const suffix = (generation: string): string => generation.slice(-6);

function countSidebar(brainState: Awaited<ReturnType<BrainStore["read"]>>, root: string, contextTokens: number = 0, archive?: { total: number; pinned: number }): SidebarCounts {
  const marks = liveStaleMarks(brainState, root);
  const stale: Partial<Record<"atlas" | "ledger" | "chat" | "context", number>> = {};
  for (const mark of marks) {
    if (mark.kind === "atlas") {
      stale.atlas = (stale.atlas ?? 0) + 1;
    }
  }
  const pinned: Partial<Record<BookKind, number>> = {};
  for (const record of brainState.chat) if (record.pinned !== undefined) pinned.chat = (pinned.chat ?? 0) + 1;
  for (const node of brainState.atlas) if (node.pinned !== undefined) pinned.atlas = (pinned.atlas ?? 0) + 1;
  for (const entry of brainState.ledger) if (entry.pinned !== undefined) pinned.ledger = (pinned.ledger ?? 0) + 1;
  const marked: Partial<Record<BookKind, number>> = {};
  for (const record of brainState.chat) {
    if (record.mark?.action === "delete") marked.chat = (marked.chat ?? 0) + 1;
  }
  return {
    chat: brainState.chat.length,
    contextTokens,
    atlas: brainState.atlas.length,
    ledger: brainState.ledger.length,
    pinned,
    marked,
    stale,
    staleTotal: marks.length,
    archive: archive?.total ?? 0,
    archivePinned: archive?.pinned ?? 0,
  };
}

interface ContextEntryLike {
  id?: number;
  kind?: string;
  model?: unknown;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  timestamp?: number;
  /** pi-ai's stop reason for the landed assistant turn: stop, length, toolUse, error, aborted… */
  stopReason?: string;
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
function liveCardsOf(live: LiveState | undefined): CardEntry[] {
  const cards: CardEntry[] = [];
  if (live === undefined) return cards;
  const attempt = live.generation?.attempt ?? 0;
  const slots = new Map((live.tools ?? []).map((slot) => [slot.callId, slot]));
  const seenCalls = new Set<string>();
  const message = live.generation?.message as { content?: unknown } | undefined;
  if (message !== undefined && Array.isArray(message.content)) {
    (message.content as unknown[]).forEach((part, index) => {
      if (!isRecord(part)) return;
      const id = `live-${attempt}-${index}`;
      if (part.type === "thinking" && typeof part.thinking === "string") {
        if (part.thinking.length > 0) cards.push({ kind: "reasoning", id, live: true, text: part.thinking });
      } else if (part.type === "text" && typeof part.text === "string") {
        if (part.text.length > 0) cards.push({ kind: "output", id, live: true, text: part.text });
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
        cards.push({ kind: "tool", id, live: true, name, args, status });
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
      ...(output === undefined ? {} : { output }),
      status: slot.status,
    });
  }
  return cards;
}

/** One hairline, exactly the width it is given: the seam under the header. */
class Rule implements Component {
  invalidate(): void {
    // Stateless.
  }

  render(width: number): string[] {
    return [ruleLine(width)];
  }
}

export async function runTui(options: CartoTuiOptions): Promise<number> {
  const brain = options.brain;
  const refresh = async () => {
    await options.models.refresh({ providers: [options.model.provider] }).catch(() => undefined);
  };
  if (options.refreshCapacity === true) await refresh();

  const boot = await brain.read();
  const session = await openLiveSession(options);
  const state: TuiState = {
    session,
    sealedAgentIds: new Set(boot.chat.filter((record) => record.author === "agent").map((record) => record.id)),
    sendMode: "steer",
    view: "chat",
    layer: "context",
    running: false,
    pending: [],
    sealed: [],
    statusLog: [],
    inFlight: 0,
    collapsing: false,
    sidebarVisible: true,
    overlayOpen: false,
    overlayHandle: undefined,
    rebuilding: false,
    sig: "",
    liveWatch: undefined,
  };

  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, undefined, undefined, { copySelection: createSelectionCopier() });

  const project = basename(options.root.replace(/[/\\]+$/, ""));
  const modelLabel = `${options.model.provider}/${options.model.modelId}`;
  const headerState = {
    project,
    modelLabel,
    session: state.session,
    view: state.view,
    layer: state.layer,
    running: state.running,
    windowUnknown: state.session.state.contextWindow <= 0,
  };
  const header = new HeaderView(headerState);
  const barState: ContextBarState = { session: headerState.session, parts: { system: 0, transcript: 0, toolWork: 0 } };
  const tokenBar = new TokenBarView(barState);
  const transcript = new TranscriptView({ project });
  const sidebar = new Sidebar();
  const transcriptScroll = new ScrollView(transcript, { follow: "end", primary: true, overscroll: "chain" });
  /**
   * The prompt's frame: Posting puts the name of the thing at the top of it, so
   * the box says what it is for. One rule above, `message` in it, one rule below.
   */
  class PromptEditor extends Editor {
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
  const editor = new PromptEditor(tui, editorTheme);

  const atlasView = new AtlasView();
  const ledgerView = new LedgerView();
  const contextView = new ContextView();
  const archiveView = new ArchiveView();

  // Each pannable view gets its own scroll view: Posting's "one scrolling pane in
  // front" — the wheel and the arrow keys move whatever is focused.
  const atlasScroll = new ScrollView(atlasView, { primary: false, overscroll: "contain" });
  const ledgerScroll = new ScrollView(ledgerView, { primary: false, overscroll: "contain" });
  const contextScroll = new ScrollView(contextView, { primary: false, overscroll: "contain" });
  const archiveScroll = new ScrollView(archiveView, { primary: false, overscroll: "contain" });

  sidebar.onSelect = (book) => void switchToView(book);
  sidebar.onToggleLayer = (layer) => void switchLayer(layer);

  const refreshSidebar = async () => {
    const brainState = await brain.read();
    const archive = await brain.readArchive().catch(() => ({ items: [] as Array<{ pinned?: "user" | "agent" }> }));
    const contextTokens = barState.parts.system + barState.parts.transcript + barState.parts.toolWork;
    sidebar.setCounts(
      countSidebar(brainState, options.root, contextTokens, {
        total: archive.items.length,
        pinned: archive.items.filter((item) => item.pinned !== undefined).length,
      }),
    );
    sidebar.setActiveBook(state.view);
    sidebar.setLayer(state.layer);
    tui.requestRender();
  };

  await refreshSidebar();

  const pushStatus = (text: string) => {
    state.statusLog.push({ t: Date.now(), entry: { kind: "status", text } });
  };

  const syncContextView = async (brainState: Awaited<ReturnType<BrainStore["read"]>>) => {
    const productTools = createTools({
      root: options.root,
      brain,
      session: state.session.state,
    });
    const bashTool = createBashTool();
    const allTools: ContextToolItem[] = [...productTools, bashTool].map((t) => ({
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
    const transcriptMessages: ContextDialogueMessage[] = [];
    const toolWorkItems: ContextWorkItem[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const message = messageOf(entry);
      if (message === undefined) continue;
      const role = message.role ?? "user";
      const id = entry.id ?? i;
      const ts = message.timestamp;
      if (role === "user") {
        const textContent = typeof message.content === "string" ? message.content : undefined;
        if (textContent && !isMarkerMessage(message as BlockMessageLike)) {
          transcriptMessages.push({ id, role, text: textContent, timestamp: ts });
        }
      } else if (role === "assistant") {
        const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
        for (let j = 0; j < content.length; j++) {
          const part = content[j];
          if (!isRecord(part)) continue;
          if (part.type === "thinking" && typeof part.thinking === "string") {
            toolWorkItems.push({ id: `${id}-${j}`, kind: "reasoning", text: part.thinking });
          } else if (part.type === "text" && typeof part.text === "string") {
            toolWorkItems.push({ id: `${id}-${j}`, kind: "output", text: part.text });
          } else if (part.type === "toolCall" && typeof part.name === "string") {
            if (part.name === "chat") {
              const textArg = isRecord(part.arguments) && typeof part.arguments.text === "string" ? part.arguments.text : "";
              transcriptMessages.push({ id: `${id}-${j}`, role: "assistant [chat]", text: textArg, timestamp: ts });
            } else {
              toolWorkItems.push({ id: `${id}-${j}`, kind: "toolCall", name: part.name, args: prettyArgs(part.arguments) });
            }
          }
        }
      } else if (role === "toolResult") {
        const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
        for (let j = 0; j < content.length; j++) {
          const part = content[j];
          if (!isRecord(part)) continue;
          const toolText = typeof part.text === "string" ? part.text : "";
          if (!toolText.startsWith("carto: ")) {
            toolWorkItems.push({ id: `${id}-${j}`, kind: "toolResult", output: toolText });
          }
        }
      }
    }

    const stateBlock = await renderLiveStateBlock(
      { root: options.root, brain, session: state.session.state, markdownPath: state.session.markdownPath },
      messages,
    );

    contextView.setData({
      brain: brainState,
      systemPrompt: CARTO_INSTRUCTIONS,
      // The frozen bytes the carto-context section renders; a missing file
      // falls back to re-rendering the Brain, the same fallback pi itself
      // uses — the view never fabricates a projection.
      ...(projectionText === undefined ? {} : { projectionText }),
      tools: allTools,
      transcriptMessages,
      toolWorkItems,
      stateBlockText: stateBlock,
    });
  };

  /** Focus follows the view: Posting's rule, and the reason the footer can be honest. */
  const focusCurrent = () => {
    if (!state.sidebarVisible) {
      // nop: the sidebar is not focusable
    }
    if (state.layer === "archive") {
      tui.setFocus(archiveView);
      return;
    }
    if (state.view === "chat") tui.setFocus(editor);
    else if (state.view === "atlas") tui.setFocus(atlasView);
    else if (state.view === "ledger") tui.setFocus(ledgerView);
    else tui.setFocus(contextView);
  };

  const switchToView = async (view: ViewMode) => {
    state.view = view;
    headerState.view = view;
    sidebar.setActiveBook(view);
    focusCurrent();
    const brainState = await brain.read();

    if (view === "atlas") {
      atlasView.setData(brainState, liveStaleMarks(brainState, options.root));
    } else if (view === "ledger") {
      ledgerView.setData(brainState);
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
    state.layer = layer;
    headerState.layer = layer;
    sidebar.setLayer(layer);
    if (layer === "archive") {
      await refreshArchive();
    } else if (state.view === "context") {
      await syncContextView(await brain.read());
    } else if (state.view === "atlas") {
      const fresh = await brain.read();
      atlasView.setData(fresh, liveStaleMarks(fresh, options.root));
    } else if (state.view === "ledger") {
      ledgerView.setData(await brain.read());
    }
    focusCurrent();
    await refreshSidebar();
    tui.requestRender();
  };
  const toggleLayer = () => switchLayer(state.layer === "archive" ? "context" : "archive");

  atlasView.onBack = () => void switchToView("chat");
  ledgerView.onBack = () => void switchToView("chat");
  contextView.onBack = () => void switchToView("chat");
  contextView.onCollapse = () => void runCollapse("context surgery");

  /** Person-side pin toggles: place/remove a pin as "user". Shared by every view that can toggle a pin. */
  const togglePin = async (target: "chat" | "ledger" | "atlas", id: string) => {
    const brainState = await brain.read();
    const record =
      target === "chat"
        ? brainState.chat.find((r) => r.id === id)
        : target === "ledger"
          ? brainState.ledger.find((e) => e.id === id)
          : brainState.atlas.find((n) => n.id === id);
    if (record === undefined) return;
    if (record.pinned === undefined) {
      await brain.apply({ kind: "pin.set", target, id: record.id, pinned: "user" }, Date.now());
      pushStatus(`pinned ${target} record #${record.id} (you)`);
    } else {
      await brain.apply({ kind: "pin.set", target, id: record.id, pinned: null }, Date.now());
      pushStatus(`unpinned ${target} record #${record.id}`);
    }
    await rebuildTranscript();
    const fresh = await brain.read();
    if (state.view === "atlas") atlasView.setData(fresh, liveStaleMarks(fresh, options.root));
    if (state.view === "ledger") ledgerView.setData(fresh);
    if (state.view === "context") await syncContextView(fresh);
    await refreshSidebar();
    tui.requestRender();
  };

  /**
   * The person's archive operations (§3.3). There is no tool for any of these,
   * and no handle that names an archived item: the agent does not know the
   * archive exists.
   */
  archiveView.onTogglePin = (id) => {
    void (async () => {
      const archive = await brain.readArchive();
      const item = archive.items.find((candidate) => candidate.id === id);
      if (item === undefined) return;
      await brain.applyArchive({ kind: "pin", id, pinned: item.pinned === undefined ? "user" : null });
      pushStatus(`${item.pinned === undefined ? "pinned" : "unpinned"} an archived item`);
      await refreshArchive();
      await refreshSidebar();
    })();
  };
  archiveView.onRestore = (id) => {
    void (async () => {
      const result = await brain.applyArchive({ kind: "restore", id });
      if (result.item === undefined) return;
      const kind = result.item.record?.kind;
      pushStatus(kind === undefined ? "restored an ephemeral item" : `restored ${kind} record ${result.item.record?.value.id ?? ""}`.trim());
      await refreshArchive();
      await rebuildTranscript();
      await refreshSidebar();
    })();
  };
  archiveView.onDelete = (id) => {
    void (async () => {
      await brain.applyArchive({ kind: "drop", id });
      pushStatus("an archived item is deleted for good");
      await refreshArchive();
      await refreshSidebar();
    })();
  };

  transcript.onTogglePin = (recordId: string) => void togglePin("chat", recordId);
  ledgerView.onTogglePin = (id: string) => void togglePin("ledger", id);
  atlasView.onTogglePin = (id: string) => void togglePin("atlas", id);
  contextView.onTogglePin = (_partId: string, itemId: string | number) => {
    void (async () => {
      const brainState = await brain.read();
      const chatRecord = brainState.chat.find((r) => String(r.id) === String(itemId));
      if (chatRecord === undefined) return;
      await togglePin("chat", chatRecord.id);
    })();
  };

  /**
   * Context surgery (§4.1): `d` marks one entry for delete, `!` arms apply-now,
   * and `c` collapses. A mark is not a deletion — the entry stays visible until
   * a collapse sweeps it — and apply-now is a rebuild, not a patch.
   */
  contextView.onDelete = async (partId, itemId, now) => {
    if (partId === "transcript") {
      const brainState = await brain.read();
      const chatRecord = brainState.chat.find((r) => r.id === itemId || String(r.id) === String(itemId));
      if (chatRecord) {
        await brain.apply({ kind: "mark.set", target: "chat", id: chatRecord.id, action: "delete", author: "user" }, Date.now());
        pushStatus(`marked chat record #${chatRecord.id} for delete${now ? "" : " at the next collapse"}`);
      }
    }
    if (now) {
      await runCollapse("context surgery (now)");
    } else {
      await rebuildTranscript();
      const brainState = await brain.read();
      await syncContextView(brainState);
      await refreshSidebar();
    }
    tui.requestRender();
  };

  // ── The screen ────────────────────────────────────────────────────────────
  // Posting's map of a screen, in bands: one header row, the working area, the
  // prompt (only where you type), the key bar, and the context bar along the
  // very bottom of everything. The sidebar is the full height of the working
  // bands beside them; its seam is drawn by the pane itself.
  //
  // Every band paints its own background, edge to edge. `VStack` sizes them by
  // their contents and `Spacer` does not grow, so a layout that leaves a band
  // to "fill" would show the terminal's own background through the gaps; each
  // band here is given the height it renders at instead.
  const footer = new FooterView(() => footerHints());
  const workArea = new VStack([
    { component: transcriptScroll, basis: 0, grow: 1, minSize: 3, visible: () => state.view === "chat" && state.layer === "context" },
    { component: atlasScroll, basis: 0, grow: 1, minSize: 3, visible: () => state.view === "atlas" && state.layer === "context" },
    { component: ledgerScroll, basis: 0, grow: 1, minSize: 3, visible: () => state.view === "ledger" && state.layer === "context" },
    { component: contextScroll, basis: 0, grow: 1, minSize: 3, visible: () => state.view === "context" && state.layer === "context" },
    { component: archiveScroll, basis: 0, grow: 1, minSize: 3, visible: () => state.layer === "archive" },
  ]);
  const headerBand = new VStack([{ component: header, basis: "auto" }, { component: new Rule(), basis: 1 }]);
  const body = new HStack([
    { component: sidebar, basis: sidebarWidth, visible: () => state.sidebarVisible },
    {
      component: new VStack([
        { component: headerBand, basis: 2 },
        { component: workArea, basis: 0, grow: 1, minSize: 3 },
        { component: editor, basis: "auto", minSize: 3, visible: () => state.view === "chat" && state.layer === "context" },
      ]),
      basis: 0,
      grow: 1,
      minSize: 20,
    },
  ]);

  tui.setLayoutRoot(
    new VStack([
      { component: body, basis: 0, grow: 1, minSize: 6 },
      { component: footer, basis: 2 },
      { component: tokenBar, basis: 1 },
    ]),
  );
  tui.start();
  tui.setFocus(editor);

  // ── Input ─────────────────────────────────────────────────────────────────
  const closeOverlay = () => {
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
    if (liveTimer !== undefined) clearInterval(liveTimer);
    tui.stop();
    await state.liveWatch?.stop().catch(() => undefined);
    state.liveWatch = undefined;
    await closeLiveSession(state.session);
    resolveRun?.(code);
  };

  /**
   * Rebuild the landed view from the sources of truth: the context's entries
   * (person lines land exactly where they were placed), the Brain's agent
   * chat records, the sealed prefix from the last collapse, and the status
   * log. Cheap enough to run after every settle and on a 1.5s timer; it
   * skips the re-render entirely when nothing moved.
   */
  const rebuildTranscript = async (): Promise<void> => {
    if (state.rebuilding) return;
    state.rebuilding = true;
    try {
      const brainState = await brain.read();
      const entries = (await sessionTranscript(state.session)) as unknown as ContextEntryLike[];

      // The context's entries are the frame: monotonic numeric ids, in the
      // order the model sees them. Person lines key off their own entry.
      const frame: Array<{ id: number; t: number }> = [];
      for (const entry of entries) {
        const id = typeof entry.id === "number" ? entry.id : 0;
        const message = messageOf(entry);
        frame.push({ id, t: message === undefined ? 0 : timestampOf(message) });
      }
      /** Largest frame id at or before `t` — where a non-entry event sits in the frame's order. */
      const anchorAt = (t: number): number => {
        let anchor = 0;
        for (const slot of frame) {
          if (slot.t <= t) anchor = Math.max(anchor, slot.id);
        }
        return anchor;
      };

      const visibleMessages: BlockMessageLike[] = [];
      for (const entry of entries) {
        const message = messageOf(entry);
        if (message === undefined) continue;
        visibleMessages.push(message as unknown as BlockMessageLike);
      }

      const person: Array<{ key: number; entry: TranscriptEntry }> = [];
      const landedTexts: Array<{ text: string; t: number }> = [];
      const toolErrors = new Map<string, boolean>();
      const toolOutputs = new Map<string, string>();
      const assistantParts: Array<{ entryId: number; parts: Record<string, unknown>[]; stopReason?: string }> = [];
      for (const entry of entries) {
        const id = typeof entry.id === "number" ? entry.id : 0;
        const message = messageOf(entry);
        if (message === undefined) continue;
        const role = typeof message.role === "string" ? message.role : "";
        if (role === "user" && typeof message.content === "string") {
          const text = message.content;
          if (text.trim() === STATE_BLOCK_MARKER || text.trim().length === 0) continue;
          const t = timestampOf(message);
          person.push({ key: id, entry: { kind: "person", text } });
          landedTexts.push({ text, t });
        } else if (role === "assistant" && Array.isArray(message.content)) {
          const parts = (message.content as unknown[]).filter(isRecord);
          const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
          if (parts.length > 0) assistantParts.push({ entryId: id, parts, ...(stopReason === undefined ? {} : { stopReason }) });
        } else if (role === "toolResult" && isRecord(message)) {
          const callId = (message as Record<string, unknown>).toolCallId;
          if (typeof callId === "string") {
            if ((message as Record<string, unknown>).isError === true) toolErrors.set(callId, true);
            let out = "";
            if (Array.isArray(message.content)) {
              for (const p of message.content) {
                if (isRecord(p) && typeof p.text === "string") out += p.text;
              }
            } else if (typeof message.content === "string") {
              out = message.content;
            }
            if (out.length > 0) toolOutputs.set(callId, out);
          }
        }
      }

      // The working, as cards: reasoning, plain model text, and tool calls, in
      // the order the model produced them. Landed cards default folded.
      const cards: Array<{ key: number; entry: TranscriptEntry }> = [];
      // The landed stop reason of each assistant turn — one quiet line per
      // turn, warn-toned when the turn was cut short (length) or failed.
      // Always present, so a truncated generation is glanceable.
      const stops: Array<{ key: number; entry: TranscriptEntry }> = [];
      for (const { entryId, parts, stopReason } of assistantParts) {
        if (stopReason !== undefined) {
          const warn = stopReason === "length" || stopReason === "error" || stopReason === "aborted";
          stops.push({
            key: entryId + (parts.length + 1) * 0.0001,
            entry: { kind: "status", text: `stopped: ${stopReason}`, ...(warn ? { tone: "warn" as const } : {}) },
          });
        }
        parts.forEach((part, partIndex) => {
          const key = entryId + (partIndex + 1) * 0.0001;
          if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim().length > 0) {
            cards.push({ key, entry: { kind: "reasoning", id: `ctx-${entryId}-${partIndex}`, text: part.thinking } });
          } else if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
            cards.push({ key, entry: { kind: "output", id: `ctx-${entryId}-${partIndex}`, text: part.text } });
          } else if (part.type === "toolCall" && typeof part.name === "string") {
            const callId = typeof part.id === "string" ? part.id : undefined;
            const output = callId !== undefined ? toolOutputs.get(callId) : undefined;
            cards.push({
              key,
              entry: {
                kind: "tool",
                id: `ctx-${entryId}-${partIndex}`,
                name: part.name,
                args: formatToolArgs(part.arguments, part.name),
                ...(output !== undefined ? { output } : {}),
                ...(callId !== undefined && toolErrors.get(callId) === true ? { failed: true } : {}),
              },
            });
          }
        });
      }

      const agent: Array<{ key: number; entry: TranscriptEntry }> = [];
      for (const record of brainState.chat) {
        if (record.author !== "agent") continue;
        if (state.sealedAgentIds.has(record.id)) continue; // shown already (boot burst or sealed by a collapse)
        agent.push({ key: anchorAt(record.createdAt) + 0.5, entry: { kind: "agent", text: record.text, recordId: record.id, pinned: record.pinned } });
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

      // Status lines key off their own insertion timestamp.
      const statusMerged: Array<{ key: number; entry: TranscriptEntry }> = state.statusLog.map((item) => ({
        key: anchorAt(item.t) + 0.25,
        entry: item.entry,
      }));

      // Token estimates: split context messages into system, transcript,
      // toolWork — strictly matching the same estimates the state block reports,
      // split the same way. Cheap next to the Brain read above.
      const blockMessages = visibleMessages.filter((message) => !isMarkerMessage(message));
      const parts = splitContextMessages(blockMessages);
      barState.parts = { system: parts.systemTokens, transcript: parts.transcriptTokens, toolWork: parts.toolWorkTokens };

      const sig = [
        state.sealed.length,
        person.map((item) => item.key).join(","),
        cards.map((item) => item.key).join(","),
        stops.map((item) => `${String(item.key)}:${item.entry.kind === "status" ? item.entry.text : ""}`).join(","),
        agent.map((item) => `${String(item.key)}:${item.entry.kind === "agent" ? String(item.entry.recordId ?? "") + ":" + String(item.entry.pinned ?? "") : ""}`).join(","),
        state.sealedAgentIds.size,
        state.statusLog.length,
        state.pending.map((item) => item.text).join("\u0001"),
        String(Math.round(parts.systemTokens)),
        String(Math.round(parts.transcriptTokens)),
        String(Math.round(parts.toolWorkTokens)),
        String(state.session.state.lastReportedInput ?? ""),
        String(state.session.state.contextWindow),
      ].join("|");
      if (sig !== state.sig) {
        state.sig = sig;
        const live = [...person, ...cards, ...stops, ...agent, ...statusMerged];
        live.sort((left, right) => left.key - right.key);
        // Sealed history is an immutable prefix; the live segment follows in the frame's order.
        transcript.setEntries(
          [...state.sealed, ...live.map((item) => item.entry)],
          state.pending.map((item) => ({ text: item.text, mode: item.mode })),
        );
        headerState.windowUnknown = state.session.state.contextWindow <= 0;
        tui.requestRender();
      }

      if (state.view === "context" && state.layer === "context") {
        await syncContextView(brainState);
      }
    } finally {
      state.rebuilding = false;
    }
  };

  let lastLiveRebuild = 0;
  const startLiveWatch = async (): Promise<void> => {
    const watch = await state.session.harness.watchDoc(LiveDoc, state.session.conversation.id, BACKGROUND_CONTEXT).catch(() => undefined);
    if (watch === undefined) return;
    state.liveWatch = watch;
    let hadLive = false;
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      const live = call.value as LiveState;
      const cards = liveCardsOf(live);
      transcript.setLive(cards);
      tui.requestRender();
      const hasLive = cards.length > 0 || live.generation !== undefined || (live.tools?.length ?? 0) > 0;
      const now = Date.now();
      if (now - lastLiveRebuild >= 400 || (hadLive && !hasLive)) {
        lastLiveRebuild = now;
        setImmediate(() => {
          void rebuildTranscript();
        });
      }
      hadLive = hasLive;
    });
  };

  const runCollapse = async (reason: string) => {
    if (state.collapsing) return;
    state.collapsing = true;
    const previous = state.session.generation;
    pushStatus(`collapsing context at ${suffix(previous)}: ${reason}…`);
    if (state.pending.length > 0) {
      pushStatus(`${state.pending.length} queued message(s) dropped by the collapse`);
      state.pending = [];
    }
    state.sealed = [...state.sealed, ...transcript.snapshot()];
    state.statusLog = [];
    transcript.setLive([]);
    await state.liveWatch?.stop().catch(() => undefined);
    state.liveWatch = undefined;
    try {
      const before = await brain.read();
      for (const record of before.chat) if (record.author === "agent") state.sealedAgentIds.add(record.id);
      const outcome = await collapseLiveSession(state.session, options, reason);
      state.session = outcome.session;
      headerState.session = outcome.session;
      barState.session = outcome.session;
      void startLiveWatch();
      pushStatus(`collapsed and rebuilt from the Brain (${suffix(previous)} → ${suffix(outcome.report.generation)})`);
      await refreshSidebar();
    } catch (error) {
      pushStatus(`collapse failed: ${errorText(error)}`);
    } finally {
      state.collapsing = false;
      state.inFlight = Math.max(0, state.inFlight);
      state.running = state.inFlight > 0;
      headerState.running = state.running;
      await rebuildTranscript();
      tui.requestRender();
    }
  };

  const refreshAdvertisedWindow = async () => {
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        const line = String(chunk).trim();
        if (line.length > 0) pushStatus(line);
        callback();
      },
    });
    await applyCapacityRefresh(state.session, refresh, options.models, options.model.provider, options.model.modelId, sink);
    await rebuildTranscript();
  };

  const runSubmission = async (message: string) => {
    if (state.collapsing) {
      pushStatus("collapsing — hold on");
      await rebuildTranscript();
      return;
    }
    state.inFlight += 1;
    state.running = true;
    headerState.running = true;
    tui.requestRender();
    try {
      if (state.sendMode === "now") await interruptRun(state.session);
      const whenBusy = state.sendMode === "after run" ? "followUp" : "steer";
      const submission = await submitInput(state.session, message, whenBusy);
      await rebuildTranscript();
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      if (settled.status !== "done") {
        pushStatus(`the run ended with status "${settled.status}"`);
      }
    } catch (error) {
      pushStatus(`the run failed: ${errorText(error)}`);
    }
    state.inFlight = Math.max(0, state.inFlight - 1);
    state.running = state.inFlight > 0;
    headerState.running = state.running;
    await rebuildTranscript();
    const reason = state.session.takeCollapseRequest();
    if (reason !== null) await runCollapse(reason);
    // A timed sleep: the agent rests, then starts again on its own (§10).
    state.running = true;
    headerState.running = true;
    tui.requestRender();
    try {
      await restThenResume(state.session);
    } finally {
      state.running = false;
      headerState.running = false;
      await rebuildTranscript();
      tui.requestRender();
    }
    if (options.refreshCapacity === true) await refreshAdvertisedWindow();
    await refreshSidebar();
    tui.requestRender();
  };

  /**
   * The person's mode toggle (§6.1). It flips the session flag the tools read,
   * and the block reports the new mode on the next request. Nothing else knows
   * the mode — `bash` stays trusted, and no gate is placed anywhere.
   */
  const toggleReadOnly = () => {
    state.session.state.readOnly = !state.session.state.readOnly;
    tui.flash(
      state.session.state.readOnly
        ? "read only mode — create and edit will refuse"
        : "edit mode — the agent may change the project",
      1_800,
    );
    tui.requestRender();
  };

  const copyTranscript = async () => {
    const text = transcript.toPlainText();
    const result = await copyWithFallback(text, "transcript");
    pushStatus(`transcript copied — ${result.where} (${text.split("\n").length} lines)`);
    return result;
  };

  const copySession = async () => {
    const brainState = await brain.read();
    const entries = (await sessionTranscript(state.session)) as unknown as ContextEntryLike[];
    const lines: string[] = [
      `# carto session dump — ${new Date().toISOString()}`,
      `project: ${options.root}`,
      `generation: ${state.session.generation}`,
      `model: ${modelLabel} · ${state.session.state.contextWindow > 0 ? `window ${state.session.state.contextWindow.toLocaleString("en-US")}` : "window unknown"}`,
      `last provider report: ${state.session.state.lastReportedInput?.toLocaleString("en-US") ?? "none"} + tool work since +${state.session.state.toolWorkAtLastReport.toLocaleString("en-US")}`,
      `atlas ${brainState.atlas.length} · ledger ${brainState.ledger.length} · chat ${brainState.chat.length}`,
      "",
      "## transcript (what the person saw)",
      transcript.toPlainText(),
      "",
      "## context (what the model sees; oldest first; state-block markers stripped)",
    ];
    for (const entry of entries) {
      const flat = flattenEntry(entry as { kind?: string; id?: number; model?: unknown });
      if (flat === undefined) continue;
      if (flat.body.trim() === STATE_BLOCK_MARKER) continue;
      lines.push("", `#${flat.id} ${flat.kind} · role ${flat.role} · ${flat.timestamp === undefined ? "?" : new Date(flat.timestamp).toISOString()}`, flat.body);
    }
    const text = lines.join("\n");
    const result = await copyWithFallback(text, "session");
    pushStatus(`session copied — ${result.where} (${text.split("\n").length} lines)`);
    return result;
  };

  const submitMessage = (message: string) => {
    state.pending.push({ text: message, at: Date.now(), mode: state.sendMode });
    void rebuildTranscript();
    void runSubmission(message);
  };

  editor.onSubmit = (text: string) => {
    const message = text.trim();
    if (message.length === 0) return;
    editor.addToHistory(message);
    submitMessage(message);
  };

  // ── Commands ─────────────────────────────────────────────────────────────
  // One registry. The footer, `f1` and `^p` are views of this list; see
  // `commands.ts`. Order matters twice: input matching goes in declaration
  // order, and the footer shows the first ones that fit.
  const inChat = () => state.layer === "context" && state.view === "chat";
  const inView = (view: ViewMode) => state.layer === "context" && state.view === view;
  const onArchive = () => state.layer === "archive";

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
      id: "quit",
      group: "anywhere",
      label: "quit",
      key: "ctrl+c",
      run: () => void shutdown(0),
      available: () => true,
    },
    {
      id: "stop",
      group: "the run",
      label: "stop the run",
      key: "ctrl+x",
      run: () => {
        void interruptRun(state.session).then(
          () => pushStatus("interrupt sent — the run stops"),
          (error: unknown) => pushStatus(`interrupt failed: ${errorText(error)}`),
        ).then(() => rebuildTranscript());
      },
      available: () => state.running,
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
      id: "prompt-fold",
      group: "the prompt",
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
    {
      id: "read-only",
      group: "the workspace",
      label: "read only mode",
      hint: "flips whether the agent may change files",
      run: () => toggleReadOnly(),
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
      id: "archive",
      group: "the workspace",
      label: "the archive layer",
      hint: "the person's, never the agent's",
      key: "ctrl+t",
      run: () => void toggleLayer(),
      available: () => true,
    },
    {
      id: "view-chat",
      group: "go to",
      label: "the transcript",
      run: () => void switchToView("chat"),
      available: () => !inChat(),
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
      id: "view-context",
      group: "go to",
      label: "the prompt",
      hint: "what the model reads, and surgery on it",
      run: () => void switchToView("context"),
      available: () => !inView("context"),
    },
    {
      id: "copy",
      group: "the record",
      label: "copy the transcript",
      key: "ctrl+y",
      run: () => void copyTranscript(),
      available: () => true,
    },
    {
      id: "copy-session",
      group: "the record",
      label: "copy a full session dump",
      run: () => void copySession(),
      available: () => true,
    },
    {
      id: "back",
      group: "anywhere",
      label: "back to the transcript",
      key: "escape",
      run: () => void switchToView("chat"),
      available: () => state.layer === "context" && state.view !== "chat",
    },
  ] satisfies Command[]);

  function footerHints(): Array<{ key: string; label: string }> {
    return commands.footer().map((command) => ({
      key: keyText(command.key ?? ""),
      label: command.key === "shift+tab" ? `${command.label}: ${sendModeLabel(state.sendMode)}` : command.label,
    }));
  }

  const helpExtras = (): HelpExtra[] => [
    { group: "type it", key: "/copy", label: "copy the transcript" },
    { group: "type it", key: "/copy-session", label: "full diagnostic dump of the session" },
    { group: "type it", key: "/help", label: "the command list in the transcript" },
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
        label: command.label,
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
    if (state.overlayOpen) return undefined;
    // The registry sees keys first: a command that is not available returns the
    // keystroke untouched, so the focused view still gets it.
    if (commands.dispatch(data)) return { consume: true };
    return undefined;
  });

  liveTimer = setInterval(() => {
    void rebuildTranscript().catch(() => undefined);
  }, 1_500);

  void startLiveWatch();
  await rebuildTranscript();
  return runDone;
}
