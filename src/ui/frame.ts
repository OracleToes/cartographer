import { visibleChat } from "../domain/brain.js";
import type { ContextMeter } from "../domain/meter.js";
import { contextMeter } from "../domain/meter.js";
import type { Text } from "@earendil-works/pi-tui";

import type { ProjectView } from "../runtime/project.js";
import type { PrefillState } from "../runtime/prefill.js";
import { ACTIONS, available, footerHints, hintText, type ActionContext, type Mode } from "./actions.js";
import { brainBody, chatBody, contextBody, selectableCount, type BodyRow } from "./body.js";
import { barCells, meterRow } from "./meter-bar.js";
import { clockSeconds, margin, width } from "./text.js";
import { BlankRow, padLine, row, RuleRow, SplitRow, textRow, TitleRow } from "./chrome.js";
import { spinnerFrame } from "./spinner.js";
import { statusLine } from "./state.js";
import { token } from "./tokens.js";

/**
 * The frame: the components the screen is made of, and the pure functions that
 * decide what they say.
 *
 * The layout is Pi TUI's: a `VStack` of fixed-height rows and one `ScrollView`
 * that takes the remaining space. Carto does not join rows into one string and
 * does not measure its own layout; it fills in the text of rows whose height it
 * declares, which is why the header can never be scrolled away.
 *
 * Everything here is pure. A component is handed strings; it does not read
 * storage, start a timer, or call the terminal.
 */

export type Tab = "chat" | "brain" | "context";
/**
 * What is open over the list.
 *
 * `help` and `actions` are references and draw as Pi TUI overlays. `chat` is the
 * edit hint, also an overlay. `record` is a page: it replaces the body, because
 * it must scroll, and the body is the one region Pi TUI lays out and scrolls.
 */
export type Detail = "help" | "actions" | "chat" | "record" | null;

export interface FrameState {
  root: string;
  model: string;
  view: ProjectView;
  /** The live documents when the frame read them; a cached frame keeps the last value. */
  live?: { busy: boolean } | undefined;
  prefill?: PrefillState | undefined;
  lastReading?: { fresh: number; ms: number; at: number } | undefined;
  /** The model's context window, in tokens. */
  contextWindow: number;
  tab: Tab;
  mode: Mode;
  detail: Detail;
  selected: number;
  folds: ReadonlySet<string>;
  expandedActivity: ReadonlySet<string>;
  sendMode: "interruption" | "steer" | "follow-up";
  /** When the current run started, if the frame saw it start. */
  runStartedAt?: number | undefined;
  applying: boolean;
  notice?: { text: string; kind: "info" | "error" } | undefined;
  error?: string | undefined;
  now: number;
  /** The first frame's uptime, so the spinner starts at its first frame. */
  startedAt: number;
}

export interface Frame {
  /** The fixed rows above the body: title, rule, tabs, bar. */
  top: readonly string[];
  /** The body: the only part that scrolls. */
  body: readonly string[];
  /** The fixed rows below the body: rule, footer. */
  bottom: readonly string[];
}

/**
 * The frame as components. `rows` is what a test reads; `layout` is what the
 * runtime hands to `TuiAltScreen.setLayoutRoot`.
 */
export interface FrameParts {
  title: TitleRow;
  rule: RuleRow;
  status: SplitRow;
  bar: SplitRow;
  /** The scrolling body's text, and the text the test reads. */
  body: Text;
  bodyText: string;
  footerRule: RuleRow;
  footer: SplitRow;
}

export const CHROME = { header: 1, rule: 1, tabs: 1, bar: 1, footer: 1 } as const;

/**
 * Build the screen's parts for one state. Pure: `rows` is what a test reads and
 * what the runtime could render into any terminal; the components are handed to
 * the `VStack` that lays them out.
 *
 * The gutter and the pad are real cells of the rows, not a wrapper: a row that
 * is already `columns` wide cannot wrap, and a `VStack` measures it as one row.
 */
