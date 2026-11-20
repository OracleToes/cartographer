/**
 * The Ledger view (MINI.md §2, §6): goals, notes, questions, instructions,
 * and progress through problems.
 *
 * Navigable via vim motions (j/k, gg/G, / to filter, enter/space to expand,
 * esc to return to Chat). Pinned items are visible directly inside the book.
 */
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import { handleOf } from "../domain/handles.js";
import type { CartoBrain, LedgerEntry } from "../domain/records.js";
import { tokens } from "./tokens.js";

export class LedgerView implements Component, Focusable {
  focused = false;
  onBack?: () => void;

  private brain: CartoBrain | undefined;
  private entries: LedgerEntry[] = [];
  private selectedIndex = 0;
  private filterText = "";
  private filtering = false;
  private detailExpanded = true;
  private pinnedHandles = new Set<string>();

  setData(brain: CartoBrain): void {
    this.brain = brain;
    this.entries = [...brain.ledger].sort((a, b) => a.createdAt - b.createdAt);
    this.pinnedHandles.clear();
    const allPins = [...brain.userPins, ...brain.carryPins];
    for (const pin of allPins) {
      for (const entry of brain.ledger) {
        const handle = handleOf(brain.handles, "ledger", entry.id);
        if (pin.item.includes(entry.id) || (handle && pin.item.includes(handle))) {
          if (handle) this.pinnedHandles.add(handle);
        }
      }
    }
    if (this.selectedIndex >= this.entries.length) {
      this.selectedIndex = Math.max(0, this.entries.length - 1);
    }
  }

