// The state block: what the main agent is shown at the end of every request.
//
// It holds the things that must always be current: the time, the tree of the project's
// files, what was written to the atlas since the copy at the top of the context was
// made, the open ledger entries, the plan with whether the user has authorized it, and
// what the agent should be doing next. It is built fresh for each request and added
// to the last message of that request only; it is never stored in the conversation.
// So the agent sees exactly one copy, the newest, whatever happened to the
// conversation in between (a fresh context, a compaction, an edit by hand).
//
// Cost: the block sits at the very end of the prompt, so the server re-reads only the
// block itself (some hundreds of tokens, most of them the tree), not what comes before it.
//
// A task does not get the block. Its prompt is the main agent's stored conversation
// plus the brief.
import { loadAssessment, textHash } from "./assessment.mjs";
import { fileMarks, linkedCount, loadAtlas, staleNodes } from "./atlas.mjs";
import { loadLedger, open, renderLedger } from "./ledger.mjs";
import { awaitsApproval, loadPlan, openItems, openOnce, openStanding, renderPlan } from "./plan.mjs";
import { requestLines } from "./requests.mjs";
import { eventLine } from "./wake.mjs";
import { ago, stamp, took } from "./time.mjs";
import { loadTop, sinceTop } from "./top.mjs";
import { treeSection } from "./tree.mjs";
import { isNote } from "./wake.mjs";

const OPEN = "<state>";
const CLOSE = "</state>";
/** The block's first line. Together with the tag it tells a real block from a mention of the tags. */
const HEAD = "Written by Cartographer, not by the user. This is the current state; it replaces any state you saw before.";

const FIRST = "Answer the user's newest message first.";
/** What the agent may do when nothing else is asked of it. It decides what deserves a node, and when to stop. */
const MAP =
	"You need not sit idle meanwhile: in the same reply you may start a look task that maps a part of the project the graph says nothing about, and has what it finds recorded as nodes. What deserves a node, and when the graph is good enough to stop and wait, is yours to decide.";
const names = (list, max = 12) => `${list.slice(0, max).join(", ")}${list.length > max ? `, and ${list.length - max} more` : ""}`;

/** What the block says the agent should do next. One situation, one instruction. `yolo`: approval is switched off. */
function direction(ledger, plan, yolo = false) {
	const goals = open(ledger, "goal").length > 0;
	if (plan === undefined || plan.items.length === 0) {
		if (goals) {
			return `${FIRST} Beyond that, work toward the open goals. If reaching one needs changes to the project, find out what you need with look tasks, then write the plan. When a goal is reached, close it and tell the user what was achieved.`;
		}
		return [
			"No goal is set. Looking and answering questions is fine without one.",
			"Find out what the user wants to achieve. When you and the user agree on it, record it as a goal with a done-when line.",
			MAP,
		].join(" ");
	}
	// A plan stands for a goal. One without is possible (the user closed the goal, or wrote the plan by hand).
	const noGoal = goals ? "" : " No goal is recorded for this plan: agree one with the user and record it with a done-when line.";
	// A standing item is a duty: it is never "next", and it does not keep the plan from being finished otherwise.
	const duties = openStanding(plan);
	const standing =
		duties.length === 0
			? ""
			: ` ${duties.length === 1 ? `${duties[0].id} is a standing duty` : `${names(duties.map((item) => item.id))} are standing duties`}: start a task for ${duties.length === 1 ? "it" : "one"} whenever its text calls for it, as often as that is, and do not mark it done while the duty lasts. A wake set with \`wake\` brings you back to check on it.`;
	const next = openOnce(plan)[0];
	const waits = awaitsApproval(plan) && !yolo;
	if (next === undefined && duties.length > 0) {
		if (waits) return `${FIRST} Change items wait for the user: show them the plan in a few lines and ask them to type /approve. Do not start ${duties[0].id} before that.${noGoal} ${MAP}`;
		return `${FIRST} Beyond that, nothing of the plan is left to do once.${standing}${noGoal}`;
	}
	if (next === undefined) {
		const check = goals ? " Check each open goal against its done-when line. Before you close one, bring the assessment up to date with `book`'s books if the work changed your picture of the project: the copy at the top of your context is rewritten when a goal closes. Close the goals that are reached, tell the user what was achieved and how to try it, and clear the plan." : " Tell the user what was done and how to try it, and clear the plan.";
		return `${FIRST} Every item of the plan is done.${check} If something is still missing, add items for it.`;
	}
	if (waits) {
		const wait = "Change items wait for the user: show them the plan in a few lines and ask them to type /approve.";
		if (next.mode === "look") return `${FIRST} Beyond that, carry out ${next.id} with \`task\`: look items need no authorization. ${wait}${noGoal}`;
		return `${FIRST} ${wait} Do not start ${next.id} before that.${noGoal} ${MAP}`;
	}
	return `${FIRST} Beyond that, carry out the plan: ${next.id} is next. Call \`task\` with its id and a brief, and mark it done when the report and the record of changed files show that it is.${standing}${noGoal}`;
}

