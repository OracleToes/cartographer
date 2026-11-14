// What is kept when the context is collapsed, and how it is written.
//
// Nothing the conversation holds is ever deleted from storage. A collapse starts a
// new stretch of context, and that stretch begins with one message Cartographer
// writes, the front block, between <context> and </context>:
//
//   the record   one line for each finished task: what was asked, how it ended, and
//                an id under which the whole report can be brought back
//   the shelf    files, or line ranges of files, the agent chose to keep in view
//   the talk     the last of what the user and the agent said to each other, word
//                for word, up to `chatWindow` tokens
//   now          when the collapse came in the middle of a turn: the calls of the
//                last reply and what they returned
//
// The agent's own notes, old tool calls and results, and reports in full are not
// carried over. The ledger, the plan, the graph and the assessment are files of
// their own and are untouched.
//
// So a request is, in order: the prompt and the tools; the assessment and the graph
// (src/top.mjs); the front block; what happened since the collapse; the state block
// (src/state.mjs). Between two collapses only the end of that changes, which is all
// the model server then has to read.
//
// What a collapse needs is collected as it happens, not dug out of the conversation
// afterwards: the task tool writes the record line and the report file when a task
// ends, and what is said is noted when it is said. It is kept in
// <project>/.atlas/carto-context.json, the reports in <project>/.atlas/reports/.
//
// A task has the same means for its own steps, and only for those: what stands in
// front of its brief is the main agent's and stays as it is (see `dressTask`).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TASK_HEADER } from "./prompt.mjs";
import { stamp } from "./time.mjs";
import { confine, LookError, readOne } from "./tools/look.mjs";

const OPEN = "<context>";
const CLOSE = "</context>";
const HEAD = "Written by Cartographer, not by the user.";
const NOTE_OPEN = "<cartographer>";
const NOTE_CLOSE = "</cartographer>";

/** Tokens of record lines a front block holds at most; older tasks are counted, not listed. */
const RECORD_MAX_TOKENS = 3000;
/** A collapse that would free less than this is not worth reading the kept part again. */
export const FLOOR = 1500;
/** The most of one result of the last reply that the front block quotes. */
const NOW_MAX_CHARS = 16_000;
/** A task's result of at least this many characters gets a tag with its id and size. */
const TAG_MIN_CHARS = 1200;
/** Lines of a file the shelf shows at most. */
const SHELF_MAX_LINES = 1000;

export const contextPath = (brainDir) => join(brainDir, "carto-context.json");
export const reportsDir = (brainDir) => join(brainDir, "reports");