export function frameParts(state: FrameState, columns: number): FrameParts {
  const widthNow = Math.max(20, columns);
  // The gutter is the terminal's background, not a drawn border, so a terminal
  // that already draws a border is not given a second one.
  const gutter = margin(widthNow);
  const edge = " ".repeat(gutter);
  const pad = "  ";
  const inner = Math.max(1, widthNow - gutter * 2 - pad.length * 2);
  /** A chrome row: gutter, pad, the row at `inner` cells, pad, gutter. */
  const chrome = (left: string, right: string, gap = 2): string =>
    `${edge}${pad}${row(left, right, inner, gap)}${pad}${edge}`;
  const barText = (): string => `${edge}${pad}${padLine(meterRow(frameMeter(state), barCells(widthNow)), inner)}${pad}${edge}`;

  const status = statusLine({
    view: state.view,
    ...(state.live === undefined ? {} : { live: state.live }),
    ...(state.prefill === undefined ? {} : { prefill: state.prefill }),
    ...(state.lastReading === undefined ? {} : { lastReading: state.lastReading }),
    ...(state.runStartedAt === undefined ? {} : { runStartedAt: state.runStartedAt }),
    now: state.now,
    applying: state.applying,
    ...(state.error === undefined ? {} : { error: state.error }),
  });
  const mark = status.spinning ? spinnerFrame(state.now - state.startedAt) : status.mark;
  const tabs = ([["chat", "Chat"], ["brain", "Brain"], ["context", "Context"]] as const)
    .map(([key, label], index) =>
      state.tab === key ? token.accent(`${index + 1} ${label}`) : token.muted(`${index + 1} ${label}`),
    )
    .join("  ");

  const title = new TitleRow();
  title.left = `${token.accent("Carto")} · ${token.ink(projectName(state.root))}`;
  title.right = token.muted(state.model);

  const statusRow = new SplitRow();
  statusRow.left = chrome(`${pad}${tabs}`, status.style(`${mark} ${status.text}`), 0);
  statusRow.right = "";

  const bar = new SplitRow();
  bar.left = barText();

  const footer = new SplitRow();
  const selection = clampSelection(state);
  footer.left = chrome(footerRow(state, inner), "", 0);
  const body = bodyText(state, selection, widthNow);

  return {
    title,
    rule: new RuleRow(gutter + 2),
    status: statusRow,
    bar,
    body: textRow(body),
    bodyText: body,
    footerRule: new RuleRow(gutter + 2),
    footer,
  };
}

/**
 * The frame's rows as strings, for a test or a host that renders elsewhere.
 * The runtime uses `frameParts` and never this.
 */
export function renderFrame(state: FrameState, columns: number): Frame {
  const widthNow = Math.max(20, columns);
  const gutter = margin(widthNow);
  const edge = " ".repeat(gutter);
  const pad = "  ";
  const inner = Math.max(1, widthNow - gutter * 2 - pad.length * 2);
  const chrome = (left: string, right: string, gap = 2): string =>
    `${edge}${pad}${row(left, right, inner, gap)}${pad}${edge}`;
  const ruleRow = (): string => `${edge}${pad}${token.rule("─".repeat(inner))}${pad}${edge}`;

  const status = statusLine({
    view: state.view,
    ...(state.live === undefined ? {} : { live: state.live }),
    ...(state.prefill === undefined ? {} : { prefill: state.prefill }),
    ...(state.lastReading === undefined ? {} : { lastReading: state.lastReading }),
    ...(state.runStartedAt === undefined ? {} : { runStartedAt: state.runStartedAt }),
    now: state.now,
    applying: state.applying,
    ...(state.error === undefined ? {} : { error: state.error }),
  });
  const mark = status.spinning ? spinnerFrame(state.now - state.startedAt) : status.mark;
  const tabs = ([["chat", "Chat"], ["brain", "Brain"], ["context", "Context"]] as const)
    .map(([key, label], index) =>
      state.tab === key ? token.accent(`${index + 1} ${label}`) : token.muted(`${index + 1} ${label}`),
    )
    .join("  ");

  const top = [
    chrome(`${token.accent("Carto")} · ${token.ink(projectName(state.root))}`, token.muted(state.model)),
    ruleRow(),
    `${edge}${pad}${row(`  ${tabs}`, status.style(`${mark} ${status.text}`), inner)}${pad}${edge}`,
    `${edge}${pad}${padLine(meterRow(frameMeter(state), barCells(widthNow)), inner)}${pad}${edge}`,
  ];
  const bottom = [ruleRow(), chrome(footerRow(state, inner), "", 0)];
  // A reference is an overlay on the live screen, but this flat frame has no
  // overlay layer, so it is appended after the body at the same inset the chrome
  // uses. A test reads it here; the screen reads `ReferenceOverlay`, and both
  // take their words from the same functions.
  const body = bodyText(state, clampSelection(state), widthNow).split("\n");
  const detail = detailLines(state, inner);
  if (detail.length > 0) {
    body.push("");
    for (const line of detail) body.push(`${" ".repeat(gutter + 2)}${line}`);
  }
  return {
    top,
    // A flat frame is what a test and a non-alt-screen host read, so each row
    // is padded to the terminal width here. In the component tree the
    // `ScrollView` supplies that width and the rows stay unpadded.
    body: body.map((line) => padLine(line, widthNow)),
    bottom,
  };
}

