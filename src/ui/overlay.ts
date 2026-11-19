import { Text, VStack, type Component } from "@earendil-works/pi-tui";

import { row } from "./chrome.js";
import { actionLines, helpLines, type FrameState } from "./frame.js";
import { token } from "./tokens.js";

/**
 * The reference an overlay shows: `?`, `a`, and the Chat edit detail.
 *
 * These used to be rows appended to the end of the body. That was wrong for the
 * reason the person gave: a reference is not part of the transcript, so it must
 * not be pushed around by the transcript's scroll position, and it must not be
 * reachable only by scrolling to the very bottom. Pi TUI draws overlays on top of
 * the screen and gives them focus, so a reference reads wherever the body is
 * scrolled to, and closing it returns the body to where it was.
 *
 * Two Pi TUI facts shape this file, both measured in `pi-tui` rather than
 * assumed:
 *
 * 1. **An overlay is not laid out, only composited.** `showOverlay` renders the
 *    component at a fixed width and clips its rows at `maxHeight` from the
 *    bottom. `ScrollView` does not clip itself; the layout engine slices it. A
 *    `ScrollView` inside an overlay would therefore render its whole document
 *    and the overlay would grow to that height, so a `ScrollView` is the wrong
 *    tool here and a manual window would be a scroll bar written by hand.
 * 2. **The clip takes the bottom, never the top.** That is why the summary row
 *    comes first: what the reference is, how many rows it did not show, and the
 *    key that closes it survive a short terminal.
 *
 * The words are not written here. `helpLines` and `actionLines` already own them
 * and are shared with `renderFrame`, the flat path the tests assert on, so the
 * overlay and the test cannot drift.
 */

/**
 * The chrome a reference must not cover: blank, title, rule, status, and the
 * token bar above it; the rule and the footer below it.
 *
 * The token bar is the case that matters. The person's rule is that the bar is
 * always visible, and a reference centred on the screen covers it. A reference
 * therefore opens in the body's own band, between the bar and the footer rule,
 * which is the only part of the screen it is allowed to own.
 */
export const CHROME_ABOVE = 5;
export const CHROME_BELOW = 2;

/** How many rows a reference may take from a terminal of `rows` rows. */
export function referenceMaxHeight(rows: number): number {
  const band = rows - CHROME_ABOVE - CHROME_BELOW;
  // No fewer than four rows, so a short terminal still shows the summary and a
  // little of the reference; the band wins when it is generous.
  return Math.max(4, band);
}

/**
 * The rows of a reference at `width`.
 *
 * The first row is the summary: what this is, how much of it is shown, and the
 * key that closes it. It is first rather than last because Pi TUI clips an
 * overlay at `maxHeight` from the **bottom** — the compositor slices the
 * component's rows — so the one row that must survive the clip is the top one.
 * That is also why nothing here slices: Pi's `maxHeight` does the clipping, and
 * a second window in this file would be a scroll bar written by hand.
 */
export function referenceRows(state: FrameState, width: number, maxHeight: number): string[] {
  const inner = Math.max(8, width - 4);
  const source =
    state.detail === "help" ? helpLines(state, inner) : state.detail === "actions" ? actionLines(state) : chatEditLines();
  const body = source.map((line) => row(line, "", inner));
  const hidden = body.length + 1 - maxHeight;
  const name = state.detail === "help" ? "Keys" : state.detail === "actions" ? "Commands" : "Chat edit";
  const tail = hidden > 0 ? ` · ${hidden} more row${hidden === 1 ? "" : "s"} below` : "";
  const close = state.detail === "chat" ? "Esc closes the edit" : "Esc closes";
  return [row(token.faint(`${name}${tail} · ${close}`), "", inner), ...body];
}

function chatEditLines(): string[] {
  return [
    token.warning("Chat edit selected. Press i to replace its text."),
    token.muted("d marks it for deletion at collapse; D removes it now."),
    token.muted("Esc closes the edit and keeps the Chat as it is."),
  ];
}

/**
 * A reference as a Pi TUI component.
 *
 * `VStack` with `basis: 1` on every row rather than one `Text`: a single `Text`
 * would re-wrap the reference at the terminal's width, and these rows are
 * already cut to fit. Each row is one row because the stack was told so, which
 * is the same reason the chrome rows declare a basis.
 *
 * The rows are not sliced to `maxHeight` here. The overlay compositor already
 * clips at the `maxHeight` passed to `showOverlay`, and the summary line is
 * first so the clip cannot take it.
 */
export class ReferenceOverlay implements Component {
  constructor(
    private readonly state: FrameState,
    private readonly maxHeight: number,
  ) {}

  render(width: number): string[] {
    return referenceRows(this.state, width, this.maxHeight);
  }

  invalidate(): void {}
}

/** The same rows in a stack, for a caller that wants a component tree. */
export function referenceStack(rows: readonly string[]): VStack {
  return new VStack(
    rows.map((line) => ({ component: new Text(line === "" ? " " : line, 0, 0), basis: 1, grow: 0, shrink: 0 })),
    { gap: 0 },
  );
}
