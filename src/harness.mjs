// Opens one project's session: the Durable harness over `.brain/session.sqlite`,
// the model provider, and the tools with the rule of who may call what.
import { contextWindowLimits, modelContextWindow, POLICY } from "./config.mjs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, GenerationTask, Harness, hook, ROOT_CONVERSATION_ID, section, ToolTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, LOOP_MAX, LOOP_STOP, REFUSALS, REPLIES_LEFT, STILL_TASK, systemPrompt } from "./prompt.mjs";

import { createAsks } from "./asks.mjs";
import { askTool } from "./tools/ask.mjs";
import { loadPrepend } from "./prepend.mjs";
import { bookTool } from "./tools/book.mjs";
import { readTool } from "./tools/read.mjs";
import { shelfTool } from "./tools/shelf.mjs";
import { returnTool } from "./tools/return.mjs";
import { stamp } from "./time.mjs";
import { chatTool } from "./tools/chat.mjs";
import { isFront, loadContext, noteChat, noteUserMessages } from "./context.mjs";
import { createEngine } from "./engine.mjs";
import { isNoChat, isNote, noted, noteKey } from "./wake.mjs";
import { planRequest, prepareRequest } from "./request.mjs";
import { bridgeRequestSources } from "./request-sources.mjs";
import { beginReadBatch, readBatchCheck } from "./read-batch.mjs";
import { loadTop, pin } from "./top.mjs";
import { changeTools } from "./tools/change.mjs";
import { lookTools } from "./tools/look.mjs";
import { shellTool } from "./tools/shell.mjs";
import { consultTool } from "./tools/consult.mjs";
import { createConferenceExtension } from "./conference-extension.mjs";
import { endConference, findConferenceByCaller } from "./conference.mjs";
import { taskTool } from "./tools/task.mjs";
import { sleepTool, wakeTool } from "./tools/wake.mjs";
import { createWakes } from "./wakes.mjs";
import { createWindows } from "./windows.mjs";
import { cleanupStaleStages } from "./stage.mjs";
import { traceFile, watchTrace } from "./trace.mjs";
import { createStreamFreeze } from "./stream.mjs";
import { loadAtlas, observeAtlas, saveAtlas } from "./atlas.mjs";
import { USER_NAME, USER_HEAD } from "./user.mjs";
import { NativeGrammarError, requireNativeGrammarCapability } from "./native-grammar.mjs";

const PROVIDER = "local";
const CHANGE = new Set(["write", "edit", "rm"]);

/** A model-server transport failure is recoverable at the terminal: Cartographer itself stays usable offline. */
export class ModelServerUnavailableError extends Error {
	constructor(server, detail) {
		super(`Could not connect to the model server at ${server}${detail ? ` (${detail})` : ""}. Cartographer is still open; start or repair the server, then send a message to retry.`);
		this.name = "ModelServerUnavailableError";
		this.server = server;
	}
}

/** A server that did answer /models must not silently accept a misspelled configured route. */
export class ModelRouteError extends Error {
	constructor(modelId, models) {
		super(`The model server has no model named "${modelId}". It has: ${models.join(", ")}.`);
		this.name = "ModelRouteError";
	}
}

const connectionDetail = (error) => {
	const code = error?.cause?.code;
	if (typeof code === "string" && code !== "") return code;
	if (error?.name === "TimeoutError") return "timed out";
	const message = typeof error?.message === "string" ? error.message : String(error ?? "");
	return message === "" ? undefined : message;
};

/**
 * Read a model listing without ever waking a model. An unavailable endpoint is a distinct, recoverable terminal
 * state; a 404/non-listing endpoint remains compatible with the first native request deciding its route.
 */
async function listedModels(server) {
	let response;
	try {
		response = await fetch(`${server}/models`, { signal: AbortSignal.timeout(POLICY.timing.modelCheckMs) });
	} catch (error) {
		throw new ModelServerUnavailableError(server, connectionDetail(error));
	}
	if (!response.ok) return undefined;
	const body = await response.json().catch(() => undefined);
	const entries = Array.isArray(body?.data) ? body.data.filter((entry) => typeof entry?.id === "string") : [];
	return { entries, models: entries.map((entry) => entry.id) };
}

const listedModel = (listing, modelId) => {
	if (listing === undefined) return undefined;
	const exact = listing.entries.find((entry) => entry.id === modelId);
	// A bare llama-server reports its filename but accepts the configured route name.
	const lone = listing.entries.length === 1 && listing.entries[0].owned_by === "llamacpp" ? listing.entries[0] : undefined;
	return exact ?? lone;
};

const unavailableFromNativeGrammar = (server, error) => {
	if (!(error instanceof NativeGrammarError)) return undefined;
	const record = error.record;
	if (record?.transport !== undefined) return new ModelServerUnavailableError(server, connectionDetail(record.transport));
	if (Number.isInteger(record?.response?.status) && record.response.status >= 500) return new ModelServerUnavailableError(server, `HTTP ${record.response.status}`);
	return undefined;
};

/**
 * Put native-GRAMMAR verification directly in front of provider transport as a last line of defense. Terminal
 * requests normally await the same gate earlier so their context capacity can be refreshed before payload sizing;
 * this guard keeps direct Harness users and resumed work fail-closed too.
 */
function guardProviderModelRequests(provider, ensureModel) {
	for (const name of ["stream", "streamSimple"]) {
		const inner = provider[name]?.bind(provider);
		if (inner === undefined) continue;
		provider[name] = (model, request, options = {}) =>
			inner(model, request, {
				...options,
				onPayload: async (payload, currentModel) => {
					await ensureModel(currentModel?.id ?? model?.id);
					return await options.onPayload?.(payload, currentModel);
				},
			});
	}
}

