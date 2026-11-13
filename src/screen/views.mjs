// What tabs 2 to 5 of the full screen hold: the brain, the changes, the shell windows, and the context.
//
// Each function here reads its part of the brain or of the session and returns what a list shows
// (src/screen/list.mjs): a few lines for the top, and items that fold. `isOpen(key)` is given because for a folder
// what is open decides which items there are. An item names the file it comes from and the line, so that `e` can
// open it there.
//
// The Context tab is the one that is not read from a file. It shows the request the agent was last sent, exactly
// as the server got it and in the order the model reads it: the system prompt, the tools, then every message, with
// the blocks Cartographer adds (the copy of the assessment and the graph, what a collapse kept, the state block,
// the windows block) as parts of their own. Then what has come since: the reply and what its calls returned.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assessmentPath } from "../assessment.mjs";
import { atlasPath, atlasSummary, fileMarks, loadAtlas, staleNodes } from "../atlas.mjs";
import { bookLine, booksPath, loadBooks } from "../books.mjs";
import { changeSince, changeSummary, lastChange, uncommitted } from "../checkpoints.mjs";
import { estimate } from "../context.mjs";
import { entryLine, loadLedger } from "../ledger.mjs";
import { authorizationLine, itemLine, loadPlan, planPath } from "../plan.mjs";
import { listRequests } from "../requests.mjs";
import { ago, stamp, took } from "../time.mjs";
import { projectFiles } from "../tools/look.mjs";
import { short, width } from "./text.mjs";

const heading = (text) => ({ key: `heading:${text}`, plain: true, head: [[text, "heading"]] });
const note = (text, style = "muted") => ({ key: `note:${text}`, plain: true, head: [[text, style]] });
const when = (value) => {
	const ms = typeof value === "number" ? value : Date.parse(value ?? "");
	return Number.isFinite(ms) ? stamp(ms) : undefined;
};

/** The line of a file on which `needle` first stands, counted from 1; undefined when it does not. */
function lineOf(file, needle) {
	try {
		const at = readFileSync(file, "utf8").indexOf(needle);
		if (at === -1) return undefined;
		return readFileSync(file, "utf8").slice(0, at).split("\n").length;
	} catch {
		return undefined;
	}
}
/** Where an entry with this value of `field` stands in one of the brain's JSON files. */
const jsonLine = (file, field, value) => lineOf(file, `"${field}": ${JSON.stringify(value)}`);

// ─── Carto ──────────────────────────────────────────────────────────────────

/** The graph: one item for each node. */
export function atlasView({ root, brainDir }) {
	const file = atlasPath(brainDir);
	const { atlas, error } = loadAtlas(brainDir);
	if (atlas === undefined) return { header: [[[`! The graph cannot be read: ${error}`, "warn"]], [[`  ${file} · e opens it`, "muted"]]], items: [{ key: "file", head: [[file, ""]], target: { file } }] };
	const stale = new Map(staleNodes(root, atlas).map((node) => [node.name, node.why]));
	const items = atlas.nodes.map((node) => {
		const old = stale.get(node.name);
		const body = [
			node.detail,
			node.files.length > 0 ? `files: ${node.files.join(", ")}` : undefined,
			node.links.length > 0 ? `links: ${node.links.join(", ")}` : undefined,
			`written ${when(node.written) ?? "at an unknown time"} by ${node.by === "task" ? "a task" : "the main agent"}`,
			old ? `may be out of date: ${old.join(", ")}` : undefined,
		].filter((line) => line !== undefined && line !== "");
		return {
			key: `node:${node.name}`,
			head: [
				[node.kind ? `${node.kind.replace("_", " ")} ` : "", "muted"],
				[node.name, "bold"],
				[`  ${node.gist}`, ""],
				[node.files.length > 0 ? `  [${node.files.join(", ")}]` : "", "tool"],
				[node.links.length > 0 ? `  → ${node.links.join(", ")}` : "", "muted"],
				[old ? "  (may be out of date)" : "", "warn"],
			],
			body: body.join("\n"),
			target: { file, line: jsonLine(file, "name", node.name) },
		};
	});
	const header = [[[`Graph: ${atlasSummary(atlas)}`, "bold"], [stale.size > 0 ? ` · ${stale.size} may be out of date` : "", "warn"]]];
	if (items.length === 0) items.push(note("  No nodes yet. The agent and its tasks write them as they learn the project."));
	return { header, items };
}