/** Said while the user has switched approval off. Here and not in the system prompt, because the user can change it while the session runs. */
function approval(yolo) {
	if (!yolo) return "";
	return "Approval\nThe user has switched approval off and is watching what you do. A change item may run without /approve, also one marked network or standing: do not ask for /approve. Every change still needs a plan item: write the item, then start its task. Keep items small, so that the user can follow each step and take one back with /undo.\n\n";
}

/**
 * The wake triggers the agent has set (src/wakes.mjs), one line each.
 * @param {string[]} [lines]
 * @param {any[]} [fired]  firings the agent is told of here and not by a note (see noteShown in src/wakes.mjs)
 */
function wakesText(lines = [], fired = []) {
	if (lines.length === 0 && fired.length === 0) return "";
	const set = lines.length === 0 ? "" : `${lines.map((line) => `  ${line}`).join("\n")}\nThese are yours: \`wake\` removes one. One that fires while you rest starts a turn for you; call \`sleep\` when it needs nothing.\n`;
	const told = fired.length === 0 ? "" : `Fired during this turn, while you worked:\n${fired.map((event) => `  ${eventLine(event)}`).join("\n")}\n`;
	return `Wakes\n${set}${told}\n`;
}

/**
 * How commands run, when it is not the usual way (in the sandbox). Said here and not in the system prompt,
 * because the user can change it while the session runs.
 */
function commands(runner) {
	if (runner?.mode === "direct") {
		return "Commands\nThe user has switched the sandbox off. A change task's commands now run directly on this machine, as the user: they can read and change files outside the project directory, and they reach the network. Only the project directory is in Cartographer's checkpoints, so what a command does outside it cannot be undone. Keep the work inside the project directory unless the user asks for something outside it, and then name the path in the brief.\n\n";
	}
	if (runner?.mode === "none") {
		return `Commands\nNo command can be run in this session: ${runner.available.why}. \`shell\` is refused. After a change, tell the user how to run or try what was written, and say plainly that it has not been run. Whether a done-when line that needs a run is met is for the user to confirm.\n\n`;
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
	const newest = `The user's newest message came ${ago(now - messages[at].timestamp)}.`;
	return began === at ? `${said} ${newest}` : `${said} ${newest} You have been working since their message of ${ago(now - messages[began].timestamp)}.`;
}

const short = (command, max = 80) => {
	const [line, ...more] = String(command ?? "").split("\n");
	return line.length > max ? `${line.slice(0, max)}…` : more.length > 0 ? `${line} …` : line;
};

const WINDOWS_OPEN = "<windows>";
const WINDOWS_CLOSE = "</windows>";
/** The block's first line. Together with the tag it tells a real block from a mention of the tags. */
const WINDOWS_HEAD = "Written by Cartographer, not by the user. The shell windows as they are at this moment:";
/** Lines of output shown for a window that is busy, unless the settings say otherwise; a free one shows FREE_TAIL. */
export const WINDOW_TAIL = 10;
const FREE_TAIL = 3;

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
		"A window keeps running what was started in it until it is stopped or closed. Close the ones nobody needs any more.",
		WINDOWS_CLOSE,
	].join("\n");
}

/** Text with any windows block removed. */
export function withoutWindows(text) {
	return text.replace(/\n*<windows>\nWritten by Cartographer[\s\S]*?\n<\/windows>/g, "");
}

/**
 * One line for each window, and under it the newest lines it printed.
 * @param {{ busy?: number, free?: number }} [tail]  how many printed lines to show for a window that is busy, and for one that is free
 */
export function windowLines(windows, tail = {}) {
	const lines = [];
	for (const win of windows) {
		const marks = `${win.sandbox === false ? " · no sandbox" : win.network ? " · network" : ""}`;
		if (win.state === "gone") {
			lines.push(`  ${win.name} · gone: ${win.why}${win.command ? `, and \`${short(win.command)}\` ended with it` : ""}. \`window\` close clears this line.`);
			continue;
		}
		const place = win.cwd !== "." ? `, in ${win.cwd}/` : "";
		if (win.state === "busy") {
			const asks = win.asks ? ` · nothing printed for ${took(win.quiet)} and its last line has no line end: it may be waiting for input` : "";
			lines.push(`  ${win.name} · busy for ${took(win.running)} with \`${short(win.command)}\`${place}${marks}${asks}`);
			for (const line of win.tail.slice(-(tail.busy ?? WINDOW_TAIL))) lines.push(`    | ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`);
		} else {
			const last = win.last ? ` · last: \`${short(win.last.command)}\` ended with exit ${win.last.exit}, ${ago(win.last.ago)}` : " · nothing was run in it yet";
			lines.push(`  ${win.name} · free${place}${marks}${last}`);
			// The command line itself is already above; show what it printed last.
			for (const line of win.tail.filter((entry) => !entry.startsWith("$ ")).slice(-(tail.free ?? FREE_TAIL))) lines.push(`    | ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`);
		}
	}
	return lines;
}

