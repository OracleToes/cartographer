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
import {
  HStack,
  ScrollView,
  VStack,
  type Component,
  type ScrollViewOptions,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { fillLine, scrollbarStyles } from "./tokens.js";

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
  none: (viewport: Viewport): boolean => viewport.width < 60,
  edge: (viewport: Viewport): boolean => viewport.height >= 20,
  gap: (viewport: Viewport): boolean => viewport.height >= 26,
};

/**
 * Stacks that cost nothing to measure.
 *
 * pi-tui's layout measures every entry of an `HStack` by calling its `render`,
 * and a stack's own `render` is the flattened, un-laid-out path: it renders and
 * composites every child row by row. Nested around a long transcript that is
 * the whole transcript composited again at every level, on every frame, and a
 * frame is requested for every chunk the model streams — about fifty times
 * slower than the layout itself, so the context bar lagged behind the stream.
 *
 * A layout that gives its stacks a definite height (every stack here sits in a
 * parent that does) never reads that measurement: children are stretched. So
 * these measure as nothing, and the layout pass is the only render.
 */
export class Row extends HStack {
  override render(): string[] {
    return [];
  }
}

export class Column extends VStack {
  override render(): string[] {
    return [];
  }
}

/**
 * A pane with its margin and its floor in one box.
 *
 * Every box in a row is composited onto the row after the ones before it, and
 * compositing re-reads the whole row each time; it was most of a frame. The
 * sidebar's left margin, its panel below the list, and the seam to its right are
 * all drawn by the one line this builds, so they cost nothing extra. It passes
 * the mouse on, shifted by the margin, so a click lands on the row it meant.
 */
export class Inset implements Component {
  private readonly leftCells: string;
  private readonly rightCells: string;

  constructor(
    private readonly child: Component & { handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined },
    private readonly left: number,
    private readonly right: number,
    private readonly floorHex: string,
    edgeHex: string,
    private readonly rows: () => number,
  ) {
    this.leftCells = left === 0 ? "" : fillLine("", left, edgeHex);
    this.rightCells = right === 0 ? "" : fillLine("", right, edgeHex);
  }

  invalidate(): void {
    this.child.invalidate?.();
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - this.left - this.right);
    const lines = this.child.render(inner);
    const floor = fillLine("", inner, this.floorHex);
    const out: string[] = [];
    for (let row = 0; row < Math.max(lines.length, this.rows()); row += 1) out.push(`${this.leftCells}${lines[row] ?? floor}${this.rightCells}`);
    return out;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const x = event.x - this.left;
    if (x < 0 || x >= event.width - this.left - this.right) return undefined;
    return this.child.handleMouse?.({ ...event, x, width: event.width - this.left - this.right });
  }
}

export interface PaneScrollViewOptions
  extends Omit<ScrollViewOptions, "scrollbar" | "scrollbarTrackStyle" | "scrollbarThumbStyle"> {
  /** Surface background hex behind the scrollbar gutter; defaults to the working canvas. */
  backgroundHex?: string;
}

/**
 * A `ScrollView` with a permanent, Carto-themed dynamic-size scrollbar gutter.
 *
 * Delegates geometry, proportional thumb sizing, painting, hover highlight,
 * track click-to-jump, thumb dragging, and selection clipping to pi-tui's
 * `ScrollView`. Reserves the rightmost column (`scrollbar: "always"`) so text
 * never overlaps or reflows when content crosses the viewport height; paints
 * the pane's own background in that column while everything fits, and shows the
 * proportional track and thumb whenever the pane can scroll.
 */
export class PaneScrollView extends ScrollView {
  private readonly scrollState: { scrollable: boolean };

  constructor(component: Component, options: PaneScrollViewOptions = {}) {
    const { backgroundHex, ...rest } = options;
    const styles = scrollbarStyles(backgroundHex);
    const scrollState = { scrollable: false };
    super(component, {
      ...rest,
      scrollbar: "always",
      scrollbarTrackStyle: (glyph) => (scrollState.scrollable ? styles.track(glyph) : styles.blank()),
      scrollbarThumbStyle: (glyph) => {
        if (!scrollState.scrollable) return styles.blank();
        return glyph === "█" ? styles.activeThumb(glyph) : styles.thumb(glyph);
      },
    });
    this.scrollState = scrollState;
  }

  /** Whether the latest layout pass had more content lines than viewport rows. */
  get isScrollable(): boolean {
    return this.scrollState.scrollable;
  }

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    this.scrollState.scrollable = viewportHeight > 0 && contentHeight > viewportHeight;
    super.updateLayout(contentHeight, viewportHeight, requestRender);
  }
}