/** A rough count of tokens: four characters each. The server's own count is used wherever there is one. */
export const estimate = (text) => Math.ceil(String(text ?? "").length / 4);
const count = (n) => Math.round(n).toLocaleString("en-US");
const oneLine = (text, max) => {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const hashOf = (text) => createHash("sha1").update(text).digest("hex").slice(0, 16);
export const textOf = (message) =>
	typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") : "";
const callsOf = (message) => (Array.isArray(message?.content) ? message.content.filter((part) => part.type === "toolCall") : []);

/** Roughly how many tokens a stored message takes in a request. */
export function messageTokens(message) {
	let chars = textOf(message).length + 12;
	for (const call of callsOf(message)) chars += call.name.length + JSON.stringify(call.arguments ?? {}).length + 24;
	return Math.ceil(chars / 4);
}

// ─── The store ───────────────────────────────────────────────────────────────

const empty = () => ({ version: 1, next: 1, records: [], chat: [], seenUser: 0, shelf: [], dropped: [], tasks: {} });

/** What is kept for the next collapse. A file that cannot be read counts as an empty one. */
export function loadContext(brainDir) {
	const path = contextPath(brainDir);
	if (!existsSync(path)) return empty();
	try {
		const store = JSON.parse(readFileSync(path, "utf8"));
		if (store === null || typeof store !== "object" || Array.isArray(store)) return empty();
		const base = empty();
		for (const key of ["records", "chat", "shelf", "dropped"]) if (!Array.isArray(store[key])) store[key] = base[key];
		if (store.tasks === null || typeof store.tasks !== "object" || Array.isArray(store.tasks)) store.tasks = {};
		if (!Number.isInteger(store.next) || store.next < 1) store.next = store.records.length + 1;
		if (!Number.isFinite(store.seenUser)) store.seenUser = 0;
		return store;
	} catch {
		return empty();
	}
}

export function saveContext(brainDir, store) {
	const path = contextPath(brainDir);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(store, null, "\t")}\n`);
	renameSync(temp, path);
}

/** Change the store in one step. */
export function updateContext(brainDir, change) {
	const store = loadContext(brainDir);
	const result = change(store);
	saveContext(brainDir, store);
	return result;
}

// ─── The record ──────────────────────────────────────────────────────────────

/** The id the next finished task is recorded under. */
export function reserveId(brainDir) {
	return updateContext(brainDir, (store) => `t${store.next++}`);
}

/** The first line of a report that says something. */
function outcomeOf(report) {
	const line = String(report ?? "")
		.split("\n")
		.map((entry) => entry.replace(/^[#>*\-\s]+/, "").trim())
		.find((entry) => entry !== "" && !/^REPORT$/i.test(entry));
	return oneLine(line ?? "(nothing written)", 180);
}

/**
 * Keep a finished task: its report as a file, and one line for the record. Doing it twice for one id changes nothing.
 * @param {{ id: string, at: number, mode: string, item?: string, brief: string, report: string, failed?: boolean, changed?: number }} task
 */
export function addRecord(brainDir, task) {
	mkdirSync(reportsDir(brainDir), { recursive: true });
	const head = [`Report ${task.id} · ${stamp(task.at)} · ${task.mode} task${task.item ? ` for ${task.item}` : ""}${task.failed ? " · it did not end well" : task.undone ? " · returned not done" : ""}`, "", "Brief:", task.brief, "", "Report:"].join("\n");
	writeFileSync(join(reportsDir(brainDir), `${task.id}.md`), `${head}\n${task.report}\n`);
	updateContext(brainDir, (store) => {
		const record = {
			id: task.id,
			at: task.at,
			mode: task.mode,
			...(task.item ? { item: task.item } : {}),
			brief: oneLine(task.brief, 140),
			// What the task itself asked to be remembered by (`summary` of `return`), or the start of its report.
			outcome: String(task.summary ?? "").trim() !== "" ? oneLine(task.summary, 400) : outcomeOf(task.report),
			...(task.failed ? { failed: true } : {}),
			...(task.undone && !task.failed ? { undone: true } : {}),
			...(task.changed > 0 ? { changed: task.changed } : {}),
		};
		const at = store.records.findIndex((entry) => entry.id === task.id);
		if (at >= 0) store.records[at] = record;
		else store.records.push(record);
	});
}

/** A kept report in full, or undefined when there is none under this id. */
export function loadReport(brainDir, id) {
	if (!/^t\d+$/.test(String(id))) return undefined;
	const path = join(reportsDir(brainDir), `${id}.md`);
	return existsSync(path) ? readFileSync(path, "utf8").trimEnd() : undefined;
}

/** What a task report says at its end, so that the agent knows the id. */
export const KEPT_AS = (id) => `This report is kept as ${id}.`;
const KEPT_ALL = /This report is kept as (t\d+)\./g;
/** What follows a report that `context` brought back. */
export const RECALLED = "[Recalled. It is in view until your context is next collapsed.]";
/** The id of the report a stored tool result holds in full: as the task returned it, or as it was recalled. */
function reportIdOf(message) {
	if (message.role !== "toolResult") return undefined;
	const text = textOf(message);
	// The last one counts: a report may quote the line of another.
	if (message.toolName === "task") return [...text.matchAll(KEPT_ALL)].at(-1)?.[1];
	if ((message.toolName === "context" || message.toolName === "book") && text.endsWith(RECALLED)) return /^Report (t\d+) · /.exec(text)?.[1];
	return undefined;
}

export const recordLine = (record) =>
	`${record.id} · ${stamp(record.at)} · ${record.mode}${record.item ? ` ${record.item}` : ""} · asked: ${record.brief} → ${record.failed ? "did not end well: " : record.undone ? "not done: " : ""}${record.outcome}${record.changed ? ` · ${record.changed === 1 ? "1 file" : `${record.changed} files`} changed` : ""}`;

function recordText(records) {
	// A record the user has archived stands out of the block for good (its report stays, and recall knows the id);
	// only what is listed here costs the model a reading.
	const shown = records.filter((record) => record.archived !== true);
	if (shown.length === 0) return { text: records.length === 0 ? "No task has finished yet." : "No task stands in the record; older ones are archived (recall by id brings one back).", listed: 0 };
	const lines = [];
	let used = 0;
	for (const record of [...shown].reverse()) {
		const line = recordLine(record);
		if (used + estimate(line) > RECORD_MAX_TOKENS && lines.length > 0) break;
		used += estimate(line);
		lines.unshift(line);
	}
	const older = shown.length - lines.length;
	if (older > 0) lines.unshift(`(${older} earlier ${older === 1 ? "task is" : "tasks are"} not listed, ${shown[0].id} to ${shown[older - 1].id}; their reports can still be recalled.)`);
	return { text: lines.join("\n"), listed: lines.length - (older > 0 ? 1 : 0) };
}

// ─── The talk ────────────────────────────────────────────────────────────────

/** Note something the user or the agent said, for the chat window. `at` tells two sayings apart. */
export function noteChat(brainDir, who, at, text, { seen = true } = {}) {
	const said = String(text ?? "").trim();
	if (said === "") return;
	updateContext(brainDir, (store) => {
		if (store.chat.some((entry) => entry.who === who && entry.at === at && entry.text === said)) return;
		store.chat.push({ who, at, text: said });
		// `seen: false`: words of the user that are not a message of the conversation (an answer to `ask`, a line
		// typed to a running task), so the messages that are still count as new.
		if (who === "user" && seen) store.seenUser = Math.max(store.seenUser, at);
	});
}

/** Note the user's messages of a request that were not noted yet. */
export function noteUserMessages(brainDir, messages) {
	const seen = loadContext(brainDir).seenUser;
	const fresh = messages.filter((message) => message.role === "user" && Number.isFinite(message.timestamp) && message.timestamp > seen && !isNoteText(textOf(message)) && !isFront(message));
	for (const message of fresh) noteChat(brainDir, "user", message.timestamp, textOf(message));
}

const isNoteText = (text) => text.startsWith(`${NOTE_OPEN}\n${HEAD}`);
const chatLine = (entry) => `[${entry.who === "user" ? "user" : "you"} · ${stamp(entry.at)}] ${entry.text}`;

/** The newest sayings that fit into `max` tokens; the newest one is kept whatever its size. */
function chatWindow(chat, max) {
	const kept = [];
	let used = 0;
	for (const entry of [...chat].reverse()) {
		const size = estimate(chatLine(entry));
		if (used + size > max && kept.length > 0) break;
		used += size;
		kept.unshift(entry);
	}
	return kept;
}

// ─── The shelf ───────────────────────────────────────────────────────────────

export class ShelfError extends Error {}

/** "10-80" → { from: 10, to: 80 }; nothing → the whole file. */
export function parseLines(lines) {
	if (lines === undefined || lines === null || String(lines).trim() === "") return {};
	const found = /^\s*(\d+)\s*(?:-|to|\.\.)\s*(\d+)\s*$/.exec(String(lines));
	if (!found) throw new ShelfError('`lines` is a range like "10-80"; leave it out for the whole file.');
	const from = Number(found[1]);
	const to = Number(found[2]);
	if (from < 1 || to < from) throw new ShelfError(`lines ${from}-${to} is not a range: the first line is 1 and the second number is the last line.`);
	return { from, to };
}

/** One shelved item as the agent reads it: the file's lines with their numbers. */
export function shelfText(root, item) {
	return item.from === undefined ? readOne(root, item.path, 1, SHELF_MAX_LINES) : readOne(root, item.path, item.from, Math.min(SHELF_MAX_LINES, item.to - item.from + 1));
}

export const shelfLabel = (item) => `${item.path}${item.from === undefined ? "" : ` (lines ${item.from}-${item.to})`}`;

/**
 * Check a path for the shelf and measure it.
 * @returns {{ item: { path: string, from?: number, to?: number }, tokens: number }}
 */
export function shelfItem(root, given, lines) {
	let path;
	try {
		path = confine(root, given);
	} catch (error) {
		if (error instanceof LookError) throw new ShelfError(error.message);
		throw error;
	}
	if (!existsSync(path.abs)) throw new ShelfError(`${path.rel} does not exist. The tree in the state block shows the files.`);
	if (!statSync(path.abs).isFile()) throw new ShelfError(`${path.rel} is a directory: the shelf holds files, or line ranges of files.`);
	const item = { path: path.rel, ...parseLines(lines) };
	const text = shelfText(root, item);
	if (!/^== .* \(lines \d+-\d+ of \d+\)\n/.test(text) && !/\n\(empty file\)$/.test(text)) throw new ShelfError(text.split("\n").slice(1).join(" ") || `${path.rel} cannot be read.`);
	return { item, tokens: estimate(text) };
}

/** The shelf's items with their text as the files are now, in order, up to `max` tokens. */
function shelfBlock(root, items, max) {
	const shown = [];
	const left = [];
	let used = 0;
	for (const item of items) {
		const text = shelfText(root, item);
		const size = estimate(text);
		if (/\nNot found\. /.test(text)) {
			left.push({ item, why: "the file is gone" });
			continue;
		}
		if (used + size > max) {
			left.push({ item, why: `it no longer fits: about ${count(size)} tokens` });
			continue;
		}
		used += size;
		shown.push({ item, text, hash: hashOf(text) });
	}
	return { shown, left, tokens: used };
}

// ─── The front block ─────────────────────────────────────────────────────────

/** Whether a stored message is a front block. */
export const isFront = (message) => message?.role === "user" && textOf(message).startsWith(`${OPEN}\n${HEAD}`);

/** Text with every front block removed (for the tests' stand-in, and for display). */
export const withoutFront = (text) => text.replace(/<context>\nWritten by Cartographer[\s\S]*?\n<\/context>\n*/g, "");

/**
 * Write the front block for a collapse that happens now, and remember what it holds.
 * @param {string} brainDir
 * @param {string} root
 * @param {{ chatWindow: number, shelfTokens: number }} config
 * @param {{ now: number, reason: string, midTurn?: { by: "user" | "note", reminded: boolean, note?: string, calls: { text: string, result: string }[] } }} input
 * @returns {{ text: string, kept: { tasks: number, shelf: number, talk: number }, tokens: { record: number, shelf: number, talk: number, now: number, total: number }, left: { item: object, why: string }[] }}
 */
export function writeFront(brainDir, root, config, { now, reason, midTurn }) {
	return updateContext(brainDir, (store) => {
		const record = recordText(store.records);
		const shelf = shelfBlock(root, store.shelf, config.shelfTokens);
		// What no longer fits or is gone leaves the shelf, and the block says so.
		store.shelf = shelf.shown.map((entry) => entry.item);
		store.chat = chatWindow(store.chat, config.chatWindow);
		const talk = store.chat.map(chatLine).join("\n");
		const parts = [
			OPEN,
			`${HEAD} Your context was collapsed on ${stamp(now)} (${reason}). What you had in view before is gone except for what stands here: one line for each finished task, your shelf, and the last of your talk with the user. Your ledger, plan, graph and assessment are as you left them; the state block at the end of the request shows them.`,
			"",
			"Finished tasks (`context` with action recall and the id brings a report back in full)",
			record.text,
			"",
			shelf.shown.length === 0 ? "Your shelf is empty." : `Your shelf: ${shelf.shown.length === 1 ? "1 item" : `${shelf.shown.length} items`}, as the files were at the collapse`,
			...shelf.shown.map((entry) => entry.text),
			...shelf.left.map((entry) => `(${shelfLabel(entry.item)} was taken off the shelf: ${entry.why}.)`),
			"",
			store.chat.length === 0 ? "You and the user have not talked yet." : "Your talk with the user, word for word; what was said before it is gone",
			...(talk === "" ? [] : [talk]),
		];
		let nowText = "";
		if (midTurn !== undefined) {
			const lines = ["", "This collapse came in the middle of your turn, so the turn goes on."];
			if (midTurn.by === "note" && midTurn.note) lines.push(`The turn began with this note from Cartographer, not with a message of the user:\n${midTurn.note}`);
			if (midTurn.calls.length > 0) {
				lines.push("The calls of your last reply, all carried out, and what each returned:");
				for (const call of midTurn.calls) {
					const result = call.result.length > NOW_MAX_CHARS ? `${call.result.slice(0, NOW_MAX_CHARS)}\n…[cut here; a report can be recalled in full by its id]` : call.result;
					lines.push(`▸ ${call.text}\n${result}`);
				}
			}
			lines.push("Go on from here: do what is left of the turn, or end it.");
			nowText = lines.join("\n");
			parts.push(nowText);
		}
		parts.push(CLOSE);
		const text = parts.join("\n");
		const tokens = { record: estimate(record.text), shelf: shelf.tokens, talk: estimate(talk), now: estimate(nowText), total: estimate(text) };
		store.dropped = [];
		store.front = {
			at: now,
			reason,
			shelf: shelf.shown.map((entry) => ({ ...entry.item, hash: entry.hash })),
			tokens,
			kept: { tasks: record.listed, shelf: shelf.shown.length, talk: store.chat.length },
			...(midTurn !== undefined ? { midTurn: { by: midTurn.by, reminded: midTurn.reminded } } : {}),
		};
		return { text, kept: store.front.kept, tokens, left: shelf.left };
	});
}

/** Forget what a fresh context should not show: the talk, the record's lines and the shelf. Reports stay recallable. */
export function clearFront(brainDir) {
	updateContext(brainDir, (store) => {
		store.chat = [];
		store.records = [];
		store.shelf = [];
		store.dropped = [];
		store.front = undefined;
	});
}

/**
 * How much of a context would go at a collapse: everything behind the front block that is not talk.
 * @param {readonly any[]} messages the stored messages of the main conversation
 */
export function droppable(messages) {
	let total = 0;
	for (const message of messages) {
		if (isFront(message)) continue;
		if (message.role === "user" && !isNoteText(textOf(message))) continue;
		if (message.role === "assistant") {
			// What was said with `chat` moves into the talk.
			const said = callsOf(message).filter((call) => call.name === "chat").reduce((sum, call) => sum + estimate(call.arguments?.text), 0);
			total += Math.max(0, messageTokens(message) - said);
		} else total += messageTokens(message);
	}
	return total;
}

/**
 * The lines the state block adds about the context: how full it is, and what on the shelf is not as shown.
 * @param {{ used?: number, window: number }} size  used: the server's count for the last reply
 */
export function contextLines(brainDir, root, { used, window }) {
	const store = loadContext(brainDir);
	const lines = [];
	if (Number.isFinite(used) && used > 0) lines.push(`Your context holds about ${count(used)} of ${count(window)} tokens.`);
	// Folding by the agent: it sees exactly which reports stand in view in full, with their size, so it can
	// decide when each has had its bookkeeping done and fold it to its one-line record (recallable by id).
	const full = store.records.filter((record) => !store.dropped.includes(record.id));
	if (full.length > 0) lines.push(`In view in full: ${full.map((record) => `${record.id} (about ${count(estimate(record.report ?? ""))} tokens)`).join(", ")}. Fold one with \`context\` once you have done its bookkeeping.`);
	const shown = store.front?.shelf ?? [];
	const key = (item) => `${item.path}:${item.from ?? ""}-${item.to ?? ""}`;
	const waiting = store.shelf.filter((item) => !shown.some((entry) => key(entry) === key(item)));
	const leaving = shown.filter((entry) => !store.shelf.some((item) => key(item) === key(entry)));
	const changed = shown.filter((entry) => store.shelf.some((item) => key(item) === key(entry)) && hashOf(shelfText(root, entry)) !== entry.hash);
	if (waiting.length > 0) lines.push(`Marked for your shelf, in view from the next collapse on: ${waiting.map(shelfLabel).join(", ")}.`);
	if (leaving.length > 0) lines.push(`Taken off your shelf, gone from view at the next collapse: ${leaving.map(shelfLabel).join(", ")}.`);
	if (changed.length > 0) lines.push(`Changed since your shelf was written, so the copy on the shelf is old: ${changed.map(shelfLabel).join(", ")}.`);
	return lines.length === 0 ? "" : `Context\n${lines.join("\n")}\n\n`;
}

