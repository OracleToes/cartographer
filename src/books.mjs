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
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAssessment } from "./assessment.mjs";

export const BOOK_KINDS = ["assessment", "practice"];
export const BOOK_ACTIONS = ["add", "edit", "done", "remove", "before"];
/** One entry is short: a finding or a habit in a few lines. */
export const BOOK_TEXT_MAX = 600;
export const BOOK_ITEMS_MAX = 60;

export class BookError extends Error {}

export const booksPath = (brainDir) => join(brainDir, "carto-books.json");

const flat = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const PREFIX = { assessment: "a", practice: "r" };

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
			items.push({ id: `a${next++}`, kind: "assessment", text: paragraph, status: "open" });
		}
		return { version: 1, next, items };
	}
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		const items = (Array.isArray(raw?.items) ? raw.items : [])
			.filter((item) => item !== null && typeof item === "object" && typeof item.id === "string" && BOOK_KINDS.includes(item.kind) && typeof item.text === "string")
			.map((item) => ({ ...item, status: item.status === "done" ? "done" : "open" }));
		const highest = items.reduce((max, item) => Math.max(max, Number(item.id.slice(1)) || 0), 0);
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
	return book.items.filter((item) => item.kind === kind && item.status === "open").map((item) => item.text).join("\n\n");
}

/** The practice entries of a project, for the copy at the top of the context. "" when there are none. */
export function practiceText(brainDir) {
	return renderBook(loadBooks(brainDir), "practice");
}

/** One line for an entry, as the agent and the user see it. */
export function bookLine(item) {
	return `${item.id} [${item.kind}] ${item.text}${item.status === "done" ? " (settled)" : ""}${item.outcome ? ` → ${item.outcome}` : ""}`;
}

function find(book, id) {
	const item = book.items.find((entry) => entry.id === id);
	if (item === undefined) {
		const ids = book.items.map((entry) => entry.id).join(", ");
		throw new BookError(`There is no entry ${JSON.stringify(id)}. ${ids === "" ? "The books are empty." : `They hold ${ids}.`}`);
	}
	return item;
}

function checked(value) {
	if (typeof value !== "string" || value.trim() === "") throw new BookError("`text` is required and was left out or empty: one short entry, in your words.");
	const text = value.trim();
	if (text.length > BOOK_TEXT_MAX) throw new BookError(`\`text\` is ${text.length} characters; an entry may hold ${BOOK_TEXT_MAX}. Keep one thought per entry.`);
	return text;
}

/** Move the entry `id` to stand in front of `before` (or to the end when it is ""). */
function moveBefore(book, item, before) {
	const at = book.items.indexOf(item);
	book.items.splice(at, 1);
	if (before === undefined || before === "") {
		book.items.push(item);
		return;
	}
	const other = find(book, before);
	if (other === item) throw new BookError("An entry cannot stand in front of itself.");
	book.items.splice(book.items.indexOf(other), 0, item);
}

/**
 * Apply one operation to `book` (changed in place).
 * @returns {{ line: string, shown: string }} what the agent is told and what the user is shown
 */
export function applyBookOp(book, op, now) {
	switch (op?.action) {
		case "add": {
			if (!BOOK_KINDS.includes(op.kind)) throw new BookError(`\`kind\` is ${JSON.stringify(op.kind)}; it is one of ${BOOK_KINDS.join(", ")}.`);
			const text = checked(op.text);
			if (book.items.filter((item) => item.status === "open").length >= BOOK_ITEMS_MAX) {
				throw new BookError(`The books hold ${BOOK_ITEMS_MAX} open entries, their limit. Settle or remove some first.`);
			}
			const item = { id: `${PREFIX[op.kind]}${book.next}`, kind: op.kind, text, status: "open", added: now };
			book.next++;
			if (op.before !== undefined && op.before !== "") {
				const other = book.items.find((entry) => entry.id === op.before);
				if (other === undefined) throw new BookError(`\`before\` names no entry: ${JSON.stringify(op.before)}.`);
				book.items.splice(book.items.indexOf(other), 0, item);
			} else book.items.push(item);
			return { line: `${item.id} added.`, shown: `+ ${bookLine(item)}` };
		}
		case "edit": {
			const item = find(book, op.id);
			item.text = checked(op.text);
			return { line: `${item.id} reworded.`, shown: `~ ${bookLine(item)}` };
		}
		case "done": {
			const item = find(book, op.id);
			if (item.status === "done") return { line: `${item.id} was already settled.`, shown: `✓ ${bookLine(item)}` };
			item.status = "done";
			if (op.text !== undefined && flat(op.text) !== "") item.outcome = flat(op.text).slice(0, 300);
			return { line: `${item.id} settled.`, shown: `✓ ${bookLine(item)}` };
		}
		case "remove": {
			const item = find(book, op.id);
			book.items.splice(book.items.indexOf(item), 1);
			return { line: `${item.id} removed.`, shown: `- ${bookLine(item)}` };
		}
		case "before": {
			const item = find(book, op.id);
			moveBefore(book, item, op.before);
			return { line: `${item.id} moved.`, shown: `↕ ${bookLine(item)}` };
		}
		default:
			throw new BookError(`Unknown action ${JSON.stringify(op?.action)}; the actions are ${BOOK_ACTIONS.join(", ")}.`);
	}
}
