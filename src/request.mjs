// What Cartographer adds to a request on its way to the model server.
//
// None of it is stored in the conversation. Each addition is either the same every
// time it is made (so the server need not read it again), or sits at the very end:
//
//   the first message   the copy of the assessment and the graph (src/top.mjs)
//   the user's messages and task reports   when they came (src/time.mjs)
//   quiet wake turns    left out once a later wake has overtaken them (src/wake.mjs)
//   replies without a call   marked as notes the agent wrote to itself
//   the last message    the state block, for the main agent only, and after it the shell windows as they
//                       are now, for the main agent and every task (src/state.mjs)
//
// And what the context engine changes in what is sent, again without touching what is stored (src/context.mjs):
//
//   reports the main agent dropped      one line each
//   a task's own steps                  collapsed steps as one block, dropped results as one line, large results
//                                       marked with their id and size
import { contextLines, dressMain, dressTask, isFront, loadContext, withoutFront, withoutTags } from "./context.mjs";
import { isNote, withoutQuietWakes } from "./wake.mjs";
import { stateBlock, windowsBlock, withoutState, withoutWindows, withState } from "./state.mjs";
import { STAMP, stamp, took } from "./time.mjs";
import { loadTop, withoutTop, withTop } from "./top.mjs";

/** `message` with `addition` after its last piece of text. */
function append(message, addition) {
	if (typeof message.content === "string") return { ...message, content: message.content + addition };
	const tail = message.content.at(-1);
	if (tail?.type !== "text") return { ...message, content: [...message.content, { type: "text", text: addition.trimStart() }] };
	return { ...message, content: [...message.content.slice(0, -1), { ...tail, text: tail.text + addition }] };
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

const TIMES = new RegExp(`\\n\\n\\[((?:sent|noted) ${STAMP}|task ended ${STAMP}, after [0-9a-z ]+)\\]`, "g");

/** Text as it is stored: without anything this file adds. */
export function withoutAdditions(text) {
	return withoutTags(withoutFront(withoutWindows(withoutState(withoutTop(text)))).replace(TIMES, ""));
}

/**
 * @param {readonly any[]} messages  the request's messages, as stored
 * @param {{ brainDir: string, root: string, runner?: any, config?: any, windows?: any, wakes?: any, gate?: { yolo?: boolean }, main: boolean, conversationId?: string, note?: string, used?: number }} input
 *   conversationId: whose request it is; note: for a task, a note for this one request; used: the server's count
 *   of tokens for the last reply
 *   main: the main agent's request; windows: the session's shell windows (src/windows.mjs); wakes: its wake
 *   triggers (src/wakes.mjs); gate: whether the user has switched approval off
 */
export function dressRequest(messages, { brainDir, root, runner, config, windows, wakes, gate, main, conversationId, note, used }) {
	// Quiet turns that a later wake has overtaken are left out, for the main agent and its tasks alike (src/wake.mjs).
	let kept = withoutQuietWakes(messages);
	// What the main agent dropped is dropped for its tasks as well: a task's request begins as the main agent's does.
	kept = dressMain(kept, brainDir);
	if (!main) {
		kept = dressTask(kept, conversationId === undefined ? undefined : loadContext(brainDir).tasks[conversationId]);
		// Said once, at the end of this request only (src/engine.mjs).
		if (note !== undefined) kept = [...kept, { role: "user", content: [{ type: "text", text: note }] }];
	}
	let dressed = withTop(withTimes(withNotes(kept)), loadTop(brainDir)?.text);
	if (main) {
		// What fired while the agent worked is told in the block, so it needs no turn of its own.
		try {
			wakes?.check();
		} catch {
			// A look that failed is taken again at the next tick.
		}
		const fired = wakes?.noteShown() ?? [];
			dressed = withState(dressed, stateBlock(brainDir, runner, { root, config, messages: kept, wakes: wakes?.lines(), fired, yolo: gate?.yolo === true, requests: true, context: contextLines(brainDir, root, { used, window: config?.contextWindow ?? 0 }) }));
	}
	// The windows come last of all, in a task's request too: they change from one request to the next, and a
	// task that left a command running sees how it is doing each time it thinks.
	const tail = config?.windowTail;
	const block = windowsBlock(windows?.list(tail), { tail });
	if (block !== "") dressed = withState(dressed, block);
	// What the windows did up to now is in that block, so it is no longer news the main agent must be woken for.
	if (main) windows?.noteShown();
	return dressed;
}
