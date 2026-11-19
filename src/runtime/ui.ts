import {
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  type Component,
} from "@earendil-works/pi-tui";

import { visibleChat } from "../domain/brain.js";
import { mergeCarryPins } from "../domain/context.js";
import { handleOf } from "../domain/handles.js";
import type { CartoProject, ProjectView, SendMode } from "./project.js";
import type { LiveActivity } from "./live-session.js";
import { parseCommand, runCommand, type UiCommand } from "../ui/commands.js";
import { actionContextOf, clampSelection, helpLines, renderFrame, type Detail, type FrameState, type Tab } from "../ui/frame.js";
import { SPINNER_INTERVAL_MS } from "../ui/spinner.js";
import { token } from "../ui/tokens.js";

export { disclosureLines } from "../ui/body.js";
export { parseCommand, type UiCommand } from "../ui/commands.js";

type Mode = "navigate" | "insert";

/**
 * The person's screen.
 *
 * One state object, one frame clock, one pure renderer. The clock runs at
 * 100 ms while anything is moving (a run, a local action, the spinner) and
 * stops when the screen is still, so an idle Carto uses no timer at all.
 *
 * Storage tells the screen when to look: a document watch marks the frame
 * dirty on every commit, and the prefill monitor marks it dirty on every
 * server report. Neither renders; the clock does, once, with whatever the two
 * produced. That is what makes a streamed answer appear without a key press.
 */
