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
import { POLICY } from "./config.mjs";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ago, since } from "./time.mjs";
import { applyEntryOp, flat } from "./rows.mjs";

export const KINDS = POLICY.enums.ledgerKinds;
const ENTRY_ID = new RegExp(POLICY.patterns.ledgerId);
const PREFIX = POLICY.idPrefixes.ledger;
/** One entry is one line of thought; the open entries ride along with every request, so they stay short. */
export const TEXT_MAX = POLICY.limits.ledger.textChars;
export const OPEN_MAX = POLICY.limits.ledger.openEntries;
/** Closed entries kept; beyond this the oldest are dropped. Open entries are never dropped. */
export const DONE_KEPT = POLICY.limits.ledger.closedEntriesKept;

export class LedgerError extends Error {}

const ledgerPath = (brainDir) => join(brainDir, "carto-ledger.json");
const empty = () => ({ version: 1, next: 1, items: [] });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
		if (typeof item.id !== "string" || !ENTRY_ID.test(item.id)) return { error: `${where}: "id" must look like g1, q2 or n3` };
		if (seen.has(item.id)) return { error: `${where}: the id ${item.id} is used twice` };
		if (typeof item.text !== "string" || item.text.trim() === "") return { error: `${where} (${item.id}): "text" is missing` };
		seen.add(item.id);
		items.push({ ...item, status: item.status === POLICY.enums.entryStatus.done ? POLICY.enums.entryStatus.done : POLICY.enums.entryStatus.open });
	}
	// Ids are never reused, also after entries were removed or added by hand.
	const highest = Math.max(0, ...items.map((item) => Number(item.id.slice(POLICY.idPrefixes.ledger[item.kind].length))));
	return { ledger: { ...raw, version: 1, next: Math.max(Number.isInteger(raw.next) ? raw.next : 1, highest + 1), items } };
}

/** Write the ledger so that a reader never sees half a file. */
export function saveLedger(brainDir, ledger) {
	const path = ledgerPath(brainDir);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(ledger, null, "\t")}\n`);
	renameSync(temp, path);
}

export const open = (ledger, kind) => ledger.items.filter((item) => item.status === POLICY.enums.entryStatus.open && item.archived !== true && (kind === undefined || item.kind === kind));

/** An entry's age is said once it is an hour old: before that it tells the agent nothing. */
const AGE_FROM = POLICY.timing.ledgerAgeMs;

/**
 * One line for an entry, as the agent and the user see it.
 * @param {number} [now]  given, an open entry that is an hour old or more says how old it is
 */
export function entryLine(item, now) {
	const doneWhen = item.kind === POLICY.enums.ledgerKind.goal && item.doneWhen ? ` (done when: ${item.doneWhen})` : "";
	const outcome = item.status === POLICY.enums.entryStatus.done && item.outcome ? ` → ${item.outcome}` : "";
	const age = now === undefined || item.status === POLICY.enums.entryStatus.done ? undefined : since(item.added, now);
	return `${item.id}  ${item.text}${doneWhen}${outcome}${age !== undefined && age >= AGE_FROM ? ` · added ${ago(age)}` : ""}`;
}

/** How this book speaks: see src/rows.mjs. */
const LEDGER_SPEC = {
	Error: LedgerError,
	kinds: KINDS,
	prefix: PREFIX,
	textMax: TEXT_MAX,
	addTextLabel: "`text` (the entry itself, one line in your words)",
	textRequired: (what) => `${what} is required and was left out or empty.`,
	textTooLong: (what, length) => `${what} is ${length} characters; the limit is ${TEXT_MAX}. Say it in one line, or split it into two entries.`,
	itemsMax: OPEN_MAX,
	limitCount: (ledger) => open(ledger).length,
	limitText: () => `The ledger has ${OPEN_MAX} open entries, which is its limit. Close or remove some before adding more.`,
	findId: (id) => flat(id ?? ""),
	findIds: (ledger) => open(ledger).map((entry) => entry.id),
	findText: (wanted, ids) => `There is no entry ${wanted || "(no id given)"}. Open entries: ${ids.length > 0 ? ids.join(", ") : "none"}.`,
	show: (item) => `${item.kind} ${entryLine(item)}`,
	closedWord: "closed",
	alreadyText: (id) => `${id} was already closed.`,
	outcome: (op, checked) => (op.text !== undefined && flat(op.text) !== "" ? checked(op.text, "`text` (how it ended)") : undefined),
	markClosed: true,
	doneFollow: (item) =>
		item.kind === POLICY.enums.ledgerKind.goal ? " Tell the user what was achieved against its done-when line, and ask whether that is what they wanted." : "",
	addFields: (op, kind, checked) =>
		kind === POLICY.enums.ledgerKind.goal ? { doneWhen: checked(op.done_when, "`done_when` (how you and the user will know the goal is reached)") } : {},
	addBefore: false,
	editFields: (item, op, hasText, checked) => {
		const hasDoneWhen = op.done_when !== undefined && flat(op.done_when) !== "";
		if (!hasText && !hasDoneWhen) throw new LedgerError("An edit needs `text`, `done_when`, or both: the new wording.");
		if (hasDoneWhen && item.kind !== POLICY.enums.ledgerKind.goal) throw new LedgerError(`${item.id} is a ${item.kind}; only a goal has a done-when line.`);
		return hasDoneWhen ? { doneWhen: checked(op.done_when, "`done_when`") } : {};
	},
	editTextRequired: false,
	reorder: false,
	unknownAction: (op) => `Unknown action ${JSON.stringify(op?.action)}; the actions are add, done, edit, remove.`,
};

/**
 * Apply one operation to the ledger (changed in place).
 * @returns {{ line: string, shown: string }} what the agent is told and what the user is shown
 */
export function applyOp(ledger, op, now) {
	return applyEntryOp(ledger, op, LEDGER_SPEC, now);
}

/** Drop the oldest closed entries beyond the number kept. */
export function prune(ledger) {
	const closed = ledger.items.filter((item) => item.status === POLICY.enums.entryStatus.done);
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
		const entries = shown.filter((item) => item.kind === kind && item.status === POLICY.enums.entryStatus.open);
		if (entries.length === 0) continue;
		lines.push(`${HEADINGS[kind]}:`);
		for (const item of entries) lines.push(`  ${entryLine(item, options.now)}`);
	}
	const closed = shown.filter((item) => item.status === POLICY.enums.entryStatus.done);
	if (options.closed && closed.length > 0) {
		lines.push("Closed:");
		for (const item of closed) lines.push(`  ${entryLine(item)}`);
	} else if (closed.length > 0) lines.push(`(${closed.length} closed ${closed.length === 1 ? "entry" : "entries"} not shown)`);
	if (archived > 0) lines.push(`(${archived} archived ${archived === 1 ? "entry" : "entries"} not shown; /unarchive ID brings one back)`);
	return lines.length > 0 ? lines.join("\n") : "The ledger is empty.";
}