// ─── The main agent's own drops ──────────────────────────────────────────────

/** The reports that stand in full in these messages, by id. */
export function reportsInView(messages) {
	const found = new Map();
	for (const [index, message] of messages.entries()) {
		const id = reportIdOf(message);
		if (id !== undefined) found.set(id, { index, tokens: messageTokens(message) });
	}
	return found;
}

const withText = (message, text) => ({ ...message, content: [{ type: "text", text }] });

/** The main agent's messages with the reports it dropped replaced by their record line. The input is not changed. */
export function dressMain(messages, brainDir) {
	const store = loadContext(brainDir);
	if (store.dropped.length === 0) return messages;
	return messages.map((message) => {
		const id = reportIdOf(message);
		if (id === undefined || !store.dropped.includes(id)) return message;
		const record = store.records.find((entry) => entry.id === id);
		return withText(message, `[You dropped report ${id} from view. Its record: ${record ? recordLine(record) : "(no line kept)"}. \`context\` with action recall and ${id} brings it back.]`);
	});
}

// ─── A task's own steps ──────────────────────────────────────────────────────

/**
 * The steps a task has taken: everything behind its brief.
 * @returns {{ start: number, replies: number, results: { id: string, index: number, call?: { name: string, arguments: any }, tokens: number, chars: number, isError: boolean, first: string }[], notes: string[] } | undefined}
 *   undefined when the messages hold no brief (they are not a task's)
 */
