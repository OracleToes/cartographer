// The books: the agent's two lists of short entries, kept in one language.
//
// One list is the assessment (what the project is, how it is built, its state),
// the other is practice (what the agent has learned about the harness and the
// habits it wants to keep). Both use the same verbs the ledger and the plan use:
// add, edit, done, remove, before. That is the point: compacting the assessment
// is one `edit`, not a rewrite of the whole, and a lesson about how Cartographer
// works is recorded the same way as a goal or a plan item.
//
// The two lists live in <project>/.atlas/carto-books.json as plain JSON. The
// assessment is mirrored to the old assessment.md so the copy at the top of the
// context, /assessment and anything the user edits by hand still work. A project
// that has no books file yet has its assessment.md split into entries by
// paragraph, once, the first time the agent uses the entry verbs.
import { POLICY } from "./config.mjs";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAssessment } from "./assessment.mjs";
import { applyEntryOp, flat } from "./rows.mjs";

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
	textRequired: () => "`text` is required and was left out or empty: one short entry, in your words.",
	textTooLong: (_, length) => `\`text\` is ${length} characters; an entry may hold ${BOOK_TEXT_MAX}. Keep one thought per entry.`,
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
	outcome: (op) => (op.text !== undefined && flat(op.text) !== "" ? flat(op.text).slice(0, POLICY.limits.books.outcomeChars) : undefined),
	markClosed: false,
	addBefore: true,
	editTextRequired: true,
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
		return { version: 1, next: Math.max(Number.isInteger(raw?.next) ? raw.next : 1, highest + 1), items };
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
