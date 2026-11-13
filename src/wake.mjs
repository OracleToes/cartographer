// Notes that Cartographer writes into the conversation itself, to wake the agent.
//
// The agent works only while it answers a message. When something happens while it
// is idle (a command ends in a shell window, a program asks for input, a trigger the
// agent set with `wake` fires), Cartographer sends a message of its own. It is stored
// like a message of the user, so it is marked from its first line on as not being one.
//
// A turn such a note starts in which the agent did nothing (it called no tool, or only
// `sleep`) is quiet. When the next note follows it, the quiet turn is left out of what
// the model is sent (src/request.mjs), so that watching over something for hours does
// not fill the context with "nothing happened".
import { took } from "./time.mjs";

const OPEN = "<cartographer>";
const HEAD = "Written by Cartographer, not by the user.";
const CLOSE = "</cartographer>";

const textOf = (message) => (typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.map((part) => part.text ?? "").join("") : "");

/** Whether a stored message is one of these notes, and not something the user wrote. */
export const isNote = (message) => textOf(message).startsWith(`${OPEN}\n${HEAD}`);

const first = (command) => {
	const line = String(command ?? "").split("\n")[0];
	return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};

/** One line on what happened, for the note and for the screen. */
export function eventLine(event) {
	if (event.type === "wake") {
		const often = event.count > 1 ? `, the last of ${event.count} times since you were told` : "";
		return `Wake ${event.id} (${event.about}): ${event.what}${often}.${event.last ? " That was its last time, so it is removed." : ""} Your note: ${event.note}`;
	}
	if (event.type === "ended") return `Window ${event.name}: \`${first(event.command)}\` ended with exit ${event.exit} after ${took(event.ms)}.`;
	if (event.type === "closed") return `Window ${event.name} closed: its shell ended, and with it \`${first(event.command)}\` after ${took(event.ms)}.`;
	if (event.type === "asks") return `Window ${event.name}: \`${first(event.command)}\` has printed nothing for a while and its last line has no line end, so it may be waiting for input. The line: ${event.line}`;
	if (event.type === "changed") return `Files changed while ${event.names.length === 1 ? `window ${event.names[0]}` : `windows ${event.names.join(", ")}`} ran with no task around: ${event.summary}. The user can see them with /diff and take them back with /undo.`;
	return `Window ${event.name}: ${event.type}.`;
}

/**
 * The message that wakes the agent.
 * @param {{ type: string, name: string }[]} events
 */
export function wakeNote(events) {
	return [
		OPEN,
		`${HEAD} Nobody typed this. It tells you what happened while you were not working.`,
		"",
		...events.map(eventLine),
		"",
		"Decide what this means for the goal and act on it. When nothing needs doing, call `sleep` and write nothing: a turn in which you did nothing else is forgotten when the next such note comes.",
		CLOSE,
	].join("\n");
}

const NO_CHAT_HEAD = `${OPEN}\n${HEAD} Your last message had no tool call.`;

/**
 * What follows a reply that had no tool call. Such a reply is a note the agent wrote to itself (src/request.mjs
 * marks it so), and the run goes on: the Harness needs a message to go on from, and this is it. The first one of a
 * turn or a task says what a note is; the later ones are as short as they can be.
 * @param {{ main: boolean, first: boolean, extra?: string }} input  extra: one more line, for example the replies left
 */
export const noted = ({ main, first, extra }) =>
	[
		`${NO_CHAT_HEAD}${first ? "" : " Noted."}`,
		...(first
			? [
					"",
					main
						? "So it is kept as a note to yourself, and nobody else read it. If it was meant for the user, say it with `chat`. If work is left, go on with it. If nothing is left to do, call `sleep`."
						: "So it is kept as a note to yourself, and nobody else read it. Go on with the brief. When the work is finished, call `return` with your report.",
				]
			: []),
		...(extra ? ["", extra] : []),
		CLOSE,
	].join("\n");

/** Sent after a reply was cut off because it repeated itself (src/terminal.mjs): the agent gets one more try. */
export const REPEAT_NOTE = (what, task) =>
	[
		OPEN,
		`${HEAD} Nobody typed this. ${task ? "The reply of the task that was running" : "Your last reply"} was cut off, because it was writing the same text over and over (${what}). What it held is lost${task ? ", and the task was stopped with it" : ""}.`,
		"",
		task ? "If the task's work is still needed, start it again with a narrower brief. Otherwise go on from where you were." : "Go on from where you were, with a short reply: one call, or a few sentences.",
		CLOSE,
	].join("\n");

/** Whether a stored message is such a line. */
export const isNoChat = (message) => textOf(message).startsWith(NO_CHAT_HEAD);

/** The tool calls of an assistant message. */
const callsOf = (message) => (Array.isArray(message?.content) ? message.content.filter((part) => part.type === "toolCall") : []);

/**
 * The messages without the quiet turns that a later note has overtaken: a turn that began with a note, in which
 * the agent called no tool but `sleep`, and after which the next message that came in is a note again.
 * A quiet turn the user answered stays, since their message may refer to what the agent said in it.
 * Whether a turn is left out depends only on the stored messages up to the next note, so it never changes back.
 * @param {readonly any[]} messages
 */
export function withoutQuietWakes(messages) {
	const starts = [];
	// The line that follows a reply without a call is written by Cartographer too, but it begins no turn.
	for (const [index, message] of messages.entries()) if (message.role === "user" && !isNoChat(message)) starts.push(index);
	const drop = new Set();
	for (const [at, start] of starts.entries()) {
		const next = starts[at + 1];
		if (next === undefined || !isNote(messages[start]) || !isNote(messages[next])) continue;
		const turn = messages.slice(start + 1, next);
		if (turn.some((message) => callsOf(message).some((call) => call.name !== "sleep"))) continue;
		for (let index = start; index < next; index++) drop.add(index);
	}
	return drop.size === 0 ? messages : messages.filter((_, index) => !drop.has(index));
}
