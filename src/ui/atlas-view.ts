/**
 * The Atlas view (MINI.md §2.1, §6): source-backed claims and the graph.
 * Navigable via vim motions (j/k, gg/G, / to filter, enter/space to expand,
 * esc to return to Chat).
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
import { tokens } from "./tokens.js";

export class AtlasView implements Component, Focusable {
  focused = false;
  onBack?: () => void;

  private brain: CartoBrain | undefined;
  private nodes: AtlasNode[] = [];
  private selectedIndex = 0;
  private filterText = "";
  private filtering = false;
  private detailExpanded = true;
  private staleHandles = new Set<string>();
  private pinnedHandles = new Set<string>();

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
    this.pinnedHandles.clear();
    const allPins = [...brain.userPins, ...brain.carryPins];
    for (const pin of allPins) {
      for (const node of brain.atlas) {
        const handle = handleOf(brain.handles, "atlas", node.id);
        if (pin.item.includes(node.id) || (handle && pin.item.includes(handle))) {
          if (handle) this.pinnedHandles.add(handle);
        }
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

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onBack?.();
      return;
    }
    if (data === "/") {
      this.filtering = true;
      this.filterText = "";
      return;
    }
    const filtered = this.getFilteredNodes();
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

  private renderDetail(node: AtlasNode, handle: string, width: number): string[] {
    const lines: string[] = [];
    const isPinned = this.pinnedHandles.has(handle);
    const isStale = this.staleHandles.has(handle);
    const isoDate = new Date(node.updatedAt).toISOString();

    const titlePrefix = `${tokens.bold(tokens.accent(`[${handle}]`))} ${tokens.bold(node.title)}`;
    const badges: string[] = [];
    if (isPinned) badges.push(tokens.pinBadge("pin"));
    if (isStale) badges.push(tokens.staleBadge("!stale"));
    badges.push(tokens.muted(isoDate));

    lines.push(tokens.cardHeaderBg(` ${titlePrefix} ${badges.join(" ")}`.padEnd(width)));
    lines.push(tokens.cardBg(" ".repeat(width)));

    // Claim
    lines.push(tokens.cardBg(` ${tokens.bold(tokens.muted("Claim:"))}`.padEnd(width)));
    const claimLines = wrapTextWithAnsi(node.claim, Math.max(1, width - 4));
    for (const cl of claimLines) {
      lines.push(tokens.cardBg(`   ${cl}`.padEnd(width)));
    }
    lines.push(tokens.cardBg(" ".repeat(width)));

    // Evidence
    lines.push(tokens.cardBg(` ${tokens.bold(tokens.muted(`Evidence (${node.evidence.length}):`))}`.padEnd(width)));
    if (node.evidence.length === 0) {
      lines.push(tokens.cardBg(`   ${tokens.muted("(none)")}`.padEnd(width)));
    } else {
      for (const ref of node.evidence) {
        if (ref.kind === "file") {
          const freshTag = ref.freshness === "stale" ? tokens.warn("[stale]") : tokens.muted(`[${ref.freshness}]`);
          lines.push(tokens.cardBg(`   ${tokens.accent("▎")} ${tokens.muted(ref.path)}:${ref.startLine}-${ref.endLine} ${freshTag}`.padEnd(width)));
          lines.push(tokens.cardBg(`     ${tokens.muted(`sha256: ${ref.digest.slice(0, 16)}…`)}`.padEnd(width)));
          const excerptLines = wrapTextWithAnsi(`"${ref.excerpt.trim()}"`, Math.max(1, width - 6));
          for (const el of excerptLines) {
            lines.push(tokens.cardBg(`     ${tokens.output(el)}`.padEnd(width)));
          }
        } else {
          lines.push(tokens.cardBg(`   ${tokens.accent("▎")} context ${ref.contextId} [${ref.freshness}]`.padEnd(width)));
        }
      }
    }
    lines.push(tokens.cardBg(" ".repeat(width)));

    // Edges
    lines.push(tokens.cardBg(` ${tokens.bold(tokens.muted(`Graph Edges (${node.edges.length}):`))}`.padEnd(width)));
    if (node.edges.length === 0) {
      lines.push(tokens.cardBg(`   ${tokens.muted("(unconnected node)")}`.padEnd(width)));
    } else {
      for (const edge of node.edges) {
        let targetHandle = "(gone)";
        if (this.brain) {
          const hit = this.brain.handles.entries.find((e) => e.id === edge.target && e.kind === "atlas");
          if (hit) targetHandle = hit.handle;
        }
        const targetText = targetHandle === "(gone)" ? tokens.danger("(gone)") : tokens.accent(targetHandle);
        lines.push(tokens.cardBg(`   ${tokens.muted("→")} ${tokens.tool(edge.kind)} ${targetText}`.padEnd(width)));
      }
    }
    lines.push(tokens.cardBg(" ".repeat(width)));

    return lines;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const filtered = this.getFilteredNodes();

    // Top Header Banner
    const filterInfo = this.filtering ? ` [filter: ${this.filterText}█]` : this.filterText ? ` [filter: ${this.filterText}]` : "";
    const headerLeft = ` ${tokens.bold(tokens.accent("ATLAS"))} ${tokens.muted("·")} ${filtered.length} nodes ${tokens.warn(filterInfo)}`;
    const headerRight = `${this.staleHandles.size > 0 ? tokens.warn(`!${this.staleHandles.size} stale  `) : ""}${tokens.muted("esc to chat ")}`;
    const pad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight));
    lines.push(tokens.panel((headerLeft + " ".repeat(pad) + headerRight).padEnd(width)));
    lines.push("");

    if (filtered.length === 0) {
      lines.push(`  ${tokens.muted("(The Atlas is empty. Call the atlas tool to create source-backed claims.)")}`);
      return lines;
    }

    const selectedNode = filtered[this.selectedIndex] ?? filtered[0];
    if (!selectedNode) return lines;
    const selectedHandle = (this.brain ? handleOf(this.brain.handles, "atlas", selectedNode.id) : undefined) ?? "A?";

    // Two-Pane split if wide enough
    if (width >= 72) {
      const listWidth = Math.min(36, Math.floor(width * 0.4));
      const detailWidth = Math.max(30, width - listWidth - 2);

      const listLines: string[] = [];
      filtered.forEach((node, idx) => {
        const handle = (this.brain ? handleOf(this.brain.handles, "atlas", node.id) : "") ?? `A${idx + 1}`;
        const isSelected = idx === this.selectedIndex;
        const isPinned = this.pinnedHandles.has(handle);
        const isStale = this.staleHandles.has(handle);

        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const handleStr = `[${handle}]`.padEnd(6);
        const pinStr = isPinned ? tokens.pinBadge("P") : "";
        const staleStr = isStale ? tokens.staleBadge("!") : "";
        const badges = `${pinStr}${staleStr}`;
        const titleSpace = Math.max(4, listWidth - 10 - visibleWidth(badges));
        const titleStr = truncateToWidth(node.title, titleSpace, "…");

        const rowText = `${prefix}${isSelected ? tokens.bold(tokens.accent(handleStr)) : tokens.muted(handleStr)} ${titleStr} ${badges}`;
        const paddedRow = isSelected ? tokens.selectedBg(rowText.padEnd(listWidth)) : tokens.activeRowBg(rowText.padEnd(listWidth));
        listLines.push(paddedRow);
      });

      const detailLines = this.renderDetail(selectedNode, selectedHandle, detailWidth);
      const rowCount = Math.max(listLines.length, detailLines.length);

      for (let r = 0; r < rowCount; r++) {
        const left = listLines[r] ?? " ".repeat(listWidth);
        const right = detailLines[r] ?? " ".repeat(detailWidth);
        lines.push(`${left}  ${right}`);
      }
    } else {
      // Stacked layout
      filtered.forEach((node, idx) => {
        const handle = (this.brain ? handleOf(this.brain.handles, "atlas", node.id) : "") ?? `A${idx + 1}`;
        const isSelected = idx === this.selectedIndex;
        const isPinned = this.pinnedHandles.has(handle);
        const isStale = this.staleHandles.has(handle);

        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const pinStr = isPinned ? tokens.pinBadge("pin") : "";
        const staleStr = isStale ? tokens.staleBadge("!stale") : "";
        const rowText = `${prefix}${tokens.bold(tokens.accent(`[${handle}]`))} ${node.title} ${pinStr} ${staleStr}`;
        lines.push(isSelected ? tokens.selectedBg(rowText.padEnd(width)) : rowText);

        if (isSelected && this.detailExpanded) {
          lines.push(...this.renderDetail(node, handle, width));
        }
      });
    }

    return lines;
  }
}
