/**
 * The context bar (§8): one row, always visible, spanning the whole bottom.
 *
 * Its width is the server's own capacity — the total llama.cpp reports for its
 * `-c` setting — and filling it is a picture of the context, not a gauge against
 * a budget. It reports three quantities, each in its own colour:
 *
 * - **fill**, occupied context in one colour;
 * - **prefilled** and **to prefill**, during a prompt read, each in its own
 *   colour, including cached tokens in the completed prefill.
 *
 * Occupancy uses reported usage when available and estimates otherwise. The
 * progress comes from llama.cpp, never from a provider's headers. When a server
 * that was reporting goes quiet the last values stay, greyed.
 */
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { barTokens, chromeLine, rawPalette, tokens } from "./tokens.js";

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
      /** True while a model request is prefilling or generating. */
      requestActive?: boolean | undefined;
      /** A held stream is not making progress. */
      paused?: boolean | undefined;
      /** True while llama.cpp is reading the prompt. */
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
): { full: string; compact: string; eta: string } => {
  if (processed === undefined || total === undefined) {
    return { full: " · prefill ?", compact: " · prefill ?", eta: "" };
  }
  const compact = ` · prefill ${thousands(processed)}/${thousands(total)}`;
  const cache = Math.min(cached ?? 0, total);
  const uncachedTotal = Math.max(0, total - cache);
  const computed = Math.max(0, processed - cache);
  const pct = uncachedTotal > 0 ? Math.round(clamp01(computed / uncachedTotal) * 100) : 100;
  const remaining = Math.max(0, total - processed);
  const eta = rate !== undefined && rate > 0 && remaining > 0 ? ` ${formatEta(remaining / rate)}` : "";
  return { full: `${compact} ${pct}%${eta}`, compact, eta };
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
    const requestActive = this.state.session.state.requestActive === true;
    const paused = this.state.session.state.paused === true;
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
      requestActive ? "active" : "", paused ? "paused" : "",
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
      : { full: "", compact: "", eta: "" };
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

    const track = serverLost ? tokens.faint(TRACK) : tokens.rule(TRACK);
    const cells: string[] = new Array(barWidth).fill(track);
    // One colour for occupied context, regardless of its contents. A live
    // prompt overlays it; the old fill remains visible outside that prompt.
    for (let cell = 0; cell < filled; cell += 1) cells[cell] = (serverLost ? tokens.faint : barTokens.fill)(FULL);
    if (prefillActive && prefillTotal !== undefined && prefillTotal > 0 && prefilledTokens !== undefined) {
      // Without a window, show progress against the prompt's own length.
      const denom = unknown ? prefillTotal : window;
      const scale = (n: number) => Math.min(barWidth, Math.max(0, Math.round(n / denom * barWidth)));
      const prefilled = scale(Math.min(prefilledTokens, prefillTotal));
      const total = scale(prefillTotal);
      // Processed includes the cached prefix. All completed prefill has the
      // same colour, whether reused or newly evaluated and wherever it falls.
      for (let cell = 0; cell < prefilled; cell += 1) cells[cell] = (serverLost ? tokens.faint : barTokens.prefilled)(PREFILL);
      for (let cell = prefilled; cell < total; cell += 1) cells[cell] = (serverLost ? tokens.faint : barTokens.pending)(PREFILL);
    }

    const tint = serverLost ? tokens.faint : unknown ? tokens.muted : measured ? tokens.muted : tokens.faint;
    // Only the current phase's figures are live. Keep stale figures and a lost
    // server quiet, and don't suggest progress while a stream is held paused.
    const active = requestActive && !paused && !serverLost;
    const prefillTint = active && prefillActive ? tokens.warn : tint;
    const decodeTint = active && !prefillActive ? tokens.accent : tint;
    const hasRates = label.endsWith(rates);
    const progress = label.slice(base.length, hasRates ? -rates.length : undefined);
    const eta = prefillText.eta && progress.endsWith(prefillText.eta) ? prefillText.eta : "";
    const right = tint(base)
      + tint(eta ? progress.slice(0, -eta.length) : progress)
      + (eta ? prefillTint(eta) : "")
      + (hasRates
        ? tint(" · ") + prefillTint(`P ${rate(prefillRate)}`) + tint(" ")
          + decodeTint(`D ${rate(decodeRate)}`) + tint(" tok/s")
        : "");
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
