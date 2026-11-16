// The operations the user has on a row of any view, in one place.
//
// The screen's views show rows of several books: Hands holds the kept reports and the shelf, Carto's tabs the
// atlas, the ledger and the plan, Requests what waits for the user. The keys over those rows (f, v, d, x, t and
// n in src/screen/app.mjs) and the commands that name a row by its id (/archive, /unarchive, /delete, /done in
// src/terminal.mjs) do the same work, so the work lives here: an id names a row of one of the books, and each
// function carries the operation out and returns the line to show.
//
// Resolve a row by searching the owning books; an id prefix is not a dispatch mechanism for context-row species.
import { POLICY } from "./config.mjs";
import { applyContextRowAction, ContextRowError, foldReports, loadContext, recallReport, unshelveForUser } from "./context.mjs";
import { applyAtlasOp, AtlasError, loadAtlas, saveAtlas } from "./atlas.mjs";
import { applyOp, LedgerError, loadLedger, prune, saveLedger } from "./ledger.mjs";
import { loadPlan, savePlan, applyPlanOp, PlanError } from "./plan.mjs";
import { pin } from "./top.mjs";

/** The books an id might name, and the words for them in a line of refusal. */
export const BOOKS = `a report is t1, a ledger entry g1, q2 or n3, a plan item p1, a node of the graph its name`;
const contextAction = (brainDir, id, action) => {
	try {
		return applyContextRowAction(brainDir, id, action);
	} catch (error) {
		if (error instanceof ContextRowError) return error.message;
		throw error;
	}
};

/** The one row an id names, read out of its book. Returns the row and the words for what it is; undefined when no book holds it. */
function row(brainDir, id) {
	const contextRow = loadContext(brainDir).rows.find((entry) => entry.id === id);
	if (contextRow !== undefined) return {
		what: "report",
		archived: contextRow.archived === true,
		kind: contextRow.species,
		found: contextRow,
	};
	const { ledger } = loadLedger(brainDir);
	const entry = ledger?.items.find((item) => item.id === id);
	if (entry !== undefined) return { what: "ledger entry", archived: entry.archived === true, kind: entry.kind, found: entry };
	const { plan } = loadPlan(brainDir);
	const item = plan?.items.find((entry) => entry.id === id);
	if (item !== undefined) return { what: "plan item", archived: item.archived === true, kind: item.mode, found: item };
	const { atlas } = loadAtlas(brainDir);
	const node = atlas?.nodes.find((entry) => entry.name === id);
	if (node !== undefined) return { what: "node", archived: node.archived === true, kind: node.kind ?? "node", found: node };
	return undefined;
}

/**
 * Take a row out of what the agent reads, keeping it on disk where the book keeps it: a report's record line is
 * archived, a ledger entry, a plan item or a node is marked archived and left out of what is built from the book.
 * @returns the line to show
 */
export function archiveRow(brainDir, id) {
	const found = row(brainDir, id);
	if (found === undefined) return `There is no ${id}. ${BOOKS}.`;
	if (found.what === "report") return contextAction(brainDir, id, POLICY.enums.actions.archive);
	if (found.archived) return `${id} is archived already.`;
	if (found.what === "ledger entry") {
		const { ledger } = loadLedger(brainDir);
		const entry = ledger.items.find((item) => item.id === id);
		entry.archived = true;
		saveLedger(brainDir, ledger);
		return `${id} archived: the ${entry.kind} leaves the ledger as the agent reads it, and waits in the file; /unarchive brings it back.`;
	}
	if (found.what === "plan item") {
		const { plan } = loadPlan(brainDir);
		const item = plan.items.find((entry) => entry.id === id);
		item.archived = true;
		savePlan(brainDir, plan);
		return `${id} archived: the item leaves the plan as the agent reads it, and waits in the file; /unarchive brings it back.`;
	}
	const { atlas } = loadAtlas(brainDir);
	const node = atlas.nodes.find((entry) => entry.name === id);
	node.archived = true;
	saveAtlas(brainDir, atlas);
	return `${id} archived: the node leaves the outline as the agent reads it, and waits in the file; /unarchive brings it back.`;
}

