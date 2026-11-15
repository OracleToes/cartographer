// The chars-per-token ratio used to size estimate() and everything built on it.
//
// The true ratio is a property of the model and the text. Starting from the usual 4.0, it is re-learned from
// each reply the server sends back: the request's payload size against the prompt tokens the server reports
// (input + cache read + cache write — the whole prompt, cached or not). An exponential moving average keeps it
// honest without chasing any one reply, and it is clamped so that one odd reply cannot swing packing or the
// display far. The collapse thresholds do not use this at all: they read the server's own count (state.used).
// What it feeds is the estimate used where no count exists yet — shelf and record packing, /context, the
// screen's tokens-per-second.
import { POLICY } from "./config.mjs";

let calibrated = POLICY.estimation.charsPerToken;

/** The ratio in effect right now. */
export const charsPerTokenNow = () => calibrated;

/**
 * Feed the server's own reading into the ratio. `chars` is the size of the payload as it was sent; `tokens` is
 * the prompt tokens the server reported for it. Nonsense (zero or NaN) is ignored.
 */
export function calibrate(chars, tokens) {
	if (!Number.isFinite(chars) || !Number.isFinite(tokens) || chars <= 0 || tokens <= 0) return;
	const observed = Math.min(POLICY.estimation.emaMax, Math.max(POLICY.estimation.emaMin, chars / tokens));
	calibrated += POLICY.estimation.emaAlpha * (observed - calibrated);
}