export function stepsOf(messages) {
	const brief = messages.findLastIndex((message) => message.role === "toolResult" && textOf(message).startsWith(TASK_HEADER));
	if (brief < 0) return undefined;
	let start = brief + 1;
	while (start < messages.length && messages[start].role === "toolResult") start++;
	const calls = new Map();
	const results = [];
	const notes = [];
	let replies = 0;
	for (let index = start; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "assistant") {
			replies++;
			for (const call of callsOf(message)) calls.set(call.id, call);
			const text = textOf(message).trim();
			if (text !== "") notes.push(text);
		} else if (message.role === "toolResult") {
			const text = textOf(message);
			results.push({ id: `s${results.length + 1}`, index, call: calls.get(message.toolCallId), tokens: messageTokens(message), chars: text.length, isError: message.isError === true, first: text.split("\n")[0] });
		}
	}
	return { start, replies, results, notes };
}

/** A call in a few words, for a list of what was done. */
export function callWords(call) {
	if (call === undefined) return "a call";
	const args = call.arguments ?? {};
	if (call.name === "read") return `read ${[].concat(args.paths ?? []).join(", ")}${args.offset !== undefined ? ` from line ${args.offset}` : ""}`;
	if (call.name === "search") return `search /${oneLine(args.pattern, 40)}/${args.path ? ` in ${args.path}` : ""}`;
	if (call.name === "list") return `list ${args.path ?? "."}`;
	if (call.name === "write" || call.name === "edit") return `${call.name} ${args.path ?? ""}`;
	if (call.name === "shell") return `shell ${oneLine(args.command, 60)}`;
	if (call.name === "book") {
		const ops = Array.isArray(args.ops) ? args.ops : [];
		if (args.book === "context") {
			const op = ops[0] ?? {};
			return `context ${op.action ?? "?"} ${oneLine(op.id ?? op.path ?? op.text ?? "", 40)}`.trim();
		}
		const what = args.book === "plan" ? ops.map((op) => `${op?.action ?? "?"} ${op?.id ?? op?.mode ?? ""}`.trim()) : ops.map((op) => `${op?.action ?? "?"} ${op?.id ?? op?.kind ?? ""}`.trim());
		return `${args.book ?? "book"} ${oneLine(what.join(", "), 60)}`.trim();
	}
	return `${call.name} ${oneLine(JSON.stringify(args), 60)}`;
}

