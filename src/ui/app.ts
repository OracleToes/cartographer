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
import { createBashTool } from "@earendil-works/pi-durable/tools";

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
import { createTools } from "../runtime/tools.js";
import { CARTO_INSTRUCTIONS, renderLiveStateBlock, staleMarks } from "../runtime/carto-extension.js";
import { isMarkerMessage, splitContextMessages, STATE_BLOCK_MARKER, type MessageLike as BlockMessageLike } from "../domain/state-block.js";
import type { BrainStore } from "../runtime/brain-store.js";

import { FooterView, HeaderView, nextSendMode, sendModeLabel, type SendMode, type ViewMode } from "./chrome.js";
import { TokenBarView, type TokenBarState } from "./token-bar.js";
import { copyWithFallback, createSelectionCopier } from "./clipboard.js";
import { flattenEntry } from "./dump.js";
import { JumpOverlay, JUMP_TARGETS } from "./jump.js";
import { Palette, selectTheme, type PaletteCommand } from "./palette.js";
import { Sidebar, sidebarWidth, type BookKind, type SidebarCounts } from "./sidebar.js";
import { TranscriptView, formatToolArgs, type CardEntry, type TranscriptEntry } from "./transcript.js";
import { AtlasView } from "./atlas-view.js";
import { LedgerView } from "./ledger-view.js";
import { ContextView, type ContextDialogueMessage, type ContextToolItem, type ContextWorkItem } from "./context-view.js";
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

function countSidebar(brainState: Awaited<ReturnType<BrainStore["read"]>>, contextTokens: number = 0): SidebarCounts {
  const marks = staleMarks(brainState);
  const stale: Partial<Record<"atlas" | "ledger", number>> = {};
  for (const mark of marks) {
    if (mark.kind === "atlas") {
      stale.atlas = (stale.atlas ?? 0) + 1;
    }
  }
  return {
    chat: brainState.chat.length,
    contextTokens,
    atlas: brainState.atlas.length,
    ledger: brainState.ledger.length,
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

  sidebar.onSelect = (book) => void switchToView(book);

  const refreshSidebar = async () => {
    const brainState = await brain.read();
    const contextTokens = barState.parts.system + barState.parts.transcript + barState.parts.toolWork;
    sidebar.setCounts(countSidebar(brainState, contextTokens));
    sidebar.setActiveBook(state.view);
    tui.requestRender();
  };

  await refreshSidebar();

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

    const entries = (await sessionTranscript(state.session)) as unknown as ContextEntryLike[];
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
      { root: options.root, brain, session: state.session.state, markdownPath: join(options.root, ".brain/context", ".projection.md") },
      [],
    );

    contextView.setData({
      brain: brainState,
      systemPrompt: CARTO_INSTRUCTIONS,
      tools: allTools,
      transcriptMessages,
      toolWorkItems,
      stateBlockText: stateBlock,
    });
  };

  const switchToView = async (view: ViewMode) => {
    state.view = view;
    headerState.view = view;
    footer.invalidate();
    sidebar.setActiveBook(view);

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
      await syncContextView(brainState);
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
              { component: scroll, basis: 0, grow: 1, minSize: 3, visible: () => state.view === "chat" },
              { component: atlasView, basis: 0, grow: 1, minSize: 3, visible: () => state.view === "atlas" },
              { component: ledgerView, basis: 0, grow: 1, minSize: 3, visible: () => state.view === "ledger" },
              { component: contextView, basis: 0, grow: 1, minSize: 3, visible: () => state.view === "context" },
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
        agent.push({ key: anchorAt(record.createdAt) + 0.5, entry: { kind: "agent", text: record.text } });
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
        String(agent.length),
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
        tui.requestRender();
      }

      if (state.view === "context") {
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
