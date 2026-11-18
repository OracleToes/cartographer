// What tabs 2 to 5 of the full screen hold: the brain, the changes, the shell windows, and the context.
//
// Each function here reads its part of the brain or of the session and returns what a list shows
// (src/screen/list.mjs): a few lines for the top, and items that fold. `isOpen(key)` is given because for a folder
// what is open decides which items there are. An item names the file it comes from and the line, so that `e` can
// open it there.
//
// The Model tab is the one that is not read from a file. Its sent pane shows the frozen provider payload captured
// immediately before dispatch: the system prompt, tools, then messages, with Cartographer's additions as parts of
// their own. Response material belongs below a plain `not sent` boundary. Current shared-brain state lives in Carto;
// a sent snapshot is never rebuilt from it.
import { POLICY } from "../config.mjs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeMoveOverlays, atlasPath, atlasSummary, attentionSnapshot, fileMarks, loadAtlas, renderAttention } from "../atlas.mjs";
import { changeSince, changeSummary, lastChange, uncommitted } from "../checkpoints.mjs";
import { estimate, loadContext, loadReport, recordLine, shelfLabel, shelfText, composedRows, splitReadTail } from "../context.mjs";
import { entryLine, loadLedger } from "../ledger.mjs";
import { authorizationLine, itemLine, loadPlan, movesOf, planPath, waiting } from "../plan.mjs";
import { flat } from "../rows.mjs";
import { listRequests } from "../requests.mjs";
import { ago, clock, stamp, took } from "../time.mjs";
import { projectFiles } from "../tools/look.mjs";
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
	const active = activeMoveOverlays(loadPlan(brainDir).plan);
	const snapshot = attentionSnapshot(root, atlas, { active });
	const care = new Map(snapshot.care.map(({ node, why }) => [node.id, why]));
	const local = renderAttention(snapshot, { idle: active.length === 0 });
	const items = [];
	if (local !== "") items.push({ key: "atlas:attention", plain: true, head: [["Local map", "heading"]], body: local });
	items.push(...atlas.nodes.map((node) => {
		const checking = care.get(node.id);
		const body = [
			`gist: ${node.gist}`,
			node.detail,
			node.files.length > 0 ? `files: ${node.files.join(", ")}` : undefined,
			node.links.length > 0 ? `links: ${node.links.join(", ")}` : undefined,
			`written ${when(node.written) ?? "at an unknown time"} by ${node.by === "task" ? "a task" : "the main agent"}`,
			checking?.length > 0 ? `needs checking: ${checking.join(", ")}` : undefined,
		].filter((line) => line !== undefined && line !== "");
		return {
			key: `node:${node.name}`,
			archived: node.archived === true,
			head: [
				[node.name, "bold"],
				[`  ${node.gist}`, ""],
				[node.files.length > 0 ? `  [${node.files.join(", ")}]` : "", "tool"],
				[node.links.length > 0 ? `  → ${node.links.join(", ")}` : "", "muted"],
				[checking?.length > 0 ? "  (needs checking)" : "", "warn"],
				[node.archived === true ? "  · archived: the agent does not read it (v brings it back)" : "", "warn"],
			],
			body: body.join("\n"),
			target: { file, line: jsonLine(file, "name", node.name) },
		};
	}));
	const header = [[[`Graph: ${atlasSummary(atlas)}`, "bold"], [care.size > 0 ? ` · ${care.size} need checking` : "", "warn"]]];
	if (atlas.nodes.length === 0) items.push(note("  No nodes yet. The agent and its tasks write them as they learn the project."));
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
		archived: item.archived === true,
		head: [
			[`${item.salient === true && item.status === POLICY.enums.entryStatus.open && item.kind === POLICY.enums.ledgerKind.note ? "● " : ""}${item.id}  `, item.status === POLICY.enums.entryStatus.done || item.archived === true ? "muted" : "tool"],
			[item.text, item.status === POLICY.enums.entryStatus.done || item.archived === true ? "muted" : ""],
			[item.kind === POLICY.enums.ledgerKind.goal && item.doneWhen ? `  (done when: ${item.doneWhen})` : "", "muted"],
			[item.salient === true && item.status === POLICY.enums.entryStatus.open ? "  · salient" : "", "ok"],
			[item.archived === true ? "  · archived: the agent does not read it (v brings it back)" : "", "warn"],
		],
		body: [
			item.text,
			item.salient === true && item.kind === POLICY.enums.ledgerKind.note ? "salient: stands in every request, including the block a collapse keeps (edit the entry to drop it)" : undefined,
			item.kind === POLICY.enums.ledgerKind.goal && item.doneWhen ? `done when: ${item.doneWhen}` : undefined,
			item.status === POLICY.enums.entryStatus.done && item.outcome ? `outcome: ${item.outcome}` : undefined,
			`${item.by === "user" ? "written by you" : "written by the agent"}${when(item.added) ? ` · added ${when(item.added)}` : ""}${item.status === POLICY.enums.entryStatus.done && when(item.closed) ? ` · closed ${when(item.closed)}` : ""}`,
		]
			.filter((line) => line !== undefined)
			.join("\n"),
		copy: entryLine(item, now),
		target: { file, line: jsonLine(file, "id", item.id) },
	});
	for (const [kind, title] of [[POLICY.enums.ledgerKind.goal, "Goals"], [POLICY.enums.ledgerKind.question, "Questions for you"], [POLICY.enums.ledgerKind.note, "Notes"]]) {
		const open = ledger.items.filter((item) => item.kind === kind && item.status === POLICY.enums.entryStatus.open);
		if (open.length === 0) continue;
		items.push(heading(title));
		items.push(...open.map(entry));
	}
	const done = ledger.items.filter((item) => item.status !== POLICY.enums.entryStatus.open);
	if (done.length > 0) {
		items.push(heading("Closed"));
		items.push(...done.map(entry));
	}
	if (items.length === 0) items.push(note("  The ledger is empty: no goal yet. Say what you want to achieve."));
	const header = [];
	return { header, items };
}

