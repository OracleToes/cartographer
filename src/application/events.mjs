// A tiny application event stream. It is deliberately independent of terminal or screen state: consumers invalidate
// projections from these durable-operation facts, while each adapter decides how and when it redraws.

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * @typedef {{ id: number, type: string, at: string, payload: object }} UiEvent
 */

/**
 * Publish immutable application facts without letting one presentation listener interrupt another.
 * `now` and `nextId` are injectable so application tests can prove event order without observing wall time.
 */
export function createApplicationEvents({ now = () => Date.now(), nextId } = {}) {
	let serial = 0;
	const listeners = new Set();
	const eventId = () => (typeof nextId === "function" ? nextId() : ++serial);

	const publish = (type, payload = {}) => {
		const name = text(type);
		if (name === "") throw new TypeError("An application event needs a non-empty type.");
		if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("An application event payload must be an object.");
		const event = Object.freeze({
			id: eventId(),
			type: name,
			at: new Date(now()).toISOString(),
			payload: Object.freeze({ ...payload }),
		});
		for (const listener of [...listeners]) {
			try { listener(event); }
			catch {
				// A stale screen or terminal listener must not turn a completed durable action into a failed one.
			}
		}
		return event;
	};

	return Object.freeze({
		/** Subscribe to later events. Calling the returned function more than once is harmless. */
		subscribe(listener) {
			if (typeof listener !== "function") throw new TypeError("An application event listener must be a function.");
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		publish,
	});
}
