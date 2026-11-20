/**
 * The sidebar: the Brain's tables of contents (MINI.md §2). Counts per book,
 * a per-book stale hint, and the total at the bottom. The app sets counts
 * after every settle and collapse; rendering is a pure function of the last
 * counts. The Brain views land in R5c; this is the index, not the books.
 */
import type { Component } from "@earendil-works/pi-tui";

import { tokens } from "./tokens.js";

export type BookKind = "atlas" | "ledger" | "chat" | "pins" | "wakes";

export interface SidebarCounts {
  atlas: number;
  ledger: number;
  chat: number;
  pins: number;
  wakes: number;
  /** Stale entries per book (derived from stale handles by prefix). */
  stale: Partial<Record<BookKind, number>>;
  staleTotal: number;
}

const EMPTY: SidebarCounts = { atlas: 0, ledger: 0, chat: 0, pins: 0, wakes: 0, stale: {}, staleTotal: 0 };
export const sidebarWidth = 22;

export class Sidebar implements Component {
  private counts: SidebarCounts = EMPTY;

  setCounts(counts: SidebarCounts): void {
    this.counts = { ...counts, stale: { ...counts.stale } };
  }

  invalidate(): void {
    // No cached state beyond `counts`, replaced atomically.
  }

  private row(name: BookKind, width: number): string {
    const count = this.counts[name];
    const stale = this.counts.stale[name] ?? 0;
    const label = ` ${name.padEnd(8)}`;
    const figure = String(count).padStart(4);
    const badge = stale === 0 ? "" : ` !${stale}`;
    const pad = Math.max(1, width - label.length - figure.length - badge.length);
    const paintedBadge = badge === "" ? "" : tokens.warn(badge);
    return `${label}${" ".repeat(pad)}${figure}${paintedBadge}`;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push("");
    lines.push(` ${tokens.bold(tokens.muted("BRAIN"))}`);
    lines.push("");
    for (const name of ["atlas", "ledger", "chat", "pins", "wakes"] as const) {
      lines.push(this.row(name, width));
    }
    lines.push("");
    lines.push(this.counts.staleTotal === 0 ? ` ${tokens.muted("stale none")}` : ` ${tokens.warn(`stale ${this.counts.staleTotal}`)}`);
    return lines;
  }
}
