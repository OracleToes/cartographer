/**
 * The archive view (§3.3, §4.1).
 *
 * The archive is the person's, not the agent's: nothing here renders in the
 * context, nothing here has a handle the agent can name, and no tool reaches
 * this view. A person opens it from the palette, sees what a collapse swept,
 * and pins, unpins, restores, or marks an item for delete.
 *
 * Grace is shown as it stands — an item swept at a collapse is deleted for good
 * at the collapse after the next one — so the person can see what is about to
 * be gone and pin it before it is.
 */
import {
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import type { Archive, ArchivedItem } from "../domain/archive.js";
import { padLine, tokens, visibleWidth } from "./tokens.js";

export class ArchiveView implements Component, Focusable {
  focused = false;
  /** Fired on `p`: place or remove the pin. A pin suspends grace. */
  onTogglePin?: (id: string) => void;
  /** Fired on `r`: restore the item out of the archive. */
  onRestore?: (id: string) => void;
  /** Fired on `d`: mark the item for delete at the next collapse. */
  onDelete?: (id: string) => void;
  onBack?: () => void;

  private archive: Archive | undefined;
  private items: ArchivedItem[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;

  setData(archive: Archive): void {
    this.archive = archive;
    // Newest first: what a collapse just took is what the person is looking for.
    this.items = [...archive.items].sort((left, right) => right.sweptAt - left.sweptAt);
    if (this.selectedIndex >= this.items.length) this.selectedIndex = Math.max(0, this.items.length - 1);
  }

  invalidate(): void {
    // Stateless; reads the archive it was handed.
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+t") || matchesKey(data, "q")) {
      this.onBack?.();
      return;
    }
    const selected = this.items[this.selectedIndex];
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
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
      this.selectedIndex = Math.max(0, this.items.length - 1);
      this.scrollOffset = 0;
      return;
    }
    if (selected === undefined) return;
    if (matchesKey(data, "p")) {
      this.onTogglePin?.(selected.id);
      return;
    }
    if (matchesKey(data, "r")) {
      this.onRestore?.(selected.id);
      return;
    }
    if (matchesKey(data, "d")) {
      this.onDelete?.(selected.id);
      return;
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const inner = Math.max(20, width - 2);
    // A layer wears the same header as the working area it covers, so the person
    // always knows which layer they are looking at.
    const left = `${tokens.bold(tokens.warn("ARCHIVE"))} ${tokens.faint("· the person's, never the agent's")}`;
    const right = tokens.faint(`${this.items.length} item${this.items.length === 1 ? "" : "s"} `);
    const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
    lines.push(tokens.panel(padLine(` ${left}${" ".repeat(gap)}${right}`, width)));
    lines.push("");
    if (this.items.length === 0) {
      lines.push(`  ${tokens.muted("Nothing is archived.")}`);
      lines.push(`  ${tokens.faint("A collapse sweeps what the Brain let go of; it waits one collapse, then it is gone.")}`);
      return lines;
    }
    lines.push(`  ${tokens.faint("swept by a collapse · waits one collapse · a pin keeps it")}`);
    lines.push("");
    this.items.forEach((item, index) => {
      const selected = index === this.selectedIndex;
      const marker = selected ? tokens.warn("▸") : tokens.faint("▸");
      const pin = item.pinned === undefined ? "" : ` ${tokens.pin(`⊙ ${item.pinned === "user" ? "you" : "agent"}`)}`;
      const kind = item.record !== undefined ? item.record.kind : (item.ephemeral?.kind ?? "item");
      const head = `${marker} ${selected ? tokens.bold(tokens.text(kind)) : tokens.muted(kind)}${pin}`;
      lines.push(padLine(`  ${head}`, width));
      const summary = summaryOf(item);
      const body = wrapTextWithAnsi(summary, Math.max(16, inner - 6)).slice(0, 3);
      body.forEach((line, lineIndex) => {
        const lead = lineIndex === 0 ? `${tokens.rule("│")} ` : "  ";
        lines.push(padLine(`    ${lead}${tokens.faint(line)}`, width));
      });
      lines.push("");
    });
    return lines;
  }
}

/** One line that says what the item is, without pretending to render it. */
function summaryOf(item: ArchivedItem): string {
  if (item.record !== undefined) {
    const value = item.record.value as { title?: string; text?: string };
    return truncateToWidth(value.title ?? value.text ?? item.record.kind, 100);
  }
  return truncateToWidth(wrapTextWithAnsi(item.ephemeral?.text ?? "", 100).join(" "), 100);
}