/** The ledger: goals, questions and notes that are open, then what is closed. */
export function ledgerView({ brainDir }) {
	const file = join(brainDir, "carto-ledger.json");
	const { ledger, error } = loadLedger(brainDir);
	if (ledger === undefined) return { header: [[[`! The ledger cannot be read: ${error}`, "warn"]]], items: [{ key: "file", head: [[file, ""]], target: { file } }] };
	const now = Date.now();
	const items = [];
	const entry = (item) => ({
		key: `entry:${item.id}`,
		head: [[`${item.id}  `, item.status === "done" ? "muted" : "tool"], [item.text, item.status === "done" ? "muted" : ""], [item.kind === "goal" && item.doneWhen ? `  (done when: ${item.doneWhen})` : "", "muted"]],
		body: [
			item.text,
			item.kind === "goal" && item.doneWhen ? `done when: ${item.doneWhen}` : undefined,
			item.status === "done" && item.outcome ? `outcome: ${item.outcome}` : undefined,
			`${item.by === "user" ? "written by you" : "written by the agent"}${when(item.added) ? ` · added ${when(item.added)}` : ""}${item.status === "done" && when(item.closed) ? ` · closed ${when(item.closed)}` : ""}`,
		]
			.filter((line) => line !== undefined)
			.join("\n"),
		copy: entryLine(item, now),
		target: { file, line: jsonLine(file, "id", item.id) },
	});
	for (const [kind, title] of [["goal", "Goals"], ["question", "Questions for you"], ["note", "Notes"]]) {
		const open = ledger.items.filter((item) => item.kind === kind && item.status === "open");
		if (open.length === 0) continue;
		items.push(heading(title));
		items.push(...open.map(entry));
	}
	const done = ledger.items.filter((item) => item.status !== "open");
	if (done.length > 0) {
		items.push(heading("Closed"));
		items.push(...done.map(entry));
	}
	if (items.length === 0) items.push(note("  The ledger is empty: no goal yet. Say what you want to achieve."));
	return { header: [], items };
}

/** The plan: whether it is authorized, then its items in order. */
export function planView({ brainDir, yolo }) {
	const file = planPath(brainDir);
	const { plan, error } = loadPlan(brainDir);
	if (plan === undefined && error !== undefined) return { header: [[[`! The plan cannot be read: ${error}`, "warn"]]], items: [{ key: "file", head: [[file, ""]], target: { file } }] };
	if (plan === undefined || plan.items.length === 0) return { header: [], items: [note("  There is no plan. The agent writes one when a goal needs changes.")] };
	const items = plan.items.map((item) => ({
		key: `item:${item.id}`,
		head: [
			[item.status === "done" ? "✓ " : "○ ", item.status === "done" ? "ok" : "warn"],
			[`${item.id} `, "tool"],
			[`[${item.mode}${item.network ? ", network" : ""}${item.standing ? ", standing" : ""}] `, "muted"],
			[item.text, item.status === "done" ? "muted" : ""],
			[item.status === "done" && item.outcome ? `  → ${item.outcome}` : "", "muted"],
		],
		body: [
			item.text,
			item.status === "done" ? `done${when(item.closed) ? ` ${when(item.closed)}` : ""}${item.outcome ? `: ${item.outcome}` : ""}` : "open",
			item.undone ? "undone by you: the files are as they were before this item ran" : undefined,
		]
			.filter((line) => line !== undefined)
			.join("\n"),
		copy: itemLine(item),
		target: { file, line: jsonLine(file, "id", item.id) },
	}));
	const waits = !yolo && plan.authorized === undefined && plan.items.some((item) => item.status === "open" && item.mode === "change");
	return { header: [[[authorizationLine(plan, { yolo }), waits ? "warn" : "muted"], [waits ? "  Type /approve to authorize it." : "", "warn"]]], items };
}

/** What waits for the user: change items, questions of taste, and changes to the agent's own prompt. */
export function requestsView({ brainDir, yolo }) {
	const all = listRequests(brainDir, { yolo });
	if (all.length === 0) return { header: [], items: [note("  Nothing waits for you. The agent goes on with whatever does not depend on an answer.")] };
	const items = all.map((request) => ({
		key: `request:${request.id}`,
		head: [
			[request.kind === "approval" ? "● " : request.kind === "question" ? "? " : "◆ ", request.kind === "approval" ? "warn" : "tool"],
			[`${request.id}  `, "tool"],
			[`[${request.kind}] `, "muted"],
			[request.text, ""],
		],
		body: [
			...(request.detail ?? []),
			request.kind === "question" ? `answer with /answer ${request.id} words` : `/approve ${request.id} approves it · /deny ${request.id} turns it down`,
		].join("\n"),
		copy: `${request.id} [${request.kind}] ${request.text}`,
	}));
	const approvals = all.some((request) => request.kind === "approval");
	return {
		header: [
			[[all.length === 1 ? "1 request waits for you" : `${all.length} requests wait for you`, "warn"]],
			[[approvals ? "  /approve ID ... · /deny ID [why] · /answer ID words" : "  /answer ID words · /deny ID [why]", "muted"]],
		],
		items,
	};
}

