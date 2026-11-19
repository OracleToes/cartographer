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
const activeJobs = (jobs) => Array.isArray(jobs) ? jobs.filter((job) => job?.state === "queued" || job?.state === "running") : [];
const jobText = (job) => {
	const progress = job?.progress;
	const message = typeof progress?.message === "string" && progress.message !== "" ? progress.message : undefined;
	const label = typeof job?.target?.label === "string" && job.target.label !== ""
		? job.target.label
		: typeof job?.target === "string" && job.target !== ""
			? job.target
			: typeof job?.kind === "string" ? job.kind.replace(/[._-]+/g, " ") : "background work";
	const count = Number.isFinite(progress?.current) && Number.isFinite(progress?.total) && progress.total > 0 ? ` ${progress.current}/${progress.total}` : "";
	return `${message ?? label}${count}`;
};

/**
 * Build the activity, shared-state, notice, and key-hint rows for the persistent shell. `brain` and `runtime` are
 * already-settled application projections; only the busy/rest transition is UI-local, so this function never starts
 * a read or asks a live session manager for context, shell, wake, or route state.
 */
export function renderStatusBar({ state, core, chat, activity = {}, brain = {}, runtime = {}, jobs = [], notice, legend = "", config = {}, options = {}, now = () => Date.now() } = {}) {
	if (state === null || typeof state !== "object") throw new TypeError("A status bar needs screen state.");
	if (core === null || typeof core?.busy !== "function" || typeof core?.thinking !== "function") throw new TypeError("A status bar needs terminal activity.");
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
	const size = Number.isFinite(runtime?.contextSize) ? runtime.contextSize : undefined;
	// /model re-fits the window while running; options.config is the shared object that follows it. Runtime's
	// deferred status snapshot supplies the measured context and route diagnostic rather than core/manager probes.
	const windowSize = options.config?.contextWindow ?? options.contextWindow;
	const windowKnown = Number.isFinite(windowSize) && windowSize > 0;
	const fraction = size === undefined || !windowKnown ? 0 : size / windowSize;
	const transportText = typeof runtime?.transport?.text === "string" ? runtime.transport.text : undefined;
	// A failed native-grammar/transport gate takes the whole status row, as the old terminal status did. That keeps
	// the server address and actual failure visible instead of spending the narrow row on ordinary accounting.
	if (runtime?.transport?.primary === true && transportText !== undefined && transportText !== "") second.push([`! ${cut(transportText, POLICY.limits.screen.consoleErrorChars)}`, runtime.transport.style ?? "warn"]);
	else {
		second.push([`ctx ${bar(fraction)} ${size === undefined ? "?" : short(size)}/${windowKnown ? short(windowSize) : "?"}`, size !== undefined && windowKnown && fraction > POLICY.limits.screen.contextWarnPercent / 100 ? "warn" : ""]);
		if (transportText !== undefined && transportText !== "") second.push([` · ${cut(transportText, POLICY.limits.screen.consoleErrorChars)}`, runtime.transport.style ?? "muted"]);
	}
	const { plan, ledger, waits, requests } = brain;
	if (ledger !== undefined) second.push([` · ${ledger}`, "muted"]);
	if (plan !== undefined) second.push([` · ${plan}`, waits ? "warn" : "muted"]);
	if (requests > 0) second.push([` · ${requests === 1 ? "1 request" : `${requests} requests`} for you`, waits ? "warn" : "muted"]);
	const windowCount = Number.isInteger(runtime?.windows?.count) && runtime.windows.count > 0 ? runtime.windows.count : 0;
	const running = Number.isInteger(runtime?.windows?.busy) && runtime.windows.busy > 0 ? runtime.windows.busy : 0;
	if (windowCount > 0) second.push([` · ${windowCount === 1 ? "1 window" : `${windowCount} windows`}${running > 0 ? `, ${running} busy` : ""}`, running > 0 ? "" : "muted"]);
	const wakeCount = Number.isInteger(runtime?.wakes?.count) && runtime.wakes.count > 0 ? runtime.wakes.count : 0;
	if (wakeCount > 0) second.push([` · ${wakeCount === 1 ? "1 wake" : `${wakeCount} wakes`}${typeof runtime.wakes.next === "string" && runtime.wakes.next !== "" ? `, ${runtime.wakes.next}` : ""}`, "muted"]);
	if (runtime?.diagnostic !== undefined && typeof runtime.diagnostic.text === "string" && runtime.diagnostic.text !== "") second.push([` · ${cut(runtime.diagnostic.text, POLICY.limits.screen.consoleErrorChars)}`, runtime.diagnostic.style ?? "muted"]);
	const active = activeJobs(jobs);
	if (active.length > 0) {
		const job = active.at(-1);
		const cancelling = job?.cancellation?.requested === true ? " · cancelling" : "";
		second.push([` · ${SPINNER[Math.floor(at / SPIN_MS) % SPINNER.length]} ${cut(jobText(job), POLICY.limits.screen.consoleErrorChars)}${cancelling}`, job?.cancellation?.requested === true ? "warn" : "tool"]);
		if (active.length > 1) second.push([` · +${active.length - 1} job${active.length === 2 ? "" : "s"}`, "muted"]);
	}
	if (options.gate?.yolo === true) second.push([" · yolo", "warn"]);
	if (options.runner?.mode === "direct") second.push([" · no sandbox", "warn"]);
	if (!core.thinking()) second.push([" · notes hidden", "muted"]);
	const rows = [first, second];
	if (notice !== undefined) rows.push([[" ", ""], ...noticeSpans(notice)]);
	rows.push([[` ${legend}`, TOKEN.text.muted]]);
	return rows;
}
