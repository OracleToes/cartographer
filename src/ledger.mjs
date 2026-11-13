// The ledger: what the agent keeps about a project across sessions.
//
//   goal      something the user wants achieved, with a "done when" line
//   question  something to ask the user
//   note      anything else worth keeping: a decision, a preference, a finding
//
// It is a notebook, not a gate: nothing here stops the agent from working. It lives
// in <project>/.atlas/carto-ledger.json as plain JSON so the user can read and edit it;
// the file is read again every time it is needed, so an edit made by hand takes
// effect at the agent's next step.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ago, since } from "./time.mjs";

export const KINDS = ["goal", "question", "note"];
const PREFIX = { goal: "g", question: "q", note: "n" };
/** One entry is one line of thought; the open entries ride along with every request, so they stay short. */
export const TEXT_MAX = 400;
export const OPEN_MAX = 40;
/** Closed entries kept; beyond this the oldest are dropped. Open entries are never dropped. */
export const DONE_KEPT = 50;

export class LedgerError extends Error {}

const ledgerPath = (brainDir) => join(brainDir, "carto-ledger.json");
const empty = () => ({ version: 1, next: 1, items: [] });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const flat = (text) => String(text).replace(/\s+/g, " ").trim();

/**
 * Before the file had its own name, Cartographer kept its ledger in `ledger.json`, a name the Orchestrator
 * extension also uses. Take over such a file when it is Cartographer's: an "items" list, where the extension
 * keeps a record. Anything else stays where it is.
 * @returns {boolean} whether a file was taken over
 */
export function adoptOldLedger(brainDir) {
	const old = join(brainDir, "ledger.json");
	if (existsSync(ledgerPath(brainDir)) || !existsSync(old)) return false;
	try {
		const raw = JSON.parse(readFileSync(old, "utf8"));
		if (raw === null || typeof raw !== "object" || !Array.isArray(raw.items)) return false;
	} catch {
		return false;
	}
	renameSync(old, ledgerPath(brainDir));
	return true;
}

/**
 * Read the ledger. A file that cannot be understood is reported, never overwritten: `error` says what is wrong
 * and `ledger` is then undefined.
 * @returns {{ ledger?: ReturnType<typeof empty>, error?: string }}
 */
export function loadLedger(brainDir) {
	const path = ledgerPath(brainDir);
	if (!existsSync(path)) return { ledger: empty() };
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
		const where = `${path}, entry ${index + 1}`;
		if (item === null || typeof item !== "object") return { error: `${where} is not an object` };
		if (!KINDS.includes(item.kind)) return { error: `${where}: "kind" must be one of ${KINDS.join(", ")}` };
		if (typeof item.id !== "string" || !/^[gqn]\d+$/.test(item.id)) return { error: `${where}: "id" must look like g1, q2 or n3` };
		if (seen.has(item.id)) return { error: `${where}: the id ${item.id} is used twice` };
		if (typeof item.text !== "string" || item.text.trim() === "") return { error: `${where} (${item.id}): "text" is missing` };
		seen.add(item.id);
		items.push({ ...item, status: item.status === "done" ? "done" : "open" });
	}
	// Ids are never reused, also after entries were removed or added by hand.
	const highest = Math.max(0, ...items.map((item) => Number(item.id.slice(1))));
	return { ledger: { ...raw, version: 1, next: Math.max(Number.isInteger(raw.next) ? raw.next : 1, highest + 1), items } };
}

