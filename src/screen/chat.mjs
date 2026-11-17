// The Chat tab: the conversation, with the agent's work folded into pointers.
//
// What the user and the agent say to each other stands in full. What the agent does in between is a run of calls,
// and a run is one line, "▸ 20 calls · 1m 12s": opening it shows one line per call, and opening a call shows what
// it returned, or leads to the tab where that work lives (a write to Diff, a command to Shells, the plan to
// Carto). The run that is going on now is open by itself, with its newest calls, and the reply that is being
// written is shown as it grows, whatever it holds: notes, a message, or the arguments of a call.
//
// How it looks is a hierarchy, and a line says where it stands in it (src/screen/theme.mjs has the colours):
//   what you say           a block in your hue, bold
//   what the agent says    plain text on the screen's own background, as Markdown: the most readable thing there is
//   what the agent does    a block in the tools' hue; a mark at full strength for each call, the rest muted
//   what Cartographer says muted, with its mark picked out; a warning in the colour of attention
//   notes and thinking     faint and italic, behind a gutter
// Blocks of different kinds stand a blank row apart, and what a task leaves behind stands right under its run.
//
// This file is the model: items in, lines out. A line is { spans, bg?, styled?, … }: `bg` names the block it
// belongs to, and `styled` is the line with its escape sequences when a Markdown renderer made it. It draws
// nothing and knows no terminal (src/screen/app.mjs does).
import { POLICY } from "../config.mjs";
import { describeCall, describeResult } from "../terminal.mjs";
import { isFront } from "../context.mjs";
import { splitTop } from "../top.mjs";
import { parseStory, STORY_ID } from "../story.mjs";
import { cut, repeats, span, width, wrap } from "./text.mjs";

/** How many of a run's newest calls are shown while it is going on. */
const LIVE_ROWS = POLICY.limits.screen.chatLiveRows;
/** How many rows of the reply that is being written are shown. */
const LIVE_TEXT_ROWS = POLICY.limits.screen.chatLiveTextRows;
/** The most of the context sent to the storyteller that an opened consult row shows; the question always shows in full. */
const CONTEXT_MAX = Math.floor(POLICY.limits.screen.chatDetailChars / 2);
/** The most of one result that is kept for opening it in place. */
const DETAIL_MAX = POLICY.limits.screen.chatDetailChars;
/** The most rows an opened result shows; the rest is in the tab it leads to, or in /report. */
const DETAIL_ROWS = POLICY.limits.screen.chatDetailRows;
/** The most rows an opened request block shows (the state block and the copy at the top of the context). */
const BLOCK_ROWS = DETAIL_ROWS * 2;
/** Items kept; older ones leave the tab (they stay in the session and in the export of what is left). */
const ITEMS_MAX = POLICY.limits.screen.chatItems;

/** An empty row between two blocks. One for all of them, so that it is painted once. */
const BLANK = { spans: [] };

/** The tab a call's work lives in, and the view inside it. */
export function homeOf(name, args = {}) {
	if (name === "book") {
		const target = args?.target;
		if (target === "file" && (args?.action === "create" || args?.action === "edit" || args?.action === "remove")) return { tab: "diff" };
		if (target === "ledger" || target === "plan" || target === "atlas") return { tab: "carto", view: target };
		// The assessment rides in the context tab's copied top block; it has no view of its own.
		if (target === "assessment") return { tab: "context", view: "window" };
		if (target === "context") return { tab: "context" };
		return undefined;
	}
	if (name === "write" || name === "edit") return { tab: "diff" };
	if (name === "shell") return { tab: "shells" };
	if (name === "plan") return { tab: "carto", view: "plan" };
	if (name === "ledger") return { tab: "carto", view: "ledger" };
	if (name === "assess") return { tab: "context", view: "window" };
	if (name === "context" || name === "shelf") return { tab: "context" };
	return undefined;
}

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
const thinkingOf = (message) => (message?.content ?? []).flatMap((part) => (part.type === "thinking" ? [part.thinking ?? ""] : [])).join("\n");
const callsOf = (message) => (Array.isArray(message?.content) ? message.content.filter((part) => part.type === "toolCall") : []);
const plain = (text) => text.replace(/<\/?harness>/g, "").replace(/\[error\] (Tool call blocked: )?/, "").trim();
/** The argument of a call that is worth watching while it is written: the longest text in it. */
function bodyOf(call) {
	const args = call.arguments ?? {};
	let best = "";
	for (const key of ["content", "newText", "new_text", "oldText", "old_text", "command", "brief", "report", "detail", "gist", "text", "done_when", "input", "context", "question"]) {
		if (typeof args[key] === "string" && args[key].length > best.length) best = args[key];
	}
	return best;
}

