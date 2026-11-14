// Opens one project's session: the Durable harness over `.atlas/session.sqlite`,
// the model provider, and the tools with the rule of who may call what.
import { POLICY } from "./config.mjs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, GenerationTask, Harness, hook, ROOT_CONVERSATION_ID, section, ToolTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, LOOP_MAX, LOOP_STOP, MAIN_TOOLS, REFUSALS, REPLIES_LEFT, STILL_TASK, systemPrompt } from "./prompt.mjs";

import { createAsks } from "./asks.mjs";
import { askTool } from "./tools/ask.mjs";
import { bookTool } from "./tools/book.mjs";
import { returnTool } from "./tools/return.mjs";
import { stamp } from "./time.mjs";
import { chatTool } from "./tools/chat.mjs";
import { isFront, loadContext, noteChat, noteUserMessages } from "./context.mjs";
import { createEngine } from "./engine.mjs";
import { isNoChat, isNote, noted } from "./wake.mjs";
import { dressRequest } from "./request.mjs";
import { loadTop, pin } from "./top.mjs";
import { atlasTool } from "./tools/atlas.mjs";
import { changeTools } from "./tools/change.mjs";
import { lookTools } from "./tools/look.mjs";
import { shellTool } from "./tools/shell.mjs";
import { taskTool } from "./tools/task.mjs";
import { sleepTool, wakeTool } from "./tools/wake.mjs";
import { createWakes } from "./wakes.mjs";
import { createWindows } from "./windows.mjs";

const PROVIDER = "local";
const LOOK = new Set(["read", "search", "list"]);
const CHANGE = new Set(["write", "edit"]);
/** Typing into a shell window: a command, or a line of input for the program that runs there. */
const types = (call) => call.name === "shell" && (call.arguments?.action === undefined || call.arguments?.action === POLICY.enums.shellAction.run || call.arguments?.action === POLICY.enums.shellAction.send);
/** Tools that belong to the main agent alone, and what a task is told when it calls one. */
// The book tool guards its own books inside the tool (a task may use its context operations);
// the rest of the main agent's tools are wrapped here.
const MAIN_ONLY_TEXT = { task: REFUSALS.taskStartsTask, wake: REFUSALS.taskWakes, sleep: REFUSALS.taskSleeps };
const MAIN_ONLY = MAIN_ONLY_TEXT;

/**
 * What kind of task a conversation is: look or change, and for a change task whether its commands reach the
 * network. The brief entry at the start of the conversation says it (src/tools/task.mjs); `runs` remembers the
 * answer for this run of the program.
 * @returns {Promise<{ mode: "look" | "change", network?: boolean }>}
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
				if (entry.data?.mode === POLICY.enums.planMode.change) run = { mode: POLICY.enums.planMode.change, network: entry.data.network === true };
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
 *   gate: `{ yolo }`, whether change items run without /approve; the terminal changes it when the user types /yolo
 */
