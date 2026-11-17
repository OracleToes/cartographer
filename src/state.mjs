// The state block: the current shared project/brain state appended to every request.
//
// It holds the time, project tree, atlas changes, open ledger entries, plan and authorization,
// and the next direction. It is built fresh for each request and appended only to that request;
// it is never stored as conversation history. A focused context also receives its one-line purpose
// and the forget-threshold reminder, so it sees the same current brain while retaining its own work window.
//
// Cost: the block sits at the very end of the prompt, so the server re-reads only the
// block itself (some hundreds of tokens, most of them the tree), not what comes before it.
//
// Every request receives a fresh block. A focused context gets the shared project/brain state
// plus its own purpose, the forget-threshold reminder, the lines about the context itself, and what
// waits for its user; its working conversation will be forgotten when it leaves view.
import { DEFAULTS, POLICY } from "./config.mjs";
import { loadAssessment, textHash } from "./assessment.mjs";
import { activeMoveOverlays, attentionSnapshot, fileMarks, linkedCount, loadAtlas, nodesForPath, renderAttention } from "./atlas.mjs";
import { loadLedger, open, renderLedger, salientNotes } from "./ledger.mjs";
import { awaitsApproval, loadPlan, movesOf, reportedMoves, runnableMoves, renderPlan } from "./plan.mjs";
import { loadContext, shelfFreshness, shelfLabel } from "./context.mjs";
import { caseStatusLine, listCases } from "./case.mjs";
import { requestLines } from "./requests.mjs";
import { eventLine } from "./wake.mjs";
import { ago, stamp, took } from "./time.mjs";
import { loadTop, sinceTop } from "./top.mjs";
import { treeSection } from "./tree.mjs";
import { isNote } from "./wake.mjs";
import { RECORD } from "./voice.mjs";
import { USER_NAME, USER_HEAD } from "./user.mjs";

/** The stable anchor every block written by me starts with; regexes are built from it so the marker cannot drift. */
const ANCHOR = RECORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const OPEN = POLICY.markup.state.open;
const CLOSE = POLICY.markup.state.close;
/** The block's first line. Together with the tag it tells a real block from a mention of the tags. */
const HEAD = `${RECORD} This is the current state; it supersedes any earlier copy I carry.`;

const names = (list, max = POLICY.limits.state.listedNames) => `${list.slice(0, max).join(", ")}${list.length > max ? `, and ${list.length - max} more` : ""}`;

