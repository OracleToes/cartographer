// Cancellable lifecycle ownership for slow application work. Jobs never run in a render or key-dispatch stack:
// their work begins on the next microtask and exposes only safe snapshots and typed UI outcomes.
import { UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";
import { uiCancelled, uiErrorFrom, uiFailure, uiSuccess } from "./result.mjs";

export const UI_JOB_STATE = Object.freeze({
	queued: "queued",
	running: "running",
	succeeded: "succeeded",
	failed: "failed",
	cancelled: "cancelled",
});

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isResult = (value) => value !== null && typeof value === "object" && typeof value.ok === "boolean" && value.meta !== undefined;
const done = (state) => state === UI_JOB_STATE.succeeded || state === UI_JOB_STATE.failed || state === UI_JOB_STATE.cancelled;
const abortResult = (meta) => uiCancelled({ meta, message: "The job was cancelled." });

/**
 * @typedef {{
 *   id: string,
 *   kind: string,
 *   state: "queued" | "running" | "succeeded" | "failed" | "cancelled",
 *   createdAt: string,
 *   startedAt?: string,
 *   finishedAt?: string,
 *   progress?: { current?: number, total?: number, message?: string },
 *   result?: import("./contracts.mjs").UiResult<any>,
 * }} UiJob
 */

/**
 * Make cancellable jobs with a small inspectable lifecycle. `events`, when supplied, receives `job.*` facts that
 * query stores can use to invalidate stale projections; no listener is needed for a job to complete correctly.
 */
export function createJobManager({ events, now = () => Date.now(), nextId } = {}) {
	let serial = 0;
	const jobs = new Map();
	const makeId = () => (typeof nextId === "function" ? String(nextId()) : `job-${++serial}`);
	const at = () => new Date(now()).toISOString();
	const snapshot = (job) => Object.freeze({
		id: job.id,
		kind: job.kind,
		state: job.state,
		createdAt: job.createdAt,
		...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
		...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
		...(job.progress === undefined ? {} : { progress: Object.freeze({ ...job.progress }) }),
		...(job.result === undefined ? {} : { result: job.result }),
	});
	const emit = (type, job) => events?.publish(type, { job: snapshot(job) });

	const get = (id) => {
		const job = jobs.get(String(id));
		return job === undefined ? undefined : snapshot(job);
	};

	const cancel = (id) => {
		const job = jobs.get(String(id));
		if (job === undefined || done(job.state)) return false;
		job.controller.abort();
		return true;
	};

	const start = ({ kind, run, meta = {} } = {}) => {
		const label = text(kind);
		if (label === "") throw new TypeError("A job needs a non-empty kind.");
		if (typeof run !== "function") throw new TypeError("A job needs a run function.");
		if (meta === null || typeof meta !== "object" || Array.isArray(meta)) throw new TypeError("A job metadata value must be an object.");
		const controller = new AbortController();
		const job = { id: makeId(), kind: label, state: UI_JOB_STATE.queued, createdAt: at(), controller };
		jobs.set(job.id, job);
		emit("job.queued", job);

		const reportProgress = (progress = {}) => {
			if (done(job.state) || progress === null || typeof progress !== "object" || Array.isArray(progress)) return false;
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

		const promise = Promise.resolve()
			.then(async () => {
				if (controller.signal.aborted) return abortResult({ ...meta, jobId: job.id, at: now() });
				job.state = UI_JOB_STATE.running;
				job.startedAt = at();
				emit("job.started", job);
				const result = await run({ id: job.id, signal: controller.signal, reportProgress });
				if (controller.signal.aborted) return abortResult({ ...meta, jobId: job.id, at: now() });
				return isResult(result) ? result : uiSuccess(result, { meta: { ...meta, jobId: job.id, at: now() } });
			})
			.catch((error) => controller.signal.aborted
				? abortResult({ ...meta, jobId: job.id, at: now() })
				: uiFailure(uiErrorFrom(error, {
					code: UI_ERROR_CODE.internal,
					kind: UI_ERROR_KIND.internal,
					message: "Cartographer could not complete that job.",
					retryable: false,
				}), { meta: { ...meta, jobId: job.id, at: now() } }))
			.then((result) => {
				job.result = result;
				job.state = result.ok ? UI_JOB_STATE.succeeded : result.error.kind === UI_ERROR_KIND.cancelled ? UI_JOB_STATE.cancelled : UI_JOB_STATE.failed;
				job.finishedAt = at();
				emit(`job.${job.state}`, job);
				return result;
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
