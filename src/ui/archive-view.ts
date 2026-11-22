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
import { padLine, tokens } from "./tokens.js";

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
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
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
    lines.push(padLine(tokens.bold("The archive"), width));
    lines.push(
      padLine(
        tokens.muted("person only · p pin · r restore · d delete · esc back · a pinned item is never dropped"),
        width,
      ),
    );
    if (this.items.length === 0) {
      lines.push("");
      lines.push(padLine(tokens.muted("nothing archived"), width));
      return lines;
    }
    lines.push("");
    const visible = Math.max(1, this.items.length);
    for (let index = 0; index < visible; index += 1) {
      const item = this.items[index];
      if (item === undefined) continue;
      const marker = index === this.selectedIndex ? "› " : "  ";
      const pin = item.pinned === undefined ? "" : ` · pinned (${item.pinned === "user" ? "you" : "agent"})`;
      const kind = item.record !== undefined ? `record · ${item.record.kind}` : `ephemeral · ${item.ephemeral?.kind ?? "item"}`;
      lines.push(padLine(`${marker}${kind}${pin}`, width));
      lines.push(padLine(tokens.muted(`    ${summaryOf(item)}`), width));
      lines.push("");
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
  return truncateToWidth(wrapTextWithAnsi(item.ephemeral?.text ?? "", 100).join(" "), 100);
}
