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
import { describeCall, describeResult } from "../terminal.mjs";
import { cut, repeats, span, width, wrap } from "./text.mjs";

/** How many of a run's newest calls are shown while it is going on. */
const LIVE_ROWS = 5;
/** How many rows of the reply that is being written are shown. */
const LIVE_TEXT_ROWS = 8;
/** The most of one result that is kept for opening it in place. */
const DETAIL_MAX = 20_000;
/** The most rows an opened result shows; the rest is in the tab it leads to, or in /report. */
const DETAIL_ROWS = 40;
/** Items kept; older ones leave the tab (they stay in the session and in the export of what is left). */
const ITEMS_MAX = 1500;

/** An empty row between two blocks. One for all of them, so that it is painted once. */
const BLANK = { spans: [] };

/** The tab a call's work lives in, and the view inside it. */
export function homeOf(name) {
	if (name === "write" || name === "edit") return { tab: "diff" };
	if (name === "shell" || name === "window") return { tab: "shells" };
	if (name === "plan") return { tab: "carto", view: "plan" };
	if (name === "ledger") return { tab: "carto", view: "ledger" };
	if (name === "atlas") return { tab: "carto", view: "atlas" };
	if (name === "assess") return { tab: "carto", view: "assessment" };
	if (name === "context") return { tab: "context" };
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
	for (const key of ["content", "new_text", "command", "brief", "report", "text", "input"]) if (typeof args[key] === "string" && args[key].length > best.length) best = args[key];
	if (best === "" && Array.isArray(args.ops)) best = args.ops.map((op) => JSON.stringify(op)).join("\n");
	return best;
}

/**
 * @param {{ now?: () => number, markdown?: (text: string, cols: number) => { styled: string, cells: number, text: string }[] }} options
 *   markdown: renders what the agent says; without it, the text is wrapped as it is
 */
export function createChat({ now = () => Date.now(), markdown } = {}) {
	/** @type {any[]} */
	const items = [];
	const rows = new Map(); // call id -> row
	const live = new Map(); // depth -> the reply being written there
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
		/** Text from Cartographer itself: what a command printed, a notice. Consecutive pieces are one block. */
		print(text) {
			const cleaned = String(text).replace(/\r\x1b\[2?K/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
			if (cleaned === "") return;
			const last = items.at(-1);
			if (last?.type === "console" && !last.sealed) last.text += cleaned;
			else say({ type: "console", text: cleaned });
			touch();
		},
		/** The block of printed text is complete: what is printed next starts a new one. */
		seal() {
			const last = items.at(-1);
			if (last?.type === "console") last.sealed = true;
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
						const row = { kind: "call", depth, id: call.id, name: call.name, label: describeCall(call), args: call.arguments ?? {}, state: "running", started: now() };
						rows.set(call.id, row);
						group().rows.push(row);
					}
					touch();
				} else if (message.role === "toolResult") {
					const row = rows.get(message.toolCallId);
					const text = textOf(message);
					if (row === undefined || row.quiet) {
						if (message.isError && row?.quiet) say({ type: "console", text: `! ${row.name ?? "chat"}: ${cut(plain(text).replace(/\n/g, " "), 300)}\n`, sealed: true });
						continue;
					}
					row.state = message.isError ? "failed" : "done";
					row.ended = now();
					row.result = row.name === "task" ? (message.isError ? cut(plain(text).replace(/\n/g, " "), 200) : `report ${message.details?.report ?? ""}`.trim()) : describeResult(message);
					row.detail = text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}\n… (${text.length - DETAIL_MAX} more characters)` : text;
					row.details = message.details;
					// What a task leaves behind is said in full: the report line, the files it changed, the plan item.
					if (depth === 0 && row.name === "task" && printed.trim() !== "") {
						const outcome = printed.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
						say({ type: "console", text: outcome.endsWith("\n") ? outcome : `${outcome}\n`, sealed: true, of: row.id });
					}
					touch();
				} else if (message.role === "user" && depth === 0 && printed.trim() !== "" && /context collapsed/.test(printed)) {
					say({ type: "console", text: printed.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""), sealed: true });
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
			const task = taskRow === undefined ? undefined : taskRow.args?.item ? `task ${taskRow.args.item}` : "task";
			const deepest = [...live.keys()].sort((a, b) => b - a)[0];
			if (deepest !== undefined) {
				const { message } = live.get(deepest);
				const call = callsOf(message).at(-1);
				if (call?.name === "chat" || call?.name === "ask") return { what: "writing to you", depth: deepest, task };
				if (call !== undefined) return { what: `writing ${cut(describeCall(call).replace(/\s+/g, " "), 50)}`, depth: deepest, task };
				if (textOf(message).trim() !== "") return { what: "writing a note", depth: deepest, task };
				return { what: "thinking", depth: deepest, task };
			}
			// The call that runs now: inside a task, the task's own call and not the task.
			const row = running.filter((entry) => entry !== taskRow).at(-1);
			if (row !== undefined) return { what: cut(row.label.replace(/\s+/g, " "), 50), depth: row.depth, task };
			if (taskRow !== undefined) return { what: "between two steps", depth: 1, task };
			return undefined;
		},
		/** The last thing the agent said to the user. */
		lastAgent: () => items.findLast((item) => item.type === "agent")?.text,
		toggle(key, to) {
			const item = items.find((entry) => entry.key === key);
			if (item?.type === "group") item.open = to ?? !item.open;
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
					for (const piece of row.open ? text : text.slice(0, 2)) add([[indent, "faint"], [piece, "note italic"]], { ...ref, kind: "note" });
					if (!row.open && text.length > 2) add([[indent, "faint"], [`… ${text.length - 2} more lines`, "faint"]], { ...ref, kind: "note" });
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
					const tasks = calls.filter((row) => row.name === "task").map((row) => row.details?.report ?? (row.args?.item ? `task ${row.args.item}` : "task"));
					const took = span((item.ended ?? now()) - item.started);
					const head = [`${calls.length === 1 ? "1 call" : `${calls.length} calls`}`, ...new Set(tasks), took].join(" · ");
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
				const sign = !still ? undefined : item.type === "group" ? `${base}|${item.rev ?? 0}|${item.rows.length}|${item.open}` : `${base}|${item.text.length}`;
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
					add([[`${indent}✎ `, "warn"], [cut(describeCall(call).replace(/\n/g, " "), inner - width(indent) - 2), "bold"]], { kind: "live", bg: "bgTool" });
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
			if (item.type === "group") {
				const row = rowIndex === undefined ? undefined : item.rows[rowIndex];
				if (row?.kind === "note") return row.text;
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
