/**
 * The token bar (MINI.md §9; docs/ui-proposal.md §7, candidate A — the breakdown
 * line is not part of the bar; it lands with the Context view's parts rail in
 * R5d). One row, segmented by part, numbers right-aligned, always visible.
 *
 * Honesty rules, standing (2026-11-20): live, never invented. Before the first
 * provider report the bar is all estimate and the fill is hatched (`▤`); once
 * a report exists the base of the figure is the provider's own count and the
 * fill is solid (`▮`). The tool-work-since tail is always an estimate, so the
 * numbers carry `~` always — the same phrasing the state block uses. The free
 * region tints warning past 90% used and danger past the window; the
 * denominator is the active context window (min of the configured ceiling and
 * the advertised capacity), never the model's maximum. No other tick is drawn:
 * this build has no budget below the window, and a mark without a meaning
 * would be an invented figure.
 */
import {
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

import { partTokens, tokens } from "./tokens.js";

/** Read at render time; the app mutates it in place and rebinds `session` at collapse. */
export interface TokenBarState {
  session: {
    state: {
      /** The ACTIVE window: min(configured ceiling, advertised). */
      contextWindow: number;
      /** The provider's own input count from the last response, if one has arrived. */
      lastReportedInput?: number | undefined;
      /** Estimated tool-work tokens as of the last response; the bar adds only what came after. */
      toolWorkAtLastReport?: number | undefined;
    };
  };
  /** Estimated payload sizes, same arithmetic and same label (`~`) as the state block. */
  parts: {
    system: number;
    transcript: number;
    toolWork: number;
  };
}

const clamp01 = (value: number): number => (value <= 0 ? 0 : value >= 1 ? 1 : value);
const thousands = (value: number): string => Math.round(value).toLocaleString("en-US");

export class TokenBarView implements Component {
  private cacheWidth = -1;
  private cacheKey = "";
  private cacheLines: string[] = [];

  constructor(private readonly state: TokenBarState) {}

  invalidate(): void {
    this.cacheWidth = -1;
  }

  render(width: number): string[] {
    const { contextWindow, lastReportedInput, toolWorkAtLastReport } = this.state.session.state;
    const { system, transcript, toolWork } = this.state.parts;
    const window = Math.max(1, contextWindow);
    const estimate = Math.max(0, system) + Math.max(0, transcript) + Math.max(0, toolWork);
    const toolWorkSince = Math.max(0, Math.max(0, toolWork) - (toolWorkAtLastReport ?? 0));
    const measured = lastReportedInput !== undefined && lastReportedInput > 0;
    const used = measured ? (lastReportedInput as number) + toolWorkSince : estimate;
    const key = [width, window, Math.round(used), Math.round(system), Math.round(transcript), Math.round(toolWork), measured].join("|");
    if (this.cacheWidth === width && this.cacheKey === key) return this.cacheLines;

    const pct = Math.round((used / window) * 100);
    const numbers = `~${thousands(used)} / ${thousands(window)} · ${pct}%`;
    const numbersTint = pct >= 100 ? tokens.danger : pct >= 90 ? tokens.warn : tokens.muted;
    const renderedNumbers = numbersTint(numbers);
    const barWidth = Math.max(4, width - visibleWidth(numbers) - 2);
    const fillGlyph = measured ? "▮" : "▤";
    const fill = clamp01(used / window) * barWidth;

    // Segment widths: estimated shares of the estimated payload, scaled to the
    // filled length (cumulative rounding keeps the segments additive).
    const shares = estimate > 0 ? [Math.max(0, system) / estimate, Math.max(0, transcript) / estimate, Math.max(0, toolWork) / estimate] : [0, 0, 1] as const;
    const hues = [partTokens.system, partTokens.transcript, partTokens.toolWork] as const;
    const cells: string[] = new Array(barWidth).fill(tokens.muted("░"));
    let cursor = 0;
    let cumulative = 0;
    for (let index = 0; index < shares.length; index += 1) {
      cumulative += (shares[index] as number) * fill;
      const end = Math.min(barWidth, Math.round(cumulative));
      for (let cell = cursor; cell < end; cell += 1) cells[cell] = (hues[index] as (text: string) => string)(fillGlyph);
      cursor = end;
    }
    if (cursor < Math.round(fill)) for (let cell = cursor; cell < Math.round(fill); cell += 1) cells[cell] = (hues[shares.length - 1] as (text: string) => string)(fillGlyph);

    const bar = cells.join("");
    const line = truncateToWidth(`${bar}  ${renderedNumbers}`, width, "");
    this.cacheLines = [line];
    this.cacheWidth = width;
    this.cacheKey = key;
    return this.cacheLines;
  }
}
