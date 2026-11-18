// What tabs 2 to 5 of the full screen hold: the brain, the changes, the shell windows, and the context.
//
// Each function here turns one already-read brain or session projection into what a list shows
// (src/screen/list.mjs): a few lines for the top, and items that fold. Rendering has no legacy readers: deferred
// application queries own durable and live snapshots before a view receives them. `isOpen(key)` is given because for
// a folder what is open decides which items there are. An item names the file it comes from and the line, so that
// `e` can open it there.
//
// The Model tab is the one that is not read from a file. Its sent panes show the frozen provider payload captured
// immediately before dispatch in semantic reading order: the system prompt, tools, then messages, with Cartographer's
// additions as parts of their own. The raw serialized payload has its own audit view; it is not another context part.
// Response material belongs below a plain `not sent` boundary. Current shared-brain state lives in Carto; a sent
// snapshot is never rebuilt from it.
import { POLICY } from "../config.mjs";
import { join } from "node:path";
import { changeSummary } from "../checkpoints.mjs";
import { estimate, isFront, recordLine, sameShelfItem, shelfLabel, composedRows, splitReadTail } from "../context.mjs";
import { authorizationLine, itemLine, movesOf, planPath, waiting } from "../plan.mjs";
import { flat } from "../rows.mjs";
import { ago, stamp, took } from "../time.mjs";
import { short, width } from "./text.mjs";
import { RECORD } from "../voice.mjs";
import { USER_NAME } from "../user.mjs";

const PROJECT_BLOCK = new RegExp(`^${POLICY.markup.project.open}\\n[\\s\\S]*?\\n${POLICY.markup.project.close}\\n*`);
const ANCHOR = RECORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CONTEXT_BLOCK = new RegExp(`${POLICY.markup.context.open}\\n${ANCHOR}[\\s\\S]*?\\n${POLICY.markup.context.close}\\n*`);
const STATE_BLOCK = new RegExp(`\\n*${POLICY.markup.state.open}\\n${ANCHOR}[\\s\\S]*?\\n${POLICY.markup.state.close}`);
const WINDOWS_BLOCK = new RegExp(`\\n*${POLICY.markup.windows.open}\\n${ANCHOR}[\\s\\S]*?\\n${POLICY.markup.windows.close}`);

const heading = (text) => ({ key: `heading:${text}`, plain: true, head: [[text, "heading"]] });
const note = (text, style = "muted") => ({ key: `note:${text}`, plain: true, head: [[text, style]] });
const when = (value) => {
	const ms = typeof value === "number" ? value : Date.parse(value ?? "");
	return Number.isFinite(ms) ? stamp(ms) : undefined;
};

// ─── Carto ──────────────────────────────────────────────────────────────────

/** The plan: authorization envelopes, then their declared executable moves. */
export function planView({ brainDir, yolo, plan, lines, error } = {}) {
	const file = planPath(brainDir);
	if (plan === undefined) {
		if (error !== undefined) return { header: [[[`! The plan cannot be read: ${error}`, "warn"]]], items: [{ key: "file", head: [[file, ""]], target: { file } }] };
		return { header: [[["Plan is loading…", "muted"]]], items: [] };
	}
	if (plan.items.length === 0) return { header: [], items: [note("  There is no plan. The agent writes an envelope when a goal needs changes.")] };
	const items = [];
	for (const envelope of plan.items) {
		items.push({
			key: `envelope:${envelope.id}`,
			archived: envelope.archived === true,
			head: [
				[envelope.status === POLICY.enums.entryStatus.done ? "✓ " : "○ ", envelope.status === POLICY.enums.entryStatus.done ? "ok" : "warn"],
				[`${envelope.id} `, "tool"],
				[`[envelope · ${envelope.mode}${envelope.network ? ", network" : ""}] `, "muted"],
				[envelope.text, envelope.status === POLICY.enums.entryStatus.done || envelope.archived === true ? "muted" : ""],
				[envelope.status === POLICY.enums.entryStatus.done && envelope.outcome ? `  → ${envelope.outcome}` : "", "muted"],
				[envelope.archived === true ? "  · archived: the agent does not read it (v brings it back)" : "", "warn"],
			],
			body: [
				envelope.text,
				`intent envelope · ${envelope.status === POLICY.enums.entryStatus.done ? `done${when(envelope.closed) ? ` ${when(envelope.closed)}` : ""}` : "open; it cannot run itself"}`,
				envelope.doneWhen ? `envelope complete when: ${envelope.doneWhen}` : "legacy envelope: add a done-when line and declared moves",
				envelope.status === POLICY.enums.entryStatus.done && envelope.outcome ? `outcome: ${envelope.outcome}` : undefined,
				envelope.undone ? "undone by you: accepted moves may need review" : undefined,
			]
				.filter((line) => line !== undefined)
				.join("\n"),
			copy: itemLine(envelope),
			target: { file, line: lines?.[envelope.id] },
		});
		for (const move of movesOf(plan, envelope.id)) {
			const state = move.status === "done" ? "✓" : move.status === "reported" ? "!" : move.status === "running" ? "▶" : move.status === "blocked" ? "×" : move.approvedRevision === move.revision ? "●" : "○";
			const muted = move.status === "done" || move.archived === true;
			const budget = move.budget ?? { replies: move.turns, fileOps: undefined, commandStarts: undefined };
			items.push({
				key: `move:${move.id}`,
				archived: move.archived === true,
				head: [
					[`  ${state} `, move.status === "done" ? "ok" : move.status === "reported" || move.status === "blocked" ? "warn" : "tool"],
					[`${move.id} `, "tool"],
					[`[move · ${move.status} · r${move.revision}] `, "muted"],
					[move.action ?? move.text, muted ? "muted" : ""],
					[move.archived === true ? "  · archived" : "", "warn"],
				],
				body: [
					`parent: ${move.parent} revision ${move.parentRevision}`,
					`action: ${move.action ?? move.text}`,
					`targets: ${(move.targets ?? []).join(", ") || "none"}`,
					`done when: ${move.doneWhen}`,
					`required proof: ${move.proof ?? "none"}`,
					`capabilities: files ${move.capabilities?.files ? "yes" : "no"}; commands ${move.capabilities?.commands ? "yes" : "no"}; network ${move.capabilities?.network ? "yes" : "no"}`,
					`budget: ${budget.replies} replies${budget.fileOps === undefined ? "" : `; ${budget.fileOps} file operations`}${budget.commandStarts === undefined ? "" : `; ${budget.commandStarts} command starts`}`,
					move.status === "reported" ? `reported: ${move.reported?.id ?? "no report id"}; inspect the report and checkpoints, then press t and write why its proof witnesses this move's done-when` : undefined,
					move.status === "reported" && move.reported?.checkpoints ? `checkpoints: ${move.reported.checkpoints.before} → ${move.reported.checkpoints.after}` : undefined,
					move.status === "reported" && Array.isArray(move.reported?.changes) ? `changed paths: ${move.reported.changes.map((change) => change.path).join(", ") || "none"}` : undefined,
					move.status === "reported" && move.reported?.proof ? `reported proof: ${move.reported.proof}` : undefined,
					move.status === "reported" && move.reported?.closureGap ? `closure gap: ${move.reported.closureGap}` : undefined,
					move.status === "blocked" ? `blocked: ${move.blocked ?? "no reason recorded"}` : undefined,
					move.status === "blocked" && move.reported?.closureGap ? `closure gap: ${move.reported.closureGap}` : undefined,
					move.status === "done" ? `accepted${when(move.closed) ? ` ${when(move.closed)}` : ""}${move.outcome ? `: ${move.outcome}` : ""}` : undefined,
					move.status === "done" && move.acceptedReview ? `acceptance review: ${move.acceptedReview}` : undefined,
				]
					.filter((line) => line !== undefined)
					.join("\n"),
				copy: itemLine(move),
				target: { file, line: lines?.[move.id] },
			});
		}
	}
	const waits = !yolo && waiting(plan).length > 0;
	return { header: [[[authorizationLine(plan, { yolo }), waits ? "warn" : "muted"], [waits ? "  Type /approve to snapshot the current move revisions." : "", "warn"]]], items };
}

