/**
 * The workspace (MINI.md §8 as re-scoped 2026-11-20 — modes, not tabs; the
 * Posting layout philosophy on pi-tui primitives).
 *
 * Chat is the boot view; Atlas, Ledger, and Context surgery views are reachable
 * via jump keys (^o a, ^o l, ^o x) and the summoned palette (^p). The token bar
 * sits above the footer on every view (docs/ui-proposal.md §7, candidate A):
 * one row, segmented by part, honest about what is estimate and what is measured.
 * The whole app carries one cell of padding on every edge.
 *
 * Pinned items and stale evidence are evident directly inside their books.
 *
 * State is one explicit value; behaviour is functions over it (MINI.md §12).
 * Pi performs; Carto adds only the composition.
 */
import { Writable } from "node:stream";
import { basename, join } from "node:path";

import {
  Editor,
  HStack,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Spacer,
  TuiAltScreen,
  VStack,
  type Component,
  type Focusable,
  type OverlayHandle,
} from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, type LiveState } from "@earendil-works/pi-durable";

import {
  closeLiveSession,
  collapseLiveSession,
  interruptRun,
  openLiveSession,
  sessionTranscript,
  submitInput,
  type LiveSession,
  type LiveSessionOptions,
} from "../runtime/live-session.js";
import { applyCapacityRefresh } from "../runtime/headless.js";
import { renderLiveStateBlock, staleMarks } from "../runtime/carto-extension.js";
import { isMarkerMessage, splitContextMessages, STATE_BLOCK_MARKER, type MessageLike as BlockMessageLike } from "../domain/state-block.js";
import type { BrainStore } from "../runtime/brain-store.js";

import { FooterView, HeaderView, nextSendMode, sendModeLabel, type SendMode, type ViewMode } from "./chrome.js";
import { TokenBarView, type TokenBarState } from "./token-bar.js";
import { copyWithFallback, createSelectionCopier } from "./clipboard.js";
import { flattenEntry } from "./dump.js";
import { JumpOverlay, JUMP_TARGETS } from "./jump.js";
import { Palette, selectTheme, type PaletteCommand } from "./palette.js";
import { Sidebar, sidebarWidth, type BookKind, type SidebarCounts } from "./sidebar.js";
import { TranscriptView, type CardEntry, type TranscriptEntry } from "./transcript.js";
import { AtlasView } from "./atlas-view.js";
import { LedgerView } from "./ledger-view.js";
import { ContextView } from "./context-view.js";
import { tokens } from "./tokens.js";

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
  /** True while at least one submission is in flight; drives the footer badge and the live timer's rebuilds. */
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

