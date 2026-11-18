// What Cartographer adds to a request on its way to the model server.
//
// None of it is stored in the conversation. Each addition is either the same every
// time it is made (so the server need not read it again), or sits at the very end:
//
//   the first message   the copy of the assessment and the graph (src/top.mjs)
//   the user's messages   named for the model; messages and task reports marked with when they came (src/time.mjs)
//   quiet wake turns    left out once a later wake has overtaken them (src/wake.mjs)
//   replies without a call   marked as notes the agent wrote to itself
//   the last message    the state block, with a task-purpose line for focused contexts, and after it the shell
//                       windows as they are now, for the orchestrator and every focus (src/state.mjs)
//
// And what the context engine changes in what is sent, again without touching what is stored (src/context.mjs):
//
//   reports the main agent dropped      one line each
//   a task's own steps                  collapsed steps as one block, dropped results as one line, large results
//                                       marked with their id and size
//   read results                        ephemeral: the newest successful reply's read batch at the very end of the
//                                       request, after the state and windows blocks; every earlier batch as one line
import { POLICY } from "./config.mjs";
import { contextLines, dressMain, dressReads, dressTask, isFront, loadContext, textOf, withReadTail, withoutFront, withoutReadTail, withoutTags } from "./context.mjs";
import { withoutShelfAsk } from "./read-batch.mjs";
import { isNote, withoutQuietWakes } from "./wake.mjs";
import { stateBlock, windowsBlock, withoutState, withoutWindows, withState } from "./state.mjs";
import { STAMP, stamp, took } from "./time.mjs";
import { loadTop, withoutTop, withTop } from "./top.mjs";
import { USER_NAME } from "./user.mjs";
import { FOCUS_START, TASK_HEADER } from "./prompt.mjs";

const USER_SPEAKER = `${USER_NAME}: `;

/** `message` with `addition` after its last piece of text. */
function append(message, addition) {
	if (typeof message.content === "string") return { ...message, content: message.content + addition };
	const tail = message.content.at(-1);
	if (tail?.type !== "text") return { ...message, content: [...message.content, { type: "text", text: addition.trimStart() }] };
	return { ...message, content: [...message.content.slice(0, -1), { ...tail, text: tail.text + addition }] };
}

/** Prefix the first text part, or add one before non-text parts. */
function prepend(message, addition) {
	if (typeof message.content === "string") return { ...message, content: addition + message.content };
	const content = Array.isArray(message.content) ? message.content : [];
	const head = content[0];
	if (head?.type !== "text") return { ...message, content: [{ type: "text", text: addition }, ...content] };
	return { ...message, content: [{ ...head, text: addition + head.text }, ...content.slice(1)] };
}

/**
 * Each of the user's messages says when it was sent, and each task report when it came and how long the task took.
 * Both are read from the stored message, so a message gets the same words in every request.
 */
export function withTimes(messages) {
	return messages.map((message) => {
		// A note of Cartographer's own (src/wake.mjs) is stored like a message of the user, and was not sent by them.
		// A front block says itself when it was written.
		if (isFront(message)) return message;
		if (message.role === "user" && Number.isFinite(message.timestamp)) return append(message, `\n\n[${isNote(message) ? "noted" : "sent"} ${stamp(message.timestamp)}]`);
		if (message.role === "toolResult" && message.toolName === "task" && Number.isFinite(message.timestamp) && Number.isFinite(message.durationMs)) {
			return append(message, `\n\n[task ended ${stamp(message.timestamp)}, after ${took(message.durationMs)}]`);
		}
		return message;
	});
}

/** What a reply without a tool call begins with in every request: nobody but the agent reads such a reply. */
export const NOTE_TO_SELF = "Note to self: ";

/**
 * A reply that called no tool is a note the agent wrote to itself, and is shown to it as one. The stored message
 * is not touched, and a note gets the same words in every request. A reply that already begins that way, because
 * the model took up the habit, is left as it is.
 */