/** What waits for the user: change moves and questions of taste. */
export function requestsView({ brainDir, requests: provided, error } = {}) {
	if (error !== undefined) return { header: [[[`! ${error}`, "warn"]]], items: [note("  Requests will be retried automatically.", "muted")] };
	if (provided === undefined) return { header: [[["Loading requests…", "muted"]]], items: [] };
	const all = provided;
	if (all.length === 0) return { header: [], items: [note("  Nothing waits for you. The agent goes on with whatever does not depend on an answer.")] };
	const items = all.map((request) => {
		// The head row holds one line; the whole request stands in the body, and `e` opens the book where it lives.
		const home = request.file ?? (request.kind === POLICY.enums.ledgerKind.question ? join(brainDir, "carto-ledger.json") : planPath(brainDir));
		return {
			key: `request:${request.id}`,
			head: [
				[request.kind === "approval" ? "● " : "? ", request.kind === "approval" ? "warn" : "tool"],
				[`${request.id}  `, "tool"],
				[`[${request.kind}] `, "muted"],
				[request.text, ""],
			],
			body: [
				flat(request.text),
				...(request.detail ?? []),
				request.kind === POLICY.enums.ledgerKind.question
					? `answer with /answer ${request.id} words · d forgets the question`
					: `a approves it · n turns it down · d forgets it, and the agent is not told`,
			].join("\n"),
			copy: `${request.id} [${request.kind}] ${request.text}`,
			target: { file: home, line: request.line },
		};
	});
	const approvals = all.some((request) => request.kind === "approval");
	return {
		header: [
			[[all.length === 1 ? "1 request waits for you" : `${all.length} requests wait for you`, "warn"]],
			[["  a approves it · n turns it down (the agent is told) · d forgets it without a word to the agent", "muted"]],
			[[approvals ? "  /approve ID ... · /deny ID [why] · /delete ID --yes · /answer ID words" : "  /answer ID words · /deny ID [why] · /delete ID --yes", "muted"]],
		],
		items,
	};
}

/** The project's files as a tree whose folders open and fold. `e` opens a file itself. */
export function treeView({ root, tree: provided } = {}, isOpen = () => false) {
	if (provided === undefined) return { header: [[["Project tree is loading…", "muted"]]], items: [] };
	const files = (provided.files ?? []).map((entry) => (typeof entry === "string" ? { path: entry } : entry));
	const marks = new Map(Object.entries(provided.marks ?? {}));
	/** @type {{ dirs: Map<string, any>, files: Array<{ name: string, bytes?: number }>, count: number }} */
	const top = { dirs: new Map(), files: [], count: 0 };
	for (const file of files) {
		const parts = file.path.split("/");
		let dir = top;
		dir.count++;
		for (const part of parts.slice(0, -1)) {
			if (!dir.dirs.has(part)) dir.dirs.set(part, { dirs: new Map(), files: [], count: 0 });
			dir = dir.dirs.get(part);
			dir.count++;
		}
		dir.files.push({ name: parts.at(-1), ...(Number.isFinite(file.bytes) ? { bytes: file.bytes } : {}) });
	}
	const items = [];
	const sizeText = (bytes) => bytes < POLICY.limits.format.kibibyte ? `${bytes} B` : bytes < POLICY.limits.format.mebibyte ? `${(bytes / POLICY.limits.format.kibibyte).toFixed(1)} KB` : `${(bytes / POLICY.limits.format.mebibyte).toFixed(1)} MB`;
	const walk = (dir, prefix, depth) => {
		for (const name of [...dir.dirs.keys()].sort()) {
			const path = `${prefix}${name}`;
			const child = dir.dirs.get(name);
			const nodes = marks.get(path);
			items.push({
				key: `dir:${path}`,
				folder: true,
				depth,
				head: [[`${name}/`, "bold"], [`  ${child.count === 1 ? "1 file" : `${child.count} files`}`, "muted"], [nodes ? `  ← ${nodes.join(", ")}` : "", "tool"]],
				copy: path,
				target: { file: join(root, path), folder: true },
			});
			if (isOpen(`dir:${path}`)) walk(child, `${path}/`, depth + 1);
		}
		for (const file of [...dir.files].sort((a, b) => a.name.localeCompare(b.name))) {
			const path = `${prefix}${file.name}`;
			const nodes = marks.get(path);
			const bytes = file.bytes;
			const size = bytes === undefined ? "gone" : sizeText(bytes);
			items.push({ key: `file:${path}`, depth, head: [[file.name, ""], [`  ${size}`, "muted"], [nodes ? `  ← ${nodes.join(", ")}` : "", "tool"]], copy: path, target: { file: join(root, path) } });
		}
	};
	walk(top, "", 0);
	if (items.length === 0) items.push(note("  The project folder is empty."));
	return { header: [[[`${files.length === 1 ? "1 file" : `${files.length} files`} in ${root}`, "bold"], ["  (without what git ignores and the brain folder; ← names the graph's nodes about a file)", "muted"]]], items };
}

