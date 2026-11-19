// Cancellable lifecycle ownership for slow application work. A job is only for a real abort-aware asynchronous port:
// it never turns a synchronous legacy operation into pretend background work. Jobs expose safe snapshots and typed UI
// outcomes; renderers consume those snapshots rather than holding a mutable AbortController or operation closure.
import { UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";
import { uiCancelled, uiErrorFrom, uiFailure, uiSuccess } from "./result.mjs";

export const UI_JOB_STATE = Object.freeze({
	queued: "queued",
	running: "running",
	succeeded: "succeeded",
	failed: "failed",
	cancelled: "cancelled",
});

/** What a cancel request can still mean at the current point in a job. */
export const UI_JOB_CANCEL_MODE = Object.freeze({
	abort: "abort",
	stopWaiting: "stop-waiting",
	settled: "settled",
});

const text = (value) => (typeof value === "string" ? value.trim() : "");
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isResult = (value) => record(value) && typeof value.ok === "boolean" && value.meta !== undefined;
const done = (state) => state === UI_JOB_STATE.succeeded || state === UI_JOB_STATE.failed || state === UI_JOB_STATE.cancelled;
const abortResult = (meta) => uiCancelled({ meta, message: "The job was cancelled before it made a durable change." });
const targetSnapshot = (target) => {
	if (text(target) !== "") return text(target);
	if (!record(target)) return undefined;
	return Object.freeze({ ...target });
};

const withJobMeta = (result, job, fallbackMeta = {}) => {
	if (!isResult(result)) return uiSuccess(result, { meta: { ...fallbackMeta, jobId: job.id } });
	const meta = { ...fallbackMeta, ...(record(result.meta) ? result.meta : {}), jobId: job.id };
	if (result.ok) return uiSuccess(result.data, { meta, notices: Array.isArray(result.notices) ? result.notices : [] });
	return uiFailure(result.error, {
		meta,
		...(result.confirmation === undefined ? {} : { confirmation: result.confirmation }),
	});
};

/**
 * @typedef {{
 *   id: string,
 *   kind: string,
 *   target?: string | object,
 *   state: "queued" | "running" | "succeeded" | "failed" | "cancelled",
 *   createdAt: string,
 *   startedAt?: string,
 *   finishedAt?: string,
 *   progress?: { current?: number, total?: number, message?: string },
 *   cancellation: { mode: "abort" | "stop-waiting" | "settled", requested: boolean, meaningful: boolean },
 *   effect?: object,
 *   result?: import("./contracts.mjs").UiResult<any>,
 * }} UiJob
 */

/**
 * Make cancellable jobs with a small inspectable lifecycle. `markCommitted` changes cancellation from "abort" to
 * "stop-waiting": a later cancel stops follow-up waiting, but may not rewrite history by reporting a completed
 * durable write as undone. `events`, when supplied, receives immutable `job.*` facts for Screen caches.
 */
export function createJobManager({ events, now = () => Date.now(), nextId } = {}) {
	let serial = 0;
	const jobs = new Map();
	const makeId = () => (typeof nextId === "function" ? String(nextId()) : `job-${++serial}`);
	const at = () => new Date(now()).toISOString();
	const cancellationSnapshot = (job) => Object.freeze({
		mode: done(job.state) ? UI_JOB_CANCEL_MODE.settled : job.cancelMode,
		requested: job.cancelRequested === true,
		meaningful: !done(job.state),
	});
	const snapshot = (job) => Object.freeze({
		id: job.id,
		kind: job.kind,
		...(job.target === undefined ? {} : { target: job.target }),
		state: job.state,
		createdAt: job.createdAt,
		...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
		...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
		...(job.progress === undefined ? {} : { progress: Object.freeze({ ...job.progress }) }),
		cancellation: cancellationSnapshot(job),
		// Kept as a compact convenience for a status strip or a job drawer. The richer cancellation fact says whether
		// cancellation aborts an uncommitted operation or merely stops waiting after a committed effect.
		cancellable: !done(job.state),
		...(job.effect === undefined ? {} : { effect: Object.freeze({ ...job.effect }) }),
		...(job.result === undefined ? {} : { result: job.result }),
	});
	const emit = (type, job) => events?.publish(type, { job: snapshot(job) });

	const get = (id) => {
		const job = jobs.get(String(id));
		return job === undefined ? undefined : snapshot(job);
	};

	const cancel = (id) => {
		const job = jobs.get(String(id));
		if (job === undefined || done(job.state) || job.cancelRequested === true) return false;
		job.cancelRequested = true;
		job.controller.abort();
		emit("job.cancel-requested", job);
		return true;
	};

	const start = ({ kind, target, run, meta = {} } = {}) => {
		const label = text(kind);
		if (label === "") throw new TypeError("A job needs a non-empty kind.");
		if (typeof run !== "function") throw new TypeError("A job needs a run function.");
		if (!record(meta)) throw new TypeError("A job metadata value must be an object.");
		const targetValue = targetSnapshot(target);
		const controller = new AbortController();
		const job = {
			id: makeId(),
			kind: label,
			...(targetValue === undefined ? {} : { target: targetValue }),
			state: UI_JOB_STATE.queued,
			createdAt: at(),
			controller,
			cancelMode: UI_JOB_CANCEL_MODE.abort,
			cancelRequested: false,
		};
		jobs.set(job.id, job);
		emit("job.queued", job);

		const reportProgress = (progress = {}) => {
			if (done(job.state) || !record(progress)) return false;
			const current = Number.isFinite(progress.current) ? progress.current : undefined;
			const total = Number.isFinite(progress.total) ? progress.total : undefined;
			const message = text(progress.message);
			job.progress = {
				...(current === undefined ? {} : { current }),
				...(total === undefined ? {} : { total }),
				...(message === "" ? {} : { message }),
			};
			emit("job.progress", job);
			return true;
		};
		const markCommitted = (effect = {}) => {
			if (done(job.state) || job.cancelMode === UI_JOB_CANCEL_MODE.stopWaiting) return false;
			job.cancelMode = UI_JOB_CANCEL_MODE.stopWaiting;
			job.effect = record(effect) ? { ...effect, committed: true } : { committed: true };
			emit("job.committed", job);
			return true;
		};

		const jobMeta = () => ({ ...meta, jobId: job.id, at: at() });
		const promise = Promise.resolve()
			.then(async () => {
				if (controller.signal.aborted) return abortResult(jobMeta());
				job.state = UI_JOB_STATE.running;
				job.startedAt = at();
				emit("job.started", job);
				const result = await run({
					id: job.id,
					signal: controller.signal,
					reportProgress,
					markCommitted,
					cancellation: () => cancellationSnapshot(job),
				});
				if (controller.signal.aborted && job.cancelMode === UI_JOB_CANCEL_MODE.abort) return abortResult(jobMeta());
				return withJobMeta(result, job, jobMeta());
			})
			.catch((error) => controller.signal.aborted && job.cancelMode === UI_JOB_CANCEL_MODE.abort
				? abortResult(jobMeta())
				: uiFailure(uiErrorFrom(error, {
					code: UI_ERROR_CODE.internal,
					kind: UI_ERROR_KIND.internal,
					message: "Cartographer could not complete that job.",
					retryable: false,
				}), { meta: jobMeta() }))
			.then((result) => {
				job.result = withJobMeta(result, job, jobMeta());
				job.state = job.result.ok ? UI_JOB_STATE.succeeded : job.result.error.kind === UI_ERROR_KIND.cancelled ? UI_JOB_STATE.cancelled : UI_JOB_STATE.failed;
				job.finishedAt = at();
				emit(`job.${job.state}`, job);
				return job.result;
			});

		return Object.freeze({ id: job.id, cancel: () => cancel(job.id), promise, snapshot: () => get(job.id) });
	};

	return Object.freeze({
		start,
		cancel,
		get,
		list: () => [...jobs.values()].map(snapshot),
	});
}