const clip = (text, max = 180) => {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** A main-only facts projection. It deliberately describes state without selecting or delegating work. */
function dispatch(ledger, plan, brainDir, root, yolo = false) {
	const lines = ["Dispatch"];
	const goals = open(ledger, POLICY.enums.ledgerKind.goal).length;
	const salient = salientNotes(ledger);
	lines.push(`Goals: ${goals === 0 ? "none open" : `${goals} open`}.`);
	if (salient.length > 0) lines.push(`Salient notes: ${salient.map((note) => `${note.id} ${clip(note.text, 120)}`).join("; ")}.`);
	let shelf = [];
	let atlas;
	let attention;
	if (root !== undefined) {
		try { shelf = Array.isArray(loadContext(brainDir).shelf) ? loadContext(brainDir).shelf : []; } catch { shelf = []; }
		try {
			atlas = loadAtlas(brainDir).atlas;
			if (atlas !== undefined) attention = attentionSnapshot(root, atlas, { active: activeMoveOverlays(plan) });
		} catch { atlas = undefined; }
	}
	const shelfFacts = (path) => shelf.filter((item) => item.ref === undefined && item.path === path).map((item) => {
		const freshness = root === undefined ? "captured" : shelfFreshness(root, item, brainDir).state;
		return `${item.id} ${freshness === "current" ? "current" : `${freshness} snapshot`}`;
	});
	const atlasFacts = (path) => {
		if (atlas === undefined) return "atlas unavailable";
		const nodes = nodesForPath(atlas, path);
		const ids = new Set(nodes.map((node) => node.id));
		const states = [];
		if (attention?.focus?.target?.kind === "path" && attention.focus.target.path === path) states.push(`focus ${attention.focus.label}`);
		if (attention?.focus?.target?.kind === "node" && ids.has(attention.focus.target.id)) states.push(`focus ${attention.focus.label}`);
		if (attention?.hot?.some((entry) => ids.has(entry.node.id))) states.push("direct-hot");
		if (attention?.warm?.some((entry) => ids.has(entry.node.id))) states.push("nearby/warm");
		if (attention?.care?.some((entry) => ids.has(entry.node.id))) states.push("needs checking");
		if (attention?.gaps?.some((entry) => entry.path === path)) states.push("mapping gap");
		const mapped = nodes.length === 0 ? "unmapped" : `nodes ${nodes.map((node) => node.id).join(", ")}`;
		return `${mapped}${states.length > 0 ? `; ${states.join(", ")}` : ""}`;
	};
	if (plan === undefined) {
		lines.push("Plan: unreadable; no move can run until it is repaired.");
	} else if (plan.items.length === 0) {
		lines.push("Plan: no envelopes or moves.");
	} else {
		const reports = reportedMoves(plan);
		const blocked = plan.moves.filter((move) => move.status === POLICY.enums.moveStatus.blocked && move.archived !== true);
		const ready = runnableMoves(plan, { yolo });
		const waiting = awaitsApproval(plan) && !yolo;
		lines.push(`Moves: ${ready.length} ready${ready.length ? ` (${names(ready.map((move) => move.id))})` : ""}; ${reports.length} reported; ${blocked.length} blocked; ${waiting ? "approval waits" : "no approval wait"}.`);
		if (reports.length > 0) {
			lines.push("Review before acceptance:");
			for (const move of reports.slice(0, POLICY.limits.state.listedNames)) {
				const checkpoints = move.reported?.checkpoints;
				const gap = typeof move.reported?.closureGap === "string" && move.reported.closureGap.trim() !== "" ? `gap ${clip(move.reported.closureGap, 120)}` : "no recorded gap";
				lines.push(`  ${move.id}: report ${move.reported?.id ?? "missing"}; checkpoints ${checkpoints?.before && checkpoints?.after ? `${checkpoints.before} → ${checkpoints.after}` : "missing"}; proof ${move.reported?.proof ? "stated" : "missing"}; ${gap}; targets ${(move.targets ?? []).join(", ") || "none"}.`);
			}
		}
		if (blocked.length > 0) lines.push(`Blocked: ${blocked.map((move) => `${move.id}${typeof move.reported?.closureGap === "string" && move.reported.closureGap.trim() !== "" ? ` (closure gap: ${clip(move.reported.closureGap, 100)})` : ""}`).join(", ")}.`);
		const undeclared = plan.items.filter((item) => item.status === POLICY.enums.entryStatus.open && item.archived !== true && movesOf(plan, item.id).length === 0);
		if (undeclared.length > 0) lines.push(`Needs executable moves: ${names(undeclared.map((item) => item.id))}.`);
		if (ready.length > 0) {
			lines.push("Eligible move facts:");
			for (const move of ready.slice(0, POLICY.limits.state.listedNames)) {
				const approval = move.capabilities?.files === true || move.capabilities?.commands === true ? (move.approvedRevision === move.revision || yolo ? "approved/current" : "awaits approval") : "read-only";
				lines.push(`  ${move.id} revision ${move.revision} · ${approval}`);
					lines.push(`    Action: ${clip(move.action ?? move.text)}.`);
				lines.push(`    Closure facts — boundary: ${(move.targets ?? []).join(", ") || "none"}. Claim: ${clip(move.doneWhen).replace(/[.!?]+$/, "")}. Witness: ${clip(move.proof ?? "none").replace(/[.!?]+$/, "")}.`);
				lines.push(`    Capabilities: files ${move.capabilities?.files ? "yes" : "no"}; commands ${move.capabilities?.commands ? "yes" : "no"}; network ${move.capabilities?.network ? "yes" : "no"}.`);
				for (const path of move.targets ?? []) {
					const matched = shelfFacts(path);
					lines.push(`    ${path}: ${atlasFacts(path)}; shelf ${matched.length > 0 ? matched.join(", ") : "no matching placement"}.`);
				}
			}
		}
	}
	if (shelf.length > 0) {
		const entries = shelf.slice(0, POLICY.limits.state.listedNames).map((item) => {
			const freshness = root === undefined ? "captured" : shelfFreshness(root, item, brainDir).state;
			return `${item.id} ${shelfLabel(item)}${freshness === "current" ? "" : ` (${freshness} snapshot)`}`;
		});
		lines.push(`Main shelf: ${entries.join("; ")}${shelf.length > entries.length ? `; and ${shelf.length - entries.length} more` : ""}.`);
	} else lines.push("Main shelf: empty.");
	try {
		const cases = listCases(brainDir);
		const openCases = cases.filter((entry) => entry.error === undefined && (entry.status === "running" || entry.status === "ready" || entry.status === "needs-user-input"));
		const broken = cases.filter((entry) => entry.error !== undefined);
		if (openCases.length > 0) {
			lines.push(`Evidence cases: ${openCases.slice(0, POLICY.limits.state.listedNames).map(caseStatusLine).join("; ")}${openCases.length > POLICY.limits.state.listedNames ? `; and ${openCases.length - POLICY.limits.state.listedNames} more` : ""}.`);
			if (openCases.some((entry) => entry.status === "ready")) lines.push("A ready case is not concluded yet: I weigh its artifacts myself, then call `case` with synthesize and supported, refuted, unresolved, or needs_user_input.");
			if (openCases.some((entry) => entry.status === "needs-user-input")) lines.push("A case has an exact recorded blocking question and successor-capsule boundary; I ask that question rather than pretending the case settled itself.");
		}
		if (broken.length > 0) lines.push(`Evidence cases unreadable: ${broken.slice(0, POLICY.limits.state.listedNames).map((entry) => entry.id).join(", ")}.`);
	} catch {
		// A hand-edited case file must not prevent the ordinary state block from reaching the model.
	}
	lines.push("Before a focus, I decide whether one local outcome can close here: a current claim, a boundary that can realize it, and a reachable witness. If not, I read, map, or revise first. I choose selected shelf evidence and a narrowing boundary. This lens neither delegates work nor approves a move.");
	return lines.join("\n");
}

/** The current purpose and forget boundary for a focused context. */
function focusDirection(task) {
	const purpose = String(task?.purpose ?? task?.brief ?? "the assigned work").replace(/\s+/g, " ").trim();
	const item = task?.item === undefined ? "" : ` Envelope: ${task.item}.`;
	const move = task?.move === undefined ? "" : ` Move: ${task.move} revision ${task.revision}.`;
	const limits = task?.budget === undefined ? "" : ` Budget: ${task.budget.replies} replies, ${task.budget.fileOps} file operations, ${task.budget.commandStarts} command starts.`;
	const evidenceCase = typeof task?.caseId === "string" ? ` Evidence case: ${task.caseId}${typeof task.phase === "string" ? `, ${task.phase} phase` : ""}.` : "";
	return `Focus${item}${move}${limits}${evidenceCase}\nI am ${purpose}. I am the same mind in a focused, temporary working context, not a different worker. I keep useful findings in the shared atlas, ledger or report before returning; anything not kept may be forgotten when this context leaves view. The orchestrating context alone changes the plan and accepts a reported move.`;
}

/** Said only while approval is off, as the plain state of how this session runs. Here and not in the system prompt, because the user can change it while the session runs, and the present state is all the prompt needs to carry. */
function approval(yolo) {
	if (!yolo) return "";
	return `Approval\nDeclared change moves may run without /approve. This bypasses only the human decision: each focus still receives one move revision, its targets, capabilities and hard budget; checkpoints, scope review, reporting and explicit acceptance still apply. New moves do not inherit anything from earlier ones.\n\n`;
}

/**
 * The wake triggers the agent has set (src/wakes.mjs), one line each.
 * @param {string[]} [lines]
 * @param {any[]} [fired]  firings the agent is told of here and not by a note (see noteShown in src/wakes.mjs)
 */
function wakesText(lines = [], fired = []) {
	if (lines.length === 0 && fired.length === 0) return "";
	const set = lines.length === 0 ? "" : `${lines.map((line) => `  ${line}`).join("\n")}\nThese are mine: \`wake\` removes one. One that fires while I rest starts a turn for me; I call \`sleep\` when it needs nothing.\n`;
	const told = fired.length === 0 ? "" : `Fired during this turn, while I worked:\n${fired.map((event) => `  ${eventLine(event)}`).join("\n")}\n`;
	return `Wakes\n${set}${told}\n`;
}

/**
 * How commands run, when it is not the usual way (in the sandbox). Said here and not in the system prompt,
 * because the user can change it while the session runs.
 */
function commands(runner) {
	if (runner?.mode === "direct") {
		return `Commands\nCommands of a declared change move run directly on this machine, as ${USER_NAME}: they can read and change files outside the project directory, and they reach the network. Only the project directory is checkpointed; what a command changes outside it cannot be undone. Inside the project, Cartographer compares the final checkpoint diff with the move's declared targets and blocks a breach after the fact; direct mode does not confine shell writes to those paths. Inline commands remain read-only when bubblewrap works; when it does not, none run.\n\n`;
	}
	if (runner?.mode === "none") {
		return `Commands\nNo command can be run in this session: ${runner.available.why}. \`shell\` is refused. After a change, I tell ${USER_NAME} how to run or try what was written, and say plainly that it has not been run. Whether a done-when line that needs a run is met is for ${USER_NAME} to confirm.\n\n`;
	}
	return "";
}

/**
 * The time now, and how long ago the user last wrote. `messages` are the request's messages, each with its time.
 * A message that follows a tool result came while the agent was working, unless that result ended a turn; the run
 * then began with an earlier one.
 */
/**
 * Whether the tool results in front of `index` ended a turn: every call of that reply was one that ends it, a
 * `chat` or a `sleep` that went through, or a call Cartographer stopped for failing again and again.
 */
function endedTurn(messages, index) {
	let from = index;
	while (from > 0 && messages[from - 1].role === "toolResult") from--;
	const results = messages.slice(from, index);
	return results.length > 0 && results.every((result) => ((result.toolName === "chat" || result.toolName === "sleep") && result.isError !== true) || result.details?.loop !== undefined);
}

function clock(messages, now) {
	const said = `Now: ${stamp(now)}.`;
	if (!Array.isArray(messages)) return said;
	// A note Cartographer wrote to wake the agent (src/wake.mjs) is stored like a message of the user, and is not one.
	const theirs = (message) => message.role === "user" && Number.isFinite(message.timestamp) && !isNote(message);
	const at = messages.findLastIndex(theirs);
	if (at < 0) return said;
	let began = at;
	while (began > 0 && messages[began - 1].role === "toolResult" && !endedTurn(messages, began)) {
		const earlier = messages.slice(0, began).findLastIndex(theirs);
		if (earlier < 0) break;
		began = earlier;
	}
	const newest = `${USER_HEAD}'s newest message came ${ago(now - messages[at].timestamp)}.`;
	return began === at ? `${said} ${newest}` : `${said} ${newest} I have been working since their message of ${ago(now - messages[began].timestamp)}.`;
}

const short = (command, max = POLICY.limits.state.commandSummaryChars) => {
	const [line, ...more] = String(command ?? "").split("\n");
	return line.length > max ? `${line.slice(0, max)}…` : more.length > 0 ? `${line} …` : line;
};

const WINDOWS_OPEN = POLICY.markup.windows.open;
const WINDOWS_CLOSE = POLICY.markup.windows.close;
const WINDOWS_BLOCK = new RegExp(`\\n*${WINDOWS_OPEN}\\n${ANCHOR}[\\s\\S]*?\\n${WINDOWS_CLOSE}`, "g");
const STATE_BLOCK = new RegExp(`\\n*${OPEN}\\n${ANCHOR}[\\s\\S]*?\\n${CLOSE}`, "g");
/** The block's first line. Together with the tag it tells a real block from a mention of the tags. */
const WINDOWS_HEAD = `${RECORD} The shell windows as they are at this moment:`;
/** Lines of output shown for a window that is busy, unless the settings say otherwise; a free one shows FREE_TAIL. */
export const WINDOW_TAIL = DEFAULTS.windowTail;
const FREE_TAIL = POLICY.limits.state.freeWindowTail;

/**
 * The shell windows as they stand: what runs in each, for how long, and its newest lines. A block of its own at the
 * very end of every request, the main agent's and a task's: it is what changes most, and whoever started a command
 * should see how it is doing without asking. Like the state block it is added on the way out and never stored.
 * @param {ReturnType<ReturnType<typeof import("./windows.mjs").createWindows>["list"]> | undefined} windows
 * @param {{ tail?: number }} [show]  lines of output for a busy window
 * @returns {string} "" when there is no window to show
 */
export function windowsBlock(windows, { tail = WINDOW_TAIL } = {}) {
	if (!Array.isArray(windows) || windows.length === 0) return "";
	return [
		WINDOWS_OPEN,
		WINDOWS_HEAD,
		...windowLines(windows, { busy: tail, free: Math.min(tail, FREE_TAIL) }),
		"A window keeps running what was started in it until it is stopped or closed. I close the ones nobody needs any more.",
		WINDOWS_CLOSE,
	].join("\n");
}

/** Text with any windows block removed. */
export function withoutWindows(text) {
	return text.replace(WINDOWS_BLOCK, "");
}

const STATE_ONE = new RegExp(`\\n*${OPEN}\\n${ANCHOR}[\\s\\S]*?\\n${CLOSE}`);
const WINDOWS_ONE = new RegExp(`\\n*${WINDOWS_OPEN}\\n${ANCHOR}[\\s\\S]*?\\n${WINDOWS_CLOSE}`);

/**
 * Text with the state and windows blocks split off: what the message itself says, and each block as its own text.
 * For display (the Chat tab shows the blocks folded, apart from the message); `withoutState`/`withoutWindows` remain
 * the way to drop them without reading them.
 * @returns {{ text: string, state?: string, windows?: string }}
 */
export function splitState(text) {
	let body = String(text ?? "");
	let state;
	let windows;
	const s = STATE_ONE.exec(body);
	if (s !== null) {
		state = s[0].replace(/^\n+/, "");
		body = body.replace(s[0], "");
	}
	const w = WINDOWS_ONE.exec(body);
	if (w !== null) {
		windows = w[0].replace(/^\n+/, "");
		body = body.replace(w[0], "");
	}
	return { text: body.replace(/\n{3,}/g, "\n\n").trim(), state, windows };
}

/**
 * One line for each window, and under it the newest lines it printed.
 * @param {{ busy?: number, free?: number }} [tail]  how many printed lines to show for a window that is busy, and for one that is free
 */
export function windowLines(windows, tail = {}) {
	const lines = [];
	for (const win of windows) {
		const marks = `${win.readOnly ? " · read-only" : win.sandbox === false ? " · no sandbox" : win.network ? " · network" : ""}`;
		if (win.state === POLICY.enums.windowStates.gone) {
			lines.push(`  ${win.name} · gone: ${win.why}${win.command ? `, and \`${short(win.command)}\` ended with it` : ""}. \`window\` close clears this line.`);
			continue;
		}
		const place = win.cwd !== "." ? `, in ${win.cwd}/` : "";
		if (win.state === POLICY.enums.windowStates.busy) {
			const asks = win.asks ? ` · nothing printed for ${took(win.quiet)} and its last line has no line end: it may be waiting for input` : "";
			lines.push(`  ${win.name} · busy for ${took(win.running)} with \`${short(win.command)}\`${place}${marks}${asks}`);
			for (const line of win.tail.slice(-(tail.busy ?? WINDOW_TAIL))) lines.push(`    | ${line.length > POLICY.limits.state.outputLineChars ? `${line.slice(0, POLICY.limits.state.outputLineChars)}…` : line}`);
		} else {
			const last = win.last ? ` · last: \`${short(win.last.command)}\` ended with exit ${win.last.exit}, ${ago(win.last.ago)}` : " · nothing was run in it yet";
			lines.push(`  ${win.name} · free${place}${marks}${last}`);
			// The command line itself is already above; show what it printed last.
			for (const line of win.tail.filter((entry) => !entry.startsWith("$ ")).slice(-(tail.free ?? FREE_TAIL))) lines.push(`    | ${line.length > POLICY.limits.state.outputLineChars ? `${line.slice(0, POLICY.limits.state.outputLineChars)}…` : line}`);
		}
	}
	return lines;
}

