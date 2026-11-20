/**
 * The workspace (MINI.md §8 as re-scoped 2026-11-20 — modes, not tabs; the
 * Posting layout philosophy on pi-tui primitives).
 *
 * Chat is the boot view; the Context surgery view and the Brain views land in
 * their own slices and are honestly absent — jumping to them flashes the slice
 * that owns them rather than rendering a fake. The transcript shows the
 * person's lines where they LANDED in the context (not where they were typed),
 * the agent's `chat` words, and quiet status lines; plain model text never
 * appears (MINI.md §10a). Submitted lines whose placement has not happened yet
 * render dimmed as queued and move into place at the boundary.
 *
 * Lines starting with `/` are workspace commands (/help, /copy, /copy-session)
 * and never reach the agent.
 *
 * State is one explicit value; behaviour is functions over it (MINI.md §12).
 * Pi performs; Carto adds only the composition.
 */
import { Writable } from "node:stream";
import { basename } from "node:path";

import {
  Editor,
  HStack,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  VStack,
  type OverlayHandle,
} from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

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
import { staleMarks } from "../runtime/carto-extension.js";
import { STATE_BLOCK_MARKER } from "../domain/state-block.js";
import type { BrainStore } from "../runtime/brain-store.js";

import { FooterView, HeaderView, nextSendMode, sendModeLabel, type SendMode } from "./chrome.js";
import { copyWithFallback, createSelectionCopier } from "./clipboard.js";
import { flattenEntry } from "./dump.js";
import { JumpOverlay, JUMP_TARGETS } from "./jump.js";
import { Palette, selectTheme, type PaletteCommand } from "./palette.js";
import { Sidebar, sidebarWidth, type BookKind, type SidebarCounts } from "./sidebar.js";
import { TranscriptView, type TranscriptEntry } from "./transcript.js";
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
  /** Warning watermark: agent record ids observed since the last collapse reset; drives the plain-text-answer detection. */
  seenChat: Set<string>;
  /** Render exclusion: agent records already shown (boot history, or sealed by a collapse). Persists across collapses. */
  sealedAgentIds: Set<string>;
  sendMode: SendMode;
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
  /** Watermark into context assistant entries, for the plain-text-answer warning. */
  assistantWatermark: number;
  rebuilding: boolean;
  /** Cheap change signature so the 1.5s timer does not bust the render cache when nothing moved. */
  sig: string;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const suffix = (generation: string): string => generation.slice(-6);

async function agentChatSeen(brain: BrainStore): Promise<Set<string>> {
  const state = await brain.read();
  return new Set(state.chat.filter((record) => record.author === "agent").map((record) => record.id));
}

