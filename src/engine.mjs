// The context engine's live part: when a collapse is due, the question that comes
// before it, and the read-ahead after it. What a collapse keeps is in src/context.mjs.
//
// Before a context is collapsed the agent is asked one question, and it can answer
// only {"handoff": true} or {"handoff": false}: the request names that shape as the
// only reply the server may produce, and switches thinking off for it. True buys
// one turn to write down what would be lost; false collapses at once. The question
// is not stored. It is sent after the very request the server read last, so the
// server reads only the question.
//
// After a collapse made while the agent rests, the new and much shorter context is
// sent once with room for a single token of answer. The server reads it then, and
// the user's next message finds it read.
//
// Both are plain requests to the model server, sent from here and not through the
// conversation: they need what the conversation's requests must never have, a fixed
// reply shape and a different end.
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { callWords, droppable, estimate, FLOOR, isFront, loadContext, messageTokens, stepsOf, supersededBy, taskBlock, taskState, textOf, updateContext, writeFront } from "./context.mjs";
import { ASK_MAIN, ASK_TASK, HANDOFF_IN_TURN, TASK_HANDOFF } from "./prompt.mjs";
import { withTimes } from "./request.mjs";
import { loadTop, pin, withTop } from "./top.mjs";

const SCHEMA = {
	type: "json_schema",
	json_schema: { name: "handoff", strict: true, schema: { type: "object", properties: { handoff: { type: "boolean" } }, required: ["handoff"], additionalProperties: false } },
};
/** Seconds the question may take. More than this means the server is reading the whole context again. */
const ASK_SECONDS = 90;

const callsOf = (message) => (Array.isArray(message?.content) ? message.content.filter((part) => part.type === "toolCall") : []);

/** A stored reply in the shape the server is sent. */
function replyForServer(message, results) {
	const text = textOf(message);
	const calls = callsOf(message);
	const out = [{ role: "assistant", content: text === "" ? null : text, ...(calls.length > 0 ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } })) } : {}) }];
	for (const call of calls) out.push({ role: "tool", content: results.get(call.id) ?? "(This call has not returned yet.)", tool_call_id: call.id });
	return out;
}

/**
 * @param {{ root: string, brainDir: string, config: any }} input
 */