// ─── Diff ───────────────────────────────────────────────────────────────────

/** A patch cut into its files: path -> the lines about that file, without git's own first lines. */
function patchByFile(patch) {
	const byFile = new Map();
	let current;
	for (const line of String(patch ?? "").split("\n")) {
		const start = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
		if (start) {
			current = [];
			byFile.set(start[2], current);
			continue;
		}
		if (current === undefined || /^(index |new file mode|deleted file mode|old mode|new mode|similarity index)/.test(line)) continue;
		current.push(line);
	}
	return byFile;
}
const patchStyle = (line) => (/^\+(?!\+\+)/.test(line) ? "ok" : /^-(?!--)/.test(line) ? "err" : /^@@/.test(line) ? "tool" : /^(\+\+\+|---) /.test(line) ? "bold" : "");
/** One item for each changed file: its line, and the patch inside. */
function changeItems(root, changes, patch) {
	const byFile = patchByFile(patch);
	return changes.map((change) => {
		const lines = byFile.get(change.path) ?? [];
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(lines.find((line) => line.startsWith("@@")) ?? "");
		const counts = change.added === undefined ? "" : ` (${[change.added > 0 ? `+${change.added}` : "", change.removed > 0 ? `−${change.removed}` : ""].filter((part) => part !== "").join(" ")})`;
		return {
			key: `change:${change.path}`,
			head: [[change.status.padEnd(8), change.status === "new" ? "ok" : change.status === "deleted" ? "err" : "warn"], [` ${change.path}`, "bold"], [counts === " ()" ? "" : counts, "muted"]],
			body: lines.length > 0 ? lines.join("\n") : change.added === undefined ? "(not a text file)" : "(no lines changed)",
			bodyStyle: patchStyle,
			copy: () => lines.join("\n"),
			target: change.status === "deleted" ? undefined : { file: join(root, change.path), line: hunk ? Number(hunk[1]) : undefined },
		};
	});
}

export function diffView({ root, review: provided } = {}, which) {
	if (provided === undefined) return { header: [[["Review is loading…", "muted"]]], items: [] };
	if (which === "last") {
		const last = provided.last;
		if (last === undefined) return { header: [], items: [note("  No change task has run that is still in effect.")] };
		const what = last.item ?? (last.windows ? `window ${last.windows.join(", ")}` : "change task");
		const header = [[[`${what} · ${last.text}`, "bold"], [`  ${changeSummary(last.changes)}${last.finished ? "" : " · cut off before it finished; compared with the files as they are now"}`, "muted"]]];
		return { header, items: last.changes.length === 0 ? [note("  It changed no file.")] : changeItems(root, last.changes, last.patch) };
	}
	if (which === "session") {
		const change = provided.change;
		if (change === undefined) return { header: [], items: [note("  No change task has run since carto started here.")] };
		return { header: [[[`Since carto started: ${change.steps === 1 ? "1 step" : `${change.steps} steps`}`, "bold"], [`  ${changeSummary(change.changes)}`, "muted"]]], items: change.changes.length === 0 ? [note("  The files are as they were.")] : changeItems(root, change.changes, change.patch) };
	}
	const own = provided.own;
	if (own === undefined) return { header: [], items: [note("  This project is not a git repository, so there is no HEAD to compare with."), note("  The other two views do not need one: they come from Cartographer's own checkpoints.")] };
	if (own.status.trim() === "") return { header: [], items: [note("  Nothing uncommitted: the project is as its git HEAD has it.")] };
	const byFile = patchByFile(own.patch);
	const items = own.status
		.replace(/\n$/, "")
		.split("\n")
		.map((row) => {
			const mark = row.slice(0, 2);
			const path = row.slice(3).replace(/^"(.*)"$/, "$1");
			const lines = byFile.get(path) ?? [];
			const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(lines.find((line) => line.startsWith("@@")) ?? "");
			return {
				key: `git:${path}`,
				head: [[mark.padEnd(3), mark.includes("?") ? "ok" : mark.includes("D") ? "err" : "warn"], [path, "bold"], [mark.includes("?") ? "  (not known to git yet)" : "", "muted"]],
				...(lines.length > 0 ? { body: lines.join("\n"), bodyStyle: patchStyle } : {}),
				copy: () => lines.join("\n") || path,
				target: mark.includes("D") ? undefined : { file: join(root, path), line: hunk ? Number(hunk[1]) : undefined },
			};
		});
	return { header: [[["Uncommitted in the project's own repository", "bold"], ["  (git status --short, and git diff HEAD inside each file)", "muted"]]], items };
}

// ─── Shells ─────────────────────────────────────────────────────────────────