export async function openSession({ root, brainDir, config, runner, gate = { yolo: false }, servedModels }) {
	const context = BACKGROUND_CONTEXT;
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
		contextWindow: config.contextWindow,
		maxTokens: config.maxTokens,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsStrictMode: false,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
		},
	};
	const models = createModels();
	// The provider knows every model the server serves, not only the configured one: a session stored under
	// an older model must still start (the conversation keeps the model it began with until /model changes
	// it), and /model can switch to any of the others without a restart.
	const known = [...new Set([config.model, ...(Array.isArray(servedModels) ? servedModels : [])])];
	const provider = createProvider({
		id: PROVIDER,
		name: "local model server",
		baseUrl: config.server,
		auth: { apiKey: { name: "none", resolve: async () => ({ auth: { apiKey: "local" } }) } },
		models: known.map((id) => (id === config.model ? model : { ...model, id, name: id })),
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
	if (config.prefill !== false) watchPrefill(provider, notify);
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
	// The task that runs now, and what the user typed while it runs: `said` is still to be told to the task,
	// `heard` is all of it, for the task's result (src/tools/task.mjs).
	const active = { id: undefined, said: [], heard: [] };
	const takeSaid = () => {
		const lines = active.said.splice(0).map((entry) => `[user · ${stamp(entry.at)}] ${entry.text}`);
		return lines.length === 0 ? undefined : ["Cartographer: the user wrote this while you work. Take it into account, and put into your report what you could not act on.", ...lines].join("\n");
	};
	const withText = (result, text) => ({ ...result, output: [...(result.output ?? []), { type: "text", text: `${(result.output ?? []).length > 0 ? "\n\n" : ""}${text}` }] });
	const textOfAnswer = (message) => (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();
	// The question the agent waits on (src/asks.mjs).
	const asks = createAsks({ config });
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
	// One flat list of tools for the main agent and every task: a fork shares the main conversation's
	// prompt byte for byte, so a differing tool list would break the prefix the server has already read.
	// Tool descriptions are built into the tool definitions.
	const sessionTools = [
		chatTool({ brainDir }),
		askTool({ brainDir, asks }),
		forMain(taskTool({ root, brainDir, config, runner, windows, gate, loops, ends, active })),
		returnTool({ brainDir }),
		bookTool({ root, brainDir, config, engine, gate }),
		atlasTool({ root, brainDir, gate }),
		...lookTools(root),
		...changeTools({ root, brainDir, write: { newOnly: config.writeCreatesOnly, maxLines: config.writeLines } }),
		shellTool({ config, runner, windows, runOf: (conversationId) => runs.get(conversationId) }),
		forMain(wakeTool({ wakes, config })),
		forMain(sleepTool({ wakes })),
		// For the main agent and for a task, each about its own part of the context.
	].map((tool) => ({ ...tool, description: describe(tool.name) ?? tool.description }));
	const core = defineExtension({
		name: "cartographer",
		// One section that never changes within a project: a change here makes the server read the whole prompt again.
		// It is built from the named sections of src/prompt.mjs.
		sections: [section("preamble", () => systemPrompt({ root }), { tag: false })],
		// One flat list of tools for the main agent and every task: a fork shares the main conversation's
		// prompt byte for byte, so a differing tool list would break the prefix the server has already read.
		// Tool descriptions are built into the tool definitions.
		tools: sessionTools,
		hooks: [
			hook(ToolTask, {
				// Every conversation is offered the same tools, so a task's prompt is the main agent's prompt.
				// Who may call what is decided here, when the call is made.
				beforeTool: async (call, api, hookContext) => {
					if (api.conversationId === ROOT_CONVERSATION_ID) {
						if (LOOK.has(call.name)) return { block: REFUSALS.mainLooks };
						if (CHANGE.has(call.name)) return { block: REFUSALS.mainChanges };
						if (types(call)) return { block: REFUSALS.mainRuns };
						if (call.name === "return") return { block: REFUSALS.mainReturns };
						// A turn that a wake started is quiet until the agent does something in it; `sleep` is not something.
						if (call.name !== "sleep") wakes.acted();
						return undefined;
					}
					// A task that reaches for a tool of the main agent is told so and goes on. It ends with `return`.
					if (MAIN_ONLY[call.name] !== undefined) return { block: `${MAIN_ONLY[call.name]} ${STILL_TASK}` };
					// Writing is for a task that carries out a change item of the authorized plan, and for no one else.
					// So is running a command. The answer is kept in `runs`, where the shell tool finds it.
					if ((CHANGE.has(call.name) || types(call)) && (await runOf(runs, api, hookContext)).mode !== POLICY.enums.planMode.change) {
						return { block: types(call) ? REFUSALS.lookTaskRuns : REFUSALS.lookTaskChanges };
					}
					return undefined;
				},
				afterTool: async (call, result, api) => {
					if (call.parent !== undefined) return undefined;
					const looped = loopCheck(call, result, api);
					const out = looped ?? result;
					engine.returned(api.conversationId, call, out);
					if (api.conversationId !== ROOT_CONVERSATION_ID) {
						const id = api.conversationId;
						// A file read again: the earlier copy of the same lines becomes one line (src/context.mjs).
						if (call.name === "read" && out.isError !== true) engine.afterTaskRead(id, call.arguments ?? {});
						const left = config.taskTurns - (steps.get(id)?.n ?? 0);
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
					// What the user said is noted for the talk a collapse keeps. A task whose context is nearly full has
					// its own steps collapsed here, after the one question (src/engine.mjs).
					let note;
					if (main) noteUserMessages(brainDir, messages);
					else note = await engine.beforeTaskRequest(api.conversationId, messages);
					return { messages: dressRequest(messages, { brainDir, root, runner, config, windows, wakes, gate, main, conversationId: api.conversationId, note, used: engine.usedBy(api.conversationId) }) };
				},
				// The request as it is sent: the question before a collapse is put behind exactly this.
				beforeProviderRequest: ({ payload }, api) => {
					engine.sending(api.conversationId, payload);
					return undefined;
				},
				afterResponse: (message, api) => {
					engine.replied(api.conversationId, message);
					const pending = new Map();
					for (const part of message.content ?? []) if (part.type === "toolCall") pending.set(keyOf(part), (pending.get(keyOf(part)) ?? 0) + 1);
					waiting.set(api.conversationId, pending);
					if (pending.size > 0) lastNote.delete(api.conversationId);
					if (api.conversationId !== ROOT_CONVERSATION_ID && (message.content ?? []).some((part) => part.type === "toolCall" && part.name === "return")) returning.add(api.conversationId);
				},
				// A reply with no tool call is a note the agent wrote to itself: it is followed by one line and the run
				// goes on. A turn of the main agent ends with `chat` or `sleep`, a task with `return`. What bounds this
				// is the count of replies in the stretch, and the same note written again and again.
				onYield: (answer, api) => {
					const id = api.conversationId;
					const main = id === ROOT_CONVERSATION_ID;
					// A reply cut off at the output limit: the screen tells the user, who decides. For a task it is the end.
					if (answer.stopReason === "length") return undefined;
					const turn = turns.get(id);
					// A turn that a wake started and in which nothing was done is a rest already.
					if (main && (turn === undefined || (turn.by === "note" && turn.calls === 0))) return undefined;
					const step = steps.get(id) ?? { key: undefined, n: 0 };
					const limit = main ? config.mainTurns : config.taskTurns;
					const text = textOfAnswer(answer);
					const last = lastNote.get(id);
					const times = last?.text === text ? last.times + 1 : 1;
					lastNote.set(id, { text, times });
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
	// The copy of the assessment and the graph that stands at the top of the context (src/top.mjs).
	if (loadTop(brainDir) === undefined) pin(brainDir, { reason: "the first start" });

	const storage = await openNodeSqliteStorage(join(brainDir, "session.sqlite"));
	// The Harness would summarize a long context with a request of its own. Cartographer collapses it instead.
	const harness = await Harness.open(storage, { models, registry, settings: { compaction: { enabled: false } } }, context);
	const main = await harness.root(context, {
		agent: { model: { provider: PROVIDER, modelId: config.model }, maxTurns: config.mainTurns },
	});
	// The settings say which model this session is on. A conversation keeps the model it began with, so a change
	// in the settings would otherwise never take hold (the stored one won, or, if the server had dropped it, the
	// run stopped with no_model). At the start, then, the conversation is set to the configured model; /model
	// switches it for the rest of the run, and every model the server serves is registered so any of them resolves.
	const held = (await main.agent(context)).model;
	if (held === undefined || (held.provider === PROVIDER && held.modelId !== config.model)) {
		await main.configure({ model: { provider: PROVIDER, modelId: config.model } }, context);
	}
	return {
		harness,
		main,
		context,
		/** The model the main conversation is on, as { provider, modelId }. */
		model: async () => (await main.agent(context)).model,
		/** Switch the model of the main conversation, and so of every task forked after. Undefined when the name is not served. */
		setModel: async (modelId, ctx = context) => {
			if (!known.includes(modelId)) return false;
			await main.configure({ model: { provider: PROVIDER, modelId } }, ctx);
			return true;
		},
		/** The model names the server was serving when the session opened. */
		servedModels: [...known],
		windows,
		wakes,
		engine,
		asks,
		/** `listener` hears what is in no conversation: { type: "prefill" | "limit" | "same-note" | "told", ... }. */
		on(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** The conversation of the task that runs now, or undefined. */
		activeTask: () => active.id,
		/**
		 * What the user typed while a task runs: the task reads it with its next result, and it is kept as talk.
		 * @returns {boolean} whether a task was there to tell
		 */
		tellTask(text) {
			if (active.id === undefined) return false;
			const entry = { text: String(text).trim(), at: Date.now() };
			if (entry.text === "") return false;
			active.said.push(entry);
			active.heard.push(entry);
			noteChat(brainDir, "user", entry.at, entry.text, { seen: false });
			return true;
		},
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