/** Typing into a shell window: a command, or a line of input for the program that runs there. */
const types = (call) => call.name === "shell" && (call.arguments?.action === undefined || call.arguments?.action === POLICY.enums.shellAction.run || call.arguments?.action === POLICY.enums.shellAction.send);
/** Tools that belong to the main agent alone, and what a task is told when it calls one. */
// The book tool guards its own books inside the tool (a task may use its context operations);
// the rest of the main agent's tools are wrapped here.
const MAIN_ONLY_TEXT = { task: REFUSALS.taskStartsTask, wake: REFUSALS.taskWakes, sleep: REFUSALS.taskSleeps };
const MAIN_ONLY = MAIN_ONLY_TEXT;

/**
 * Restore the limited execution contract stored with a focus. It is read after a
 * restart, so an inspect focus must remain inspect rather than falling through to
 * a change default. Fields not needed at the authority boundary stay out.
 */
export function runFromBrief(stored) {
	if (stored?.mode !== POLICY.enums.planMode.change && stored?.mode !== POLICY.enums.planMode.look) {
		return { mode: POLICY.enums.planMode.look };
	}
	return {
		mode: stored.mode,
		...(stored.network === true ? { network: true } : {}),
		...(typeof stored.move === "string" ? { move: stored.move } : {}),
		...(Number.isInteger(stored.revision) ? { revision: stored.revision } : {}),
		...(Array.isArray(stored.targets) ? { targets: stored.targets } : {}),
		...(Number.isInteger(stored.turns) ? { turns: stored.turns } : {}),
	};
}

/**
 * What kind of task a conversation is: look or change, and for a change task whether its commands reach the
 * network. The brief entry at the start of the conversation says it (src/tools/task.mjs); `runs` remembers the
 * answer for this run of the program.
 * @returns {Promise<{ mode: "look" | "change", network?: boolean, move?: string, revision?: number, targets?: string[], turns?: number }>}
 */
async function runOf(runs, api, context) {
	const known = runs.get(api.conversationId);
	if (known !== undefined) return known;
	let run = { mode: POLICY.enums.planMode.look };
	let cursor;
	search: for (let page = 0; page < POLICY.limits.taskHistory.apiMaxPages; page++) {
		const result = await api.entries({}, POLICY.limits.taskHistory.apiEntryPage, cursor, context);
		for (const entry of result.items) {
			// Newest first: the task's own entries, then the main conversation's, which hold no brief.
			if (entry.conversationId !== api.conversationId) break search;
			if (entry.kind === "carto.brief") {
				run = runFromBrief(entry.data);
				break search;
			}
		}
		cursor = result.next;
		if (cursor === undefined) break;
	}
	runs.set(api.conversationId, run);
	return run;
}

/**
 * @param {{ root: string, brainDir: string, config: ReturnType<typeof import("./config.mjs").loadConfig>, runner: ReturnType<typeof import("./sandbox.mjs").createRunner> }} input
 *   runner: how commands run in this session; the terminal changes it when the user types /bwrap
 *   gate: `{ yolo }`, whether declared change moves run without /approve; the terminal changes it when the user types /yolo
 */
