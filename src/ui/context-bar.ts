/**
 * The context bar (§8): one row, always visible, spanning the whole bottom.
 *
 * Its width is the server's own capacity — the total llama.cpp reports for its
 * `-c` setting — and filling it is a picture of the context, not a gauge against
 * a budget. It reports three quantities, each in its own colour:
 *
 * - **fill**, solid, in three parts: the stable system and tool prefix, the
 *   transcript, and tool work;
 * - **prefilled** and **to prefill**, during a prompt read, so the slow half of a
 *   long context is visible as it is paid for.
 *
 * All three figures come from llama.cpp, never from a provider's headers. Before
 * the first measured request the bar says so in its own glyph and colour rather
 * than inventing a number; when a server that was reporting goes quiet the last
 * values stay, greyed, so the person can still see where the context stood.
 */
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { chromeLine, partTokens, rawPalette, tokens } from "./tokens.js";

/** What the bar knows. The app mutates it in place and rebinds `session` at collapse. */
export interface ContextBarState {
  session: {
    state: {
      /** The server's advertised capacity for `-c`; 0 = unknown. */
      contextWindow: number;
      /** The server's own input count from the last response, if one has arrived. */
      lastReportedInput?: number | undefined;
      lastReportedOutput?: number | undefined;
      /** Estimated tool-work tokens as of the last response; the bar adds only what came after. */
      toolWorkAtLastReport?: number | undefined;
      /** True while a request is being sent and no response has come back yet: llama.cpp is reading the prompt. */
      prefillActive?: boolean | undefined;
      /** Tokens of the current prompt already read, when the server is reporting progress. */
      prefilledTokens?: number | undefined;
      prefillTotal?: number | undefined;
      prefillCached?: number | undefined;
      prefillRate?: number | undefined;
      decodeRate?: number | undefined;
      /** True when a server that was reporting has stopped: the figures are the last known ones. */
      serverLost?: boolean | undefined;
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

const formatEta = (seconds: number): string => {
  if (seconds < 1) return "now";
  if (seconds < 60) return `~${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `~${minutes}m ${secs}s` : `~${minutes}m`;
};

const formatPrefill = (
  processed: number | undefined,
  total: number | undefined,
  cached: number | undefined,
  rate: number | undefined,
): { full: string; compact: string } => {
  if (processed === undefined || total === undefined) {
    return { full: " · prefill ?", compact: " · prefill ?" };
  }
  const compact = ` · prefill ${thousands(processed)}/${thousands(total)}`;
  const cache = Math.min(cached ?? 0, total);
  const uncachedTotal = Math.max(0, total - cache);
  const computed = Math.max(0, processed - cache);
  const pct = uncachedTotal > 0 ? Math.round(clamp01(computed / uncachedTotal) * 100) : 100;
  const remaining = Math.max(0, total - processed);
  const eta = rate !== undefined && rate > 0 && remaining > 0 ? ` ${formatEta(remaining / rate)}` : "";
  return { full: `${compact} ${pct}%${eta}`, compact };
};

/** Half-block cells: a bar that reads as a continuous surface rather than a row of boxes. */
const FULL = "█";
const PREFILL = "▓";
const TRACK = "░";

export class TokenBarView implements Component {
  private cacheWidth = -1;
  private cacheKey = "";
  private cacheLines: string[] = [];

  constructor(private readonly state: ContextBarState) {}

  invalidate(): void {
    this.cacheWidth = -1;
  }

  setParts(parts: ContextBarState["parts"]): void {
    this.state.parts = parts;
  }

  render(width: number): string[] {
    const { contextWindow, lastReportedInput, lastReportedOutput, toolWorkAtLastReport,
      prefillTotal, prefilledTokens, prefillCached, prefillRate, decodeRate } = this.state.session.state;
    const prefillActive = this.state.session.state.prefillActive === true;
    const serverLost = this.state.session.state.serverLost === true;
    const { system, transcript, toolWork } = this.state.parts;
    const unknown = contextWindow <= 0;
    const window = unknown ? 1 : contextWindow;
    const estimate = Math.max(0, system) + Math.max(0, transcript) + Math.max(0, toolWork);
    const toolWorkSince = Math.max(0, Math.max(0, toolWork) - (toolWorkAtLastReport ?? 0));
    const measured = lastReportedInput !== undefined && lastReportedInput > 0;
    const used = measured ? (lastReportedInput as number) + (lastReportedOutput ?? 0) + toolWorkSince : estimate;

    const key = [
      width,
      window,
      unknown ? "unknown" : "known",
      Math.round(used),
      Math.round(system),
      Math.round(transcript),
      Math.round(toolWork),
      measured ? "measured" : "estimated",
      prefillActive ? "prefill" : "",
      prefillTotal ?? "?", prefilledTokens ?? "?", prefillCached ?? "?",
      prefillRate ?? "?", decodeRate ?? "?",
      serverLost ? "lost" : "",
    ].join("|");
    if (this.cacheWidth === width && this.cacheKey === key) return this.cacheLines;

    // The figure on the right; the bar takes everything else it can have.
    const shown = unknown ? `${thousands(used)} · window unknown` : `${thousands(used)} / ${thousands(contextWindow)}`;
    const qualifier = measured && toolWorkSince === 0 ? "" : "~";
    const rate = (value: number | undefined) => value === undefined ? "—" : value.toFixed(1);
    const prefillText = prefillActive
      ? formatPrefill(prefilledTokens, prefillTotal, prefillCached, prefillRate)
      : { full: "", compact: "" };
    const rates = ` · P ${rate(prefillRate)} D ${rate(decodeRate)} tok/s`;
    const base = `${qualifier}${shown}`;
    // Keep some bar on narrow terminals; show progress before speed if both
    // will not fit. A missing value is shown as unknown, never zero progress.
    const label = width >= visibleWidth(base + prefillText.full + rates) + 8 ? base + prefillText.full + rates
      : width >= visibleWidth(base + prefillText.compact + rates) + 8 ? base + prefillText.compact + rates
      : width >= visibleWidth(base + prefillText.full) + 8 ? base + prefillText.full
      : width >= visibleWidth(base + prefillText.compact) + 8 ? base + prefillText.compact
      : base;
    const barWidth = Math.max(0, width - visibleWidth(label) - 1);
    const ratio = unknown ? 0 : clamp01(used / window);
    const filled = Math.round(ratio * barWidth);

    // Three parts of the fill, in the parts' own hues, cumulative-rounded so they add up.
    const shares: Array<[number, (text: string) => string]> = estimate > 0
      ? [
          [Math.max(0, system) / estimate, partTokens.system],
          [Math.max(0, transcript) / estimate, partTokens.transcript],
          [Math.max(0, toolWork) / estimate, partTokens.toolWork],
        ]
      : [[1, partTokens.toolWork]];

    const track = serverLost ? tokens.faint(TRACK) : tokens.rule(TRACK);
    const cells: string[] = new Array(barWidth).fill(track);
    // Always draw the last known occupied context first, even while a new
    // prompt is being read. Prefill is an overlay, not a replacement for fill.
    let cursor = 0;
    let cumulative = 0;
    for (const [share, tint] of shares) {
      cumulative += share * filled;
      const end = Math.min(barWidth, Math.round(cumulative));
      for (let cell = cursor; cell < end; cell += 1) cells[cell] = serverLost ? tokens.faint(FULL) : tint(FULL);
      cursor = end;
    }
    for (let cell = cursor; cell < filled; cell += 1) cells[cell] = serverLost ? tokens.faint(FULL) : partTokens.toolWork(FULL);
    if (prefillActive && prefillTotal !== undefined && prefillTotal > 0 && prefilledTokens !== undefined) {
      const denom = unknown ? prefillTotal : window;
      const scale = (n: number) => Math.min(barWidth, Math.max(0, Math.round(n / denom * barWidth)));
      const cached = scale(prefillCached ?? 0);
      const prefilled = scale(prefilledTokens);
      const total = scale(prefillTotal);
      if (unknown) {
        // When the server has not yet advertised a context window, scale the
        // live prefill bar against the prompt being read so prefill is visible.
        for (let cell = 0; cell < cached; cell += 1) cells[cell] = serverLost ? tokens.faint(FULL) : partTokens.system(FULL);
        for (let cell = cached; cell < prefilled; cell += 1) cells[cell] = serverLost ? tokens.faint(PREFILL) : tokens.warn(PREFILL);
        for (let cell = prefilled; cell < total; cell += 1) cells[cell] = tokens.rule(PREFILL);
      } else {
        for (let cell = cached; cell < prefilled; cell += 1) cells[cell] = (cell < filled ? tokens.prefillOnFill : tokens.warn)(PREFILL);
        for (let cell = prefilled; cell < total; cell += 1) cells[cell] = (cell < filled ? tokens.prefillPendingOnFill : tokens.rule)(PREFILL);
      }
    }

    const tint = serverLost ? tokens.faint : unknown ? tokens.muted : measured ? tokens.muted : tokens.faint;
    const right = tint(label);
    const gap = Math.max(1, width - barWidth - visibleWidth(right));
    const line = chromeLine(truncateToWidth(`${cells.join("")}${" ".repeat(gap)}${right}`, width, ""), width);
    this.cacheLines = [line];
    this.cacheWidth = width;
    this.cacheKey = key;
    return this.cacheLines;
  }
}

/** The bar's raw palette, for anything that wants to draw its own track in the same ink. */
export const barInk = rawPalette;