export function withNotes(messages) {
	return messages.map((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content) || message.content.some((part) => part.type === "toolCall")) return message;
		const at = message.content.findIndex((part) => part.type === "text" && part.text.trim() !== "");
		if (at < 0 || /^\s*note to self\b/i.test(message.content[at].text)) return message;
		return { ...message, content: message.content.map((part, index) => (index === at ? { ...part, text: `${NOTE_TO_SELF}${part.text.trimStart()}` } : part)) };
	});
}

/** Label user-role chat messages in the request without changing stored history or Cartographer's own notes. */
function withSpeaker(messages) {
	return messages.map((message) => {
		if (message.role !== "user" || isFront(message) || isNote(message)) return message;
		const text = textOf(message);
		if (text.startsWith(USER_SPEAKER) || text.startsWith(`${POLICY.markup.note.open}\n`)) return message;
		return prepend(message, USER_SPEAKER);
	});
}

const TIMES = new RegExp(`\\n\\n\\[((?:sent|noted) ${STAMP}|task ended ${STAMP}, after [0-9a-z ]+)\\]`, "g");

/** Text as it is stored: without anything this file adds. */
export function withoutAdditions(text) {
	const stripped = withoutShelfAsk(withoutTags(withoutFront(withoutWindows(withoutState(withoutTop(withoutReadTail(text))))).replace(TIMES, "")));
	return stripped.startsWith(USER_SPEAKER) ? stripped.slice(USER_SPEAKER.length) : stripped;
}

/** Project a Durable focus fork into its local provider context. Fork lineage remains durable, but the provider sees
 * only shared system messages, its prepared capsule, and its own subsequent work. */
function focusProjection(messages) {
	const briefAt = messages.findLastIndex((message) => message.role === "toolResult" && textOf(message).startsWith(TASK_HEADER));
	if (briefAt < 0) return messages;
	const system = messages.slice(0, briefAt).filter((message) => message.role === "system");
	const own = [messages[briefAt]];
	let replied = false;
	for (const message of messages.slice(briefAt + 1)) {
		// Results for sibling calls made in the parent turn can sit beside the fork brief. They are neither local
		// evidence nor task work, so do not leak them into this capsule.
		if (!replied && message.role === "toolResult" && /^That call is a separate task\b/.test(textOf(message))) continue;
		own.push(message);
		if (message.role === "assistant") replied = true;
	}
	return [...system, ...own];
}

/**
 * A non-mutating request plan. It reads the active conversation and shared brain as they stand, but never checks or
 * consumes wakes, marks windows shown, advances an attempt, or retains a snapshot. The live send and the prospective
 * inspector both consume this one plan.
 * @param {readonly any[]} messages  the active Durable messages
 * @param {{ brainDir: string, root: string, runner?: any, config?: any, gate?: { yolo?: boolean }, main: boolean, conversationId?: string, note?: string, used?: number, fired?: any[], wakeLines?: any, windowRows?: any[], sources?: any[] }} input
 * @returns {{ messages: any[], parts: any[], main: boolean, conversationId?: string, task?: object }}
 */