/** The plan: authorization envelopes, then their declared executable moves. */
export function planView({ brainDir, yolo }) {
	const file = planPath(brainDir);
	const { plan, error } = loadPlan(brainDir);
	if (plan === undefined && error !== undefined) return { header: [[[`! The plan cannot be read: ${error}`, "warn"]]], items: [{ key: "file", head: [[file, ""]], target: { file } }] };
	if (plan === undefined || plan.items.length === 0) return { header: [], items: [note("  There is no plan. The agent writes an envelope when a goal needs changes.")] };
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
			target: { file, line: jsonLine(file, "id", envelope.id) },
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
					move.status === "reported" ? `reported: ${move.reported?.id ?? "no report id"}; inspect the report and checkpoints, then settle to accept` : undefined,
					move.status === "reported" && move.reported?.checkpoints ? `checkpoints: ${move.reported.checkpoints.before} → ${move.reported.checkpoints.after}` : undefined,
					move.status === "reported" && Array.isArray(move.reported?.changes) ? `changed paths: ${move.reported.changes.map((change) => change.path).join(", ") || "none"}` : undefined,
					move.status === "reported" && move.reported?.proof ? `reported proof: ${move.reported.proof}` : undefined,
					move.status === "blocked" ? `blocked: ${move.blocked ?? "no reason recorded"}` : undefined,
					move.status === "done" ? `accepted${when(move.closed) ? ` ${when(move.closed)}` : ""}${move.outcome ? `: ${move.outcome}` : ""}` : undefined,
				]
					.filter((line) => line !== undefined)
					.join("\n"),
				copy: itemLine(move),
				target: { file, line: jsonLine(file, "id", move.id) },
			});
		}
	}
	const waits = !yolo && waiting(plan).length > 0;
	return { header: [[[authorizationLine(plan, { yolo }), waits ? "warn" : "muted"], [waits ? "  Type /approve to snapshot the current move revisions." : "", "warn"]]], items };
}