/**
 * The body's text. It is the page, so it runs the full frame width: its
 * scrollbar belongs at the terminal's edge, not in the gutter. Its own two
 * cells of inset are part of the text.
 *
 * A reference (`?`, `a`, the Chat edit detail) is **not** here. It is an
 * overlay drawn by `runtime/ui.ts` through `tui.showOverlay`, so it reads
 * wherever the body happens to be scrolled to and cannot be mistaken for the
 * transcript. `detailLines` below is the flat renderer of that same content,
 * kept for `renderFrame` so a test can assert on it without a terminal.
 */
function bodyText(state: FrameState, selection: number, widthNow: number): string {
  const body = bodyRows({ ...state, selected: selection }, widthNow);
  return body.map((entry) => entry.text).join("\n");
}

/**
 * The flat rows of a reference, for `renderFrame`.
 *
 * The live screen does not use this: `runtime/ui.ts` shows a reference through
 * `tui.showOverlay` with the same words, taken from `helpLines` and
 * `actionLines`. This function exists so a test can assert the content without a
 * terminal, and so the flat and overlay paths read from one source.
 */
export function detailLines(state: FrameState, inner: number): string[] {
  if (state.detail === "help") return helpLines(state, inner);
  if (state.detail === "actions") return actionLines(state);
  if (state.detail === "record") return [];
  if (state.detail === "chat") {
    return [
      token.warning("Chat edit selected. Press i to replace its text."),
      token.muted("d marks it for deletion at collapse; D removes it now."),
      token.muted("Esc closes the edit and keeps the Chat as it is."),
    ];
  }
  return [];
}

/** The rows that can be selected, so a stale index cannot point past the end. */
export function clampSelection(state: Pick<FrameState, "tab" | "view" | "selected"> & { contextCount?: number }): number {
  // The Context tab counts its tree's rows, which the runtime knows and this
  // pure function does not. A caller that has them passes `contextCount`; the
  // block count is the fallback, so the function stays pure.
  const count = state.tab === "context" && state.contextCount !== undefined ? state.contextCount : selectableCount(state.tab, state.view);
  if (count === 0) return 0;
  return Math.min(Math.max(state.selected, 0), count - 1);
}

/** The meter for this frame: a server reading if there is one, else the estimate. */
export function frameMeter(state: Pick<FrameState, "view" | "prefill" | "contextWindow">): ContextMeter {
  const reading = state.prefill === undefined ? undefined : asReading(state.prefill);
  return contextMeter({
    window: state.contextWindow,
    cap: state.view.context.budget,
    ...(reading === undefined ? {} : { reading }),
    estimate: state.view.context.estimatedTokens,
  });
}

function asReading(prefill: PrefillState): { total: number; cache: number; processed: number } | undefined {
  if (prefill.total <= 0) return undefined;
  return { total: prefill.total, cache: prefill.cache, processed: prefill.processed };
}

function bodyRows(state: FrameState & { selected: number }, columns: number): BodyRow[] {
  const input = {
    view: state.view,
    selected: state.selected,
    folds: state.folds,
    expandedActivity: state.expandedActivity,
    columns,
    tab: state.tab,
  };
  if (state.tab === "chat") return chatBody(input);
  if (state.tab === "brain") return brainBody(input);
  return contextBody(input);
}

/**
 * The footer takes the entire bottom row. Hints sit at the left and the right
 * end says what Enter will do; when space runs out, the hints give way first,
 * one at a time, and the mode never does.
 */
function footerRow(state: FrameState, inner: number): string {
  const actionContext: ActionContext = actionContextOf(state);
  const right = footerRight(state);
  const rightWidth = width(right);
  const hintRoom = Math.max(0, inner - rightWidth - 2);
  const hints = footerHints(actionContext, hintRoom, width);
  const text = hints === "" ? modeLine(state) : hints;
  if (right === "") return padLine(text, inner);
  return row(text, right, inner);
}

function footerRight(state: FrameState): string {
  if (state.detail === "record") return token.faint("Esc back to the list · j k scroll · g G ends");
  if (state.detail !== null) return token.faint(`Esc closes ${state.detail === "chat" ? "the edit" : state.detail}`);
  if (state.notice !== undefined) {
    return state.notice.kind === "error" ? token.danger(state.notice.text) : token.warning(state.notice.text);
  }
  if (state.mode === "insert") return token.accent("insert");
  return token.faint(`${state.tab} · send ${state.sendMode}`);
}

function modeLine(state: FrameState): string {
  return state.mode === "insert" ? token.accent("insert") : token.faint("navigate");
}