export async function runCartoUi(project: CartoProject): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("carto needs an interactive terminal for the Carto UI.");

  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, true, undefined, { mouse: true });
  const chrome = new Text();
  const body = new Text();
  const footer = new Text();
  const editor = new Editor(tui, editorTheme());
  const scroll = new ScrollView(body, { primary: true, follow: "end", scrollbar: "auto" });
  // The footer takes the whole bottom row; the bar and the chrome sit above
  // the body, so the bar never moves when the body scrolls.
  tui.setLayoutRoot(new VStack([chrome, { component: scroll, grow: 1 }, footer], { gap: 0 }));

  let tab: Tab = "chat";
  let mode: Mode = "navigate";
  let detail: Detail = null;
  let selected = 0;
  let applying = false;
  let quitting = false;
  let sendMode: SendMode = "follow-up";
  let insertAction: "send" | "edit-chat" | "agent-chat" | "resume" = "send";
  let view = await project.view();
  const folds = new Set<string>();
  const expandedActivity = new Set<string>();
  let notice: { text: string; kind: "info" | "error" } | undefined;
  let error: string | undefined;
  let startedAt = performance.now();
  let runStartedAt: number | undefined;
  let lastPaintedAt = performance.now();
  let spinnerPaintAt = -1;
  let dirty = true;
  let width = terminal.columns;
  let resolveExit: (() => void) | undefined;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const clock = (): number => Date.now();

  /** One state value, built from what the last reads produced. */
  const currentState = (): FrameState => ({
    root: project.root,
    model: project.config.model,
    view,
    ...(project.prefill().current === undefined ? {} : { prefill: project.prefill().current }),
    ...(project.prefill().last === undefined ? {} : { lastReading: project.prefill().last }),
    contextWindow: project.prefill().window,
    tab,
    mode,
    detail,
    selected,
    folds,
    expandedActivity,
    sendMode,
    ...(runStartedAt === undefined ? {} : { runStartedAt }),
    applying,
    ...(notice === undefined ? {} : { notice }),
    ...(error === undefined ? {} : { error }),
    now: clock(),
    startedAt,
  });

  /** Draw the frame. The only function that writes to the terminal. */
  const paint = (force = false): void => {
    if (quitting) return;
    const state = currentState();
    const frame = renderFrame(state, width);
    chrome.setText(frame.top.join("\n"));
    body.setText(frame.body.join("\n"));
    footer.setText(frame.bottom.join("\n"));
    spinnerPaintAt = state.now;
    dirty = false;
    if (force) tui.requestRender(true);
    else tui.requestRender();
    lastPaintedAt = performance.now();
  };

  /** Read the project again, then draw. A read never writes. */
  const refresh = async (live = false): Promise<void> => {
    try {
      view = live ? await project.liveFrameView() : await project.view();
      const turn = view.turn.state;
      if (turn === "running" && runStartedAt === undefined) runStartedAt = clock();
      if (turn !== "running") runStartedAt = undefined;
      error = undefined;
      dirty = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      dirty = true;
    }
  };

  const active = (): boolean => applying || view.turn.state !== "idle" || project.prefill().current?.phase === "reading";

  /**
   * The frame clock. It ticks at 100 ms while something moves, and it stops
   * when nothing does. While idle it still wakes once a second, so a wake that
   * fires is seen even if no commit reaches this process.
   */
  let ticker: NodeJS.Timeout | undefined;
  const tick = async (): Promise<void> => {
    if (quitting) return;
    const now = clock();
    if (active() && (dirty || now - spinnerPaintAt >= SPINNER_INTERVAL_MS)) {
      // A live read is cheap; the transcript is read when a commit says so.
      if (dirty) await refresh(true);
      paint();
    } else if (dirty) {
      paint();
    }
    ticker = setTimeout(() => void tick(), active() ? SPINNER_INTERVAL_MS : 1_000);
    ticker.unref();
  };

  const stop = (): void => {
    if (ticker !== undefined) clearTimeout(ticker);
    ticker = undefined;
  };

  const quit = (): void => {
    if (quitting) return;
    quitting = true;
    stop();
    tui.stop();
    detach();
    resolveExit?.();
  };

  const work = async (task: () => Promise<void>): Promise<void> => {
    if (applying) {
      notice = { text: "Carto is already applying a local action.", kind: "info" };
      dirty = true;
      return;
    }
    applying = true;
    dirty = true;
    try {
      await task();
      notice = undefined;
    } catch (cause) {
      notice = { text: cause instanceof Error ? cause.message : String(cause), kind: "error" };
      dirty = true;
    } finally {
      applying = false;
      await refresh();
      paint();
    }
  };

  const submit = async (text: string): Promise<void> => {
    const value = text.trim();
    if (value === "") return;
    editor.setText("");
    editor.addToHistory(value);
    const action = insertAction;
    insertAction = "send";
    mode = "navigate";
    detail = null;
    tui.setFocus(null);
    if (action === "edit-chat") {
      const entry = selectedChat(view, clampSelection({ tab, view, selected }));
      if (entry !== undefined) await work(() => project.editChat(entry.id, value));
      return;
    }
    if (action === "agent-chat") {
      await work(() => project.addAgentChat(value));
      return;
    }
    if (action === "resume") {
      await work(() => project.resumeTurn(value));
      return;
    }
    let command: UiCommand | undefined;
    try {
      command = parseCommand(value);
    } catch (cause) {
      notice = { text: cause instanceof Error ? cause.message : String(cause), kind: "error" };
      dirty = true;
      paint();
      return;
    }
    if (command !== undefined) {
      await work(() => runCommand(project, command));
      return;
    }
    // A send is admitted now; the run itself is watched, not awaited, so the
    // screen keeps drawing while the agent works.
    await work(async () => {
      await project.send(value, sendMode);
    });
  };
  editor.onSubmit = (text) => void submit(text);

  const enterInsert = (seed = "", action: "send" | "edit-chat" | "agent-chat" | "resume" = "send"): void => {
    mode = "insert";
    insertAction = action;
    editor.setText(seed);
    tui.setFocus(editor);
    dirty = true;
  };
  const navigate = (): void => {
    mode = "navigate";
    tui.setFocus(null);
    dirty = true;
  };

  const signalHandler = (): void => quit();
  process.once("SIGINT", signalHandler);
  const removeInput = tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
      quit();
      return { consume: true };
    }
    if (mode === "insert") {
      if (matchesKey(data, Key.escape)) {
        navigate();
        return { consume: true };
      }
      return undefined;
    }
    if (matchesKey(data, Key.escape)) {
      detail = null;
      navigate();
      return { consume: true };
    }
    if (matchesKey(data, Key.backspace)) {
      if (detail !== null) detail = null;
      else selected = 0;
      dirty = true;
      return { consume: true };
    }
    if (data === "1") return switchTab("chat");
    if (data === "2") return switchTab("brain");
    if (data === "3") return switchTab("context");
    if (data === "j" || matchesKey(data, Key.down)) {
      selected += 1;
      selected = clampSelection({ tab, view, selected });
      dirty = true;
      return { consume: true };
    }
    if (data === "k" || matchesKey(data, Key.up)) {
      selected = Math.max(0, selected - 1);
      dirty = true;
      return { consume: true };
    }
    if (data === "g" || matchesKey(data, Key.home)) {
      selected = 0;
      dirty = true;
      return { consume: true };
    }
    if (data === "G" || matchesKey(data, Key.end)) {
      selected = 9_999;
      selected = clampSelection({ tab, view, selected });
      dirty = true;
      return { consume: true };
    }
    if (data === "i" || matchesKey(data, Key.enter)) {
      if (tab === "chat" && selectedChat(view, clampSelection({ tab, view, selected })) !== undefined && detail === "chat") {
        enterInsert(selectedChat(view, clampSelection({ tab, view, selected }))!.text, "edit-chat");
      } else {
        enterInsert();
      }
      return { consume: true };
    }
    if (data === "a") {
      detail = detail === "actions" ? null : "actions";
      dirty = true;
      return { consume: true };
    }
    if (data === "?") {
      detail = detail === "help" ? null : "help";
      dirty = true;
      return { consume: true };
    }
    if (data === "f" && tab === "chat") {
      const entry = selectedChat(view, clampSelection({ tab, view, selected }));
      if (entry !== undefined) {
        if (folds.has(entry.id)) folds.delete(entry.id);
        else folds.add(entry.id);
        dirty = true;
      }
      return { consume: true };
    }
    if (data === "e" && tab === "chat") {
      if (selectedChat(view, clampSelection({ tab, view, selected })) !== undefined) {
        detail = "chat";
        dirty = true;
      }
      return { consume: true };
    }
    if (data === "o" && tab === "chat") {
      const item = selectedActivity(view, clampSelection({ tab, view, selected }));
      if (item !== undefined) {
        if (expandedActivity.has(item.id)) expandedActivity.delete(item.id);
        else expandedActivity.add(item.id);
        dirty = true;
      }
      return { consume: true };
    }
    if (data === "A" && tab === "chat") {
      enterInsert("", "agent-chat");
      return { consume: true };
    }
    if ((data === "d" || data === "D") && tab === "chat") {
      const entry = selectedChat(view, clampSelection({ tab, view, selected }));
      const handle = entry === undefined ? undefined : handleOf(view.brain.handles, "chat", entry.id);
      if (handle !== undefined) void work(() => (data === "D" ? project.deleteHandleNow(handle) : project.markHandleForDeletion(handle)));
      return { consume: true };
    }
    if ((data === "u" || data === "U") && tab === "context") {
      const pin = selectedPin(view, clampSelection({ tab, view, selected }));
      const handle = pin === undefined ? undefined : handleOf(view.brain.handles, "pin", pin.id);
      if (handle !== undefined) void work(() => (data === "U" ? project.removePinHandleNow(handle) : project.removePinHandleAtCollapse(handle)));
      return { consume: true };
    }
    if (data === "p") {
      void work(() => project.pauseTurn());
      return { consume: true };
    }
    if (data === "r") {
      if (view.turn.state === "paused") enterInsert(view.turn.pausedDraft ?? "", "resume");
      else void work(() => project.continueTurn());
      return { consume: true };
    }
    if (data === "x") {
      void work(() => project.cancelTurn());
      return { consume: true };
    }
    if (data === "I") {
      sendMode = "interruption";
      enterInsert();
      return { consume: true };
    }
    if (data === "S") {
      sendMode = "steer";
      enterInsert();
      return { consume: true };
    }
    if (data === "F") {
      sendMode = "follow-up";
      enterInsert();
      return { consume: true };
    }
    return undefined;

    function switchTab(next: Tab): { consume: true } {
      tab = next;
      selected = 0;
      detail = null;
      dirty = true;
      return { consume: true };
    }
  });

  // Storage says when to look. A commit marks the frame dirty; it never
  // renders, because a render inside a watch callback would fight the writer.
  let detach = (): void => undefined;
  try {
    const liveWatch = await project.watchLive(() => {
      dirty = true;
    });
    const prefillOff = project.onPrefill(() => {
      dirty = true;
    });
    detach = () => {
      liveWatch();
      prefillOff();
    };
  } catch {
    // A watch is an optimization, not the source of truth: the clock still
    // refreshes while anything is active, and every local action refreshes.
    detach = () => undefined;
  }

  await refresh();
  paint(true);
  tui.setFocus(null);
  tui.start();
  startedAt = performance.now();
  ticker = setTimeout(() => void tick(), SPINNER_INTERVAL_MS);
  ticker.unref();
  await exit;
  removeInput();
  process.off("SIGINT", signalHandler);
}