/** The reverse of `archiveRow`: the row stands in what the agent reads again. @returns the line to show */
export function unarchiveRow(brainDir, id) {
	const found = row(brainDir, id);
	if (found === undefined) return `There is no ${id}. ${BOOKS}.`;
	if (found.what === "report") return contextAction(brainDir, id, POLICY.enums.actions.unarchive);
	if (!found.archived) return `${id} is not archived.`;
	if (found.what === "ledger entry") {
		const { ledger } = loadLedger(brainDir);
		const entry = ledger.items.find((item) => item.id === id);
		delete entry.archived;
		saveLedger(brainDir, ledger);
		return `${id} is back in the ledger as the agent reads it.`;
	}
	if (found.what === "plan item") {
		const { plan } = loadPlan(brainDir);
		const item = plan.items.find((entry) => entry.id === id);
		delete item.archived;
		savePlan(brainDir, plan);
		return `${id} is back in the plan as the agent reads it.`;
	}
	const { atlas } = loadAtlas(brainDir);
	const node = atlas.nodes.find((entry) => entry.name === id);
	delete node.archived;
	saveAtlas(brainDir, atlas);
	return `${id} is back in the outline as the agent reads it.`;
}

/**
 * A row is gone for good: a report's record line and file are dropped, a ledger entry, a plan item or a node is
 * taken out of its book. Nothing is said to the agent: this
 * is how the user makes the agent forget a thing it wrote down. @returns the line to show
 */
export function dropRow(brainDir, id) {
	const found = row(brainDir, id);
	if (found === undefined) return `There is no ${id}. ${BOOKS}.`;
	if (found.what === "report") return contextAction(brainDir, id, POLICY.enums.actions.delete);
	if (found.what === "ledger entry") {
		const { ledger } = loadLedger(brainDir);
		const at = ledger.items.findIndex((item) => item.id === id);
		if (at < 0) return `There is no ${id}. ${BOOKS}.`;
		ledger.items.splice(at, 1);
		saveLedger(brainDir, ledger);
		return `${id} is gone for good: the ${found.found.kind} is out of the ledger, and nothing of it is said to the agent.`;
	}
	if (found.what === "plan item") {
		const { plan } = loadPlan(brainDir);
		const at = plan.items.findIndex((item) => item.id === id);
		if (at < 0) return `There is no ${id}. ${BOOKS}.`;
		plan.items.splice(at, 1);
		savePlan(brainDir, plan);
		return `${id} is gone for good: the item is out of the plan, and nothing of it is said to the agent.`;
	}
	const { atlas, error } = loadAtlas(brainDir);
	if (atlas === undefined) return `! The graph cannot be read: ${error}`;
	const at = atlas.nodes.findIndex((entry) => entry.name === id);
	if (at < 0) return `There is no node ${id}. /atlas lists the nodes.`;
	atlas.nodes.splice(at, 1);
	let links = 0;
	for (const other of atlas.nodes) if (other.links.includes(id)) { other.links = other.links.filter((link) => link !== id); links++; }
	saveAtlas(brainDir, atlas);
	return `${id} is gone for good: the node is out of the graph${links > 0 ? `, and ${links === 1 ? "1 link" : `${links} links`} to it went with it` : ""}, and nothing of it is said to the agent.`;
}

/**
 * f on a report: fold it out of view, leaving its one line, or bring it back in full.
 * @returns the line to show
 */
export function foldRow(brainDir, id) {
	const found = row(brainDir, id);
	if (found?.what !== "report") return `Only a composed report row folds: ${BOOKS}.`;
	const { dropped } = loadContext(brainDir);
	return dropped.includes(id) ? recallReport(brainDir, id) : foldReports(brainDir, [id]);
}

/** x on a shelved file: take it off the shelf. @returns the line to show */
export function unshelveRow(brainDir, id) {
	return unshelveForUser(brainDir, id);
}

/**
 * The operations over several ids at once, for the commands: each id goes to its book, and the lines come back
 * together. Unknown ids are said in their own lines, so one mistake does not hide the rest.
 */
function rows(brainDir, ids, one) {
	return ids.map((id) => one(brainDir, id)).join("\n");
}

