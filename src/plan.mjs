// The plan: the short list of work the agent means to do for the open goals.
//
// Each item is one piece of work a single task can do, marked `look` or `change`.
// Look items can run at any time. Change items can run only while the plan is
// authorized, and only the user authorizes, with /approve. That is the one gate in
// Cartographer; everything else about the plan is the agent's to arrange.
//
// The authorization covers the change items as they stood when it was given. When
// the agent adds a change item, rewords one, turns a look item into one, or gives
// one the network, the authorization is withdrawn and the user is asked again.
//
// A change item marked `network` lets its task's commands reach the network
// (src/sandbox.mjs); without the mark they cannot.
//
// The plan lives in <project>/.atlas/carto-plan.json as plain JSON. The user can
// read and edit it; it is read again every time it is needed.
import { POLICY } from "./config.mjs";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MODES = POLICY.enums.planModes;
const ITEM_ID = new RegExp(POLICY.patterns.planId);
/** One item is one line; the open items ride along with every request. */
export const ITEM_MAX = POLICY.limits.plan.itemChars;
export const ITEMS_MAX = POLICY.limits.plan.items;

export class PlanError extends Error {}

export const planPath = (brainDir) => join(brainDir, "carto-plan.json");
const empty = () => ({ version: 1, next: 1, items: [] });
const flat = (text) => String(text).replace(/\s+/g, " ").trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Read the plan. A file that cannot be understood is reported, never overwritten.
 * @returns {{ plan?: ReturnType<typeof empty> & { authorized?: string, lastCall?: string }, error?: string }}
 */
export function loadPlan(brainDir) {
	const path = planPath(brainDir);
	if (!existsSync(path)) return { plan: empty() };
	let raw;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { error: `${path} is not valid JSON (${error.message})` };
	}
	if (raw === null || typeof raw !== "object" || !Array.isArray(raw.items)) return { error: `${path} must hold an object with an "items" list` };
	const seen = new Set();
	const items = [];
	for (const [index, item] of raw.items.entries()) {
		const where = `${path}, item ${index + 1}`;
		if (item === null || typeof item !== "object") return { error: `${where} is not an object` };
		if (typeof item.id !== "string" || !ITEM_ID.test(item.id)) return { error: `${where} needs an "id" like "p3"` };
		if (seen.has(item.id)) return { error: `${where} repeats the id ${item.id}` };
		if (!MODES.includes(item.mode)) return { error: `${where} needs a "mode" that is one of ${MODES.join(", ")}` };
		if (typeof item.text !== "string" || item.text.trim() === "") return { error: `${where} needs a "text"` };
		seen.add(item.id);
		const kept = { ...item, text: flat(item.text), status: item.status === POLICY.enums.entryStatus.done ? POLICY.enums.entryStatus.done : POLICY.enums.entryStatus.open };
		// Only a change item runs commands, so only there does the mark mean anything.
		if (kept.network === true && kept.mode === POLICY.enums.planMode.change) kept.network = true;
		else delete kept.network;
		if (kept.standing === true && kept.mode === POLICY.enums.planMode.change) kept.standing = true;
		else delete kept.standing;
		items.push(kept);
	}
	// Ids are never reused, also when the counter in the file is missing or behind.
	const highest = items.reduce((max, item) => Math.max(max, Number(item.id.slice(POLICY.idPrefixes.plan.length))), 0);
	const next = Number.isInteger(raw.next) && raw.next > highest ? raw.next : highest + 1;
	const plan = { version: 1, next, items };
	if (typeof raw.authorized === "string" && raw.authorized !== "") plan.authorized = raw.authorized;
	if (typeof raw.lastCall === "string") plan.lastCall = raw.lastCall;
	return { plan };
}

export function savePlan(brainDir, plan) {
	const path = planPath(brainDir);
	writeFileSync(`${path}.tmp`, `${JSON.stringify(plan, null, 2)}\n`);
	renameSync(`${path}.tmp`, path);
}

export const openItems = (plan, mode) => plan.items.filter((item) => item.status === POLICY.enums.entryStatus.open && item.archived !== true && (mode === undefined || item.mode === mode));

