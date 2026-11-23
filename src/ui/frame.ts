/**
 * The frame around the workspace (§8).
 *
 * The screen is built from surfaces, darkest outermost: the **chrome** (the
 * margin, the header row, the key bar and the context bar) sits on the page's
 * deepest tone; the **panes** — the working area and the sidebar — are raised
 * out of it, each on its own step; the prompt and a selected row are raised
 * again. A person reads the hierarchy from the steps before reading a word.
 *
 * pi-tui paints only the cells a component renders, and every row is erased
 * to the terminal's own background first, so a pane that is shorter than the
 * room it was given shows the terminal through the gap. `Fill` is the one
 * answer to that: a component that renders solid colour, as tall as the screen
 * and clipped by the layout to the room it has. It is a margin when given a
 * fixed size, and a pane's floor when given `grow`.
 */
import type { Component } from "@earendil-works/pi-tui";

import { fillLine } from "./tokens.js";

/** What a stack entry's `visible` is handed. */
export interface Viewport {
  width: number;
  height: number;
}

export class Fill implements Component {
  private key = "";
  private lines: string[] = [];

  constructor(
    private readonly hex: string,
    private readonly rows: () => number,
  ) {}

  invalidate(): void {
    this.key = "";
  }

  render(width: number): string[] {
    const rows = Math.max(1, this.rows());
    const key = `${width}x${rows}`;
    if (key !== this.key) {
      this.lines = Array.from({ length: rows }, () => fillLine("", width, this.hex));
      this.key = key;
    }
    return this.lines;
  }
}

/**
 * The outer margin by terminal size: two cells either side when the screen is
 * wide enough to spare them, one when it is not, none on a very small one.
 * One row above and below, and a breathing row between the bands, only when
 * there are rows to spare — a short terminal needs its lines for the work.
 */
export const margin = {
  wide: (viewport: Viewport): boolean => viewport.width >= 100,
  narrow: (viewport: Viewport): boolean => viewport.width >= 60 && viewport.width < 100,
  edge: (viewport: Viewport): boolean => viewport.height >= 20,
  gap: (viewport: Viewport): boolean => viewport.height >= 26,
};