function countSidebar(brainState: Awaited<ReturnType<BrainStore["read"]>>): SidebarCounts {
  const marks = staleMarks(brainState);
  const stale: Partial<Record<BookKind, number>> = {};
  for (const mark of marks) {
    if (mark.kind === "atlas") {
      stale.atlas = (stale.atlas ?? 0) + 1;
    }
  }
  return {
    atlas: brainState.atlas.length,
    ledger: brainState.ledger.length,
    chat: brainState.chat.length,
    stale,
    staleTotal: marks.length,
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
      } else if (part.type === "toolCall" && typeof part.name === "string") {
        const callId = typeof part.id === "string" ? part.id : undefined;
        if (callId !== undefined) seenCalls.add(callId);
        const slot = callId === undefined ? undefined : slots.get(callId);
        cards.push({ kind: "tool", id, live: true, name: part.name, args: prettyArgs(part.arguments), status: slot?.status ?? "pending" });
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

class WorkAreaSwitcher implements Component, Focusable {
  focused = false;
  constructor(
    private readonly getState: () => {
      view: ViewMode;
      scroll: ScrollView;
      atlas: AtlasView;
      ledger: LedgerView;
      context: ContextView;
    },
  ) {}

  invalidate(): void {
    // Stateless delegate.
  }

  render(width: number): string[] {
    const s = this.getState();
    if (s.view === "atlas") return s.atlas.render(width);
    if (s.view === "ledger") return s.ledger.render(width);
    if (s.view === "context") return s.context.render(width);
    return s.scroll.render(width);
  }
}

export async function runTui(options: CartoTuiOptions): Promise<number> {
  const brain = options.brain;
  const refresh = async () => {
    await options.models.refresh({ providers: [options.model.provider] }).catch(() => undefined);
  };
  if (options.refreshCapacity === true) await refresh();

  const session = await openLiveSession(options);
  const state: TuiState = {
    session,
    sealedAgentIds: new Set((await brain.read()).chat.filter((record) => record.author === "agent").map((record) => record.id)),
    sendMode: "steer",
    view: "chat",
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
  const headerState = { project, modelLabel, session: state.session, view: state.view };
  const header = new HeaderView(headerState);
  const barState: TokenBarState = { session: headerState.session, parts: { system: 0, transcript: 0, toolWork: 0 } };
  const tokenBar = new TokenBarView(barState);
  const footer = new FooterView(state);
  const transcript = new TranscriptView();
  const sidebar = new Sidebar();
  const scroll = new ScrollView(transcript, { follow: "end", primary: true, overscroll: "chain" });
  const editorTheme = { borderColor: (line: string) => tokens.muted(line), selectList: selectTheme };
  const editor = new Editor(tui, editorTheme);

  const atlasView = new AtlasView();
  const ledgerView = new LedgerView();
  const contextView = new ContextView();

  const workArea = new WorkAreaSwitcher(() => ({
    view: state.view,
    scroll,
    atlas: atlasView,
    ledger: ledgerView,
    context: contextView,
  }));

  const refreshSidebar = async () => {
    const brainState = await brain.read();
    sidebar.setCounts(countSidebar(brainState));
    sidebar.setActiveBook(state.view === "context" ? "context" : state.view);
    tui.requestRender();
  };

  await refreshSidebar();

  const switchToView = async (view: ViewMode) => {
    state.view = view;
    headerState.view = view;
    footer.invalidate();
    sidebar.setActiveBook(view === "context" ? "context" : view);

    const brainState = await brain.read();
    const marks = staleMarks(brainState);

    if (view === "chat") {
      tui.setFocus(editor);
    } else if (view === "atlas") {
      atlasView.setData(brainState, marks);
      tui.setFocus(atlasView);
    } else if (view === "ledger") {
      ledgerView.setData(brainState);
      tui.setFocus(ledgerView);
    } else if (view === "context") {
      const sysPrompt = "Carto rules and system prompt.";
      const toolDescs = ["chat", "atlas", "ledger", "pin", "read", "edit", "shell", "tree", "collapse", "sleep"].map((n) => `tool ${n}`);
      const transText = transcript.toPlainText();
      const workText = state.session.state.lastReportedInput !== null ? `last report: ${state.session.state.lastReportedInput} tokens` : "none";
      const stateBlock = await renderLiveStateBlock(
        { root: options.root, brain, session: state.session.state, markdownPath: join(options.root, ".brain/context", ".projection.md") },
        [],
      );
      contextView.setData(brainState, sysPrompt, toolDescs, transText, workText, stateBlock);
      tui.setFocus(contextView);
    }
    tui.requestRender();
  };

  atlasView.onBack = () => void switchToView("chat");
  ledgerView.onBack = () => void switchToView("chat");
  contextView.onBack = () => void switchToView("chat");

  tui.setLayoutRoot(
    new HStack([
      { component: new Spacer(0), basis: 1 },
      {
        component: new VStack([
          { component: new Spacer(1), basis: 1 },
          { component: header, basis: "auto" },
          {
            component: new HStack([
              { component: sidebar, basis: sidebarWidth, visible: () => state.sidebarVisible },
              { component: workArea, basis: 0, grow: 1, minSize: 3 },
            ]),
            basis: 0,
            grow: 1,
            minSize: 3,
          },
          { component: editor, basis: "auto", minSize: 3, visible: () => state.view === "chat" },
          { component: tokenBar, basis: 1 },
          { component: footer, basis: 1 },
          { component: new Spacer(1), basis: 1 },
        ]),
        basis: 0,
        grow: 1,
        minSize: 3,
      },
      { component: new Spacer(0), basis: 1 },
    ]),
  );
  tui.start();
  tui.setFocus(editor);

  const closeOverlay = () => {
    state.overlayHandle?.hide();
    state.overlayHandle = undefined;
    state.overlayOpen = false;
    if (state.view === "chat") {
      tui.setFocus(editor);
    } else if (state.view === "atlas") {
      tui.setFocus(atlasView);
    } else if (state.view === "ledger") {
      tui.setFocus(ledgerView);
    } else if (state.view === "context") {
      tui.setFocus(contextView);
    }
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

  const pushStatus = (text: string) => {
    state.statusLog.push({ t: Date.now(), entry: { kind: "status", text } });
  };

  const rebuildTranscript = async () => {
    if (state.rebuilding) return;
    state.rebuilding = true;
    try {
      const entries = (await sessionTranscript(state.session)) as unknown as ContextEntryLike[];
      const landed: TranscriptEntry[] = [];
      const pendingByText = new Map<string, number>();
      for (const item of state.pending) {
        pendingByText.set(item.text, (pendingByText.get(item.text) ?? 0) + 1);
      }
      const consumePending = (text: string): boolean => {
        const count = pendingByText.get(text) ?? 0;
        if (count <= 0) return false;
        if (count === 1) pendingByText.delete(text);
        else pendingByText.set(text, count - 1);
        const index = state.pending.findIndex((item) => item.text === text);
        if (index >= 0) state.pending.splice(index, 1);
        return true;
      };

      const brainState = await brain.read();
      const agentChatById = new Map<string, string>();
      for (const record of brainState.chat) {
        if (record.author === "agent" && !state.sealedAgentIds.has(record.id)) {
          agentChatById.set(record.id, record.text);
        }
      }

      for (const entry of entries) {
        const message = messageOf(entry);
        if (message === undefined) continue;
        const role = message.role;
        const textContent = typeof message.content === "string" ? message.content : undefined;
        if (role === "user") {
          if (textContent === undefined) continue;
          if (isMarkerMessage(message as BlockMessageLike)) continue;
          consumePending(textContent);
          landed.push({ kind: "person", text: textContent });
        } else if (role === "assistant") {
          const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
          for (let index = 0; index < content.length; index += 1) {
            const part = content[index];
            if (!isRecord(part)) continue;
            const id = `ctx-${entry.id ?? index}-${index}`;
            if (part.type === "thinking" && typeof part.thinking === "string") {
              if (part.thinking.length > 0) landed.push({ kind: "reasoning", id, text: part.thinking });
            } else if (part.type === "text" && typeof part.text === "string") {
              if (part.text.length > 0) landed.push({ kind: "output", id, text: part.text });
            } else if (part.type === "toolCall" && typeof part.name === "string") {
              const name = part.name;
              const args = prettyArgs(part.arguments);
              landed.push({ kind: "tool", id, name, args });
            }
          }
          if (typeof message.stopReason === "string" && message.stopReason.length > 0) {
            const tone = ["length", "error", "aborted"].includes(message.stopReason) ? "warn" : undefined;
            landed.push({ kind: "status", text: `stopped: ${message.stopReason}`, ...(tone ? { tone } : {}) });
          }
        } else if (role === "toolResult") {
          const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
          for (let index = 0; index < content.length; index += 1) {
            const part = content[index];
            if (!isRecord(part)) continue;
            const toolText = typeof part.text === "string" ? part.text : "";
            const isError = part.isError === true;
            if (toolText.startsWith("carto: ")) {
              landed.push({ kind: "agent", text: toolText.slice(7) });
            } else if (isError) {
              const id = `ctx-${entry.id ?? index}-err-${index}`;
              landed.push({ kind: "tool", id, name: "tool", args: "", output: toolText, failed: true });
            }
          }
        }
      }

      for (const [id, text] of agentChatById.entries()) {
        if (!landed.some((entry) => entry.kind === "agent" && entry.text === text)) {
          landed.push({ kind: "agent", text });
          state.sealedAgentIds.add(id);
        }
      }

      const allEntries = [...state.sealed, ...landed, ...state.statusLog.map((item) => item.entry)];
      transcript.setEntries(
        allEntries,
        state.pending.map((item) => ({ text: item.text, mode: item.mode })),
      );

      const visible = entries.map((entry) => messageOf(entry)).filter((m): m is BlockMessageLike => m !== undefined);
      const { transcriptTokens, toolWorkTokens, systemTokens } = splitContextMessages(visible);
      barState.parts = {
        system: systemTokens,
        transcript: transcriptTokens,
        toolWork: toolWorkTokens,
      };

      tui.requestRender();
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
    await rebuildTranscript();
    const reason = state.session.takeCollapseRequest();
    if (reason !== null) await runCollapse(reason);
    if (options.refreshCapacity === true) await refreshAdvertisedWindow();
    await refreshSidebar();
    tui.requestRender();
  };

  const slashHelp = [
    "/help — this screen",
    "/copy — copy the transcript to the clipboard (also a /tmp fallback file)",
    "/copy-session — full diagnostic dump: transcript, context, counts (clipboard + /tmp)",
    "these are the only slash commands; anything else starting with / is not sent to the agent",
    "keys: ctrl+x stop · shift+tab send mode · ctrl+e fold cards · ctrl+o jump · ctrl+p palette · ctrl+h sidebar · ctrl+c quit",
  ].join("\n");

  const runSlash = async (raw: string) => {
    const match = /^\/(\S+)(?:\s+(.*))?$/.exec(raw.trim());
    const command = (match?.[1] ?? "").toLowerCase();
    try {
      if (command === "help" || command === "h" || command === "?") {
        pushStatus(slashHelp);
      } else if (command === "copy") {
        const text = transcript.toPlainText();
        const result = await copyWithFallback(text, "transcript");
        pushStatus(`/copy — ${result.where} (${text.split("\n").length} lines) · fallback file: ${result.fallbackPath}`);
      } else if (command === "copy-session") {
        const brainState = await brain.read();
        const entries = (await sessionTranscript(state.session)) as unknown as ContextEntryLike[];
        const lines: string[] = [
          `# carto session dump — ${new Date().toISOString()}`,
          `project: ${options.root}`,
          `generation: ${state.session.generation}`,
          `model: ${modelLabel} · ${state.session.state.contextWindow > 0 ? `window ${state.session.state.contextWindow.toLocaleString("en-US")}` : "window unknown"}`,
          `last provider report: ${state.session.state.lastReportedInput?.toLocaleString("en-US") ?? "none"} + tool work since +${state.session.state.toolWorkAtLastReport.toLocaleString("en-US")}`,
          `atlas ${brainState.atlas.length} · ledger ${brainState.ledger.length} · chat ${brainState.chat.length} · pins ${brainState.userPins.length + brainState.carryPins.length} · wakes ${brainState.wakes.length}`,
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
        pushStatus(`/copy-session — ${result.where} (${text.split("\n").length} lines) · fallback file: ${result.fallbackPath}`);
      } else {
        pushStatus(`unknown command /${command} — /help lists them`);
      }
    } catch (error) {
      pushStatus(`/${command} failed: ${errorText(error)}`);
    }
    await rebuildTranscript();
  };

  editor.onSubmit = (text: string) => {
    const message = text.trim();
    if (message.length === 0) return;
    editor.addToHistory(message);
    if (message.startsWith("/")) {
      void runSlash(message);
      return;
    }
    state.pending.push({ text: message, at: Date.now(), mode: state.sendMode });
    void rebuildTranscript();
    void runSubmission(message);
  };

  const showPalette = () => {
    if (state.overlayOpen) return;
    state.overlayOpen = true;
    const commands: PaletteCommand[] = [
      {
        value: "chat",
        label: "switch to chat view",
        hint: "^o c",
        run: () => void switchToView("chat"),
      },
      {
        value: "atlas",
        label: "switch to atlas view",
        hint: "^o a",
        run: () => void switchToView("atlas"),
      },
      {
        value: "ledger",
        label: "switch to ledger view",
        hint: "^o l",
        run: () => void switchToView("ledger"),
      },
      {
        value: "context",
        label: "switch to context surgery view",
        hint: "^o x",
        run: () => void switchToView("context"),
      },
      {
        value: "collapse",
        label: "collapse the context now",
        hint: "the Brain rebuilds it",
        run: () => void runCollapse("person requested (palette)"),
      },
      {
        value: "sidebar",
        label: "toggle the sidebar",
        hint: "ctrl+h",
        run: () => {
          state.sidebarVisible = !state.sidebarVisible;
          tui.requestRender();
        },
      },
      {
        value: "quit",
        label: "quit carto",
        hint: "ctrl+c",
        run: () => void shutdown(0),
      },
    ];
    const palette = new Palette(commands);
    palette.onClose = closeOverlay;
    state.overlayHandle = tui.showOverlay(palette, { width: 58, anchor: "bottom-center", offsetY: -2 });
    tui.setFocus(palette);
  };

  const showJump = () => {
    if (state.overlayOpen) return;
    state.overlayOpen = true;
    const jump = new JumpOverlay(JUMP_TARGETS);
    jump.onClose = closeOverlay;
    jump.onJump = (key) => {
      if (key === "c") void switchToView("chat");
      else if (key === "a") void switchToView("atlas");
      else if (key === "l") void switchToView("ledger");
      else if (key === "x") void switchToView("context");
    };
    state.overlayHandle = tui.showOverlay(jump, { width: 52, anchor: "center" });
    tui.setFocus(jump);
  };

  tui.addInputListener((data) => {
    if (state.overlayOpen) return undefined;
    if (matchesKey(data, "ctrl+c")) {
      void shutdown(0);
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+x")) {
      if (state.running) {
        void interruptRun(state.session).then(
          () => pushStatus("interrupt sent — the run stops"),
          (error: unknown) => pushStatus(`interrupt failed: ${errorText(error)}`),
        ).then(() => rebuildTranscript());
      } else {
        tui.flash("no run in flight", 1_500);
      }
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab") && state.view === "chat") {
      state.sendMode = nextSendMode(state.sendMode);
      tui.flash(`send mode: ${sendModeLabel(state.sendMode)}`, 1_200);
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+e") && state.view === "chat") {
      transcript.toggleAllCards();
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      showJump();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+p")) {
      showPalette();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+h")) {
      state.sidebarVisible = !state.sidebarVisible;
      tui.requestRender();
      return { consume: true };
    }
    return undefined;
  });

  liveTimer = setInterval(() => {
    void rebuildTranscript().catch(() => undefined);
  }, 1_500);

  void startLiveWatch();
  await rebuildTranscript();
  return runDone;
}
