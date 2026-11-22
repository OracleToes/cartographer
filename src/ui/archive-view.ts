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
import { canvasLine, padLine, tokens, visibleWidth } from "./tokens.js";

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
  /**
   * Which item is armed for deletion. `d` takes two presses, the way deleting
   * does everywhere else here: an archived item is one the person already lost
   * once, and the second press is what makes the loss deliberate.
   */
  private armed: string | undefined;
  private scrollOffset = 0;

  /**
   * The item under the cursor, so a palette entry can do what the key does.
   * The archive is a layer over the same UI (§3.3), and the palette is part of
   * that UI: a command that only worked from a keypress would be half a layer.
   */
  selectedItem(): ArchivedItem | undefined {
    return this.items[this.selectedIndex];
  }

  /**
   * The one `d`: the first press arms the item under the cursor, the second
   * deletes it. Says which happened, so the caller can tell the person.
   */
  deleteSelected(): "armed" | "deleted" | "none" {
    const item = this.selectedItem();
    if (item === undefined) return "none";
    if (this.armed === item.id) {
      this.armed = undefined;
      this.onDelete?.(item.id);
      return "deleted";
    }
    this.armed = item.id;
    return "armed";
  }

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
      this.armed = undefined;
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
      this.scrollOffset = 0;
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.armed = undefined;
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.scrollOffset = 0;
      return;
    }
    if (matchesKey(data, "g")) {
      this.armed = undefined;
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      return;
    }
    if (data === "G") {
      this.armed = undefined;
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
      // The registry owns `d` while this layer is up, so this is the path only
      // for a view driven on its own (a test, a preview); it calls the same
      // rule, so no route deletes in one press.
      if (this.armed === selected.id) {
        this.armed = undefined;
        this.onDelete?.(selected.id);
      } else {
        this.armed = selected.id;
      }
      return;
    }
    // Any other key withdraws the arm: a person who moved on did not mean it.
    this.armed = undefined;
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
    lines.push(canvasLine("", width));
    if (this.items.length === 0) {
      lines.push(canvasLine(`  ${tokens.muted("Nothing is archived.")}`, width));
      lines.push(canvasLine(`  ${tokens.faint("A collapse sweeps what the Brain let go of; it waits one collapse, then it is gone.")}`, width));
      return lines;
    }
    lines.push(canvasLine(`  ${tokens.faint("swept by a collapse · waits one collapse · a pin keeps it")}`, width));
    lines.push(canvasLine("", width));
    this.items.forEach((item, index) => {
      const selected = index === this.selectedIndex;
      const marker = selected ? tokens.warn("▸") : tokens.faint("▸");
      const pin = item.pinned === undefined ? "" : ` ${tokens.pin(`⊙ ${item.pinned === "user" ? "you" : "agent"}`)}`;
      // Armed for deletion, said in words: a second press is a real loss, and a
      // key that does nothing visible the first time reads as broken.
      const armed = this.armed === item.id ? ` ${tokens.warn("d again: delete for good")}` : "";
      const kind = item.record !== undefined ? item.record.kind : (item.ephemeral?.kind ?? "item");
      // A result of a `read` is not just text: restoring it is a claim about a
      // file, so the row says so rather than looking like any other result.
      const from = item.ephemeral?.kind === "readResult" ? readPathOf(item) : undefined;
      const head = `${marker} ${selected ? tokens.bold(tokens.text(kind)) : tokens.muted(kind)}${pin}${armed}`;
      lines.push(canvasLine(`  ${head}`, width));
      const summary = from === undefined ? summaryOf(item) : `read of ${from} — ${summaryOf(item)}`;
      const body = wrapTextWithAnsi(summary, Math.max(16, inner - 6)).slice(0, 3);
      body.forEach((line, lineIndex) => {
        const lead = lineIndex === 0 ? `${tokens.rule("│")} ` : "  ";
        lines.push(canvasLine(`    ${lead}${tokens.faint(line)}`, width));
      });
      lines.push(canvasLine("", width));
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

/** The path a swept `read` result was for, when the store recorded one. */
function readPathOf(item: ArchivedItem): string | undefined {
  const data = item.ephemeral?.data;
  if (data === null || typeof data !== "object") return undefined;
  const path = (data as { path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
}