export function createEngine({ root, brainDir, config }) {
	// Per conversation: the body of the last request as it was sent, the reply to it, what its calls returned so
	// far, the stored messages that request was made from, and the server's count of tokens.
	const sent = new Map();
	const listeners = new Set();
	const of = (id) => {
		if (!sent.has(id)) sent.set(id, { results: new Map() });
		return sent.get(id);
	};
	const emit = (event) => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				// The screen's trouble is not the engine's.
			}
		}
	};
	// The conversation that sent the newest request.
	let newest;
	// Whether the server has refused the answer's schema in this run of carto: the question is then asked without it.
	let noSchema = false;
	/** A collapse of the main context that is wanted: { reason, asked?, byAgent?, forced?, round? }. */
	let due;
	const full = () => Math.floor((config.contextWindow * config.collapseFull) / 100);

	/** One request to the server that is not part of any conversation. */
	async function post(body, { seconds, signal }) {
		const began = Date.now();
		const timer = AbortSignal.timeout(seconds * 1000);
		try {
			const response = await fetch(`${config.server}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer local" },
				body: JSON.stringify(body),
				signal: signal === undefined ? timer : AbortSignal.any([timer, signal]),
			});
			const text = await response.text();
			if (!response.ok) return { error: `the server answered ${response.status}: ${text.replace(/\s+/g, " ").slice(0, 300)}`, ms: Date.now() - began };
			return { json: JSON.parse(text), ms: Date.now() - began };
		} catch (error) {
			const aborted = signal?.aborted === true;
			return { error: aborted ? "stopped" : error?.name === "TimeoutError" ? `no answer within ${seconds} s` : String(error?.cause?.message ?? error?.message ?? error), aborted, ms: Date.now() - began };
		}
	}

	/**
	 * Ask whether a turn is wanted before the collapse.
	 * @param {string} conversationId
	 * @param {{ reason: string, task?: boolean, results?: readonly any[] }} input  results: stored tool results that came after the last reply
	 * @returns {Promise<{ handoff: boolean, error?: string, ms: number }>}  on an error `handoff` is false
	 */
	async function ask(conversationId, { reason, task = false, results = [] }) {
		const state = of(conversationId);
		// Nothing was sent in this run of carto yet: there is no request to put the question behind, and the server
		// would have to read the whole context to answer it.
		if (state.payload === undefined) return { handoff: false, skipped: true, ms: 0 };
		const returned = new Map(state.results);
		for (const result of results) returned.set(result.toolCallId, textOf(result));
		const { stream_options: _dropped, ...base } = state.payload;
		const body = {
			...base,
			messages: [...state.payload.messages, ...(state.reply === undefined ? [] : replyForServer(state.reply, returned)), { role: "user", content: task ? ASK_TASK(reason) : ASK_MAIN(reason) }],
			stream: false,
			max_tokens: 16,
			temperature: 0,
			// Thinking off for this one request: the answer is one word.
			chat_template_kwargs: { enable_thinking: false },
			// The tools stay in the request, because the server has read them as part of the prompt. But no call can
			// be the answer, and with some chat templates llama.cpp cannot build the grammar for "this JSON or a call
			// of any of these tools" at all: it answers 400 "failed to parse grammar" (seen with the Qwen3.8 template
			// on build 11913; with tool_choice none the same request is accepted and the prompt is not read again).
			...(Array.isArray(base.tools) && base.tools.length > 0 ? { tool_choice: "none" } : {}),
		};
		// A server that will not take the schema is asked the same question without it, from then on.
		let answer = noSchema ? undefined : await post({ ...body, response_format: SCHEMA }, { seconds: config.askSeconds ?? ASK_SECONDS });
		let fallback;
		if (answer?.error !== undefined && /answered 4\d\d/.test(answer.error)) {
			noSchema = true;
			fallback = answer.error;
		}
		if (answer === undefined || fallback !== undefined) answer = await post(body, { seconds: config.askSeconds ?? ASK_SECONDS });
		const also = fallback === undefined ? {} : { fallback };
		if (answer.error !== undefined) return { handoff: false, error: answer.error, ms: answer.ms, ...also };
		const said = answer.json?.choices?.[0]?.message?.content ?? "";
		let handoff;
		try {
			handoff = JSON.parse(said)?.handoff;
		} catch {
			handoff = /"handoff"\s*:\s*true/.test(said) ? true : /"handoff"\s*:\s*false/.test(said) ? false : undefined;
		}
		if (typeof handoff !== "boolean") return { handoff: false, error: `the answer was not the JSON asked for: ${JSON.stringify(String(said).slice(0, 120))}`, ms: answer.ms, ...also };
		return { handoff, ms: answer.ms, ...also };
	}

	/**
	 * Collapse the main context now: bring the top up to date, write the front block.
	 * @returns {{ text: string }} the front block, to be stored as the start of the new context
	 */
	function collapse({ reason, midTurn, now = Date.now(), before }) {
		// Everything is read again anyway: the moment to bring the copy of assessment and graph up to date.
		try {
			pin(brainDir, { now, reason });
		} catch {
			// The old copy stays.
		}
		const front = writeFront(brainDir, root, config, { now, reason, midTurn });
		const state = of(ROOT_CONVERSATION_ID);
		const fixed = state.payload === undefined ? undefined : estimate(JSON.stringify(state.payload.tools ?? [])) + estimate(state.payload.messages?.[0]?.role === "system" ? state.payload.messages[0].content : "");
		const info = { at: now, reason, before: before ?? state.used, after: fixed === undefined ? undefined : fixed + estimate(loadTop(brainDir)?.text ?? "") + front.tokens.total, kept: front.kept, left: front.left, midTurn: midTurn !== undefined };
		updateContext(brainDir, (store) => {
			store.last = { at: info.at, reason, before: info.before, after: info.after, kept: info.kept };
		});
		due = undefined;
		state.collapsed = info;
		// The server's count belongs to the context that is gone.
		state.used = undefined;
		return { text: front.text, info };
	}

	return {
		on(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** The stored messages a request is made from. */
		seen(conversationId, messages) {
			of(conversationId).messages = messages;
		},
		messagesOf: (conversationId) => of(conversationId).messages,
		/** The body of a request as it is sent. */
		sending(conversationId, payload) {
			const state = of(conversationId);
			newest = conversationId;
			state.sentAt = Date.now();
			state.sent = (state.sent ?? 0) + 1;
			state.payload = payload;
			state.reply = undefined;
			state.results = new Map();
		},
		/** The reply to it. */
		replied(conversationId, message) {
			const state = of(conversationId);
			state.reply = message;
			state.results = new Map();
			const used = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0) + (message.usage?.output ?? 0);
			if (used > 0) state.used = used;
		},
		/** What one call of that reply returned. */
		returned(conversationId, call, result) {
			const text = [...(result.output ?? []).map((part) => part.text ?? ""), ...(result.diagnostics ?? []).map((entry) => `[${entry.severity}] ${entry.message}`)].join("\n").trim();
			of(conversationId).results.set(call.id, text);
		},
		usedBy: (conversationId) => of(conversationId).used,
		/**
		 * What an agent was last sent, exactly as the server got it, and what has come since: for the screen's
		 * Context tab. `which` is "main" for the main agent, anything else for whoever asked last (a task while
		 * one runs). undefined before the first request of this run of carto.
		 * @returns {undefined | { task: boolean, payload: any, reply?: any, results: Map<string, string>, at: number, count: number, used?: number, collapsedSince: boolean }}
		 */
		window(which) {
			const id = which === "main" || newest === undefined ? ROOT_CONVERSATION_ID : newest;
			const state = of(id);
			if (state.payload === undefined) return undefined;
			const at = id === ROOT_CONVERSATION_ID ? loadContext(brainDir).front?.at : undefined;
			const front = typeof at === "number" ? at : Date.parse(at ?? "");
			return { task: id !== ROOT_CONVERSATION_ID, payload: state.payload, reply: state.reply, results: state.results ?? new Map(), at: state.sentAt, count: state.sent, used: state.used, collapsedSince: Number.isFinite(front) && front > state.sentAt };
		},
		/** What the last collapse did, for the screen; read once. */
		takeCollapsed() {
			const state = of(ROOT_CONVERSATION_ID);
			const info = state.collapsed;
			state.collapsed = undefined;
			return info;
		},
		/** Want the main context collapsed. `asked`: no question is needed (the agent asked for it itself). */
		want(reason, more = {}) {
			if (due === undefined || more.asked) due = { reason, ...more };
		},
		due: () => due,
		forget() {
			due = undefined;
		},
		ask,
		collapse,
		droppable,

		/**
		 * After one call of the main agent has returned: decide whether its context collapses with this round.
		 * @param {{ last: boolean, round: number, turn?: { by: "user" | "note", reminded: boolean } }} at  last: no call of this reply is still out
		 * @returns {Promise<{ note?: string, handoff?: string } | undefined>}  note: text to add to the result; handoff: the front block
		 */
		async afterMainCall(at) {
			const state = of(ROOT_CONVERSATION_ID);
			if (due === undefined && Number.isFinite(state.used) && state.used >= full()) {
				due = { reason: `it held about ${Math.round((state.used / config.contextWindow) * 100)}% of what fits`, forced: true };
			}
			// A collapse that waits for the end of the turn it was given (the agent was resting when it was asked).
			if (due === undefined || due.atRest) return undefined;
			// A reply that ends the turn (nothing but `chat` or `sleep`): the collapse waits for the rest that follows,
			// where the server can read the result ahead. Here it would tell the agent that its turn goes on.
			if (callsOf(state.reply).every((call) => call.name === "chat" || call.name === "sleep")) return undefined;
			const stored = state.messages ?? [];
			const would = droppable(stored) + (state.reply === undefined ? 0 : messageTokens(state.reply)) + [...state.results.values()].reduce((sum, text) => sum + estimate(text), 0);
			// Almost nothing would go (a goal that closes early; a context that is full of what a collapse keeps):
			// collapsing would only make the server read the rest again, and when it is full, do so after every reply.
			if (!due.asked && !due.byAgent && would < FLOOR) {
				due = undefined;
				return undefined;
			}
			let note;
			if (!due.asked) {
				due.asked = true;
				const choice = await ask(ROOT_CONVERSATION_ID, { reason: due.reason });
				emit({ type: "asked", reason: due.reason, ...choice });
				if (choice.handoff) {
					due.round = at.round;
					note = HANDOFF_IN_TURN(due.reason);
				}
			}
			// The reply that was told gets its turn: the collapse comes with a later one.
			if (due.round === at.round) return note === undefined ? undefined : { note };
			if (!at.last) return undefined;
			const reply = state.reply;
			const turnStart = stored.findLast((message) => message.role === "user" && !isFront(message));
			const { text } = collapse({
				reason: due.reason,
				before: state.used,
				midTurn: {
					by: at.turn?.by ?? "user",
					reminded: at.turn?.reminded ?? false,
					...(at.turn?.by === "note" && turnStart !== undefined ? { note: textOf(turnStart).replace(/<\/?cartographer>\n?/g, "").trim().slice(0, 2000) } : {}),
					calls: callsOf(reply).map((call) => ({ text: `${call.name} ${JSON.stringify(call.arguments ?? {}).slice(0, 300)}`, result: state.results.get(call.id) ?? "(no result)" })),
				},
			});
			return { handoff: text };
		},

		/**
		 * Before a task's request: collapse its own steps when the context is nearly full, or when it asked for it.
		 * @param {string} conversationId
		 * @param {readonly any[]} messages  the task's stored messages
		 * @returns {Promise<string | undefined>}  a note to put at the end of this one request
		 */
		async beforeTaskRequest(conversationId, messages) {
			const steps = stepsOf(messages);
			if (steps === undefined) return undefined;
			const state = of(conversationId);
			const mine = loadContext(brainDir).tasks[conversationId] ?? {};
			const hidden = mine.cut?.steps ?? 0;
			const visible = messages.slice(steps.start + hidden).reduce((sum, message) => sum + messageTokens(message), 0);
			const nearlyFull = Number.isFinite(state.used) && state.used >= full() && visible >= FLOOR;
			let why;
			if (mine.pending === "now" || mine.pending === "told") why = mine.reason ?? "You asked for it";
			else if (nearlyFull) {
				why = `Your context held about ${Math.round((state.used / config.contextWindow) * 100)}% of what fits`;
				const results = messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1).filter((message) => message.role === "toolResult");
				const choice = await ask(conversationId, { reason: why, task: true, results });
				emit({ type: "asked", task: true, reason: why, ...choice });
				if (choice.handoff) {
					updateContext(brainDir, (store) => {
						Object.assign(taskState(store, conversationId), { pending: "told", reason: why });
					});
					return TASK_HANDOFF;
				}
			}
			if (why === undefined) return undefined;
			const before = state.used;
			updateContext(brainDir, (store) => {
				const task = taskState(store, conversationId);
				task.cut = { steps: messages.length - steps.start, block: taskBlock(root, config, steps, task, { reason: why }), at: Date.now() };
				task.pending = undefined;
				task.reason = undefined;
			});
			state.used = undefined;
			emit({ type: "task-collapsed", reason: why, before, replies: steps.replies, calls: steps.results.length });
			return undefined;
		},

		/** After a task's `read`: earlier copies of the same lines become one line each. Returns their ids. */
		afterTaskRead(conversationId, args) {
			const messages = of(conversationId).messages;
			const steps = messages === undefined ? undefined : stepsOf(messages);
			if (steps === undefined) return [];
			const mine = loadContext(brainDir).tasks[conversationId] ?? {};
			const hidden = mine.cut?.steps ?? 0;
			const inView = { ...steps, results: steps.results.filter((result) => result.index >= steps.start + hidden) };
			const ids = supersededBy(inView, args, mine.dropped ?? {});
			if (ids.length > 0) {
				updateContext(brainDir, (store) => {
					const task = taskState(store, conversationId);
					task.dropped ??= {};
					for (const id of ids) task.dropped[id] = "An earlier read of the same lines stood here; the newer one is further down.";
				});
			}
			return ids;
		},

		/**
		 * Send the collapsed context once so that the server has read it when the next message comes.
		 * @param {string} front  the front block as it was stored
		 * @param {number} at  when it was stored
		 * @returns {{ done: Promise<{ ms: number, tokens?: number, error?: string, aborted?: boolean }>, abort: () => void } | undefined}
		 *   undefined when no request was sent in this run yet: there is nothing to copy the prompt and tools from
		 */
		readAhead(front, at) {
			const state = of(ROOT_CONVERSATION_ID);
			if (state.payload === undefined) return undefined;
			const { stream_options: _dropped, ...base } = state.payload;
			const system = state.payload.messages[0]?.role === "system" ? [state.payload.messages[0]] : [];
			// The front block as the next request will carry it: with the copy of assessment and graph before it.
			const [dressed] = withTop(withTimes([{ role: "user", content: [{ type: "text", text: front }], timestamp: at }]), loadTop(brainDir)?.text);
			const body = { ...base, messages: [...system, { role: "user", content: textOf(dressed) }], stream: false, max_tokens: 1 };
			const controller = new AbortController();
			const done = post(body, { seconds: config.readAheadSeconds ?? 600, signal: controller.signal }).then((answer) => ({
				ms: answer.ms,
				...(answer.error !== undefined ? { error: answer.error, aborted: answer.aborted === true } : { tokens: answer.json?.usage?.prompt_tokens }),
			}));
			return { done, abort: () => controller.abort() };
		},

		/**
		 * The parts of the main context and how large each is, for /context.
		 * @param {readonly any[]} messages  the stored messages of the main conversation
		 */
		sizes(messages, stateText = "") {
			const state = of(ROOT_CONVERSATION_ID);
			const store = loadContext(brainDir);
			const front = messages.find(isFront);
			const work = messages.filter((message) => !isFront(message)).reduce((sum, message) => sum + messageTokens(message), 0);
			return {
				used: state.used,
				fixed: state.payload === undefined ? undefined : estimate(JSON.stringify(state.payload.tools ?? [])) + estimate(state.payload.messages?.[0]?.role === "system" ? state.payload.messages[0].content : ""),
				top: estimate(loadTop(brainDir)?.text ?? ""),
				front: front === undefined ? undefined : { ...store.front, total: estimate(textOf(front)) },
				work,
				frees: droppable(messages),
				state: estimate(stateText),
				store,
				full: full(),
				due,
			};
		},
		callWords,
	};
}