function countSidebar(brainState: Awaited<ReturnType<BrainStore["read"]>>): SidebarCounts {
  // Typed marks, not prefix parsing: the stale kind is what the Brain reports.
  const marks = staleMarks(brainState);
  const stale: Partial<Record<BookKind, number>> = {};
  for (const mark of marks) {
    const kind: BookKind = mark.kind === "pin" ? "pins" : "atlas";
    stale[kind] = (stale[kind] ?? 0) + 1;
  }
  return {
    atlas: brainState.atlas.length,
    ledger: brainState.ledger.length,
    chat: brainState.chat.length,
    pins: brainState.userPins.length + brainState.carryPins.length,
    wakes: brainState.wakes.length,
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
}

function messageOf(entry: ContextEntryLike): MessageLike | undefined {
  if (!Array.isArray(entry.model) || entry.model.length === 0) return undefined;
  const message = entry.model[0];
  return message !== null && typeof message === "object" ? (message as MessageLike) : undefined;
}

function timestampOf(message: MessageLike): number {
  return typeof message.timestamp === "number" ? message.timestamp : 0;
}

function hasTextPart(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => part !== null && typeof part === "object" && (part as Record<string, unknown>).type === "text" && String((part as Record<string, unknown>).text ?? "").trim().length > 0);
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
    seenChat: await agentChatSeen(brain),
    sealedAgentIds: await agentChatSeen(brain),
    sendMode: "steer",
    running: false,
    pending: [],
    sealed: [],
    statusLog: [],
    inFlight: 0,
    collapsing: false,
    sidebarVisible: true,
    overlayOpen: false,
    overlayHandle: undefined,
    assistantWatermark: 0,
    rebuilding: false,
    sig: "",
  };

  const terminal = new ProcessTerminal();
  // The same verified-native clipboard path the mouse selection copies through;
  // without it pi-tui falls back to a bare OSC 52 write, which can lie.
  const tui = new TuiAltScreen(terminal, undefined, undefined, { copySelection: createSelectionCopier() });

  const project = basename(options.root.replace(/[/\\]+$/, ""));
  const modelLabel = `${options.model.provider}/${options.model.modelId}`;
  const headerState = { project, modelLabel, session: state.session };
  const header = new HeaderView(headerState);
  const footer = new FooterView(state);
  const transcript = new TranscriptView();
  const sidebar = new Sidebar();
  const scroll = new ScrollView(transcript, { follow: "end", primary: true, overscroll: "chain" });
  const editorTheme = { borderColor: (line: string) => tokens.muted(line), selectList: selectTheme };
  const editor = new Editor(tui, editorTheme);

  const refreshSidebar = async () => {
    sidebar.setCounts(countSidebar(await brain.read()));
    tui.requestRender();
  };

  sidebar.setCounts(countSidebar(await brain.read()));

  tui.setLayoutRoot(
    new VStack([
      { component: header, basis: "auto" },
      {
        component: new HStack([
          { component: sidebar, basis: sidebarWidth, visible: () => state.sidebarVisible },
          { component: scroll, basis: 0, grow: 1, minSize: 3 },
        ]),
        basis: 0,
        grow: 1,
        minSize: 3,
      },
      { component: editor, basis: "auto", minSize: 3 },
      { component: footer, basis: 1 },
    ]),
  );
  tui.start();
  tui.setFocus(editor);

  const closeOverlay = () => {
    state.overlayHandle?.hide();
    state.overlayHandle = undefined;
    state.overlayOpen = false;
    tui.setFocus(editor);
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

      const person: Array<{ key: number; entry: TranscriptEntry }> = [];
      let sawPlainTextSinceWatermark = false;
      let watermark = state.assistantWatermark;
      const landedTexts: Array<{ text: string; t: number }> = [];
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
        } else if (role === "assistant") {
          if (id > watermark) watermark = id;
          if (hasTextPart(message.content) && id > state.assistantWatermark) sawPlainTextSinceWatermark = true;
        }
      }
      state.assistantWatermark = watermark;

      const agent: Array<{ key: number; entry: TranscriptEntry }> = [];
      const freshAgentIds: string[] = [];
      for (const record of brainState.chat) {
        if (record.author !== "agent") continue;
        if (!state.seenChat.has(record.id)) {
          state.seenChat.add(record.id);
          freshAgentIds.push(record.id);
        }
        if (state.sealedAgentIds.has(record.id)) continue; // shown already (boot burst or sealed by a collapse)
        agent.push({ key: anchorAt(record.createdAt) + 0.5, entry: { kind: "agent", text: record.text } });
      }

      if (sawPlainTextSinceWatermark && freshAgentIds.length === 0) {
        pushStatus("the agent answered in plain text — nothing renders here by design (§10a); ask it to say it in chat");
      }

      // Clear pending items whose placement we can now see: same text, an
      // entry placed at or after the submit. Best effort, matches oldest first.
      if (state.pending.length > 0) {
        const remaining: PendingItem[] = [];
        const pool = [...landedTexts];
        for (const item of state.pending) {
          const index = pool.findIndex((landed) => landed.text === item.text && landed.t >= item.at - 5_000);
          if (index >= 0) pool.splice(index, 1);
          else remaining.push(item);
        }
        state.pending = remaining;
      }

      const statusMerged = state.statusLog.map((item) => ({ key: anchorAt(item.t) + 0.5, entry: item.entry }));

      const sig = [
        state.sealed.length,
        person.map((item) => item.key).join(","),
        String(agent.length),
        state.sealedAgentIds.size,
        state.statusLog.length,
        state.pending.map((item) => item.text).join("\u0001"),
      ].join("|");
      if (sig !== state.sig) {
        state.sig = sig;
        const live = [...person, ...agent, ...statusMerged];
        live.sort((left, right) => left.key - right.key);
        // Sealed history is an immutable prefix; the live segment follows in the frame's order.
        transcript.setEntries(
          [...state.sealed, ...live.map((item) => item.entry)],
          state.pending.map((item) => ({ text: item.text, mode: item.mode })),
        );
        tui.requestRender();
      }
    } finally {
      state.rebuilding = false;
    }
  };

  const runCollapse = async (reason: string) => {
    if (state.collapsing) return;
    state.collapsing = true;
    const previous = state.session.generation;
    // Seal the conversation as it renders right now: post-collapse the context
    // is rebuilt from the Brain and no longer holds these entries.
    if (state.pending.length > 0) {
      pushStatus(`${state.pending.length} queued message(s) dropped by the collapse`);
      state.pending = [];
    }
    // seal: the rendered prefix becomes history; the status log rides along inside it
    state.sealed = [...state.sealed, ...transcript.snapshot()];
    state.statusLog = [];
    try {
      const before = await brain.read();
      for (const record of before.chat) if (record.author === "agent") state.sealedAgentIds.add(record.id);
      const outcome = await collapseLiveSession(state.session, options, reason);
      state.session = outcome.session;
      headerState.session = outcome.session;
      state.assistantWatermark = 0;
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
      // If the message was admitted idle, it is placed in the context right
      // now; flip the line out of queued immediately rather than at settle.
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
    // Move placed lines to where they landed, drain new chat words, flag a
    // silent plain-text answer. The landed order is the context's order.
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
    "keys: ctrl+x stop · shift+tab send mode · ctrl+o jump · ctrl+p palette · ctrl+h sidebar · ctrl+c quit",
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
          `model: ${modelLabel} · window ${state.session.contextWindow.toLocaleString("en-US")}`,
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
    void rebuildTranscript(); // paint the queued line immediately
    void runSubmission(message);
  };

  const showPalette = () => {
    if (state.overlayOpen) return;
    state.overlayOpen = true;
    const commands: PaletteCommand[] = [
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
      if (key === "c") {
        tui.setFocus(editor);
        return;
      }
      const label = JUMP_TARGETS.find((target) => target.key === key)?.label ?? key;
      tui.flash(`jump: ${label.split(" — ")[0]} — lands with its slice`, 2_500);
    };
    state.overlayHandle = tui.showOverlay(jump, { width: 46, anchor: "center" });
    tui.setFocus(jump);
  };

  tui.addInputListener((data) => {
    // A focused overlay owns the keys; the palette and jump overlay handle
    // their own escape/cancel, so nothing leaks to a global action.
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
    if (matchesKey(data, "shift+tab")) {
      state.sendMode = nextSendMode(state.sendMode);
      tui.flash(`send mode: ${sendModeLabel(state.sendMode)}`, 1_200);
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

  // Cheap heartbeat: while a run is in flight the boundary can land at any
  // time; pick up placements and new chat words even between settle hooks.
  liveTimer = setInterval(() => {
    void rebuildTranscript().catch(() => undefined);
  }, 1_500);

  await rebuildTranscript();
  return runDone;
}
