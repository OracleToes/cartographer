// The books: the agent's two lists of short entries, kept in one language.
//
// One list is the assessment (what the project is, how it is built, its state),
// the other is practice (what the agent has learned about the harness and the
// habits it wants to keep). Both use the same verbs the ledger and the plan use:
// add, edit, done, remove, before. That is the point: compacting the assessment
// is one `edit`, not a rewrite of the whole, and a lesson about how Cartographer
// works is recorded the same way as a goal or a plan item.
//
// The two lists live in <project>/.brain/carto-books.json as plain JSON. The
// assessment is mirrored to the old assessment.md so the copy at the top of the
// context, /assessment and anything the user edits by hand still work. A project
// that has no books file yet has its assessment.md split into entries by
// paragraph, once, the first time the agent uses the entry verbs.
import { POLICY } from "./config.mjs";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAssessment } from "./assessment.mjs";
import { applyEntryOp, flat } from "./rows.mjs";
import { clipNote, warn } from "./warnings.mjs";

export const BOOK_KINDS = POLICY.enums.bookKinds;
export const BOOK_ACTIONS = POLICY.enums.bookActions;
/** One entry is short: a finding or a habit in a few lines. */
export const BOOK_TEXT_MAX = POLICY.limits.books.textChars;
export const BOOK_ITEMS_MAX = POLICY.limits.books.items;

export class BookError extends Error {}

export const booksPath = (brainDir) => join(brainDir, "carto-books.json");

const PREFIX = POLICY.idPrefixes.books;

/** How this book speaks: see src/rows.mjs. */
const BOOK_SPEC = {
	Error: BookError,
	kinds: BOOK_KINDS,
	prefix: PREFIX,
	textMax: BOOK_TEXT_MAX,
	addTextLabel: "`text`",
	textRequired: () => "`text` is required and was left out or empty: one short entry, in my words.",
	itemsMax: BOOK_ITEMS_MAX,
	limitCount: (book) => book.items.filter((item) => item.status === POLICY.enums.entryStatus.open).length,
	limitText: () => `The books hold ${BOOK_ITEMS_MAX} open entries, their limit. Settle or remove some first.`,
	findId: (id) => id,
	findIds: (book) => book.items.map((entry) => entry.id),
	findText: (id, ids, where) =>
		where === "before"
			? `\`before\` names no entry: ${JSON.stringify(id)}.`
			: `There is no entry ${JSON.stringify(id)}. ${ids === "" ? "The books are empty." : `They hold ${ids}.`}`,
	show: bookLine,
	closedWord: "settled",
	alreadyText: (id) => `${id} was already settled.`,
	outcome: (op) => { if (op.text === undefined || flat(op.text) === "") return undefined; const text = flat(op.text); if (text.length <= POLICY.limits.books.outcomeChars) return text; const clipped = `${text.slice(0, POLICY.limits.books.outcomeChars - 1).trimEnd()}…`; warn(clipNote("`text` (how it ended)", text, clipped, POLICY.limits.books.outcomeChars, { remedy: "the edit action for the entry (`book` books edit)" })); return clipped; },
	markClosed: false,
	addBefore: true,
	editFields: (item, op, hasText, checked) => {
		const hasOutcome = op.outcome !== undefined;
		if (!hasText && !hasOutcome) throw new BookError("An edit needs `text` or `outcome`: what changes.");
		if (hasOutcome && item.status !== POLICY.enums.entryStatus.done) throw new BookError(`${item.id} is not settled; an outcome is how it ended, and is set when it settles.`);
		if (!hasOutcome) return {};
		const text = flat(op.outcome);
		if (text === "") throw new BookError("`outcome` is empty: say how it ended, or leave it out.");
		if (text.length > POLICY.limits.books.outcomeChars) {
			const clipped = `${text.slice(0, POLICY.limits.books.outcomeChars - 1).trimEnd()}…`;
			warn(clipNote("`outcome`", text, clipped, POLICY.limits.books.outcomeChars, { remedy: "the edit action for the entry (`book` books edit)" }));
			return { outcome: clipped };
		}
		return { outcome: text };
	},
	editTextRequired: false,
	reorder: true,
	unknownAction: (op) => `Unknown action ${JSON.stringify(op?.action)}; the actions are ${BOOK_ACTIONS.join(", ")}.`,
};


/**
 * The two lists, with a one-time migration of an old assessment.md into
 * assessment entries. A missing or broken file counts as empty.
 * @returns {{ version: 1, next: number, items: { id: string, kind: string, text: string, status: "open" | "done", added?: number, outcome?: string }[] }}
 */
export function loadBooks(brainDir) {
	const path = booksPath(brainDir);
	if (!existsSync(path)) {
		const items = [];
		const text = loadAssessment(brainDir).text;
		let next = 1;
		for (const paragraph of text.split(/\n\s*\n/).map((part) => part.trim()).filter((part) => part !== "")) {
			items.push({ id: `${PREFIX.assessment}${next++}`, kind: POLICY.enums.bookKind.assessment, text: paragraph, status: POLICY.enums.entryStatus.open });
		}
		return { version: 1, next, items };
	}
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		const items = (Array.isArray(raw?.items) ? raw.items : [])
			.filter((item) => item !== null && typeof item === "object" && typeof item.id === "string" && BOOK_KINDS.includes(item.kind) && typeof item.text === "string")
			.map((item) => ({ ...item, status: item.status === POLICY.enums.entryStatus.done ? POLICY.enums.entryStatus.done : POLICY.enums.entryStatus.open }));
		const highest = items.reduce((max, item) => Math.max(max, Number(item.id.slice(POLICY.idPrefixes.books[item.kind].length)) || 0), 0);
		return { version: 1, next: Math.max(Number.isInteger(raw?.next) ? raw.next : 1, highest + 1), items, ...(typeof raw?.lastCall === "string" ? { lastCall: raw.lastCall } : {}) };
	} catch {
		return { version: 1, next: 1, items: [] };
	}
}

export function saveBooks(brainDir, book) {
	const path = booksPath(brainDir);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(book, null, "\t")}\n`);
	renameSync(temp, path);
}

/** The open entries of one kind as text, one blank line between them. */
export function renderBook(book, kind) {
	return book.items.filter((item) => item.kind === kind && item.status === POLICY.enums.entryStatus.open).map((item) => item.text).join("\n\n");
}

/** The practice entries of a project, for the copy at the top of the context. "" when there are none. */
export function practiceText(brainDir) {
	return renderBook(loadBooks(brainDir), POLICY.enums.bookKind.practice);
}

/** One line for an entry, as the agent and the user see it. */
export function bookLine(item) {
	return `${item.id} [${item.kind}] ${item.text}${item.status === POLICY.enums.entryStatus.done ? " (settled)" : ""}${item.outcome ? ` → ${item.outcome}` : ""}`;
}

export function applyBookOp(book, op, now) {
	return applyEntryOp(book, op, BOOK_SPEC, now);
}
