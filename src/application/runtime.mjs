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
