import { cell, fit, rule, width } from "./text.js";
import { token } from "./tokens.js";

/**
 * The input box: the one place the person types.
 *
 * It is a box, not a row, because a prompt that wraps needs somewhere to wrap
 * to. A one-row input either scrolls sideways or pushes the body up by a row
 * each time the text grows; a box declares its height, so the part that moves
 * while typing is the body above it, and the line under the cursor is always
 * the line the person just wrote.
 *
 * The rows are built from the editor's own rendered rows. The box does not
 * re-wrap the text and does not place the cursor: Pi TUI's `Editor` already
 * marked the cursor cell, and a second opinion here would move the hardware
 * cursor off the character it is about to change.
 */

export interface InputBoxInput {
  /** The editor's own rows, one per visual line. */
  lines: readonly string[];
  /** What Enter does, in the person's words: `send follow-up`, `edit Chat C2`. */
  title: string;
  /**
   * Extra words for the box's bottom edge. Normally empty: the footer under
   * the box already shows the keys the action table allows here, and printing
   * them twice would make one of the two copies a lie when they drift.
   */
  note?: string;
  /** The terminal width. The box draws its own gutter and pad, like the frame. */
  columns: number;
  /** The gutter cells between the terminal edge and the frame, from `margin()`. */
  gutter: number;
}

/**
 * The rows the box draws for an editor of `lines` rows. The runtime needs the
 * height before the layout runs, because a stack allocates space by height and
 * the text is only known after a render.
 */
export function inputBoxHeight(lines: number | readonly string[]): number {
  return Math.max(1, typeof lines === "number" ? lines : lines.length) + 2;
}

/** The box's height in rows: one frame row, the text, and one frame row. */
/** The cells a line of text gets: the frame, less gutter, pad, sides, and air. */
export function inputTextCells(columns: number, gutter: number): number {
  return Math.max(4, columns - gutter * 2 - 4 - 4);
}

export function inputBoxRows(input: InputBoxInput): string[] {
  const total = Math.max(12, input.columns);
  const edge = " ".repeat(Math.max(0, input.gutter));
  const strip = " ".repeat(2);
  // `inner` is the frame's own content width, the same one the rules above
  // and below the body use, so the box lines up with them exactly.
  const inner = Math.max(5, total - edge.length * 2 - strip.length * 2);
  const rows: string[] = [];
  const around = (row: string): string => `${edge}${strip}${row}${strip}${edge}`;
  // One cell of air between the frame and the text, on both sides, so a
  // prompt does not touch the box it is written in.
  const inside = Math.max(1, inner - 4);
  const air = " ";
  rows.push(around(topEdge(input.title, inner)));
  for (const line of input.lines) {
    // The editor's row is exactly the inside width; a cursor that overflows
    // into its own padding is trimmed, never wrapped.
    rows.push(around(`${token.rule("│")}${air}${cell(line, inside)}${air}${token.rule("│")}`));
  }
  if (input.lines.length === 0) rows.push(around(`${token.rule("│")}${air}${" ".repeat(inside)}${air}${token.rule("│")}`));
  rows.push(around(bottomEdge(input.note ?? "", inner)));
  return rows;
}

/**
 * `╭ send follow-up ──────────╮`. The title is cut, not the right corner: a
 * box without a corner does not read as a box.
 */
function topEdge(title: string, columns: number): string {
  const room = Math.max(0, columns - 6);
  const label = title === "" ? "" : ` ${fit(title, room)} `;
  const fill = Math.max(0, columns - width(label) - 2);
  return `${token.rule("╭")}${token.accent(label)}${token.rule(rule(fill))}${token.rule("╮")}`;
}

/**
 * `╰──────── Esc back · Enter send ╯`. The keys sit at the right end, where
 * the footer put them, so the box is read the same way as the screen it
 * replaced.
 */
function bottomEdge(note: string, columns: number): string {
  const inside = Math.max(0, columns - 2);
  if (note === "") return `${token.rule("╰")}${token.rule(rule(inside))}${token.rule("╯")}`;
  const label = token.muted(note);
  const room = Math.max(0, inside - 2);
  const shown = fit(label, room);
  const left = Math.max(0, inside - width(shown) - 2);
  return `${token.rule("╰")}${token.rule(rule(left))}${token.rule(" ")}${shown}${token.rule(" ")}${token.rule("╯")}`;
}

/**
 * The title for each reason the input opens. One table, so the box and the
 * tests name the same thing.
 */
export const INPUT_TITLE = {
  send: (mode: string): string => `send ${mode}`,
  editChat: (handle: string): string => `edit Chat ${handle}`,
  agentChat: (): string => "add Agent Chat",
  resume: (): string => "edit the paused draft",
} as const;
