import { POLICY } from "./config.mjs";
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
import { RECORD } from "./voice.mjs";
import { USER_NAME, USER_HEAD } from "./user.mjs";

const OPEN = POLICY.markup.note.open;
const HEAD = RECORD;
const CLOSE = POLICY.markup.note.close;

const textOf = (message) => (typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.map((part) => part.text ?? "").join("") : "");

/** Whether a stored message is one of these notes, and not something the user wrote. */
export const isNote = (message) => textOf(message).startsWith(`${OPEN}\n${HEAD}`);

/**
 * What two notes are the same note for the loop check: the words, not the layout and not the case.
 * Two notes are the same note when they carry the same words in the same order, ignoring runs of
 * whitespace and case. It does not read meaning — a reworded note is a different note — so the loop
 * check is a floor under a runaway run of the *same* note, never a ceiling on notes in general;
 * the stretch is bounded regardless by the reply limit.
 */
export const noteKey = (text) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const first = (command) => {
	const line = String(command ?? "").split("\n")[0];
	return line.length > POLICY.limits.wakes.noteSummaryChars ? `${line.slice(0, POLICY.limits.wakes.noteSummaryChars)}…` : line;
};

/** One line on what happened, for the note and for the screen. */
export function eventLine(event) {
	if (event.type === "wake") {
		const often = event.count > 1 ? `, the last of ${event.count} times since I was told` : "";
		return `Wake ${event.id} (${event.about}): ${event.what}${often}.${event.last ? " That was its last time, so it is removed." : ""} My note: ${event.note}`;
	}
	if (event.type === "ended") return `Window ${event.name}: \`${first(event.command)}\` ended with exit ${event.exit} after ${took(event.ms)}.`;
	if (event.type === "closed") return `Window ${event.name} closed: its shell ended, and with it \`${first(event.command)}\` after ${took(event.ms)}.`;
	if (event.type === "asks") return `Window ${event.name}: \`${first(event.command)}\` has printed nothing for a while and its last line has no line end, so it may be waiting for input. The line: ${event.line}`;
	if (event.type === "changed") return `Files changed while ${event.names.length === 1 ? `window ${event.names[0]}` : `windows ${event.names.join(", ")}`} ran with no task around: ${event.summary}. ${USER_HEAD} can see them with /diff and take them back with /undo.`;
	return `Window ${event.name}: ${event.type}.`;
}

/**
 * The message that wakes the agent.
 * @param {{ type: string, name: string }[]} events
 */
export function wakeNote(events) {
	return [
		OPEN,
		`${HEAD} Nobody typed this. It tells me what happened while I was not working.`,
		"",
		...events.map(eventLine),
		"",
		"I decide what this means for the goal and act on it. When nothing needs doing, I call `sleep` and write nothing: a turn in which I did nothing else is forgotten when the next such note comes.",
		CLOSE,
	].join("\n");
}

/**
 * The message that gives the agent its first turn, at the start of a session, when nothing is waiting on it (src/cli.mjs passes the option through; /initiate switches it).
 */
export function startNote() {
	return [
		OPEN,
		`${HEAD} Nobody typed this. The session has started, and nothing is waiting on me: this turn is mine.`,
		"",
		`The standing duty. I look at the project — what it is, how it builds, how it tests, where the entry points are, what the docs claim — and record what I learn in the books and the atlas. I form hypotheses and record them; I verify what I can, with the commands I may run; I carry out one approved move revision at a time. When nothing remains — no unmapped ground at the tree depth in view, no untested hypothesis, no approved runnable move, no question waiting for ${USER_NAME} — I call \`sleep\`.`,
		CLOSE,
	].join("\n");
}

const NO_CHAT_HEAD = `${OPEN}\n${HEAD} My last message had no tool call.`;

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
						? `So it is kept as a note to myself, and nobody else read it. If it was meant for ${USER_NAME}, I say it with \`chat\`. If work is left, I go on with it. If nothing is left to do, I call \`sleep\`.`
						: "So it is kept as a note to myself, and nobody else read it. I go on with the brief. When the work is finished, I call `return` with my report.",
				]
			: []),
		...(extra ? ["", extra] : []),
		CLOSE,
	].join("\n");

/** Sent after a reply was cut off because it repeated itself (src/terminal.mjs): the agent gets one more try. */
export const REPEAT_NOTE = (what, task) =>
	[
		OPEN,
		`${HEAD} Nobody typed this. ${task ? "The reply of the focused context that was running" : "My last reply"} was cut off, because it was writing the same text over and over (${what}). What it held is lost${task ? ", and the task was stopped with it" : ""}.`,
		"",
		task ? "If the task's work is still needed, it is started again with a narrower brief. Otherwise I go on from where I was." : "I go on from where I was, with a short reply: one call, or a few sentences.",
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