  handleInput(data: string): void {
    if (this.filtering) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.filtering = false;
        this.filterText = "";
        return;
      }
      if (matchesKey(data, "enter")) {
        this.filtering = false;
        return;
      }
      if (matchesKey(data, "backspace")) {
        this.filterText = this.filterText.slice(0, -1);
        this.selectedIndex = 0;
        return;
      }
      if (data.length === 1 && !matchesKey(data, "tab")) {
        this.filterText += data.toLowerCase();
        this.selectedIndex = 0;
      }
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onBack?.();
      return;
    }
    if (data === "/") {
      this.filtering = true;
      this.filterText = "";
      return;
    }
    const filtered = this.getFilteredEntries();
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.selectedIndex = Math.min(filtered.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, "g")) {
      this.selectedIndex = 0;
      return;
    }
    if (data === "G") {
      this.selectedIndex = Math.max(0, filtered.length - 1);
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      this.detailExpanded = !this.detailExpanded;
      return;
    }
  }

  invalidate(): void {
    // Stateless.
  }

  private getFilteredEntries(): LedgerEntry[] {
    if (this.filterText.trim().length === 0) return this.entries;
    const q = this.filterText.toLowerCase();
    return this.entries.filter((entry) => {
      const handle = (this.brain ? handleOf(this.brain.handles, "ledger", entry.id) : "") ?? "";
      return (
        handle.toLowerCase().includes(q) ||
        entry.kind.toLowerCase().includes(q) ||
        entry.status.toLowerCase().includes(q) ||
        entry.text.toLowerCase().includes(q)
      );
    });
  }

  private renderDetail(entry: LedgerEntry, handle: string, width: number): string[] {
    const lines: string[] = [];
    const isPinned = this.pinnedHandles.has(handle);
    const isoDate = new Date(entry.updatedAt).toISOString();

    const titlePrefix = `${tokens.bold(tokens.accent(`[${handle}]`))} ${tokens.kindBadge(entry.kind)} ${entry.status === "open" ? tokens.statusBadge("open") : tokens.closedBadge(entry.status)}`;
    const badges: string[] = [];
    if (isPinned) badges.push(tokens.pinBadge("pin"));
    badges.push(tokens.muted(isoDate));

    lines.push(tokens.cardHeaderBg(` ${titlePrefix} ${badges.join(" ")}`.padEnd(width)));
    lines.push(tokens.cardBg(" ".repeat(width)));

    // Body text
    lines.push(tokens.cardBg(` ${tokens.bold(tokens.muted("Content:"))}`.padEnd(width)));
    const textLines = wrapTextWithAnsi(entry.text, Math.max(1, width - 4));
    for (const tl of textLines) {
      lines.push(tokens.cardBg(`   ${tl}`.padEnd(width)));
    }
    lines.push(tokens.cardBg(" ".repeat(width)));

    // Answer / Outcome
    if (entry.answer !== null) {
      lines.push(tokens.cardBg(` ${tokens.bold(tokens.muted("Answer / Outcome:"))}`.padEnd(width)));
      const answerLines = wrapTextWithAnsi(entry.answer.text, Math.max(1, width - 4));
      for (const al of answerLines) {
        lines.push(tokens.cardBg(`   ${tokens.agent(al)}`.padEnd(width)));
      }
      if (entry.answer.evidenceIds.length > 0) {
        let evidenceHandles = "";
        if (this.brain) {
          evidenceHandles = entry.answer.evidenceIds
            .map((id) => {
              const hit = this.brain!.handles.entries.find((e) => e.id === id);
              return hit ? hit.handle : "(gone)";
            })
            .join(", ");
        }
        lines.push(tokens.cardBg(`   ${tokens.muted(`Evidence handles: ${evidenceHandles}`)}`.padEnd(width)));
      }
      lines.push(tokens.cardBg(" ".repeat(width)));
    }

    return lines;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const filtered = this.getFilteredEntries();

    // Top Header Banner
    const filterInfo = this.filtering ? ` [filter: ${this.filterText}█]` : this.filterText ? ` [filter: ${this.filterText}]` : "";
    const openCount = this.entries.filter((e) => e.status === "open").length;
    const headerLeft = ` ${tokens.bold(tokens.accent("LEDGER"))} ${tokens.muted("·")} ${filtered.length} entries (${openCount} open) ${tokens.warn(filterInfo)}`;
    const headerRight = `${tokens.muted("esc to chat ")}`;
    const pad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight));
    lines.push(tokens.panel((headerLeft + " ".repeat(pad) + headerRight).padEnd(width)));
    lines.push("");

    if (filtered.length === 0) {
      lines.push(`  ${tokens.muted("(The Ledger is empty. Call the ledger tool to track goals, notes, and questions.)")}`);
      return lines;
    }

    const selectedEntry = filtered[this.selectedIndex] ?? filtered[0];
    if (!selectedEntry) return lines;
    const selectedHandle = (this.brain && selectedEntry ? handleOf(this.brain.handles, "ledger", selectedEntry.id) : undefined) ?? "L?";

    // Two-Pane split if wide enough
    if (width >= 72) {
      const listWidth = Math.min(38, Math.floor(width * 0.42));
      const detailWidth = Math.max(30, width - listWidth - 2);

      const listLines: string[] = [];
      filtered.forEach((entry, idx) => {
        const handle = (this.brain ? handleOf(this.brain.handles, "ledger", entry.id) : "") ?? `L${idx + 1}`;
        const isSelected = idx === this.selectedIndex;
        const isPinned = this.pinnedHandles.has(handle);

        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const handleStr = `[${handle}]`.padEnd(6);
        const pinStr = isPinned ? tokens.pinBadge("P") : "";
        const statusStr = entry.status === "open" ? tokens.statusBadge("open") : tokens.closedBadge(entry.status);
        const kindStr = tokens.muted(`[${entry.kind}]`);

        const badgeStr = `${pinStr} ${statusStr}`;
        const previewSpace = Math.max(4, listWidth - 14 - visibleWidth(badgeStr));
        const preview = truncateToWidth(entry.text.replace(/\s+/g, " "), previewSpace, "…");

        const rowText = `${prefix}${isSelected ? tokens.bold(tokens.accent(handleStr)) : tokens.muted(handleStr)} ${kindStr} ${preview} ${badgeStr}`;
        const paddedRow = isSelected ? tokens.selectedBg(rowText.padEnd(listWidth)) : tokens.activeRowBg(rowText.padEnd(listWidth));
        listLines.push(paddedRow);
      });

      const detailLines = this.renderDetail(selectedEntry, selectedHandle, detailWidth);
      const rowCount = Math.max(listLines.length, detailLines.length);

      for (let r = 0; r < rowCount; r++) {
        const left = listLines[r] ?? " ".repeat(listWidth);
        const right = detailLines[r] ?? " ".repeat(detailWidth);
        lines.push(`${left}  ${right}`);
      }
    } else {
      // Stacked layout
      filtered.forEach((entry, idx) => {
        const handle = (this.brain ? handleOf(this.brain.handles, "ledger", entry.id) : "") ?? `L${idx + 1}`;
        const isSelected = idx === this.selectedIndex;
        const isPinned = this.pinnedHandles.has(handle);

        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const pinStr = isPinned ? tokens.pinBadge("pin") : "";
        const statusStr = entry.status === "open" ? tokens.statusBadge("open") : tokens.closedBadge(entry.status);
        const rowText = `${prefix}${tokens.bold(tokens.accent(`[${handle}]`))} [${entry.kind}] ${entry.text} ${statusStr} ${pinStr}`;
        lines.push(isSelected ? tokens.selectedBg(rowText.padEnd(width)) : rowText);

        if (isSelected && this.detailExpanded) {
          lines.push(...this.renderDetail(entry, handle, width));
        }
      });
    }

    return lines;
  }
}
