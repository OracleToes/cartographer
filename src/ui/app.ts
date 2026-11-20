/**
 * The workspace (MINI.md §8 as re-scoped 2026-11-20 — modes, not tabs; the
 * Posting layout philosophy on pi-tui primitives).
 *
 * Chat is the boot view; the Context surgery view and the Brain views land in
 * their own slices and are honestly absent — jumping to them flashes the slice
 * that owns them rather than rendering a fake. The transcript shows the
 * person's lines and the agent's `chat` words only; plain model text is not
 * person-facing (MINI.md §10a). The token bar lands in R5b.
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
  submitInput,
  type LiveSession,
  type LiveSessionOptions,
} from "../runtime/live-session.js";
import { applyCapacityRefresh } from "../runtime/headless.js";
import { staleMarks } from "../runtime/carto-extension.js";
import type { BrainStore } from "../runtime/brain-store.js";

import { FooterView, HeaderView, nextSendMode, sendModeLabel, type SendMode } from "./chrome.js";
import { JumpOverlay, JUMP_TARGETS } from "./jump.js";
import { Palette, selectTheme, type PaletteCommand } from "./palette.js";
import { Sidebar, sidebarWidth, type BookKind, type SidebarCounts } from "./sidebar.js";
import { TranscriptView } from "./transcript.js";
import { tokens } from "./tokens.js";

export interface CartoTuiOptions extends LiveSessionOptions {
  /** When true, the provider catalog is re-discovered before boot and after every settled run (llama-swap advertises capacity once the model has loaded). */
  refreshCapacity?: boolean;
}

interface TuiState {
  session: LiveSession;
  seenChat: Set<string>;
  sendMode: SendMode;
  running: boolean;
  collapsing: boolean;
  sidebarVisible: boolean;
  overlayOpen: boolean;
  overlayHandle: OverlayHandle | undefined;
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
    sendMode: "steer",
    running: false,
    collapsing: false,
    sidebarVisible: true,
    overlayOpen: false,
    overlayHandle: undefined,
  };

  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);

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
          { component: scroll, basis: 0, grow: 1, minSize: 1 },
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
  const shutdown = async (code: number): Promise<void> => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    tui.stop();
    await closeLiveSession(state.session);
    resolveRun?.(code);
  };

  const drainAgentChat = async () => {
    for (const record of (await brain.read()).chat) {
      if (record.author !== "agent" || state.seenChat.has(record.id)) continue;
      state.seenChat.add(record.id);
      transcript.add({ kind: "agent", text: record.text });
    }
  };

  const runCollapse = async (reason: string) => {
    if (state.collapsing) return;
    state.collapsing = true;
    const previous = state.session.generation;
    try {
      const outcome = await collapseLiveSession(state.session, options, reason);
      state.session = outcome.session;
      headerState.session = outcome.session;
      state.seenChat = await agentChatSeen(brain);
      transcript.add({
        kind: "status",
        text: `collapsed and rebuilt from the Brain (${suffix(previous)} → ${suffix(outcome.report.generation)})`,
      });
      await refreshSidebar();
    } catch (error) {
      transcript.add({ kind: "status", text: `collapse failed: ${errorText(error)}` });
    } finally {
      state.collapsing = false;
      state.running = false;
      tui.requestRender();
    }
  };

  const refreshAdvertisedWindow = async () => {
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        const line = String(chunk).trim();
        if (line.length > 0) transcript.add({ kind: "status", text: line });
        callback();
      },
    });
    await applyCapacityRefresh(state.session, refresh, options.models, options.model.provider, options.model.modelId, sink);
  };

  const runSubmission = async (message: string) => {
    if (state.collapsing) {
      transcript.add({ kind: "status", text: "collapsing — hold on" });
      return;
    }
    state.running = true;
    tui.requestRender();
    try {
      if (state.sendMode === "now") await interruptRun(state.session);
      const whenBusy = state.sendMode === "after run" ? "followUp" : "steer";
      const submission = await submitInput(state.session, message, whenBusy);
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      if (settled.status !== "done") {
        transcript.add({ kind: "status", text: `the run ended with status "${settled.status}"` });
      }
    } catch (error) {
      transcript.add({ kind: "status", text: `the run failed: ${errorText(error)}` });
    }
    await drainAgentChat();
    const reason = state.session.takeCollapseRequest();
    if (reason !== null) await runCollapse(reason);
    if (options.refreshCapacity === true) await refreshAdvertisedWindow();
    await refreshSidebar();
    state.running = false;
    tui.requestRender();
  };

  editor.onSubmit = (text: string) => {
    const message = text.trim();
    if (message.length === 0) return;
    transcript.add({ kind: "person", text: message });
    editor.addToHistory(message);
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
          () => transcript.add({ kind: "status", text: "interrupt sent — the run stops" }),
          (error: unknown) => transcript.add({ kind: "status", text: `interrupt failed: ${errorText(error)}` }),
        );
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

  return runDone;
}