/** Render the deferred Runtime shell-list projection; this renderer never touches a live window manager. */
export function shellsView({ windows: all = [] } = {}) {
	if (all.length === 0) return { header: [], items: [note("  No shell window is open. A change task opens one when it runs a command.")] };
	const one = (text) => (text.length > POLICY.limits.screen.viewSummaryChars ? `${text.slice(0, POLICY.limits.screen.viewSummaryChars)}…` : text).replace(/\s+/g, " ");
	const items = all.map((win) => {
		const marks = win.sandbox === false ? " · no sandbox" : win.network ? " · network" : "";
		// When the head cuts the command short, the whole command stands in the body: a cut is never silent.
		const shown = win.state === POLICY.enums.windowStates.busy ? win.command ?? "" : win.last?.command ?? "";
		const whole = shown !== "" && one(shown) !== shown ? `$ ${flat(shown)}` : undefined;
		const state =
			win.state === POLICY.enums.windowStates.gone
				? [["gone", "err"], [`  ${win.why}`, "muted"]]
				: win.state === POLICY.enums.windowStates.busy
					? [["busy", "warn"], [` ${took(win.running)}`, ""], [`  $ ${one(shown)}`, "bold"], [win.asks ? "  may be waiting for input" : "", "warn"]]
					: [["free", "ok"], [win.last ? `  last: $ ${one(shown)} → exit ${win.last.exit}, ${ago(win.last.ago)}` : "  nothing was run in it yet", "muted"]];
		const body = [whole, ...win.tail].filter((line) => line !== undefined).join("\n");
		const wholeCommand = shown === "" ? undefined : `$ ${flat(shown)}`;
		return {
			key: `window:${win.name}`,
			head: [[`${win.name}  `, "bold"], ...state, [`${win.cwd && win.cwd !== "." ? `  in ${win.cwd}/` : ""}${marks}`, "muted"]],
			...(body !== "" ? { body, bodyStyle: (line) => (line.startsWith("$ ") ? "bold" : "") } : {}),
			copy: () => [wholeCommand, ...win.tail].filter((line) => line !== undefined).join("\n"),
		};
	});
	return { header: [[[`${all.length === 1 ? "1 shell window" : `${all.length} shell windows`}`, "bold"], ["  · opened, a window shows its newest lines, live · /kill NAME ends one", "muted"]]], items };
}

// ─── Context ────────────────────────────────────────────────────────────────

/** The kinds of thing a context holds, in the order they are listed under the bar. */
export const CATEGORIES = [
	{ id: "system", name: "System prompt", style: "catSystem" },
	{ id: "tools", name: "Tools", style: "catTools" },
	{ id: "top", name: "Assessment and graph", style: "catTop" },
	{ id: "kept", name: "Kept by a collapse", style: "catKept" },
	{ id: "you", name: "Your messages", style: "catYou" },
	{ id: "carto", name: "Cartographer's notes", style: "catCarto" },
	{ id: "agent", name: "Agent: notes and calls", style: "catAgent" },
	{ id: "result", name: "Tool results", style: "catResult" },
	{ id: "state", name: "State block", style: "catState" },
	{ id: "windows", name: "Windows block", style: "catWindows" },
];
const styleOf = (id) => CATEGORIES.find((category) => category.id === id)?.style ?? "";

const contentText = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : "");
const pretty = (value) => {
	try {
		return JSON.stringify(typeof value === "string" ? JSON.parse(value) : value, null, 2);
	} catch {
		return String(value);
	}
};
/** The words of a `chat` call, when its arguments carry them. */
function chatSaid(args) {
	try {
		const parsed = typeof args === "string" ? JSON.parse(args) : args;
		const said = parsed?.text;
		return typeof said === "string" && said.trim() !== "" ? said : undefined;
	} catch {
		return undefined;
	}
}

