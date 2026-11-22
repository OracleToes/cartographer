/**
 * The Atlas view (§2.1): nodes — a name and a text entry —
 * linked to other nodes or attached to any reference.
 * Navigable via vim motions (j/k, gg/G, / to filter, enter/space to expand,
 * h/l or left/right to switch between list and detail, esc to return to Chat).
 *
 * Designed with Posting's visual hierarchy: background tints and card surfaces
 * rather than excessive line borders. Pinned nodes and stale entries are
 * evident directly inside the book entries.
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
import type { AtlasNode, CartoBrain } from "../domain/records.js";
import { padLine, tokens, pinBadgeText } from "./tokens.js";
import { RecordControls } from "./record-controls.js";

export class AtlasView implements Component, Focusable {
  focused = false;
  onBack?: () => void;
  /** Fired on `p`: toggle the pin marker on the selected node. */
  onTogglePin?: (id: string) => void;
  /** The person's marks on the selected record: `a` archive, `d` delete, `u` withdraw, `!` apply now (§4.1). */
  readonly controls = new RecordControls();

  private focusedPane: "list" | "detail" = "list";
  private brain: CartoBrain | undefined;
  private nodes: AtlasNode[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private filterText = "";
  private filtering = false;
  private detailExpanded = true;
  private staleHandles = new Set<string>();

  setData(brain: CartoBrain, staleList: Array<{ kind: string; label: string }>): void {
    this.brain = brain;
    this.nodes = [...brain.atlas].sort((a, b) => a.createdAt - b.createdAt);
    this.staleHandles.clear();
    for (const mark of staleList) {
      if (mark.kind === "atlas" && mark.label !== "") this.staleHandles.add(mark.label);
    }
    if (this.selectedIndex >= this.nodes.length) {
      this.selectedIndex = Math.max(0, this.nodes.length - 1);
    }
  }

  /** True while `/` is taking text: a command key is a letter of the filter then. */
  isFiltering(): boolean {
    return this.filtering;
  }

  /** The id the cursor is on, which the marks and the pin act on. */
  selectedId(): string | undefined {
    return this.getFilteredNodes()[this.selectedIndex]?.id;
  }

  /** Pin or unpin the selected record, the act `p` performs. */
  pinSelected(): void {
    const id = this.selectedId();
    if (id !== undefined) this.onTogglePin?.(id);
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

    // The marks are the same in both panes; paging the detail is ctrl+d/ctrl+u.
    if (this.controls.handleKey(data, this.selectedId())) return;

    if (this.focusedPane === "list") {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.onBack?.();
        return;
      }
      if (data === "/") {
        this.filtering = true;
        this.filterText = "";
        return;
      }
      if (matchesKey(data, "l") || matchesKey(data, "right") || matchesKey(data, "enter")) {
        this.focusedPane = "detail";
        this.scrollOffset = 0;
        return;
      }
      const filtered = this.getFilteredNodes();
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
      if (matchesKey(data, "p")) {
        const node = filtered[this.selectedIndex];
        if (node) this.onTogglePin?.(node.id);
        return;
      }
    } else {
      // Detail pane focused
      if (matchesKey(data, "h") || matchesKey(data, "left") || matchesKey(data, "escape")) {
        this.focusedPane = "list";
        return;
      }
      if (matchesKey(data, "p")) {
        const node = this.getFilteredNodes()[this.selectedIndex];
        if (node) this.onTogglePin?.(node.id);
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
        const filtered = this.getFilteredNodes();
        const delta = event.wheelDelta > 0 ? 1 : -1;
        this.selectedIndex = Math.max(0, Math.min(filtered.length - 1, this.selectedIndex + delta));
      }
      return { handled: true, render: true };
    }
    if (event.type === "press") {
      return { handled: true, focus: true };
    }
    if (event.type === "click") {
      const listWidth = Math.min(36, Math.floor(event.width * 0.4));
      if (event.x < listWidth) {
        const listIdx = event.y - 2;
        const filtered = this.getFilteredNodes();
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
    // Stateless rendering from brain data.
  }

  private getFilteredNodes(): AtlasNode[] {
    if (this.filterText.trim().length === 0) return this.nodes;
    const q = this.filterText.toLowerCase();
    return this.nodes.filter((node) => {
      const handle = (this.brain ? handleOf(this.brain.handles, "atlas", node.id) : "") ?? "";
      return (
        handle.toLowerCase().includes(q) ||
        node.title.toLowerCase().includes(q) ||
        node.text.toLowerCase().includes(q)
      );
    });
  }

  private renderDetail(node: AtlasNode, handle: string, width: number, maxLines: number = 28): string[] {
    const rawLines: string[] = [];
    const isStale = this.staleHandles.has(handle);
    const isoDate = new Date(node.updatedAt).toISOString();

    const titlePrefix = `${tokens.bold(tokens.accent(`[${handle}]`))} ${tokens.bold(node.title)}`;
    const badges: string[] = [];
    if (node.pinned !== undefined) badges.push(pinBadgeText(node.pinned, "pin"));
    if (isStale) badges.push(tokens.staleBadge("!stale"));
    badges.push(tokens.muted(isoDate));
    if (this.focusedPane === "detail") badges.push(tokens.bold(tokens.accent("[FOCUSED]")));

    rawLines.push(tokens.cardHeaderBg(padLine(` ${titlePrefix} ${badges.join(" ")}`, width)));
    if (node.mark !== undefined) {
      rawLines.push(tokens.cardBg(padLine(` ${tokens.warn(`◆ ${node.mark.action} on collapse · ${node.mark.author === "user" ? "you" : "agent"}`)}`, width)));
    }
    rawLines.push(tokens.cardBg(" ".repeat(width)));

    // Text entry
    rawLines.push(tokens.cardBg(padLine(` ${tokens.bold(tokens.muted("Text:"))}`, width)));
    const textLines = wrapTextWithAnsi(node.text, Math.max(1, width - 4));
    for (const tl of textLines) {
      rawLines.push(tokens.cardBg(padLine(`   ${tl}`, width)));
    }
    rawLines.push(tokens.cardBg(" ".repeat(width)));

    // Links
    rawLines.push(tokens.cardBg(padLine(` ${tokens.bold(tokens.muted(`Links (${node.links.length}):`))}`, width)));
    if (node.links.length === 0) {
      rawLines.push(tokens.cardBg(padLine(`   ${tokens.muted("(none)")}`, width)));
    } else {
      for (const link of node.links) {
        let targetHandle = "(gone)";
        if (this.brain) {
          const hit = this.brain.handles.entries.find((e) => e.id === link && e.kind === "atlas");
          if (hit) targetHandle = hit.handle;
        }
        const targetText = targetHandle === "(gone)" ? tokens.danger("(gone)") : tokens.accent(targetHandle);
        rawLines.push(tokens.cardBg(padLine(`   ${tokens.accent("▎")} ${targetText}`, width)));
      }
    }
    rawLines.push(tokens.cardBg(" ".repeat(width)));

    // Attachments
    rawLines.push(tokens.cardBg(padLine(` ${tokens.bold(tokens.muted(`Attachments (${node.attachments.length}):`))}`, width)));
    if (node.attachments.length === 0) {
      rawLines.push(tokens.cardBg(padLine(`   ${tokens.muted("(none)")}`, width)));
    } else {
      for (const attachment of node.attachments) {
        if (attachment.kind === "file") {
          rawLines.push(tokens.cardBg(padLine(`   ${tokens.accent("▎")} ${tokens.muted(attachment.path)}`, width)));
        } else {
          let recordHandle = "(gone)";
          if (this.brain) {
            const hit = this.brain.handles.entries.find((e) => e.id === attachment.id);
            if (hit) recordHandle = hit.handle;
          }
          const targetText = recordHandle === "(gone)" ? tokens.danger("(gone)") : tokens.accent(recordHandle);
          rawLines.push(tokens.cardBg(padLine(`   ${tokens.accent("▎")} ${targetText}`, width)));
        }
      }
    }
    rawLines.push(tokens.cardBg(" ".repeat(width)));

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
    const filtered = this.getFilteredNodes();

    // One header row, Posting's shape: the book's name, its figure, and what the
    // keys do here. The book itself starts one quiet line below it.
    const name = tokens.bold(tokens.atlas("ATLAS"));
    const figure = `${tokens.text(String(filtered.length))} ${tokens.faint("nodes")}`;
    const filter = this.filtering
      ? ` ${tokens.accent(`/${this.filterText}█`)}`
      : this.filterText
        ? ` ${tokens.accent(`/${this.filterText}`)}`
        : "";
    const stale = this.staleHandles.size > 0 ? ` ${tokens.warn(`!${this.staleHandles.size} stale`)}` : "";
    const left = ` ${name} ${tokens.faint("·")} ${figure}${filter}${stale}`;
    const right = `${tokens.faint(this.controls.nowArmed ? "next mark applies NOW " : "p pin · a/d mark · u withdraw · ! now · / filter ")}`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    lines.push(tokens.panel(padLine(left + " ".repeat(gap) + right, width)));
    lines.push(padLine("", width));

    if (filtered.length === 0) {
      lines.push(`  ${tokens.muted("The Atlas is empty. The agent creates nodes with the atlas tool.")}`);
      return lines;
    }

    const selectedNode = filtered[this.selectedIndex] ?? filtered[0];
    if (!selectedNode) return lines;
    const selectedHandle = (this.brain ? handleOf(this.brain.handles, "atlas", selectedNode.id) : undefined) ?? "A?";

    // Two-Pane split
    if (width >= 72) {
      const listWidth = Math.min(36, Math.floor(width * 0.4));
      const detailWidth = Math.max(30, width - listWidth - 2);

      const listLines: string[] = [];
      filtered.forEach((node, idx) => {
        const handle = (this.brain ? handleOf(this.brain.handles, "atlas", node.id) : "") ?? `A${idx + 1}`;
        const isSelected = idx === this.selectedIndex;
        const isStale = this.staleHandles.has(handle);

        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const handleStr = `[${handle}]`.padEnd(6);
        const pinStr = pinBadgeText(node.pinned, "P");
        const staleStr = isStale ? tokens.staleBadge("!") : "";
        const badges = `${pinStr}${staleStr}`;
        const mark = node.mark === undefined ? "" : `${tokens.warn(`◆ ${node.mark.action}`)} `;
        const titleSpace = Math.max(1, listWidth - 10 - visibleWidth(badges) - visibleWidth(mark));
        const titleStr = truncateToWidth(node.title, titleSpace, "…");

        const rowText = `${prefix}${isSelected ? tokens.bold(tokens.accent(handleStr)) : tokens.muted(handleStr)} ${mark}${titleStr} ${badges}`;
        const paddedRow = isSelected
          ? (this.focusedPane === "list" ? tokens.selectedBg(padLine(rowText, listWidth)) : tokens.activeRowBg(padLine(rowText, listWidth)))
          : tokens.sidebarBg(padLine(rowText, listWidth));
        listLines.push(paddedRow);
      });

      const detailLines = this.renderDetail(selectedNode, selectedHandle, detailWidth);
      const rowCount = Math.max(listLines.length, detailLines.length);

      for (let r = 0; r < rowCount; r++) {
        const left = listLines[r] ?? tokens.sidebarBg(" ".repeat(listWidth));
        const right = detailLines[r] ?? tokens.cardBg(" ".repeat(detailWidth));
        lines.push(`${left}  ${right}`);
      }
    } else {
      // Stacked layout
      filtered.forEach((node, idx) => {
        const handle = (this.brain ? handleOf(this.brain.handles, "atlas", node.id) : "") ?? `A${idx + 1}`;
        const isSelected = idx === this.selectedIndex;
        const isStale = this.staleHandles.has(handle);

        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const pinStr = pinBadgeText(node.pinned, "pin");
        const staleStr = isStale ? tokens.staleBadge("!stale") : "";
        const mark = node.mark === undefined ? "" : `${tokens.warn(`◆ ${node.mark.action} on collapse`)} `;
        const rowText = `${prefix}${tokens.bold(tokens.accent(`[${handle}]`))} ${mark}${node.title} ${pinStr} ${staleStr}`;
        lines.push(isSelected ? tokens.selectedBg(padLine(rowText, width)) : rowText);

        if (isSelected && this.detailExpanded) {
          lines.push(...this.renderDetail(node, handle, width, 16));
        }
      });
    }

    return lines;
  }
}
