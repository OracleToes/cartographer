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

/**
 * A non-mutating request plan. It reads the active conversation and shared brain as they stand, but never checks or
 * consumes wakes, marks windows shown, advances an attempt, or retains a snapshot. The live send and the prospective
 * inspector both consume this one plan.
 * @param {readonly any[]} messages  the active Durable messages
 * @param {{ brainDir: string, root: string, runner?: any, config?: any, gate?: { yolo?: boolean }, main: boolean, conversationId?: string, note?: string, used?: number, fired?: any[], wakeLines?: any, windowRows?: any[] }} input
 * @returns {{ messages: any[], parts: any[], main: boolean, conversationId?: string, task?: object }}
 */
export function planRequest(messages, { brainDir, root, runner, config, gate, main, conversationId, note, used, fired = [], wakeLines, windowRows }) {
	// Quiet turns that a later wake has overtaken are left out, for the main agent and its tasks alike. These source
	// identities are positional only when Durable did not expose an entry id; the plan says that rather than matching
	// equal text later.
	let kept = withoutQuietWakes(messages);
	const sourceIds = kept.map((message, index) => {
		const known = message?.entryId ?? message?.entry?.id;
		return known === undefined ? `active:${conversationId ?? "unknown"}:${index}` : `durable:${conversationId ?? "unknown"}:${known}`;
	});
	// What the main agent dropped is dropped for its tasks as well: a task's request begins as the main agent's does.
	kept = dressMain(kept, brainDir);
	// File-read results are ephemeral: the newest successful reply's read batch is at the very end; earlier batches are one line.
	// Dressing that tail is request-only and never asks the context engine to collapse.
	const ephemeral = dressReads(kept);
	kept = ephemeral.messages;
	let focus;
	if (!main) {
		focus = conversationId === undefined ? undefined : loadContext(brainDir).tasks[conversationId];
		const beforeTask = kept;
		const sourcesBeforeTask = new WeakMap(beforeTask.map((message, index) => [message, sourceIds[index]]));
		kept = dressTask(kept, focus);
		// A task collapse can introduce one generated block and replace large results. Preserve an original object
		// identity where it survives; name the other output as transformed rather than guessing from equal words.
		sourceIds.splice(0, sourceIds.length, ...kept.map((message, index) => sourcesBeforeTask.get(message) ?? `transformed-active:${conversationId ?? "unknown"}:${index}`));
	}
	// Only chat the person sent gets the speaker label. The task's one-request note is appended afterward.
	let requestMessages = withSpeaker(withNotes(kept));
	if (!main && note !== undefined) {
		const taskNote = { role: "user", content: [{ type: "text", text: note }] };
		kept = [...kept, taskNote];
		requestMessages = [...requestMessages, taskNote];
		sourceIds.push(`task-note:${conversationId ?? "unknown"}`);
	}
	const top = loadTop(brainDir);
	let dressed = withTop(withTimes(requestMessages), top?.text);
	// Capture this plan's ordered sources before transient blocks are glued to the final message. These records are
	// not a reconstruction of a provider payload: they name the active message or request-only addition that planned it.
	const parts = [];
	const firstMessage = dressed.findIndex((message) => message.role !== "system");
	if (top?.text !== undefined && top.text !== "" && firstMessage >= 0 && dressed[firstMessage]?.role === "user") {
		parts.push({ id: `part:${conversationId ?? "unknown"}:top`, kind: "brain-copy", source: "brain:top", lifecycle: "planned", message: firstMessage, fragment: top.text, ...(top.at === undefined ? {} : { sourceAt: top.at }) });
	}
	for (const [index, message] of dressed.entries()) {
		parts.push({ id: `part:${conversationId ?? "unknown"}:message:${index}`, kind: "active-message", source: sourceIds[index] ?? `planned:${conversationId ?? "unknown"}:${index}`, lifecycle: "planned", message: index, role: message.role, fragment: message });
	}
	let state;
	if (main) {
		state = stateBlock(brainDir, runner, { root, config, messages: kept, wakes: wakeLines, fired, yolo: gate?.yolo === true, requests: true, context: contextLines(brainDir, root, { used, window: config?.contextWindow ?? 0, main: true, conversationId }) });
	} else {
		// A focus is a live agent too: it gets the lines about the context itself (how full it is, its own + inherited shelf) and what waits for its user. Wakes alone stay the main agent's — nothing in a focus can act on one.
		state = stateBlock(brainDir, runner, { root, config, messages: kept, yolo: gate?.yolo === true, task: focus ?? {}, requests: true, used, context: contextLines(brainDir, root, { used, window: config?.contextWindow ?? 0, main: false, conversationId }) });
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
 * @param {{ brainDir: string, root: string, runner?: any, config?: any, windows?: any, wakes?: any, gate?: { yolo?: boolean }, main: boolean, conversationId?: string, note?: string, used?: number, replay?: boolean }} input
 */
export function prepareRequest(messages, { brainDir, root, runner, config, windows, wakes, gate, main, conversationId, note, used, replay }) {
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
	});
	// What the windows did up to now is in that block, so it is no longer news the main agent must be woken for.
	if (main && !replay) windows?.noteShown();
	return plan;
}

/** The legacy message-array door used by request fixtures and callers that do not need the plan facts. */
export function dressRequest(messages, input) {
	return prepareRequest(messages, input).messages;
}