/** A call as it reads: its name, then each argument, long text as text and not as one JSON string. */
function callText(name, args) {
	let parsed = args;
	if (typeof args === "string") {
		try {
			parsed = JSON.parse(args);
		} catch {
			return `${name}  ${args}`;
		}
	}
	const lines = [`call ${name}`];
	for (const [key, value] of Object.entries(parsed ?? {})) {
		if (typeof value === "string" && (value.includes("\n") || value.length > POLICY.limits.screen.jsonLongValueChars)) lines.push(`  ${key}:`, ...value.split("\n").map((line) => `    ${line}`));
		else lines.push(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
	}
	return lines.join("\n");
}
const firstWords = (text) => text.replace(/\s+/g, " ").trim().slice(0, POLICY.limits.screen.contextSummaryChars);

/**
 * One message of a request cut into what Cartographer added to it and what it is itself.
 * @returns {{ cat: string, title: string, text: string }[]}
 */
function partsOfMessage(message, toolNames) {
	const parts = [];
	let text = contentText(message.content);
	const tail = [];
	const take = (pattern, cat, title, to) => {
		const found = pattern.exec(text);
		if (!found) return;
		to.push({ cat, title, text: found[0].trim() });
		text = text.slice(0, found.index) + text.slice(found.index + found[0].length);
	};
	take(PROJECT_BLOCK, "top", "Assessment and graph, as copied at the last collapse", parts);
	take(CONTEXT_BLOCK, "kept", "What the last collapse kept", parts);
	take(STATE_BLOCK, "state", "State block: the time, the tree, the ledger, the plan", tail);
	take(WINDOWS_BLOCK, "windows", "Windows block: the shell windows as they are", tail);
	const readTail = splitReadTail(text);
	text = readTail.text.trim();
	if (readTail.tail !== undefined) tail.push({ cat: "result", title: "Current read batch: transient file content", text: readTail.tail });
	if (message.role === "assistant") {
		const calls = message.tool_calls ?? [];
		const body = [typeof message.reasoning_content === "string" && message.reasoning_content.trim() !== "" ? `(thinking)\n${message.reasoning_content.trim()}` : "", text, ...calls.map((call) => callText(call.function?.name ?? "?", call.function?.arguments))].filter((part) => part !== "").join("\n\n");
		const names = calls.map((call) => call.function?.name ?? "?");
		// A message whose only work is to say something to the user: its words can be edited as words (e).
		const said = calls.length === 1 && calls[0].function?.name === "chat" ? chatSaid(calls[0].function?.arguments) : undefined;
		parts.push({ cat: "agent", title: names.length === 0 ? "Chat · Agent · note" : `Chat · Agent · ${text !== "" ? "note and " : ""}${names.length === 1 ? "call" : "calls"}: ${names.join(", ")}`, text: body, preview: firstWords(text !== "" ? text : calls.map((call) => String(call.function?.arguments ?? "")).join(" ")), ...(said !== undefined ? { chat: said } : {}) });
	} else if (message.role === "tool") {
		// A task's context continues the main agent's, and its brief stands where the result of the `task` call would.
		if (text.startsWith("You are now the task")) parts.push({ cat: "carto", title: "The task's brief", text });
		else if (text !== "") parts.push({ cat: "result", title: `Result of ${toolNames.get(message.tool_call_id) ?? "a call"}`, text });
	} else if (text !== "") {
		if (text.startsWith(POLICY.markup.note.open)) parts.push({ cat: "carto", title: "Cartographer's note", text });
		else if (text.startsWith(POLICY.markup.context.open) || (/^Cartographer: /.test(text) && !text.startsWith(`${USER_NAME}: `))) parts.push({ cat: "carto", title: "Cartographer", text });
		else parts.push({ cat: "you", title: "Chat · You", text });
	}
	return [...parts, ...tail];
}

/** The bar: the whole window as one row of cells, in the order the model reads it. */
export function contextBar(parts, windowSize, cols) {
	const cells = Math.max(10, cols);
	const per = windowSize / cells;
	const spans = [];
	let at = 0; // tokens before the part in hand
	let index = 0;
	for (let cell = 0; cell < cells; cell++) {
		const middle = (cell + 0.5) * per;
		while (index < parts.length && at + parts[index].tokens <= middle) {
			at += parts[index].tokens;
			index++;
		}
		const part = parts[index];
		const [mark, style] = part === undefined ? ["□", "faint"] : ["■", styleOf(part.cat)];
		if (spans.at(-1)?.[1] === style && spans.at(-1)[0].startsWith(mark)) spans.at(-1)[0] += mark;
		else spans.push([mark, style]);
	}
	return spans;
}

/**
 * The Model tab's sent-request view.
 * @param {ReturnType<ReturnType<typeof import("../engine.mjs").createEngine>["window"]>} sent  what the engine holds of the newest request
 * @param {{ windowSize: number, cols: number, writing?: any, isOpen?: (key: string) => boolean }} options  writing: the response as far as it is written
 */
export function contextView(sent, { windowSize, cols, writing, isOpen }) {
	if (sent === undefined) return { header: [], items: [note("  Nothing has been sent to a provider in this run of carto yet. Send a message, then its frozen provider payload appears here.")] };
	const { payload } = sent;
	const messages = payload.messages ?? [];
	const parts = [];
	const since = [];
	const add = (key, part, extra = {}) => parts.push({ key, tokens: estimate(part.text), ...part, ...extra });
	const addSince = (key, part, extra = {}) => since.push({ key, tokens: estimate(part.text), ...part, ...extra, since: true });
	const rest = messages[0]?.role === "system" ? messages.slice(1) : messages;
	if (messages[0]?.role === "system") add("system", { cat: "system", title: "System prompt", text: contentText(messages[0].content) });
	const tools = payload.tools ?? [];
	// The tools are one sent block. Opened, it gives a line to each definition for reading and copying; the raw
	// provider JSON remains available separately, because this is a semantic reading order rather than raw JSON.
	if (tools.length > 0) {
		const text = tools.map((tool) => `── ${tool.function?.name ?? "?"} ──\n${tool.function?.description ?? ""}\nparameters: ${pretty(tool.function?.parameters ?? {})}`).join("\n\n");
		add("tools", { cat: "tools", title: `Tools · ${tools.length}: ${tools.map((tool) => tool.function?.name).join(", ")}`, text, preview: "" }, { tokens: estimate(JSON.stringify(tools)) });
	}
	const toolNames = new Map();
	for (const [index, message] of rest.entries()) {
		for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function?.name ?? "?");
		for (const [n, part] of partsOfMessage(message, toolNames).entries()) add(`m${index}.${n}.${part.cat}`, part);
	}
	// A response and its results are deliberately outside the frozen provider request. They can inform a later
	// request, but state, windows, read tails, a collapse, or a new message may transform or discard them first.
	const reply = sent.reply ?? writing;
	if (reply !== undefined) {
		const content = Array.isArray(reply.content) ? reply.content : [];
		const calls = content.filter((part) => part.type === "toolCall");
		const text = [
			...content.filter((part) => part.type === "thinking" && String(part.thinking ?? "").trim() !== "").map((part) => `(private reasoning)\n${part.thinking.trim()}`),
			...content.filter((part) => part.type === "text" && part.text.trim() !== "").map((part) => part.text.trim()),
			...calls.map((call) => callText(call.name, call.arguments)),
		].join("\n\n");
		const names = calls.map((call) => call.name);
		addSince("reply", { cat: "agent", title: `${sent.reply === undefined ? "Response, as it is being written" : "Response received"}${names.length > 0 ? ` · ${names.length === 1 ? "call" : "calls"}: ${names.join(", ")}` : " · agent note"}`, text, preview: firstWords(content.filter((part) => part.type === "text").map((part) => part.text).join(" ")) });
		for (const call of calls) {
			const result = sent.results.get(call.id);
			if (result !== undefined) addSince(`result:${call.id}`, { cat: "result", title: `Result after ${call.name}`, text: result });
		}
	}
	const used = parts.reduce((sum, part) => sum + part.tokens, 0);

	// The top describes this frozen provider request only. Response output is shown below the sent boundary and is
	// never counted into the input bar.
	const who = sent.task ? "focus" : "main agent";
	const provider = [sent.model?.provider, sent.model?.api, sent.model?.id].filter((part) => typeof part === "string" && part !== "").join(" · ");
	const usage = sent.usage ?? {};
	const reported = [
		typeof usage.input === "number" ? `input ${short(usage.input)}` : undefined,
		typeof usage.cacheRead === "number" ? `cache read ${short(usage.cacheRead)}` : undefined,
		typeof usage.cacheWrite === "number" ? `cache write ${short(usage.cacheWrite)}` : undefined,
		typeof usage.output === "number" ? `output ${short(usage.output)}` : undefined,
	].filter((part) => part !== undefined).join(" · ");
	const header = [
		[
			["Sent provider request", "bold"],
			[`  ·  ${who} · ${sent.requestId ?? `request ${sent.count}`}`, ""],
			[provider === "" ? "" : `  ·  ${provider}`, "muted"],
		],
		[[`sent ${stamp(sent.at).split(", ").at(-1)} (${ago(Date.now() - sent.at)}) · frozen for this run${sent.payloadHash === undefined ? "" : ` · payload ${sent.payloadHash}`}`, "muted"]],
		[[`about ${short(used)} of ${short(windowSize)} input tokens (${Math.round((used / windowSize) * 100)}%) — estimated${reported === "" ? "" : ` · provider reported ${reported}`}`, ""]],
		contextBar(parts, windowSize, cols),
	];
	const totals = new Map();
	for (const part of parts) totals.set(part.cat, (totals.get(part.cat) ?? 0) + part.tokens);
	const entries = [...CATEGORIES.filter((category) => totals.has(category.id)).map((category) => ({ mark: "■", style: category.style, name: category.name, tokens: totals.get(category.id) })), { mark: "□", style: "faint", name: "Free", tokens: Math.max(0, windowSize - used) }];
	const nameWidth = Math.max(...entries.map((entry) => width(entry.name)));
	const cellWidth = nameWidth + 20;
	const perRow = Math.max(1, Math.floor(cols / cellWidth));
	for (let i = 0; i < entries.length; i += perRow) {
		const row = [];
		for (const entry of entries.slice(i, i + perRow)) {
			const percent = (entry.tokens / windowSize) * 100;
			row.push([`${entry.mark} `, entry.style], [entry.name, ""], [` ${".".repeat(nameWidth - width(entry.name) + 2)} `, "muted"], [short(entry.tokens).padStart(5), ""], [`${(percent > 0 && percent < 0.1 ? "<0.1" : percent < 10 ? percent.toFixed(1) : String(Math.round(percent))).padStart(5)}%   `, "muted"]);
		}
		header.push(row);
	}
	if (sent.collapsedSince) header.push([["! A collapse happened after this request was sent. This snapshot stays as sent; a later request starts from the new kept block.", "warn"]]);
	header.push([], [["Frozen payload parts, in provider reading order. Raw provider JSON is a separate audit view, not another context part.", "faint"]]);

	// A frozen payload is read-only. Its copies are useful historical evidence, not edit handles for current prompt,
	// tool, brain, or talk sources.
	const items = [];
	const one = (part, extra = {}) => {
		// Sent and since-send rows each render the captured text they describe. Current brain edits belong in the
		// Brain view; they never replace bytes in a historical request row.
		const text = part.text;
		return {
			key: part.key,
			head: [["■ ", styleOf(part.cat)], [short(part.tokens).padStart(5), "muted"], [`  ${part.title}`, ""], [`  ${part.preview ?? firstWords(text)}`, "faint"]],
			body: text === "" ? "(empty)" : text,
			copy: text,
			...extra,
		};
	};
	for (const part of parts) {
		// A collapse snapshot is a normal frozen payload part. Opening it shows exactly its own bytes; current
		// ledger, shelf, report, and talk data never unfold underneath it.
		items.push(one(part, part.key === "tools" ? { folder: true } : {}));
		// The tools part stands for the block the provider reads; unfolded, a line for each frozen definition.
		if (part.key === "tools" && isOpen?.("tools")) {
			for (const tool of tools) {
				const name = tool.function?.name ?? "?";
				const text = `${tool.function?.description ?? ""}\n\nparameters: ${pretty(tool.function?.parameters ?? {})}`;
				items.push({
					key: `tool:${name}`,
					depth: 1,
					head: [["· ", "muted"], [short(estimate(JSON.stringify(tool))).padStart(5), "muted"], [`  ${name}`, ""], [`  ${firstWords(tool.function?.description ?? "")}`, "faint"]],
					body: text,
					copy: text,
				});
			}
		}
	}
	// The state block stands at the end of every sent request; one that is not in view here is a defect, not an
	// invitation to substitute current state.
	if (!parts.some((part) => part.cat === "state")) {
		items.push({
			key: "state:missing",
			plain: true,
			head: [["! ", "warn"], ["  No state block in this sent request — this provider payload did not carry one.", "warn"]],
			copy: "",
		});
	}
	if (since.length > 0) {
		items.push({ key: "since", plain: true, head: [[`── since ${sent.requestId ?? `request ${sent.count}`}: response material, not sent ──`, "muted"]] });
		for (const part of since) items.push(one(part));
	}
	return { header, items, parts, since };
}

