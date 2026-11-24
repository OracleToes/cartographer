/**
 * The archive view (§3.3, §4.1).
 *
 * The archive is the person's, not the agent's: nothing here renders in the
 * context, nothing here has a handle the agent can name, and no tool reaches
 * this view. A person opens it from the palette, sees what a collapse swept,
 * and pins, unpins, restores, or marks an item for delete.
 *
 * Unpinned items expire at the next collapse; pins keep them.
 */
import {
  Input,
  fuzzyFilter,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import type { Archive, ArchivedItem } from "../domain/archive.js";
import { canvasLine, padLine, tokens, visibleWidth } from "./tokens.js";
import { pinHandle } from "./prompt-handles.js";

/**
 * The handle an archived row is named by. An archived record kept its Brain
 * handle while it was in the Brain and the archive stores it, so that is the
 * name; an ephemeral item never had one, and its archived id — the sweep's own
 * name for it — is what it answers to. A pin on either is `P` and that handle
 * (§5.4), because a pin is named by what it marks.
 */
function handleOfRow(item: ArchivedItem): string {
  const record = item.record;
  if (record !== undefined && "handle" in record && typeof record.handle === "string") return record.handle;
  const short = item.id.split(":").at(-1) ?? item.id;
  return short === "" ? item.id : short;
}

export class ArchiveView implements Component, Focusable {
  focused = false;
  /** Fired on `p`: place or remove the pin. A pin suspends grace. */
  onTogglePin?: (id: string) => void;
  /** Fired on `r`: mark the item for restore at the next collapse. */
  onRestore?: (id: string) => void;
  /** Fired on `d`: mark the item for delete at the next collapse. */
  onDelete?: (id: string) => void;
  /** Fired on `p`/`r`/`d` with the apply-now arm set: the mark, applied at once (§4.1). */
  onApplyNow?: (id: string, action: "restore" | "delete") => void;
  /** Fired on `u`: withdraw the mark on the item. A person's own mark is always theirs to withdraw. */
  onWithdrawMark?: (id: string) => void;
  onBack?: () => void;
  onReveal?: (line: number) => void;
  onFocus?: () => void;

  private allItems: ArchivedItem[] = [];
  private items: ArchivedItem[] = [];
  private selectedIndex = 0;
  private readonly filterInput = new Input({ prompt: "/", placeholder: "filter archive" });
  private filtering = false;
  private detailOpen = false;
  private detailCache: { item: ArchivedItem; width: number; lines: string[] } | undefined;
  private searchText = new Map<ArchivedItem, string>();
  private rowLines = new Map<number, number>();
  private detailLine = 0;
  private static readonly pageSize = 20;

  isFiltering(): boolean { return this.filtering; }

  pinSelected(): void {
    this.armed = undefined;
    this.nowArmed = false;
    const item = this.selectedItem();
    if (item !== undefined) this.onTogglePin?.(item.id);
  }

  private filterItems(selectedId?: string): void {
    const query = this.filterInput.getValue().trim();
    this.items = query === "" ? this.allItems : fuzzyFilter(this.allItems, query, (item) => {
      let text = this.searchText.get(item);
      if (text === undefined) {
        text = `${item.id} ${item.record?.kind ?? item.ephemeral?.kind ?? ""} ${item.sweptAtGeneration} ${JSON.stringify(item.record?.value ?? item.ephemeral ?? "")}`;
        this.searchText.set(item, text);
      }
      return text;
    });
    const index = selectedId === undefined ? -1 : this.items.findIndex((item) => item.id === selectedId);
    this.selectedIndex = index >= 0 ? index : 0;
    this.armed = undefined;
    this.nowArmed = false;
    this.detailOpen = false;
  }

  private select(index: number): void {
    this.selectedIndex = Math.max(0, Math.min(this.items.length - 1, index));
    this.armed = undefined;
    this.nowArmed = false;
    this.detailOpen = false;
    // The next render computes the row's line on its new bounded page.
    this.revealSelection = true;
  }

  private revealSelection = false;
  /**
   * Which item is armed for deletion. `d` takes two presses, the way deleting
   * does everywhere else here: an archived item is one the person already lost
   * once, and the second press is what makes the loss deliberate.
   */
  private armed: string | undefined;
  /**
   * The apply-now arm (§4.1). `!` arms it so the next mark is applied by a
   * rebuild now rather than at the next collapse. It is the person's, and it
   * costs work, so it is armed explicitly every time and clears itself.
   */
  private nowArmed = false;

  /**
   * The item under the cursor, so a palette entry can do what the key does.
   * The archive is a layer over the same UI (§3.3), and the palette is part of
   * that UI: a command that only worked from a keypress would be half a layer.
   */
  selectedItem(): ArchivedItem | undefined {
    return this.items[this.selectedIndex];
  }

  /**
   * The one `d`: the first press marks the item for delete, the second applies
   * that mark now. Says which happened, so the caller can tell the person.
   */
  deleteSelected(): "marked" | "applied" | "none" {
    const item = this.selectedItem();
    if (item === undefined) return "none";
    if (this.armed === item.id) {
      this.armed = undefined;
      this.nowArmed = false;
      this.onApplyNow?.(item.id, "delete");
      return "applied";
    }
    // Deletion always requires confirmation, including after `!`.
    this.nowArmed = false;
    this.armed = item.id;
    this.onDelete?.(item.id);
    return "marked";
  }

  /** The one `u`: withdraw the mark, leaving the item where it is. */
  withdrawSelected(): boolean {
    const item = this.selectedItem();
    if (item === undefined || item.mark === undefined) return false;
    this.armed = undefined;
    this.nowArmed = false;
    this.onWithdrawMark?.(item.id);
    return true;
  }

  /** The one `r`: mark the item for restore, or apply that mark now when `!` is armed. */
  restoreSelected(): "marked" | "applied" | "none" {
    const item = this.selectedItem();
    if (item === undefined) return "none";
    this.armed = undefined;
    if (this.nowArmed) {
      this.nowArmed = false;
      this.onApplyNow?.(item.id, "restore");
      return "applied";
    }
    this.onRestore?.(item.id);
    return "marked";
  }

  setData(archive: Archive): void {
    const selected = this.selectedItem()?.id;
    // Newest first, keeping the same selection across asynchronous refreshes.
    this.allItems = [...archive.items].sort((left, right) => right.sweptAt - left.sweptAt);
    this.searchText.clear();
    const index = this.selectedIndex;
    const armed = this.armed;
    const nowArmed = this.nowArmed;
    const detailOpen = this.detailOpen;
    this.filterItems(selected);
    if (selected !== undefined && !this.items.some((item) => item.id === selected)) {
      this.selectedIndex = Math.min(index, Math.max(0, this.items.length - 1));
    }
    if (this.selectedItem()?.id === selected) {
      this.armed = armed;
      this.nowArmed = nowArmed;
      this.detailOpen = detailOpen;
    }
    this.detailCache = undefined;
  }

  invalidate(): void {
    // Stateless; reads the archive it was handed.
  }

  handleInput(data: string): void {
    if (this.filtering) {
      if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
        this.filtering = false;
        return;
      }
      const before = this.filterInput.getValue();
      this.filterInput.handleInput(data);
      if (before !== this.filterInput.getValue()) {
        this.filterItems();
        this.revealSelection = true;
      }
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+t") || matchesKey(data, "q")) {
      this.onBack?.();
      return;
    }
    if (data === "/") { this.filtering = true; this.armed = undefined; this.nowArmed = false; return; }
    if (matchesKey(data, "j") || matchesKey(data, "down")) { this.select(this.selectedIndex + 1); return; }
    if (matchesKey(data, "k") || matchesKey(data, "up")) { this.select(this.selectedIndex - 1); return; }
    if (matchesKey(data, "g")) { this.select(0); return; }
    if (data === "G") { this.select(this.items.length - 1); return; }
    if (matchesKey(data, "enter") || data === " ") {
      if (this.selectedItem() !== undefined) {
        this.detailOpen = !this.detailOpen;
        this.armed = undefined;
        this.nowArmed = false;
        this.revealSelection = true;
      }
      return;
    }
    const selected = this.selectedItem();
    if (selected === undefined) return;
    if (matchesKey(data, "p")) { this.pinSelected(); return; }
    if (matchesKey(data, "r")) { this.restoreSelected(); return; }
    if (matchesKey(data, "d")) { this.deleteSelected(); return; }
    if (matchesKey(data, "u")) { this.withdrawSelected(); return; }
    if (data === "!") { this.armed = undefined; this.nowArmed = !this.nowArmed; return; }
    this.armed = undefined;
    this.nowArmed = false;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press") { this.onFocus?.(); return { handled: true }; }
    if (event.type === "click") {
      const index = this.rowLines.get(event.y);
      if (index !== undefined) {
        this.select(index);
        this.onFocus?.();
        return { handled: true, render: true };
      }
    }
    return undefined;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const inner = Math.max(20, width - 2);
    // A layer wears the same header as the working area it covers, so the person
    // always knows which layer they are looking at.
    const left = `${tokens.bold(tokens.warn("ARCHIVE"))} ${tokens.faint("· the person's, never the agent's")}`;
    const right = tokens.faint(`${this.items.length}/${this.allItems.length} items `);
    const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
    lines.push(tokens.panel(padLine(` ${left}${" ".repeat(gap)}${right}`, width)));
    if (this.filtering) {
      this.filterInput.focused = this.focused;
      lines.push(canvasLine(`  ${this.filterInput.render(Math.max(1, width - 2))[0] ?? ""}`, width));
    } else {
      const query = this.filterInput.getValue();
      lines.push(canvasLine(`  ${tokens.faint(query ? `filter: ${query} · / edit` : "/ filter · enter full content · j/k select")}`, width));
    }
    if (this.items.length === 0) {
      lines.push(canvasLine(`  ${tokens.muted(this.allItems.length === 0 ? "Nothing is archived." : "No matching items.")}`, width));
      lines.push(canvasLine(`  ${tokens.faint("Unpinned items expire at the next collapse; a pin keeps them.")}`, width));
      return lines;
    }
    lines.push(canvasLine(`  ${tokens.faint("unpinned: expires next collapse · pinned: kept")}`, width));
    if (this.nowArmed) lines.push(canvasLine(`  ${tokens.warn("! armed: r restores now · delete still requires d twice")}`, width));
    lines.push(canvasLine("", width));
    const start = Math.floor(this.selectedIndex / ArchiveView.pageSize) * ArchiveView.pageSize;
    this.rowLines.clear();
    if (this.items.length > ArchiveView.pageSize) {
      lines.push(canvasLine(`  ${tokens.faint(`items ${start + 1}–${Math.min(start + ArchiveView.pageSize, this.items.length)} of ${this.items.length}`)}`, width));
    }
    this.items.slice(start, start + ArchiveView.pageSize).forEach((item, offset) => {
      const index = start + offset;
      const rowStart = lines.length;
      const selected = index === this.selectedIndex;
      const marker = selected ? tokens.warn("▸") : tokens.faint("▸");
      // §5.4: a pin is named by the handle of the entry it marks, so an
      // archived item shows `P` and its own handle, and nothing else does.
      const pin =
        item.pinned === undefined
          ? ""
          : ` ${tokens.pin(`${pinHandle(handleOfRow(item))} ${item.pinned === "user" ? "you" : "agent"}`)}`;
      // Armed for deletion, said in words: a second press is a real loss, and a
      // key that does nothing visible the first time reads as broken.
      const armed = this.armed === item.id ? ` ${tokens.warn("d again: delete now")}` : "";
      // A mark is a decision waiting for a collapse, so the row says which one
      // and who made it: a mark nobody can see reads as nothing having happened.
      const mark =
        item.mark === undefined
          ? ""
          : ` ${tokens.pin(`→ ${item.mark.action} at the next collapse · ${item.mark.author === "user" ? "you" : "agent"}`)}`;
      const kind = item.record !== undefined ? item.record.kind : (item.ephemeral?.kind ?? "item");
      // A result of a `read` is not just text: restoring it is a claim about a
      // file, so the row says so rather than looking like any other result.
      const from = item.ephemeral?.kind === "readResult" ? readPathOf(item) : undefined;
      // The pending action must remain visible even when the kind or pin is long.
      const pending = item.restorePending === true ? ` ${tokens.warn("restore pending")}` : "";
      const head = `${marker}${mark} ${selected ? tokens.bold(tokens.text(kind)) : tokens.muted(kind)}${pin}${armed}${pending}`;
      lines.push(canvasLine(`  ${head}`, width));
      const summary = from === undefined ? summaryOf(item) : `read of ${from} — ${summaryOf(item)}`;
      const body = wrapTextWithAnsi(summary, Math.max(16, inner - 6)).slice(0, 3);
      body.forEach((line, lineIndex) => {
        const lead = lineIndex === 0 ? `${tokens.rule("│")} ` : "  ";
        lines.push(canvasLine(`    ${lead}${tokens.faint(line)}`, width));
      });
      lines.push(canvasLine("", width));
      for (let line = rowStart; line < lines.length; line++) this.rowLines.set(line, index);
    });
    const selected = this.selectedItem();
    if (this.detailOpen && selected !== undefined) {
      this.detailLine = lines.length;
      lines.push(canvasLine(`  ${tokens.bold(tokens.text("FULL ITEM"))} ${tokens.faint("· enter closes · scroll to read")}`, width));
      if (this.detailCache?.item !== selected || this.detailCache.width !== width) {
        // JSON preserves every record field and ephemeral payload, not just the summary.
        const value = selected.record?.value as { text?: string } | undefined;
        const text = value?.text ?? selected.ephemeral?.text ?? "";
        const content = `${text}\n\nStored item (all fields):\n${JSON.stringify(selected, null, 2)}`;
        const wrapped = content.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 4)));
        this.detailCache = { item: selected, width, lines: wrapped.map((line) => canvasLine(`  ${line}`, width)) };
      }
      for (const line of this.detailCache.lines) lines.push(line);
    }
    if (this.revealSelection) {
      this.revealSelection = false;
      const line = this.detailOpen ? this.detailLine : [...this.rowLines].find(([, index]) => index === this.selectedIndex)?.[0];
      if (line !== undefined) this.onReveal?.(line);
    }
    return lines;
  }
}

/** One line that says what the item is, without pretending to render it. */
function summaryOf(item: ArchivedItem): string {
  if (item.record !== undefined) {
    const value = item.record.value as { title?: string; text?: string };
    return truncateToWidth(value.title ?? value.text ?? item.record.kind, 100);
  }
  return truncateToWidth((item.ephemeral?.text ?? "").slice(0, 400).replace(/\s+/g, " "), 100);
}

/** The path a swept `read` result was for, when the store recorded one. */
function readPathOf(item: ArchivedItem): string | undefined {
  const data = item.ephemeral?.data;
  if (data === null || typeof data !== "object") return undefined;
  const path = (data as { path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
}
