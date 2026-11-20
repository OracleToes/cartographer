/**
 * The sidebar: the Brain's tables of contents (MINI.md §2). Counts per book,
 * a per-book stale hint, and the total at the bottom. The Brain books are
 * Atlas, Ledger, and Chat; pins are evident inside each book rather than
 * segregated into a separate book.
 */
import type { Component } from "@earendil-works/pi-tui";

import { tokens } from "./tokens.js";

export type BookKind = "atlas" | "ledger" | "chat";

export interface SidebarCounts {
  atlas: number;
  ledger: number;
  chat: number;
  /** Stale entries per book (derived from stale handles by prefix). */
  stale: Partial<Record<BookKind, number>>;
  staleTotal: number;
}

const EMPTY: SidebarCounts = { atlas: 0, ledger: 0, chat: 0, stale: {}, staleTotal: 0 };
export const sidebarWidth = 22;

export class Sidebar implements Component {
  private counts: SidebarCounts = EMPTY;
  private activeBook: BookKind | "context" | undefined = "chat";

  setCounts(counts: SidebarCounts): void {
    this.counts = { ...counts, stale: { ...counts.stale } };
  }

  setActiveBook(book?: BookKind | "context"): void {
    this.activeBook = book;
  }

  invalidate(): void {
    // No cached state beyond `counts`, replaced atomically.
  }

  private row(name: BookKind, width: number): string {
    const count = this.counts[name];
    const stale = this.counts.stale[name] ?? 0;
    const isActive = this.activeBook === name;
    const prefix = isActive ? tokens.accent("▸ ") : "  ";
    const label = `${name.padEnd(8)}`;
    const figure = String(count).padStart(4);
    const badge = stale === 0 ? "" : ` !${stale}`;
    const leftText = `${prefix}${isActive ? tokens.bold(tokens.accent(label)) : tokens.muted(label)}`;
    const pad = Math.max(1, width - 2 - label.length - figure.length - badge.length);
    const paintedBadge = badge === "" ? "" : tokens.warn(badge);
    const paintedFigure = isActive ? tokens.bold(tokens.accent(figure)) : tokens.muted(figure);
    const line = `${leftText}${" ".repeat(pad)}${paintedFigure}${paintedBadge}`;
    return isActive ? tokens.selectedBg(line.padEnd(width)) : tokens.sidebarBg(line.padEnd(width));
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const bg = (s: string) => tokens.sidebarBg(s.padEnd(width));
    lines.push(bg(""));
    lines.push(bg(`  ${tokens.bold(tokens.muted("BRAIN"))}`));
    lines.push(bg(""));
    for (const name of ["atlas", "ledger", "chat"] as const) {
      lines.push(this.row(name, width));
    }
    lines.push(bg(""));
    const staleText = this.counts.staleTotal === 0
      ? `  ${tokens.muted("stale none")}`
      : `  ${tokens.warn(`stale ${this.counts.staleTotal}`)}`;
    lines.push(bg(staleText));
    return lines;
  }
}