/**
 * @param {{ now?: () => number, markdown?: (text: string, cols: number) => { styled: string, cells: number, text: string }[], describeRef?: (ref: object) => string | undefined, readFile?: (rel: string) => string | undefined }} options
 *   markdown: renders what the agent says; without it, the text is wrapped as it is
 *   readStory: reads the story under a thread (st1, st2, …); for a consult row, so the whole exchange can be shown from
 *   the story itself, without keeping that text in the session. Without it, a consult row
 *   opens to the call and its outcome only.
 */
export function createChat({ now = () => Date.now(), markdown, describeRef, readStory } = {}) {
	/** @type {any[]} */
	const items = [];
	const rows = new Map(); // call id -> row
	const live = new Map(); // depth -> the reply being written there
	const toolTails = new Map(); // call id -> the tail of a running tool's output, as the harness keeps it
	let thinking = true;
	// Counted up when the colours change: what was rendered with the old ones is made again.
	let styleRev = 0;
	let serial = 0;
	let version = 0;
	const touch = () => {
		version++;
	};
	const push = (item) => {
		item.key = ++serial;
		items.push(item);
		if (items.length > ITEMS_MAX) items.splice(0, items.length - ITEMS_MAX);
		touch();
		return item;
	};
	/** The run of calls that is going on, or a new one. */
	const group = () => {
		const last = items.at(-1);
		if (last?.type === "group" && !last.closed) return last;
		return push({ type: "group", rows: [], open: false, closed: false, started: now() });
	};
	/** What is said ends the run before it. */
	const closeGroup = () => {
		const last = items.at(-1);
		if (last?.type === "group" && !last.closed) {
			last.closed = true;
			last.ended = now();
		}
	};
	const say = (item) => {
		closeGroup();
		return push({ at: now(), ...item });
	};

	/**
	 * What a consult row holds, assembled once and kept: the rounds from the story the call belongs to (never from
	 * the session — the exchange is large and belongs in the brain exactly once), the thread marker from the call's
	 * details, and the call's own ask as the fallback when no story stands behind it (a failed call, or a thread the
	 * brain no longer holds).
	 */
	const shortWhen = (at) => `${String(at ?? "").slice(0, 16).replace("T", " ")} UTC`;
	const storyOf = (row) => {
		if (row.story !== undefined) return row.story;
		const args = row.args ?? {};
		const question = String(args.question ?? "").trim();
		const context = typeof args.context === "string" ? args.context.trim() : "";
		const thread = typeof row.details?.thread === "string" && STORY_ID.test(row.details.thread) ? row.details.thread : undefined;
		const raw = thread !== undefined && typeof readStory === "function" ? readStory(thread) : undefined;
		let rounds;
		let unparsable = false;
		if (raw !== undefined) {
			try {
				rounds = parseStory(raw).rounds;
			} catch {
				unparsable = true;
			}
		}
		row.story = { thread, rounds, question, context, unparsable, missing: thread !== undefined && raw === undefined };
		return row.story;
	};

	const api = {
		get version() {
			return version;
		},
		items,
		setThinking(on) {
			thinking = on;
			touch();
		},
		/** What the user typed. */
		user(text) {
			say({ type: "user", text });
		},
		/** Text from Cartographer itself: what a command printed, a notice. Consecutive pieces are one block. `{ keep: true }`: survives a collapse of the conversation. */
		print(text, options = {}) {
			const cleaned = String(text).replace(/\r\x1b\[2?K/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
			if (cleaned === "") return;
			const last = items.at(-1);
			if (last?.type === "console" && !last.sealed) {
				last.text += cleaned;
				if (options.keep === true) last.keep = true;
			} else say({ type: "console", text: cleaned, ...(options.keep === true ? { keep: true } : {}) });
			touch();
		},
		/** The block of printed text is complete: what is printed next starts a new one. */
		seal() {
			const last = items.at(-1);
			if (last?.type === "console") last.sealed = true;
		},
		/**
		 * A collapse of the main context: everything the agent could see before it is out of the tab, so only the
		 * marker of the collapse stands. Items flagged `keep` (what was said before the screen opened) survive.
		 */
		collapse() {
			for (let index = items.length - 1; index >= 0; index--) if (items[index].keep !== true) items.splice(index, 1);
			rows.clear();
			live.clear();
			touch();
		},
		/**
		 * A block the agent sees at the start or the end of its request — the copy at the top of the context, the
		 * state block, the shell windows block, the current read batch. One line until opened, the way a run of calls folds.
		 */
		block(label, text) {
			closeGroup();
			push({ type: "block", label: String(label).replace(/\s+/g, " ").trim(), text: String(text), open: false, at: now() });
		},
		/**
		 * One new entry of a conversation: depth 0 is the main agent, 1 a task. `printed` is what the plain
		 * terminal says about it, used for the outcome of a task and for a collapse.
		 */
		entry(depth, entry, printed = "") {
			for (const message of entry.model ?? []) {
				if (message.role === "assistant") {
					live.delete(depth);
					const notes = [thinkingOf(message), textOf(message)].filter((part) => part.trim() !== "").join("\n").trim();
					const calls = message.stopReason === "length" ? [] : callsOf(message);
					if (notes !== "") {
						// A note of the main agent with no call beside it stands on its own; any other is a row of the run.
						if (depth === 0 && calls.length === 0) say({ type: "note", text: notes });
						else group().rows.push({ kind: "note", depth, text: notes });
					}
					if (depth === 0 && message.stopReason === "length") say({ type: "console", text: `! The agent's reply was cut off at the output limit (maxTokens in the settings). Say "continue" to let it go on.\n`, sealed: true });
					for (const call of calls) {
						if (call.name === "chat") {
							if (typeof call.arguments?.text === "string" && call.arguments.text.trim() !== "") say({ type: "agent", text: call.arguments.text, task: depth > 0 });
							rows.set(call.id, { quiet: true });
							continue;
						}
						// A question is shown when it is put, and `return` is the report line of its task.
						if (call.name === "ask" || call.name === "return") {
							rows.set(call.id, { quiet: true, name: call.name });
							continue;
						}
						const row = { kind: "call", depth, id: call.id, name: call.name, label: describeCall(call, describeRef), args: call.arguments ?? {}, state: "running", started: now() };
						rows.set(call.id, row);
						group().rows.push(row);
					}
					touch();
				} else if (message.role === "toolResult") {
					const row = rows.get(message.toolCallId);
					const text = textOf(message);
					if (row === undefined || row.quiet) {
						if (message.isError && row?.quiet) say({ type: "console", text: `! ${row.name ?? "chat"}: ${cut(plain(text).replace(/\n/g, " "), POLICY.limits.screen.consoleErrorChars)}\n`, sealed: true });
						continue;
					}
					row.state = message.isError ? "failed" : "done";
					row.ended = now();
					row.result = row.name === "task" ? (message.isError ? cut(plain(text).replace(/\n/g, " "), POLICY.limits.screen.taskErrorChars) : `report ${message.details?.report ?? ""}`.trim()) : describeResult(message) || undefined;
					// The consult's answer is not in the result (the receipt keeps the session lean); no detail to show.
					row.receipt = row.name === "consult" ? text : undefined;
					row.detail = row.name === "consult" ? undefined : text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}\n… (${text.length - DETAIL_MAX} more characters)` : text;
					row.details = message.details;
					// What a task leaves behind is said in full: the report line, changed files and declared move.
					if (depth === 0 && row.name === "task" && printed.trim() !== "") {
						const outcome = printed.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
						say({ type: "console", text: outcome.endsWith("\n") ? outcome : `${outcome}\n`, sealed: true, of: row.id });
					}
					touch();
				} else if (message.role === "user" && depth === 0 && isFront({ role: "user", content: [{ type: "text", text: splitTop(textOf(message)).text }] })) {
					// The front block of a collapse, whenever it reached the tab — live or replayed: everything the
					// agent could see before it is out of view, so only the marker stands.
					api.collapse();
					const said = printed.trim() !== "" ? printed.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") : "◆ the context was collapsed; /context shows it\n";
					say({ type: "console", text: said, sealed: true });
				}
			}
		},
		/** The reply that is being written at this depth, as far as it has come; undefined when none is. */
		live(depth, message) {
			if (message === undefined) {
				if (live.delete(depth)) touch();
				return;
			}
			const before = live.get(depth);
			live.set(depth, { message, since: before?.message.timestamp === message.timestamp ? before.since : now() });
			touch();
		},
		/** What the running tools at this depth are saying, as far as the harness keeps it: a bounded tail of each. */
		liveTools(depth, slots) {
			void depth;
			const next = new Map();
			for (const slot of slots ?? []) {
				if (slot?.callId === undefined || slot?.status !== "running") continue;
				if (typeof slot.output !== "string" || slot.output === "") continue;
				next.set(slot.callId, { text: slot.output, clipped: (slot.droppedBytes ?? 0) > 0 });
			}
			let same = next.size === toolTails.size;
			if (same) for (const [id, entry] of next) {
				const previous = toolTails.get(id);
				if (previous === undefined || previous.text !== entry.text || previous.clipped !== entry.clipped) {
					same = false;
					break;
				}
			}
			toolTails.clear();
			for (const [id, entry] of next) toolTails.set(id, entry);
			if (!same) touch();
		},
		/** Whether the end of what is being written is the same thing over and over (src/screen/text.mjs). */
		stuck() {
			for (const { message } of live.values()) {
				const parts = [thinkingOf(message), textOf(message), ...callsOf(message).map((call) => bodyOf(call) || JSON.stringify(call.arguments ?? {}))];
				for (const part of parts) {
					const found = repeats(part);
					if (found !== undefined) return found;
				}
			}
			return undefined;
		},
		/** Roughly how many characters the replies being written hold: for the rate of writing. */
		liveSize() {
			let size = 0;
			for (const { message } of live.values()) size += thinkingOf(message).length + textOf(message).length + callsOf(message).reduce((sum, call) => sum + JSON.stringify(call.arguments ?? {}).length, 0);
			return size;
		},
		/** What the agent is doing now, in a few words, and where: { what, depth, task? }. */
		doing() {
			const last = items.at(-1);
			const running = last?.type === "group" && !last.closed ? last.rows.filter((row) => row.kind === "call" && row.state === "running") : [];
			const taskRow = running.find((row) => row.name === "task");
			const task = taskRow === undefined ? undefined : taskRow.args?.move ? `move ${taskRow.args.move}` : taskRow.args?.item ? `task ${taskRow.args.item}` : "task";
			const deepest = [...live.keys()].sort((a, b) => b - a)[0];
			if (deepest !== undefined) {
				const { message } = live.get(deepest);
				const call = callsOf(message).at(-1);
				if (call?.name === "chat" || call?.name === "ask") return { what: "writing to you", depth: deepest, task };
				if (call !== undefined) return { what: `writing ${cut(describeCall(call, describeRef).replace(/\s+/g, " "), POLICY.limits.screen.activeCallChars)}`, depth: deepest, task };
				if (textOf(message).trim() !== "") return { what: "writing a note", depth: deepest, task };
				return { what: "thinking", depth: deepest, task };
			}
			// The call that runs now: inside a task, the task's own call and not the task.
			const row = running.filter((entry) => entry !== taskRow).at(-1);
			if (row?.name === "consult") return { what: "the storyteller is writing", depth: row.depth, task };
			if (row !== undefined) return { what: cut(row.label.replace(/\s+/g, " "), POLICY.limits.screen.activeCallChars), depth: row.depth, task };
			if (taskRow !== undefined) return { what: "between two steps", depth: 1, task };
			return undefined;
		},
		/** The last thing the agent said to the user. */
		lastAgent: () => items.findLast((item) => item.type === "agent")?.text,
		toggle(key, to) {
			const item = items.find((entry) => entry.key === key);
			if (item?.type === "group" || item?.type === "block") item.open = to ?? !item.open;
			touch();
		},
		/** Open every run of calls, or fold them all with what was opened inside them. */
		setAll(open) {
			for (const item of items) {
				if (item.type !== "group") continue;
				item.open = open;
				if (!open) for (const row of item.rows) row.open = false;
				item.rev = (item.rev ?? 0) + 1;
			}
			touch();
		},
		/** The colours have changed: what was rendered with the old ones is rendered again. */
		restyle() {
			for (const item of items) delete item.md;
			styleRev++;
			touch();
		},
		/** The reply that is being written at a depth, as far as it has come. */
		liveMessage: (depth) => live.get(depth)?.message,
		/**
		 * Whether a message as it shows can be edited with e: the words of the user and of the agent. Tool work
		 * (a run of calls, a call with what it returned) cannot, nor what Cartographer printed.
		 */
		editable(key) {
			const item = items.find((entry) => entry.key === key);
			return item?.type === "user" || item?.type === "agent" || item?.type === "note";
		},
	/** A message said anew, as it shows. The conversation's stored entries cannot change; this changes the tab. */
	revise(key, text) {
		const item = items.find((entry) => entry.key === key);
		if (item === undefined || (item.type !== "user" && item.type !== "agent" && item.type !== "note")) return false;
		const said = String(text ?? "").replace(/\s+$/, "");
		if (said === "" || said === item.text) return false;
		item.text = said;
		delete item.md;
		touch();
		return true;
	},
	/** A message taken out of the tab (deleted in the Context window): gone where it stood. */
	forget(key) {
		const at = items.findIndex((entry) => entry.key === key);
		if (at < 0) return false;
		items.splice(at, 1);
		touch();
		return true;
	},
		toggleRow(key, index, to) {
			const item = items.find((entry) => entry.key === key);
			const row = item?.rows?.[index];
			if (row !== undefined) {
				row.open = to ?? !row.open;
				item.rev = (item.rev ?? 0) + 1;
			}
			touch();
		},

		/**
		 * The tab as lines of `cols` cells. Each line says what it belongs to, so that a selection or a click can
		 * act on it: { spans, item, row?, kind }.
		 */
		lines(cols) {
			const out = [];
			// Where the lines being made go: the lines of one item while it is made, else the tab's.
			let sink = out;
			// A line of a block has a blank cell before its text, which the screen adds (`pad`).
			const add = (spans, ref = {}) => sink.push({ spans, ...ref, ...(ref.bg !== undefined ? { pad: 1 } : {}) });
			const blank = () => {
				if (out.length > 0 && out.at(-1).spans.length > 0) out.push(BLANK);
			};
			// So the text of a block is that much narrower, and a cell more at its right edge.
			const inner = cols - 2;
			/** What the agent says, as Markdown when a renderer is there. */
			const said = (text, ref, cache) => {
				if (markdown === undefined) {
					for (const piece of wrap(text, cols)) add([[piece, ""]], ref);
					return;
				}
				let rendered = cache?.md;
				if (rendered === undefined || rendered.cols !== cols || rendered.text !== text) {
					try {
						rendered = { cols, text, lines: markdown(text, cols) };
					} catch {
						rendered = { cols, text, lines: wrap(text, cols).map((piece) => ({ styled: piece, cells: width(piece), text: piece })) };
					}
					if (cache !== undefined) cache.md = rendered;
				}
				for (const line of rendered.lines) add([[line.text, ""]], { ...ref, styled: line.styled, cells: line.cells });
			};
			const callLine = (row) => {
				const mark = row.state === "running" ? "…" : row.state === "failed" ? "✗" : "✓";
				const style = row.state === "failed" ? "err" : row.state === "running" ? "warn" : "ok";
				const indent = row.depth > 0 ? "  │ " : "  ";
				const result = row.result !== undefined ? `  → ${row.result}` : row.state === "running" ? `  ${span(now() - row.started)}` : "";
				const room = Math.max(10, inner - width(indent) - 2 - width(result));
				return [[indent, "faint"], [`${mark} `, style], [cut(row.label.replace(/\n/g, " "), room), ""], [result, row.state === "failed" ? "err" : "muted"]];
			};
			const rowLines = (item, index) => {
				const row = item.rows[index];
				const ref = { item: item.key, row: index, bg: "bgTool" };
				if (row.kind === "note") {
					if (!thinking) return;
					const indent = row.depth > 0 ? "  │ ┊ " : "  ┊ ";
					const text = wrap(row.text, inner - width(indent));
					for (const piece of row.open ? text : text.slice(0, POLICY.limits.screen.notePreviewLines)) add([[indent, "faint"], [piece, "note italic"]], { ...ref, kind: "note" });
					if (!row.open && text.length > POLICY.limits.screen.notePreviewLines) add([[indent, "faint"], [`… ${text.length - POLICY.limits.screen.notePreviewLines} more lines`, "faint"]], { ...ref, kind: "note" });
					return;
				}
				if (row.name === "consult") {
					// The storyteller: the call opens to the whole exchange — what I asked, and what it answered.
					add(callLine(row), { ...ref, kind: "call" });
					if (row.state === "running") {
						// Its words as they come: the tail the harness keeps, not the story (the round lands in the brain when it finishes).
						const tail = toolTails.get(row.id);
						if (tail !== undefined) {
							const indentLive = row.depth > 0 ? "  │   " : "    ";
							if (tail.clipped) add([[indentLive, "faint"], ["… the beginning of the story is on its way to the brain", "faint"]], { ...ref, kind: "detail" });
							const shown = wrap(tail.text.replace(/\s+$/, ""), inner - width(indentLive));
							for (const piece of shown.slice(-POLICY.limits.screen.chatLiveTextRows)) add([[indentLive, "faint"], [piece, "muted"]], { ...ref, kind: "detail" });
						}
					}
					if (row.open) {
						const indent = row.depth > 0 ? "  │   " : "    ";
						const section = (title) => add([[indent, "faint"], [title, "faint"]], { ...ref, kind: "detail" });
						const body = (text, style = "muted") => {
							for (const piece of wrap(text, inner - width(indent))) add([[indent, "faint"], [piece, row.state === "failed" ? "err" : style]], { ...ref, kind: "detail" });
						};
						const story = storyOf(row);
						const clippedContext = (text) => (text.length > CONTEXT_MAX ? `${text.slice(0, CONTEXT_MAX)}\n… (${text.length - CONTEXT_MAX} more characters of context)` : text);
						if (story.thread !== undefined) add([[indent, "faint"], [`the story stands under thread ${story.thread}${story.rounds !== undefined ? ` · ${story.rounds.length} ${story.rounds.length === 1 ? "round" : "rounds"}` : ""}`, "faint"]], { ...ref, kind: "detail" });
						if (story.rounds !== undefined) {
							for (const [index, round] of story.rounds.entries()) {
								section(`round ${index + 1} · ${shortWhen(round.at)}`);
								if (round.context !== "") {
									section("what I sent — the context");
									body(clippedContext(round.context));
								}
								section("what I asked — the question");
								body(round.question === "" ? "(the question is not in the call)" : round.question);
								section("what the storyteller answered");
								body(round.answer);
							}
							if (row.state === "failed") {
								section("why it failed");
								body(plain(row.receipt ?? ""));
							}
							return;
						}
						if (story.context !== "") {
							section("what I sent — the context");
							body(clippedContext(story.context));
						}
						section("what I asked — the question");
						body(story.question === "" ? "(the question is not in the call)" : story.question);
						if (row.state === "failed") {
							section("why it failed");
							body(plain(row.receipt ?? ""));
							return;
						}
						section("what the storyteller answered");
						if (row.state === "running") body("(the storyteller is still writing; the answer lands in the story when it finishes)", "faint");
						else if (story.unparsable) body(`(the story under thread ${story.thread} cannot be read as a story; the answer stood there)`, "faint");
						else if (story.missing) body(story.thread === undefined ? "(the answer is not in the session, and no thread was named)" : `(the story under thread ${story.thread} is gone from the brain; the answer stood there)`, "faint");
						else body("(no answer stands behind this call)", "faint");
					}
					return;
				}
				add(callLine(row), { ...ref, kind: "call" });
				if (row.open && row.detail !== undefined) {
					const indent = row.depth > 0 ? "  │   " : "    ";
					const text = wrap(plain(row.detail), inner - width(indent));
					for (const piece of text.slice(0, DETAIL_ROWS)) add([[indent, "faint"], [piece, row.state === "failed" ? "err" : "muted"]], { ...ref, kind: "detail" });
					if (text.length > DETAIL_ROWS) add([[indent, "faint"], [`… ${text.length - DETAIL_ROWS} more lines${row.name === "task" ? " (/report shows the report)" : ""}`, "faint"]], { ...ref, kind: "detail" });
				}
			};
			/** One line that Cartographer printed: its mark picked out, the rest by what the line is. */
			const printed = (piece, question) => {
				if (question) return [[piece, ""]];
				const mark = /^(\s*)([!●◆◂▸?›✓○])(\s?)(.*)$/s.exec(piece);
				if (mark === null) return [[piece, /^\s{2,}/.test(piece) ? "faint" : "muted"]];
				const [, lead, sign, gap, rest] = mark;
				if (sign === "!") return [[piece, "warn"]];
				if (sign === "›") return [[`${lead}${sign}${gap}`, "user"], [rest, "muted"]];
				return [[`${lead}${sign}${gap}`, sign === "✓" ? "ok" : "carto"], [rest, lead === "" ? "muted" : "faint"]];
			};
			/** The lines of one item, without the empty row that may stand before it. */
			const make = (item) => {
				if (item.type === "user") {
					for (const [index, piece] of wrap(item.text, inner - 2).entries()) add([[index === 0 ? "› " : "  ", "user bold"], [piece, "bold"]], { item: item.key, kind: "user", bg: "bgUser" });
				} else if (item.type === "agent") {
					said(item.text, { item: item.key, kind: "agent" }, item);
				} else if (item.type === "block") {
					const ref = { item: item.key, kind: "block", bg: "bgTool" };
					add([[item.open ? "▾ " : "▸ ", "carto"], [cut(item.label, inner - 2), "muted"]], ref);
					if (item.open) {
						const indent = "  ";
						const pieces = wrap(item.text, inner - width(indent));
						for (const piece of pieces.slice(0, BLOCK_ROWS)) add([[indent, "faint"], [piece, "muted"]], ref);
						if (pieces.length > BLOCK_ROWS) add([[indent, "faint"], [`… ${pieces.length - BLOCK_ROWS} more lines (y copies it)`, "faint"]], ref);
					}
				} else if (item.type === "note") {
					if (!thinking) return;
					for (const piece of wrap(item.text, cols - 2)) add([["┊ ", "faint"], [piece, "note italic"]], { item: item.key, kind: "note" });
				} else if (item.type === "console") {
					const question = /^\? /.test(item.text);
					for (const [index, piece] of item.text.replace(/\n$/, "").split("\n").entries()) {
						const rows = wrap(piece, cols);
						const head = question && index === 0 ? [["? ", "warn bold"], [rows[0].slice(2), "bold"]] : printed(rows[0], question && !/^\s{2}(Type |no answer|nobody)/.test(piece));
						add(head, { item: item.key, kind: "console" });
						// A long line keeps the style of its end on the rows it runs over.
						for (const part of rows.slice(1)) add([[part, head.at(-1)[1]]], { item: item.key, kind: "console" });
					}
				} else if (item.type === "group") {
					const calls = item.rows.filter((row) => row.kind === "call");
					if (calls.length === 0 && (!thinking || item.rows.length === 0)) return;
					const running = !item.closed;
					const open = item.open || running;
					const failed = calls.filter((row) => row.state === "failed").length;
					const tasks = calls.filter((row) => row.name === "task").map((row) => row.details?.report ?? (row.args?.move ? `move ${row.args.move}` : row.args?.item ? `task ${row.args.item}` : "task"));
					const consults = calls.filter((row) => row.name === "consult").map((row) => cut(String(row.args?.question ?? "").replace(/\s+/g, " "), 48)).filter((text) => text !== "");
					const took = span((item.ended ?? now()) - item.started);
					const head = [`${calls.length === 1 ? "1 call" : `${calls.length} calls`}`, ...new Set([...tasks, ...consults]), took].join(" · ");
					add([[open ? "▾ " : "▸ ", running ? "warn" : "tool"], [head, running ? "" : "muted"], [failed > 0 ? ` · ${failed} failed` : "", "err"]], { item: item.key, kind: "group", bg: "bgTool" });
					if (open) {
						// A run that is going on shows its newest rows; opened by hand, it shows all of them.
						const from = item.open ? 0 : Math.max(0, item.rows.length - LIVE_ROWS);
						if (from > 0) add([["  ", ""], [`… ${from} earlier: Enter on the line above shows all`, "faint"]], { item: item.key, kind: "group", bg: "bgTool" });
						for (let index = from; index < item.rows.length; index++) rowLines(item, index);
					}
				}
			};
			// An item's lines are made once and kept until the item changes: a long conversation is not made again
			// for every word the agent writes. What the lines depend on is put into one string; a run of calls
			// that is going on, or that shows a clock, is made every time.
			const base = `${cols}|${thinking}|${styleRev}`;
			const linesOf = (item) => {
				const still = item.type !== "group" || (item.closed && !item.rows.some((row) => row.kind === "call" && row.state === "running"));
				const sign = !still ? undefined : item.type === "group" ? `${base}|${item.rev ?? 0}|${item.rows.length}|${item.open}` : item.type === "block" ? `${base}|${item.text.length}|${item.open ?? ""}` : `${base}|${item.text.length}`;
				if (sign !== undefined && item.made?.sign === sign) return item.made.lines;
				sink = [];
				make(item);
				const made = sink;
				sink = out;
				item.made = sign === undefined ? undefined : { sign, lines: made };
				return made;
			};
			let before;
			for (const item of items) {
				const own = linesOf(item);
				if (own.length === 0) continue;
				// Blocks of different kinds stand an empty row apart; what a task left behind stands under its run.
				const apart = item.type === "note" ? before !== "note" : item.type === "console" ? before !== "console" && !(before === "group" && item.of !== undefined) : true;
				if (apart) blank();
				for (const line of own) out.push(line);
				before = item.type;
			}
			// What is being written now, whatever it is.
			for (const depth of [...live.keys()].sort((a, b) => a - b)) {
				const { message } = live.get(depth);
				const indent = depth > 0 ? "  │ " : "";
				const notes = [thinkingOf(message), textOf(message)].filter((part) => part.trim() !== "").join("\n");
				const calls = callsOf(message);
				// Inside a task, what is written belongs to the task's run, and has its background.
				const block = depth > 0 ? { bg: "bgTool" } : {};
				if (depth === 0 && (notes.trim() !== "" || calls.length > 0) && before !== "note") blank();
				if (notes.trim() !== "" && thinking) {
					const text = wrap(notes, inner - width(indent) - 2);
					for (const piece of text.slice(-(calls.length > 0 ? 2 : LIVE_TEXT_ROWS))) add([[`${indent}┊ `, "faint"], [piece, "note italic"]], { kind: "live", ...block });
				} else if (notes.trim() !== "" && calls.length === 0) add([[`${indent}┊ `, "faint"], ["thinking… (Ctrl-T shows it)", "faint"]], { kind: "live", ...block });
				for (const call of calls) {
					if (call.name === "chat") {
						if (depth === 0) blank();
						said(String(call.arguments?.text ?? ""), { kind: "live" });
						continue;
					}
					add([[`${indent}✎ `, "warn"], [cut(describeCall(call, describeRef).replace(/\n/g, " "), inner - width(indent) - 2), "bold"]], { kind: "live", bg: "bgTool" });
					const body = bodyOf(call);
					if (body !== "") {
						const text = wrap(body, inner - width(indent) - 4);
						for (const piece of text.slice(-LIVE_TEXT_ROWS)) add([[`${indent}  │ `, "faint"], [piece, "muted"]], { kind: "live", bg: "bgTool" });
					}
				}
			}
			return out;
		},

		/** The text of one item, for copying. */
		textOf(key, rowIndex) {
			const item = items.find((entry) => entry.key === key);
			if (item === undefined) return "";
			if (item.type === "block") return item.text;
			if (item.type === "group") {
				const row = rowIndex === undefined ? undefined : item.rows[rowIndex];
				if (row?.kind === "note") return row.text;
				if (row?.name === "consult") {
					const story = storyOf(row);
					const parts = [row.label];
					if (story.thread !== undefined) parts.push(`The story stands under thread ${story.thread}${story.rounds !== undefined ? ` · ${story.rounds.length} ${story.rounds.length === 1 ? "round" : "rounds"}` : ""}`);
					if (story.rounds !== undefined) {
						for (const [index, round] of story.rounds.entries()) {
							parts.push("", `Round ${index + 1} — ${shortWhen(round.at)}`);
							if (round.context !== "") parts.push("", "What I sent — the context", "", round.context);
							parts.push("", "What I asked — the question", "", round.question === "" ? "(the question is not in the call)" : round.question, "", "What the storyteller answered", "", round.answer);
						}
						return parts.join("\n");
					}
					if (story.context !== "") parts.push("", "What I sent — the context", "", story.context);
					parts.push("", "What I asked — the question", "", story.question === "" ? "(the question is not in the call)" : story.question, "", "What the storyteller answered", "", story.unparsable ? `(the story under thread ${story.thread} cannot be read as a story; the answer stood there)` : story.missing ? `(the story under thread ${story.thread} is gone from the brain; the answer stood there)` : "(the answer is not in the session)");
					return parts.join("\n");
				}
				if (row !== undefined) return `${row.label}${row.result ? `  → ${row.result}` : ""}${row.detail ? `\n\n${plain(row.detail)}` : ""}`;
				return item.rows.map((entry) => (entry.kind === "note" ? `  ┊ ${entry.text.split("\n")[0]}` : `${entry.depth > 0 ? "  │ " : "  "}${entry.label}${entry.result ? `  → ${entry.result}` : ""}`)).join("\n");
			}
			return item.text ?? "";
		},
		/** The whole session as Markdown: what was said in full, each call as one line. */
		transcript({ title = "Cartographer session" } = {}) {
			const parts = [`# ${title}`, ""];
			for (const item of items) {
				if (item.type === "user") parts.push("## You", "", item.text, "");
				else if (item.type === "agent") parts.push(`## Cartographer${item.task ? " (from a task)" : ""}`, "", item.text, "");
				else if (item.type === "note") parts.push(...item.text.split("\n").map((line) => `> ${line}`), "");
				else if (item.type === "block") parts.push("```text", `// ${item.label}`, item.text.replace(/\n+$/, ""), "```", "");
				else if (item.type === "console") parts.push("```text", item.text.replace(/\n+$/, ""), "```", "");
				else if (item.type === "group" && item.rows.length > 0) {
					for (const row of item.rows) {
						if (row.kind === "note") parts.push(`${row.depth > 0 ? "  " : ""}- _note:_ ${row.text.replace(/\s+/g, " ")}`);
						else parts.push(`${row.depth > 0 ? "  " : ""}- \`${row.label.replace(/\n/g, " ").replace(/`/g, "'")}\`${row.result ? ` → ${row.result}` : ""}${row.state === "failed" ? " (failed)" : ""}`);
					}
					parts.push("");
				}
			}
			return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
		},
	};
	return api;
}
