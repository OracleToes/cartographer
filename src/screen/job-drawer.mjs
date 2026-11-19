// A compact, typed view of asynchronous work.
//
// The drawer receives immutable application job snapshots and a cancellation dispatcher. It never sees a controller,
// process handle, or operation closure, so it can present cancellation without becoming another execution surface.
import { cut, paint, wrap } from "./text.mjs";
import { TOKEN } from "./tokens.mjs";

const isPromise = (value) => value !== null && typeof value === "object" && typeof value.then === "function";
const active = (job) => job?.state === "queued" || job?.state === "running";
const inspectable = (job) => active(job) || job?.state === "failed" || job?.state === "cancelled";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const result = (value) => {
	if (!record(value) || typeof value.ok !== "boolean") return undefined;
	if (value.ok) return Object.freeze({ ok: true });
	return Object.freeze({ ok: false, error: Object.freeze({ message: typeof value.error?.message === "string" ? value.error.message : "Cartographer could not complete that job." }) });
};
const copy = (job) => {
	const outcome = result(job?.result);
	return Object.freeze({
		id: String(job?.id ?? ""),
		kind: typeof job?.kind === "string" ? job.kind : "background work",
		state: typeof job?.state === "string" ? job.state : "unknown",
		...(job?.target === undefined ? {} : { target: record(job.target) ? Object.freeze({ ...job.target }) : job.target }),
		...(record(job?.progress) ? { progress: Object.freeze({ ...job.progress }) } : {}),
		...(record(job?.cancellation) ? { cancellation: Object.freeze({ ...job.cancellation }) } : {}),
		...(job?.cancellable === true ? { cancellable: true } : {}),
		...(outcome === undefined ? {} : { result: outcome }),
	});
};

/** The drawer stays out of the way for one ordinary active job; the status bar carries that concise fact. */
export const jobsForDrawer = (jobs = []) => (Array.isArray(jobs) ? jobs : [])
	.filter(inspectable)
	.map(copy)
	.sort((left, right) => Number(active(right)) - Number(active(left)) || left.id.localeCompare(right.id));

/** More than one live job needs a compact list; failures and cancellations remain inspectable until the person dismisses it. */
export const jobDrawerNeeded = (jobs = []) => {
	const visible = jobsForDrawer(jobs);
	return visible.filter(active).length > 1 || visible.some((job) => job.state === "failed" || job.state === "cancelled");
};

const label = (job) => {
	if (typeof job?.target?.label === "string" && job.target.label !== "") return job.target.label;
	if (typeof job?.target === "string" && job.target !== "") return job.target;
	return job?.kind?.replace(/[._-]+/g, " ") ?? "background work";
};
const progress = (job) => {
	const message = typeof job?.progress?.message === "string" ? job.progress.message : "";
	const current = Number.isFinite(job?.progress?.current) ? job.progress.current : undefined;
	const total = Number.isFinite(job?.progress?.total) ? job.progress.total : undefined;
	const count = current !== undefined && total !== undefined && total > 0 ? `${current}/${total}` : "";
	return [message, count].filter(Boolean).join(" · ");
};
const stateText = (job) => job?.cancellation?.requested === true && active(job) ? "cancelling" : job?.state ?? "unknown";
const stateStyle = (job) => {
	if (job?.state === "failed") return TOKEN.feedback.danger;
	if (job?.state === "cancelled" || job?.cancellation?.requested === true) return TOKEN.feedback.warning;
	if (active(job)) return TOKEN.interaction.loading;
	return TOKEN.text.muted;
};
const cancellationHint = (job) => {
	if (job?.cancellable !== true || job?.cancellation?.meaningful !== true) return "This job has already settled.";
	return job.cancellation.mode === "stop-waiting"
		? "Cancel stops waiting after its committed effect; it does not undo that effect."
		: "Cancel stops this abort-aware work before it finishes.";
};

/**
 * Focus-capturing job inspector. `cancel` returns a UiResult; the drawer reports that typed outcome and waits for the
 * corresponding job event/snapshot rather than assuming a process was actually stopped.
 */
