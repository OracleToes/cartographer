// Seeing exactly what was sent to, and exactly what came back from, the model server.
//
// CARTO_TRACE turns it on:
//   CARTO_TRACE=1                    → <project>/.atlas/export/trace-<time>.jsonl
//   CARTO_TRACE=/path/to/file.jsonl  → that file; a relative path resolves from the project root
//
// One JSON line per call to the model: the request exactly as it went on the wire (the body may carry
// `return_progress`, which the prefill watcher adds), and the raw response body as it came back — the
// SSE stream, unparsed. The /models health check before the session begins is not traced. A trace file
// can be large — every request holds a whole context — and it is not part of the brain's state: nothing
// reads it, and it is yours to keep, share or delete. A trace that cannot be written is skipped, never an error.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const two = (n) => String(n).padStart(2, "0");
const fileStamp = () => {
	const date = new Date();
	return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
};

/**
 * Where CARTO_TRACE points. Undefined when tracing is off. With a file path the parent folders are created.
 * @param {{ env?: NodeJS.ProcessEnv, root?: string, brainDir?: string }} input
 */
export function traceFile({ env = process.env, root, brainDir } = {}) {
	const raw = env.CARTO_TRACE?.trim();
	if (!raw) return undefined;
	if (/^(1|true|yes|on)$/i.test(raw)) return brainDir === undefined ? undefined : join(brainDir, "export", `trace-${fileStamp()}.jsonl`);
	return isAbsolute(raw) ? raw : resolve(root ?? process.cwd(), raw);
}

const safeParse = (text) => {
	try {
		return text === undefined ? undefined : JSON.parse(text);
	} catch {
		return undefined;
	}
};

function write(file, record) {
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify(record)}\n`);
	} catch {
		// A trace that cannot be written must not break the run.
	}
}

/**
 * Wrap a provider so every call to the model appends one JSON line to `file`. Wrapped like the prefill
 * watcher; wrapping after it puts the trace inside the prefill watcher's fetch chain — either order terminates.
 * @param {any} provider  the provider from pi-ai's createProvider, as in src/harness.mjs
 * @param {string} file
 */
export function watchTrace(provider, file) {
	let serial = 0;
	const wrap = (name) => {
		const inner = provider[name]?.bind(provider);
		if (inner === undefined) return;
		provider[name] = (model, request, options = {}) => {
			const id = ++serial;
			return inner(model, request, {
				...options,
				fetch: async (url, init = {}) => {
					const began = Date.now();
					const body = init.body === undefined ? undefined : String(init.body);
					const response = await (options.fetch ?? globalThis.fetch)(url, init);
					/** @type {Record<string, any>} */
					const record = {
						at: began,
						id,
						url: String(url),
						method: init.method ?? "GET",
						bytesSent: body === undefined ? 0 : Buffer.byteLength(body),
						request: safeParse(body) ?? body,
					};
					const done = (text, error) => {
						record.status = response.status;
						record.statusText = response.statusText;
						record.ms = Date.now() - began;
						record.response = text;
						if (error !== undefined) record.error = String(error);
						write(file, record);
					};
					if (response.body === null) {
						done(undefined);
						return response;
					}
					if (typeof response.body.tee === "function") {
						// The stream is read twice: once by pi-ai, once for the trace.
						const [mine, theirs] = response.body.tee();
						(async () => {
							const decoder = new TextDecoder();
							let text = "";
							try {
								for await (const chunk of mine) text += decoder.decode(chunk, { stream: true });
								text += decoder.decode();
							} catch (error) {
								done(text, error);
								return;
							}
							done(text);
						})().catch(() => done("", "the trace reader failed"));
						return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
					}
					// A body that cannot be teed: read it, log it, hand on one built from what was read.
					try {
						const text = await response.text();
						done(text);
						return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
					} catch (error) {
						done(undefined, error);
						throw error;
					}
				},
			});
		};
	};
	wrap("stream");
	wrap("streamSimple");
}