/**
 * The earlier reads that a new read makes pointless: the same files, and the new one shows at least the same lines.
 * Only where it pays: the old copy is large, and what the server must read again for it is not much more.
 * @param {ReturnType<typeof stepsOf>} steps  the steps before the new read
 * @param {{ paths?: string[] | string, offset?: number, limit?: number }} args  the new read's arguments
 * @param {Record<string, string>} dropped  what is replaced already
 * @returns {string[]} step ids
 */
export function supersededBy(steps, args, dropped = {}) {
	const paths = new Set([].concat(args.paths ?? []));
	const whole = args.offset === undefined && args.limit === undefined;
	const ids = [];
	let behind = 0;
	for (const result of [...steps.results].reverse()) {
		const old = result.call;
		const size = dropped[result.id] === undefined ? result.tokens : 0;
		if (old?.name === "read" && !result.isError && dropped[result.id] === undefined) {
			const oldPaths = [].concat(old.arguments?.paths ?? []);
			const covered = oldPaths.length > 0 && oldPaths.every((path) => paths.has(path)) && (whole || (old.arguments?.offset === args.offset && old.arguments?.limit === args.limit));
			if (covered && result.tokens >= 400 && behind <= result.tokens * 8) ids.push(result.id);
		}
		behind += size;
	}
	return ids;
}