export class JobDrawer {
	/**
	 * @param {{
	 *   jobs: object[] | (() => object[]),
	 *   keyOf: (data: string) => string | undefined,
	 *   close: () => void,
	 *   cancel: (id: string) => { ok: boolean, data?: object, error?: { message?: string } } | Promise<{ ok: boolean, data?: object, error?: { message?: string } }>,
	 *   flash: (text: string) => void,
	 *   redraw?: () => void,
	 * }} given
	 */
	constructor(given) {
		if (given === null || typeof given !== "object") throw new TypeError("A job drawer needs its options.");
		if (typeof given.keyOf !== "function") throw new TypeError("A job drawer needs a key reader.");
		if (typeof given.close !== "function") throw new TypeError("A job drawer needs a close callback.");
		if (typeof given.cancel !== "function") throw new TypeError("A job drawer needs a cancellation dispatcher.");
		if (typeof given.flash !== "function") throw new TypeError("A job drawer needs a feedback callback.");
		this.given = given;
		this.capturesViewportInput = true;
		this.index = 0;
		this.pending = false;
	}
	invalidate() {}
	jobs() {
		const supplied = typeof this.given.jobs === "function" ? this.given.jobs() : this.given.jobs;
		return jobsForDrawer(supplied);
	}
	selected() {
		const jobs = this.jobs();
		this.index = Math.max(0, Math.min(jobs.length - 1, this.index));
		return jobs[this.index];
	}
	move(by) {
		const jobs = this.jobs();
		if (jobs.length === 0) return;
		this.index = Math.max(0, Math.min(jobs.length - 1, this.index + by));
	}
	cancel() {
		if (this.pending) return void this.given.flash("that cancellation is still finishing");
		const job = this.selected();
		if (job === undefined) return void this.given.flash("there is no job to inspect");
		if (job.cancellable !== true || job.cancellation?.meaningful !== true) return void this.given.flash("that job has already settled");
		let outcome;
		try {
			outcome = this.given.cancel(job.id);
		} catch (error) {
			this.given.flash(`could not cancel that job: ${error?.message ?? error}`);
			return;
		}
		const finish = (result) => {
			if (result?.ok === true) this.given.flash(result?.data?.accepted === false ? "cancellation was already requested" : "cancellation requested");
			else this.given.flash(result?.error?.message ?? "Cartographer could not cancel that job.");
		};
		if (!isPromise(outcome)) return void finish(outcome);
		this.pending = true;
		this.given.redraw?.();
		void Promise.resolve(outcome)
			.then(finish)
			.catch((error) => this.given.flash(`could not cancel that job: ${error?.message ?? error}`))
			.finally(() => {
				this.pending = false;
				this.given.redraw?.();
			});
	}
	handleInput(data) {
		const key = this.given.keyOf(data);
		if (this.pending) return void this.given.flash(key === "escape" ? "that cancellation is still finishing" : "cancelling…");
		if (key === "escape") return void this.given.close();
		if (key === "enter" || key === "c" || key === "x") return void this.cancel();
		if (key === "up" || key === "k" || key === "ctrl+p") return void this.move(-1);
		if (key === "down" || key === "j" || key === "ctrl+n") return void this.move(1);
		if (key === "home") {
			this.index = 0;
			return;
		}
		if (key === "end") {
			this.index = Math.max(0, this.jobs().length - 1);
			return;
		}
		if (key === "pageUp") return void this.move(-6);
		if (key === "pageDown") return void this.move(6);
	}
	handleMouse() {
		return { handled: true };
	}
	footer() {
		return this.pending ? "Cancelling… waiting for Cartographer to acknowledge it" : "↑ ↓ inspect · Enter/c cancel a live job · Esc close";
	}
	render(width) {
		const inner = Math.max(10, width - 6);
		const row = (spans, selected = false) => paint([["   ", ""], ...spans], width, selected ? TOKEN.interaction.selected : TOKEN.surface.overlay);
		const jobs = this.jobs();
		this.index = Math.max(0, Math.min(jobs.length - 1, this.index));
		const selected = jobs[this.index];
		const rows = [
			paint([], width, TOKEN.surface.overlay),
			row([[" Background work", `${TOKEN.text.primary} ${TOKEN.emphasis.strong}`]]),
			row([[" Jobs use abort-aware ports; cancellation is explicit", TOKEN.text.muted]]),
			paint([], width, TOKEN.surface.overlay),
		];
		if (jobs.length === 0) rows.push(row([[" No active, failed, or cancelled jobs need inspection.", TOKEN.text.muted]]));
		else {
			const start = Math.max(0, Math.min(jobs.length - 7, this.index - 3));
			const visible = jobs.slice(start, start + 7);
			for (const [offset, job] of visible.entries()) {
				const index = start + offset;
				const prefix = index === this.index ? "› " : "  ";
				rows.push(row([
					[prefix, stateStyle(job)],
					[cut(label(job), Math.max(8, inner - 22)), TOKEN.text.primary],
					[` · ${stateText(job)}`, stateStyle(job)],
				], index === this.index));
			}
			if (visible.length < jobs.length) rows.push(row([[` … ${jobs.length - visible.length} more`, TOKEN.text.muted]]));
			const detail = selected === undefined ? undefined : progress(selected) || (selected.result?.ok === false ? selected.result.error?.message : cancellationHint(selected));
			if (detail !== undefined && detail !== "") {
				rows.push(paint([], width, TOKEN.surface.overlay));
				for (const line of wrap(detail, inner - 2).slice(0, 2)) rows.push(row([[` ${line}`, selected?.state === "failed" ? TOKEN.feedback.danger : selected?.state === "cancelled" ? TOKEN.feedback.warning : TOKEN.text.secondary]]));
			}
		}
		rows.push(paint([], width, TOKEN.surface.overlay));
		rows.push(row([[this.footer(), this.pending ? TOKEN.interaction.loading : TOKEN.text.muted]]));
		rows.push(paint([], width, TOKEN.surface.overlay));
		return rows;
	}
}
