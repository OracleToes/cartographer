/**
 * The sidebar: the workspace index (MINI.md §8; docs/ui-proposal.md §4).
 * Lists Chat, Context, Atlas, and Ledger with counts and status badges.
 */
import { visibleWidth, type Component } from "@earendil-works/pi-tui";

import { padLine, tokens } from "./tokens.js";

export type BookKind = "chat" | "context" | "atlas" | "ledger";

export interface SidebarCounts {
  chat: number;
  contextTokens: number;
  atlas: number;
  ledger: number;
  /** Stale entries per book. */
  stale: Partial<Record<"atlas" | "ledger", number>>;
  staleTotal: number;
}

const EMPTY: SidebarCounts = { chat: 0, contextTokens: 0, atlas: 0, ledger: 0, stale: {}, staleTotal: 0 };
export const sidebarWidth = 22;

export class Sidebar implements Component {
  private counts: SidebarCounts = EMPTY;
  private activeItem: BookKind = "chat";
  onSelect?: (book: BookKind) => void;

  setCounts(counts: SidebarCounts): void {
    this.counts = { ...counts, stale: { ...counts.stale } };
  }

  setActiveBook(item: BookKind): void {
    this.activeItem = item;
  }

  invalidate(): void {
    // Stateless.
  }

  handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent): import("@earendil-works/pi-tui").TuiMouseEventResult | undefined {
    if (event.type === "press") {
      if (event.y === 3 || event.y === 4 || event.y === 8 || event.y === 9) {
        return { handled: true };
      }
    }
    if (event.type === "click") {
      if (event.y === 3) {
        this.onSelect?.("chat");
        return { handled: true, render: true };
      }
      if (event.y === 4) {
        this.onSelect?.("context");
        return { handled: true, render: true };
      }
      if (event.y === 8) {
        this.onSelect?.("atlas");
        return { handled: true, render: true };
      }
      if (event.y === 9) {
        this.onSelect?.("ledger");
        return { handled: true, render: true };
      }
    }
    return undefined;
  }

  private row(id: BookKind, label: string, figure: string, badgeText: string, width: number): string {
    const isActive = this.activeItem === id;
    const prefix = isActive ? tokens.accent("▸ ") : "  ";
    const paintedLabel = isActive ? tokens.bold(tokens.accent(label)) : tokens.muted(label);
    const paintedBadge = badgeText === "" ? "" : tokens.warn(badgeText);
    const paintedFig = isActive ? tokens.bold(tokens.accent(figure)) : tokens.muted(figure);

    const leftPart = `${prefix}${paintedLabel}`;
    const rightPart = `${paintedFig}${paintedBadge}`;
    const leftWidth = visibleWidth(leftPart);
    const rightWidth = visibleWidth(rightPart);
    const gap = Math.max(1, width - leftWidth - rightWidth);
    const line = `${leftPart}${" ".repeat(gap)}${rightPart}`;

    const padded = padLine(line, width);
    return isActive ? tokens.selectedBg(padded) : tokens.sidebarBg(padded);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const bg = (s: string) => tokens.sidebarBg(padLine(s, width));

    lines.push(bg(""));
    lines.push(bg(`  ${tokens.bold(tokens.muted("WORKSPACE"))}`));
    lines.push(bg(""));

    // Chat
    lines.push(this.row("chat", "chat", String(this.counts.chat), "", width));

    // Context
    const tokFormatted = this.counts.contextTokens > 0
      ? `~${Math.round(this.counts.contextTokens / 1000)}k`
      : "0";
    lines.push(this.row("context", "context", tokFormatted, "", width));

    lines.push(bg(""));
    lines.push(bg(`  ${tokens.bold(tokens.muted("BRAIN"))}`));
    lines.push(bg(""));

    // Atlas
    const atlasStale = this.counts.stale.atlas ?? 0;
    const atlasBadge = atlasStale > 0 ? ` !${atlasStale}` : "";
    lines.push(this.row("atlas", "atlas", String(this.counts.atlas), atlasBadge, width));

    // Ledger
    const ledgerStale = this.counts.stale.ledger ?? 0;
    const ledgerBadge = ledgerStale > 0 ? ` !${ledgerStale}` : "";
    lines.push(this.row("ledger", "ledger", String(this.counts.ledger), ledgerBadge, width));

    lines.push(bg(""));
    const staleText = this.counts.staleTotal === 0
      ? `  ${tokens.muted("stale none")}`
      : `  ${tokens.warn(`stale ${this.counts.staleTotal}`)}`;
    lines.push(bg(staleText));

    return lines;
  }
}
