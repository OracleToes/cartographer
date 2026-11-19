import type { ContextMeter } from "../domain/meter.js";
import { meterCells } from "../domain/meter.js";
import { short, width } from "./text.js";
import { token } from "./tokens.js";

/**
 * The token bar: one row that says how full the model's window is, how much of
 * it the server is reading now, and where the Carto budget sits inside it.
 *
 * Three parts, always in this order: what the server keeps (`▰`), what it must
 * read now (`▨`), and what is still free (`▱`). The budget is a mark, not a
 * second bar, so the person reads one length: the real window. Before the
 * first server report every cell is drawn from an estimate (`▤`, muted, `~`),
 * and three marks say so, because one is not enough on a plain terminal.
 */

const GLYPH = { filled: "▰", changing: "▨", free: "▱", estimate: "▤", cap: "┊" } as const;

/** How many cells the bar gets at a terminal width. */
export function barCells(width: number): number {
  if (width < 60) return 0;
  if (width < 96) return 10;
  return 20;
}

/** The bar alone, for a caller that composes its own row. */
export function meterBar(meter: ContextMeter, cells: number): string {
  const parts = meterCells(meter, cells);
  const estimate = meter.source === "estimate";
  // An estimate past the budget is still an estimate: it keeps its own glyph
  // and its own style, and the numbers say how far past it is.
  const bodyStyle = estimate
    ? token.barEstimate
    : meter.overWindow
      ? token.barOverWindow
      : parts.overCap
        ? token.barOverCap
        : token.barFilled;
  const end = parts.small ? 1 : parts.filled + parts.changing;
  // Group equal cells into runs: one escape pair per colour change rather than
  // one per cell, which keeps a 10 Hz frame cheap.
  const runs: Array<{ style: (text: string) => string; text: string }> = [];
  const push = (styleOf: (text: string) => string, glyph: string): void => {
    const previous = runs[runs.length - 1];
    if (previous !== undefined && previous.style === styleOf) previous.text += glyph;
    else runs.push({ style: styleOf, text: glyph });
  };
  for (let index = 0; index < parts.cells; index += 1) {
    if (parts.small && index === 0) push(bodyStyle, estimate ? GLYPH.estimate : GLYPH.filled);
    else if (index < parts.filled) push(bodyStyle, GLYPH.filled);
    else if (index < end) push(estimate ? token.barEstimate : token.barChanging, estimate ? GLYPH.estimate : GLYPH.changing);
    else if (parts.capShown && index === parts.capIndex) push(token.barCap, GLYPH.cap);
    else push(token.barFree, GLYPH.free);
  }
  return runs.map((run) => run.style(run.text)).join("");
}

/** The bar, the numbers, and any warning. This is what a frame draws. */
export function meterRow(meter: ContextMeter, cells: number): string {
  const bar = meterBar(meter, cells);
  const text = meterText(meter, cells);
  const styled = meter.overWindow
    ? token.danger(text)
    : meter.overCap
      ? token.warning(text)
      : meter.source === "estimate"
        ? token.muted(text)
        : token.ink(text);
  return bar === "" ? styled : `${bar}  ${styled}`;
}

/** The cells `meterRow` occupies, so a caller can measure before it commits. */
export function meterRowWidth(meter: ContextMeter, cells: number): number {
  return (cells === 0 ? 0 : cells + 2) + width(meterText(meter, cells));
}

function meterText(meter: ContextMeter, cells: number): string {
  const estimate = meter.source === "estimate";
  const total = meter.filled + meter.changing;
  const kept = estimate ? `~${short(meter.changing)}` : short(meter.filled);
  const reading = !estimate && meter.changing > 0 ? ` + ${short(meter.changing)} new` : "";
  const percent = cells > 0 || estimate ? ` · ${meter.percent}%` : "";
  let text = `${kept}${reading} / ${short(meter.window)} · cap ${short(meter.cap)}${percent}`;
  // The warning is about the budget before it is about the window: the budget
  // is the boundary Carto chose, and it arrives first.
  if (meter.overCap) text += ` · over cap by ${short(total - meter.cap)}`;
  if (meter.overWindow) text += ` · over window by ${short(total - meter.window)}`;
  if (estimate) text += " (estimate)";
  return text;
}

/** The estimate glyph, so a test can assert that the shape alone changes. */
export const ESTIMATE_GLYPH = GLYPH.estimate;
/** The confirmed glyph. */
export const CONFIRMED_GLYPH = GLYPH.filled;
