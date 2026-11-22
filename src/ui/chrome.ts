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
 *   ^x stop  ⇧tab steering  ^e fold  ^o jump  ^p palette  ^h sidebar  ^c quit
 *
 * The header states the mode in the spec's own words (§6.1) and nothing else
 * that can change on its own; the footer is context-sensitive, so the keys it
 * shows are the keys that work where the cursor is, and a key it does not show
 * is in the palette.
 */
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { padLine, ruleLine, tokens } from "./tokens.js";

/** The archive is a layer (§3.3), not a screen: the same UI over a different layer. */
export type Layer = "context" | "archive";
/** The books, plus the prompt itself. `archive` is not here: it is a layer, not a book. */
export type ViewMode = "chat" | "atlas" | "ledger" | "context";
export type SendMode = "steer" | "after run" | "now";

export interface HeaderState {
  project: string;
  readonly session: { generation: string; state: { contextWindow: number; readOnly: boolean } };
  modelLabel: string;
  view: ViewMode;
  layer: Layer;
  running: boolean;
  /** Set when the last provider report is missing, so the window is an advertisement, not a measurement. */
  windowUnknown: boolean;
}

const VIEW_TITLES: Record<ViewMode, string> = {
  chat: "chat",
  atlas: "atlas",
  ledger: "ledger",
  context: "context",
};

export class HeaderView implements Component {
  constructor(private readonly state: HeaderState) {}

  invalidate(): void {
    // Stateless; reads the live session reference.
  }

  render(width: number): string[] {
    const stateWindow = this.state.session.state.contextWindow;
    const window = stateWindow > 0 ? stateWindow.toLocaleString("en-US") : "window unknown";

    // The mode and the layer are never truncated: they are the two facts a
    // person must be able to read at a glance. Only the project name gives way.
    const badges = [
      this.state.session.state.readOnly ? tokens.warn(tokens.bold("READ ONLY")) : "",
      this.state.layer === "archive" ? tokens.warn(tokens.bold("archive")) : "",
    ].filter((part) => part.length > 0);
    const badgeText = badges.length === 0 ? "" : `  ${badges.join(" ")}`;

    const status = this.state.running ? tokens.warn("working…") : tokens.faint("idle");
    const rightText = `${tokens.muted(this.state.modelLabel)}${tokens.faint(" · ")}${tokens.muted(window)}${tokens.faint(" · ")}${status}`;
    const rightWidth = visibleWidth(rightText);

    const prefix = `${tokens.bold(tokens.accent("carto"))}${tokens.faint(" ▏ ")}`;
    const tail = `${tokens.faint(` · ${VIEW_TITLES[this.state.view]} · ${this.state.session.generation.slice(-6)}`)}`;
    const room = Math.max(4, width - rightWidth - visibleWidth(badgeText) - visibleWidth(prefix) - visibleWidth(tail) - 2);
    const name = truncateToWidth(this.state.project, room, tokens.faint("…"));

    const left = `${prefix}${tokens.bold(tokens.text(name))}${tail}${badgeText}`;
    const pad = Math.max(1, width - visibleWidth(left) - rightWidth);
    return [padLine(left + " ".repeat(pad) + rightText, width), ruleLine(width)];
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
    // Posting's footer: the key in the accent, the verb in dim grey, two spaces between pairs.
    const rendered = hints.map((hint) => `${tokens.accent(hint.key)} ${tokens.faint(hint.label)}`);
    return [ruleLine(width), padLine(truncateToWidth(rendered.join(tokens.faint("  ")), width, tokens.faint(" …")), width)];
  }
}
