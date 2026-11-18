// Live runtime projections need the session's conversation and engine, but they still belong behind the application
// boundary. This adapter gathers that volatile state only after a query has yielded from the UI stack; screen and
// terminal render the returned data rather than asking one another for formatted command output.
import { stateBlock } from "../state.mjs";

const positiveInteger = (value) => Number.isInteger(value) && value > 0 ? value : undefined;

/**
 * Build the narrow live dependency needed by Runtime → Current accounting.
 *
 * `main.context` is intentionally injected by composition: the application service never owns a Durable
 * conversation. `engine.sizes` remains the authoritative accounting algorithm and owns the matching state block.
 * @param {{
 *   main?: { context?: (context: any) => Promise<{ messages?: readonly any[] }> },
 *   context?: any,
 *   engine?: { sizes?: (messages: readonly any[], state: string) => object },
 *   brainDir: string,
 *   root: string,
 *   config?: object,
 *   runner?: any,
 *   contextWindow?: number | (() => number),
 * }} options
 */
export function createRuntimeContextReader({ main, context, engine, brainDir, root, config = {}, runner, contextWindow }) {
	return async ({ signal } = {}) => {
		if (signal?.aborted === true) return undefined;
		if (typeof main?.context !== "function" || typeof engine?.sizes !== "function") return undefined;
		const view = await main.context(context);
		if (signal?.aborted === true) return undefined;
		const messages = Array.isArray(view?.messages) ? view.messages : [];
		// stateBlock reads the same current books that the next agent turn would read. It is deliberately calculated
		// here, after the facade's asynchronous yield, rather than in a screen render or terminal key handler.
		const state = stateBlock(brainDir, runner, { root, config });
		const sizes = engine.sizes(messages, state);
		const reportedWindow = positiveInteger(typeof contextWindow === "function" ? contextWindow() : contextWindow);
		return { messages, sizes, ...(reportedWindow === undefined ? {} : { contextWindow: reportedWindow }) };
	};
}

/**
 * Deferred session snapshots for Runtime views. The engine's request-window reader currently calculates collapse
 * state from durable context, and shell managers expose mutable process state, so neither may be called from a
 * screen render/key stack. Composition supplies both as narrow live dependencies; this adapter owns only their
 * presentation-safe snapshots.
 * @param {{
 *   engine?: { window?: (scope?: "main" | "newest") => any },
 *   windows?: { list?: (tail?: number) => any[], linesFrom?: (name: string, from: number, options?: { partial?: boolean }) => string[] },
 *   preview?: (options?: { signal?: AbortSignal }) => Promise<any> | any,
 * }} options
 */
export function createRuntimeViewReader({ engine, windows, preview } = {}) {
	const list = (tail) => {
		const listed = typeof windows?.list === "function" ? windows.list(tail) : [];
		return Array.isArray(listed) ? listed : [];
	};
	return Object.freeze({
		sent(scope = "newest") {
			return typeof engine?.window === "function" ? engine.window(scope) : undefined;
		},
		shells({ tail = 0 } = {}) {
			return { windows: list(tail) };
		},
		shellOutput({ name, tail = 0 } = {}) {
			const available = list(0).filter((window) => window?.state !== "gone");
			const window = available.find((candidate) => candidate.name === name) ?? available.at(-1);
			const lines = window !== undefined && typeof windows?.linesFrom === "function"
				? windows.linesFrom(window.name, 0, { partial: true }).slice(-tail)
				: [];
			return { ...(window === undefined ? {} : { window }), lines };
		},
		async preview({ signal } = {}) {
			if (signal?.aborted === true || typeof preview !== "function") return undefined;
			const value = await preview({ signal });
			return signal?.aborted === true ? undefined : value;
		},
	});
}