/** The tree, and what the atlas holds that the copy at the top of the context does not. */
function atlasText(brainDir, root, config, now, task) {
	const { atlas, error } = loadAtlas(brainDir);
	const tree = treeSection(root, atlas?.view, { marks: atlas ? fileMarks(atlas) : undefined, depth: config?.treeDepth });
	const head = `Tree\n${tree.text}\n\nAtlas\n`;
	if (atlas === undefined) return `${head}The graph cannot be read: ${error}. It was probably edited by hand. Tell ${USER_NAME}; until they repair the file, nodes cannot be shown or written.\n\n`;
	const lines = [];
	const assessment = loadAssessment(brainDir);
	const linked = atlas.nodes.length === 0 ? "" : ` Files a node links to: ${linkedCount(atlas, tree.files)} of ${tree.files.length}.`;
	lines.push(
		`Graph: ${atlas.nodes.length === 0 ? "no nodes yet" : atlas.nodes.length === 1 ? "1 node" : `${atlas.nodes.length} nodes`}.${linked} Assessment: ${
			assessment.text === "" ? "none yet. I write one with `book` (target=assessment, action=write, text) once I know what the project is and how it is built." : `written ${ago(now - (assessment.written ?? now))}.`
		}`,
	);
	const since = sinceTop(brainDir, atlas, assessment.text);
	const changed = [];
	if (since.written.length > 0) changed.push(`Nodes written since the copy at the top of my context: ${names(since.written)} (\`book\` target=atlas, action=look shows one).`);
	if (since.removed.length > 0) changed.push(`Removed since: ${names(since.removed)}.`);
	if (changed.length > 0) lines.push(changed.join(" "));
	if (since.assessment && assessment.text !== "") {
		// The agent's own rewrite is in its context as the call that made it. An edit by hand is not, so it is shown.
		if (loadTop(brainDir)?.assessed === textHash(assessment.text)) lines.push("I rewrote the assessment since that copy: my `book` call holds the text that counts.");
		else lines.push(`The assessment was edited outside this conversation since that copy, probably by ${USER_NAME}. It now reads:\n${assessment.text}`);
	}
	const { plan } = loadPlan(brainDir);
	const active = activeMoveOverlays(plan);
	const local = renderAttention(attentionSnapshot(root, atlas, { active, now }), { idle: active.length === 0 && task === undefined });
	if (local !== "") lines.push(local);
	return `${head}${lines.join("\n")}\n\n`;
}

