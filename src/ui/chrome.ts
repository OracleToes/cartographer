import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { token } from "./tokens.js";
import { rule } from "./text.js";

/**
 * The chrome rows, as components.
 *
 * Pi TUI lays out a `VStack` by measuring each child's rendered height, so a
 * row must render exactly one line. Two Pi TUI facts shape this file:
 *
 * 1. `new Text("")` renders **zero** lines. A chrome row built that way
 *    measures as height 0, and `grow: 1` on the body then takes the whole
 *    viewport: the header scrolls off with the transcript and never comes
 *    back. Every row here renders one line, empty or not.
 * 2. `Text` wraps with `wrapTextWithAnsi`, which breaks at any run of spaces.
 *    A right-aligned row padded with spaces therefore wraps to two lines and
 *    pushes every row below it down. The rows here assemble a line that is
 *    already exactly `width` cells, so there is no fill run for the wrapper to
 *    break.
 *
 * Everything a person *reads* is Pi TUI text. This file only decides where the
 * left and right parts of a row sit.
 */

/** One line, exactly `width` cells, cut with `…` if the text is too long. */
export function row(left: string, right: string, width: number, gap = 2): string {
  if (width <= 0) return "";
  if (right === "") return padLine(left, width);
  const rightCells = visibleWidth(right);
  if (rightCells >= width) return truncateToWidth(right, width, "…", true);
  const room = width - rightCells - gap;
  if (room <= 0) return `${" ".repeat(width - rightCells)}${right}`;
  const leftText = visibleWidth(left) > room ? truncateToWidth(left, room, "…", false) : left;
  const fill = width - visibleWidth(leftText) - rightCells;
  return `${leftText}${" ".repeat(fill)}${right}`;
}

/** A line padded to `width`, cut if it is longer. */
export function padLine(text: string, width: number): string {
  if (width <= 0) return "";
  const cells = visibleWidth(text);
  if (cells === width) return text;
  if (cells > width) return truncateToWidth(text, width, "…", true);
  return `${text}${" ".repeat(width - cells)}`;
}

/** The base for every fixed row: exactly one line, always. */
abstract class OneRow implements Component {
  abstract render(width: number): string[];
  /** One line means one row; nothing is cached. */
  invalidate(): void {}
}

/** A blank row that still measures as one row. */
export class BlankRow extends OneRow {
  render(): string[] {
    return [""];
  }
}

/** The title: product and project on the left, model on the right. */
export class TitleRow extends OneRow {
  left = "";
  right = "";

  render(width: number): string[] {
    return [padLine(row(this.left, this.right, width), width)];
  }
}

/** A rule, inset by `pad` cells on each side. */
export class RuleRow extends OneRow {
  constructor(private readonly pad = 2) {
    super();
  }

  render(width: number): string[] {
    const cells = Math.max(0, width - this.pad * 2);
    return [`${" ".repeat(this.pad)}${token.rule(rule(cells))}${" ".repeat(this.pad)}`];
  }
}

/** A left part and a right part on one row: status, footer, and notices. */
export class SplitRow extends OneRow {
  left = "";
  right = "";

  render(width: number): string[] {
    return [padLine(row(this.left, this.right, width), width)];
  }
}

/**
 * One line of text that may be empty. `Text` is used rather than a custom
 * component so a row keeps Pi TUI's own wrapping and truncation for the
 * content it displays; the caller passes text that already fits.
 */
export function textRow(text: string, paddingX = 0): Text {
  // A space, not "", because an empty `Text` renders no rows at all.
  return new Text(text === "" ? " " : text, paddingX, 0);
}