/** Whether a change item may run now. */
export const isAuthorized = (plan) => plan.authorized !== undefined;

/** Whether the user's /approve is what the plan waits for. */
export const awaitsApproval = (plan) => !isAuthorized(plan) && openItems(plan, POLICY.enums.planMode.change).length > 0;
/** Whether any request waits on the plan: an open change item that neither the whole-plan approval nor its own covers. */
export const planWaits = (plan) => !isAuthorized(plan) && waiting(plan).length > 0;
/** Open items that are finished by being carried out once; a standing item is a duty and stays open. */
export const openOnce = (plan) => openItems(plan).filter((item) => item.standing !== true);
export const openStanding = (plan) => openItems(plan).filter((item) => item.standing === true);

function find(plan, id) {
	const item = plan.items.find((entry) => entry.id === id);
	if (item === undefined) {
		const ids = plan.items.map((entry) => entry.id).join(", ");
		throw new PlanError(`There is no item ${JSON.stringify(id)}. ${ids === "" ? "The plan is empty." : `The plan has ${ids}.`}`);
	}
	return item;
}

function checked(value) {
	if (typeof value !== "string" || value.trim() === "") throw new PlanError("`text` is required and was left out or empty: say in one line what this item covers.");
	const text = flat(value);
	if (text.length > ITEM_MAX) throw new PlanError(`\`text\` is ${text.length} characters; the limit is ${ITEM_MAX}. One line that says what the item covers is enough: the detail goes into the task's brief.`);
	return text;
}

/** One line for an item, as the agent and the user see it. */
export function itemLine(item) {
	const outcome = item.status === POLICY.enums.entryStatus.done && item.outcome ? ` → ${item.outcome}` : "";
	const undone = item.undone ? " (undone by the user: the files are as they were before this item ran)" : "";
	return `${item.id} [${item.mode}${item.network ? ", network" : ""}${item.standing ? ", standing" : ""}] ${item.text}${outcome}${undone}`;
}

const WITHDRAWN = "This changed what the plan may change, so the user's authorization no longer holds. Tell the user what changed and why, and ask them to type /approve.";

/**
 * Apply one operation to `plan` (changed in place).
 * @returns {{ line: string, shown: string, withdrawn?: boolean }} what the agent is told, what the user is shown,
 *   and whether the operation withdrew the user's authorization
 */
