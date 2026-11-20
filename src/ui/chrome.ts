/**
 * The chrome: one fixed header row and one fixed footer row (MINI.md §8 —
 * fixed header, fixed footer, one row of padding, nothing touches the
 * terminal edge). The header names the project, the generation, the active
 * view mode, the model, and the active context window; the footer carries the
 * keys that work where you are (Posting's context-sensitive idiom) and the armed
 * send mode when in chat.
 */
import {
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

import { tokens } from "./tokens.js";

export type ViewMode = "chat" | "atlas" | "ledger" | "context";
export type SendMode = "steer" | "after run" | "now";

export interface HeaderState {
  project: string;
  readonly session: { generation: string; state: { contextWindow: number } };
  modelLabel: string;
  view: ViewMode;
}

export class HeaderView implements Component {
  constructor(private readonly state: HeaderState) {}

  invalidate(): void {
    // Stateless; reads the live session reference.
  }

  render(width: number): string[] {
    const stateWindow = this.state.session.state.contextWindow;
    const window = stateWindow > 0 ? stateWindow.toLocaleString("en-US") : "window unknown";
    const modeBadge = `[${this.state.view}]`;
    const right = tokens.muted(`${this.state.modelLabel} · ${window}`);
    const rightWidth = visibleWidth(`${this.state.modelLabel} · ${window}`);
    const left = truncateToWidth(
      `${tokens.bold(tokens.accent("carto"))} ${tokens.muted("▏")} ${this.state.project} ${tokens.muted(`· ${this.state.session.generation}`)} ${tokens.bold(tokens.accent(modeBadge))}`,
      Math.max(1, width - rightWidth - 2),
      tokens.muted("…"),
    );
    const pad = Math.max(1, width - visibleWidth(left) - rightWidth);
    const rule = tokens.muted("─".repeat(width));
    return [left + " ".repeat(pad) + right, rule];
  }
}

export interface FooterState {
  view: ViewMode;
  sendMode: SendMode;
  running: boolean;
  sidebarVisible: boolean;
}

const SEND_ORDER: SendMode[] = ["steer", "after run", "now"];

export function nextSendMode(mode: SendMode): SendMode {
  const index = SEND_ORDER.indexOf(mode);
  return SEND_ORDER[(index + 1) % SEND_ORDER.length] ?? "steer";
}

export function sendModeLabel(mode: SendMode): string {
  return mode === "after run" ? "after run" : mode;
}

export class FooterView implements Component {
  constructor(private readonly state: FooterState) {}

  invalidate(): void {
    // Stateless; reads the live object.
  }

  render(width: number): string[] {
    const key = (name: string, label: string) => `${tokens.accent(name)} ${tokens.muted(label)}`;
    const segments: string[] = [];

    if (this.state.view === "chat") {
      segments.push(
        key("^x", "stop"),
        `${tokens.accent("⇧tab")} ${tokens.muted("mode")} ${tokens.agent(sendModeLabel(this.state.sendMode))}`,
        key("^e", "fold"),
        key("^o", "jump"),
        key("^p", "palette"),
        key("^h", "sidebar"),
        key("^c", "quit"),
      );
    } else if (this.state.view === "atlas" || this.state.view === "ledger") {
      segments.push(
        key("j/k", "move"),
        key("gg/G", "top/end"),
        key("enter", "expand"),
        key("/", "filter"),
        key("esc", "chat"),
        key("^o", "jump"),
        key("^p", "palette"),
        key("^h", "sidebar"),
        key("^c", "quit"),
      );
    } else if (this.state.view === "context") {
      segments.push(
        key("j/k", "nav"),
        key("h/l", "pane"),
        key("tab", "raw"),
        key("d", "delete"),
        key("!", "now"),
        key("c", "collapse"),
        key("esc", "chat"),
        key("^o", "jump"),
        key("^p", "palette"),
        key("^h", "sidebar"),
        key("^c", "quit"),
      );
    }

    const left = segments.join(tokens.muted("  "));
    const right = this.state.running ? tokens.warn("working…") : "";
    const rightWidth = visibleWidth(right);
    if (rightWidth === 0) return [truncateToWidth(left, width)];
    const leftWidth = visibleWidth(left);
    const pad = Math.max(1, width - leftWidth - rightWidth);
    return [truncateToWidth(left, Math.max(1, width - rightWidth - 1), tokens.muted("…")) + " ".repeat(pad) + right];
  }
}