/** The project's files as a tree whose folders open and fold. `e` opens a file itself. */
export function treeView({ root, brainDir }, isOpen) {
	const files = projectFiles(root);
	const { atlas } = loadAtlas(brainDir);
	const marks = atlas ? fileMarks(atlas) : new Map();
	/** @type {{ dirs: Map<string, any>, files: string[], count: number }} */
	const top = { dirs: new Map(), files: [], count: 0 };
	for (const path of files) {
		const parts = path.split("/");
		let dir = top;
		dir.count++;
		for (const part of parts.slice(0, -1)) {
			if (!dir.dirs.has(part)) dir.dirs.set(part, { dirs: new Map(), files: [], count: 0 });
			dir = dir.dirs.get(part);
			dir.count++;
		}
		dir.files.push(parts.at(-1));
	}
	const items = [];
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
		for (const name of dir.files.sort()) {
			const path = `${prefix}${name}`;
			const nodes = marks.get(path);
			let size = "";
			try {
				const bytes = statSync(join(root, path)).size;
				size = bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
			} catch {
				size = "gone";
			}
			items.push({ key: `file:${path}`, depth, head: [[name, ""], [`  ${size}`, "muted"], [nodes ? `  ← ${nodes.join(", ")}` : "", "tool"]], copy: path, target: { file: join(root, path) } });
		}
	};
	walk(top, "", 0);
	if (items.length === 0) items.push(note("  The project folder is empty."));
	return { header: [[[`${files.length === 1 ? "1 file" : `${files.length} files`} in ${root}`, "bold"], ["  (without what git ignores and the brain folder; ← names the graph's nodes about a file)", "muted"]]], items };
}