/**
 * The exact serialized provider body captured at dispatch. It is an audit artifact for copying or wire-level
 * comparison, deliberately separate from the semantic sent-context view so it cannot look like a second prompt.
 */
export function rawPayloadView(sent) {
	const title = "Raw provider payload · audit copy";
	if (sent === undefined) {
		return {
			header: [[[title, "bold"]], [["No provider request has been sent in this run, so there is no frozen raw JSON to inspect.", "muted"]]],
			items: [note("  Nothing has been sent to a provider in this run of carto yet.")],
		};
	}
	const who = sent.task ? "focus" : "main agent";
	const request = sent.requestId ?? `request ${sent.count}`;
	const header = [
		[[title, "bold"], [`  ·  ${who} · ${request}`, ""]],
		[[`Frozen at dispatch${sent.payloadHash === undefined ? "" : ` · payload ${sent.payloadHash}`}. It serializes the same sent request shown in Latest sent or Main sent.`, "muted"]],
		[["This is an audit copy, not another model-context part; it is not included in either sent view's input-token bar.", "faint"]],
	];
	if (typeof sent.payloadJson !== "string") {
		return { header, items: [note("  This sent request has no retained raw provider JSON.", "warn")] };
	}
	return {
		header,
		items: [{
			key: "payload",
			head: [["■ ", "catSystem"], ["  Provider payload JSON", ""], [`  ${short(sent.payloadJson.length)} chars · audit only`, "faint"]],
			body: sent.payloadJson,
			copy: sent.payloadJson,
		}],
	};
}

/** The current request plan is not a provider payload yet. It keeps source facts alongside the exact fragments the
 * planner produced, so this renderer need not guess a lifecycle from completed provider JSON. */
const plannedText = (fragment) => {
	if (typeof fragment === "string") return fragment;
	if (fragment === null || typeof fragment !== "object") return String(fragment ?? "");
	if (!Array.isArray(fragment.content)) return pretty(fragment);
	return fragment.content.map((part) => {
		if (part?.type === "text") return part.text ?? "";
		if (part?.type === "thinking") return `(private reasoning)\n${part.thinking ?? ""}`;
		if (part?.type === "toolCall") return callText(part.name ?? "?", part.arguments);
		return pretty(part);
	}).filter((text) => text !== "").join("\n\n");
};
const plannedTitle = (part) => {
	if (part.kind === "brain-copy") return "Frozen brain copy for this preview";
	if (part.kind === "generated-state") return "Generated state block";
	if (part.kind === "generated-windows") return "Generated windows block";
	if (part.kind === "transient-read-tail") return "Current read batch · transient";
	if (part.kind === "focus-capsule") return "Prepared focus capsule · captured handoff";
	if (part.kind === "focus-start") return "Focused task start query · request-only";
	return `${part.role ?? "active"} message from active conversation`;
};