/** The tree, and what the atlas holds that the copy at the top of the context does not. */
function atlasText(brainDir, root, config, now) {
	const { atlas, error } = loadAtlas(brainDir);
	const tree = treeSection(root, atlas?.view, { marks: atlas ? fileMarks(atlas) : undefined, depth: config?.treeDepth });
	const head = `Tree\n${tree.text}\n\nAtlas\n`;
	if (atlas === undefined) return `${head}The graph cannot be read: ${error}. It was probably edited by hand. Tell the user; until they repair the file, nodes cannot be shown or written.\n\n`;
	const lines = [];
	const assessment = loadAssessment(brainDir);
	const linked = atlas.nodes.length === 0 ? "" : ` Files a node links to: ${linkedCount(atlas, tree.files)} of ${tree.files.length}.`;
	lines.push(
		`Graph: ${atlas.nodes.length === 0 ? "no nodes yet" : atlas.nodes.length === 1 ? "1 node" : `${atlas.nodes.length} nodes`}.${linked} Assessment: ${
			assessment.text === "" ? "none yet. Write one with `book`'s books once you know what the project is and how it is built." : `written ${ago(now - (assessment.written ?? now))}.`
		}`,
	);
	const since = sinceTop(brainDir, atlas, assessment.text);
	const changed = [];
	if (since.written.length > 0) changed.push(`Nodes written since the copy at the top of your context: ${names(since.written)} (\`atlas\` look shows one).`);
	if (since.removed.length > 0) changed.push(`Removed since: ${names(since.removed)}.`);
	if (changed.length > 0) lines.push(changed.join(" "));
	if (since.assessment && assessment.text !== "") {
		// The agent's own rewrite is in its context as the call that made it. An edit by hand is not, so it is shown.
		if (loadTop(brainDir)?.assessed === textHash(assessment.text)) lines.push("You rewrote the assessment since that copy: your `book` call holds the text that counts.");
		else lines.push(`The assessment was edited outside this conversation since that copy, probably by the user. It now reads:\n${assessment.text}`);
	}
	const stale = staleNodes(root, atlas, now);
	if (stale.length > 0) {
		lines.push(`May be out of date: ${stale.slice(0, 12).map((node) => `${node.name} (${node.why.join(", ")})`).join("; ")}${stale.length > 12 ? `; and ${stale.length - 12} more` : ""}. Have a task check each against its files, then rewrite the node, or confirm it when it still holds.`);
	}
	return `${head}${lines.join("\n")}\n\n`;
}

/**
 * @param {string} brainDir
 * @param {{ mode: "sandbox" | "direct" | "none", available?: { why?: string } }} [runner]  how commands run now (src/sandbox.mjs)
 * @param {{ root?: string, config?: { treeDepth?: number }, messages?: readonly any[], now?: number, wakes?: string[], yolo?: boolean, requests?: boolean, context?: string }} [more]
 *   wakes: the agent's wake triggers, one line each; yolo: the user has switched approval off
 *   context: the lines about the context itself, ready made; requests: whether to list what waits for the user
 *     (only the live agent's block lists it; a plain read of the state, as /context and the tests do, does not)
 *   root: the project, for the tree and the atlas (left out, the block has neither); messages: the request's messages;
 * @returns {string} the block, tags included
 */
export function stateBlock(brainDir, runner, more = {}) {
	const now = more.now ?? Date.now();
	const { ledger, error } = loadLedger(brainDir);
	const { plan, error: planError } = loadPlan(brainDir);
	const front = `${clock(more.messages, now)}\n\n${more.root === undefined ? "" : atlasText(brainDir, more.root, more.config, now)}`;
	let body;
	if (ledger === undefined) {
		body = `The ledger cannot be read: ${error}. It was probably edited by hand. Tell the user; until they repair the file, the ledger cannot be shown or changed.`;
		} else {
			// No plan, no section: the instruction below says when to write one.
			let planText = "";
			if (plan === undefined) planText = `Plan\nThe plan cannot be read: ${planError}. It was probably edited by hand. Tell the user; until they repair the file, no plan item can run.\n\n`;
			else if (plan.items.length > 0) planText = `Plan\n${renderPlan(plan, { yolo: more.yolo === true })}\n\n`;
			// What waits for the user: approvals of change items, questions of taste, and proposed edits to the
			// prompt. Put at the very end, so the shape of the block before it stays as it was. The agent keeps
			// working on whatever does not depend on one.
			const waiting = more.requests === true ? requestLines(brainDir, { yolo: more.yolo === true }) : "";
			const requests = waiting === "" ? "" : `\n\nRequests\nThese wait for the user; carry on with what does not depend on them:\n${waiting}\n`;
			body = `Ledger\n${renderLedger(ledger, { now })}\n\n${planText}${approval(more.yolo === true)}${commands(runner)}${wakesText(more.wakes, more.fired)}${direction(ledger, plan, more.yolo === true)}${requests}`;
		}
	// How full the context is and what on the shelf is not as shown (src/context.mjs).
	return `${OPEN}\n${HEAD}\n\n${front}${more.context ?? ""}${body}\n${CLOSE}`;
}

/** Text with any state block removed (for display, and for the tests' stand-in). */
export function withoutState(text) {
	return text.replace(/\n*<state>\nWritten by Cartographer[\s\S]*?\n<\/state>/g, "");
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
