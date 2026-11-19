import { visibleChat } from "../domain/brain.js";
import type { ContextMeter } from "../domain/meter.js";
import { contextMeter } from "../domain/meter.js";
import type { ProjectView } from "../runtime/project.js";
import type { PrefillState } from "../runtime/prefill.js";
import { ACTIONS, available, footerHints, hintText, type ActionContext, type Mode } from "./actions.js";
import { brainBody, chatBody, contextBody, selectableCount, type BodyRow } from "./body.js";
import { barCells, meterRow } from "./meter-bar.js";
import { cell, clockSeconds, fit, rule, split, splitStyled, width } from "./text.js";
import { spinnerFrame } from "./spinner.js";
import { statusLine } from "./state.js";
import { token } from "./tokens.js";

/**
 * The frame: everything the person sees, as rows for one terminal width.
 *
 * This function is pure. It is given a state value and a width, and it returns
 * strings; it does not read storage, start a timer, or call the terminal. The
 * runtime calls it at most ten times a second and asks Pi TUI to draw only
 * when a row changed.
 *
 * The frame has five parts, in this order: the title row, a rule, the tabs
 * with the state line, the token bar, and the footer. The body sits between
 * the bar and the footer and is the only part that scrolls.
 */

export type Tab = "chat" | "brain" | "context";
export type Detail = "help" | "actions" | "chat" | null;

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
  /** The chrome above the body. */
  top: string[];
  /** The body itself. */
  body: string[];
  /** The footer, the last row on screen. */
  bottom: string[];
}

export const CHROME = { header: 1, rule: 1, tabs: 1, bar: 1, footer: 1 } as const;

export function renderFrame(state: FrameState, columns: number): Frame {
  const widthNow = Math.max(20, columns);
  const pad = 2;
  const inner = Math.max(1, widthNow - pad * 2);
  const strip = " ".repeat(pad);
  // `inner` is what the row draws between the two pads, so a full row is
  // `pad + inner + pad` cells wide. The pad is literal spaces, not part of
  // the measured text, which is why `fit` gets `inner` and not `cell`.
  const full = (text: string): string => `${strip}${fit(text, inner)}${strip}`;

  const top: string[] = [];
  top.push(full(splitStyled(`${token.accent("Carto")} · ${token.ink(projectName(state.root))}`, token.ink, token.muted(state.model), inner)));
  top.push(`${strip}${token.rule(rule(inner))}${strip}`);
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
  const spinning = status.spinning;
  const mark = spinning ? spinnerFrame(state.now - state.startedAt) : status.mark;
  const tabs = ([["chat", "Chat"], ["brain", "Brain"], ["context", "Context"]] as const)
    .map(([key, label], index) => (state.tab === key ? token.accent(`${index + 1} ${label}`) : token.muted(`${index + 1} ${label}`)))
    .join("  ");
  top.push(full(splitStyled(`  ${tabs}`, token.ink, status.style(`${mark} ${status.text}`), inner)));

  // The bar is always visible. Before the first server report it is drawn
  // from the projection's estimate, with its own glyph, style and `~`.
  const meter = frameMeter(state);
  const cells = barCells(widthNow);
  const row = meterRow(meter, cells);
  const meterWidth = width(row);
  top.push(full(cell(meterWidth > inner ? fit(row, inner) : row, inner)));

  const bottom: string[] = [];
  bottom.push(`${strip}${token.rule(rule(inner))}${strip}`);
  bottom.push(full(footerRow(state, inner)));

  const selection = clampSelection(state);
  const body = bodyRows({ ...state, selected: selection }, Math.max(4, inner));
  // A detail is drawn under the body, so the tab keeps its place and the
  // person can look at both. The body never moves to make room for it.
  const detailRows = detailLines(state, inner);
  return {
    top,
    // The body's rows are built for `inner`, which includes no pad; the two
    // cells of page inset live inside that width, so a body row is a full
    // frame row.
    body: [
      ...body.map((row) => `${strip}${cell(row.text, inner)}${strip}`),
      ...(detailRows.length === 0 ? [] : [cell("", widthNow)]),
      ...detailRows.map((row) => `${strip}${cell(row, inner)}${strip}`),
    ],
    bottom,
  };
}

/** The overlay for `?`, `a`, and the Chat edit detail. */
export function detailLines(state: FrameState, inner: number): string[] {
  if (state.detail === "help") return helpLines(state, inner);
  if (state.detail === "actions") return actionLines(state);
  if (state.detail === "chat") {
    return [
      token.warning("Chat edit selected. Press i to replace its text."),
      token.muted("d marks it for deletion at collapse; D removes it now."),
    ];
  }
  return [];
}

/** The rows that can be selected, so a stale index cannot point past the end. */
export function clampSelection(state: Pick<FrameState, "tab" | "view" | "selected">): number {
  const count = selectableCount(state.tab, state.view);
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
  if (hints === "") return split(modeLine(state), right, inner);
  return split(hints, right, inner);
}

function footerRight(state: FrameState): string {
  if (state.detail !== null) return token.faint(`Esc closes ${state.detail === "chat" ? "the edit" : state.detail}`);
  if (state.notice !== undefined) {
    return state.notice.kind === "error" ? token.danger(state.notice.text) : token.warning(state.notice.text);
  }
  if (state.mode === "insert") return token.accent(`send ${state.sendMode}`);
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
    detailOpen: state.detail !== null,
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
      lines.push(fit(`  ${key}${" ".repeat(pad)}${label}${token.muted(action.help)}`, columns));
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
