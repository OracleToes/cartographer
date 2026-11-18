// The persistent shell status strip.
//
// It paints only settled screen state: callers refresh their projections and pass the cached facts in here. The small
// busy/rest transition is UI-local, so it belongs with the strip rather than a renderer or a terminal-core callback.
import { DEFAULTS, POLICY } from "../config.mjs";
import { stamp } from "../time.mjs";
import { noticeSpans } from "./notices.mjs";
import { TOKEN } from "./tokens.mjs";
import { bar, cut, short, span } from "./text.mjs";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPIN_MS = POLICY.timing.spinnerMs;
const array = (value) => Array.isArray(value) ? value : [];

/**
 * Build the activity, shared-state, notice, and key-hint rows for the persistent shell. `brain`, `windows`, and
 * `wakes` must already be cached deferred projections; this function never starts a read.
 */
export function renderStatusBar({ state, core, chat, activity = {}, brain = {}, windows = [], wakes = [], notice, legend = "", config = {}, options = {}, now = () => Date.now() } = {}) {
	if (state === null || typeof state !== "object") throw new TypeError("A status bar needs screen state.");
	if (core === null || typeof core?.busy !== "function" || typeof core?.contextSize !== "function" || typeof core?.thinking !== "function") throw new TypeError("A status bar needs terminal activity.");
	if (chat === null || typeof chat?.doing !== "function") throw new TypeError("A status bar needs chat activity.");
	if (typeof now !== "function") throw new TypeError("A status bar needs a clock.");
	const at = now();
	const busy = core.busy();
	if (busy && state.busySince === undefined) {
		state.busySince = at;
		state.rate = undefined;
	}
	if (!busy && state.busySince !== undefined) {
		state.busySince = undefined;
		state.restSince = at;
		state.prefill = undefined;
	}
	const question = activity.question;
	const first = [];
	if (question !== undefined) first.push([Number.isFinite(question.since) ? `? waiting for your answer since ${stamp(question.since).split(", ").at(-1)}` : "? waiting for your answer", "warn bold"], [" · type it below", "muted"]);
	else if (busy) {
		const doing = chat.doing();
		// The mark turns while the agent works: the screen is alive also when nothing else on it moves.
		first.push([`${SPINNER[Math.floor(at / SPIN_MS) % SPINNER.length]} `, "ok"], [doing?.task ?? (activity.taskActive ? "task" : "working"), "bold"]);
		const reading = state.prefill?.phase === "reading" && state.prefill.fresh >= (config.prefillTokens ?? DEFAULTS.prefillTokens);
		if (reading) {
			const { fresh, done, ms } = state.prefill;
			const rate = ms > 0 ? done / (ms / 1000) : 0;
			const left = rate > 0 ? (fresh - done) / rate : undefined;
			first.push([` · reading ${short(done)} of ${short(fresh)} new ${bar(done / fresh)} ${Math.round((done / fresh) * 100)}%`, "tool"], [`${rate > 0 ? ` · ${Math.round(rate)} tok/s` : ""}${left !== undefined ? ` · writing in ~${Math.max(1, Math.round(left))} s` : ""}`, "muted"]);
		} else if (doing !== undefined) first.push([` · ${doing.what}`, ""]);
		else if (state.prefill?.phase === "sent") first.push([" · waiting for the model", "muted"]);
		first.push([` · ${span(at - state.busySince)}`, "muted"]);
		if (state.rate !== undefined && !reading) first.push([` · ${state.rate < POLICY.limits.format.rateDecimalBelow ? state.rate.toFixed(1) : Math.round(state.rate)} tok/s`, "muted"]);
		if (state.lastPrefill !== undefined && at - state.lastPrefill.at < POLICY.timing.screen.prefillRecentMs && !reading) first.push([` · read ${short(state.lastPrefill.fresh)} new in ${span(state.lastPrefill.ms)}`, "muted"]);
	} else first.push(["○ ", "muted"], ["resting", ""], [` · ${span(at - state.restSince)}`, "muted"]);
	if (core.paused?.()) first.push([" · paused: held · /pause or Ctrl-V lets it go on", "warn"]);

	const second = [];
	const size = core.contextSize();
	// /model re-fits the window while running; options.config is the shared object that follows it. A route error
	// takes precedence over ordinary accounting: the visible status must say why Cartographer is resting.
	const windowSize = options.config?.contextWindow ?? options.contextWindow;
	if (state.modelError !== undefined) second.push([`! ${cut(state.modelError, POLICY.limits.screen.consoleErrorChars)}`, "warn"]);
	else second.push([`ctx ${bar((size ?? 0) / windowSize)} ${size === undefined ? "?" : short(size)}/${short(windowSize)}`, size !== undefined && size / windowSize > POLICY.limits.screen.contextWarnPercent / 100 ? "warn" : ""]);
	const { plan, ledger, waits, requests } = brain;
	if (ledger !== undefined) second.push([` · ${ledger}`, "muted"]);
	if (plan !== undefined) second.push([` · ${plan}`, waits ? "warn" : "muted"]);
	if (requests > 0) second.push([` · ${requests === 1 ? "1 request" : `${requests} requests`} for you`, waits ? "warn" : "muted"]);
	const availableWindows = array(windows).filter((win) => win.state !== POLICY.enums.windowStates.gone);
	if (availableWindows.length > 0) {
		const running = availableWindows.filter((win) => win.state === POLICY.enums.windowStates.busy).length;
		second.push([` · ${availableWindows.length === 1 ? "1 window" : `${availableWindows.length} windows`}${running > 0 ? `, ${running} busy` : ""}`, running > 0 ? "" : "muted"]);
	}
	const scheduledWakes = array(wakes);
	if (scheduledWakes.length > 0) second.push([` · ${scheduledWakes.length === 1 ? "1 wake" : `${scheduledWakes.length} wakes`}`, "muted"]);
	if (options.gate?.yolo === true) second.push([" · yolo", "warn"]);
	if (options.runner?.mode === "direct") second.push([" · no sandbox", "warn"]);
	if (!core.thinking()) second.push([" · notes hidden", "muted"]);
	const rows = [first, second];
	if (notice !== undefined) rows.push([[" ", ""], ...noticeSpans(notice)]);
	rows.push([[` ${legend}`, TOKEN.text.muted]]);
	return rows;
}
