// The operations the user has on a row of any view, in one place.
//
// The screen's views show rows of several books: Hands holds the kept reports and the shelf, Carto's tabs the
// atlas, the ledger and the plan, Requests what waits for the user. The keys over those rows (f, v, d, x in
// src/screen/app.mjs) and the commands that name a row by its id (/archive, /unarchive, /delete in
// src/terminal.mjs) do the same work, so the work lives here: an id names a row of one of the books, and each
// function carries the operation out and returns the line to show.
//
// An id is read by its shape: t1 is a report, g1, q2 or n3 a ledger entry, p1 a plan item, and anything else the name of a node of the graph.
import { POLICY } from "./config.mjs";
import { archiveReports, deleteReports, foldReports, loadContext, recallReport, unarchiveReports, unshelveForUser } from "./context.mjs";
import { loadAtlas, saveAtlas } from "./atlas.mjs";
import { loadLedger, saveLedger } from "./ledger.mjs";
import { loadPlan, savePlan } from "./plan.mjs";

const REPORT = new RegExp(POLICY.patterns.reportId);
const ENTRY = new RegExp(POLICY.patterns.ledgerId);
const ITEM = new RegExp(POLICY.patterns.planId);
/** The books an id might name, and the words for them in a line of refusal. */
export const BOOKS = `a report is t1, a ledger entry g1, q2 or n3, a plan item p1, a node of the graph its name`;

/** The one row an id names, read out of its book. Returns the row and the words for what it is; undefined when no book holds it. */
function row(brainDir, id) {
	if (REPORT.test(id)) {
		const { records } = loadContext(brainDir);
		const record = records.find((entry) => entry.id === id);
		return record === undefined ? undefined : { what: "report", archived: record.archived === true, kind: "report" };
	}
	if (ENTRY.test(id)) {
		const { ledger } = loadLedger(brainDir);
		const entry = ledger?.items.find((item) => item.id === id);
		return entry === undefined ? undefined : { what: "ledger entry", archived: entry.archived === true, kind: entry.kind, found: entry };
	}
	if (ITEM.test(id)) {
		const { plan } = loadPlan(brainDir);
		const item = plan?.items.find((entry) => entry.id === id);
		return item === undefined ? undefined : { what: "plan item", archived: item.archived === true, kind: item.mode, found: item };
	}
	const { atlas } = loadAtlas(brainDir);
	const node = atlas?.nodes.find((entry) => entry.name === id);
	return node === undefined ? undefined : { what: "node", archived: node.archived === true, kind: node.kind ?? "node", found: node };
}

/**
 * Take a row out of what the agent reads, keeping it on disk where the book keeps it: a report's record line is
 * archived, a ledger entry, a plan item or a node is marked archived and left out of what is built from the book.
 * @returns the line to show
 */
export function archiveRow(brainDir, id) {
	// A report goes by the words of the context store, which say more about what archiving one means.
	if (REPORT.test(id)) return archiveReports(brainDir, [id]);
	const found = row(brainDir, id);
	if (found === undefined) return `There is no ${id}. ${BOOKS}.`;
	if (found.what === "report") return archiveReports(brainDir, [id]);
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
	if (REPORT.test(id)) return unarchiveReports(brainDir, [id]);
	const found = row(brainDir, id);
	if (found === undefined) return `There is no ${id}. ${BOOKS}.`;
	if (found.what === "report") return unarchiveReports(brainDir, [id]);
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
	if (REPORT.test(id)) return deleteReports(brainDir, [id]);
	const found = row(brainDir, id);
	if (found === undefined) return `There is no ${id}. ${BOOKS}.`;
	if (found.what === "report") return deleteReports(brainDir, [id]);
	if (found.what === "ledger entry") {
		const { ledger } = loadLedger(brainDir);
		ledger.items.splice(ledger.items.indexOf(found.found), 1);
		saveLedger(brainDir, ledger);
		return `${id} is gone for good: the ${found.found.kind} is out of the ledger, and nothing of it is said to the agent.`;
	}
	if (found.what === "plan item") {
		const { plan } = loadPlan(brainDir);
		plan.items.splice(plan.items.indexOf(found.found), 1);
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
	if (!REPORT.test(id)) return `Only a report (t1) folds: ${BOOKS}.`;
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