export const archiveRows = (brainDir, ids) => rows(brainDir, ids, archiveRow);
export const unarchiveRows = (brainDir, ids) => rows(brainDir, ids, unarchiveRow);
export const dropRows = (brainDir, ids) => rows(brainDir, ids, dropRow);

/**
 * Mark a row of a view settled, with the same operations the agent uses: a ledger entry is closed (with the
 * outcome line the agent would give), a plan item is done, a node of the graph is confirmed (the node's own
 * "still true"). @returns the line to show
 */
export function settleRow(brainDir, id, root) {
	const found = row(brainDir, id);
	if (found === undefined) return `There is no ${id}. ${BOOKS}.`;
	const now = new Date().toISOString();
	try {
		if (found.what === "report") return "A report has no settled: f folds it out of view.";
		if (found.what === "ledger entry") {
			const { ledger, error } = loadLedger(brainDir);
			if (ledger === undefined) return `! The ledger cannot be read: ${error}`;
			const isGoal = found.found.kind === POLICY.enums.ledgerKind.goal && found.found.status !== POLICY.enums.entryStatus.done;
			const result = applyOp(ledger, { action: POLICY.enums.actions.done, id }, now);
			prune(ledger);
			saveLedger(brainDir, ledger);
			// A goal that closes is a moment to bring the copy at the top of the context up to date, as the agent's own done does.
			if (isGoal && ledger.items.find((item) => item.id === id)?.status === POLICY.enums.entryStatus.done && pin(brainDir, { reason: `goal ${id} was closed` }).changed) {
				return `${result.line} The copy of my assessment and graph at the top of the context was rewritten to what they are now.`;
			}
			return result.line;
		}
		if (found.what === "plan item") {
			const { plan, error } = loadPlan(brainDir);
			if (plan === undefined) return `! The plan cannot be read: ${error}`;
			const result = applyPlanOp(plan, { action: POLICY.enums.actions.done, id }, now);
			savePlan(brainDir, plan);
			return result.line;
		}
		const { atlas, error } = loadAtlas(brainDir);
		if (atlas === undefined) return `! The graph cannot be read: ${error}`;
		if (root === undefined) return "A node is confirmed from somewhere the graph can re-read its files.";
		const result = applyAtlasOp(atlas, { action: "confirm", names: [found.found.name] }, { root, now });
		saveAtlas(brainDir, atlas);
		return result.line;
	} catch (error) {
		if (error instanceof LedgerError || error instanceof PlanError || error instanceof AtlasError) return `! ${error.message}`;
		throw error;
	}
}

/** The scaffold a new row of a book starts from, and how the book applies it. */
const ADD_TEMPLATES = {
	ledger: { label: "ledger entry", text: () => `${JSON.stringify({ kind: "note", text: "", salient: false, done_when: "" }, null, "\t")}\n` },
	plan: { label: "plan item", text: () => `${JSON.stringify({ mode: "look", text: "", network: false, standing: false }, null, "\t")}\n` },
	atlas: { label: "node", text: () => `${JSON.stringify({ name: "", gist: "", kind: "", detail: "" }, null, "\t")}\n` },
};

export const ADD_BOOKS = Object.keys(ADD_TEMPLATES);

/** The JSON a new row of `book` starts from; an editor opens on it. @returns undefined for a book with no add */
export const addTemplate = (book) => ADD_TEMPLATES[book]?.text();

/**
 * Add a row to a book from the JSON its scaffold holds, with the same operations the agent uses. The file is
 * parsed first; anything the book refuses is said plainly; nothing is half-applied. @returns the line to show
 */