/** Write the ledger so that a reader never sees half a file. */
export function saveLedger(brainDir, ledger) {
	const path = ledgerPath(brainDir);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(ledger, null, "\t")}\n`);
	renameSync(temp, path);
}

export const open = (ledger, kind) => ledger.items.filter((item) => item.status === "open" && item.archived !== true && (kind === undefined || item.kind === kind));

function find(ledger, id) {
	const wanted = flat(id ?? "");
	const item = ledger.items.find((entry) => entry.id === wanted);
	if (item === undefined) {
		const ids = open(ledger).map((entry) => entry.id);
		throw new LedgerError(`There is no entry ${wanted || "(no id given)"}. Open entries: ${ids.length > 0 ? ids.join(", ") : "none"}.`);
	}
	return item;
}

function checked(value, what) {
	if (typeof value !== "string" || value.trim() === "") throw new LedgerError(`${what} is required and was left out or empty.`);
	const text = flat(value);
	if (text.length > TEXT_MAX) throw new LedgerError(`${what} is ${text.length} characters; the limit is ${TEXT_MAX}. Say it in one line, or split it into two entries.`);
	return text;
}

/** An entry's age is said once it is an hour old: before that it tells the agent nothing. */
const AGE_FROM = 3_600_000;

/**
 * One line for an entry, as the agent and the user see it.
 * @param {number} [now]  given, an open entry that is an hour old or more says how old it is
 */
export function entryLine(item, now) {
	const doneWhen = item.kind === "goal" && item.doneWhen ? ` (done when: ${item.doneWhen})` : "";
	const outcome = item.status === "done" && item.outcome ? ` → ${item.outcome}` : "";
	const age = now === undefined || item.status === "done" ? undefined : since(item.added, now);
	return `${item.id}  ${item.text}${doneWhen}${outcome}${age !== undefined && age >= AGE_FROM ? ` · added ${ago(age)}` : ""}`;
}

/**
 * Apply one operation to `ledger` (changed in place).
 * @returns {{ line: string, shown: string }} what the agent is told, and what the user is shown
 */
export function applyOp(ledger, op, now) {
	switch (op?.action) {
		case "add": {
			if (!KINDS.includes(op.kind)) throw new LedgerError(`\`kind\` is ${JSON.stringify(op.kind)}; it is one of ${KINDS.join(", ")}.`);
			const text = checked(op.text, "`text` (the entry itself, one line in your words)");
			const item = { id: `${PREFIX[op.kind]}${ledger.next}`, kind: op.kind, text };
			if (op.kind === "goal") {
				item.doneWhen = checked(op.done_when, "`done_when` (how you and the user will know the goal is reached)");
			}
			Object.assign(item, { status: "open", added: now });
			if (open(ledger).length >= OPEN_MAX) {
				throw new LedgerError(`The ledger has ${OPEN_MAX} open entries, which is its limit. Close or remove some before adding more.`);
			}
			ledger.next++;
			ledger.items.push(item);
			return { line: `${item.id} added.`, shown: `+ ${op.kind} ${entryLine(item)}` };
		}
		case "done": {
			const item = find(ledger, op.id);
			if (item.status === "done") return { line: `${item.id} was already closed.`, shown: `✓ ${item.kind} ${entryLine(item)}` };
			item.status = "done";
			item.closed = now;
			if (op.text !== undefined && flat(op.text) !== "") item.outcome = checked(op.text, "`text` (how it ended)");
			const follow =
				item.kind === "goal"
					? " Tell the user what was achieved against its done-when line, and ask whether that is what they wanted."
					: "";
			return { line: `${item.id} closed.${follow}`, shown: `✓ ${item.kind} ${entryLine(item)}` };
		}
		case "edit": {
			const item = find(ledger, op.id);
			const hasText = op.text !== undefined && flat(op.text) !== "";
			const hasDoneWhen = op.done_when !== undefined && flat(op.done_when) !== "";
			if (!hasText && !hasDoneWhen) throw new LedgerError("An edit needs `text`, `done_when`, or both: the new wording.");
			if (hasDoneWhen && item.kind !== "goal") throw new LedgerError(`${item.id} is a ${item.kind}; only a goal has a done-when line.`);
			if (hasText) item.text = checked(op.text, "`text`");
			if (hasDoneWhen) item.doneWhen = checked(op.done_when, "`done_when`");
			return { line: `${item.id} reworded.`, shown: `~ ${item.kind} ${entryLine(item)}` };
		}
		case "remove": {
			const item = find(ledger, op.id);
			ledger.items.splice(ledger.items.indexOf(item), 1);
			return { line: `${item.id} removed.`, shown: `- ${item.kind} ${entryLine(item)}` };
		}
		default:
			throw new LedgerError(`Unknown action ${JSON.stringify(op?.action)}; the actions are add, done, edit, remove.`);
	}
}

/** Drop the oldest closed entries beyond the number kept. */
export function prune(ledger) {
	const closed = ledger.items.filter((item) => item.status === "done");
	if (closed.length <= DONE_KEPT) return;
	const drop = new Set(closed.slice(0, closed.length - DONE_KEPT));
	ledger.items = ledger.items.filter((item) => !drop.has(item));
}

/** "1 goal, 2 questions, no notes" */
export function openCounts(ledger) {
	return KINDS.map((kind) => {
		const n = open(ledger, kind).length;
		return n === 0 ? `no ${kind}s` : plural(n, kind);
	}).join(", ");
}

const HEADINGS = { goal: "Goals", question: "Questions for the user", note: "Notes" };

/**
 * The open entries as text, grouped by kind.
 * @param {{ closed?: boolean, now?: number }} options  closed: also list the closed entries (for the user); now: say how old entries are
 */
export function renderLedger(ledger, options = {}) {
	const lines = [];
	const shown = ledger.items.filter((item) => item.archived !== true);
	const archived = ledger.items.length - shown.length;
	for (const kind of KINDS) {
		const entries = shown.filter((item) => item.kind === kind && item.status === "open");
		if (entries.length === 0) continue;
		lines.push(`${HEADINGS[kind]}:`);
		for (const item of entries) lines.push(`  ${entryLine(item, options.now)}`);
	}
	const closed = shown.filter((item) => item.status === "done");
	if (options.closed && closed.length > 0) {
		lines.push("Closed:");
		for (const item of closed) lines.push(`  ${entryLine(item)}`);
	} else if (closed.length > 0) lines.push(`(${closed.length} closed ${closed.length === 1 ? "entry" : "entries"} not shown)`);
	if (archived > 0) lines.push(`(${archived} archived ${archived === 1 ? "entry" : "entries"} not shown; /unarchive ID brings one back)`);
	return lines.length > 0 ? lines.join("\n") : "The ledger is empty.";
}