/** The explicitly prospective main-agent plan. It has no provider payload because pi-ai has not formatted one and no
 * request has been sent. */
export function previewView(preview) {
	if (preview === undefined) return { header: [[["Next request preview · not sent", "bold"]]], items: [note("  Calculating the current main-agent plan without consuming wakes…")] };
	if (preview?.error !== undefined) return { header: [[["Next request preview · not sent", "bold"]]], items: [note(`  ! ${preview.error}`, "warn")] };
	const plan = preview.plan;
	if (plan === undefined) return { header: [[["Next request preview · not sent", "bold"]]], items: [note("  No main-agent request can be planned now.")] };
	const at = Number.isFinite(preview.at) ? stamp(preview.at).split(", ").at(-1) : "just now";
	const header = [
		[["Next request preview · not sent", "bold"], [`  ·  main agent · rebuilt ${at}`, ""]],
		[["Pure current calculation: wakes were not checked or consumed, and no provider request was made or retained.", "muted"]],
		[["State, windows, the read batch, a collapse, or a new message can change this before any send. Provider JSON does not exist for a preview.", "faint"]],
	];
	const items = [];
	for (const part of plan.parts ?? []) {
		const text = plannedText(part.fragment);
		items.push({
			key: `preview:${part.id}`,
			head: [["◇ ", "catState"], [`${plannedTitle(part)}  `, ""], [`${part.source} · preview only`, "faint"]],
			body: text === "" ? "(empty)" : text,
			copy: text,
		});
	}
	if (items.length === 0) items.push(note("  The current plan has no displayable parts."));
	return { header, items };
}

/** A view of plain lines, for text that a command prints. */
export function textView(text) {
	return { header: [], items: String(text ?? "").replace(/\n+$/, "").split("\n").map((line, index) => ({ key: `line:${index}`, plain: true, head: [[line, /^\s*!/.test(line) ? "warn" : ""]] })) };
}

/** Current active-context accounting, deliberately not a historical request inspector or a preview. */
export function accountingView(text) {
	const view = textView(text);
	return {
		...view,
		header: [
			[["Current active-context accounting", "bold"]],
			[["Calculated now from the active conversation and brain. It is neither a sent provider payload nor a promise of the next request.", "muted"]],
		],
	};
}

/**
 * Render the typed Runtime accounting projection. This deliberately formats data from the application facade rather
 * than capturing and parsing the terminal's `/context` words, so a screen refresh cannot turn a presentation adapter
 * into its data source.
 */
export function accountingProjectionView({ messages = [], sizes = {}, contextWindow } = {}, { config = {} } = {}) {
	const tokens = (value) => Number.isFinite(value) ? short(value) : "?";
	const plural = (value, word) => `${value} ${word}${value === 1 ? "" : "s"}`;
	const rows = [];
	const row = (name, value, what) => rows.push(`    ${name.padEnd(8)}${tokens(value).padStart(7)}   ${what}`);
	const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined;
	const known = [sizes.fixed, sizes.top, sizes.front?.total, sizes.work, sizes.state].reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
	if (sizes.fixed === undefined) rows.push(`  The agent's context: of ${tokens(window)} tokens, not measured yet (nothing has been sent in this run of carto yet; the parts below are estimates, without the prompt and the tools)`);
	else rows.push(`  The agent's context: about ${tokens(sizes.used ?? known)} of ${tokens(window)} tokens${sizes.used === undefined ? " (estimated; the server has not counted it yet)" : " (measured, as the server counted it; the parts below are estimates)"}`);
	row("fixed", sizes.fixed, "the prompt and the tools; never changes");
	row("top", sizes.top, "the assessment and the graph, as copied at the last collapse");
	if (sizes.front === undefined) row("kept", 0, "nothing yet: the context has not been collapsed");
	else {
		const kept = sizes.front.tokens ?? {};
		row("record", kept.record, `${plural(sizes.front.kept?.tasks ?? 0, "finished task")}, one line each`);
		row("shelf", kept.shelf, (sizes.front.shelf ?? []).length === 0 ? "empty" : (sizes.front.shelf ?? []).map((item) => `${shelfLabel(item)} [${item.id}]`).join(", "));
		row("talk", kept.talk, `${plural(sizes.front.kept?.talk ?? 0, "message")} between you and the agent${Number.isFinite(config.chatWindow) ? `, of at most ${tokens(config.chatWindow)} tokens` : ""}`);
	}
	const since = messages.filter((message) => !isFront(message)).length;
	const from = sizes.front === undefined ? "the start" : "the last collapse";
	row("work", sizes.work, since === 0 ? `nothing since ${from}` : `${plural(since, "message")} since ${from}; a collapse frees about ${tokens(sizes.frees)}`);
	row("state", sizes.state, "the state block, written anew for every request");
	const store = sizes.store ?? { shelf: [], rows: [] };
	const shelf = Array.isArray(store.shelf) ? store.shelf : [];
	const keptShelf = sizes.front?.shelf ?? [];
	const waiting = shelf.filter((item) => !keptShelf.some((entry) => sameShelfItem(entry, item)));
	const leaving = keptShelf.filter((entry) => !shelf.some((item) => sameShelfItem(entry, item)));
	if (waiting.length > 0) rows.push(`  new shelf snapshots, in view now and carried into the next collapse: ${waiting.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}`);
	if (leaving.length > 0) rows.push(`  taken off the shelf, gone at the next collapse: ${leaving.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}`);
	const records = composedRows(store);
	if (records.length > 0) {
		rows.push(`  kept reports: ${records.length} (${records[0].id} to ${records.at(-1).id}); the newest:`);
		for (const record of records.slice(-POLICY.limits.terminal.recentReports)) rows.push(`    ${recordLine(record)}`);
	}
	if (store.last !== undefined) rows.push(`  last collapse: ${stamp(store.last.at)} (${store.last.reason ?? "unknown reason"})${store.last.before !== undefined && store.last.after !== undefined ? `, about ${tokens(store.last.before)} → ${tokens(store.last.after)} tokens` : ""}`);
	const next = Number.isFinite(config.collapseTokens) ? `once ${tokens(config.collapseTokens)} tokens would go` : "at the configured threshold";
	const away = Number.isFinite(config.collapseMinutes) && config.collapseMinutes > 0 ? ` or you have been away ${took(config.collapseMinutes * 60_000)}` : "";
	rows.push(`  next: while the agent rests, ${next}${away}; when a goal closes; while it works, at ${tokens(sizes.full)} tokens. /collapse does it now.`);
	return accountingView(rows.join("\n"));
}

