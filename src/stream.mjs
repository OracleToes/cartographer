// The stream freeze behind Ctrl-V. Pausing must stop the model where it stands — and, if nothing else is
// written, let the very same reply go on when the pause is lifted.
//
// pi-ai's request runner starts the network read as soon as the provider is called and buffers events in
// memory, so refusing to pull from the provider's event stream only buffers the whole reply. The freeze
// therefore sits at the response body: the provider's `fetch` is wrapped (the same pattern the prefill and
// trace watchers use), and the SDK is handed a body stream whose `pull()` waits while the gate is frozen.
// While it waits, nothing reads the upstream socket: the kernel buffers fill, TCP pushes back, and the
// server stops mid-token. Opening the gate lets the same `pull()` continue and the same HTTP response flow
// on, token for token — there is no second request and nothing is replayed.
//
// The gate is per session, and covers every conversation it serves (the main agent and any task), so
// everything that may reach the model is held, not one stream.

/**
 * @returns {{
 *   watchProvider(provider: object): void,
 *   freeze(): boolean,
 *   resume(): boolean,
 *   abandon(): void,
 *   frozen: () => boolean,
 *   live: () => boolean,
 * }} `freeze` holds a live stream and reports whether there was one (false: the pause lands on a round of tool calls instead).
 *   `resume` lets a held stream go on and reports whether there was one. `abandon` lets go of every held stream:
 *   the model's connection is torn down and the run ends aborted (the interrupt paths — a typed line or command,
 *   Ctrl-X, the repeat cut). `frozen` reports a held stream; `live` any stream in flight, held or not.
 */
export function createStreamFreeze() {
	let frozen = false;
	/** The body streams currently in flight, each with its own dying mark. */
	const bodies = new Set();
	/** Resolvers waiting for the freeze to lift or the streams to be abandoned. */
	let waiters = [];
	const settled = () => {
		const list = waiters;
		waiters = [];
		for (const resolve of list) resolve();
	};
	// Register first, then re-check: the freeze can lift between pull's `frozen` check and our push, and a
	// waiter pushed after its signal was consumed would sleep forever. Resolving early is safe — pull loops
	// back and parks again if the gate is frozen.
	const wait = () => new Promise((resolve) => {
		waiters.push(resolve);
		if (!frozen) resolve();
	});

	const ABORT = () => Object.assign(new Error("The pause let go of the stream."), { name: "AbortError" });

	const wrap = (provider, name) => {
		const inner = provider[name]?.bind(provider);
		if (inner === undefined) return;
		provider[name] = (model, request, options = {}) =>
			inner(model, request, {
				...options,
				fetch: async (url, init) => {
					const upstream = await (options.fetch ?? globalThis.fetch)(url, init);
					const body = upstream?.body;
					if (upstream === undefined || upstream === null || body === null || typeof body.getReader !== "function") return upstream;
					return new Response(gatedBody(body), { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
				},
			});
	};
	/** A body that reads upstream only while the gate is open; held mid-stream while it is frozen. */
	const gatedBody = (upstream) => {
		const reader = upstream.getReader();
		const state = { dying: false };
		bodies.add(state);
		const done = () => bodies.delete(state);
		return new ReadableStream({
			async pull(controller) {
				for (;;) {
					if (state.dying) {
						try { await reader.cancel(); } catch { /* the server is already gone */ }
						controller.error(ABORT());
						done();
						return;
					}
					if (frozen) { await wait(); continue; }
					let reading;
					try {
						reading = await reader.read();
					} catch (error) {
						controller.error(error);
						done();
						return;
					}
					if (reading.done) {
						controller.close();
						done();
						return;
					}
					controller.enqueue(reading.value);
					if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
				}
			},
			async cancel(reason) {
				state.dying = true;
				try { await reader.cancel(reason); } catch { /* the server is already gone */ }
				done();
			},
		});
	};

	return {
		watchProvider(provider) {
			wrap(provider, "stream");
			wrap(provider, "streamSimple");
		},
		freeze: () => (bodies.size > 0 ? ((frozen = true), true) : false),
		resume: () => (frozen ? ((frozen = false), settled(), true) : false),
		abandon() {
			for (const state of bodies) state.dying = true;
			frozen = false;
			settled();
		},
		frozen: () => frozen,
		live: () => bodies.size > 0,
	};
}
