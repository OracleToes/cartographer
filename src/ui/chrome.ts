/**
 * The chrome (§8, and Posting's layout).
 *
 * Posting's screen reads top to bottom as: one header row naming where you are,
 * the working area, and one footer row of the keys that matter *here*. That is
 * the whole of its chrome, and it is the whole of ours:
 *
 *   carto │ project · gen-… │ [READ ONLY]        model · 32,768   working…
 *   ────────────────────────────────────────────────────────────────────────
 *   …the working area…
 *
 *   ^x stop  ^v pause  ⇧tab steering  ^e fold  ^o jump  ^p palette  ^g editor  ^c quit
 *
 * The header states the mode in the spec's own words (§6.1) and nothing else
 * that can change on its own; the footer is context-sensitive, so the keys it
 * shows are the keys that work where the cursor is, and a key it does not show
 * is in the palette.
 */
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { chromeLine, tokens } from "./tokens.js";

/** The archive is a layer (§3.3), not a screen: the same UI over a different layer. */
export type Layer = "context" | "archive";
/** The books, plus the context itself. `archive` is not here: it is a layer, not a book. */
export type ViewMode = "chat" | "atlas" | "ledger" | "tree" | "context" | "jobs";
export type SendMode = "steer" | "after run" | "now";

export interface HeaderState {
  project: string;
  readonly session: { generation: string; state: { contextWindow: number; readOnly: boolean; paused: boolean; pathScope?: "strict" | "relaxed" } };
  modelLabel: string;
  view: ViewMode;
  layer: Layer;
  running: boolean;
  /** Set when the last provider report is missing, so the window is an advertisement, not a measurement. */
  windowUnknown: boolean;
}

const VIEW_TITLES: Record<ViewMode, string> = {
  chat: "chat",
  jobs: "jobs",
  atlas: "atlas",
  ledger: "ledger",
  tree: "tree",
  context: "context",
};

export class HeaderView implements Component {
  constructor(private readonly state: HeaderState) {}

  invalidate(): void {
    // Stateless; reads the live session reference.
  }

  render(outer: number): string[] {
    // One cell of inset either side: the header is chrome, and chrome is not flush to the pane edge.
    const width = Math.max(1, outer - 2);
    // Three zones, so a long project name can never push the figures around:
    // the mark and where you are on the left, the mode in the middle, the model
    // and its capacity on the right. Each zone is cut to fit; nothing overlaps.
    const view = this.state.layer === "archive" ? "archive" : VIEW_TITLES[this.state.view];
    const capacity = this.state.session.state.contextWindow;
    const window = capacity > 0 ? capacity.toLocaleString("en-US") : "window unknown";

    const left = `${tokens.bold(tokens.accent("carto"))}${tokens.faint(" ▏ ")}${tokens.bold(tokens.text(this.state.project))}${tokens.faint(` · ${view} · ${this.state.session.generation.slice(-6)}`)}`;
    // The view name already says `archive` when the other layer is showing, so
    // the middle zone carries the states that change what the agent may do: the
    // mode, and the pause (§9). A pause holds the run where it is, so the header
    // says so rather than leaving `working…` to imply progress that is not
    // happening. Both fit; neither is invented when it does not apply.
    const paused = this.state.session.state.paused;
    const middle = [
      this.state.session.state.readOnly ? tokens.warn(tokens.bold("READ ONLY")) : "",
      this.state.session.state.pathScope === "relaxed" ? tokens.warn(tokens.bold("RELAXED")) : "",
      paused ? tokens.accent(tokens.bold("PAUSED")) : "",
    ].filter((part) => part !== "").join(" ");
    const status = paused
      ? tokens.accent(this.state.running ? "held" : "paused")
      : this.state.running
        ? tokens.warn("working…")
        : tokens.faint("idle");
    const right = `${tokens.muted(this.state.modelLabel)}${tokens.faint(" · ")}${tokens.muted(window)}${tokens.faint(" · ")}${status}`;

    const middleWidth = visibleWidth(middle);
    const rightWidth = visibleWidth(right);
    const room = Math.max(8, width - rightWidth - middleWidth - 4);
    const clippedLeft = truncateToWidth(left, room, tokens.faint("…"));
    const gapLeft = Math.max(1, width - rightWidth - middleWidth - visibleWidth(clippedLeft) - 2);
    const beforeMiddle = middle.length === 0 ? "" : middle;
    const leftPart = clippedLeft + " ".repeat(gapLeft) + beforeMiddle;
    const pad = Math.max(1, width - visibleWidth(leftPart) - rightWidth);
    return [chromeLine(` ${leftPart}${" ".repeat(pad)}${right}`, outer)];
  }
}

export interface FooterHint {
  key: string;
  label: string;
}

export const SEND_MODES: SendMode[] = ["steer", "after run", "now"];

export function nextSendMode(mode: SendMode): SendMode {
  const index = SEND_MODES.indexOf(mode);
  return SEND_MODES[(index + 1) % SEND_MODES.length] ?? "steer";
}

export function sendModeLabel(mode: SendMode): string {
  return mode === "after run" ? "after the run" : mode;
}

export class FooterView implements Component {
  constructor(private readonly hints: () => FooterHint[]) {}

  invalidate(): void {
    // Stateless; the hint list is rebuilt on every frame.
  }

  render(width: number): string[] {
    const hints = this.hints();
    const inner = Math.max(1, width - 2);
    // Posting's footer: the key in the accent, the verb in dim grey, two spaces between pairs.
    const rendered = hints.map((hint) => `${tokens.accent(hint.key)} ${tokens.faint(hint.label)}`);
    return [chromeLine(` ${truncateToWidth(rendered.join(tokens.faint("  ")), inner, tokens.faint(" …"))}`, width)];
  }
}
