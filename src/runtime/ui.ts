import {
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  sliceByColumn,
  Spacer,
  Text,
  TuiAltScreen,
  VStack,
  type Component,
  type StackEntryOptions,
} from "@earendil-works/pi-tui";

import { visibleChat } from "../domain/brain.js";
import { mergeCarryPins } from "../domain/context.js";
import { handleOf } from "../domain/handles.js";
import type { CartoProject, ProjectView, SendMode } from "./project.js";
import type { LiveActivity } from "./live-session.js";
import { parseCommand, runCommand, type UiCommand } from "../ui/commands.js";
import { actionContextOf, clampSelection, helpLines, renderFrame, type Detail, type FrameState, type Tab } from "../ui/frame.js";
import { inputBoxRows, inputTextCells, INPUT_TITLE } from "../ui/input-box.js";
import { margin } from "../ui/text.js";
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
  // The chrome and the footer are one row each. The default `Text` pads above
  // and below, which would move the footer off the bottom row.
  const gap = new Spacer(1);
  const chrome = new Text("", 0, 0);
  const body = new Text("", 0, 0);
  const footer = new Text("", 0, 0);
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
  let spinnerPaintAt = -1;
  let dirty = true;
  let width = terminal.columns;
  let resolveExit: (() => void) | undefined;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const clock = (): number => Date.now();

  // The editor is a real layout child, not a focused widget off screen: a
  // component draws only when a parent renders it. With `paddingX: 2` it
  // draws its text two cells in and no border of its own; the box draws the
  // frame, so the box and the footer cannot disagree about the border colour.
  // `paddingX: 0` is required for two reasons. `Editor` draws its padding
  // inside its own width and reserves one column for the cursor when the
  // padding is zero, so a zero-padded editor wraps at exactly the width it is
  // given: the box's inside width. Its rows can then be used as they are, and
  // its cursor marker stays on the character it marked.
  const editor = new Editor(tui, editorTheme(), { paddingX: 0 });
  // The box is chrome, so it is inset like the chrome. Its rows carry the
  // gutter and the pad themselves, exactly as `renderFrame`'s rows do, so its
  // edges line up with the rules above and below the body.
  const input = new Text("", 0, 0);
  const scroll = new ScrollView(body, { primary: true, follow: "end", scrollbar: "auto" });

  /**
   * The editor's own rows for the box's text width. The box never re-wraps
   * them and never re-places the cursor, so the hardware cursor lands on the
   * character Pi TUI marked.
   *
   * `Editor` draws a rule above and below its text. In the box those rules
   * would be a second frame inside the frame, so they are dropped here: the
   * box owns the border and the editor owns only the text.
   */
  const editorRows = (columns: number): string[] => {
    // The editor must wrap at exactly the cells the box gives a line, or its
    // own wrap and the box's cut disagree and the tail of a long line
    // disappears. `inputTextCells` is that number, in one place.
    const rows = editor.render(inputTextCells(columns, margin(columns)));
    return rows.length <= 2 ? [] : rows.slice(1, -1);
  };

  /**
   * The box is measured, not declared: `basis: "auto"` asks the layout to use
   * the rows the box draws, so the box can never be allocated one row and draw
   * three. `visible` is a predicate the layout calls on every pass, so the box
   * appears and disappears with the mode. The box is the only child whose
   * height changes while the person types, and the body above it is the only
   * child that absorbs that change.
   */
  const inputEntry: StackEntryOptions = {
    basis: "auto",
    grow: 0,
    shrink: 0,
    visible: () => mode === "insert",
  };

  // One blank row above the frame and one below it, so the chrome never
  // touches the terminal's own edge. The body is the only child that grows,
  // so it is the only child a resize or a wrapped prompt moves.
  tui.setLayoutRoot(
    new VStack(
      [gap, chrome, { component: scroll, grow: 1 }, { component: input, ...inputEntry }, footer, gap],
      { gap: 0 },
    ),
  );

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
    paintInput();
    spinnerPaintAt = state.now;
    dirty = false;
    if (force) tui.requestRender(true);
    else tui.requestRender();
  };

  /**
   * A reference is read from the top. The body follows its own end so a
   * streamed answer stays in view, but a `?` or `a` reference longer than the
   * body would open scrolled to its last line and its title would never be
   * seen. Opening one therefore leaves follow mode at the top of the body;
   * closing it returns the body to the end.
   */
  const showDetail = (next: Detail): void => {
    const wasOpen = detail !== null;
    detail = next;
    if (next !== null) scroll.scrollTo(0, { disableFollow: true });
    else if (wasOpen) scroll.scrollToEnd();
    paint();
    tui.requestRender();
  };

  /**
   * Draw the input box from the editor's own rows, and tell the layout how
   * many rows it needs. The height is derived from the same render the box is
   * drawn from, so the box cannot be allocated one row and drawn three: that
   * mismatch is how a box ends up over the footer.
   */
  const paintInput = (): void => {
    if (mode !== "insert") {
      input.setText("");
      return;
    }
    const rows = editorRows(width);
    input.setText(
      inputBoxRows({ lines: rows, title: inputTitle(), columns: width, gutter: margin(width) }).join("\n"),
    );
  };

  /** What Enter will do, said on the box's top edge. */
  const inputTitle = (): string => {
    if (insertAction === "edit-chat") {
      const entry = selectedChat(view, clampSelection({ tab, view, selected }));
      const handle = entry === undefined ? undefined : handleOf(view.brain.handles, "chat", entry.id);
      return handle === undefined ? INPUT_TITLE.editChat("C?") : INPUT_TITLE.editChat(handle);
    }
    if (insertAction === "agent-chat") return INPUT_TITLE.agentChat();
    if (insertAction === "resume") return INPUT_TITLE.resume();
    return INPUT_TITLE.send(sendMode);
  };

  /** Read the project again, then draw. A read never writes. */
  const refresh = async (live = false): Promise<void> => {
    try {
      view = live ? await project.liveFrameView() : await project.view();
      const turn = view.turn.state;
      if (turn === "running" && runStartedAt === undefined) runStartedAt = clock();
      if (turn !== "running") runStartedAt = undefined;
      error = undefined;
      wake();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      wake();
    }
  };

  const active = (): boolean => applying || view.turn.state !== "idle" || project.prefill().current?.phase === "reading";

  /**
   * The frame clock.
   *
   * One pending timer, never a repeating one: a tick schedules the next tick,
   * so a pause between runs costs nothing. While anything moves (a run, a
   * local action, a server reading) the interval is the spinner's 100 ms.
   * While the screen is still the interval is one second, which is the
   * cheapest way to notice a wake that fired without a commit reaching us.
   *
   * A tick paints only when something changed: the spinner moved, storage
   * marked the frame dirty, or a notification asked for it. That is why a
   * streamed answer appears without a key press and an idle Carto does not
   * redraw at all.
   */
  let ticker: NodeJS.Timeout | undefined;
  let ticking = false;
  const scheduleTick = (delay: number): void => {
    if (quitting) return;
    if (ticker !== undefined) clearTimeout(ticker);
    ticker = setTimeout(() => void tick(), delay);
    ticker.unref();
  };
  /** Ask the next tick to happen now, from input or from a notification. */
  const wake = (): void => {
    dirty = true;
    if (!ticking) scheduleTick(0);
  };
  const tick = async (): Promise<void> => {
    if (quitting) return;
    ticking = true;
    const now = clock();
    const moving = active();
    if (moving && dirty) {
      // A live read is cheap; the transcript is read when a commit says so.
      await refresh(true);
    }
    if (dirty || (moving && now - spinnerPaintAt >= SPINNER_INTERVAL_MS)) paint();
    ticking = false;
    scheduleTick(active() ? SPINNER_INTERVAL_MS : 1_000);
  };

  /**
   * A terminal resize changes every row, and Pi TUI tells the layout but not
   * this frame. Checking the width is the cheapest correct signal.
   */
  const checkWidth = (): void => {
    if (quitting) return;
    const next = terminal.columns;
    if (next !== width) {
      width = next;
      wake();
    }
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
      wake();
      return;
    }
    applying = true;
    wake();
    try {
      await task();
      notice = undefined;
    } catch (cause) {
      notice = { text: cause instanceof Error ? cause.message : String(cause), kind: "error" };
      wake();
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
      wake();
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
  // Typing is latency-sensitive: a box drawn on the next clock tick would be
  // up to 100 ms behind the key. Pi TUI calls this inside the keystroke, so
  // the box and the cursor move together.
  editor.onChange = () => {
    if (mode !== "insert") return;
    paint();
    tui.requestRender();
  };

  const enterInsert = (seed = "", action: "send" | "edit-chat" | "agent-chat" | "resume" = "send"): void => {
    mode = "insert";
    insertAction = action;
    editor.setText(seed);
    tui.setFocus(editor);
    // Paint now, not on the next tick: the person pressed a key and expects
    // the box in the same frame.
    paint();
    tui.requestRender();
  };
  const navigate = (): void => {
    mode = "navigate";
    tui.setFocus(null);
    input.setText("");
    paint();
    tui.requestRender();
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
      if (detail !== null) showDetail(null);
      navigate();
      return { consume: true };
    }
    if (matchesKey(data, Key.backspace)) {
      if (detail !== null) showDetail(null);
      else selected = 0;
      wake();
      return { consume: true };
    }
    if (data === "1") return switchTab("chat");
    if (data === "2") return switchTab("brain");
    if (data === "3") return switchTab("context");
    if (data === "j" || matchesKey(data, Key.down)) {
      selected += 1;
      selected = clampSelection({ tab, view, selected });
      wake();
      return { consume: true };
    }
    if (data === "k" || matchesKey(data, Key.up)) {
      selected = Math.max(0, selected - 1);
      wake();
      return { consume: true };
    }
    if (data === "g" || matchesKey(data, Key.home)) {
      selected = 0;
      wake();
      return { consume: true };
    }
    if (data === "G" || matchesKey(data, Key.end)) {
      selected = 9_999;
      selected = clampSelection({ tab, view, selected });
      wake();
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
      showDetail(detail === "actions" ? null : "actions");
      return { consume: true };
    }
    if (data === "?") {
      showDetail(detail === "help" ? null : "help");
      return { consume: true };
    }
    if (data === "f" && tab === "chat") {
      const entry = selectedChat(view, clampSelection({ tab, view, selected }));
      if (entry !== undefined) {
        if (folds.has(entry.id)) folds.delete(entry.id);
        else folds.add(entry.id);
        wake();
      }
      return { consume: true };
    }
    if (data === "e" && tab === "chat") {
      if (selectedChat(view, clampSelection({ tab, view, selected })) !== undefined) {
        detail = "chat";
        wake();
      }
      return { consume: true };
    }
    if (data === "o" && tab === "chat") {
      const item = selectedActivity(view, clampSelection({ tab, view, selected }));
      if (item !== undefined) {
        if (expandedActivity.has(item.id)) expandedActivity.delete(item.id);
        else expandedActivity.add(item.id);
        wake();
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
      if (detail !== null) showDetail(null);
      wake();
      return { consume: true };
    }
  });

  // Storage says when to look. A commit marks the frame dirty; it never
  // renders, because a render inside a watch callback would fight the writer.
  let detach = (): void => undefined;
  try {
    const liveWatch = await project.watchLive(() => {
      wake();
    });
    const prefillOff = project.onPrefill(() => {
      wake();
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
  scheduleTick(SPINNER_INTERVAL_MS);
  const widthTimer = setInterval(checkWidth, 250);
  widthTimer.unref();
  await exit;
  clearInterval(widthTimer);
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
