/**
 * One honest token meter for the Carto screen.
 *
 * The meter is a pure value: the renderer draws what it says and never does
 * arithmetic of its own. Two sources feed it. A llama-swap server reports how
 * far it is with reading a prompt (`prompt_progress`), and the context
 * projection gives an estimate before the first request of a generation. A
 * meter never mixes the two: `source` says which one the numbers came from.
 */

/** One `prompt_progress` report from llama.cpp, in prompt tokens. */
export interface PrefillReading {
  /** Every token in the prompt the server will read. */
  total: number;
  /** Tokens the server reused from its cache instead of reading. */
  cache: number;
  /** Tokens the server has finished with, cache included. */
  processed: number;
}

export interface ContextMeterInput {
  /** The model's context window, in tokens. The bar's length. */
  window: number;
  /** The Carto budget, in tokens. A mark inside the bar. */
  cap: number;
  /** The newest server report for the current request, if there is one. */
  reading?: PrefillReading;
  /** The projection's estimate, used only when there is no reading. */
  estimate: number;
}

export interface ContextMeter {
  window: number;
  cap: number;
  /** Tokens the server keeps and has read. */
  filled: number;
  /** Tokens the server must read now, and has not read yet. */
  changing: number;
  source: "server" | "estimate";
  /** True when the prompt is past the Carto budget. */
  overCap: boolean;
  /** True when the prompt is past the model's window; the server may truncate. */
  overWindow: boolean;
  /** filled + changing, as a share of the window, rounded to a whole percent. */
  percent: number;
}

export function contextMeter(input: ContextMeterInput): ContextMeter {
  const window = Math.max(1, Math.floor(input.window));
  const cap = Math.max(0, Math.min(Math.floor(input.cap), window));
  const reading = sanitizeReading(input.reading);
  let filled: number;
  let changing: number;
  let source: ContextMeter["source"];
  if (reading === undefined) {
    filled = 0;
    changing = Math.max(0, Math.floor(input.estimate));
    source = "estimate";
  } else {
    filled = reading.processed;
    changing = Math.max(0, reading.total - reading.processed);
    source = "server";
  }
  const total = filled + changing;
  return {
    window,
    cap,
    filled,
    changing,
    source,
    // A reading can exceed the window: the server tells us what it will read,
    // and truncation happens after that. Say so instead of clamping silently.
    overWindow: total > window,
    overCap: total > cap,
    percent: Math.min(100, Math.round((Math.min(total, window) / window) * 100)),
  };
}

function sanitizeReading(reading: PrefillReading | undefined): PrefillReading | undefined {
  if (reading === undefined) return undefined;
  const total = Math.max(0, Math.floor(reading.total));
  if (total === 0) return undefined;
  return {
    total,
    cache: Math.max(0, Math.min(Math.floor(reading.cache), total)),
    processed: Math.max(0, Math.min(Math.floor(reading.processed), total)),
  };
}

/** How a bar of `cells` cells divides between the three parts. */
export interface MeterCells {
  cells: number;
  /** Cells of the filled part. */
  filled: number;
  /** Cells of the changing part, directly after the filled part. */
  changing: number;
  /** Cells still free. */
  free: number;
  /** The cell where the budget boundary falls. */
  capIndex: number;
  /** True when the boundary falls in a free cell, so the mark can replace it. */
  capShown: boolean;
  /** True when any part of the bar is past the budget. */
  overCap: boolean;
  /**
   * True for a small prompt that would take no cell at this width. The first
   * cell is filled then, because a bar that shows nothing reads as a bug; the
   * numbers stay exact, and `estimate` still says the number is a guess.
   */
  small: boolean;
}

/**
 * Divide a bar into cells. The three counts always add up to `cells`, the
 * order is always filled, changing, free, and rounding never lets one part
 * overtake the next: boundaries are rounded once, from the start.
 */
export function meterCells(meter: ContextMeter, cells: number): MeterCells {
  const count = Math.max(0, Math.floor(cells));
  const window = Math.max(1, meter.window);
  const changeEnd = clamp(Math.round(((meter.filled + meter.changing) / window) * count), 0, count);
  const filledEnd = clamp(Math.round((meter.filled / window) * count), 0, changeEnd);
  const filled = filledEnd;
  const changing = changeEnd - filledEnd;
  const free = count - changeEnd;
  const small = count > 0 && changeEnd === 0 && meter.filled + meter.changing > 0;
  const capIndex = clamp(Math.floor((meter.cap / window) * count), 0, Math.max(0, count - 1));
  return {
    cells: count,
    filled,
    changing,
    free,
    capIndex,
    capShown: count > 0 && capIndex >= changeEnd && free > 0,
    overCap: meter.overCap,
    small,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