function editorTheme() {
  return {
    borderColor: token.muted,
    selectList: {
      selectedPrefix: token.accent,
      selectedText: token.accent,
      noMatch: token.muted,
      description: token.muted,
      scrollInfo: token.muted,
    },
  };
}

/** The detail overlay, drawn under the body, so the body stays where it was. */
function detailLines(state: FrameState, columns: number): string[] {
  const inner = Math.max(4, columns - 4);
  if (state.detail === "help") return ["", ...helpLines(state, inner)];
  if (state.detail === "actions") {
    const context = actionContextOf(state);
    return [
      "",
      token.sectionActive("Commands"),
      `${token.accent("/collapse")} ${token.muted("request a collapse")} · ${token.accent("/confirm-collapse")} · ${token.accent("/cancel-collapse")}`,
      `${token.accent("/delete HANDLE")} · ${token.accent("/delete-now HANDLE")} · ${token.accent("/undelete HANDLE")}`,
      `${token.accent("/unpin P#")} · ${token.accent("/unpin-now P#")} · ${token.accent("/pin ITEM | REASON")}`,
      `${token.accent("/pin-file path:1-9 | ITEM | REASON")} · ${token.accent("/refresh")}`,
      `${token.accent("/ledger [L#] | goal|note|question | open|answered|closed | TEXT [| ANSWER]")}`,
      `${token.accent("/atlas [A#] | TITLE | CLAIM | path:1-9 [| LINK,LINK]")}`,
      `${token.accent("/handoff INTENT | NEXT ACTION [| NOTE]")} · ${token.accent("/clear-handoff")}`,
      `${token.accent("/wake [W#] | time|path | CONDITION | REASON")} · ${token.accent("/cancel-wake W# [| REASON]")}`,
      `${token.accent("/approve X#")} · ${token.accent("/reject X#")}`,
      "",
      token.muted(`Esc closes. Handles are short and local to this context${context.busy ? "; Carto is working now." : "."}`),
    ];
  }
  if (state.detail === "chat") {
    return [
      "",
      token.warning("Chat edit selected. Press i to replace its text."),
      token.muted("d marks it for deletion at collapse; D removes it now."),
    ];
  }
  return [];
}

function selectedChat(view: ProjectView, selected: number) {
  return visibleChat(view.brain)[selected];
}

function selectedActivity(view: ProjectView, selected: number): LiveActivity | undefined {
  return view.activity[selected - visibleChat(view.brain).length];
}

/**
 * The pin under the selection. A pin is part of the context projection, so it
 * is selected as a block; this resolves that block back to the pin record.
 */
function selectedPin(view: ProjectView, selected: number) {
  const block = view.context.blocks[selected];
  if (block === undefined || block.section !== "pin") return undefined;
  const id = block.id.replace(/^[a-z]+-pin:/, "").replace(/:stale$/, "");
  return allPins(view).find((pin) => pin.id === id);
}

function allPins(view: ProjectView) {
  return [...view.brain.userPins, ...mergeCarryPins(view.liveCarryPins, view.brain.carryPins)];
}

// Keep Component in the import surface for host extensions that type-check UI adapters.
void (null as Component | null);