/**
 * The block that stands in for a task's collapsed steps.
 * @param {string} root
 * @param {{ shelfTokens: number }} config
 * @param {NonNullable<ReturnType<typeof stepsOf>>} steps
 * @param {{ notes?: string[], shelf?: object[] }} state
 * @param {{ reason: string }} input
 */
export function taskBlock(root, config, steps, state, { reason }) {
	const notes = [...(state.notes ?? []).map((note) => `- ${note}`), ...steps.notes.map((note) => `- ${note}`)];
	// The newest notes win when there are too many.
	let used = 0;
	const keptNotes = [];
	for (const note of [...notes].reverse()) {
		if (used + estimate(note) > 4000 && keptNotes.length > 0) break;
		used += estimate(note);
		keptNotes.unshift(note);
	}
	const done = steps.results.slice(-60).map((result) => `${result.id} ${callWords(result.call)} → ${result.isError ? "failed: " : ""}${oneLine(result.first, 90)}`);
	const shelf = shelfBlock(root, state.shelf ?? [], config.shelfTokens);
	return [
		NOTE_OPEN,
		`${HEAD} ${reason}, so your steps up to here (${steps.replies === 1 ? "1 reply" : `${steps.replies} replies`}, ${steps.results.length === 1 ? "1 call" : `${steps.results.length} calls`}) were collapsed: their results are no longer in view. You are still the task, and the brief above still holds. What you kept:`,
		"",
		"Your notes",
		keptNotes.length === 0 ? "(none)" : keptNotes.join("\n"),
		"",
		`Your calls so far${steps.results.length > done.length ? `, the last ${done.length} of ${steps.results.length}` : ""} (call again for a result you need)`,
		done.length === 0 ? "(none)" : done.join("\n"),
		"",
		shelf.shown.length === 0 ? "Your shelf is empty." : `Your shelf: ${shelf.shown.length === 1 ? "1 item" : `${shelf.shown.length} items`}, as the files are now`,
		...shelf.shown.map((entry) => entry.text),
		...shelf.left.map((entry) => `(${shelfLabel(entry.item)} is not shown: ${entry.why}.)`),
		"",
		"Go on with the brief from here. Your final message is still the report.",
		NOTE_CLOSE,
	].join("\n");
}

/** What a task is shown in place of a result it no longer needs. */
const marker = (result, why) => `[${result.id}: ${why} It was: ${callWords(result.call)}, about ${count(result.tokens)} tokens. Call again if you need it.]`;

/**
 * A task's messages as they are sent: collapsed steps replaced by their block, dropped results by one line, and
 * each large result marked with its id and size. What stands in front of the brief is not touched. The input is
 * not changed.
 * @param {readonly any[]} messages  the task's stored messages
 * @param {{ cut?: { steps: number, block: string, at: number }, dropped?: Record<string, string> } | undefined} state
 */
export function dressTask(messages, state) {
	const steps = stepsOf(messages);
	if (steps === undefined) return messages;
	const dropped = state?.dropped ?? {};
	const byIndex = new Map(steps.results.map((result) => [result.index, result]));
	const hidden = Math.min(state?.cut?.steps ?? 0, messages.length - steps.start);
	const out = messages.slice(0, steps.start);
	if (hidden > 0) out.push({ role: "user", content: [{ type: "text", text: state.cut.block }], timestamp: state.cut.at });
	for (let index = steps.start + hidden; index < messages.length; index++) {
		const message = messages[index];
		const result = byIndex.get(index);
		if (result === undefined) out.push(message);
		else if (dropped[result.id] !== undefined) out.push(withText(message, marker(result, dropped[result.id])));
		else if (result.chars >= TAG_MIN_CHARS) out.push(withText(message, `${textOf(message)}\n\n[${result.id} · about ${count(result.tokens)} tokens]`));
		else out.push(message);
	}
	return out;
}

/** Text without the tags `dressTask` adds (for the tests' stand-in). */
export const withoutTags = (text) => text.replace(/\n\n\[s\d+ · about [\d,]+ tokens\]$/g, "");

/** A task's state, made when first asked for. */
export function taskState(store, conversationId) {
	store.tasks[conversationId] ??= {};
	return store.tasks[conversationId];
}