/** The books: the assessment of the project and the practice, one entry to an item, so that `e` opens the file where it is. */
export function booksView({ brainDir }) {
	// Until the agent's first book operation the entries live only in assessment.md; the view opens that.
	const store = booksPath(brainDir);
	const file = existsSync(store) ? store : assessmentPath(brainDir);
	const book = loadBooks(brainDir);
	const entry = (item) => {
		const first = item.text.split("\n")[0];
		const more = item.text.includes("\n") || width(first) > 100;
		const target = file === store ? { file, line: jsonLine(file, "id", item.id) } : { file, line: lineOf(file, first) };
		return {
			key: `entry:${item.id}`,
			head: [[`${item.id}  `, item.status === "done" ? "muted" : "tool"], [first, item.status === "done" ? "muted" : ""]],
			...(more ? { body: item.text } : {}),
			copy: bookLine(item),
			target,
		};
	};
	const items = [];
	for (const [kind, title] of [["assessment", "Assessment of the project"], ["practice", "Practice: how the agent works"]]) {
		const mine = book.items.filter((item) => item.kind === kind);
		if (mine.length === 0) continue;
		items.push(heading(title));
		items.push(...mine.filter((item) => item.status === "open").map(entry), ...mine.filter((item) => item.status === "done").map(entry));
	}
	if (items.length === 0) return { header: [], items: [note("  The books are empty. The agent writes what it learns about the project, and about how it works.")] };
	return { header: [[[`The agent's books · ${store}`, "bold"]], [["  /practice shows the second book on the terminal", "muted"]]], items };
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

export function diffView({ root, brainDir, started }, which) {
	if (which === "last") {
		const last = lastChange(root, brainDir);
		if (last === undefined) return { header: [], items: [note("  No change task has run that is still in effect.")] };
		const what = last.item ?? (last.windows ? `window ${last.windows.join(", ")}` : "change task");
		const header = [[[`${what} · ${last.text}`, "bold"], [`  ${changeSummary(last.changes)}${last.finished ? "" : " · cut off before it finished; compared with the files as they are now"}`, "muted"]]];
		return { header, items: last.changes.length === 0 ? [note("  It changed no file.")] : changeItems(root, last.changes, last.patch) };
	}
	if (which === "session") {
		const change = changeSince(root, brainDir, started);
		if (change === undefined) return { header: [], items: [note("  No change task has run since carto started here.")] };
		return { header: [[[`Since carto started: ${change.steps === 1 ? "1 step" : `${change.steps} steps`}`, "bold"], [`  ${changeSummary(change.changes)}`, "muted"]]], items: change.changes.length === 0 ? [note("  The files are as they were.")] : changeItems(root, change.changes, change.patch) };
	}
	const own = uncommitted(root);
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

export function shellsView({ session }) {
	const all = session.windows?.list(200) ?? [];
	if (all.length === 0) return { header: [], items: [note("  No shell window is open. A change task opens one when it runs a command.")] };
	const one = (text) => (text.length > 70 ? `${text.slice(0, 70)}…` : text).replace(/\s+/g, " ");
	const items = all.map((win) => {
		const marks = win.sandbox === false ? " · no sandbox" : win.network ? " · network" : "";
		const state =
			win.state === "gone"
				? [["gone", "err"], [`  ${win.why}`, "muted"]]
				: win.state === "busy"
					? [["busy", "warn"], [` ${took(win.running)}`, ""], [`  $ ${one(win.command ?? "")}`, "bold"], [win.asks ? "  may be waiting for input" : "", "warn"]]
					: [["free", "ok"], [win.last ? `  last: $ ${one(win.last.command)} → exit ${win.last.exit}, ${ago(win.last.ago)}` : "  nothing was run in it yet", "muted"]];
		return {
			key: `window:${win.name}`,
			head: [[`${win.name}  `, "bold"], ...state, [`${win.cwd && win.cwd !== "." ? `  in ${win.cwd}/` : ""}${marks}`, "muted"]],
			...(win.tail.length > 0 ? { body: win.tail.join("\n"), bodyStyle: (line) => (line.startsWith("$ ") ? "bold" : "") } : {}),
			copy: () => win.tail.join("\n"),
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
		if (typeof value === "string" && (value.includes("\n") || value.length > 80)) lines.push(`  ${key}:`, ...value.split("\n").map((line) => `    ${line}`));
		else lines.push(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
	}
	return lines.join("\n");
}
const firstWords = (text) => text.replace(/\s+/g, " ").trim().slice(0, 160);

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
	take(/^<project>\n[\s\S]*?\n<\/project>\n*/, "top", "Assessment and graph, as copied at the last collapse", parts);
	take(/<context>\nWritten by Cartographer[\s\S]*?\n<\/context>\n*/, "kept", "What the last collapse kept", parts);
	take(/\n*<state>\nWritten by Cartographer[\s\S]*?\n<\/state>/, "state", "State block: the time, the tree, the ledger, the plan", tail);
	take(/\n*<windows>\nWritten by Cartographer[\s\S]*?\n<\/windows>\s*$/, "windows", "Windows block: the shell windows as they are", tail);
	text = text.trim();
	if (message.role === "assistant") {
		const calls = message.tool_calls ?? [];
		const body = [typeof message.reasoning_content === "string" && message.reasoning_content.trim() !== "" ? `(thinking)\n${message.reasoning_content.trim()}` : "", text, ...calls.map((call) => callText(call.function?.name ?? "?", call.function?.arguments))].filter((part) => part !== "").join("\n\n");
		const names = calls.map((call) => call.function?.name ?? "?");
		parts.push({ cat: "agent", title: names.length === 0 ? "Agent · note" : `Agent · ${text !== "" ? "note and " : ""}${names.length === 1 ? "call" : "calls"}: ${names.join(", ")}`, text: body, preview: firstWords(text !== "" ? text : calls.map((call) => String(call.function?.arguments ?? "")).join(" ")) });
	} else if (message.role === "tool") {
		// A task's context continues the main agent's, and its brief stands where the result of the `task` call would.
		if (text.startsWith("You are now the task")) parts.push({ cat: "carto", title: "The task's brief", text });
		else if (text !== "") parts.push({ cat: "result", title: `Result of ${toolNames.get(message.tool_call_id) ?? "a call"}`, text });
	} else if (text !== "") {
		if (text.startsWith("<cartographer>")) parts.push({ cat: "carto", title: "Cartographer's note", text });
		else if (text.startsWith("<context>") || /^Cartographer: /.test(text)) parts.push({ cat: "carto", title: "Cartographer", text });
		else parts.push({ cat: "you", title: "You", text });
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
 * The Context tab's main view.
 * @param {ReturnType<ReturnType<typeof import("../engine.mjs").createEngine>["window"]>} sent  what the engine holds of the newest request
 * @param {{ windowSize: number, cols: number, writing?: any }} options  writing: the reply as far as it is written
 */
export function contextView(sent, { windowSize, cols, writing }) {
	if (sent === undefined) return { header: [], items: [note("  Nothing has been sent to the model in this run of carto yet. Say something, and what the agent sees shows here.")] };
	const { payload } = sent;
	const messages = payload.messages ?? [];
	const parts = [];
	const add = (key, part, extra = {}) => parts.push({ key, tokens: estimate(part.text), ...part, ...extra });
	const rest = messages[0]?.role === "system" ? messages.slice(1) : messages;
	if (messages[0]?.role === "system") add("system", { cat: "system", title: "System prompt", text: contentText(messages[0].content) });
	const tools = payload.tools ?? [];
	if (tools.length > 0) {
		const text = tools.map((tool) => `── ${tool.function?.name ?? "?"} ──\n${tool.function?.description ?? ""}\nparameters: ${pretty(tool.function?.parameters ?? {})}`).join("\n\n");
		add("tools", { cat: "tools", title: `Tools · ${tools.length}: ${tools.map((tool) => tool.function?.name).join(", ")}`, text, preview: "" }, { tokens: estimate(JSON.stringify(tools)) });
	}
	const toolNames = new Map();
	for (const [index, message] of rest.entries()) {
		for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function?.name ?? "?");
		for (const [n, part] of partsOfMessage(message, toolNames).entries()) add(`m${index}.${n}.${part.cat}`, part);
	}
	const inRequest = parts.length;
	// What has come since that request: the reply, and what its calls returned. The next request holds them.
	const reply = sent.reply ?? writing;
	if (reply !== undefined) {
		const content = Array.isArray(reply.content) ? reply.content : [];
		const calls = content.filter((part) => part.type === "toolCall");
		const text = [
			...content.filter((part) => part.type === "thinking" && String(part.thinking ?? "").trim() !== "").map((part) => `(thinking, not kept in the context)\n${part.thinking.trim()}`),
			...content.filter((part) => part.type === "text" && part.text.trim() !== "").map((part) => part.text.trim()),
			...calls.map((call) => callText(call.name, call.arguments)),
		].join("\n\n");
		const names = calls.map((call) => call.name);
		add("reply", { cat: "agent", title: `${sent.reply === undefined ? "The reply, as it is being written" : "The reply"}${names.length > 0 ? ` · ${names.length === 1 ? "call" : "calls"}: ${names.join(", ")}` : " · note"}`, text, preview: firstWords(content.filter((part) => part.type === "text").map((part) => part.text).join(" ")) }, { since: true });
		for (const call of calls) {
			const result = sent.results.get(call.id);
			if (result !== undefined) add(`result:${call.id}`, { cat: "result", title: `Result of ${call.name}`, text: result }, { since: true });
		}
	}
	const used = parts.reduce((sum, part) => sum + part.tokens, 0);

	// The top: whose window it is, how full, the bar, and what each colour is.
	const who = sent.task ? "the running task" : "the main agent";
	const header = [
		[
			[`What ${who} sees`, "bold"],
			[`  ·  about ${short(used)} of ${short(windowSize)} tokens (${Math.round((used / windowSize) * 100)}%)`, ""],
			[sent.used !== undefined ? `  ·  the server counted ${short(sent.used)}` : "", "muted"],
		],
		[[`request ${sent.count} of this run, sent ${stamp(sent.at).split(", ").at(-1)} (${ago(Date.now() - sent.at)}), as the server got it · part sizes are estimates`, "muted"]],
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
	if (sent.collapsedSince) header.push([["! The context was collapsed after this request was sent: the next request starts from what the collapse kept, not from this.", "warn"]]);
	header.push([], [["Every part, in the order the model reads it. Enter opens one, + all of them.", "faint"]]);

	const items = [];
	for (const [index, part] of parts.entries()) {
		if (index === inRequest) items.push({ key: "since", plain: true, head: [["── since that request: what the next one will hold as well ──", "muted"]] });
		items.push({
			key: part.key,
			head: [["■ ", styleOf(part.cat)], [short(part.tokens).padStart(5), "muted"], [`  ${part.title}`, ""], [`  ${part.preview ?? firstWords(part.text)}`, "faint"]],
			body: part.text === "" ? "(empty)" : part.text,
			copy: part.text,
		});
	}
	return { header, items, parts };
}

/** A view of plain lines, for text that a command prints. */
export function textView(text) {
	return { header: [], items: String(text ?? "").replace(/\n+$/, "").split("\n").map((line, index) => ({ key: `line:${index}`, plain: true, head: [[line, /^\s*!/.test(line) ? "warn" : ""]] })) };
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

/** Whether a path names a folder, which an editor is not asked to open. */
export const isFolder = (path) => {
	try {
		return existsSync(path) && statSync(path).isDirectory();
	} catch {
		return false;
	}
};
