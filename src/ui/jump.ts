/**
 * Jump mode (Posting's idiom): one key, a label per addressable region, one
 * keystroke to land. Esc leaves untouched.
 */
import {
  matchesKey,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import { tokens } from "./tokens.js";

export interface JumpTarget {
  /** Single lowercase letter. */
  key: string;
  label: string;
}

export const JUMP_TARGETS: JumpTarget[] = [
  { key: "c", label: "chat — conversation & cards" },
  { key: "a", label: "atlas — nodes, links & attachments" },
  { key: "l", label: "ledger — goals, notes, questions & progress" },
  { key: "x", label: "context — the surgery view" },
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
    const row = (key: string, label: string) => `   ${tokens.accent(key)}   ${tokens.muted(label)}`;
    const lines = [
      "",
      ` ${tokens.bold(tokens.muted(" jump"))}`,
      "",
      ...this.targets.map((target) => row(target.key, target.label)),
      "",
      `   ${tokens.muted("esc to stay")}`,
      "",
    ];
    const inner = Math.max(24, Math.min(width, 52));
    return lines.map((line) => tokens.panel(line.padEnd(inner)));
  }
}