// ─── The user's own hands on the context ────────────────────────────────────

/**
 * The user archives reports: their record lines leave the block the collapse keeps, so a project with a
 * thousand finished tasks does not read a thousand one-liners. The report stays on disk and recall by id
 * still finds it. Returns the line to show.
 */
export function archiveReports(brainDir, ids) {
	const store = loadContext(brainDir);
	const known = ids.filter((id) => store.records.some((record) => record.id === id));
	const open = ids.filter((id) => !known.includes(id));
	if (known.length === 0) return `There is no report ${ids.join(", ")}. /context lists the kept ones.`;
	updateContext(brainDir, (next) => {
		for (const record of next.records) if (known.includes(record.id)) record.archived = true;
		next.dropped = [...new Set([...next.dropped, ...known])];
	});
	return `${known.join(", ")} archived: the record ${known.length === 1 ? "line leaves" : "lines leave"} the kept block, the report ${known.length === 1 ? "stays" : "stay"} on disk, recall by id still finds ${known.length === 1 ? "it" : "them"}. ${open.length > 0 ? `No report ${open.join(", ")}.` : ""}`.trim();
}

/** The user brings archived reports back into the record. Returns the line to show. */
export function unarchiveReports(brainDir, ids) {
	const store = loadContext(brainDir);
	const held = ids.filter((id) => store.records.some((record) => record.id === id && record.archived === true));
	const rest = ids.filter((id) => !held.includes(id));
	if (held.length === 0) return `${ids.join(", ")} ${ids.length === 1 ? "is" : "are"} not archived.`;
	updateContext(brainDir, (next) => {
		for (const record of next.records) if (held.includes(record.id)) delete record.archived;
	});
	return `${held.join(", ")} back in the record: the next collapse lists ${held.length === 1 ? "its" : "their"} line${held.length === 1 ? "" : "s"} again. ${rest.length > 0 ? `${rest.join(", ")} ${rest.length === 1 ? "was" : "were"} not archived.` : ""}`.trim();
}

/**
 * The user deletes reports for good: the record line and the report's file are gone, and nothing recalls
 * them again. Returns the line to show.
 */
export function deleteReports(brainDir, ids) {
	const store = loadContext(brainDir);
	const known = ids.filter((id) => store.records.some((record) => record.id === id));
	const open = ids.filter((id) => !known.includes(id));
	if (known.length === 0) return `There is no report ${ids.join(", ")}. /context lists the kept ones.`;
	updateContext(brainDir, (next) => {
		next.records = next.records.filter((record) => !known.includes(record.id));
		next.dropped = next.dropped.filter((entry) => !known.includes(entry));
	});
	const gone = [];
	for (const id of known) {
		const file = join(reportsDir(brainDir), `${id}.md`);
		try {
			unlinkSync(file);
			gone.push(id);
		} catch {
			// The file was already gone; the record is deleted all the same.
		}
	}
	return `${known.join(", ")} deleted: the record ${known.length === 1 ? "line is" : "lines are"} gone and ${gone.length > 0 ? `${gone.length === 1 ? "its file is" : `${gone.length} files are`} gone from ${reportsDir(brainDir)}` : "their files were already gone"}. Nothing recalls ${known.length === 1 ? "it" : "them"} again. ${open.length > 0 ? `No report ${open.join(", ")}.` : ""}`.trim();
}

/** The user's message, as it shows in the talk, was edited: the line the context keeps is rewritten to match. */

/** Two shelf items are the same file. */
const sameItem = (a, b) => a.path === b.path;
// The same operations the agent has with `context`, for the person watching: /fold, /recall, /shelve and
// /unshelve on the terminal, and the keys of the Context tab in the full screen. Nothing here is a tool; the
// user is the one the requests are for, and these change the stored context exactly as the agent's calls do.

/** The user folds reports out of view, leaving their record lines. Returns the line to show. */
export function foldReports(brainDir, ids) {
	const store = loadContext(brainDir);
	const unknown = ids.filter((id) => !store.records.some((record) => record.id === id));
	const foldable = ids.filter((id) => {
		const record = store.records.find((entry) => entry.id === id);
		return record !== undefined && record.archived !== true && !store.dropped.includes(id);
	});
	if (foldable.length === 0) {
		const open = store.records.filter((record) => record.archived !== true && !store.dropped.includes(record.id)).map((record) => record.id);
		return unknown.length === ids.length
			? `There is no report ${ids.join(", ")}. The kept ones: ${store.records.map((record) => record.id).join(", ") || "none yet"}.`
			: `${ids.join(", ")} ${ids.length === 1 ? "is" : "are"} already out of view.${open.length > 0 ? ` In full: ${open.join(", ")}.` : ""}`;
	}
	updateContext(brainDir, (next) => {
		next.dropped = [...new Set([...next.dropped, ...foldable])];
	});
	const said = foldable.map((id) => `${id}: ${recordLine(store.records.find((record) => record.id === id))}`).join("\n  ");
	return `${unknown.length > 0 ? `no report ${unknown.join(", ")}; ` : ""}out of view, the record line stands in ${foldable.length === 1 ? "its" : "their"} place:\n  ${said}\n/recall ${foldable.join(" ")} brings ${foldable.length === 1 ? "it" : "them"} back.`;
}

