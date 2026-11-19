import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Cell-exact text helpers for the screen.
 *
 * Width, cutting and padding come from Pi TUI, so a styled string is measured
 * by its visible cells and a cut never lands inside an escape sequence. This
 * file adds only the vocabulary the frame speaks: short counts, clocks,
 * durations, and one- and two-part rows.
 */

/** The visible width of a string in terminal cells. */
export const width = visibleWidth;

/**
 * How many cells the frame keeps between its own content and the terminal
 * edge. A terminal can draw its own border or sit inside a window frame, and
 * content in column 1 scrapes it. One cell is enough to separate them; below
 * 40 columns the content needs the cells more than the edge does.
 */
export function margin(columns: number): number {
  return columns >= 40 ? 1 : 0;
}

/** Fill to `cells` cells, cutting with `…` first if the text is too long. */
export function fit(text: string, cells: number, ellipsis = "…"): string {
  if (cells <= 0) return "";
  return truncateToWidth(text, cells, ellipsis, false);
}

/** Fill to exactly `cells` cells, cutting or padding as needed. */
export function cell(text: string, cells: number, ellipsis = "…"): string {
  if (cells <= 0) return "";
  return truncateToWidth(text, cells, ellipsis, true);
}

/** The cells `[start, start + count)` of a styled string. */
export function slice(text: string, start: number, count: number): string {
  if (count <= 0) return "";
  return sliceByColumn(text, start, count);
}

/**
 * A count of tokens as the person reads it: `950`, `9.4k`, `33k`. The point is
 * comparing magnitudes, not exact tokens, so below 10 000 we keep one decimal
 * and from 10 000 we drop decimals entirely.
 */
export function short(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "?";
  const whole = Math.floor(value);
  if (whole < 1_000) return String(whole);
  if (whole < 10_000) return `${(whole / 1_000).toFixed(1)}k`;
  return `${Math.round(whole / 1_000)}k`;
}

/** `09:41` in local time. The durable ISO stamp stays in agent context. */
export function clock(stamp: number): string {
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** `14:03:22` for a status line that must be exact. */
export function clockSeconds(stamp: number): string {
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return `${clock(stamp)}:${String(date.getSeconds()).padStart(2, "0")}`;
}

/** A pause as a person says it: `800ms`, `1.2s`, `2m 3s`, `1h 2m`. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  // Round, then format, so 1 250 ms reads as `1.3s` and never as `1.2s`.
  if (seconds < 10) return `${(Math.round(ms) / 1_000).toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `1.4k tok/s`, or `?` while two reports are too close together. */
export function rate(tokens: number, ms: number): string {
  if (!Number.isFinite(tokens) || !Number.isFinite(ms) || ms <= 0 || tokens <= 0) return "?";
  return `${short(Math.round((tokens * 1_000) / ms))} tok/s`;
}

/** Replace every run of whitespace with one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Pad text on the right to a cell width. */
export function padEnd(text: string, cells: number): string {
  return cell(text, cells);
}

/**
 * Lay a left part and a right part in one `cells`-wide row. The right part
 * keeps its space; the left part is cut with `…` when the two would touch.
 *
 * The gap is padded with spaces, and Pi TUI's wrap breaks a line at a run of
 * spaces, so an unbroken run would wrap onto a second line and push every row
 * below it down by one. A reset-and-restore pair around the space run stops the
 * wrap from seeing one run: the row stays one logical line and the frame keeps
 * the height it reported. The pair writes no visible character and costs no
 * cell, so the row is still exactly `cells` wide.
 */
export function split(left: string, right: string, cells: number, gap = 2): string {
  if (cells <= 0) return "";
  const safeRight = fit(right, Math.max(0, cells - gap));
  const rightWidth = width(safeRight);
  if (rightWidth === 0) return cell(left, cells);
  const leftRoom = Math.max(0, cells - rightWidth - gap);
  const safeLeft = fit(left, leftRoom);
  const fill = cells - width(safeLeft) - rightWidth;
  if (fill <= 0) return `${safeLeft}${safeRight}`;
  // See the note above: a reset pair around the fill keeps the wrap from
  // treating it as one long break point. `\x1b[39m` resets only the colour.
  return `${safeLeft}\x1b[39m${" ".repeat(fill)}\x1b[39m${safeRight}`;
}

/**
 * The same row, for a caller that composed `styledLeft` with a style that must
 * survive the gap (a cyan handle that runs to the end of the row). The fill is
 * kept inside the left style and the right part restores it afterwards.
 */
export function splitStyled(styledLeft: string, style: (text: string) => string, right: string, cells: number, gap = 2): string {
  if (cells <= 0) return "";
  const safeRight = fit(right, Math.max(0, cells - gap));
  const rightWidth = width(safeRight);
  if (rightWidth === 0) return cell(styledLeft, cells);
  const leftRoom = Math.max(0, cells - rightWidth - gap);
  const safeLeft = fit(styledLeft, leftRoom);
  const fill = cells - width(safeLeft) - rightWidth;
  if (fill <= 0) return `${safeLeft}${safeRight}`;
  return `${safeLeft}\x1b[39m${style(" ".repeat(fill))}\x1b[39m${safeRight}`;
}

/** A horizontal rule of `cells` cells. */
export function rule(cells: number, glyph = "─"): string {
  return glyph.repeat(Math.max(0, Math.floor(cells)));
}