export async function openSession({ root, brainDir, config, runner, gate = { yolo: false }, servedModels, servedContextWindow, trace, configuredContextWindow }) {
	const context = BACKGROUND_CONTEXT;
	// Opening a project is deliberately local: a stopped or unavailable model server must not keep Cartographer's
	// terminal, ledger, plan, atlas, or shell controls from opening. The required native-GRAMMAR proof happens just
	// before model work (and is also guarded at provider transport below), never as an eager launch request.
	const windowCeiling = Number.isInteger(configuredContextWindow) && configuredContextWindow > 0 ? configuredContextWindow : config.contextWindow;
	const initialLimits = contextWindowLimits(windowCeiling, servedContextWindow);
	config.contextWindow = initialLimits.usableContextWindow;
	const model = {
		id: config.model,
		name: config.model,
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl: config.server,
		// The server's own reasoning settings apply; none are sent.
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// pi-ai receives the full advertised capacity, matching Cartographer's context plan. It dynamically lowers
		// an individual response ceiling only when the actual prompt is near that real server limit.
		contextWindow: initialLimits.serverContextWindow ?? initialLimits.usableContextWindow,
		maxTokens: config.maxTokens,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			// This OpenAI-compatible endpoint must accept strict function JSON Schemas; selected calls fail closed otherwise.
			supportsStrictMode: true,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
		},
	};
	const models = createModels();
	// Model listings may arrive only after the terminal has opened, or only after llama-swap has started one model.
	// Keep this mutable backing array: pi-ai's provider reads it whenever it resolves a model, so /model can learn
	// routes without requiring a launch-time connection.
	const known = [config.model];
	const providerModels = [model];
	const addKnownModels = (ids) => {
		for (const id of ids ?? []) {
			if (typeof id !== "string" || id === "" || known.includes(id)) continue;
			known.push(id);
			providerModels.push({ ...model, id, name: id, contextWindow: windowCeiling });
		}
	};
	addKnownModels(servedModels);
	const modelRecord = (id) => {
		let found = providerModels.find((entry) => entry.id === id);
		if (found !== undefined) return found;
		addKnownModels([id]);
		return providerModels.find((entry) => entry.id === id);
	};
	const provider = createProvider({
		id: PROVIDER,
		name: "local model server",
		baseUrl: config.server,
		auth: { apiKey: { name: "none", resolve: async () => ({ auth: { apiKey: "local" } }) } },
		// createProvider asks this backing list whenever Models resolves a route. Keep it mutable so a late /models
		// listing can make a discovered route selectable without requiring a launch-time connection.
		models: providerModels,
		api: openAICompletionsApi(),
	});
	// What the session tells the screen that is not in any conversation: how far the server is with reading a
	// prompt, that a turn or a task was ended at its limit, what the user said to a running task.
	const listeners = new Set();
	const notify = (event) => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				// The screen's trouble is not the session's.
			}
		}
	};
	// A listing is a light health check, not a model request. Share one in-flight read between the opening screen,
	// the first model turn, and /model so an offline endpoint produces one quick, intelligible failure instead of
	// several concurrent connection attempts.
	let listingFlight;
	let activeModelId = config.model;
	const readyModels = new Map();
	const readyValues = new Map();
	// A failed native route proof is a durable session diagnostic, not a reason to open a generic or prompt-only
	// fallback. Runtime and Settings render this fact until a later positive proof clears it.
	const routeDiagnostics = new Map();
	const routeDiagnostic = (error) => ({
		kind: error?.name === "NativeGrammarError" ? "native-grammar" : error?.name === "ModelServerUnavailableError" ? "transport" : error?.name === "ModelRouteError" ? "route" : "unavailable",
		message: String(error?.message ?? error),
	});
	const readListing = async () => {
		if (listingFlight !== undefined) return await listingFlight;
		const pending = listedModels(config.server);
		listingFlight = pending;
		try {
			const listing = await pending;
			if (listing !== undefined) addKnownModels(listing.models);
			return listing;
		} finally {
			if (listingFlight === pending) listingFlight = undefined;
		}
	};
	const applyCapacity = (modelId, serverContextWindow) => {
		// A transient listing failure after a successful proof must not inflate a previously discovered lower limit.
		const remembered = readyValues.get(modelId)?.serverContextWindow;
		const effective = contextWindowLimits(windowCeiling, serverContextWindow ?? remembered);
		const target = modelRecord(modelId);
		if (target !== undefined) target.contextWindow = effective.serverContextWindow ?? effective.usableContextWindow;
		if (modelId === activeModelId) config.contextWindow = effective.usableContextWindow;
		return effective;
	};
	const inspectServer = async (modelId = activeModelId) => {
		const listing = await readListing();
		const entry = listedModel(listing, modelId);
		return { listing, entry, limits: applyCapacity(modelId, modelContextWindow(entry)) };
	};
	const ensureModelReady = async (modelId = activeModelId, fallbackContextWindow) => {
		const knownReady = readyModels.get(modelId);
		if (knownReady !== undefined) return await knownReady;
		const pending = (async () => {
			const before = await inspectServer(modelId);
			if (before.listing?.entries.length > 0 && before.entry === undefined) throw new ModelRouteError(modelId, before.listing.models);
			try {
				await requireNativeGrammarCapability({ server: config.server, modelId });
			} catch (error) {
				throw unavailableFromNativeGrammar(config.server, error) ?? error;
			}
			// llama-swap can publish context_length only after the native proof has routed and loaded this model.
			// A second-listing outage is non-fatal: the proof just established that the route itself is usable.
			let after = before;
			try { after = await inspectServer(modelId); } catch { /* Retain pre-proof metadata when only /models is transiently unavailable. */ }
			const capacity = modelContextWindow(after.entry) ?? modelContextWindow(before.entry) ?? fallbackContextWindow;
			const limits = applyCapacity(modelId, capacity);
			readyValues.set(modelId, limits);
			routeDiagnostics.delete(modelId);
			if (modelId === activeModelId) notify({ type: "model-ready", modelId, limits });
			return limits;
		})();
		readyModels.set(modelId, pending);
		try {
			return await pending;
		} catch (error) {
			readyModels.delete(modelId);
			readyValues.delete(modelId);
			routeDiagnostics.set(modelId, routeDiagnostic(error));
			throw error;
		}
	};
	// No provider stream is allowed to reach the model before the native capability proof, including resumed Durable
	// work and integrations that call a conversation directly instead of going through the terminal's friendly gate.
	guardProviderModelRequests(provider, async (modelId) => {
		try {
			return await ensureModelReady(modelId);
		} catch (error) {
			notify({ type: "model-error", modelId, error });
			throw error;
		}
	});
	if (config.prefill !== false) watchPrefill(provider, notify);
	// CARTO_TRACE: one JSON line per provider model call, appended as it is answered. After the prefill watcher,
	// whose fetch is then the one the trace records around. The /models health listing is deliberately not traced.
	const tracePath = trace ?? traceFile({ root, brainDir });
	if (tracePath !== undefined) watchTrace(provider, tracePath);
	// The resume behind Ctrl-V: the response body of every model call goes through this gate, outside the other
	// watchers, last of all — what it declines to read, the server does not write.
	const streamFreeze = createStreamFreeze();
	streamFreeze.watchProvider(provider);
	models.setProvider(provider);

	const runs = new Map();
	// How many requests each conversation has made.
	const rounds = new Map();
	// What began the turn each conversation is in, and how many calls it has made in it: read from the messages of
	// each request, so it is right again after a restart. `onYield` decides with it.
	const turns = new Map();
	const turnOf = (messages) => {
		// The reminder that follows a reply without a call belongs to the turn it was sent in.
		const start = messages.findLastIndex((message) => message.role === "user" && !isNoChat(message));
		const first = messages[start];
		const later = messages.slice(start + 1);
		const calls = later.reduce((sum, message) => sum + (message.role === "assistant" ? (message.content ?? []).filter((part) => part.type === "toolCall").length : 0), 0);
		// A collapse in the middle of a turn: the context now starts with the front block (src/context.mjs), and the
		// turn is still the one that was going on. What began it, and whether it was reminded, was kept with the block.
		if (isFront(first)) {
			const mid = loadContext(brainDir).front?.midTurn;
			return { front: true, by: mid?.by ?? "note", reminded: (mid?.reminded ?? false) || later.some((message) => message.role === "user"), calls: calls + (mid === undefined ? 0 : 1), start: first.timestamp };
		}
		return { by: first === undefined || !isNote(first) ? "user" : "note", reminded: later.some((message) => message.role === "user"), calls, start: first?.timestamp };
	};
	// The same call failing again and again: per conversation, how often each call has failed since a call last
	// succeeded (LOOP_MAX). `loops` keeps what ended a conversation's turn this way, for the task tool and the screen.
	// A reply can hold the same call several times; `waiting` counts, per conversation, the calls of the newest reply
	// whose results are still to come, so that all of them end the turn together and not only the last.
	const failures = new Map();
	const waiting = new Map();
	const loops = new Map();
	const keyOf = (call) => `${call.name} ${JSON.stringify(call.arguments ?? {})}`;
	// A tool of the main agent. `beforeTool` refuses its call inside a task; this is the same answer for a call
	// that got past it.
	const forMain = (tool) => ({
		...tool,
		execute: async (args, api, callContext) => {
			if (api.conversationId === ROOT_CONVERSATION_ID) return tool.execute(args, api, callContext);
			return { isError: true, output: [{ type: "text", text: `Refused: ${MAIN_ONLY[tool.name]} ${STILL_TASK}` }] };
		},
	});
	// How many replies each conversation has made in the stretch it is in: for the main agent a turn, for a task
	// its whole life. The Harness counts tool rounds and starts over whenever a note is followed up, so a run of
	// notes and calls would have no end without this count.
	const steps = new Map();
	// The note each conversation last wrote and how often in a row, and where it was first told what a note is.
	const lastNote = new Map();
	const notedIn = new Map();
	// Tasks whose newest reply calls `return`: the round ends the task whatever else it calls.
	const returning = new Set();
	// What ended a conversation's stretch from here and not by its own doing: { why: "limit" | "same-note", ... }.
	const ends = new Map();
	// The focused task that runs now, and what the user typed while it runs. `said` reaches its next result and
	// `heard` becomes part of its returned report trail.
	const active = { id: undefined, said: [], heard: [], kind: undefined };
	const takeSaid = () => {
		const entries = active.said.splice(0);
		if (entries.length === 0) return undefined;
		const lines = entries.map((entry) => `[${USER_NAME} · ${stamp(entry.at)}] ${entry.text}`);
		return [`${USER_HEAD} wrote this while I was working. I take it into account, and put into my report what I could not act on.`, ...lines].join("\n");
	};
	const withText = (result, text) => ({ ...result, output: [...(result.output ?? []), { type: "text", text: `${(result.output ?? []).length > 0 ? "\n\n" : ""}${text}` }] });
	// Tools report plain, successful facts; the atlas alone maps a path to an existing node or keeps an unmapped
	// path as a gap. This hook is deliberately the one publisher rather than a second score in each tool.
	const atlasFacts = (call, result) => {
		const details = result?.details ?? {};
		if (call.name === "read" && result?.isError !== true && typeof details.path === "string") return [{ kind: "read", paths: [details.path] }];
		if (call.name === "shelf" && call.arguments?.action === "add" && result?.isError !== true && Array.isArray(details.paths)) return [{ kind: "shelf", paths: details.paths }];
		if (call.name === "task" && Array.isArray(details.changes) && details.changes.length > 0) return [{ kind: "checkpoint", paths: details.changes.map((change) => change?.path).filter((path) => typeof path === "string") }];
		return [];
	};
	const atlasFactsInRound = new Map();
	const publishAtlasFacts = (call, result, api) => {
		const facts = atlasFacts(call, result);
		const id = api.conversationId;
		if (facts.length > 0) atlasFactsInRound.set(id, [...(atlasFactsInRound.get(id) ?? []), ...facts]);
		// A response can call several reads or shelf adds. They are one factual batch and therefore one work epoch,
		// even when Durable happens to complete their individual calls in a different order.
		const last = [...(waiting.get(id) ?? new Map()).values()].every((open) => open <= 0);
		if (!last) return;
		const batch = atlasFactsInRound.get(id) ?? [];
		atlasFactsInRound.delete(id);
		if (batch.length === 0) return;
		try {
			const { atlas } = loadAtlas(brainDir);
			if (atlas === undefined) return;
			const observed = observeAtlas(atlas, batch, { at: new Date(api.now()).toISOString() });
			if (observed.changed) saveAtlas(brainDir, atlas);
		} catch {
			// A map edited into an unreadable shape must not change whether the factual tool call itself succeeds.
		}
	};
	const textOfAnswer = (message) => (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();
	// The question the agent waits on (src/asks.mjs).
	const asks = createAsks({ config });
	// A prior crashed process leaves no usable stage: discard only its own dead-process disposable roots before
	// this session can reconstruct a focus. Ordinary project and brain paths are never touched here.
	cleanupStaleStages({ root });
	// The shell windows of this session (src/windows.mjs). They end with the program.
	const windows = createWindows({ root, brainDir, config, runner });
	// The wake triggers the agent has set (src/wakes.mjs). They are kept from one start to the next.
	const wakes = createWakes({ root, brainDir, config, windows });
	// The context engine: when a collapse is due, the question before it, the read-ahead after it (src/engine.mjs).
	const engine = createEngine({ root, brainDir, config });
	/**
	 * A call that fails the same way again and again ends the turn. This sees every result, also the ones the
	 * Harness writes itself for arguments that do not fit and for a refused call.
	 * @returns the result to store instead, or undefined
	 */
	const loopCheck = (call, result, api) => {
		const seen = failures.get(api.conversationId) ?? new Map();
		failures.set(api.conversationId, seen);
		const pending = waiting.get(api.conversationId) ?? new Map();
		pending.set(keyOf(call), (pending.get(keyOf(call)) ?? 0) - 1);
		if (result.isError !== true) {
			seen.clear();
			return undefined;
		}
		// A call that was cut off or stopped did not fail by its own doing.
		if ((result.diagnostics ?? []).some((entry) => ["aborted", "abandoned", "interrupted", "restart_limit"].includes(entry.code))) return undefined;
		const key = keyOf(call);
		const times = (seen.get(key) ?? 0) + 1;
		seen.set(key, times);
		// The same call further on in this reply will fail the same way: count it now, so that every result
		// of such a reply asks for the end and the turn does end with it.
		const total = times + Math.max(0, pending.get(key) ?? 0);
		if (total < LOOP_MAX) return undefined;
		// What went wrong is in the output of a tool that ran, and in a diagnostic when the Harness refused the call.
		const error = [...(result.output ?? []).map((part) => part.text ?? ""), ...(result.diagnostics ?? []).filter((entry) => entry.severity === "error").map((entry) => entry.message)].join("\n").trim();
		// The turn ends with this reply when every call in it is part of such a run.
		const ends = [...pending.keys()].every((other) => (seen.get(other) ?? 0) + Math.max(0, pending.get(other) ?? 0) >= LOOP_MAX);
		const loop = { total, ends, call: key.length > POLICY.limits.loops.callKeyChars ? `${key.slice(0, POLICY.limits.loops.callKeyChars)}…` : key, error: error.length > POLICY.limits.loops.errorChars ? `${error.slice(0, POLICY.limits.loops.errorChars)}…` : error };
		loops.set(api.conversationId, loop);
		return {
			...result,
			diagnostics: [...(result.diagnostics ?? []), { severity: "warn", code: "carto_loop", message: LOOP_STOP(total) }],
			details: { ...(result.details !== null && typeof result.details === "object" && !Array.isArray(result.details) ? result.details : {}), loop },
			control: { ...POLICY.control.terminate },
		};
	};
	// Installed once but selected only by independent consultation children. Its registration objects are passed to
	// Durable agent configuration below; names alone are stored only after Durable validates the selection.
	const conferenceExtension = createConferenceExtension({ brainDir, server: config.server });
	// One flat list of tools for the main agent and every task: a fork shares the main conversation's
	// prompt byte for byte, so a differing tool list would break the prefix the server has already read.
	// Tool descriptions are built into the tool definitions.
	const sessionTools = [
		chatTool({ brainDir }),
		askTool({ brainDir, asks }),
		forMain(taskTool({ root, brainDir, config, runner, windows, gate, loops, ends, active })),
		returnTool({ root, brainDir, config }),
		readTool({ root, brainDir }),
		shelfTool({ root, brainDir, config }),
		bookTool({ root, brainDir, config, engine, gate }),
		...lookTools(root),
		...changeTools({ root, brainDir, gate }),
		shellTool({ root, config, brainDir, gate, runner, windows, runOf: (conversationId) => runs.get(conversationId) }),
		consultTool({ root, brainDir, conferenceExtension }),
		forMain(wakeTool({ wakes, config })),
		forMain(sleepTool({ wakes })),
		// For the main agent and for a task, each about its own part of the context.
	].map((tool) => ({ ...tool, description: describe(tool.name) ?? tool.description }));
	// The generation hooks are declared before Harness.open() creates these handles. They are assigned before any run
	// can start, and let the hooks read the exact active Durable ContextView for provenance.
	let sessionHarness;
	let sessionMain;
	const core = defineExtension({
		name: "cartographer",
		// The preamble never changes within a project; a change here makes the server read the whole prompt again.
		// It is built from the named sections of src/prompt.mjs. The prepend stands before it: the user's own
		// markdown (src/prepend.mjs), read fresh each request — a file read per request, and a new prompt section
		// only when its bytes change.
		sections: [section("prepend", () => loadPrepend(brainDir), { tag: false }), section("preamble", () => systemPrompt({ root, handoffQuestion: config.handoffQuestion === true }), { tag: false })],
		// One flat list of tools for the main agent and every task: a fork shares the main conversation's
		// prompt byte for byte, so a differing tool list would break the prefix the server has already read.
		// Tool descriptions are built into the tool definitions.
		tools: sessionTools,
		hooks: [
			hook(ToolTask, {
				// Every conversation is offered the same tools, so a task's prompt is the main agent's prompt.
				// Who may call what is decided here, when the call is made.
				beforeTool: async (call, api, hookContext) => {
					// One reply may carry a bounded transient read batch; a ninth file is refused before disk is read (src/read-batch.mjs).
					const readRefused = readBatchCheck(api.conversationId, call);
					if (readRefused !== undefined) return { block: readRefused };
					if (api.conversationId === ROOT_CONVERSATION_ID) {
					if (CHANGE.has(call.name)) return { block: REFUSALS.mainChanges };
						// Running a command as a read is open to the main conversation (it executes in a read-only window); typing into a running program is not a read.
						const mainRun = call.name === "shell" && (call.arguments?.action === undefined || call.arguments?.action === POLICY.enums.shellAction.run);
						if (types(call) && !mainRun) return { block: REFUSALS.mainRuns };
						if (call.name === "return") return { block: REFUSALS.mainReturns };
						// A turn that a wake started is quiet until the agent does something in it; `sleep` is not something.
						if (call.name !== "sleep") wakes.acted();
						return undefined;
					}
					// A task that reaches for a tool of the main agent is told so and goes on. It ends with `return`.
					if (MAIN_ONLY[call.name] !== undefined) return { block: `${MAIN_ONLY[call.name]} ${STILL_TASK}` };
					const run = await runOf(runs, api, hookContext);
					// Writing is for a task that carries out a live approved change move revision, and for no one else.
					// So is running a command. The answer is kept in `runs`, where the shell tool finds it.
					if (CHANGE.has(call.name) || types(call)) {
						if (run.mode !== POLICY.enums.planMode.change || typeof run.move !== "string" || !Number.isInteger(run.revision)) {
							return { block: types(call) ? REFUSALS.lookTaskRuns : REFUSALS.lookTaskChanges };
						}
					}
					return undefined;
				},
					afterTool: async (call, result, api) => {
						if (call.parent !== undefined) return undefined;
						// The harness can end a running tool without returning through its execute() catch. Preserve the
						// conference lifecycle in that situation rather than leaving an apparently-live private child after /stop.
						if (call.name === "consult") {
							const diagnostic = (result.diagnostics ?? []).find((entry) => ["aborted", "interrupted", "restart_limit", "abandoned"].includes(entry.code));
							if (diagnostic !== undefined) {
								const conference = findConferenceByCaller(brainDir, { taskId: api.taskId, callId: call.id });
								if (conference !== undefined) {
									const cancelled = diagnostic.code === "aborted" || diagnostic.code === "abandoned";
									try {
										endConference(brainDir, conference.id, cancelled ? "cancelled" : "interrupted", cancelled ? "The caller stopped the outer consult tool before a final consult_return." : "The outer consult tool was interrupted before a final consult_return.", api.now());
									} catch {
										// The record may already have returned or recorded a more specific terminal failure.
									}
								}
							}
						}
						const looped = loopCheck(call, result, api);
					const out = looped ?? result;
					// Keep this synchronous with loopCheck: sibling calls in one reply share one mapping epoch.
					publishAtlasFacts(call, out, api);
					engine.returned(api.conversationId, call, out);
					if (api.conversationId !== ROOT_CONVERSATION_ID) {
						const id = api.conversationId;
						// A file read again: the earlier copy of the same lines becomes one line (src/context.mjs).
						if (call.name === "read" && out.isError !== true) engine.afterTaskRead(id, call.arguments ?? {});
						const run = await runOf(runs, api, hookContext);
						const taskLimit = Number.isInteger(run.turns) ? run.turns : config.taskTurns;
						const left = taskLimit - (steps.get(id)?.n ?? 0);
						const lastOfRound = [...(waiting.get(id) ?? new Map()).values()].every((open) => open <= 0);
						let told = out;
						// A round that holds `return` ends the task, whatever else it called. A `return` that was refused does not.
						if (returning.has(id)) {
							if (call.name === "return" && out.isError === true) returning.delete(id);
							else return { ...told, control: { ...(told.control ?? {}), ...POLICY.control.terminate } };
						}
						if (lastOfRound) {
							// What the user typed since the task's last reply.
							const said = takeSaid();
							if (said !== undefined) told = withText(told, said);
							if (left >= 1 && left <= POLICY.limits.loops.warningReplies) told = withText(told, REPLIES_LEFT(left));
						}
						// The task has used its replies: this round is its last.
						if (left <= 0 && told.control?.terminate !== true) {
							ends.set(id, { why: "limit", replies: steps.get(id)?.n ?? 0 });
							told = { ...told, control: { ...(told.control ?? {}), ...POLICY.control.terminate } };
						}
						return told === result ? undefined : told;
					}
					// Whether the main agent's context collapses with this round of calls.
					const pending = waiting.get(api.conversationId) ?? new Map();
					const decided = await engine.afterMainCall({ last: [...pending.values()].every((left) => left <= 0), round: rounds.get(api.conversationId) ?? 0, turn: turns.get(api.conversationId) });
					if (decided === undefined) return looped;
					return {
						...out,
						...(decided.note !== undefined ? { output: [...(out.output ?? []), { type: "text", text: `${(out.output ?? []).length > 0 ? "\n\n" : ""}${decided.note}` }] } : {}),
						...(decided.handoff !== undefined ? { control: { ...(out.control ?? {}), handoff: decided.handoff } } : {}),
					};
				},
			}),
			hook(GenerationTask, {
				// What a request carries that the conversation does not store (src/request.mjs): the copy of the
				// assessment and the graph in front, the times, and for the main agent the state block at the end.
				beforeRequest: async ({ messages }, api) => {
					const main = api.conversationId === ROOT_CONVERSATION_ID;
					// Cache the durable move contract before its first reply so a focus that writes only notes
					// still receives its move-specific reply ceiling.
					if (!main) await runOf(runs, api, context);
					rounds.set(api.conversationId, (rounds.get(api.conversationId) ?? 0) + 1);
					const turn = turnOf(messages);
					// One more reply in this stretch: a turn of the main agent (a collapse in the middle of it does not
					// begin another), or the task.
					const prior = steps.get(api.conversationId);
					const key = main ? (turn.front ? (prior?.key ?? turn.start) : turn.start) : "task";
					steps.set(api.conversationId, prior !== undefined && prior.key === key ? { key, n: prior.n + 1 } : { key, n: 1 });
					// A new message of the user, or a new note: what failed before it is no longer "in a row".
					if (turns.get(api.conversationId)?.start !== turn.start) failures.delete(api.conversationId);
					turns.set(api.conversationId, turn);
					engine.seen(api.conversationId, messages);
					// Durable gives its active entries beside their contributions. Re-read that view here so the planner and
					// the talk store can keep entry ids through request dressing; a row with no unambiguous bridge stays unnamed.
					let sources;
					try {
						const conversation = main ? sessionMain : await sessionHarness.conversation(api.conversationId, context);
						if (conversation !== undefined) sources = bridgeRequestSources(messages, await conversation.context(context));
					} catch {
						// A request still runs when inspection cannot be read; its plan says that source is unmapped.
					}
					// What the user said is noted for the talk a collapse keeps. A task whose context is nearly full has
					// its own steps collapsed here, after the one question (src/engine.mjs).
					let note;
					if (main) noteUserMessages(brainDir, messages, sources);
					else note = await engine.beforeTaskRequest(api.conversationId, messages);
					const planned = prepareRequest(messages, { brainDir, root, runner, config, windows, wakes, gate, main, conversationId: api.conversationId, note, used: engine.usedBy(api.conversationId), sources });
					engine.planned(api.conversationId, planned);
					return { messages: planned.messages };
				},
				// The request as it is sent: the question before a collapse is put behind exactly this.
				beforeProviderRequest: ({ payload, model }, api) => {
					// The declaration is static and flat; there is nothing to re-route here. `sending` freezes this provider
					// body for the Model view before pi-ai dispatches it; the collapse accounting uses the same snapshot.
					engine.sending(api.conversationId, payload, model);
					return { payload, model };
				},
				afterResponse: async (message, api) => {
					beginReadBatch(api.conversationId, message);
					engine.replied(api.conversationId, message);
					const pending = new Map();
					for (const part of message.content ?? []) if (part.type === "toolCall") pending.set(keyOf(part), (pending.get(keyOf(part)) ?? 0) + 1);
					waiting.set(api.conversationId, pending);
					if (pending.size > 0) lastNote.delete(api.conversationId);
					if (api.conversationId !== ROOT_CONVERSATION_ID && (message.content ?? []).some((part) => part.type === "toolCall" && part.name === "return")) returning.add(api.conversationId);
				},
				// A reply with no tool call is a note the agent wrote to itself: it is followed by one line and the run
				// goes on. The main agent rests only with `sleep`; a task ends with `return`. What bounds this is the
				// count of replies in the stretch, and the same note written again and again.
				onYield: (answer, api) => {
					const id = api.conversationId;
					const main = id === ROOT_CONVERSATION_ID;
					// A reply cut off at the output limit: the screen tells the user, who decides. For a task it is the end.
					if (answer.stopReason === "length") return undefined;
					// At the ceiling the plain-reply path never reaches the tool round where a collapse is normally
					// decided (src/engine.mjs overCeiling). End the stretch here; the rest path collapses it mechanically.
					if (main && engine.overCeiling(id)) {
						const used = engine.usedBy(id) ?? 0;
						engine.want(`it held about ${Math.round((used / config.contextWindow) * 100)}% of what fits`, { forced: true, atRest: true });
						return undefined;
					}
					const turn = turns.get(id);
					// A turn that a wake started and in which nothing was done is a rest already.
					if (main && (turn === undefined || (turn.by === "note" && turn.calls === 0))) return undefined;
					const step = steps.get(id) ?? { key: undefined, n: 0 };
					const taskRun = main ? undefined : runs.get(id);
					const limit = main ? config.mainTurns : (Number.isInteger(taskRun?.turns) ? taskRun.turns : config.taskTurns);
					const text = textOfAnswer(answer);
					// The same note, word for word (ignoring layout and case), written again and again: the run ends.
					const key = noteKey(text);
					const last = lastNote.get(id);
					const times = last?.key === key ? last.times + 1 : 1;
					lastNote.set(id, { key, times, text });
					if (times >= LOOP_MAX) {
						ends.set(id, { why: "same-note", times, empty: text === "" });
						notify({ type: "same-note", conversationId: id, main, times, empty: text === "" });
						return undefined;
					}
					if (step.n >= limit) {
						ends.set(id, { why: "limit", replies: step.n });
						notify({ type: "limit", conversationId: id, main, replies: step.n });
						return undefined;
					}
					const first = notedIn.get(id) !== step.key || step.key === undefined;
					notedIn.set(id, step.key);
					const left = limit - step.n;
					const extra = main ? undefined : [takeSaid(), left <= POLICY.limits.loops.warningReplies ? REPLIES_LEFT(left) : undefined].filter((line) => line !== undefined).join("\n\n");
					return { continue: noted({ main, first, extra: extra === "" ? undefined : extra }) };
				},
			}),
		],
	});
	const registry = createRegistry();
	registry.install(core);
	// Conference children select this isolated profile explicitly. Installing it does not add its prompt or tools
	// to the root, which stays on the ordinary Cartographer surface.
	registry.install(conferenceExtension);
	// The copy of the assessment and the graph that stands at the top of the context (src/top.mjs).
	if (loadTop(brainDir) === undefined) pin(brainDir, { reason: "the first start" });

	const storage = await openNodeSqliteStorage(join(brainDir, "session.sqlite"));
	// The Harness would summarize a long context with a request of its own. Cartographer collapses it instead.
	// A burst of user messages sent while a provider request or focus is busy belongs in the very next context
	// boundary. The Durable default takes only one steer per boundary, needlessly leaving the rest queued for a
	// later tool round (or even the next user turn) when the current response ends without more tools.
	const harness = sessionHarness = await Harness.open(storage, { models, registry, settings: { compaction: { enabled: false }, steeringMode: "all" } }, context);
	const main = sessionMain = await harness.root(context, {
		// Explicit selection prevents an installed consult-only extension from leaking its isolated tools into root requests.
		agent: { model: { provider: PROVIDER, modelId: config.model }, extensions: [core], maxTurns: config.mainTurns },
	});
	// The settings say which model this session is on. A conversation keeps the model it began with, so a change
	// in the settings would otherwise never take hold (the stored one won, or, if the server had dropped it, the
	// run stopped with no_model). At the start, then, the conversation is set to the configured model; /model
	// switches it for the rest of the run, and late /models listings register additional routes as they arrive.
	const held = (await main.agent(context)).model;
	if (held === undefined || (held.provider === PROVIDER && held.modelId !== config.model)) {
		await main.configure({ model: { provider: PROVIDER, modelId: config.model } }, context);
	}
	// Existing Durable roots predate the extension selection field. Pin them on every open so a stored root cannot
	// accidentally retain the conference profile; only independent conference children receive it.
	await main.configure({ extensions: [core] }, context);
	const currentModel = async () => (await main.agent(context)).model;
	const selectModel = async (modelId, ctx = context, limits = {}) => {
		// A selected route is proven before it is adopted. If Cartographer opened while offline, this is also the
		// first time a freshly listed model becomes part of the provider registry.
		const effective = await ensureModelReady(modelId, limits?.contextWindow);
		await main.configure({ model: { provider: PROVIDER, modelId } }, ctx);
		activeModelId = modelId;
		config.contextWindow = effective.usableContextWindow;
		notify({ type: "model-ready", modelId, limits: effective });
		return effective;
	};
	const routeTaskMessage = (text) => {
		if (active.kind !== "task" || active.id === undefined) return false;
		const entry = { text: String(text).trim(), at: Date.now() };
		if (entry.text === "") return false;
		active.said.push(entry);
		active.heard.push(entry);
		noteChat(brainDir, "user", entry.at, entry.text, { seen: false });
		return true;
	};
	/** The narrow task-message port records user steering without exposing task identity, messages, or lifecycle state. */
	const work = Object.freeze({ tell: routeTaskMessage });
	/** The presentation/application port for model state. It keeps terminal and Screen out of the session's transport helpers. */
	const modelManager = Object.freeze({
		current: currentModel,
		inspect: async () => await inspectServer(activeModelId),
		ensure: async () => await ensureModelReady(activeModelId),
		ready: () => readyValues.has(activeModelId),
		diagnostic: () => routeDiagnostics.get(activeModelId),
		known: () => [...known],
		select: async (modelId, limits = {}) => await selectModel(modelId, context, limits),
	});
	return {
		harness,
		main,
		context,
		/** The gate the model's response body passes through; /pause holds it mid-stream and lets it go on. */
		streamFreeze,
		/** The presentation/application port for model state and controls. */
		models: modelManager,
		/** Compatibility aliases for integrations that have not adopted `models` yet. */
		model: currentModel,
		/**
		 * Switch the model of the main conversation, and so of every task forked after.
		 * @param {object} [limits]  what the server said about the new model, from the same /models fetch that listed it
		 * @param {number} [limits.contextWindow]  its advertised total request capacity, when the listing already has one
		 * @returns {Promise<ReturnType<typeof contextWindowLimits>>} the model's active context window and reported
		 *   capacity. A listing that explicitly lacks the name rejects with ModelRouteError. The active window is what
		 *   the engine, state block, shelf's soft cap (half of it), display, and provider context sizing use.
		 */
		setModel: selectModel,
		/** A non-blocking model-listing check for the terminal's offline status line; it never starts a model. */
		checkServer: modelManager.inspect,
		/** Prove the active route immediately before model work. Any unavailable or grammar-invalid route rejects closed. */
		ensureModelReady: modelManager.ensure,
		/** Whether this process has already proven the active route and refreshed its post-load capacity. */
		isModelReady: modelManager.ready,
		/** The model names known so far. A getter keeps /model current after a late listing arrives. */
		get servedModels() { return modelManager.known(); },
		windows,
		wakes,
		engine,
		/** A pure main-agent request plan for the screen. It reads the active Durable context and current brain without
		 * checking/consuming wakes, marking window output shown, starting an attempt, or retaining history. */
		preview: async () => {
			const view = await main.context(context);
			return {
				at: Date.now(),
				plan: planRequest(view.messages, {
					brainDir,
					root,
					runner,
					config,
					gate,
					main: true,
					conversationId: main.id,
					used: engine.usedBy(main.id),
					fired: [],
					wakeLines: wakes.lines(),
					windowRows: windows.list(config.windowTail),
				}),
			};
		},
		asks,
		/** `listener` hears what is in no conversation: { type: "prefill" | "limit" | "same-note" | "told", ... }. */
		on(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** The conversation of the ordinary task that runs now, or undefined. */
		activeTask: () => active.kind === "task" ? active.id : undefined,
		/** The application port for safely routing a user message to private task work. */
		work,
		/** Compatibility aliases for integrations that have not adopted `work` yet. */
		tellTask: routeTaskMessage,
		tellWork: (text) => routeTaskMessage(text) ? { kind: "task" } : false,

	};
}

/**
 * Ask the server to say how far it is with reading the prompt, and listen for it. With `return_progress` in the
 * request, llama.cpp puts `prompt_progress: { total, cache, processed, time_ms }` into the stream, one for each
 * batch it has read. The reply's own events are not touched: the stream is read a second time on the side.
 */
function watchPrefill(provider, notify) {
	let serial = 0;
	const wrap = (name) => {
		const inner = provider[name]?.bind(provider);
		if (inner === undefined) return;
		provider[name] = (model, request, options = {}) => {
			const id = ++serial;
			return inner(model, request, {
				...options,
				onPayload: async (payload, of) => {
					const next = (await options.onPayload?.(payload, of)) ?? payload;
					return next !== null && typeof next === "object" && next.stream === true ? { ...next, return_progress: true } : next;
				},
				fetch: async (url, init) => {
					const began = Date.now();
					notify({ type: "prefill", id, phase: "sent", at: began });
					const response = await (options.fetch ?? globalThis.fetch)(url, init);
					if (!response.ok || response.body === null || typeof response.body.tee !== "function") return response;
					const [mine, theirs] = response.body.tee();
					(async () => {
						const decoder = new TextDecoder();
						let rest = "";
						let writing = false;
						for await (const chunk of mine) {
							rest += decoder.decode(chunk, { stream: true });
							for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
								const line = rest.slice(0, at).trim();
								rest = rest.slice(at + 1);
								if (!line.startsWith("data: {")) continue;
								if (line.includes('"prompt_progress"')) {
									try {
										const progress = JSON.parse(line.slice(6)).prompt_progress;
										if (progress !== undefined) notify({ type: "prefill", id, phase: "reading", at: Date.now(), began, ...progress });
									} catch {
										// Half a line, or not what it looked like.
									}
								} else if (!writing && /"(content|reasoning_content|tool_calls)":\s*(?!null)/.test(line)) {
									writing = true;
									notify({ type: "prefill", id, phase: "writing", at: Date.now(), began });
								}
							}
						}
						notify({ type: "prefill", id, phase: "done", at: Date.now(), began });
					})().catch(() => {});
					return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
				},
			});
		};
	};
	wrap("stream");
	wrap("streamSimple");
}