export function applyPlanOp(plan, op, now, { yolo = false } = {}) {
	const withdraw = () => {
		if (!isAuthorized(plan)) return false;
		// A whole-plan /approve covered every item it held. If the plan grows or changes, that cover ends for
		// all of them: each item becomes a request again. In the per-item case there is no cover to withdraw;
		// the other items keep their own approvals, and only the edited one waits again (below).
		delete plan.authorized;
		for (const item of plan.items) delete item.approved;
		// With approval switched off there is nothing to ask the user for.
		return !yolo;
	};
	const marks = (target, wanted) => {
		if (wanted.network === true && target !== POLICY.enums.planMode.change) throw new PlanError("`network` goes with a change item: only a change task runs commands.");
		if (wanted.standing === true && target !== POLICY.enums.planMode.change) throw new PlanError("`standing` goes with a change item: a look item needs no authorization and can be carried out as often as you like.");
	};
	switch (op?.action) {
		case POLICY.enums.actions.add: {
			if (!MODES.includes(op.mode)) throw new PlanError(`\`mode\` is ${JSON.stringify(op.mode)}; it is look (the task only reads) or change (the task writes files).`);
			const text = checked(op.text);
			if (plan.items.length >= ITEMS_MAX) throw new PlanError(`The plan has ${ITEMS_MAX} items, which is its limit. Remove finished ones, or clear the plan.`);
			marks(op.mode, op);
			const item = { id: `${POLICY.idPrefixes.plan}${plan.next}`, mode: op.mode, text, ...(op.network === true ? { network: true } : {}), ...(op.standing === true ? { standing: true } : {}), status: POLICY.enums.entryStatus.open, added: now };
			let at = plan.items.length;
			if (op.before !== undefined && op.before !== "") at = plan.items.indexOf(find(plan, op.before));
			plan.next++;
			plan.items.splice(at, 0, item);
			const withdrawn = op.mode === POLICY.enums.planMode.change && withdraw();
			return { line: `${item.id} added.${withdrawn ? ` ${WITHDRAWN}` : ""}`, shown: `+ ${itemLine(item)}`, withdrawn };
		}
		case POLICY.enums.actions.edit: {
			const item = find(plan, op.id);
			const hasText = op.text !== undefined && flat(op.text) !== "";
			const hasMode = op.mode !== undefined && op.mode !== "";
			const hasNetwork = typeof op.network === "boolean";
			const hasStanding = typeof op.standing === "boolean";
			if (!hasText && !hasMode && !hasNetwork && !hasStanding) throw new PlanError("An edit needs `text`, `mode`, `network` or `standing`.");
			if (hasMode && !MODES.includes(op.mode)) throw new PlanError(`\`mode\` is ${JSON.stringify(op.mode)}; it is look or change.`);
			marks(hasMode ? op.mode : item.mode, op);
			// Taking the network away, or ending a duty, asks for less than the user agreed to; everything else here asks for something new.
			const before = `${item.mode} ${item.text} ${item.network === true} ${item.standing === true}`;
			if (hasText) item.text = checked(op.text);
			if (hasMode) item.mode = op.mode;
			const hadNetwork = item.network === true;
			if (hasNetwork && op.network) item.network = true;
			if ((hasNetwork && !op.network) || item.mode !== POLICY.enums.planMode.change) delete item.network;
			const wasStanding = item.standing === true;
			if (hasStanding && op.standing) item.standing = true;
			if ((hasStanding && !op.standing) || item.mode !== POLICY.enums.planMode.change) delete item.standing;
			delete item.undone;
			// Rewording a change item, or making an item one, changes what the user agreed to.
			const after = `${item.mode} ${item.text} ${hadNetwork || item.network === true} ${wasStanding || item.standing === true}`;
			const changed = item.mode === POLICY.enums.planMode.change && item.status === POLICY.enums.entryStatus.open && before !== after;
			// Per item: rewording this one asks the user to approve this one again, and leaves its neighbours alone.
			const reasked = changed && item.approved !== undefined;
			if (reasked) delete item.approved;
			const withdrawn = changed && withdraw();
			return { line: `${item.id} changed.${withdrawn || reasked ? ` ${WITHDRAWN}` : ""}`, shown: `~ ${itemLine(item)}`, withdrawn: withdrawn || reasked };
		}
		case POLICY.enums.actions.done: {
			const item = find(plan, op.id);
			if (item.status === POLICY.enums.entryStatus.done) return { line: `${item.id} was already done.`, shown: `✓ ${itemLine(item)}` };
			item.status = POLICY.enums.entryStatus.done;
			item.closed = now;
			delete item.undone;
			if (op.text !== undefined && flat(op.text) !== "") item.outcome = checked(op.text);
			const left = openItems(plan).length;
			const follow = item.standing
				? " The standing duty has ended: no further task can be started for it."
				: left > 0
					? ` ${plural(left, "item")} still open.`
					: " Every item is done. Check each open goal against its done-when line and close the ones that are reached; then clear the plan.";
			return { line: `${item.id} done.${follow}`, shown: `✓ ${itemLine(item)}` };
		}
		case POLICY.enums.actions.remove: {
			const item = find(plan, op.id);
			plan.items.splice(plan.items.indexOf(item), 1);
			return { line: `${item.id} removed.`, shown: `- ${itemLine(item)}` };
		}
		case POLICY.enums.actions.clear: {
			const count = plan.items.length;
			plan.items = [];
			delete plan.authorized;
			return { line: "The plan is empty now.", shown: `cleared (${plural(count, "item")})` };
		}
		default:
			throw new PlanError(`Unknown action ${JSON.stringify(op?.action)}; the actions are add, edit, done, remove, clear.`);
	}
}

