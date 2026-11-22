/**
 * Jump mode (§8, Posting's idiom).
 *
 * Posting's jump mode is the fastest way around a screen you already know: one
 * key overlays a label on every place you can go, and one keystroke lands you
 * there. The labels are stable, so they become muscle memory — the same letter
 * is the same destination every time.
 *
 * Ours has the same shape and a fixed alphabet: each view's letter is also its
 * key in `ctrl+o <letter>`, so the overlay is a reminder of the keys rather than
 * a second scheme to learn.
 */
import { matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";

import { padLine, tokens, visibleWidth } from "./tokens.js";

export interface JumpTarget {
  /** Single lowercase letter. */
  key: string;
  /** The view it lands on. */
  view: "chat" | "atlas" | "ledger" | "context";
  label: string;
  description: string;
}

export const JUMP_TARGETS: JumpTarget[] = [
  { key: "c", view: "chat", label: "transcript", description: "the conversation" },
  { key: "a", view: "atlas", label: "atlas", description: "nodes, links and attachments" },
  { key: "l", view: "ledger", label: "ledger", description: "goals, notes, questions, progress" },
  { key: "x", view: "context", label: "context", description: "what the model reads, and surgery on it" },
];

export class JumpOverlay implements Component, Focusable {
  focused = false;
  onClose?: () => void;
  onJump?: (key: string) => void;

  constructor(private readonly targets: JumpTarget[] = JUMP_TARGETS) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+o") || matchesKey(data, "ctrl+c")) {
      this.onClose?.();
      return;
    }
    const key = data.length === 1 ? data.toLowerCase() : "";
    if (this.targets.some((target) => target.key === key)) {
      this.onClose?.();
      this.onJump?.(key);
    }
  }

  invalidate(): void {
    // Stateless.
  }

  render(width: number): string[] {
    const inner = Math.max(20, Math.min(width, 58));
    const lines: string[] = [];
    lines.push(padLine(` ${tokens.bold(tokens.text("Jump"))} ${tokens.faint("· one key, then a letter")}`, inner));
    lines.push(padLine("", inner));
    for (const target of this.targets) {
      const key = tokens.accent(tokens.bold(` ${target.key} `));
      const name = tokens.text(target.label.padEnd(11));
      const pad = Math.max(1, inner - 3 - 11 - 4 - visibleWidth(target.description));
      lines.push(padLine(`  ${key} ${name}${tokens.faint(target.description)}`, inner));
      void pad;
    }
    lines.push(padLine("", inner));
    lines.push(padLine(`  ${tokens.faint("esc stays where you are")}`, inner));
    return lines.map((line) => tokens.panel(line));
  }
}
