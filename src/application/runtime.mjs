// Live runtime projections need the session's conversation and engine, but they still belong behind the application
// boundary. This adapter gathers that volatile state only after a query has yielded from the UI stack; screen and
// terminal render the returned data rather than asking one another for formatted command output.
import { modelContextWindow } from "../config.mjs";
import { stateBlock } from "../state.mjs";

const positiveInteger = (value) => Number.isInteger(value) && value > 0 ? value : undefined;
const finite = (value) => Number.isFinite(value) ? value : undefined;

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
 * Build the narrow live dependency needed by the terminal and Runtime status strip. It reports facts only: the
 * terminal decides how to describe a resting or working agent, while this reader keeps conversation, shell, wake,
 * and model-manager access out of display code.
 * @param {{
 *   main?: { id?: string, context?: (context: any) => Promise<{ messages?: readonly any[] }> },
 *   context?: any,
 *   engine?: { usedBy?: (conversationId: string) => number | undefined },
 *   windows?: { list?: (tail?: number) => any[] },
 *   wakes?: { list?: () => any[], nextDue?: () => number | undefined },
 *   model?: () => Promise<{ modelId?: string } | undefined> | { modelId?: string } | undefined,
 * }} options
 */
export function createRuntimeStatusReader({ main, context, engine, windows, wakes, model } = {}) {
	return async ({ signal } = {}) => {
		if (signal?.aborted === true) return undefined;
		const view = typeof main?.context === "function" ? await main.context(context) : undefined;
		if (signal?.aborted === true) return undefined;
		const current = typeof model === "function" ? await model() : undefined;
		if (signal?.aborted === true) return undefined;
		const listedWindows = typeof windows?.list === "function" ? windows.list(0) : [];
		const listedWakes = typeof wakes?.list === "function" ? wakes.list() : [];
		const nextWakeDue = typeof wakes?.nextDue === "function" ? finite(wakes.nextDue()) : undefined;
		// `engine.usedBy` is the same authoritative accounting the terminal formerly handed directly to Screen. Read it
		// here, after the facade's yield, so even a mid-stream context count reaches the strip as a typed snapshot.
		const contextSize = typeof engine?.usedBy === "function" && typeof main?.id === "string" ? finite(engine.usedBy(main.id)) : undefined;
		return {
			messages: Array.isArray(view?.messages) ? view.messages : [],
			...(contextSize === undefined ? {} : { contextSize }),
			windows: Array.isArray(listedWindows) ? listedWindows : [],
			wakes: Array.isArray(listedWakes) ? listedWakes : [],
			...(typeof current?.modelId === "string" && current.modelId !== "" ? { modelId: current.modelId } : {}),
			...(nextWakeDue === undefined ? {} : { nextWakeDue }),
		};
	};
}

/**
 * Build the tiny live activity snapshot the screen needs while it paints its strip and composer. Question text and
 * task internals remain with the terminal lifecycle; rendering needs only that an answer is pending, when it began,
 * and whether private task work currently owns input.
 * @param {{ asks?: { pending?: () => { since?: number } | undefined }, activeTask?: () => unknown }} options
 */
export function createRuntimeActivityReader({ asks, activeTask } = {}) {
	return async ({ signal } = {}) => {
		if (signal?.aborted === true) return undefined;
		const pending = typeof asks?.pending === "function" ? asks.pending() : undefined;
		const task = typeof activeTask === "function" ? activeTask() : undefined;
		if (signal?.aborted === true) return undefined;
		return {
			...(pending === undefined ? {} : { question: { ...(finite(pending?.since) === undefined ? {} : { since: pending.since }) } }),
			taskActive: task !== undefined,
		};
	};
}

const modelName = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const listedModel = (entry) => {
	const id = modelName(entry?.id);
	if (id === undefined) return undefined;
	const contextWindow = modelContextWindow(entry);
	return { id, ...(contextWindow === undefined ? {} : { contextWindow }) };
};
/**
 * Build the model route projection used by the terminal's model command and connection status. The deferred result
 * carries only known route names, active identity, advertised context limits, and a safe listing issue—not provider
 * payloads or a model request.
 * @param {{ models?: { current?: () => Promise<{ modelId?: string } | undefined> | { modelId?: string } | undefined, inspect?: () => Promise<{ listing?: { entries?: any[] }, limits?: object } | undefined>, known?: () => string[], ready?: () => boolean } }} options
 */
export function createRuntimeModelsReader({ models } = {}) {
	return async ({ signal } = {}) => {
		if (signal?.aborted === true || models === undefined) return undefined;
		const listedKnown = typeof models.known === "function" ? models.known() : [];
		const known = (Array.isArray(listedKnown) ? listedKnown : []).map(modelName).filter((id) => id !== undefined);
		// Route discovery only says that a server listed a name. Readiness is a separate session fact set after the
		// native-GBNF proof succeeds; expose the settled boolean without asking the model manager to do more work.
		const ready = typeof models.ready === "function" ? models.ready() === true : undefined;
		let inspected;
		let issue;
		try {
			if (typeof models.inspect === "function") inspected = await models.inspect();
		} catch (error) {
			issue = { message: String(error?.message ?? error) };
		}
		if (signal?.aborted === true) return undefined;
		let current;
		try {
			current = typeof models.current === "function" ? await models.current() : undefined;
		} catch (error) {
			issue ??= { message: String(error?.message ?? error) };
		}
		if (signal?.aborted === true) return undefined;
		const entries = Array.isArray(inspected?.listing?.entries) ? inspected.listing.entries.map(listedModel).filter((entry) => entry !== undefined) : [];
		const modelsListed = entries.length > 0
			? entries
			: [...new Set(known)].map((id) => ({ id }));
		const currentId = modelName(current?.modelId);
		if (currentId !== undefined && !modelsListed.some((entry) => entry.id === currentId)) modelsListed.push({ id: currentId });
		return {
			...(currentId === undefined ? {} : { currentId }),
			models: modelsListed,
			...(ready === undefined ? {} : { ready }),
			...(inspected?.limits === undefined ? {} : { limits: inspected.limits }),
			...(issue === undefined ? {} : { issue }),
		};
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
 *   wakes?: { list?: () => any[], lines?: () => string[] },
 *   preview?: (options?: { signal?: AbortSignal }) => Promise<any> | any,
 * }} options
 */
export function createRuntimeViewReader({ engine, windows, wakes, preview } = {}) {
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
		wakes() {
			const listed = typeof wakes?.list === "function" ? wakes.list() : [];
			const lines = typeof wakes?.lines === "function" ? wakes.lines() : [];
			return { wakes: Array.isArray(listed) ? listed : [], lines: Array.isArray(lines) ? lines : [] };
		},
		async preview({ signal } = {}) {
			if (signal?.aborted === true || typeof preview !== "function") return undefined;
			const value = await preview({ signal });
			return signal?.aborted === true ? undefined : value;
		},
	});
}