/** "3 items, 1 done · authorized" */
export function planSummary(plan) {
	if (plan.items.length === 0) return "no plan";
	const shown = plan.items.filter((item) => item.archived !== true);
	const done = shown.length - openItems(plan).length;
	const change = openItems(plan, POLICY.enums.planMode.change).length;
	const state = change === 0 ? "" : isAuthorized(plan) ? " · authorized" : ` · ${plural(change, "change item")} not authorized`;
	return `${plural(shown.length, "item")}${done > 0 ? `, ${done} done` : ""}${state}`;
}

/** What the user is told when approval is switched off. */
export const YOLO_LINE = "approval: OFF (yolo) · the agent's change items run without /approve, also ones that reach the network · /undo takes a step back, /stop stops the agent";

/** The first line of the plan as text: whether change items may run. */
export function authorizationLine(plan, { yolo = false } = {}) {
	if (yolo && openItems(plan, POLICY.enums.planMode.change).length > 0) return "The user has switched approval off: change items may run without /approve.";
	if (isAuthorized(plan)) return "Authorized by the user: change items may run.";
	if (openItems(plan, POLICY.enums.planMode.change).length > 0) return "Not approved: change items wait for the user. Look items may run.";
	return "No change item is open, so nothing needs authorizing.";
}

/**
 * The plan as text.
 * @param {{ done?: boolean, yolo?: boolean }} options  done: also list finished items in full (for the user);
 *   yolo: the user has switched approval off
 */
export function renderPlan(plan, options = {}) {
	if (plan.items.length === 0) return "There is no plan.";
	const lines = [authorizationLine(plan, options)];
	const shown = plan.items.filter((item) => item.archived !== true);
	const archived = plan.items.length - shown.length;
	const done = shown.filter((item) => item.status === POLICY.enums.entryStatus.done);
	for (const item of shown) {
		if (item.status === POLICY.enums.entryStatus.open) lines.push(`  ${itemLine(item)}`);
		else if (options.done) lines.push(`  ✓ ${itemLine(item)}`);
	}
	if (!options.done && done.length > 0) lines.push(`  (done: ${done.map((item) => item.id).join(", ")})`);
	if (archived > 0) lines.push(`  (${archived} archived ${archived === 1 ? "item" : "items"} not shown; /unarchive ID brings one back)`);
	return lines.join("\n");
}

/**
 * The user authorizes the plan as it stands (the original whole-plan /approve).
 * @returns {number} how many open change items it covers
 */
export function authorize(plan, now) {
	plan.authorized = now;
	for (const item of plan.items) delete item.undone;
	return openItems(plan, POLICY.enums.planMode.change).length;
}

// ─── Approval per item (the Requests system) ───────────────────────────────
// The agent no longer has to pack a plan to keep one authorization. Each change
// item is approved on its own and waits in the user's Requests until then. The
// old whole-plan authorization above still works: while it holds, no item waits.

/** Change items that wait for the user's approval: not covered by whole-plan authorization, not approved one by one. */
export function waiting(plan) {
	return openItems(plan, POLICY.enums.planMode.change).filter((item) => item.approved === undefined && plan.authorized === undefined);
}

/** Whether this change item may run now: approval switched off, whole-plan /approve, or its own approval. */
export function mayRun(plan, item, yolo = false) {
	if (yolo || isAuthorized(plan) || item.approved !== undefined) return true;
	// A standing duty approved once may be carried out again and again.
	return false;
}

/**
 * Approve change items one by one. `ids` names which ones; left out, all open
 * change items. Proposals and questions are not plan items and never appear here.
 * @returns {{ approved: string[], unknown: string[] }} ids approved, and ids that named no open change item
 */
export function approve(plan, now, ids) {
	const open = openItems(plan, POLICY.enums.planMode.change);
	const wanted = ids === undefined ? open.map((item) => item.id) : ids.filter((id) => typeof id === "string" && id !== "");
	const approved = [];
	const unknown = [];
	for (const id of wanted) {
		const item = open.find((entry) => entry.id === id);
		if (item === undefined) {
			unknown.push(id);
			continue;
		}
		item.approved = now;
		delete item.undone;
		approved.push(id);
	}
	return { approved, unknown };
}
