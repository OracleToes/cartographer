// The small async cache behind durable screen projections.
//
// A renderer only reads its last settled value. This scheduler owns the async edge: one request per cache key,
// AbortController cancellation, stale-settlement rejection, cached-error retry, and invalidation after an action.
// It deliberately knows nothing about a view or a durable reader, so the full screen can keep those concerns apart.

const cancelled = (result) => result?.ok === false && result.error?.kind === "cancelled";
const failure = (result) => result?.error ?? { message: "Cartographer returned an invalid projection result." };
const thrown = (error) => ({ message: error?.message ?? String(error) });

/**
 * @param {{ now?: () => number, onSettled?: (id: string, state: object) => void }} options
 */
export function createProjectionScheduler({ now = () => Date.now(), onSettled = () => {} } = {}) {
	const entries = new Map();
	const idle = () => ({ generation: 0, loading: false });
	const get = (id) => entries.get(id) ?? idle();
	const notify = (id, state) => {
		try { onSettled(id, state); } catch { /* A display refresh cannot corrupt the cache that just settled. */ }
	};
	const settle = (id, generation, result) => {
		const current = entries.get(id);
		if (current?.generation !== generation) return false;
		let next;
		if (result?.ok === true) {
			next = { generation, loading: false, data: result.data, requestedAt: current.requestedAt, updatedAt: now() };
		} else if (cancelled(result)) {
			next = { ...current, loading: false, controller: undefined };
		} else {
			next = { ...current, loading: false, controller: undefined, error: failure(result) };
		}
		entries.set(id, next);
		notify(id, next);
		return true;
	};
	const settleThrown = (id, generation, error) => {
		const current = entries.get(id);
		if (current?.generation !== generation) return false;
		const next = { ...current, loading: false, controller: undefined, error: thrown(error) };
		entries.set(id, next);
		notify(id, next);
		return true;
	};
	/** Begin a projection read. A forced read aborts and supersedes an older one; ordinary refreshes leave it alone. */
	const refresh = (id, request, { force = false } = {}) => {
		if (typeof request !== "function") throw new TypeError("A projection refresh needs a request function.");
		const prior = get(id);
		if (prior.loading && !force) return false;
		prior.controller?.abort();
		const generation = prior.generation + 1;
		const controller = new AbortController();
		entries.set(id, { ...prior, generation, loading: true, error: undefined, controller, requestedAt: now() });
		Promise.resolve()
			.then(() => request({ signal: controller.signal }))
			.then((result) => settle(id, generation, result), (error) => settleThrown(id, generation, error));
		return true;
	};
	/** Stop one active read and make any late result stale. Cached data remains available to its view. */
	const cancel = (id) => {
		const current = entries.get(id);
		if (current?.loading !== true) return false;
		current.controller?.abort();
		entries.set(id, { ...current, generation: current.generation + 1, loading: false, controller: undefined });
		return true;
	};
	/** Invalidate settled or running views after a durable action. The next visible refresh owns their retry. */
	const invalidate = () => {
		for (const [id, current] of entries) {
			current.controller?.abort();
			entries.set(id, { ...current, generation: current.generation + 1, loading: false, controller: undefined, error: undefined });
		}
	};
	return Object.freeze({ get, refresh, cancel, invalidate, keys: () => [...entries.keys()] });
}