/**
 * @param {string} brainDir
 * @param {{ mode: "sandbox" | "direct" | "none", available?: { why?: string } }} [runner]  how commands run now (src/sandbox.mjs)
 * @param {{ root?: string, config?: { treeDepth?: number }, messages?: readonly any[], now?: number, wakes?: string[], yolo?: boolean, requests?: boolean, context?: string }} [more]
 *   wakes: my wake triggers, one line each; yolo: approval is off in this session (carried as plain state, not as an exception)
 *   context: the lines about the context itself, ready made; requests: whether to list what waits for the user
 *     (the live agents list it, the main agent's block and a task's alike; a plain read of the state, as /context and the tests do, does not)
 *   root: the project, for the tree and the atlas (left out, the block has neither); messages: the request's messages;
 * @returns {string} the block, tags included
 */
export function stateBlock(brainDir, runner, more = {}) {
	const now = more.now ?? Date.now();
	const { ledger, error } = loadLedger(brainDir);
	const { plan, error: planError } = loadPlan(brainDir);
	// The main state is a broad live dispatch view. A focus instead gets its local capsule plus compact operational
	// facts; it must not replay the parent atlas/tree/plan environment.
	const front = more.task === undefined ? `${clock(more.messages, now)}\n\n${more.root === undefined ? "" : atlasText(brainDir, more.root, more.config, now, more.task)}` : "";
	let body;
	if (more.task !== undefined) {
		body = `${commands(runner)}${focusDirection(more.task)}`;
	} else if (ledger === undefined) {
		body = `The ledger cannot be read: ${error}. It was probably edited by hand. Tell ${USER_NAME}; until they repair the file, the ledger cannot be shown or changed.`;
		} else {
			// No plan, no section: the instruction below says when to write one.
			let planText = "";
			if (plan === undefined) planText = `Plan\nThe plan cannot be read: ${planError}. It was probably edited by hand. Tell ${USER_NAME}; until they repair the file, no plan move can run.\n\n`;
			else if (plan.items.length > 0) planText = `Plan\n${renderPlan(plan, { yolo: more.yolo === true })}\n\n`;
			// What waits for the user: approvals of change moves, questions of taste, and proposed edits to the
			// prompt. Put at the very end, so the shape of the block before it stays as it was. The agent keeps
			// working on whatever does not depend on one.
			const waiting = more.requests === true ? requestLines(brainDir, { yolo: more.yolo === true }) : "";
			const requests = waiting === "" ? "" : `\n\nRequests\nThese wait for ${USER_NAME}; carry on with what does not depend on them:\n${waiting}\n`;
			body = `Ledger\n${renderLedger(ledger, { now })}\n\n${planText}${approval(more.yolo === true)}${commands(runner)}${wakesText(more.wakes, more.fired)}${dispatch(ledger, plan, brainDir, more.root, more.yolo === true)}${requests}`;
		}
	// How full the context is and what on the shelf is not as shown (src/context.mjs).
	return `${OPEN}\n${HEAD}\n\n${front}${more.context ?? ""}${body}\n${CLOSE}`;
}

/** Text with any state block removed (for display, and for the tests' stand-in). */
export function withoutState(text) {
	return text.replace(STATE_BLOCK, "");
}

/**
 * The messages of one request with the block added to the last one, when that is a user message or a tool result.
 * The input is not changed.
 * @param {readonly any[]} messages
 * @param {string} block
 */
export function withState(messages, block) {
	const last = messages.at(-1);
	if (last === undefined || (last.role !== "user" && last.role !== "toolResult")) return messages;
	const addition = `\n\n${block}`;
	let content;
	if (typeof last.content === "string") content = last.content + addition;
	else {
		// Joined to the last piece of text, so the block follows the message's own words after one empty line.
		const tail = last.content.at(-1);
		content = tail?.type === "text" ? [...last.content.slice(0, -1), { ...tail, text: tail.text + addition }] : [...last.content, { type: "text", text: block }];
	}
	return [...messages.slice(0, -1), { ...last, content }];
}
