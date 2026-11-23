/**
 * The Ledger view (§2): goals, notes, questions, instructions,
 * and progress through problems.
 *
 * Navigable via vim motions (j/k, gg/G, / to filter, enter/space to expand,
 * h/l or left/right to switch between list and detail, esc to return to Chat).
 * Pinned items are visible directly inside the book.
 */
import {
  fuzzyFilter,
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import { handleOf } from "../domain/handles.js";
import type { CartoBrain, LedgerEntry } from "../domain/records.js";
import { padLine, tokens } from "./tokens.js";
import { RecordControls } from "./record-controls.js";

export class LedgerView implements Component, Focusable {
  focused = false;
  onBack?: () => void;
  /** The person's marks on the selected record: `a` archive, `d` delete, `u` withdraw, `!` apply now (§4.1). */
  readonly controls = new RecordControls();

  private focusedPane: "list" | "detail" = "list";
  private brain: CartoBrain | undefined;
  private entries: LedgerEntry[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private readonly filterInput = new Input({ prompt: "/" });
  private filtering = false;
  private detailExpanded = true;

  setData(brain: CartoBrain): void {
    this.brain = brain;
    this.entries = [...brain.ledger].sort((a, b) => a.createdAt - b.createdAt);
    if (this.selectedIndex >= this.entries.length) {
      this.selectedIndex = Math.max(0, this.entries.length - 1);
    }
  }

  /** True while `/` is taking text: a command key is a letter of the filter then. */
  isFiltering(): boolean {
    return this.filtering;
  }

  /** The id the cursor is on, which the marks act on. */
  selectedId(): string | undefined {
    return this.getFilteredEntries()[this.selectedIndex]?.id;
  }

  handleInput(data: string): void {
    if (this.filtering) {
      this.filterInput.focused = this.focused;
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.filtering = false;
        this.filterInput.setValue("");
        this.selectedIndex = 0;
        return;
      }
      if (matchesKey(data, "enter")) {
        this.filtering = false;
        return;
      }
      if (matchesKey(data, "tab")) return;
      this.filterInput.handleInput(data);
      this.selectedIndex = 0;
      return;
    }

    // The marks are the same in both panes; paging the detail is ctrl+d/ctrl+u.
    if (this.controls.handleKey(data, this.selectedId())) return;

    if (this.focusedPane === "list") {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.onBack?.();
        return;
      }
      if (data === "/") {
        this.filtering = true;
        this.filterInput.setValue("");
        return;
      }
      if (matchesKey(data, "l") || matchesKey(data, "right") || matchesKey(data, "enter")) {
        this.focusedPane = "detail";
        this.scrollOffset = 0;
        return;
      }
      const filtered = this.getFilteredEntries();
      if (matchesKey(data, "j") || matchesKey(data, "down")) {
        this.selectedIndex = Math.min(filtered.length - 1, this.selectedIndex + 1);
        this.scrollOffset = 0;
        return;
      }
      if (matchesKey(data, "k") || matchesKey(data, "up")) {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.scrollOffset = 0;
        return;
      }
      if (matchesKey(data, "g")) {
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        return;
      }
      if (data === "G") {
        this.selectedIndex = Math.max(0, filtered.length - 1);
        this.scrollOffset = 0;
        return;
      }
      if (matchesKey(data, "space")) {
        this.detailExpanded = !this.detailExpanded;
        return;
      }
    } else {
      // Detail pane focused
      if (matchesKey(data, "h") || matchesKey(data, "left") || matchesKey(data, "escape")) {
        this.focusedPane = "list";
        return;
      }
      if (matchesKey(data, "j") || matchesKey(data, "down")) {
        this.scrollOffset += 1;
        return;
      }
      if (matchesKey(data, "k") || matchesKey(data, "up")) {
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        return;
      }
      if (matchesKey(data, "ctrl+d") || matchesKey(data, "pageDown")) {
        this.scrollOffset += 10;
        return;
      }
      if (matchesKey(data, "ctrl+u") || matchesKey(data, "pageUp")) {
        this.scrollOffset = Math.max(0, this.scrollOffset - 10);
        return;
      }
      if (matchesKey(data, "g")) {
        this.scrollOffset = 0;
        return;
      }
      if (data === "G") {
        this.scrollOffset = 9999;
        return;
      }
    }
  }

  handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent): import("@earendil-works/pi-tui").TuiMouseEventResult | undefined {
    if (event.type === "wheel" && event.wheelDelta) {
      if (this.focusedPane === "detail") {
        this.scrollOffset = Math.max(0, this.scrollOffset + (event.wheelDelta > 0 ? 3 : -3));
      } else {
        const filtered = this.getFilteredEntries();
        const delta = event.wheelDelta > 0 ? 1 : -1;
        this.selectedIndex = Math.max(0, Math.min(filtered.length - 1, this.selectedIndex + delta));
      }
      return { handled: true, render: true };
    }
    if (event.type === "press") {
      return { handled: true, focus: true };
    }
    if (event.type === "click") {
      const listWidth = Math.min(38, Math.floor(event.width * 0.42));
      if (event.x < listWidth) {
        const listIdx = event.y - 2;
        const filtered = this.getFilteredEntries();
        if (listIdx >= 0 && listIdx < filtered.length) {
          this.selectedIndex = listIdx;
          this.focusedPane = "list";
          this.scrollOffset = 0;
          return { handled: true, render: true };
        }
      } else {
        this.focusedPane = "detail";
        return { handled: true, render: true };
      }
    }
    return undefined;
  }

  invalidate(): void {
    // Stateless.
  }

  private getFilteredEntries(): LedgerEntry[] {
    const query = this.filterInput.getValue().trim();
    if (query.length === 0) return this.entries;
    return fuzzyFilter(this.entries, query, (entry) => {
      const handle = (this.brain ? handleOf(this.brain.handles, "ledger", entry.id) : "") ?? "";
      return `${handle} ${entry.kind} ${entry.status} ${entry.text}`;
    });
  }

  private renderDetail(entry: LedgerEntry, handle: string, width: number, maxLines: number = 28): string[] {
    const rawLines: string[] = [];
    const isoDate = new Date(entry.updatedAt).toISOString();

    const titlePrefix = `${tokens.bold(tokens.accent(`[${handle}]`))} ${tokens.kindBadge(entry.kind)} ${entry.status === "open" ? tokens.statusBadge("open") : tokens.closedBadge(entry.status)}`;
    const badges: string[] = [];
    badges.push(tokens.muted(isoDate));
    if (this.focusedPane === "detail") badges.push(tokens.bold(tokens.accent("[FOCUSED]")));

    rawLines.push(tokens.cardHeaderBg(padLine(` ${titlePrefix} ${badges.join(" ")}`, width)));
    if (entry.mark !== undefined) {
      rawLines.push(tokens.cardBg(padLine(` ${tokens.warn(`◆ ${entry.mark.action} on collapse · ${entry.mark.author === "user" ? "you" : "agent"}`)}`, width)));
    }
    rawLines.push(tokens.cardBg(" ".repeat(width)));

    // Body text
    rawLines.push(tokens.cardBg(padLine(` ${tokens.bold(tokens.muted("Content:"))}`, width)));
    const textLines = wrapTextWithAnsi(entry.text, Math.max(1, width - 4));
    for (const tl of textLines) {
      rawLines.push(tokens.cardBg(padLine(`   ${tl}`, width)));
    }
    rawLines.push(tokens.cardBg(" ".repeat(width)));

    // Answer / Outcome
    if (entry.answer !== null) {
      rawLines.push(tokens.cardBg(padLine(` ${tokens.bold(tokens.muted("Answer / Outcome:"))}`, width)));
      const answerLines = wrapTextWithAnsi(entry.answer.text, Math.max(1, width - 4));
      for (const al of answerLines) {
        rawLines.push(tokens.cardBg(padLine(`   ${tokens.agent(al)}`, width)));
      }
      rawLines.push(tokens.cardBg(" ".repeat(width)));
    }

    if (this.scrollOffset > Math.max(0, rawLines.length - maxLines)) {
      this.scrollOffset = Math.max(0, rawLines.length - maxLines);
    }
    const visibleChunk = rawLines.slice(this.scrollOffset, this.scrollOffset + maxLines);
    if (rawLines.length > maxLines) {
      const remaining = rawLines.length - (this.scrollOffset + visibleChunk.length);
      const scrollInfo = ` ⋯ ${this.scrollOffset > 0 ? `▲ ${this.scrollOffset} above ` : ""}${remaining > 0 ? `▼ ${remaining} more lines ` : ""}· j/k to scroll`;
      visibleChunk.push(tokens.cardBg(padLine(tokens.muted(scrollInfo), width)));
    }
    return visibleChunk;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const filtered = this.getFilteredEntries();

    // One header row, Posting's shape: the book's name, its figure, and what the
    // keys do here. The book itself starts one quiet line below it.
    const name = tokens.bold(tokens.ledger("LEDGER"));
    const figure = `${tokens.text(String(filtered.length))} ${tokens.faint("entries")}`;
    const query = this.filterInput.getValue();
    let filter = "";
    if (this.filtering) {
      this.filterInput.focused = this.focused;
      const filterWidth = Math.min(24, Math.max(6, visibleWidth(query) + 2));
      filter = ` ${tokens.accent((this.filterInput.render(filterWidth)[0] ?? `/${query}`).trimEnd())}`;
    } else if (query.length > 0) {
      filter = ` ${tokens.accent(`/${query}`)}`;
    }
    const stale = "";
    const left = ` ${name} ${tokens.faint("·")} ${figure}${filter}${stale}`;
    const right = `${tokens.faint(this.controls.nowArmed ? "next mark applies NOW " : "a/d mark · u withdraw · ! now · / filter ")}`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    lines.push(tokens.panel(padLine(left + " ".repeat(gap) + right, width)));
    lines.push(padLine("", width));

    if (filtered.length === 0) {
      lines.push(`  ${tokens.muted("The Ledger is empty. The agent opens goals, notes and questions with the ledger tool.")}`);
      return lines;
    }

    const selectedEntry = filtered[this.selectedIndex] ?? filtered[0];
    if (!selectedEntry) return lines;
    const selectedHandle = (this.brain && selectedEntry ? handleOf(this.brain.handles, "ledger", selectedEntry.id) : undefined) ?? "L?";

    // Two-Pane split
    if (width >= 72) {
      const listWidth = Math.min(38, Math.floor(width * 0.42));
      const detailWidth = Math.max(30, width - listWidth - 2);

      const listLines: string[] = [];
      filtered.forEach((entry, idx) => {
        const handle = (this.brain ? handleOf(this.brain.handles, "ledger", entry.id) : "") ?? `L${idx + 1}`;
        const isSelected = idx === this.selectedIndex;
        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const handleStr = `[${handle}]`.padEnd(6);
        const statusStr = entry.status === "open" ? tokens.statusBadge("open") : tokens.closedBadge(entry.status);
        const kindStr = tokens.muted(`[${entry.kind}]`);

        const badgeStr = statusStr;
        const mark = entry.mark === undefined ? "" : `${tokens.warn(`◆ ${entry.mark.action}`)} `;
        const previewSpace = Math.max(1, listWidth - 14 - visibleWidth(badgeStr) - visibleWidth(mark));
        const preview = truncateToWidth(entry.text.replace(/\s+/g, " "), previewSpace, "…");

        const rowText = `${prefix}${isSelected ? tokens.bold(tokens.accent(handleStr)) : tokens.muted(handleStr)} ${mark}${kindStr} ${preview} ${badgeStr}`;
        const paddedRow = isSelected
          ? (this.focusedPane === "list" ? tokens.selectedBg(padLine(rowText, listWidth)) : tokens.activeRowBg(padLine(rowText, listWidth)))
          : tokens.sidebarBg(padLine(rowText, listWidth));
        listLines.push(paddedRow);
      });

      const detailLines = this.renderDetail(selectedEntry, selectedHandle, detailWidth);
      const rowCount = Math.max(listLines.length, detailLines.length);

      for (let r = 0; r < rowCount; r++) {
        const left = listLines[r] ?? tokens.sidebarBg(" ".repeat(listWidth));
        const right = detailLines[r] ?? tokens.cardBg(" ".repeat(detailWidth));
        lines.push(`${left}  ${right}`);
      }
    } else {
      // Stacked layout
      filtered.forEach((entry, idx) => {
        const handle = (this.brain ? handleOf(this.brain.handles, "ledger", entry.id) : "") ?? `L${idx + 1}`;
        const isSelected = idx === this.selectedIndex;
        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const statusStr = entry.status === "open" ? tokens.statusBadge("open") : tokens.closedBadge(entry.status);
        const mark = entry.mark === undefined ? "" : `${tokens.warn(`◆ ${entry.mark.action} on collapse`)} `;
        const rowText = `${prefix}${tokens.bold(tokens.accent(`[${handle}]`))} ${mark}[${entry.kind}] ${entry.text} ${statusStr}`;
        lines.push(isSelected ? tokens.selectedBg(padLine(rowText, width)) : rowText);

        if (isSelected && this.detailExpanded) {
          lines.push(...this.renderDetail(entry, handle, width, 16));
        }
      });
    }

    return lines;
  }
}