export function planRequest(messages, { brainDir, root, runner, config, gate, main, conversationId, note, used, fired = [], wakeLines, windowRows, sources }) {
	// Quiet turns that a later wake has overtaken are left out, for the main agent and its tasks alike. When Durable
	// did not expose an unambiguous entry source, the plan says `unmapped` rather than inventing a positional or
	// text-derived identity.
	const fallbackSource = (index, kind = "active-message") => ({ id: `unmapped:${conversationId ?? "unknown"}:${index}`, kind, conversationId: String(conversationId ?? "unknown") });
	const sourceAt = (index) => sources?.[index]?.id !== undefined ? { ...sources[index] } : fallbackSource(index);
	const originalSources = new WeakMap();
	for (const [index, message] of messages.entries()) if (message !== null && typeof message === "object") originalSources.set(message, sourceAt(index));
	let kept = withoutQuietWakes(messages);
	let keptSources = kept.map((message, index) => originalSources.get(message) ?? fallbackSource(index));
	let focus;
	let ephemeral;
	if (main) {
		// Main requests retain their active conversation and live planning view.
		kept = dressMain(kept, brainDir);
		ephemeral = dressReads(kept);
		kept = ephemeral.messages;
	} else {
		focus = conversationId === undefined ? undefined : loadContext(brainDir).tasks[conversationId];
		const projectedSources = new WeakMap(kept.map((message, index) => [message, keptSources[index]]));
		kept = focusProjection(kept);
		keptSources = kept.map((message, index) => projectedSources.get(message) ?? fallbackSource(index, "focus-capsule"));
		const beforeTask = kept;
		const sourcesBeforeTask = new WeakMap(beforeTask.map((message, index) => [message, keptSources[index]]));
		const resultSources = new Map(beforeTask.filter((message) => message.role === "toolResult").map((message, index) => [message.toolCallId, sourcesBeforeTask.get(message) ?? fallbackSource(index)]));
		kept = dressTask(kept, focus);
		// A task collapse can introduce one generated block and replace large results. Preserve an original object
		// identity where it survives; name the other output as transformed rather than guessing from equal words.
		keptSources = kept.map((message, index) => sourcesBeforeTask.get(message)
			?? (message.role === "toolResult" ? resultSources.get(message.toolCallId) : undefined)
			?? { id: `transformed-active:${conversationId ?? "unknown"}:${index}`, kind: "transformed-active", conversationId: String(conversationId ?? "unknown") });
		ephemeral = dressReads(kept);
		kept = ephemeral.messages;
	}
	// Only chat the person sent gets the speaker label. The task's one-request note is appended afterward.
	let requestMessages = withSpeaker(withNotes(kept));
	if (!main && note !== undefined) {
		const taskNote = { role: "user", content: [{ type: "text", text: note }] };
		kept = [...kept, taskNote];
		requestMessages = [...requestMessages, taskNote];
		keptSources.push({ id: `task-note:${conversationId ?? "unknown"}`, kind: "task-note", conversationId: String(conversationId ?? "unknown") });
	}
	if (!main) {
		// A Durable fork's prepared brief is a tool result. Some provider chat templates reject a tool-only prefix,
		// so give it one explicit request-only user turn without restoring the parent conversation.
		const capsuleAt = requestMessages.findIndex((message) => message.role === "toolResult" && textOf(message).startsWith(TASK_HEADER));
		if (capsuleAt >= 0) {
			const start = { role: "user", content: [{ type: "text", text: FOCUS_START }] };
			const source = { id: `focus-start:${conversationId ?? "unknown"}`, kind: "focus-start", conversationId: String(conversationId ?? "unknown") };
			requestMessages = [...requestMessages.slice(0, capsuleAt), start, ...requestMessages.slice(capsuleAt)];
			keptSources = [...keptSources.slice(0, capsuleAt), source, ...keptSources.slice(capsuleAt)];
		}
	}
	// The frozen project-top copy is main working memory. A focus begins from its prepared capsule instead of replaying
	// that broad orientation; Durable lineage still retains the parent fork.
	const top = main ? loadTop(brainDir) : undefined;
	let dressed = withTimes(requestMessages);
	if (main) dressed = withTop(dressed, top?.text);
	// Capture this plan's ordered sources before transient blocks are glued to the final message. These records are
	// not a reconstruction of a provider payload: they name the active message or request-only addition that planned it.
	const parts = [];
	const firstMessage = dressed.findIndex((message) => message.role !== "system");
	if (top?.text !== undefined && top.text !== "" && firstMessage >= 0 && dressed[firstMessage]?.role === "user") {
		parts.push({ id: `part:${conversationId ?? "unknown"}:top`, kind: "brain-copy", source: "brain:top", lifecycle: "planned", message: firstMessage, fragment: top.text, ...(top.at === undefined ? {} : { sourceAt: top.at }) });
	}
	for (const [index, message] of dressed.entries()) {
		const source = keptSources[index] ?? { id: `planned:${conversationId ?? "unknown"}:${index}`, kind: "planned", conversationId: String(conversationId ?? "unknown") };
		const capsule = !main && message.role === "toolResult" && textOf(message).startsWith(TASK_HEADER);
		const focusStart = !main && source.kind === "focus-start";
		parts.push({ id: `part:${conversationId ?? "unknown"}:message:${index}`, kind: focusStart ? "focus-start" : capsule ? "focus-capsule" : "active-message", source: source.id, sourceRef: source, lifecycle: "planned", message: index, role: message.role, fragment: message });
	}
	let state;
	if (main) {
		state = stateBlock(brainDir, runner, { root, config, messages: kept, wakes: wakeLines, fired, yolo: gate?.yolo === true, requests: true, context: contextLines(brainDir, root, { used, window: config?.contextWindow ?? 0, main: true, conversationId }) });
	} else {
		// A focus receives local operational state only. Requests, the main plan queue, Dispatch, and unrelated main
		// shelf/report material stay with the orchestrating context.
		state = stateBlock(brainDir, runner, { root, config, messages: kept, yolo: gate?.yolo === true, task: focus ?? {}, used, context: contextLines(brainDir, root, { used, window: config?.contextWindow ?? 0, main: false, conversationId }) });
	}
	const withPlannedState = withState(dressed, state);
	if (withPlannedState !== dressed) {
		dressed = withPlannedState;
		parts.push({ id: `part:${conversationId ?? "unknown"}:state`, kind: "generated-state", source: "harness:state", lifecycle: "planned", fragment: state });
	}
	// The windows come before the current read batch, in a task's request too: they change from one request to
	// the next, and a task that left a command running sees how it is doing each time it thinks.
	const tail = config?.windowTail;
	const windows = windowsBlock(windowRows, { tail });
	if (windows !== "") {
		const withPlannedWindows = withState(dressed, windows);
		if (withPlannedWindows !== dressed) {
			dressed = withPlannedWindows;
			parts.push({ id: `part:${conversationId ?? "unknown"}:windows`, kind: "generated-windows", source: "harness:windows", lifecycle: "planned", fragment: windows });
		}
	}
	// The current read batch, at the very end of the request: after everything else, the blocks included.
	if (ephemeral.tail !== undefined) {
		dressed = withReadTail(dressed, ephemeral.tail);
		parts.push({ id: `part:${conversationId ?? "unknown"}:read-tail`, kind: "transient-read-tail", source: "read-batch:current", lifecycle: "planned", fragment: ephemeral.tail });
	}
	return { messages: dressed, parts, main, ...(conversationId === undefined ? {} : { conversationId }), ...(focus === undefined ? {} : { task: { id: conversationId, mode: focus.mode, move: focus.move } }) };
}

