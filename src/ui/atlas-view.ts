/**
 * The Atlas view (MINI.md §2.1, §6): source-backed claims and the graph.
 * Navigable via vim motions (j/k, gg/G, / to filter, enter/space to expand,
 * h/l or left/right to switch between list and detail, esc to return to Chat).
 *
 * Designed with Posting's visual hierarchy: background tints and card surfaces
 * rather than excessive line borders. Pinned nodes and stale evidence are
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
import { padLine, tokens } from "./tokens.js";

export class AtlasView implements Component, Focusable {
  focused = false;
  onBack?: () => void;

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
      if (mark.kind === "atlas") {
        const handle = mark.label.split(" ")[0];
        if (handle) this.staleHandles.add(handle);
      }
    }
    if (this.selectedIndex >= this.nodes.length) {
      this.selectedIndex = Math.max(0, this.nodes.length - 1);
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
      if (matchesKey(data, "d") || matchesKey(data, "pageDown")) {
        this.scrollOffset += 10;
        return;
      }
      if (matchesKey(data, "u") || matchesKey(data, "pageUp")) {
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
        node.claim.toLowerCase().includes(q)
      );
    });
  }

  private renderDetail(node: AtlasNode, handle: string, width: number, maxLines: number = 28): string[] {
    const rawLines: string[] = [];
    const isPinned = node.pinned === true;
    const isStale = this.staleHandles.has(handle);
    const isoDate = new Date(node.updatedAt).toISOString();

    const titlePrefix = `${tokens.bold(tokens.accent(`[${handle}]`))} ${tokens.bold(node.title || node.claim || "")}`;
    const badges: string[] = [];
    if (isPinned) badges.push(tokens.pinBadge("pin"));
    if (isStale) badges.push(tokens.staleBadge("!stale"));
    badges.push(tokens.muted(isoDate));
    if (this.focusedPane === "detail") badges.push(tokens.bold(tokens.accent("[FOCUSED]")));

    rawLines.push(tokens.cardHeaderBg(padLine(` ${titlePrefix} ${badges.join(" ")}`, width)));
    rawLines.push(tokens.cardBg(" ".repeat(width)));

    // Claim
    rawLines.push(tokens.cardBg(padLine(` ${tokens.bold(tokens.muted("Claim:"))}`, width)));
    const claimLines = wrapTextWithAnsi(node.claim, Math.max(1, width - 4));
    for (const cl of claimLines) {
      rawLines.push(tokens.cardBg(padLine(`   ${cl}`, width)));
    }
    rawLines.push(tokens.cardBg(" ".repeat(width)));

    // Evidence
    rawLines.push(tokens.cardBg(padLine(` ${tokens.bold(tokens.muted(`Evidence (${node.evidence.length}):`))}`, width)));
    if (node.evidence.length === 0) {
      rawLines.push(tokens.cardBg(padLine(`   ${tokens.muted("(none)")}`, width)));
    } else {
      for (const ref of node.evidence) {
        if (ref.kind === "file") {
          const freshTag = ref.freshness === "stale" ? tokens.warn("[stale]") : tokens.muted(`[${ref.freshness}]`);
          rawLines.push(tokens.cardBg(padLine(`   ${tokens.accent("▎")} ${tokens.muted(ref.path)}:${ref.startLine}-${ref.endLine} ${freshTag}`, width)));
          rawLines.push(tokens.cardBg(padLine(`     ${tokens.muted(`sha256: ${ref.digest.slice(0, 16)}…`)}`, width)));
          const excerptLines = wrapTextWithAnsi(`"${ref.excerpt.trim()}"`, Math.max(1, width - 6));
          for (const el of excerptLines) {
            rawLines.push(tokens.cardBg(padLine(`     ${tokens.output(el)}`, width)));
          }
        } else {
          rawLines.push(tokens.cardBg(padLine(`   ${tokens.accent("▎")} context ${ref.contextId} [${ref.freshness}]`, width)));
        }
      }
    }
    rawLines.push(tokens.cardBg(" ".repeat(width)));

    // Edges
    rawLines.push(tokens.cardBg(padLine(` ${tokens.bold(tokens.muted(`Graph Edges (${node.edges.length}):`))}`, width)));
    if (node.edges.length === 0) {
      rawLines.push(tokens.cardBg(padLine(`   ${tokens.muted("(unconnected node)")}`, width)));
    } else {
      for (const edge of node.edges) {
        let targetHandle = "(gone)";
        if (this.brain) {
          const hit = this.brain.handles.entries.find((e) => e.id === edge.target && e.kind === "atlas");
          if (hit) targetHandle = hit.handle;
        }
        const targetText = targetHandle === "(gone)" ? tokens.danger("(gone)") : tokens.accent(targetHandle);
        rawLines.push(tokens.cardBg(padLine(`   ${tokens.muted("→")} ${tokens.tool(edge.kind)} ${targetText}`, width)));
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

    // Top Header Banner
    const filterInfo = this.filtering ? ` [filter: ${this.filterText}█]` : this.filterText ? ` [filter: ${this.filterText}]` : "";
    const headerLeft = ` ${tokens.bold(tokens.accent("ATLAS"))} ${tokens.muted("·")} ${filtered.length} nodes ${tokens.warn(filterInfo)}`;
    const headerRight = `${this.staleHandles.size > 0 ? tokens.warn(`!${this.staleHandles.size} stale  `) : ""}${tokens.muted("h/l switch panes · esc chat ")}`;
    const pad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight));
    lines.push(tokens.panel(padLine(headerLeft + " ".repeat(pad) + headerRight, width)));
    lines.push(padLine("", width));

    if (filtered.length === 0) {
      lines.push(`  ${tokens.muted("(The Atlas is empty. Call the atlas tool to create source-backed claims.)")}`);
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
        const isPinned = node.pinned === true;
        const isStale = this.staleHandles.has(handle);

        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const handleStr = `[${handle}]`.padEnd(6);
        const pinStr = isPinned ? tokens.pinBadge("P") : "";
        const staleStr = isStale ? tokens.staleBadge("!") : "";
        const badges = `${pinStr}${staleStr}`;
        const titleSpace = Math.max(4, listWidth - 10 - visibleWidth(badges));
        const titleStr = truncateToWidth(node.title || node.claim || "", titleSpace, "…");

        const rowText = `${prefix}${isSelected ? tokens.bold(tokens.accent(handleStr)) : tokens.muted(handleStr)} ${titleStr} ${badges}`;
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
        const isPinned = node.pinned === true;
        const isStale = this.staleHandles.has(handle);

        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const pinStr = isPinned ? tokens.pinBadge("pin") : "";
        const staleStr = isStale ? tokens.staleBadge("!stale") : "";
        const rowText = `${prefix}${tokens.bold(tokens.accent(`[${handle}]`))} ${node.title || node.claim || ""} ${pinStr} ${staleStr}`;
        lines.push(isSelected ? tokens.selectedBg(padLine(rowText, width)) : rowText);

        if (isSelected && this.detailExpanded) {
          lines.push(...this.renderDetail(node, handle, width, 16));
        }
      });
    }

    return lines;
  }
}
