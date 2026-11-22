/**
 * The sidebar: the workspace index (§8), built like Posting's collection pane.
 *
 * It runs the full height on the left, carries a gradient that fades toward the
 * page so the working area reads as the surface in front, groups its rows under
 * quiet headings, and puts a count on the right of each row. The active row is
 * tinted and gets a one-cell spine; nothing else in the pane is coloured.
 *
 * Two groups, because the product has two: the **workspace** (the transcript and
 * the prompt itself) and the **brain** (the Atlas and the Ledger). The archive is
 * not a third group: it is a layer under the same UI (§3.3), so its toggle sits
 * at the bottom, apart from the books, and says which layer is showing.
 */
import { visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

import { padLine, sidebarRow, tokens } from "./tokens.js";

export type BookKind = "chat" | "context" | "atlas" | "ledger";
export type SidebarLayer = "context" | "archive";

export interface SidebarCounts {
  chat: number;
  contextTokens: number;
  atlas: number;
  ledger: number;
  /** Entries carrying a pin, by book. */
  pinned: Partial<Record<BookKind, number>>;
  /** Entries carrying a mark, by book. */
  marked: Partial<Record<BookKind, number>>;
  /** Stale attachments, by book. */
  stale: Partial<Record<BookKind, number>>;
  staleTotal: number;
  /** Things in the archive, and how many of them are pinned. */
  archive: number;
  archivePinned: number;
}

const EMPTY: SidebarCounts = {
  chat: 0,
  contextTokens: 0,
  atlas: 0,
  ledger: 0,
  pinned: {},
  marked: {},
  stale: {},
  staleTotal: 0,
  archive: 0,
  archivePinned: 0,
};

export const sidebarWidth = 24;

interface Row {
  kind: BookKind;
  label: string;
  figure: string;
  marks: string;
}

export class Sidebar implements Component {
  private counts: SidebarCounts = EMPTY;
  private activeItem: BookKind = "chat";
  private layer: SidebarLayer = "context";
  /** Where each clickable line landed on the last render, so a click never has to guess. */
  private hitRows = new Map<number, "book" | "layer">();
  private hitIndex = new Map<number, number>();
  private renderedRows: Array<{ kind: BookKind } | { layer: SidebarLayer }> = [];
  onSelect?: (book: BookKind) => void;
  onToggleLayer?: (layer: SidebarLayer) => void;

  setCounts(counts: SidebarCounts): void {
    this.counts = { ...counts, pinned: { ...counts.pinned }, marked: { ...counts.marked }, stale: { ...counts.stale } };
  }

  setActiveBook(item: string): void {
    if (item === "chat" || item === "context" || item === "atlas" || item === "ledger") this.activeItem = item;
  }

  setLayer(layer: SidebarLayer): void {
    this.layer = layer;
  }

  invalidate(): void {
    // Stateless.
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click") return undefined;
    const which = this.hitRows.get(event.y);
    if (which === undefined) return undefined;
    if (which === "layer") {
      this.onToggleLayer?.(this.layer === "archive" ? "context" : "archive");
      return { handled: true, render: true };
    }
    const row = this.renderedRows[this.hitIndex.get(event.y) ?? -1];
    if (row !== undefined && "kind" in row) {
      this.onSelect?.(row.kind);
      return { handled: true, render: true };
    }
    return undefined;
  }

  /** The figure a row shows: a count, or a compact token figure for the prompt itself. */
  private figure(kind: BookKind): string {
    if (kind === "chat") return String(this.counts.chat);
    if (kind === "context") {
      const tokens = this.counts.contextTokens;
      if (tokens <= 0) return "0";
      return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(Math.round(tokens));
    }
    return String(kind === "atlas" ? this.counts.atlas : this.counts.ledger);
  }

  /** The quiet marks after a figure: pins, marks, stale. One glyph each, never a sentence. */
  private marks(kind: BookKind): string {
    const pinned = this.counts.pinned[kind] ?? 0;
    const marked = this.counts.marked[kind] ?? 0;
    const stale = this.counts.stale[kind] ?? 0;
    const parts: string[] = [];
    if (pinned > 0) parts.push(tokens.pin("⊙"));
    if (marked > 0) parts.push(tokens.warn("◆"));
    if (stale > 0) parts.push(tokens.warn("!"));
    return parts.join(" ");
  }

  render(width: number): string[] {
    const rows: Row[] = [
      { kind: "chat", label: "transcript", figure: this.figure("chat"), marks: this.marks("chat") },
      { kind: "context", label: "prompt", figure: this.figure("context"), marks: this.marks("context") },
      { kind: "atlas", label: "atlas", figure: this.figure("atlas"), marks: this.marks("atlas") },
      { kind: "ledger", label: "ledger", figure: this.figure("ledger"), marks: this.marks("ledger") },
    ];
    const lines: string[] = [];
    const total = 18; // one gradient across the whole pane, not per group
    let index = 0;
    const blank = () => {
      lines.push(sidebarRow(index++, total)(" ".repeat(width)));
    };
    const heading = (text: string) => {
      lines.push(sidebarRow(index++, total)(padLine(` ${tokens.faint(tokens.bold(text))}`, width)));
    };

    blank();
    lines.push(
      sidebarRow(index++, total)(
        padLine(` ${tokens.bold(tokens.accent("carto"))}${tokens.faint("  workspace")}`, width),
      ),
    );
    blank();
    heading("WORKSPACE");
    const rowFor = (row: Row) => {
      const active = this.activeItem === row.kind;
      const spine = active ? tokens.accent("▌") : " ";
      const label = active ? tokens.bold(tokens.text(row.label)) : tokens.muted(row.label);
      const figure = active ? tokens.text(row.figure) : tokens.faint(row.figure);
      const marks = row.marks.length > 0 ? ` ${row.marks}` : "";
      const right = `${figure}${marks}`;
      const leftPart = `${spine} ${label}`;
      const gap = Math.max(1, width - 1 - visibleWidth(leftPart) - visibleWidth(right));
      const line = ` ${leftPart}${" ".repeat(gap)}${right}`;
      const painted = active ? tokens.selectedBg(padLine(line, width)) : sidebarRow(index, total)(padLine(line, width));
      index += 1;
      return painted;
    };
    this.renderedRows = [];
    const bookRows = rows.slice(0, 2);
    for (const row of bookRows) {
      this.hitRows.set(lines.length, "book");
      this.hitIndex.set(lines.length, this.renderedRows.length);
      this.renderedRows.push({ kind: row.kind });
      lines.push(rowFor(row));
    }
    blank();
    heading("BRAIN");
    for (const row of rows.slice(2)) {
      this.hitRows.set(lines.length, "book");
      this.hitIndex.set(lines.length, this.renderedRows.length);
      this.renderedRows.push({ kind: row.kind });
      lines.push(rowFor(row));
    }

    if (this.counts.staleTotal > 0) {
      blank();
      lines.push(sidebarRow(index++, total)(padLine(` ${tokens.warn(`! ${this.counts.staleTotal} stale`)}`, width)));
    }

    blank();
    blank();
    heading("LAYER");
    const archiveActive = this.layer === "archive";
    const layerLabel = archiveActive ? tokens.bold(tokens.warn("archive")) : tokens.muted("context");
    const pinMarks = this.counts.archivePinned > 0 ? ` ${tokens.pin("⊙")}` : "";
    const layerRight = archiveActive ? `${tokens.warn(String(this.counts.archive))}${pinMarks}` : "";
    const layerLeft = `${archiveActive ? tokens.warn("▌") : " "} ${layerLabel}`;
    const layerGap = Math.max(1, width - 1 - visibleWidth(layerLeft) - visibleWidth(layerRight));
    const layerLine = ` ${layerLeft}${" ".repeat(layerGap)}${layerRight}`;
    this.hitRows.set(lines.length, "layer");
    lines.push(sidebarRow(index++, total)(padLine(layerLine, width)));
    lines.push(sidebarRow(index++, total)(padLine(`   ${tokens.faint("^t swaps")}`, width)));

    // The pane fills its height: the gradient keeps running past the last row.
    return lines;
  }
}