/** What waits for the user: change moves and questions of taste. */
export function requestsView({ brainDir, yolo }) {
	const all = listRequests(brainDir, { yolo });
	if (all.length === 0) return { header: [], items: [note("  Nothing waits for you. The agent goes on with whatever does not depend on an answer.")] };
	const items = all.map((request) => {
		// The head row holds one line; the whole request stands in the body, and `e` opens the book where it lives.
		const home = request.kind === POLICY.enums.ledgerKind.question ? join(brainDir, "carto-ledger.json") : planPath(brainDir);
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
			target: { file: home, line: jsonLine(home, "id", request.id) },
		};
	});
	const approvals = all.some((request) => request.kind === "approval");
	return {
		header: [
			[[all.length === 1 ? "1 request waits for you" : `${all.length} requests wait for you`, "warn"]],
			[["  a approves it · n turns it down (the agent is told) · d forgets it without a word to the agent", "muted"]],
			[[approvals ? "  /approve ID ... · /deny ID [why] · /delete ID · /answer ID words" : "  /answer ID words · /deny ID [why] · /delete ID", "muted"]],
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
				size = bytes < POLICY.limits.format.kibibyte ? `${bytes} B` : bytes < POLICY.limits.format.mebibyte ? `${(bytes / POLICY.limits.format.kibibyte).toFixed(1)} KB` : `${(bytes / POLICY.limits.format.mebibyte).toFixed(1)} MB`;
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
	const all = session.windows?.list(POLICY.limits.screen.windowsListed) ?? [];
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
	header.push([], [["Frozen payload parts, in provider reading order. The raw provider JSON opens as its own row.", "faint"]]);

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
	if (typeof sent.payloadJson === "string") {
		items.push({
			key: "payload",
			head: [["■ ", "catSystem"], [short(estimate(sent.payloadJson)).padStart(5), "muted"], ["  Provider payload JSON", ""], [sent.payloadHash === undefined ? "  frozen body" : `  frozen · ${sent.payloadHash}`, "faint"]],
			body: sent.payloadJson,
			copy: sent.payloadJson,
		});
	}
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

/** Current `/context` accounting, deliberately not a historical request inspector or a preview. */
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

// ─── Current shared brain ───────────────────────────────────────────────────

/**
 * Carto's current shared-brain view: what the agent keeps with `shelf` and `book` context actions — the shelf and
 * reports — with the same operations offered to the user. These are live brain records, never children of a frozen
 * sent request. A report folds out of view or comes back (f), a file comes off the shelf (x), and a file is shelved
 * with a, which puts /shelve in the prompt. The typed commands /fold, /recall, /shelve, /unshelve and /collapse do
 * the same things from the prompt.
 * @param {{ root: string, brainDir: string }} env
 */
export function handsView({ root, brainDir }) {
	const store = loadContext(brainDir);
	const header = [
		[["Current shared brain", "bold"], ["  ·  live shelf and reports; not part of any sent provider request", "muted"]],
		[["Your hands on what the agent keeps", "muted"], ["  ·  salient notes live in the Ledger view", "muted"]],
	];
	const items = [];
	items.push(heading("  The shelf · snapshots are in view now, carried through collapse, and read by every task at its start"));
	if (store.shelf.length === 0) items.push(note("  Nothing is on the shelf. a shelves a file; the agent shelves with `shelf`."));
	for (const item of store.shelf) {
		items.push({
			key: `shelf:${shelfLabel(item)}`,
			kind: "shelf",
			head: [[`${shelfLabel(item)} · ${item.id}  `, ""], [`about ${short(estimate(shelfText(root, item, brainDir)))} rendered tokens`, "muted"]],
			body: () => shelfText(root, item, brainDir),
			...(item.path === undefined ? {} : { path: join(root, item.path) }),
		});
	}
	const standing = composedRows(store).filter((record) => record.archived !== true);
	const archived = composedRows(store).filter((record) => record.archived === true);
	items.push(heading("  The reports of finished work · f folds one out of view, v archives it out of the record, d deletes it (press d again)"));
	if (standing.length === 0 && archived.length === 0) items.push(note("  No work has been finished yet. When a task ends, its report is kept here, and its record line stands in the context."));
	for (const record of standing) {
		const folded = store.dropped.includes(record.id);
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
			body: () => loadReport(brainDir, record.id) ?? "(the report's file is gone)",
		});
	}
	if (archived.length > 0) {
		items.push(heading("  Archived · the record no longer lists them; recall by id still finds them"));
		for (const record of archived) {
			items.push({
				key: `report:${record.id}`,
				kind: "report",
				archived: true,
				head: [
					[`${record.id}  `, "muted"],
					["· archived  ", "muted"],
					[recordLine(record), "faint"],
				],
				body: () => loadReport(brainDir, record.id) ?? "(the report's file is gone)",
			});
		}
	}
	return { header, items };
}

/**
 * Where a tool of the context is defined: cartographer's own source, by its `name: "…"` line. `e` on a tool
 * part of the Model tab opens it there.
 * @returns {{ file: string, line: number } | undefined}
 */
export function toolSource(name) {
	const dir = fileURLToPath(new URL("../tools", import.meta.url));
	try {
		for (const entry of readdirSync(dir).sort()) {
			if (!entry.endsWith(".mjs")) continue;
			const file = join(dir, entry);
			const text = readFileSync(file, "utf8");
			const at = text.indexOf(`name: "${name}"`);
			if (at >= 0) return { file, line: text.slice(0, at).split("\n").length };
		}
	} catch {
		// The folder is not there, or cannot be read: no source to open.
	}
	return undefined;
}

/** The shell windows as a terminal emulator sees them: the newest lines of a window, the newest at the bottom. */
export function shellsOutView({ session }, name) {
	const all = (session.windows?.list(0) ?? []).filter((win) => win.state !== POLICY.enums.windowStates.gone);
	const pick = all.find((win) => win.name === name) ?? all.at(-1);
	if (pick === undefined) return { header: [], items: [note("  No shell window is open. A change task opens one when it runs a command.")] };
	const lines = (session.windows?.linesFrom(pick.name, 0, { partial: true }) ?? []).slice(-POLICY.limits.screen.shellViewLines);
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

/**
 * Where the built-in system prompt lives: source code reviewed and changed by the developer.
 * @returns {string | undefined}
 */
export function promptsSource() {
	const file = fileURLToPath(new URL("../prompt.mjs", import.meta.url));
	return existsSync(file) ? file : undefined;
}
