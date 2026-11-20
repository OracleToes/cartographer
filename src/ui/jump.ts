/**
 * Jump mode (Posting's idiom): one key, a label per addressable region, one
 * keystroke to land. Spatial one-key-per-widget labels need per-widget render
 * geometry we do not have yet, so this is the contract without the pixels:
 * type a letter, land on the mode. Esc leaves untouched.
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
  { key: "c", label: "chat" },
  { key: "x", label: "context — the surgery view" },
  { key: "a", label: "atlas" },
  { key: "l", label: "ledger" },
  { key: "p", label: "pins" },
  { key: "w", label: "wakes" },
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
    const inner = Math.max(24, Math.min(width, 44));
    return lines.map((line) => tokens.panel(line.padEnd(inner)));
  }
}