/**
 * The command that opens a file in the user's editor, at a line when the editor is known to take one.
 * @returns {string} a shell command
 */
export function editorCommand(editor, file, line) {
	const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
	const name = String(editor).trim().split(/\s+/)[0].split("/").at(-1);
	if (line === undefined || !Number.isInteger(line) || line < 1) return `${editor} ${quote(file)}`;
	if (["code", "code-insiders", "codium", "cursor", "windsurf"].includes(name)) return `${editor} --goto ${quote(`${file}:${line}`)}`;
	if (["hx", "helix", "zed", "subl"].includes(name)) return `${editor} ${quote(`${file}:${line}`)}`;
	// vi, vim, nvim, nano, emacs, micro, kak, joe, ne, mg and most others take +LINE.
	return `${editor} +${line} ${quote(file)}`;
}

// ─── Current shared brain ───────────────────────────────────────────────────

/**
 * Carto's current shared-brain view: what the agent keeps with `shelf` and `book` context actions — the shelf and
 * reports — with the same operations offered to the user. These are live brain records, never children of a frozen
 * sent request. A report folds out of view or comes back (f), a file comes off the shelf (x), and a file is shelved
 * with a, which puts /shelve in the prompt. The typed commands /fold, /recall, /shelve, /unshelve and /collapse do
 * the same things from the prompt.
 * @param {{ root: string, brainDir: string }} env
 */
export function handsView({ root, context: provided, error } = {}) {
	if (error !== undefined) return { header: [[[`! ${error}`, "warn"]]], items: [note("  Current shared brain will be retried automatically.", "muted")] };
	if (provided === undefined) return { header: [[["Loading current shared brain…", "muted"]]], items: [] };
	const store = provided.store ?? provided;
	const header = [
		[["Current shared brain", "bold"], ["  ·  live shelf and reports; not part of any sent provider request", "muted"]],
		[["Your hands on what the agent keeps", "muted"], ["  ·  salient notes live in the Ledger view", "muted"]],
	];
	const items = [];
	items.push(heading("  The shelf · snapshots are in view now, carried through collapse, and read by every task at its start"));
	const shelves = provided.shelf ?? [];
	if (shelves.length === 0) items.push(note("  Nothing is on the shelf. a shelves a file; the agent shelves with `shelf`."));
	for (const shelf of shelves) {
		const item = shelf.item ?? shelf;
		const text = shelf.text ?? "(the shelf snapshot cannot be read)";
		items.push({
			key: `shelf:${shelfLabel(item)}`,
			kind: "shelf",
			head: [[`${shelfLabel(item)} · ${item.id}  `, ""], [`about ${short(estimate(text))} rendered tokens`, "muted"]],
			body: text,
			...(item.path === undefined ? {} : { path: join(root, item.path) }),
		});
	}
	const standing = provided.standing ?? [];
	const archived = provided.archived ?? [];
	items.push(heading("  The reports of finished work · f folds one out of view, v archives it out of the record, d opens a deletion confirmation"));
	if (standing.length === 0 && archived.length === 0) items.push(note("  No work has been finished yet. When a task ends, its report is kept here, and its record line stands in the context."));
	for (const source of standing) {
		const record = source.record ?? source;
		const text = Object.hasOwn(source, "text") ? source.text : undefined;
		const folded = (store.dropped ?? []).includes(record.id);
		items.push({
			key: `report:${record.id}`,
			kind: "report",
			archived: false,
			folded,
			head: [
				[`${record.id}  `, folded ? "muted" : "bold"],
				[folded ? "· folded  " : "· in view  ", folded ? "muted" : "ok"],
				[recordLine(record), folded ? "faint" : ""],
			],
			body: text ?? "(the report's file is gone)",
		});
	}
	if (archived.length > 0) {
		items.push(heading("  Archived · the record no longer lists them; recall by id still finds them"));
		for (const source of archived) {
			const record = source.record ?? source;
			const text = Object.hasOwn(source, "text") ? source.text : undefined;
			items.push({
				key: `report:${record.id}`,
				kind: "report",
				archived: true,
				head: [
					[`${record.id}  `, "muted"],
					["· archived  ", "muted"],
					[recordLine(record), "faint"],
				],
				body: text ?? "(the report's file is gone)",
			});
		}
	}
	return { header, items };
}

/** The selected deferred shell-output projection, as a terminal emulator sees its newest lines. */
export function shellsOutView({ window: pick, lines = [] } = {}) {
	if (pick === undefined) return { header: [], items: [note("  No shell window is open. A change task opens one when it runs a command.")] };
	const what =
		pick.state === POLICY.enums.windowStates.busy
			? [["busy", "warn"], [`  $ ${pick.command ?? ""}`, "bold"], [pick.asks ? "  · may be waiting for input" : "", "warn"]]
			: pick.state === POLICY.enums.windowStates.gone
				? [["gone", "err"], [`  ${pick.why ?? ""}`, "muted"]]
				: [["free", "ok"]];
	const header = [
		[["Output of ", "bold"], [pick.name, "bold"], ["  ·  ", "muted"], ...what, [`${pick.cwd && pick.cwd !== "." ? `  in ${pick.cwd}/` : ""}${pick.sandbox === false ? "  · no sandbox" : pick.network ? "  · network" : ""}`, "muted"]],
		[["The newest lines, as the window keeps them; the view follows on its own.", "faint"]],
		[["/send " + pick.name + " line types into it from the prompt.", "faint"]],
	];
	const items = [
		{ key: "term", plain: true, head: lines.length === 0 ? [["  (nothing has been printed yet)", "muted"]] : lines.map((line) => [line || " ", ""]) },
	];
	return { header, items };
}