export function applyAdd(brainDir, book, text, root) {
	const scaffold = ADD_TEMPLATES[book];
	if (scaffold === undefined) return `There is no add for ${book} here.`;
	let op;
	try {
		op = JSON.parse(String(text));
	} catch (error) {
		return `! The new ${scaffold.label} does not parse: ${error.message}. Nothing was added.`;
	}
	if (op === null || typeof op !== "object" || Array.isArray(op)) return `! The new ${scaffold.label} has to be a single JSON object. Nothing was added.`;
	const now = new Date().toISOString();
	try {
		if (book === "ledger") {
			const { ledger, error } = loadLedger(brainDir);
			if (ledger === undefined) return `! The ledger cannot be read: ${error}`;
			const result = applyOp(ledger, { action: POLICY.enums.actions.add, ...op }, now);
			saveLedger(brainDir, ledger);
			return result.line;
		}
		if (book === "plan") {
			const { plan, error } = loadPlan(brainDir);
			if (plan === undefined) return `! The plan cannot be read: ${error}`;
			const result = applyPlanOp(plan, { action: POLICY.enums.actions.add, ...op }, now);
			savePlan(brainDir, plan);
			return result.line;
		}
		const { atlas, error } = loadAtlas(brainDir);
		if (atlas === undefined) return `! The graph cannot be read: ${error}`;
		if (root === undefined) return "A node is added from somewhere the graph can check its files.";
		const result = applyAtlasOp(atlas, { action: "add", ...op }, { root, now, mayCreate: false });
		saveAtlas(brainDir, atlas);
		return result.line;
	} catch (error) {
		if (error instanceof LedgerError || error instanceof PlanError || error instanceof AtlasError) return `! ${error.message}`;
		throw error;
	}
}

/**
 * The fields the screen's small box edits, applied with the same operations the agent uses. `changes` holds only
 * what was edited — `text`, `doneWhen`, `outcome`, `gist`, `detail`, `name` — so a save carries the whole edit in
 * one pass: one operation per book, one save at the end, nothing half-applied. @returns the line to show
 */
export function editRow(brainDir, id, changes, root) {
	const found = row(brainDir, id);
	if (found === undefined) return `There is no ${id}. ${BOOKS}.`;
	const now = new Date().toISOString();
	try {
		if (found.what === "ledger entry") {
			const { ledger, error } = loadLedger(brainDir);
			if (ledger === undefined) return `! The ledger cannot be read: ${error}`;
			const op = {
				action: POLICY.enums.actions.edit,
				id,
				...(changes.text !== undefined ? { text: changes.text } : {}),
				...(changes.doneWhen !== undefined ? { done_when: changes.doneWhen } : {}),
				...(changes.outcome !== undefined ? { outcome: changes.outcome } : {}),
			};
			const result = applyOp(ledger, op, now);
			saveLedger(brainDir, ledger);
			return result.line;
		}
		if (found.what === "plan item") {
			const { plan, error } = loadPlan(brainDir);
			if (plan === undefined) return `! The plan cannot be read: ${error}`;
			const op = {
				action: POLICY.enums.actions.edit,
				id,
				...(changes.text !== undefined ? { text: changes.text } : {}),
				...(changes.outcome !== undefined ? { outcome: changes.outcome } : {}),
			};
			const result = applyPlanOp(plan, op, now);
			savePlan(brainDir, plan);
			return result.line;
		}
		if (found.what === "node") {
			const { atlas, error } = loadAtlas(brainDir);
			if (atlas === undefined) return `! The graph cannot be read: ${error}`;
			const node = atlas.nodes.find((entry) => entry.name === id);
			if (node === undefined) return `There is no node ${id}.`;
			const who = { root, now, by: POLICY.enums.atlasAuthors.user };
			const lines = [];
			// The edit goes first, by the name the node carries now; the rename last. One save after both, or none.
			if (changes.gist !== undefined || changes.detail !== undefined) {
				const result = applyAtlasOp(atlas, { action: POLICY.enums.atlasActions.edit, name: id, gist: changes.gist ?? node.gist, ...(changes.detail !== undefined ? { detail: changes.detail } : {}) }, who);
				lines.push(result.line);
			}
			if (changes.name !== undefined && changes.name !== id) {
				const result = applyAtlasOp(atlas, { action: POLICY.enums.atlasActions.rename, name: id, to: changes.name }, who);
				lines.push(result.line);
			}
			if (lines.length === 0) return "Nothing is changed.";
			saveAtlas(brainDir, atlas);
			return lines.join(" ");
		}
		return `There is no ${id}. ${BOOKS}.`;
	} catch (error) {
		if (error instanceof LedgerError || error instanceof PlanError || error instanceof AtlasError) return `! ${error.message}`;
		throw error;
	}
}
