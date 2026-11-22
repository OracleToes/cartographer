/**
 * The sidebar: where you are in the workspace (§8), built like Posting's
 * collection pane.
 *
 * It occupies the full height on the left as one flat band, a step darker than
 * the working surface, with a single seam on its right. Not a gradient: a fade
 * made the pane read as a decoration and pulled the eye off its rows.
 *
 * The type scale does the work, in three steps:
 *
 * 1. the product mark, in the accent, once;
 * 2. two quiet group labels, upper-case and small;
 * 3. rows in body ink with their figures right-aligned in a fixed column, so a
 *    column of numbers can be read down rather than scanned along.
 *
 * The active row is a full-width tint with a two-cell accent spine; it is the
 * only coloured row in the pane. Marks (pin, mark, stale) sit with the figure,
 * because they are facts about the same thing the figure counts.
 */
import { truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

import { bandLine, padLine, tokens } from "./tokens.js";

export type BookKind = "chat" | "context" | "atlas" | "ledger" | "tree";
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
  /** The project tree: how many directories and files it shows at the anchor. */
  treeDirs: number;
  treeFiles: number;
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
  treeDirs: 0,
  treeFiles: 0,
  archive: 0,
  archivePinned: 0,
};

/**
 * 28 cells: wide enough for `transcript` and its figure together with room to
 * spare, because a pane that truncates its own row labels at 22 looks broken.
 */
export const sidebarWidth = 28;

/** The right-hand column the figures line up in. */
const FIGURE_GUTTER = 10;

interface Row {
  kind: BookKind;
  label: string;
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
    if (item === "chat" || item === "context" || item === "atlas" || item === "ledger" || item === "tree") this.activeItem = item;
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

  /** The figure a row shows: a count, or a compact token figure for the context itself. */
  private figure(kind: BookKind): string {
    if (kind === "chat") return String(this.counts.chat);
    if (kind === "context") {
      const tokens = this.counts.contextTokens;
      if (tokens <= 0) return "—";
      return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(Math.round(tokens));
    }
    if (kind === "tree") {
      // Two figures, because a tree is two things: the folders and the files.
      // Faint, because they are counts of what is there, not a size to judge.
      return `${this.counts.treeDirs}/${this.counts.treeFiles}`;
    }
    return String(kind === "atlas" ? this.counts.atlas : this.counts.ledger);
  }

  /** The quiet marks after a figure: pins, marks, stale. One glyph each, never a sentence. */
  private marksOf(kind: BookKind): string {
    const parts: string[] = [];
    // A count of pins, not one pin's name: the sidebar says how many there are,
    // and the block and the views name each one `P <handle>` (§5.4).
    if ((this.counts.pinned[kind] ?? 0) > 0) parts.push(tokens.pin("P"));
    if ((this.counts.marked[kind] ?? 0) > 0) parts.push(tokens.warn("◆"));
    if ((this.counts.stale[kind] ?? 0) > 0) parts.push(tokens.warn("!"));
    return parts.join(" ");
  }

  /** One row: spine, label, and the figure column. Always exactly `width` cells. */
  private row(kind: BookKind, label: string, active: boolean, width: number): string {
    const marks = this.marksOf(kind);
    const right = `${this.figure(kind)}${marks.length > 0 ? ` ${marks}` : ""}`;
    const spine = active ? tokens.accent("▌") : " ";
    const name = active ? tokens.bold(tokens.text(label)) : tokens.text(label);
    // Eight cells of figure column on the right, whatever the label's length;
    // a column of numbers is read down, so it has to line up.
    const room = Math.max(4, width - 2 - FIGURE_GUTTER);
    const head = truncateToWidth(`${spine}  ${name}`, room, "…");
    const rightInk = this.figureInk(active, right);
    const gap = Math.max(1, width - 1 - visibleWidth(head) - visibleWidth(rightInk));
    const line = padLine(`${head}${" ".repeat(gap)}${rightInk}`, width);
    return active ? tokens.selectedBg(line) : bandLine(line, width);
  }

  /** Figures are quiet; the marks after them are not, because they ask for a look. */
  private figureInk(active: boolean, right: string): string {
    const [figure = "", ...rest] = right.split(" ");
    const painted = active ? tokens.text(figure) : tokens.muted(figure);
    return rest.length > 0 ? `${painted} ${rest.join(" ")}` : painted;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    this.hitRows = new Map();
    this.hitIndex = new Map();
    this.renderedRows = [];
    const fill = (text: string): string => bandLine(text, width);
    const blank = (): void => {
      lines.push(fill(""));
    };
    const book = (kind: BookKind, label: string): void => {
      this.hitRows.set(lines.length, "book");
      this.hitIndex.set(lines.length, this.renderedRows.length);
      this.renderedRows.push({ kind });
      // On the archive layer no book is current: the layer covers the workspace,
      // so a lit book row would say you are somewhere you are not.
      lines.push(this.row(kind, label, this.layer === "context" && this.activeItem === kind, width));
    };

    // No second product mark: the header already says whose workspace this is,
    // and a second one a few cells below it is just noise in the same corner.
    blank();
    lines.push(fill(`   ${tokens.faint("WORKSPACE")}`));
    lines.push(fill(""));
    book("chat", "transcript");
    book("context", "context");

    blank();
    lines.push(fill(`   ${tokens.faint("BRAIN")}`));
    book("atlas", "atlas");
    book("ledger", "ledger");
    book("tree", "tree");

    if (this.counts.staleTotal > 0) {
      blank();
      lines.push(fill(`   ${tokens.warn(`${this.counts.staleTotal} stale`)}`));
    }

    // The layer sits at the foot of the pane, on the far side of a seam: it is
    // not a fourth book, it is the other half of the same workspace (§3.3).
    blank();
    lines.push(fill(`   ${tokens.faint("─".repeat(Math.max(0, width - 7)))}`));
    blank();

    const archiveActive = this.layer === "archive";
    const label = archiveActive ? "archive" : "context";
    const spine = archiveActive ? tokens.warn("▌") : " ";
    const name = archiveActive ? tokens.bold(tokens.warn(label)) : tokens.text(label);
    const figure = archiveActive ? String(this.counts.archive) : "—";
    const pinMark = archiveActive && this.counts.archivePinned > 0 ? ` ${tokens.pin("P")}` : "";
    const head = `${spine}  ${tokens.faint("layer")} ${name}`;
    const right = `${tokens.muted(figure)}${pinMark}`;
    const gap = Math.max(1, width - 1 - visibleWidth(head) - visibleWidth(right));
    const layerLine = archiveActive
      ? tokens.selectedBg(padLine(`${head}${" ".repeat(gap)}${right}`, width))
      : fill(`${head}${" ".repeat(gap)}${right}`);
    this.hitRows.set(lines.length, "layer");
    lines.push(layerLine);
    lines.push(fill(`     ${tokens.faint(archiveActive ? "^t back" : "^t swap")}`));

    return lines;
  }
}
