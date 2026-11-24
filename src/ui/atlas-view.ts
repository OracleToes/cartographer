/**
 * The Atlas view (§2.1): nodes — a name and a text entry —
 * linked to other nodes or attached to any reference.
 * Navigable via vim motions (j/k, gg/G, / to filter, enter/space to expand,
 * h/l or left/right to switch between list and detail, esc to return to Chat).
 *
 * Exposes `headerPane`, `listPane`, and `detailPane` so the host mounts the
 * list and detail inside real per-pane `ScrollView`s (no manual `scrollOffset`
 * or fixed line cap), while still rendering standalone for narrow viewports
 * and tests.
 */
import {
  fuzzyFilter,
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type ScrollView,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { handleOf } from "../domain/handles.js";
import type { AtlasNode, CartoBrain } from "../domain/records.js";
import { padLine, renderMarkdown, surfaceLine, tokens } from "./tokens.js";
import { RecordControls } from "./record-controls.js";

export class AtlasView implements Component, Focusable {
  focused = false;
  onBack?: () => void;
  /** Called when a click lands inside a sub-pane so the host keeps keyboard focus on AtlasView. */
  onFocus?: () => void;
  /** The person's marks on the selected record: `a` archive, `d` delete, `u` withdraw, `!` apply now (§4.1). */
  readonly controls = new RecordControls();

  private focusedPane: "list" | "detail" = "list";
  private brain: CartoBrain | undefined;
  private nodes: AtlasNode[] = [];
  private selectedIndex = 0;
  private readonly filterInput = new Input({ prompt: "/" });
  private filtering = false;
  private detailExpanded = true;
  private staleHandles = new Set<string>();
  private listScroll: ScrollView | undefined;
  private detailScroll: ScrollView | undefined;

  /** Fixed 2-row header above the split panes. */
  readonly headerPane: Component = {
    invalidate: () => {},
    render: (width) => this.renderHeader(width),
  };

  /** Scrollable left list pane mounted in its own `ScrollView`. */
  readonly listPane: Component = {
    invalidate: () => {},
    render: (width) => this.renderListRows(width),
    handleMouse: (event) => this.handleListMouse(event),
  };

  /** Scrollable right detail pane mounted in its own `ScrollView`. */
  readonly detailPane: Component = {
    invalidate: () => {},
    render: (width) => this.renderSelectedDetail(width),
    handleMouse: (event) => this.handleDetailMouse(event),
  };

  /** Bind the host's per-pane `ScrollView`s so keyboard navigation drives real viewport scrolling. */
  attachScrolls(listScroll: ScrollView, detailScroll: ScrollView): void {
    this.listScroll = listScroll;
    this.detailScroll = detailScroll;
  }

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

  /** The id the cursor is on, which the marks act on. */
  selectedId(): string | undefined {
    return this.getFilteredNodes()[this.selectedIndex]?.id;
  }

  private revealListRow(): void {
    const scroll = this.listScroll;
    if (scroll === undefined) return;
    const viewport = scroll.viewportHeight;
    if (viewport <= 0) return;
    const top = scroll.scrollTop;
    if (this.selectedIndex < top) scroll.scrollTo(this.selectedIndex);
    else if (this.selectedIndex >= top + viewport) scroll.scrollTo(this.selectedIndex - viewport + 1);
  }

  private selectIndex(next: number): void {
    const filtered = this.getFilteredNodes();
    this.selectedIndex = filtered.length === 0 ? 0 : Math.max(0, Math.min(filtered.length - 1, next));
    this.revealListRow();
    this.detailScroll?.scrollToStart();
  }

  private detailPageStep(): number {
    const viewport = this.detailScroll?.viewportHeight ?? 0;
    return viewport > 2 ? Math.max(1, Math.floor(viewport / 2)) : 10;
  }

  handleInput(data: string): void {
    if (this.filtering) {
      this.filterInput.focused = this.focused;
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.filtering = false;
        this.filterInput.setValue("");
        this.selectIndex(0);
        return;
      }
      if (matchesKey(data, "enter")) {
        this.filtering = false;
        return;
      }
      if (matchesKey(data, "tab")) return;
      this.filterInput.handleInput(data);
      this.selectIndex(0);
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
        this.detailScroll?.scrollToStart();
        return;
      }
      const filtered = this.getFilteredNodes();
      if (matchesKey(data, "j") || matchesKey(data, "down")) {
        this.selectIndex(this.selectedIndex + 1);
        return;
      }
      if (matchesKey(data, "k") || matchesKey(data, "up")) {
        this.selectIndex(this.selectedIndex - 1);
        return;
      }
      if (matchesKey(data, "g")) {
        this.selectIndex(0);
        return;
      }
      if (data === "G") {
        this.selectIndex(filtered.length - 1);
        return;
      }
      if (matchesKey(data, "space")) {
        this.detailExpanded = !this.detailExpanded;
        return;
      }
    } else {
      // Detail pane focused — drive the detail ScrollView directly.
      if (matchesKey(data, "h") || matchesKey(data, "left") || matchesKey(data, "escape")) {
        this.focusedPane = "list";
        return;
      }
      if (matchesKey(data, "j") || matchesKey(data, "down")) {
        this.detailScroll?.scrollBy(1);
        return;
      }
      if (matchesKey(data, "k") || matchesKey(data, "up")) {
        this.detailScroll?.scrollBy(-1);
        return;
      }
      if (matchesKey(data, "ctrl+d") || matchesKey(data, "pageDown")) {
        this.detailScroll?.scrollBy(this.detailPageStep());
        return;
      }
      if (matchesKey(data, "ctrl+u") || matchesKey(data, "pageUp")) {
        this.detailScroll?.scrollBy(-this.detailPageStep());
        return;
      }
      if (matchesKey(data, "g")) {
        this.detailScroll?.scrollToStart();
        return;
      }
      if (data === "G") {
        this.detailScroll?.scrollToEnd();
        return;
      }
    }
  }

  private handleListMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press") {
      this.onFocus?.();
      return { handled: true };
    }
    if (event.type === "click") {
      const filtered = this.getFilteredNodes();
      if (event.y >= 0 && event.y < filtered.length) {
        this.focusedPane = "list";
        this.selectIndex(event.y);
        this.onFocus?.();
        return { handled: true, render: true };
      }
    }
    return undefined;
  }

  private handleDetailMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press") {
      this.onFocus?.();
      return { handled: true };
    }
    if (event.type === "click") {
      this.focusedPane = "detail";
      this.onFocus?.();
      return { handled: true, render: true };
    }
    return undefined;
  }

  /** Mouse handling for standalone / narrow stacked rendering. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel" && event.wheelDelta) {
      if (this.focusedPane === "detail") {
        this.detailScroll?.scrollBy(event.wheelDelta > 0 ? 3 : -3);
      } else {
        const delta = event.wheelDelta > 0 ? 1 : -1;
        this.selectIndex(this.selectedIndex + delta);
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
          this.focusedPane = "list";
          this.selectIndex(listIdx);
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
    const query = this.filterInput.getValue().trim();
    if (query.length === 0) return this.nodes;
    return fuzzyFilter(this.nodes, query, (node) => {
      const handle = (this.brain ? handleOf(this.brain.handles, "atlas", node.id) : "") ?? "";
      return `${handle} ${node.title} ${node.text}`;
    });
  }

  private renderHeader(width: number): string[] {
    const filtered = this.getFilteredNodes();
    const name = tokens.bold(tokens.atlas("ATLAS"));
    const figure = `${tokens.text(String(filtered.length))} ${tokens.faint("nodes")}`;
    const query = this.filterInput.getValue();
    let filter = "";
    if (this.filtering) {
      this.filterInput.focused = this.focused;
      const filterWidth = Math.min(24, Math.max(6, visibleWidth(query) + 2));
      filter = ` ${tokens.accent((this.filterInput.render(filterWidth)[0] ?? `/${query}`).trimEnd())}`;
    } else if (query.length > 0) {
      filter = ` ${tokens.accent(`/${query}`)}`;
    }
    const stale = this.staleHandles.size > 0 ? ` ${tokens.warn(`!${this.staleHandles.size} stale`)}` : "";
    const left = ` ${name} ${tokens.faint("·")} ${figure}${filter}${stale}`;
    const right = `${tokens.faint(this.controls.nowArmed ? "next mark applies NOW " : "a/d mark · u withdraw · ! now · / filter ")}`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return [tokens.panel(padLine(left + " ".repeat(gap) + right, width)), padLine("", width)];
  }

  private renderListRows(width: number): string[] {
    const filtered = this.getFilteredNodes();
    if (filtered.length === 0) {
      return [tokens.sidebarBg(padLine(`  ${tokens.muted("No Atlas nodes.")}`, width))];
    }
    return filtered.map((node, idx) => {
      const handle = (this.brain ? handleOf(this.brain.handles, "atlas", node.id) : "") ?? `A${idx + 1}`;
      const isSelected = idx === this.selectedIndex;
      const isStale = this.staleHandles.has(handle);

      const prefix = isSelected ? tokens.accent("▸ ") : "  ";
      const handleStr = `[${handle}]`.padEnd(6);
      const staleStr = isStale ? tokens.staleBadge("!") : "";
      const badges = staleStr;
      const mark = node.mark === undefined ? "" : `${tokens.warn(`◆ ${node.mark.action}`)} `;
      const titleSpace = Math.max(1, width - 10 - visibleWidth(badges) - visibleWidth(mark));
      const titleStr = truncateToWidth(node.title, titleSpace, "…");

      const rowText = `${prefix}${isSelected ? tokens.bold(tokens.accent(handleStr)) : tokens.muted(handleStr)} ${mark}${titleStr} ${badges}`;
      return isSelected
        ? (this.focusedPane === "list" ? tokens.selectedBg(padLine(rowText, width)) : tokens.activeRowBg(padLine(rowText, width)))
        : tokens.sidebarBg(padLine(rowText, width));
    });
  }

  private renderSelectedDetail(width: number): string[] {
    const filtered = this.getFilteredNodes();
    const selectedNode = filtered[this.selectedIndex] ?? filtered[0];
    if (!selectedNode) {
      return [surfaceLine(`  ${tokens.muted("The Atlas is empty. The agent creates nodes with the atlas tool.")}`, width)];
    }
    const selectedHandle = (this.brain ? handleOf(this.brain.handles, "atlas", selectedNode.id) : undefined) ?? "A?";
    return this.renderDetail(selectedNode, selectedHandle, width);
  }

  private renderDetail(node: AtlasNode, handle: string, width: number): string[] {
    const rawLines: string[] = [];
    const isStale = this.staleHandles.has(handle);
    const isoDate = new Date(node.updatedAt).toISOString();

    const titlePrefix = `${tokens.bold(tokens.accent(`[${handle}]`))} ${tokens.bold(node.title)}`;
    const badges: string[] = [];
    if (isStale) badges.push(tokens.staleBadge("!stale"));
    badges.push(tokens.muted(isoDate));
    if (this.focusedPane === "detail") badges.push(tokens.bold(tokens.accent("[FOCUSED]")));

    rawLines.push(tokens.cardHeaderBg(padLine(` ${titlePrefix} ${badges.join(" ")}`, width)));
    if (node.mark !== undefined) {
      rawLines.push(surfaceLine(` ${tokens.warn(`◆ ${node.mark.action} on collapse · ${node.mark.author === "user" ? "you" : "agent"}`)}`, width));
    }
    rawLines.push(surfaceLine("", width));

    // Text entry (rendered as Markdown via pi-tui)
    rawLines.push(surfaceLine(` ${tokens.bold(tokens.muted("Text:"))}`, width));
    const textLines = renderMarkdown(node.text, Math.max(1, width - 4), tokens.text);
    for (const tl of textLines) {
      rawLines.push(surfaceLine(`   ${tl}`, width));
    }
    rawLines.push(surfaceLine("", width));

    // Links
    rawLines.push(surfaceLine(` ${tokens.bold(tokens.muted(`Links (${node.links.length}):`))}`, width));
    if (node.links.length === 0) {
      rawLines.push(surfaceLine(`   ${tokens.muted("(none)")}`, width));
    } else {
      for (const link of node.links) {
        let targetHandle = "(gone)";
        if (this.brain) {
          const hit = this.brain.handles.entries.find((e) => e.id === link && e.kind === "atlas");
          if (hit) targetHandle = hit.handle;
        }
        const targetText = targetHandle === "(gone)" ? tokens.danger("(gone)") : tokens.accent(targetHandle);
        rawLines.push(surfaceLine(`   ${tokens.accent("▎")} ${targetText}`, width));
      }
    }
    rawLines.push(surfaceLine("", width));

    // Attachments
    rawLines.push(surfaceLine(` ${tokens.bold(tokens.muted(`Attachments (${node.attachments.length}):`))}`, width));
    if (node.attachments.length === 0) {
      rawLines.push(surfaceLine(`   ${tokens.muted("(none)")}`, width));
    } else {
      for (const attachment of node.attachments) {
        if (attachment.kind === "file") {
          rawLines.push(surfaceLine(`   ${tokens.accent("▎")} ${tokens.muted(attachment.path)}`, width));
        } else {
          let recordHandle = "(gone)";
          if (this.brain) {
            const hit = this.brain.handles.entries.find((e) => e.id === attachment.id);
            if (hit) recordHandle = hit.handle;
          }
          const targetText = recordHandle === "(gone)" ? tokens.danger("(gone)") : tokens.accent(recordHandle);
          rawLines.push(surfaceLine(`   ${tokens.accent("▎")} ${targetText}`, width));
        }
      }
    }
    rawLines.push(surfaceLine("", width));
    return rawLines;
  }

  /** Standalone / narrow stacked render (used on narrow terminals and in direct unit tests). */
  render(width: number): string[] {
    const lines = this.renderHeader(width);
    const filtered = this.getFilteredNodes();

    if (filtered.length === 0) {
      lines.push(padLine(`  ${tokens.muted("The Atlas is empty. The agent creates nodes with the atlas tool.")}`, width));
      return lines;
    }

    const selectedNode = filtered[this.selectedIndex] ?? filtered[0];
    if (!selectedNode) return lines;
    const selectedHandle = (this.brain ? handleOf(this.brain.handles, "atlas", selectedNode.id) : undefined) ?? "A?";

    if (width >= 72) {
      const listWidth = Math.min(36, Math.floor(width * 0.4));
      const detailWidth = Math.max(30, width - listWidth - 2);
      const listLines = this.renderListRows(listWidth);
      const detailLines = this.renderDetail(selectedNode, selectedHandle, detailWidth);
      const rowCount = Math.max(listLines.length, detailLines.length);

      for (let r = 0; r < rowCount; r++) {
        const left = listLines[r] ?? tokens.sidebarBg(" ".repeat(listWidth));
        const right = detailLines[r] ?? surfaceLine("", detailWidth);
        lines.push(`${left}  ${right}`);
      }
    } else {
      filtered.forEach((node, idx) => {
        const handle = (this.brain ? handleOf(this.brain.handles, "atlas", node.id) : "") ?? `A${idx + 1}`;
        const isSelected = idx === this.selectedIndex;
        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const mark = node.mark === undefined ? "" : `${tokens.warn(`◆ ${node.mark.action} on collapse`)} `;
        const rowText = `${prefix}${tokens.bold(tokens.accent(`[${handle}]`))} ${mark}${node.title}`;
        lines.push(isSelected ? tokens.selectedBg(padLine(rowText, width)) : padLine(rowText, width));

        if (isSelected && this.detailExpanded) {
          lines.push(...this.renderDetail(node, handle, width));
        }
      });
    }

    return lines;
  }
}
