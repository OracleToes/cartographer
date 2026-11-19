import {
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Spacer,
  Text,
  TuiAltScreen,
  VStack,
  type OverlayHandle,
  type StackEntry,
} from "@earendil-works/pi-tui";

import { visibleChat } from "../domain/brain.js";
import { mergeCarryPins } from "../domain/context.js";
import { handleOf } from "../domain/handles.js";
import type { CartoProject, ProjectView, SendMode } from "./project.js";
import type { LiveActivity } from "./live-session.js";
import { parseCommand, runCommand, type UiCommand } from "../ui/commands.js";
import { selectedLabel } from "../ui/body.js";
import { actionContextOf, clampSelection, frameParts, helpLines, type Detail, type FrameState, type Tab } from "../ui/frame.js";
import { BlankRow } from "../ui/chrome.js";
import { ReferenceOverlay, referenceMaxHeight } from "../ui/overlay.js";
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
  const tui = new TuiAltScreen(terminal, true, undefined, {
    mouse: true,
    // Pi TUI draws the jump-to-end label when a follow-end view is scrolled
    // away from its end, and makes it clickable. That is the "you are not at
    // the bottom" affordance; Carto does not draw its own.
    scrollToEndIndicator: () => token.muted("↓ end · Ctrl+End"),
  });

  let tab: Tab = "chat";
  let mode: Mode = "navigate";
  let detail: Detail = null;
  /** The one overlay handle for a reference, or `undefined` when none is open. */
  let reference: OverlayHandle | undefined;
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

  /**
   * The screen is a Pi TUI component tree:
   *
   *   blank
   *   title row          one fixed row
   *   rule               one fixed row
   *   tabs + state       one fixed row
   *   token bar          one fixed row
   *   body               the only child that grows; it scrolls
   *   input box          `basis: "auto"`, present only in insert mode
   *   blank
   *   rule               one fixed row
   *   footer             one fixed row
   *
   * Every fixed row declares `basis: 1`. Without it, `VStack` falls back to
   * measuring the row's rendered height, and a `Text` whose content is empty
   * renders zero rows. That is exactly how the header used to scroll away: all
   * four chrome rows measured 0, `grow: 1` gave the body the whole viewport,
   * and there was no header row left on screen to scroll back to.
   */
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

  /**
   * The fixed rows and the one scrolling region.
   *
   * `basis: 1` on every chrome row is load-bearing: a `VStack` otherwise sizes
   * a child by its rendered height, and an empty `Text` renders zero rows. With
   * all four chrome rows at height 0, `grow: 1` gave the body every row of the
   * viewport and the header scrolled away with the transcript.
   */
  const parts = frameParts(currentState(), terminal.columns);
  const scroll = new ScrollView(parts.body, { primary: true, follow: "end", scrollbar: "auto" });
  const editor = new Editor(tui, editorTheme(), { paddingX: 0 });
  const input = new Text("", 0, 0);
  const fixed = (component: object): StackEntry => ({
    component: component as never,
    basis: 1,
    grow: 0,
    shrink: 0,
  });
  const inputEntry: StackEntry = {
    component: input,
    basis: "auto",
    grow: 0,
    shrink: 0,
    visible: () => mode === "insert",
  };
  tui.setLayoutRoot(
    new VStack(
      [
        fixed(new BlankRow()),
        fixed(parts.title),
        fixed(parts.rule),
        fixed(parts.status),
        fixed(parts.bar),
        { component: scroll, grow: 1, basis: 0, minSize: 1 },
        inputEntry,
        fixed(new BlankRow()),
        fixed(parts.footerRule),
        fixed(parts.footer),
      ],
      { gap: 0 },
    ),
  );

  /** Draw the screen. Fills the components; Pi TUI does the layout. */
  const paint = (force = false): void => {
    if (quitting) return;
    const state = currentState();
    const next = frameParts(state, width);
    parts.title.left = next.title.left;
    parts.title.right = next.title.right;
    parts.status.left = next.status.left;
    parts.bar.left = next.bar.left;
    parts.footer.left = next.footer.left;
    parts.body.setText(next.bodyText);
    paintInput();
    spinnerPaintAt = state.now;
    dirty = false;
    if (force) tui.requestRender(true);
    else tui.requestRender();
  };

  /**
   * A reference is an overlay, not a tail of the body.
   *
   * `?`, `a`, and the Chat edit detail open through `tui.showOverlay`, so they
   * are drawn on top of the screen and given focus. The body does not move, the
   * transcript's scroll position is not disturbed, and a reference is readable
   * whatever the body is showing. Closing the overlay returns focus to the
   * screen, and the body is exactly where it was.
   *
   * The component is rebuilt on every open because the words depend on the
   * current state (which actions are available, what the draft is). An overlay
   * is cheap; a stale reference is a lie.
   */
  const showDetail = (next: Detail): void => {
    detail = next;
    reference?.hide();
    reference = undefined;
    if (next === null) {
      paint();
      tui.requestRender();
      return;
    }
    const overlay = new ReferenceOverlay(currentState(), referenceMaxHeight(terminal.rows));
    reference = tui.showOverlay(overlay, {
      width: Math.max(20, Math.min(width, 96)),
      maxHeight: referenceMaxHeight(tui.terminal.rows),
      anchor: "center",
      margin: 1,
    });
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
  /**
   * Enter in Navigate mode: open the selected item.
   *
   * A Chat item opens its edit detail; a live disclosure expands or folds; a
   * Brain or Context record opens the same detail the person can act on. Enter
   * never opens the input: that is `i`, so one key has one meaning per mode.
   */
  const openSelected = (): void => {
    const index = clampSelection({ tab, view, selected });
    if (tab === "chat") {
      const entry = selectedChat(view, index);
      if (entry !== undefined) {
        showDetail(detail === "chat" ? null : "chat");
        return;
      }
      const item = selectedActivity(view, index);
      if (item !== undefined) {
        if (expandedActivity.has(item.id)) expandedActivity.delete(item.id);
        else expandedActivity.add(item.id);
        wake();
        return;
      }
      return;
    }
    // Brain and Context records have no separate detail view yet; announce the
    // selection in the footer rather than pretending to open something.
    notice = { text: `${selectedLabel(tab, view, index) ?? "Nothing"} is selected. Enter opens items on the Chat tab.`, kind: "info" };
    wake();
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
      // One Escape closes the reference; a second leaves the screen alone. A
      // reference is a thing you opened, not a place you navigated to, so it
      // must not take two different meanings from one key press.
      if (detail !== null) {
        showDetail(null);
        return { consume: true };
      }
      return { consume: true };
    }
    // A reference that is a page of words (`?`, `a`) owns the keyboard while it
    // is open. It closes on its own key or on Escape, and the screen underneath
    // does not move: reaching into the transcript with `j` while a reference
    // covers it would move something the person cannot see. A tab switch is let
    // past, because it closes the reference anyway.
    if (reference !== undefined && detail !== "chat") {
      if (data === "?" || data === "a") {
        showDetail(null);
        return { consume: true };
      }
      if (data === "1") return switchTab("chat");
      if (data === "2") return switchTab("brain");
      if (data === "3") return switchTab("context");
      return { consume: true };
    }
    // The Chat edit reference is a hint, not a page: it names keys, so those
    // keys must work. It closes on the first key, and the key then does its job,
    // which keeps one key meaning one thing in one mode.
    if (reference !== undefined && detail === "chat") showDetail(null);
    if (matchesKey(data, Key.backspace)) {
      selected = 0;
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
    // `i` opens the input and nothing else.
    if (data === "i") {
      enterInsert();
      return { consume: true };
    }
    // Enter opens the selected item. It used to be an alias for `i`, so Enter
    // opened the input in Navigate mode and never opened anything; that was a
    // port artefact with no line in the spec.
    if (matchesKey(data, Key.enter)) {
      openSelected();
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


