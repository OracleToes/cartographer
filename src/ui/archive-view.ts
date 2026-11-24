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

  private archive: Archive | undefined;
  private items: ArchivedItem[] = [];
  private selectedIndex = 0;
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
      this.onApplyNow?.(item.id, "delete");
      return "applied";
    }
    this.armed = item.id;
    this.onDelete?.(item.id);
    return "marked";
  }

  /** The one `u`: withdraw the mark, leaving the item where it is. */
  withdrawSelected(): boolean {
    const item = this.selectedItem();
    if (item === undefined || item.mark === undefined) return false;
    this.onWithdrawMark?.(item.id);
    return true;
  }

  /** The one `r`: mark the item for restore, or apply that mark now when `!` is armed. */
  restoreSelected(): "marked" | "applied" | "none" {
    const item = this.selectedItem();
    if (item === undefined) return "none";
    if (this.nowArmed) {
      this.nowArmed = false;
      this.onApplyNow?.(item.id, "restore");
      return "applied";
    }
    this.onRestore?.(item.id);
    return "marked";
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
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.armed = undefined;
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, "g")) {
      this.armed = undefined;
      this.selectedIndex = 0;
      return;
    }
    if (data === "G") {
      this.armed = undefined;
      this.selectedIndex = Math.max(0, this.items.length - 1);
      return;
    }
    if (selected === undefined) return;
    if (matchesKey(data, "p")) {
      this.onTogglePin?.(selected.id);
      return;
    }
    if (matchesKey(data, "r")) {
      // Restore is a mark by default (§4.1): it leaves the item in the archive
      // and the next collapse returns it. With `!` armed it applies now.
      this.restoreSelected();
      return;
    }
    if (matchesKey(data, "d")) {
      // Delete is a mark too, and the dangerous one, so it takes two presses:
      // the first marks, the second applies the mark now. A collapse applies a
      // single-press mark all the same (§4.1).
      if (this.armed === selected.id) {
        this.armed = undefined;
        this.onApplyNow?.(selected.id, "delete");
      } else {
        this.armed = selected.id;
        this.onDelete?.(selected.id);
      }
      return;
    }
    if (matchesKey(data, "u")) {
      this.onWithdrawMark?.(selected.id);
      this.armed = undefined;
      return;
    }
    if (data === "!") {
      this.nowArmed = !this.nowArmed;
      return;
    }
    // Any other key withdraws the arm: a person who moved on did not mean it.
    this.armed = undefined;
    this.nowArmed = false;
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
    if (this.nowArmed) lines.push(canvasLine(`  ${tokens.warn("! armed: the next mark is applied now, not at the next collapse")}`, width));
    lines.push(canvasLine("", width));
    this.items.forEach((item, index) => {
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
      const head = `${marker}${mark} ${selected ? tokens.bold(tokens.text(kind)) : tokens.muted(kind)}${pin}${armed}`;
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