/** The user recalls a kept report. One that is only folded stands in view again; one that is not is printed for the user to read, and stays out of the model's view. Returns the line to show, or undefined. */
export function recallReport(brainDir, id) {
	const store = loadContext(brainDir);
	if (!store.records.some((record) => record.id === id)) return undefined;
	if (store.dropped.includes(id)) {
		updateContext(brainDir, (next) => {
			next.dropped = next.dropped.filter((entry) => entry !== id);
		});
		return `${id} stands in its place again, in view.`;
	}
	const report = loadReport(brainDir, id);
	return `${id} is in view already. As it stands:\n${report ?? "(its file is gone)"}`;
}

/** The user shelves a file, as the agent does: in view from the next collapse on. Throws ShelfError. */
export function shelveForUser(root, brainDir, config, path, lines) {
	const { item, tokens } = shelfItem(root, path, lines);
	const store = loadContext(brainDir);
	const others = store.shelf.filter((entry) => !sameItem(entry, item));
	const total = others.reduce((sum, entry) => sum + estimate(shelfText(root, entry)), 0) + tokens;
	if (total > config.shelfTokens) {
		throw new ShelfError(`${shelfLabel(item)} is about ${count(tokens)} tokens, and the shelf would then hold ${count(total)} of at most ${count(config.shelfTokens)}. Shelve a range of lines instead, or take something off first${others.length > 0 ? `: ${others.map(shelfLabel).join(", ")}` : ""}.`);
	}
	updateContext(brainDir, (next) => {
		const at = next.shelf.findIndex((entry) => sameItem(entry, item));
		if (at >= 0) next.shelf[at] = item;
		else next.shelf.push(item);
	});
	return `${shelfLabel(item)} is marked for the shelf (about ${count(tokens)} tokens; the shelf then holds ${count(total)} of ${count(config.shelfTokens)}). From the next collapse on it stands at the start, and every task begins with it read.`;
}

/** The user takes a file, or everything, off the shelf. Throws ShelfError for a name that is not on it. */
export function unshelveForUser(brainDir, path) {
	const store = loadContext(brainDir);
	const gone = path === "all" ? [...store.shelf] : store.shelf.filter((entry) => entry.path === path || entry.path === path.replace(/^\.\//, ""));
	if (gone.length === 0) throw new ShelfError(`${path} is not on the shelf.${store.shelf.length > 0 ? ` On it: ${store.shelf.map(shelfLabel).join(", ")}.` : " The shelf is empty."}`);
	updateContext(brainDir, (next) => {
		next.shelf = next.shelf.filter((entry) => !gone.some((other) => sameItem(other, entry)));
	});
	return `Taken off the shelf: ${gone.map(shelfLabel).join(", ")}. A copy that stands in the context stays until the next collapse.`;
}

/** A message, as it shows, was edited in the editor: the line the talk keeps is rewritten to match. A note of the agent stands nowhere in the talk, so there is nothing to rewrite for one. */
export function reviseNote(brainDir, from, to) {
	const said = String(from ?? "").trim();
	const next = String(to ?? "").trim();
	if (said === "" || next === "" || said === next) return false;
	let changed = false;
	updateContext(brainDir, (store) => {
		const at = store.chat.findLastIndex((entry) => entry.text === said);
		if (at >= 0) {
			store.chat[at] = { ...store.chat[at], text: next };
			changed = true;
		}
	});
	return changed;
}

/**
 * The user takes a message out of the talk the collapse keeps: it is gone from view, and the next collapse keeps
 * nothing of it. What was sent stays stored, and the agent reads it until then. @returns whether it was there
 */
export function forgetChat(brainDir, text) {
	const said = String(text ?? "").trim();
	if (said === "") return false;
	let changed = false;
	updateContext(brainDir, (store) => {
		const at = store.chat.findLastIndex((entry) => entry.text === said);
		if (at >= 0) {
			store.chat.splice(at, 1);
			changed = true;
		}
	});
	return changed;
}

/**
 * What a task hands on to the main agent's shelf when it ends, and the cleaning up after it.
 * @returns {{ added: string[], refused: string[] }}
 */
export function endTaskContext(root, brainDir, config, conversationId) {
	return updateContext(brainDir, (store) => {
		const task = store.tasks[conversationId];
		delete store.tasks[conversationId];
		const added = [];
		const refused = [];
		for (const { handOn, ...item } of (task?.shelf ?? []).filter((entry) => entry.handOn === true)) {
			const others = store.shelf.filter((entry) => entry.path !== item.path);
			const total = [...others, item].reduce((sum, entry) => sum + estimate(shelfText(root, entry)), 0);
			if (total > config.shelfTokens) {
				refused.push(shelfLabel(item));
				continue;
			}
			store.shelf = [...others, item];
			added.push(shelfLabel(item));
		}
		return { added, refused };
	});
}