export function actionContextOf(state: FrameState): ActionContext {
  const selection = clampSelection(state);
  // Chat rows come first in the Chat tab, then the live disclosure.
  const chatCount = visibleChat(state.view.brain).length;
  const chatSelected = state.tab === "chat" && selection < chatCount;
  const activitySelected = state.tab === "chat" && selection >= chatCount && state.view.activity.length > 0;
  const pinStart = state.view.context.blocks.length;
  const pinSelected = state.tab === "context" && selection >= pinStart;
  const brainSelected = state.tab === "brain";
  return {
    mode: state.mode,
    tab: state.tab,
    view: state.view,
    chatSelected,
    activitySelected,
    pinSelected,
    brainSelected,
    detailOpen: state.detail !== null && state.detail !== "record",
    recordOpen: state.detail === "record",
    busy: state.applying || state.view.turn.state === "cancelling",
    paused: state.view.turn.state === "paused",
    running: state.view.turn.state === "running",
  };
}

function projectName(root: string): string {
  const parts = root.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? root;
}

/** The `?` reference: every available action, grouped, in the order of use. */
export function helpLines(state: FrameState, columns: number): string[] {
  const context = actionContextOf(state);
  const groups: Array<[string, string]> = [
    ["move", "Move"],
    ["view", "View"],
    ["chat", "Chat"],
    ["context", "Context"],
    ["turn", "Turn"],
    ["commands", "Commands"],
  ];
  const lines: string[] = [];
  for (const [key, title] of groups) {
    const actions = available(context).filter((action) => action.group === key && action.id !== "quit");
    if (actions.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(token.sectionActive(title));
    for (const action of actions) {
      // The key column is fixed so the labels line up, and the help follows
      // the label on the same row: a reference is for scanning, not for prose.
      const keys = action.keys.join(" ");
      const key = token.accent(keys);
      const pad = Math.max(1, 14 - width(keys));
      const label = `${action.label}${" ".repeat(Math.max(1, 18 - (width(action.label) + 2)))}`;
      lines.push(padLine(`  ${key}${" ".repeat(pad)}${label}${token.muted(action.help)}`, columns));
    }
  }
  lines.push("");
  lines.push(token.muted("Commands start with / and name records by their short handle."));
  lines.push(token.muted("Examples: /delete C2 · /unpin P3 · /approve X1 · /wake W1 | time | …"));
  return lines;
}

/** The `a` reference: the commands, one line each, with the key that opens the input. */
export function actionLines(state: FrameState): string[] {
  const lines = [token.sectionActive("Actions"), ""];
  lines.push(`${token.accent("/collapse")} ${token.muted("request a context collapse")} · ${token.accent("/confirm-collapse")} ${token.muted("do it")}`);
  lines.push(`${token.accent("/delete HANDLE")} ${token.muted("mark a record; /delete-now removes it now; /undelete cancels")}`);
  lines.push(`${token.accent("/pin ITEM | REASON")} · ${token.accent("/pin-file path:1-9 | ITEM | REASON")}`);
  lines.push(`${token.accent("/unpin P#")} ${token.muted("at collapse")} · ${token.accent("/unpin-now P#")} ${token.muted("now")}`);
  lines.push(`${token.accent("/ledger [L#] | goal|note|question | open|answered|closed | TEXT [| ANSWER]")}`);
  lines.push(`${token.accent("/atlas [A#] | TITLE | CLAIM | path:1-9 [| LINK,LINK]")}`);
  lines.push(`${token.accent("/handoff INTENT | NEXT ACTION [| NOTE]")} · ${token.accent("/clear-handoff")}`);
  lines.push(`${token.accent("/wake [W#] | time|path | CONDITION | REASON")} · ${token.accent("/cancel-wake W# [| REASON]")}`);
  lines.push(`${token.accent("/approve X#")} · ${token.accent("/reject X#")} · ${token.accent("/refresh")}`);
  if (state.view.turn.state === "paused") lines.push("");
  if (state.view.turn.state === "paused") lines.push(token.warning("A paused draft is ready: press r and edit it."));
  lines.push("");
  lines.push(token.muted("Esc closes this. i opens the input."));
  return lines;
}

/** The keys of the current mode, for a host that shows a hint elsewhere. */
export function keySummary(state: FrameState): string {
  const context = actionContextOf(state);
  return ACTIONS.filter((action) => action.when?.(context) === true && action.hidden !== true)
    .map(hintText)
    .join(" · ");
}

/** `09:41:07`, so a status can say exactly when something happened. */
export function timestamp(now: number): string {
  return clockSeconds(now);
}