/**
 * The live request planner. Effects that make a real attempt different from a preview stay here, outside
 * `planRequest`: wakes are checked and consumed once, and current window output is marked shown after it was copied.
 * @param {readonly any[]} messages  the request's messages, as stored
 * @param {{ brainDir: string, root: string, runner?: any, config?: any, windows?: any, wakes?: any, gate?: { yolo?: boolean }, main: boolean, conversationId?: string, note?: string, used?: number, replay?: boolean, sources?: any[] }} input
 */
export function prepareRequest(messages, { brainDir, root, runner, config, windows, wakes, gate, main, conversationId, note, used, replay, sources }) {
	let fired = [];
	if (main && !replay) {
		try {
			wakes?.check();
		} catch {
			// A look that failed is taken again at the next tick.
		}
		fired = wakes?.noteShown() ?? [];
	}
	const plan = planRequest(messages, {
		brainDir,
		root,
		runner,
		config,
		gate,
		main,
		conversationId,
		note,
		used,
		fired,
		wakeLines: main ? wakes?.lines() : undefined,
		windowRows: windows?.list(config?.windowTail),
		sources,
	});
	// What the windows did up to now is in that block, so it is no longer news the main agent must be woken for.
	if (main && !replay) windows?.noteShown();
	return plan;
}

/** The legacy message-array door used by request fixtures and callers that do not need the plan facts. */
export function dressRequest(messages, input) {
	return prepareRequest(messages, input).messages;
}
