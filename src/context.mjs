// What is kept when the context is collapsed, and how it is written.
//
// Nothing the conversation holds is ever deleted from storage. A collapse starts a
// new stretch of context, and that stretch begins with one message Cartographer
// writes, the front block, between <context> and </context>:
//
//   the record   one line for each finished task, with the minute it ended: what was
//                asked, how it ended, and an id under which the whole report can be
//                brought back
//   the salient  the open ledger notes carrying salience (src/ledger.mjs), one
//   notes        line each with its minute, re-read from the ledger when the block is dressed
//   the shelf    a structured listing of the items held, then the files, or line ranges of
//                files, the agent chose to keep in view, as the collapse found them
//   the talk     the last of what the user and the agent said to each other, word
//                for word, in order, each saying with its minute, up to `chatWindow` tokens
//   the calls    one line per call of the stretch before the collapse: the minute, the
//                call, its outcome; the newest that fit, under `callsTokens` tokens
//   now          when the collapse came in the middle of a turn: the calls of the
//                last reply and what they returned
//
// Every line carries a local hour:minute; the block is typed in clusters, and what is
// stamped within a cluster reads in the order it happened.
//
// The agent's own notes, old tool calls and results, and reports in full are not
// carried over. The ledger, the plan, the graph and the assessment are files of
// their own and are untouched.
//
// So a request is, in order: the prompt and the tools; the assessment and the graph
// (src/top.mjs); the front block; what happened since the collapse; the state block
// (src/state.mjs). Between two collapses only the end of that changes, which is all
// the model server then has to read.
//
// What a collapse needs is collected as it happens, not dug out of the conversation
// afterwards: the task tool writes the record line and the report file when a task
// ends, and what is said is noted when it is said. The context is kept in
// <project>/.brain/carto-context.json, full file shelf snapshots in
// <project>/.brain/shelf/, and reports in <project>/.brain/reports/.
//
// A task has the same means for its own steps, and only for those: what stands in
// front of its brief is the main agent's and stays as it is (see `dressTask`).
import { POLICY } from "./config.mjs";
import { charsPerTokenNow } from "./calibrate.mjs";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileIdentityForPath, readReferenceVersion } from "./catalog.mjs";
import { TASK_HEADER } from "./prompt.mjs";
import { RECORD } from "./voice.mjs";

/** The stable anchor every block written by me starts with; the regex below is built from it so the marker cannot drift. */
const ANCHOR = RECORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
import { clock, stamp } from "./time.mjs";
import { entryLine, loadLedger, salientNotes, saveLedger } from "./ledger.mjs";
import { confine, LookError } from "./tools/look.mjs";
import { fileReference } from "./catalog.mjs";
import { USER_NAME, USER_HEAD } from "./user.mjs";
import { parseStory, readStory, renderStory, STORY_ID } from "./story.mjs";

const OPEN = POLICY.markup.context.open;
const CLOSE = POLICY.markup.context.close;
const HEAD = RECORD;
const NOTE_OPEN = POLICY.markup.note.open;
const NOTE_CLOSE = POLICY.markup.note.close;
const REPORT_ID = new RegExp(POLICY.patterns.reportId);
const RECALLED_REPORT = new RegExp(POLICY.patterns.recalledReport);
const FRONT_BLOCK = new RegExp(`${OPEN}\\n${ANCHOR}[\\s\\S]*?\\n${CLOSE}\\n*`, "g");

/** Tokens of record lines a front block holds at most; older tasks are counted, not listed. */
const RECORD_MAX_TOKENS = POLICY.limits.context.recordTokens;
/** A collapse that would free less than this is not worth reading the kept part again. */
export const FLOOR = POLICY.limits.context.collapseFloorTokens;
/** The most of one result of the last reply that the front block quotes. */
const NOW_MAX_CHARS = POLICY.limits.context.resultChars;
/** A task's result of at least this many characters gets a tag with its id and size. */
const TAG_MIN_CHARS = POLICY.limits.context.resultTagChars;
/** Lines of a file the shelf shows at most. */
const SHELF_MAX_LINES = POLICY.limits.context.shelfLines;

export const contextPath = (brainDir) => join(brainDir, "carto-context.json");
export const reportsDir = (brainDir) => join(brainDir, "reports");

/** A rough count of tokens: the calibrated ratio (see src/calibrate.mjs). The server's own count is used wherever there is one. */
export const estimate = (text) => Math.ceil(String(text ?? "").length / charsPerTokenNow());
export { charsPerTokenNow };
const count = (n) => Math.round(n).toLocaleString("en-US");
const oneLine = (text, max) => {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const hashOf = (text) => createHash("sha1").update(text).digest("hex").slice(0, 16);
/** Shelf placement ids count up within the brain, which is per project: sh1, sh2, ….
 *  The number is derived from every placement on disk — the main shelf, the front set and every task's —
 *  and from the snapshot files, so the numbering cannot collide across scopes or across calls.
 *  Placements written before 2026-11-15 hold `sh-<uuid>` ids; they stay valid. */
const nextShelfId = (brainDir, existing = []) => {
	let highest = 0;
	const scan = (item) => {
		const match = /^sh(\d+)$/.exec(typeof item?.id === "string" ? item.id : "");
		if (match) highest = Math.max(highest, Number(match[1]));
	};
	for (const item of existing) scan(item);
	try {
		const store = loadContext(brainDir);
		for (const item of store.shelf ?? []) scan(item);
		if (Array.isArray(store.front?.shelf)) for (const item of store.front.shelf) scan(item);
		for (const task of Object.values(store.tasks ?? {})) {
			for (const item of task?.shelf ?? []) scan(item);
			for (const evidence of task?.evidence ?? []) scan(evidence?.item);
		}
	} catch { /* an unreadable store mints from the in-flight list alone */ }
	try {
		for (const file of readdirSync(join(brainDir, "shelf"))) {
			const match = /^sh(\d+)\.txt$/.exec(file);
			if (match) highest = Math.max(highest, Number(match[1]));
		}
	} catch { /* no snapshot directory yet */ }
	return `sh${highest + 1}`;
};
const legacyShelfId = (item, index, scope = "main") => `sh-legacy-${hashOf(`${scope}:${index}:${JSON.stringify(item?.ref ?? item?.path ?? item)}`)}`;
const shelfSnapshotPath = (brainDir, item) => join(brainDir, "shelf", `${item.id}.txt`);
function safeShelfSnapshotPath(brainDir, item, { create = false } = {}) {
	const dir = join(brainDir, "shelf");
	if (create) mkdirSync(dir, { recursive: true });
	if (existsSync(dir) && !lstatSync(dir).isDirectory()) throw new ShelfError("The shelf snapshot directory is not a regular directory.");
	const path = shelfSnapshotPath(brainDir, item);
	if (existsSync(path) && !lstatSync(path).isFile()) throw new ShelfError(`The backing snapshot for ${item.id} is not a regular file.`);
	return path;
}
export function cleanupShelfSnapshots(brainDir, removed, retainedStore) {
	const current = retainedStore ?? loadContext(brainDir);
	const retained = new Set([...current.shelf, ...Object.values(current.tasks).flatMap((task) => task?.shelf ?? []), ...(current.front?.shelf ?? [])].map((item) => item.id));
	for (const item of removed) {
		if (!item.id || retained.has(item.id)) continue;
		try { unlinkSync(safeShelfSnapshotPath(brainDir, item)); } catch { /* The snapshot was absent or unsafe to remove. */ }
	}
}
const shelfIdLine = (text, item) => {
	const [first, ...rest] = String(text).split("\n");
	const clean = first.replace(/ \[shelf id sh(\d+|-[A-Za-z0-9-]+)\]$/, "");
	return `${clean} [shelf id ${item.id}]${rest.length > 0 ? `\n${rest.join("\n")}` : ""}`;
};

/** The raw text a placement held when its snapshot was taken, and what it resolves to now. */
const rawShelf = (root, item, brainDir) => {
	const now = item.ref !== undefined ? SHELF_RESOLVERS[item.ref.type]?.(brainDir, item.ref, item) : liveShelfSource(root, item)?.content;
	return { before: readShelfSnapshot(brainDir, item), now };
};

/** The line delta of a shelf change, as +added −removed lines; for the one-line notices in the state block. */
function shelfDelta(before, after) {
	const oldLines = String(before ?? "").split("\n");
	const newLines = String(after ?? "").split("\n");
	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
	return { added: newEnd - start, removed: oldEnd - start };
}
export const textOf = (message) =>
	typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") : "";
const callsOf = (message) => (Array.isArray(message?.content) ? message.content.filter((part) => part.type === "toolCall") : []);

/** Roughly how many tokens a stored message takes in a request. */
export function messageTokens(message) {
	let chars = textOf(message).length + 12;
	for (const call of callsOf(message)) chars += call.name.length + JSON.stringify(call.arguments ?? {}).length + 24;
	return Math.ceil(chars / charsPerTokenNow());
}

// ─── The store ───────────────────────────────────────────────────────────────

const ROW_SPECIES = POLICY.enums.contextRowSpecies;
const hasAppliedOperation = (store, operationId) => operationId !== undefined && store.appliedOperations?.includes(String(operationId));
const markAppliedOperation = (store, operationId) => {
	if (operationId === undefined) return;
	store.appliedOperations = [...new Set([...(store.appliedOperations ?? []), String(operationId)])].slice(-POLICY.limits.context.operationReplay);
};
const empty = () => ({ version: 1, next: 1, rows: [], chat: [], nextTalk: 1, talkBindings: {}, seenUser: 0, shelf: [], dropped: [], forgottenEntries: [], appliedOperations: [], tasks: {} });
const clone = (value) => JSON.parse(JSON.stringify(value));
export const composedRows = (store) => store.rows.filter((row) => row.species === ROW_SPECIES.composed);
const activeRows = (rows) => rows.filter((row) => row.archived !== true).map(clone);
const reportNumber = (id) => Number(String(id).slice(POLICY.idPrefixes.report.length)) || 0;
const VISIBILITY = POLICY.enums.contextVisibility;
export class ContextRowError extends Error {}

// ─── No context-row species any more ────────────────────────────────────────
// An earlier version kept its own rows of notes in the context (species "curated"). They are gone:
// a note that should stay in view is a ledger note carrying salience (src/ledger.mjs), which rides
// in every request like the rest of the ledger and in the collapse block with a ● mark. What
// remains here are the report rows of finished work (species "composed"). loadContext folds any
// legacy curated rows into the ledger on first read after the update.

const visibleNow = (when) => when === undefined || when === VISIBILITY.now;
const rowSnapshot = (rows) => activeRows(rows).map(({ species, id, text, status, outcome, ref, at, mode, item, brief, failed, undone, changed }) => ({ species, id, text, status, outcome, ref, at, mode, item, brief, failed, undone, changed }));
const rowContent = (row) => recordLine(row);

/** Fold legacy curated rows into the ledger, once: an open row becomes a salient note, a closed one a closed note, an archived one an archived note. Deduped against what the ledger already holds, so an interrupted migration can be resumed safely. Reports nothing unless the ledger can be read; a ledger that cannot be read leaves the rows in the store untouched. */
function migrateCuratedRows(brainDir, rows) {
	try {
		const { ledger } = loadLedger(brainDir);
		if (ledger === undefined) return false;
		const TEXT_MAX = POLICY.limits.ledger.textChars;
		const norm = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
		let next = ledger.next;
		for (const row of rows) {
			const text = norm(row.text);
			if (text === "") continue;
			const wantSalient = row.status !== POLICY.enums.entryStatus.done && row.archived !== true;
			const dupe = ledger.items.find((item) => item.kind === POLICY.enums.ledgerKind.note && norm(item.text) === text);
			if (dupe !== undefined) {
				if (wantSalient && dupe.status === POLICY.enums.entryStatus.open && dupe.archived !== true) dupe.salient = true;
				continue;
			}
			const entry = { id: `n${next}`, kind: POLICY.enums.ledgerKind.note, text, added: row.added ?? new Date().toISOString() };
			next++;
			if (row.status === POLICY.enums.entryStatus.done) {
				entry.status = POLICY.enums.entryStatus.done;
				entry.closed = row.closed ?? entry.added;
				const outcome = norm(row.outcome);
				if (outcome !== "") entry.outcome = outcome;
			} else {
				entry.status = POLICY.enums.entryStatus.open;
				if (wantSalient) entry.salient = true;
			}
			if (row.archived === true) entry.archived = true;
			ledger.items.push(entry);
		}
		ledger.next = next;
		saveLedger(brainDir, ledger);
		return true;
	} catch {
		return false;
	}
}

/** What is kept for the next collapse. A file that cannot be read counts as an empty one. */
export function loadContext(brainDir) {
	const path = contextPath(brainDir);
	if (!existsSync(path)) return empty();
	try {
		const store = JSON.parse(readFileSync(path, "utf8"));
		if (store === null || typeof store !== "object" || Array.isArray(store)) return empty();
		const base = empty();
		// Version 1 stored task reports in `records`. Migrate them in memory to the tagged row collection;
		// the next ordinary write persists the new form, while report ids and files remain untouched.
		if (!Array.isArray(store.rows)) {
			store.rows = (Array.isArray(store.records) ? store.records : []).map((record) => ({
				...record,
				species: ROW_SPECIES.composed,
				ref: { type: "report", id: record.id },
			}));
		}
		const legacyCurated = store.rows.filter((row) => row.species === "curated");
		if (legacyCurated.length > 0 && migrateCuratedRows(brainDir, legacyCurated)) {
			store.rows = store.rows.filter((row) => row.species !== "curated");
			delete store.curatedNext;
			// Persist the cleaned store, so the fold happens once and not on every later read.
			saveContext(brainDir, store);
		}
		for (const row of store.rows) {
			if (row.species === undefined) row.species = ROW_SPECIES.composed;
			if (row.species === ROW_SPECIES.composed) row.ref ??= { type: "report", id: row.id };
		}
		delete store.records;
		for (const key of ["chat", "shelf", "dropped"]) if (!Array.isArray(store[key])) store[key] = base[key];
		let nextTalk = 1;
		for (const [index, entry] of store.chat.entries()) {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
				store.chat[index] = { id: `talk:${nextTalk++}`, who: "user", at: 0, text: String(entry ?? "") };
				continue;
			}
			const found = /^talk:(\d+)$/.exec(typeof entry.id === "string" ? entry.id : "");
			if (found !== null) nextTalk = Math.max(nextTalk, Number(found[1]) + 1);
			else entry.id = `talk:${nextTalk++}`;
			// A source is optional for records written before source identities existed. New mutations refuse those rows
			// rather than guessing from equal words.
			if (entry.source === null || typeof entry.source !== "object" || Array.isArray(entry.source)) delete entry.source;
		}
		if (!Number.isInteger(store.nextTalk) || store.nextTalk < nextTalk) store.nextTalk = nextTalk;
		if (store.talkBindings === null || typeof store.talkBindings !== "object" || Array.isArray(store.talkBindings)) store.talkBindings = {};
		for (const [key, source] of Object.entries(store.talkBindings)) if (talkSourceKey(source) === undefined || !/^(?:chat-call|tool-call):/.test(key)) delete store.talkBindings[key];
		const typeShelfItem = (item, index, scope) => ({
			...item,
			type: item?.ref !== undefined ? "reference" : "file",
			id: typeof item?.id === "string" && /^sh(\d+|-[A-Za-z0-9-]+)$/.test(item.id) ? item.id : legacyShelfId(item, index, scope),
		});
		store.shelf = store.shelf.map((item, index) => typeShelfItem(item, index, "main"));
		if (store.front && Array.isArray(store.front.shelf)) {
			store.front.shelf = store.front.shelf.map((item, index) => ({
				...item,
				id: typeof item?.id === "string" && /^sh(\d+|-[A-Za-z0-9-]+)$/.test(item.id)
					? item.id
					: store.shelf.find((entry) => sameShelfItem(entry, item))?.id ?? legacyShelfId(item, index, "main"),
			}));
		}
		if (store.tasks === null || typeof store.tasks !== "object" || Array.isArray(store.tasks)) store.tasks = {};
		for (const [conversationId, task] of Object.entries(store.tasks)) {
			if (Array.isArray(task?.shelf)) task.shelf = task.shelf.map((item, index) => typeShelfItem(item, index, conversationId));
		}
		const highestReport = Math.max(0, ...composedRows(store).map((row) => reportNumber(row.id)));
		if (!Number.isInteger(store.next) || store.next <= highestReport) store.next = highestReport + 1;
		if (!Number.isFinite(store.seenUser)) store.seenUser = 0;
		if (!Array.isArray(store.forgottenEntries)) store.forgottenEntries = [];
		if (!Array.isArray(store.appliedOperations)) store.appliedOperations = [];
		const pendingForget = readSoftForgetPending(brainDir);
		if (pendingForget.length > 0) {
			const removed = applySoftForgetPending(store, pendingForget);
			if (removed.length > 0) cleanupShelfSnapshots(brainDir, removed, store);
		}
		if (store.front && !Array.isArray(store.front.rows)) store.front.rows = rowSnapshot(store.rows);
		if (store.front && !Array.isArray(store.front.left)) store.front.left = [];
		return store;
	} catch {
		return empty();
	}
}

export function saveContext(brainDir, store) {
	const path = contextPath(brainDir);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(store, null, "\t")}\n`);
	renameSync(temp, path);
}

/** Change the store in one step. */
export function updateContext(brainDir, change) {
	const store = loadContext(brainDir);
	const result = change(store);
	saveContext(brainDir, store);
	const pendingForget = readSoftForgetPending(brainDir);
	if (pendingForget.length > 0 && pendingForget.every((entry) => store.forgottenEntries?.includes(entry.entryId))) {
		try { unlinkSync(softForgetPath(brainDir)); } catch { /* best effort */ }
	}
	return result;
}

// ─── The record ──────────────────────────────────────────────────────────────

/** The id the next finished task is recorded under. */
export function reserveId(brainDir) {
	return updateContext(brainDir, (store) => `${POLICY.idPrefixes.report}${store.next++}`);
}

/** The first line of a report that says something. */
function outcomeOf(report) {
	const line = String(report ?? "")
		.split("\n")
		.map((entry) => entry.replace(/^[#>*\-\s]+/, "").trim())
		.find((entry) => entry !== "" && entry.toUpperCase() !== POLICY.sentinels.reportHeading);
	return oneLine(line ?? "(nothing written)", POLICY.limits.context.recordSummaryChars);
}

/**
 * Keep a finished task: its report as a file, and one line for the record. Doing it twice for one id changes nothing.
 * @param {{ id: string, at: number, mode: string, item?: string, brief: string, report: string, failed?: boolean, changed?: number }} task
 */
export function addRecord(brainDir, task) {
	mkdirSync(reportsDir(brainDir), { recursive: true });
	const head = [`Report ${task.id} · ${stamp(task.at)} · ${task.mode} task${task.move ? ` for ${task.move} r${task.revision}` : task.item ? ` for ${task.item}` : ""}${task.failed ? " · it did not end well" : task.undone ? " · returned not done" : ""}`, "", "Brief:", task.brief, "", "Report:"].join("\n");
	writeFileSync(join(reportsDir(brainDir), `${task.id}.md`), `${head}\n${task.report}\n`);
	updateContext(brainDir, (store) => {
		const record = {
			species: ROW_SPECIES.composed,
			ref: { type: "report", id: task.id },
			id: task.id,
			at: task.at,
			mode: task.mode,
			...(task.item ? { item: task.item } : {}),
			...(task.move ? { move: task.move, revision: task.revision } : {}),
			brief: oneLine(task.brief, POLICY.limits.context.briefChars),
			// What the task itself asked to be remembered by (`summary` of `return`), or the start of its report.
			outcome: String(task.summary ?? "").trim() !== "" ? oneLine(task.summary, POLICY.limits.context.summaryChars) : outcomeOf(task.report),
			...(task.failed ? { failed: true } : {}),
			...(task.undone && !task.failed ? { undone: true } : {}),
			...(task.changed > 0 ? { changed: task.changed } : {}),
		};
		const at = store.rows.findIndex((entry) => entry.species === ROW_SPECIES.composed && entry.id === task.id);
		if (at >= 0) store.rows[at] = record;
		else store.rows.push(record);
		// The report is already present in the live conversation. Reflect just this row,
		// without accidentally flushing unrelated next-boundary edits.
		reflectRows(store, VISIBILITY.now, [task.id]);
	});
}

/** A kept report in full, or undefined when there is none under this id. */
export function loadReport(brainDir, id) {
	if (!REPORT_ID.test(String(id))) return undefined;
	const path = join(reportsDir(brainDir), `${id}.md`);
	return existsSync(path) ? readFileSync(path, "utf8").trimEnd() : undefined;
}

/** What a task report says at its end, so that the agent knows the id. */
export const KEPT_AS = (id) => `This report is kept as ${id}.`;
const KEPT_ALL = new RegExp(POLICY.patterns.keptReport, "g");
/** What follows a report that `context` brought back. */
export const RECALLED = "[Recalled. It is in view until my context is next collapsed.]";
/** The id of the report a stored tool result holds in full: as the task returned it, or as it was recalled. */
function reportIdOf(message) {
	if (message.role !== "toolResult") return undefined;
	const text = textOf(message);
	// The last one counts: a report may quote the line of another.
	if (message.toolName === "task") return [...text.matchAll(KEPT_ALL)].at(-1)?.[1];
	if ((message.toolName === "context" || message.toolName === "book") && text.endsWith(RECALLED)) return RECALLED_REPORT.exec(text)?.[1];
	return undefined;
}

export const recordLine = (record) =>
	`${record.id} · ${clock(record.at)} · ${record.mode}${record.item ? ` ${record.item}` : ""} · asked: ${record.brief} → ${record.failed ? "did not end well: " : record.undone ? "not done: " : ""}${record.outcome}${record.changed ? ` · ${record.changed === 1 ? "1 file" : `${record.changed} files`} changed` : ""}`;

const checkWhen = (when) => {
	if (when !== undefined && !Object.values(VISIBILITY).includes(when)) throw new ContextRowError(`\`when\` is ${JSON.stringify(when)}; it is now or next-boundary.`);
	return when;
};
// Apply only the rows changed by this operation to the active projection. A prior
// next-boundary change to some other row must not become visible as a side effect.
function reflectRows(store, when, ids, { beforeId, reposition = false, atEnd = false } = {}) {
	if (!store.front || !visibleNow(when)) return;
	const visible = [...(store.front.rows ?? [])];
	for (const id of ids) {
		const oldAt = visible.findIndex((row) => row.id === id);
		if (oldAt >= 0) visible.splice(oldAt, 1);
		const current = store.rows.find((row) => row.id === id && row.archived !== true);
		if (current === undefined) continue;
		const snapshot = rowSnapshot([current])[0];
		if (oldAt >= 0 && !reposition) {
			visible.splice(Math.min(oldAt, visible.length), 0, snapshot);
			continue;
		}
		let at = beforeId === undefined ? -1 : visible.findIndex((row) => row.id === beforeId);
		if (at < 0 && !atEnd) {
			const ordered = store.rows.filter((row) => row.archived !== true);
			const index = ordered.findIndex((row) => row.id === id);
			for (const next of ordered.slice(index + 1)) {
				at = visible.findIndex((row) => row.id === next.id);
				if (at >= 0) break;
			}
			if (at < 0) {
				for (const previous of ordered.slice(0, index).reverse()) {
					const previousAt = visible.findIndex((row) => row.id === previous.id);
					if (previousAt >= 0) { at = previousAt + 1; break; }
				}
			}
		}
		visible.splice(at < 0 ? visible.length : at, 0, snapshot);
	}
	store.front.rows = visible;
}

/** Apply a shared archive, unarchive, or delete to any context row. The report body remains a referenced file. */
export function applyContextRowAction(brainDir, id, action, when, operationId) {
	checkWhen(when);
	if (hasAppliedOperation(loadContext(brainDir), operationId)) {
		if (action === POLICY.enums.actions.delete) try { unlinkSync(join(reportsDir(brainDir), `${id}.md`)); } catch { /* already absent */ }
		return `${id} was already ${action} by this durable operation.`;
	}
	const row = updateContext(brainDir, (store) => {
		const found = store.rows.find((entry) => entry.id === id);
		if (found === undefined) throw new ContextRowError(`There is no context row ${JSON.stringify(id)}.`);
		if (action === POLICY.enums.actions.archive) {
			if (found.archived) throw new ContextRowError(`${id} is archived already.`);
			found.archived = true;
			if (found.species === ROW_SPECIES.composed && visibleNow(when)) store.dropped = [...new Set([...store.dropped, id])];
		} else if (action === POLICY.enums.actions.unarchive) {
			if (!found.archived) throw new ContextRowError(`${id} is not archived.`);
			delete found.archived;
			if (found.species === ROW_SPECIES.composed && visibleNow(when)) store.dropped = store.dropped.filter((entry) => entry !== id);
		} else if (action === POLICY.enums.actions.delete) {
			store.rows = store.rows.filter((entry) => entry.id !== id);
			if (visibleNow(when)) store.dropped = store.dropped.filter((entry) => entry !== id);
		} else throw new ContextRowError(`Unknown row operation ${JSON.stringify(action)}.`);
		reflectRows(store, when, [id]);
		markAppliedOperation(store, operationId);
		return clone(found);
	});
	if (action === POLICY.enums.actions.delete && row.species === ROW_SPECIES.composed) {
		try { unlinkSync(join(reportsDir(brainDir), `${id}.md`)); } catch { /* A missing body does not restore its deleted row. */ }
	}
	const content = rowContent(row);
	if (action === POLICY.enums.actions.archive) return row.species === ROW_SPECIES.composed
		? `${id} archived: the record line leaves the kept block, the report stays on disk, recall by id still finds it.`
		: `${id} archived: the row leaves what the agent reads; its content remains available. ${content}`;
	if (action === POLICY.enums.actions.unarchive) return row.species === ROW_SPECIES.composed
		? `${id} back in the record: the next collapse lists its line again.`
		: `${id} is back in what the agent reads. ${content}`;
	return row.species === ROW_SPECIES.composed
		? `${id} deleted: the record line is gone and its file is gone from ${join(reportsDir(brainDir), `${id}.md`)}.`
		: `${id} deleted: the row is gone for good.`;
}

function recordText(records) {
	// A record the user has archived stands out of the block for good (its report stays, and recall knows the id);
	// only what is listed here costs the model a reading.
	const shown = records.filter((record) => record.archived !== true);
	if (shown.length === 0) return { text: records.length === 0 ? "No task has finished yet." : "No task stands in the record; older ones are archived (recall by id brings one back).", listed: 0 };
	const lines = [];
	let used = 0;
	// The budget keeps the newest; what is listed reads in the order the tasks ended.
	for (const record of [...shown].reverse()) {
		const line = recordLine(record);
		if (used + estimate(line) > RECORD_MAX_TOKENS && lines.length > 0) break;
		used += estimate(line);
		lines.unshift(line);
	}
	const older = shown.length - lines.length;
	if (older > 0) lines.unshift(`(${older} earlier ${older === 1 ? "task is" : "tasks are"} not listed, ${shown[0].id} to ${shown[older - 1].id}; their reports can still be recalled.)`);
	return { text: lines.join("\n"), listed: lines.length - (older > 0 ? 1 : 0) };
}

// ─── The talk ────────────────────────────────────────────────────────────────

/** A stable source of one kept saying. Older records may have no source; callers must not infer one from its words. */
export function talkSourceKey(source) {
	if (source === null || typeof source !== "object" || Array.isArray(source)) return undefined;
	if (source.kind === "durable-message" && typeof source.conversationId === "string" && typeof source.entryId === "string" && Number.isInteger(source.position)) return `durable-message:${source.conversationId}:${source.entryId}:${source.position}:${typeof source.callId === "string" ? source.callId : ""}`;
	if ((source.kind === "chat-call" || source.kind === "tool-call") && typeof source.conversationId === "string" && typeof source.callId === "string") return `${source.kind}:${source.conversationId}:${source.callId}`;
	return undefined;
}

const talkSourceOf = (source) => {
	const key = talkSourceKey(source);
	return key === undefined ? undefined : { ...source };
};

/** Note something the user or the agent said, for a later collapse. */
export function noteChat(brainDir, who, at, text, { seen = true, source } = {}) {
	const said = String(text ?? "").trim();
	if (said === "") return undefined;
	let stableSource = talkSourceOf(source);
	let noted;
	updateContext(brainDir, (store) => {
		const provisionalKey = talkSourceKey(stableSource);
		const bound = provisionalKey === undefined ? undefined : talkSourceOf(store.talkBindings?.[provisionalKey]);
		if (bound !== undefined) {
			stableSource = bound;
			delete store.talkBindings[provisionalKey];
		}
		const sourceKey = talkSourceKey(stableSource);
		const prior = sourceKey === undefined
			? store.chat.find((entry) => entry.who === who && entry.at === at && entry.text === said)
			: store.chat.find((entry) => talkSourceKey(entry.source) === sourceKey);
		if (prior !== undefined) {
			noted = prior;
			return;
		}
		const id = `talk:${store.nextTalk++}`;
		noted = { id, who, at, text: said, ...(stableSource === undefined ? {} : { source: stableSource }) };
		store.chat.push(noted);
		// `seen: false`: words of the user that are not a message of the conversation (an answer to `ask`, a line
		// typed to a running task), so the messages that are still count as new.
		if (who === "user" && seen) store.seenUser = Math.max(store.seenUser, at);
	});
	return noted;
}

/** Note the user's messages of a request that were not noted yet, with their Durable entry sources when available. */
export function noteUserMessages(brainDir, messages, sources = []) {
	const seen = loadContext(brainDir).seenUser;
	for (const [index, message] of messages.entries()) {
		if (message.role !== "user" || !Number.isFinite(message.timestamp) || message.timestamp <= seen || isNoteText(textOf(message)) || isFront(message)) continue;
		noteChat(brainDir, "user", message.timestamp, textOf(message), { source: sources[index] });
	}
}

/** Reword exactly one source in the mutable talk that a future collapse may keep. */
export function reviseTalkSource(brainDir, source, text) {
	const key = talkSourceKey(source);
	const next = String(text ?? "").trim();
	if (key === undefined || next === "") return false;
	let changed = false;
	updateContext(brainDir, (store) => {
		const entry = store.chat.find((line) => talkSourceKey(line.source) === key);
		if (entry === undefined || entry.text === next) return;
		entry.text = next;
		changed = true;
	});
	return changed;
}

/** Replace one provisional tool-call source with its admitted Durable entry source. */
export function bindTalkSource(brainDir, from, source) {
	const fromKey = talkSourceKey(from);
	const next = talkSourceOf(source);
	if (fromKey === undefined || next === undefined) return false;
	let changed = false;
	updateContext(brainDir, (store) => {
		const entry = store.chat.find((line) => talkSourceKey(line.source) === fromKey);
		if (entry === undefined) {
			// Durable records an assistant entry before its tool runs on some paths. Keep this exact call-to-entry
			// binding until the tool writes its talk record; no visible wording is used to join them.
			store.talkBindings[fromKey] = next;
			changed = true;
			return;
		}
		entry.source = next;
		delete store.talkBindings[fromKey];
		changed = true;
	});
	return changed;
}

/** Remove exactly one source from the mutable talk that a future collapse may keep. */
export function removeTalkSource(brainDir, source) {
	const key = talkSourceKey(source);
	if (key === undefined) return false;
	let changed = false;
	updateContext(brainDir, (store) => {
		const at = store.chat.findIndex((line) => talkSourceKey(line.source) === key);
		if (at < 0) return;
		store.chat.splice(at, 1);
		changed = true;
	});
	return changed;
}

const isNoteText = (text) => text.startsWith(`${NOTE_OPEN}\n${HEAD}`);
export const chatLine = (entry) => `${clock(entry.at)}  ${entry.who === "user" ? USER_NAME : "me"}: ${entry.text}`;

/** The newest sayings that fit into `max` tokens; the newest one is kept whatever its size. */
function chatWindow(chat, max) {
	const kept = [];
	let used = 0;
	for (const entry of [...chat].reverse()) {
		const size = estimate(chatLine(entry));
		if (used + size > max && kept.length > 0) break;
		used += size;
		kept.unshift(entry);
	}
	return kept;
}

// ─── The shelf ───────────────────────────────────────────────────────────────

export class ShelfError extends Error {}

/** "10-80" → { from: 10, to: 80 }; nothing → the whole file. */
export function parseLines(lines) {
	if (lines === undefined || lines === null || String(lines).trim() === "") return {};
	const found = /^\s*(\d+)\s*(?:-|to|\.\.)\s*(\d+)\s*$/.exec(String(lines));
	if (!found) throw new ShelfError('`lines` is a range like "10-80"; leave it out for the whole file.');
	const from = Number(found[1]);
	const to = Number(found[2]);
	if (from < 1 || to < from) throw new ShelfError(`lines ${from}-${to} is not a range: the first line is 1 and the second number is the last line.`);
	return { from, to };
}


// ─── Soft-forget crash recovery ───────────────────────────────────────────────
// `message edit` writes the durable soft-forget marker first, then updates this store. A crash between the two leaves the
// message forgotten in the transcript and visible here. The pending sidecar carries everything the store needs to finish
// the job by itself on the next load — no Durable access required, and no writes on read.
const softForgetPath = (brainDir) => join(brainDir, "catalog", "soft-forget.pending.json");

/** Record a pending soft-forget. Called after the durable marker commits, before the store update. */
export function recordSoftForgetPending(brainDir, entry) {
	const path = softForgetPath(brainDir);
	mkdirSync(dirname(path), { recursive: true });
	let pending = [];
	try { const value = JSON.parse(readFileSync(path, "utf8")); if (Array.isArray(value?.entries)) pending = value.entries; } catch { /* a corrupt sidecar is replaced, never trusted */ }
	pending = [...pending.filter((prior) => prior?.entryId !== entry.entryId), { ...entry, at: entry.at ?? Date.now() }];
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, `${JSON.stringify({ version: 1, entries: pending })}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

const readSoftForgetPending = (brainDir) => {
	try {
		const value = JSON.parse(readFileSync(softForgetPath(brainDir), "utf8"));
		if (value?.version !== 1 || !Array.isArray(value.entries)) return [];
		return value.entries.filter((entry) => entry && typeof entry.entryId === "string" && entry.entryId.length > 0);
	} catch { return []; }
};

const applySoftForgetPending = (store, pending) => {
	const ids = new Set(pending.map((entry) => entry.entryId));
	store.forgottenEntries = [...new Set([...(store.forgottenEntries ?? []), ...ids])];
	// A soft-forget acts on one Durable entry. Do not take an equal saying out of kept talk: legacy rows with no
	// source remain visible until someone deliberately changes that source.
	store.chat = (store.chat ?? []).filter((line) => !ids.has(String(line.source?.entryId ?? "")));
	for (const [key, source] of Object.entries(store.talkBindings ?? {})) if (ids.has(String(source?.entryId ?? ""))) delete store.talkBindings[key];
	const removed = [];
	const strip = (shelf) => (Array.isArray(shelf) ? shelf.filter((placement) => {
		if (placement?.target?.kind === "message" && ids.has(String(placement.target.id))) { removed.push(placement); return false; }
		return true;
	}) : shelf);
	store.shelf = strip(store.shelf);
	if (store.front && Array.isArray(store.front.shelf)) store.front.shelf = strip(store.front.shelf);
	for (const task of Object.values(store.tasks ?? {})) if (Array.isArray(task?.shelf)) task.shelf = strip(task.shelf);
	return removed;
};

/** Resolve a typed reference to the full content the shelf should show. Add resolvers here, not kind-specific shelf flows. */
// Live Durable content cannot be read synchronously on the render path, so Durable kinds render from the backing
// snapshot taken when they were shelved (immutable content — for those, the snapshot is the live bytes), or from an
// explicitly retained pinned version when one exists. `Not found.` below is the one unified wording for every ref kind.
const pinnedText = (brainDir, ref) => {
	if (ref.version === undefined) return undefined;
	const value = readReferenceVersion(brainDir, { namespace: ref.namespace, kind: ref.type ?? ref.kind, id: ref.id, version: ref.version });
	return value === undefined ? undefined : JSON.stringify(value, null, 2);
};
const snapshotText = (brainDir, item) => readShelfSnapshot(brainDir, item);
const SHELF_RESOLVERS = {
	// A story stands in the brain whole; the shelf carries the exchange for whoever asked. The path is never shown.
	story: (brainDir, ref, item) => {
		if (!STORY_ID.test(String(ref.id))) return undefined;
		const raw = readStory(brainDir, ref.id);
		if (raw !== undefined) {
			try {
				return renderStory(parseStory(raw).rounds);
			} catch { /* fall back to the shelf's own backing snapshot */ }
		}
		return snapshotText(brainDir, item);
	},
	report: (brainDir, ref, item) => {
		const row = composedRows(loadContext(brainDir)).find((entry) => entry.id === ref.id);
		if (row !== undefined) { const body = loadReport(brainDir, ref.id); if (body !== undefined) return body; }
		return pinnedText(brainDir, ref) ?? snapshotText(brainDir, item);
	},
	schema: (brainDir, ref, item) => pinnedText(brainDir, ref) ?? snapshotText(brainDir, item),
	message: (brainDir, ref, item) => pinnedText(brainDir, ref) ?? snapshotText(brainDir, item),
	toolCall: (brainDir, ref, item) => pinnedText(brainDir, ref) ?? snapshotText(brainDir, item),
	toolResult: (brainDir, ref, item) => pinnedText(brainDir, ref) ?? snapshotText(brainDir, item),
};
const referenceOf = (given) => {
	if (given !== null && typeof given === "object" && typeof given.kind === "string" && typeof given.id === "string") {
		return { type: given.kind, id: given.id, ...(given.namespace ? { namespace: given.namespace } : {}), ...(given.version ? { version: given.version } : {}) };
	}
	const match = /^([a-z][a-z0-9_-]*):(.+)$/.exec(String(given ?? ""));
	return match === null ? undefined : { type: match[1], id: match[2] };
};

/** Render the selected view of a full backing file snapshot. */
function formatShelfFile(path, content, item, { validateRange = false } = {}) {
	const lines = String(content).split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length === 0) return `== ${path}\n(empty file)`;
	const first = item.from ?? 1;
	const requestedLast = item.to ?? lines.length;
	if (first > lines.length) {
		if (validateRange) throw new ShelfError(`The file has ${lines.length} lines; line ${first} does not exist.`);
		return `== ${path}\nThe saved range ${first}-${requestedLast} is unavailable: the file has ${lines.length} lines.`;
	}
	const last = Math.min(lines.length, requestedLast, first + SHELF_MAX_LINES - 1);
	const width = String(last).length;
	const clip = POLICY.limits.look.lineChars;
	const body = lines.slice(first - 1, last).map((line, i) => {
		const shown = line.length > clip ? `${line.slice(0, clip)} …[line cut, ${line.length} characters]` : line;
		return `${String(first + i).padStart(width)}  ${shown}`;
	});
	const remaining = requestedLast < lines.length ? `\n(${Math.min(requestedLast, lines.length) - last} more selected lines; expand or change the range)` : last < lines.length ? `\n(${lines.length - last} more lines; continue with offset ${last + 1})` : "";
	return `== ${path} (lines ${first}-${last} of ${lines.length})\n${body.join("\n")}${remaining}`;
}

/** Read the whole live source, refusing directories, binary files, and unsafe paths. */
function liveShelfSource(root, item) {
	let path;
	try {
		path = confine(root, item.path);
	} catch (error) {
		return { error: error instanceof LookError ? error.message : String(error) };
	}
	if (!existsSync(path.abs)) return undefined;
	try {
		const stat = statSync(path.abs);
		if (!stat.isFile()) return { error: `${path.rel} is not a regular file.` };
		const buffer = readFileSync(path.abs);
		if (buffer.subarray(0, POLICY.limits.look.binaryProbeChars).includes(0)) return { error: `${path.rel} is binary and cannot be snapshotted as text.` };
		return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer), path: path.rel };
	} catch (error) {
		return { error: `${path.rel} cannot be read or snapshotted: ${error.message}` };
	}
}

function readShelfSnapshot(brainDir, item) {
	if (typeof item.id !== "string") return undefined;
	try {
		const path = safeShelfSnapshotPath(brainDir, item);
		return existsSync(path) ? readFileSync(path, "utf8") : undefined;
	} catch { return undefined; }
}

/** Persist a full backing snapshot atomically under .brain/shelf; callers validate context budget first. Skips the write when the backing is unchanged. */
export function persistShelfSnapshot(brainDir, item, content) {
	if ((item?.type !== "file" && item?.type !== "reference") || typeof content !== "string") return;
	const path = safeShelfSnapshotPath(brainDir, item, { create: true });
	if (existsSync(path)) {
		try { if (readFileSync(path, "utf8") === content) return; } catch { /* an unreadable snapshot is overwritten */ }
	}
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, content, { encoding: "utf8", flag: "wx" });
		renameSync(temp, path);
	} catch (error) {
		try { unlinkSync(temp); } catch { /* no temporary file */ }
		throw new ShelfError(`Could not save the full snapshot for ${shelfLabel(item)}: ${error.message}`);
	}
}

/** Resolve the current selected content. A missing or unreadable source falls back to the full shelf snapshot. */
function resolveShelfText(root, item, brainDir) {
	if (item.ref !== undefined) {
		const content = SHELF_RESOLVERS[item.ref.type]?.(brainDir, item.ref, item);
		return content === undefined ? `== ${shelfLabel(item)} ==\nNot found. The referenced item is no longer available.` : `== ${shelfLabel(item)} ==\n${content}`;
	}
	const live = liveShelfSource(root, item);
	if (live?.content !== undefined) return formatShelfFile(item.path, live.content, item);
	const saved = readShelfSnapshot(brainDir, item);
	if (saved !== undefined) return formatShelfFile(item.path, saved, item);
	return item.snapshot ?? `== ${shelfLabel(item)}\nNot found. The source and its full shelf snapshot are unavailable.`;
}

/** The saved selected view is what stays in context; resolution detects changes and refreshes at collapse. */
export function shelfText(root, item, brainDir) {
	return typeof item.snapshot === "string" ? item.snapshot : resolveShelfText(root, item, brainDir);
}

/** Whether a shelf snapshot still describes the source it was taken from. The saved snapshot remains evidence even
 * when it has changed; callers use this only to label it honestly, never to replace it invisibly. */
export function shelfFreshness(root, item, brainDir) {
	try {
		const current = shelfIdLine(resolveShelfText(root, item, brainDir), item);
		if (typeof item?.snapshot !== "string") return { state: "unknown" };
		if (current === item.snapshot) return { state: "current" };
		if (/\nNot found\. /.test(current)) return { state: "stale" };
		return { state: "changed" };
	} catch (error) {
		return { state: "stale", why: error instanceof Error ? error.message : String(error) };
	}
}

export const shelfLabel = (item) => item.ref === undefined ? `${item.path}${item.from === undefined ? "" : ` (lines ${item.from}-${item.to})`}` : `${item.ref.type}:${item.ref.id}`;
export const sameShelfItem = (a, b) => a.ref !== undefined || b.ref !== undefined
	? a.ref?.type === b.ref?.type && a.ref?.id === b.ref?.id
	: a.path === b.path;

/**
 * Resolve a project path/range or typed reference; file backing snapshots are always full-file text.
 * @returns {{ item: object, tokens: number, backing?: string }}
 */
export function shelfItem(root, given, lines, brainDir, existing = []) {
	const ref = referenceOf(given);
	if (ref !== undefined && SHELF_RESOLVERS[ref.type] !== undefined) {
		if (ref.type === "schema" && (typeof ref.namespace !== "string" || typeof ref.version !== "string")) throw new ShelfError("A schema shelf placement needs a version-pinned schema reference.");
		const item = { type: "reference", ref, id: existing.find((entry) => sameShelfItem(entry, { ref }))?.id ?? nextShelfId(brainDir, existing) };
		const text = resolveShelfText(root, item, brainDir);
		if (/\nNot found\. /.test(text)) throw new ShelfError(text.split("\n").slice(1).join(" "));
		return { item: { ...item, snapshot: shelfIdLine(text, item) }, tokens: estimate(shelfIdLine(text, item)), backing: text };
	}
	let path;
	try {
		path = confine(root, given);
	} catch (error) {
		if (error instanceof LookError) throw new ShelfError(error.message);
		throw error;
	}
	const selected = { type: "file", path: path.rel, ...parseLines(lines) };
	const prior = existing.find((entry) => sameShelfItem(entry, selected));
	if (!existsSync(path.abs) && prior === undefined) throw new ShelfError(`${path.rel} does not exist. The tree in the state block shows the files.`);
	if (existsSync(path.abs)) {
		try {
			if (!statSync(path.abs).isFile() && prior === undefined) throw new ShelfError(`${path.rel} is a directory: the shelf holds files, or line ranges of files.`);
		} catch (error) {
			if (error instanceof ShelfError) throw error;
			if (prior === undefined) throw new ShelfError(`${path.rel} cannot be read: ${error.message}`);
		}
	}
	const item = { ...selected, id: prior?.id ?? nextShelfId(brainDir, existing) };
	// Preserve the shelf placement ID separately from the stable target identity. `.cartoignore` only affects
	// ambient discovery; an explicit shelf operation is allowed to catalog this confined project file.
	if (existsSync(path.abs)) {
		try { item.target = fileReference(root, brainDir, path.rel); }
		catch (error) { throw new ShelfError(`Could not record the stable identity for ${path.rel}: ${error.message}`); }
	}
	const live = liveShelfSource(root, item);
	let backing = live?.content;
	if (live?.error && prior === undefined) throw new ShelfError(live.error);
	if (backing === undefined) {
		backing = readShelfSnapshot(brainDir, prior ?? item);
		if (backing === undefined) throw new ShelfError(`${path.rel} is unavailable and has no full shelf snapshot to fall back to.`);
	}
	const text = formatShelfFile(path.rel, backing, item, { validateRange: true });
	const snapshot = shelfIdLine(text, item);
	return { item: { ...item, snapshot }, tokens: estimate(snapshot), backing };
}

/** Build a reference shelf placement from content already verified at add time (the render path has no Durable access). */
export function shelfReferenceItem(ref, content, brainDir, existing = []) {
	const normalized = { type: ref.kind ?? ref.type, id: ref.id, ...(ref.namespace ? { namespace: ref.namespace } : {}), ...(ref.version ? { version: ref.version } : {}) };
	if (typeof normalized.type !== "string" || typeof normalized.id !== "string") throw new ShelfError("A { kind, id, namespace?, version? } reference is required.");
	const item = { type: "reference", ref: normalized, id: existing.find((entry) => sameShelfItem(entry, { ref: normalized }))?.id ?? nextShelfId(brainDir, existing) };
	const text = `== ${normalized.type}:${normalized.id} ==\n${content}`;
	const snapshot = shelfIdLine(text, item);
	return { item: { ...item, snapshot }, tokens: estimate(snapshot), backing: content };
}

/** The shelf's soft cap: half the window. Nothing refuses at it; the status block tells the agent to make room as it fills. */
export const shelfSpace = (window) => Math.max(1, Math.floor((Number.isFinite(window) && window > 0 ? window : POLICY.validation.minimumTokenSetting * 2) / 2));

/** The line the state block adds about the shelf: how full it is, in the agent's own words and as a share of shelf space. */
function shelfFillLine(root, brainDir, items, window) {
	const total = items.reduce((sum, item) => {
		try { return sum + estimate(shelfText(root, item, brainDir)); } catch { return sum; }
	}, 0);
	const space = shelfSpace(window);
	const percent = Math.round((total / space) * 100);
	const files = items.length === 1 ? "My file is" : "My files are";
	const filled = `${files} taking up ${percent}% of shelf space (about ${count(total)} of ${count(space)} tokens)`;
	if (percent < 50) return `${filled}.`;
	if (percent < 75) return `${filled} — I should leave room on it: fold or unshelve what I no longer need.`;
	if (percent < 100) return `${filled} — I need to trim it now: fold or unshelve what I no longer need.`;
	return `${filled} — I NEED to take something off it NOW; the shelf is over what it holds.`;
}

/** Resolve, refresh and render shelf items without discarding entries that do not currently fit. */
function shelfBlock(root, items, max, brainDir) {
	const shown = [];
	const left = [];
	const stale = [];
	const refreshedItems = [];
	let used = 0;
	for (const original of items) {
		let item = { ...original };
		let text;
		if (item.ref === undefined) {
			const live = liveShelfSource(root, item);
			if (live?.content !== undefined) {
				if (item.target === undefined) {
					const mapped = fileIdentityForPath(brainDir, item.path);
					if (mapped !== undefined) item.target = mapped;
					// Never observe from a render path: identity is adopted for display and persists with the next store write.
				}
				try {
					persistShelfSnapshot(brainDir, item, live.content);
					text = formatShelfFile(item.path, live.content, item);
				} catch (error) {
					stale.push({ item, why: error.message });
					const saved = readShelfSnapshot(brainDir, item);
					text = saved === undefined ? item.snapshot ?? `== ${shelfLabel(item)}\nNot found. The full shelf snapshot could not be saved.` : formatShelfFile(item.path, saved, item);
				}
			} else {
				const saved = readShelfSnapshot(brainDir, item);
				text = saved === undefined
					? item.snapshot ?? `== ${shelfLabel(item)}\nNot found. The source and full shelf snapshot are unavailable.`
					: formatShelfFile(item.path, saved, item);
				stale.push({ item, why: live?.error ?? (saved === undefined ? "the source file is gone and no full backing snapshot exists; retaining the legacy rendered view" : "the source file is gone; using the full shelf snapshot") });
			}
		} else text = resolveShelfText(root, item, brainDir);
		text = shelfIdLine(text, item);
		item.snapshot = text;
		refreshedItems.push(item);
		const size = estimate(text);
		if (/\nNot found\. /.test(text)) {
			left.push({ item, why: "the source and its snapshot are unavailable" });
			continue;
		}
		if (used + size > max) {
			left.push({ item, why: `it does not fit in the remaining context shelf budget (about ${count(size)} tokens)` });
			continue;
		}
		used += size;
		shown.push({ item, text, hash: hashOf(text) });
	}
	return { shown, left, stale, items: refreshedItems, tokens: used };
}

// ─── The front block ─────────────────────────────────────────────────────────

/** The heading of the finished-tasks section in the collapse block; written and dressed identically. */
const REPORT_HEADING = "Finished tasks (`book` with target=context, action=recall, id brings a report back in full)";
const LEGACY_REPORT_HEADING = "Finished tasks (`book` with book context, action recall and the id brings a report back in full)";
/** The heading of the salient-notes section in the collapse block; written and dressed identically. */
const SALIENT_HEADING = "Salient notes (ledger notes marked salient; `book` with target=ledger, action=edit, id, salient: false drops the mark)";
/** One salient line of the front block: the minute the note was taken, then the entry. Written and re-dressed identically. */
const salientLine = (item) => `${clock(item.added)}  ${entryLine(item)}`;
/** The prefix of the shelf section's heading; dressFrontRows finds the section by it. */
const SHELF_PREFIX = "Shelf at ";
/** The salient open notes to show in the block, re-read from the ledger; a ledger that cannot be read shows none. */
const salientFrom = (brainDir) => {
	try {
		const { ledger } = loadLedger(brainDir);
		return ledger === undefined ? [] : salientNotes(ledger);
	} catch {
		return [];
	}
};

/** Whether a stored message is a front block. */
export const isFront = (message) => message?.role === "user" && textOf(message).startsWith(`${OPEN}\n${HEAD}`);

/** Text with every front block removed (for the tests' stand-in, and for display). */
export const withoutFront = (text) => text.replace(FRONT_BLOCK, "");

/**
 * The calls of the stretch before the collapse, as one line each: the minute, the call, its outcome. The newest
 * that fit under `callsTokens`; what is older is counted, not listed.
 * @param {{ at?: number, text: string, outcome: string }[]} calls  oldest first
 */
function callLines(calls) {
	const lines = calls.map((call) => `${call.at !== undefined ? clock(call.at) : "--:--"}  ${call.text} → ${call.outcome}`);
	const budget = POLICY.limits.context.callsTokens;
	const kept = [];
	let used = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const size = estimate(lines[i]);
		if (used + size > budget && kept.length > 0) break;
		used += size;
		kept.unshift(lines[i]);
	}
	const older = lines.length - kept.length;
	return [...(older > 0 ? [`(${older} earlier ${older === 1 ? "call is" : "calls are"} not listed.)`] : []), ...kept];
}

/**
 * Write the front block for a collapse that happens now, and remember what it holds.
 * @param {string} brainDir
 * @param {string} root
 * @param {{ chatWindow: number, contextWindow: number }} config
 * @param {{ now: number, reason: string, midTurn?: { by: "user" | "note", reminded: boolean, note?: string, calls: { text: string, result: string }[] }, calls?: { at?: number, text: string, outcome: string }[] }} input
 * @returns {{ text: string, kept: { tasks: number, shelf: number, talk: number }, tokens: { record: number, shelf: number, talk: number, now: number, calls: number, total: number }, left: { item: object, why: string }[] }}
 */
export function writeFront(brainDir, root, config, { now, reason, midTurn, calls }) {
	return updateContext(brainDir, (store) => {
		const record = recordText(composedRows(store));
		const salient = salientFrom(brainDir);
		const shelf = shelfBlock(root, store.shelf, shelfSpace(config?.contextWindow), brainDir);
		// Items that cannot be rendered right now remain shelved with their stable IDs and backing snapshots.
		store.shelf = shelf.items;
		store.chat = chatWindow(store.chat, config.chatWindow);
		const talk = store.chat.map(chatLine).join("\n");
		const calls_ = Array.isArray(calls) ? callLines(calls) : [];
		const parts = [
			OPEN,
			`${HEAD} My context was collapsed at ${clock(now)} (${reason}). What I had in view before is gone except for what stands here: the finished tasks,${salient.length > 0 ? " my salient notes," : ""} my shelf, the last of my talk with ${USER_NAME}, and the calls of the stretch before the collapse. My ledger, plan, graph and assessment are as I left them; the state block at the end of the request shows them.`,
			"",
			REPORT_HEADING,
			record.text,
			...(salient.length > 0 ? ["", SALIENT_HEADING, ...salient.map(salientLine)] : []),
			"",
			`${SHELF_PREFIX}${clock(now)} · ${shelf.shown.length === 0 ? "empty" : `${shelf.shown.length === 1 ? "1 item" : `${shelf.shown.length} items`}, as the files were at the collapse`}`,
			...shelf.shown.map((entry) => `${clock(now)}  ${shelfLabel(entry.item)} [${entry.item.id}]`),
			...(shelf.shown.length > 0 ? [""] : []),
			...shelf.shown.map((entry) => entry.text),
			...shelf.left.map((entry) => `(${shelfLabel(entry.item)} [${entry.item.id}] remains on the shelf but is not shown: ${entry.why}.)`),
			...shelf.stale.map((entry) => `(${shelfLabel(entry.item)} [${entry.item.id}] is stale: ${entry.why}.)`),
			"",
			store.chat.length === 0 ? `${USER_HEAD} and I have not talked yet.` : `Talk with ${USER_NAME}, word for word, in order; what was said before ${clock(store.chat[0].at)} is gone`,
			...(talk === "" ? [] : [talk]),
			...(calls_.length > 0 ? ["", "Calls of the stretch before the collapse (the minute, the call, its outcome; the newest that fit stand here)", ...calls_] : []),
		];
		let nowText = "";
		if (midTurn !== undefined) {
			const lines = ["", "This collapse came in the middle of my turn, so the turn goes on."];
			if (midTurn.by === "note" && midTurn.note) lines.push(`The turn began with a note I wrote, not with a message of ${USER_NAME}:\n${midTurn.note}`);
			if (midTurn.calls.length > 0) {
				lines.push("The calls of my last reply, all carried out, and what each returned:");
				for (const call of midTurn.calls) {
					const result = call.result.length > NOW_MAX_CHARS ? `${call.result.slice(0, NOW_MAX_CHARS)}\n…[cut here; a report can be recalled in full by its id]` : call.result;
					lines.push(`▸ ${call.text}\n${result}`);
				}
			}
			lines.push("I go on from here: do what is left of the turn, or end it.");
			nowText = lines.join("\n");
			parts.push(nowText);
		}
		parts.push(CLOSE);
		const text = parts.join("\n");
		const tokens = { record: estimate(record.text), shelf: shelf.tokens, talk: estimate(talk), now: estimate(nowText), calls: estimate(calls_.join("\n")), total: estimate(text) };
		store.dropped = [];
		store.front = {
			at: now,
			reason,
			rows: rowSnapshot(store.rows),
			shelf: shelf.shown.map((entry) => ({ ...entry.item, hash: entry.hash })),
			left: shelf.left.map((entry) => ({ id: entry.item.id, hash: hashOf(entry.item.snapshot ?? ""), why: entry.why })),
			tokens,
			kept: { tasks: record.listed, shelf: shelf.shown.length, talk: store.chat.length },
			...(midTurn !== undefined ? { midTurn: { by: midTurn.by, reminded: midTurn.reminded } } : {}),
		};
		return { text, kept: store.front.kept, tokens, left: shelf.left };
	});
}

/** Forget what a fresh context should not show: the talk, the record's lines and the shelf. Reports stay recallable. */
export function clearFront(brainDir) {
	const before = loadContext(brainDir);
	updateContext(brainDir, (store) => {
		store.chat = [];
		store.rows = store.rows.filter((row) => row.species !== ROW_SPECIES.composed);
		store.shelf = [];
		store.dropped = [];
		store.front = undefined;
	});
	cleanupShelfSnapshots(brainDir, before.shelf);
}

/**
 * How much of a context would go at a collapse: everything behind the front block that is not talk.
 * @param {readonly any[]} messages the stored messages of the main conversation
 */
export function droppable(messages) {
	let total = 0;
	for (const message of messages) {
		if (isFront(message)) continue;
		if (message.role === "user" && !isNoteText(textOf(message))) continue;
		if (message.role === "assistant") {
			// What was said with `chat` moves into the talk.
			const said = callsOf(message).filter((call) => call.name === "chat").reduce((sum, call) => sum + estimate(call.arguments?.text), 0);
			total += Math.max(0, messageTokens(message) - said);
		} else total += messageTokens(message);
	}
	return total;
}

/**
 * A focus owns its local shelf and receives only launch-captured evidence. It never silently inherits the whole
 * main shelf: a task needs a stable capsule, not the orchestrator's changing working set.
 */
function effectiveShelfFor(store, main, conversationId) {
	if (main !== false) return { activeShelf: store.shelf, shown: store.front?.shelf ?? [], deferred: store.front?.left ?? [] };
	const focus = conversationId !== undefined ? store.tasks[conversationId] : undefined;
	const evidence = Array.isArray(focus?.evidence) ? focus.evidence.map((entry) => entry.item).filter((item) => item !== undefined) : [];
	const focusShelf = Array.isArray(focus?.shelf) ? focus.shelf : [];
	const merged = [...evidence];
	for (const local of focusShelf) {
		if (!merged.some((entry) => entry.id === local.id || sameShelfItem(entry, local))) merged.push(local);
	}
	const cutShown = Array.isArray(focus?.cutShelf) ? focus.cutShelf : [];
	return { activeShelf: merged, shown: cutShown, deferred: [] };
}

/**
 * The lines the state block adds about the context: how full it is, and what on the shelf is not as shown.
 * @param {{ used?: number, window: number, main?: boolean, conversationId?: string }} size  used: the server's count for the last reply
 */
export function contextLines(brainDir, root, { used, window, main = true, conversationId }) {
	const store = loadContext(brainDir);
	const { activeShelf, shown, deferred } = effectiveShelfFor(store, main, conversationId);
	const lines = [];
	if (Number.isFinite(used) && used > 0) lines.push(`My context holds about ${count(used)} of ${count(window)} tokens.`);
	if (main === false) {
		const task = conversationId === undefined ? undefined : store.tasks[conversationId];
		if (activeShelf.length > 0) lines.push(`Focus evidence and local shelf: ${activeShelf.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}.`);
		else lines.push("Focus evidence and local shelf: empty.");
		const localShelf = Array.isArray(task?.shelf) ? task.shelf : [];
		if (localShelf.length > 0) {
			lines.push("Focus-local shelf snapshots:");
			for (const item of localShelf) lines.push(shelfText(root, item, brainDir));
		}
		if (task?.move !== undefined) {
			const surface = task.changedSurface ?? { bytes: 0, lines: 0 };
			const bytes = Math.max(0, POLICY.limits.change.surfaceBytes - (surface.bytes ?? 0));
			const rows = Math.max(0, POLICY.limits.change.surfaceLines - (surface.lines ?? 0));
			lines.push(`Direct changed surface: ${surface.bytes ?? 0}/${POLICY.limits.change.surfaceBytes} bytes and ${surface.lines ?? 0}/${POLICY.limits.change.surfaceLines} lines used; ${bytes} bytes and ${rows} lines remain. It is a hard local ceiling; file-operation count is only an anti-loop stop.`);
		}
		return `Context\n${lines.join("\n")}\n\n`;
	}
	if (activeShelf.length > 0) lines.push(shelfFillLine(root, brainDir, activeShelf, window));
	// Folding by the agent: it sees exactly which reports stand in view in full, with their size, so it can
	// decide when each has had its bookkeeping done and fold it to its one-line record (recallable by id).
	const visibleRows = store.front?.rows ?? composedRows(store).filter((record) => record.archived !== true);
	const full = visibleRows.filter((record) => record.species === ROW_SPECIES.composed && !store.dropped.includes(record.id));
	if (full.length > 0) lines.push(`In view in full: ${full.map((record) => `${record.id} (about ${count(estimate(loadReport(brainDir, record.id) ?? ""))} tokens)`).join(", ")}. I fold one with \`book\` once I have done its bookkeeping.`);
	if (store.front && Array.isArray(store.front.rows)) {
		const before = new Map(store.front.rows.map((row) => [row.id, row]));
		const after = new Map(activeRows(store.rows).map((row) => [row.id, row]));
		const added = [...after.keys()].filter((id) => !before.has(id));
		const changed = [...after.keys()].filter((id) => before.has(id) && rowContent(before.get(id)) !== rowContent(after.get(id)));
		const leaving = [...before.keys()].filter((id) => !after.has(id));
		const common = new Set([...before.keys()].filter((id) => after.has(id)));
		const priorOrder = store.front.rows.map((row) => row.id).filter((id) => common.has(id));
		const nextOrder = activeRows(store.rows).map((row) => row.id).filter((id) => common.has(id));
		if (added.length > 0) lines.push(`Rows entering context at the next boundary: ${added.join(", ")}.`);
		if (changed.length > 0) lines.push(`Rows changed for the next boundary: ${changed.join(", ")}.`);
		if (leaving.length > 0) lines.push(`Rows leaving context at the next boundary: ${leaving.map((id) => `${id} (${store.rows.some((row) => row.id === id) ? "archived" : "deleted"})`).join(", ")}.`);
		if (priorOrder.join("\0") !== nextOrder.join("\0")) lines.push(`Rows reordered for the next boundary: ${nextOrder.join(", ")}.`);
	}
	const waiting = activeShelf.filter((item) => !shown.some((entry) => sameShelfItem(entry, item)) && !deferred.some((entry) => entry.id === item.id && entry.hash === hashOf(item.snapshot ?? "")));
	const updated = activeShelf.filter((item) => shown.some((entry) => sameShelfItem(entry, item) && typeof item.snapshot === "string" && entry.hash !== hashOf(item.snapshot)));
	const stillDeferred = activeShelf.filter((item) => deferred.some((entry) => entry.id === item.id && entry.hash === hashOf(item.snapshot ?? "")));
	const leaving = shown.filter((entry) => !activeShelf.some((item) => sameShelfItem(item, entry)));
	if (waiting.length > 0 || updated.length > 0) {
		lines.push("New or updated shelf snapshots, in view now and carried into the next collapse:");
		for (const item of [...waiting, ...updated]) lines.push(shelfIdLine(shelfText(root, item, brainDir), item));
	}
	if (leaving.length > 0) lines.push(`Taken off my shelf, gone from view at the next collapse: ${leaving.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}.`);
	if (activeShelf.length > 0) lines.push(`Shelf items (stable ID; unshelve by ID or path): ${activeShelf.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}.`);
	if (stillDeferred.length > 0) lines.push(`Shelved items not shown because they did not fit the shelf's space remain available by ID: ${stillDeferred.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}.`);
	const missingSources = activeShelf.filter((item) => item.ref === undefined && liveShelfSource(root, item)?.content === undefined);
	const backedSources = missingSources.filter((item) => readShelfSnapshot(brainDir, item) !== undefined);
	const unbackedSources = missingSources.filter((item) => !backedSources.includes(item));
	if (backedSources.length > 0) lines.push(`Source files missing or unreadable; their full shelf snapshots remain available under these shelf IDs: ${backedSources.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}.`);
	if (unbackedSources.length > 0) lines.push(`Source files missing or unreadable, and no full backing snapshot is available (only the legacy rendered view remains): ${unbackedSources.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}.`);
	const changes = activeShelf.flatMap((item) => {
		if (typeof item.snapshot !== "string") return [];
		const current = shelfIdLine(resolveShelfText(root, item, brainDir), item);
		if (current === item.snapshot) return [];
		return [{ item, current }];
	});
	if (changes.length > 0) {
		// One line per changed file (O3): the diff is a tool call away — re-shelve the file or read it — not prompt cargo.
		lines.push("Shelved files changed since their snapshots (the snapshots stay as they were until collapse; I call `read` or `shelf` with action=\"add\" to refresh):");
		for (const { item, current } of changes) {
			// The stored snapshot is the rendered view, whose header line (`(lines a-b of N)`) changes on every line-count edit: diff the raw file text instead when it is available, and fall back to the rendered view otherwise.
			const raw = rawShelf(root, item, brainDir);
			const { added, removed } = raw.before !== undefined && raw.now !== undefined ? shelfDelta(raw.before, raw.now) : shelfDelta(item.snapshot, current);
			lines.push(`  ${shelfLabel(item)} [${item.id}] changed (+${added} −${removed} lines)`);
		}
	}
	return lines.length === 0 ? "" : `Context\n${lines.join("\n")}\n\n`;
}

// ─── The main agent's own drops ──────────────────────────────────────────────

/** The reports that stand in full in these messages, by id. */
export function reportsInView(messages) {
	const found = new Map();
	for (const [index, message] of messages.entries()) {
		const id = reportIdOf(message);
		if (id !== undefined) found.set(id, { index, tokens: messageTokens(message) });
	}
	return found;
}

const withText = (message, text) => ({ ...message, content: [{ type: "text", text }] });

// ─── Read results are ephemeral ───────────────────────────────────────────
// Successful project-file reads made by one assistant reply are one transient batch: their content stands together at
// the end of the request. A later successful batch takes the whole earlier batch out of view, leaving one line per
// read. Failed or blocked reads stay inline and never replace the current batch; `book` reads of brain records stay
// inline too. The batch is deliberately not a collapse: the Durable transcript retains every result, and `shelf` is
// the explicit place for files that must survive another batch or a collapse.

/** The tag that opens the tail block of a request: the current read batch, moved to the end. */
const READ_TAIL = "<read-tail>";
const LEGACY_SHELF_ASK_BLOCK = /\n*<shelf-ask>[\s\S]*?<\/shelf-ask>\n?/g;

const flatWords = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/** The one line a read leaves in its place when a later successful batch removes it from active view. */
const evictedReadLine = (call) => `[the result of this read is no longer in active view — ${flatWords(callWords(call))}. A later successful read batch removed the prior batch from active view. Call \`read\` in a later batch to see it again, or deliberately preserve it on \`shelf\` (action="add") before that.]`;

/** The one line a read leaves in its place, saying where its content stands instead. */
const movedReadLine = (call) => `[the result of this read stands in the current read batch at the end of the request — ${flatWords(callWords(call))}.]`;

/** The fixed, explicit reminder that precedes every transient batch. */
const readBatchTail = (entries) => {
	const listed = entries.map(({ call }) => flatWords(callWords(call))).join(", ");
	return [
		`Current read batch: ${listed}. This is the only transient file content in view.`,
		"A later successful read batch removes the prior batch from active view. That changes only this transient tail; it is not a context collapse. Before that happens, I deliberately preserve source material I need afterward on the shelf or write lasting conclusions to the shared ledger, atlas or assessment.",
		"",
		...entries.map(({ message }) => textOf(message)),
	].join("\n");
};

/** Text with the tail block split off: what stands before it, and the block as its own text. The block runs to the end of the text. */
export function splitReadTail(text) {
	const body = String(text ?? "");
	const at = body.lastIndexOf(READ_TAIL);
	if (at < 0) return { text: body, tail: undefined };
	return { text: body.slice(0, at).replace(/\n+$/, ""), tail: body.slice(at).replace(/\n+$/, "") };
}

/** Text with any tail block removed. */
export const withoutReadTail = (text) => splitReadTail(text).text;

const appendText = (message, addition) => {
	if (typeof message.content === "string") return { ...message, content: message.content + addition };
	const tail = message.content.at(-1);
	if (tail?.type !== "text") return { ...message, content: [...message.content, { type: "text", text: addition.trimStart() }] };
	return { ...message, content: [...message.content.slice(0, -1), { ...tail, text: tail.text + addition }] };
};

/**
 * The newest successful reply's read-batch content moved to the very end, as a block opening with `<read-tail>`:
 * after everything else, the state and windows blocks included. What cannot take more text (a message that is not
 * the user's and not a tool result) gets a message of its own at the end. The input is not changed.
 * @param {readonly any[]} messages
 * @param {string} tail  the newest batch's content, as it stood in its place
 */
export function withReadTail(messages, tail) {
	const block = `\n\n${READ_TAIL}\n${tail}`;
	const last = messages.at(-1);
	if (last === undefined) return [{ role: "user", content: [{ type: "text", text: `${READ_TAIL}\n${tail}` }] }];
	if (last.role === "user" || last.role === "toolResult") return [...messages.slice(0, -1), appendText(last, block)];
	return [...messages, { role: "user", content: [{ type: "text", text: `${READ_TAIL}\n${tail}` }] }];
}

const isEphemeralFileReadCall = (call) =>
	call?.name === "read" || (call?.name === "book" && call.arguments?.target === "file" && call.arguments?.action === "read");

const isErrorToolResult = (message) =>
	message?.isError === true || /^(?:<harness>\s*)?\[error\]/i.test(textOf(message).trim());

/**
 * File-read results, dressed for one request: successful project-file reads from the newest assistant reply stand
 * together as one tail batch. Every earlier successful batch becomes one line per read. Failed or blocked file reads
 * stay inline and never replace the current batch; `book` reads of brain records stay inline as well. The stored
 * messages are not changed.
 * @param {readonly any[]} messages
 * @returns {{ messages: any[], tail?: string }} the dressed messages, and the current batch content to move to the end
 */
export function dressReads(messages) {
	const calls = new Map();
	for (const [reply, message] of messages.entries()) {
		if (message.role !== "assistant") continue;
		for (const [order, call] of callsOf(message).entries()) calls.set(call.id, { call, reply, order });
	}
	const cleaned = messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const raw = textOf(message);
		if (!raw.includes("<shelf-ask>")) return message;
		return withText(message, raw.replace(LEGACY_SHELF_ASK_BLOCK, ""));
	});
	const reads = [];
	for (const [index, message] of cleaned.entries()) {
		if (message.role !== "toolResult") continue;
		const source = calls.get(message.toolCallId);
		if (source === undefined || !isEphemeralFileReadCall(source.call)) continue;
		if (isErrorToolResult(message)) continue;
		reads.push({ index, message, ...source });
	}
	if (reads.length === 0) return { messages: cleaned };
	// A result already folded by a task keeps the line it was folded under (it carries its id).
	const folded = (message) => /^\[s\d+: /.test(textOf(message));
	const newestReply = Math.max(...reads.map((entry) => entry.reply));
	const current = reads.filter((entry) => entry.reply === newestReply && !folded(entry.message)).sort((a, b) => a.order - b.order);
	const indexes = new Set(reads.map((entry) => entry.index));
	const currentIndexes = new Set(current.map((entry) => entry.index));
	const out = cleaned.map((message, index) => {
		if (!indexes.has(index) || folded(message)) return message;
		const call = calls.get(message.toolCallId)?.call;
		return withText(message, currentIndexes.has(index) ? movedReadLine(call) : evictedReadLine(call));
	});
	if (current.length === 0) return { messages: out };
	return { messages: out, tail: readBatchTail(current) };
}

/** Reconcile the front block's salient-notes section with the ledger, and its record section with the report rows. */
function dressFrontRows(message, store, salient) {
	let text = textOf(message);
	const currentRows = store.front?.rows ?? [];
	const reportHeading = text.includes(`${REPORT_HEADING}\n`) ? REPORT_HEADING : LEGACY_REPORT_HEADING;
	const reportStart = text.indexOf(`${reportHeading}\n`);
	const shelfStart = text.indexOf(`\n\n${SHELF_PREFIX}`, reportStart);
	if (reportStart >= 0 && shelfStart >= 0) {
		const start = reportStart + reportHeading.length + 1;
		const record = recordText(currentRows.filter((row) => row.species === ROW_SPECIES.composed)).text;
		text = `${text.slice(0, start)}${record}${text.slice(shelfStart)}`;
	}
	const sectionStart = text.indexOf(`\n\n${SALIENT_HEADING}`);
	const sectionEnd = sectionStart < 0 ? -1 : text.indexOf(`\n\n${SHELF_PREFIX}`, sectionStart);
	if (salient.length > 0) {
		const section = `\n\n${SALIENT_HEADING}\n${salient.map(salientLine).join("\n")}`;
		if (sectionStart >= 0 && sectionEnd >= 0) text = `${text.slice(0, sectionStart)}${section}${text.slice(sectionEnd)}`;
		else text = text.replace(`\n\n${SHELF_PREFIX}`, `${section}\n\n${SHELF_PREFIX}`);
	} else if (sectionStart >= 0 && sectionEnd >= 0) text = `${text.slice(0, sectionStart)}${text.slice(sectionEnd)}`;
	return text === textOf(message) ? message : withText(message, text);
}

/** The main agent's messages reconciled to the active row view; the input is not changed. */
export function dressMain(messages, brainDir) {
	const store = loadContext(brainDir);
	const salient = salientFrom(brainDir);
	return messages.map((message) => {
		if (isFront(message)) return dressFrontRows(message, store, salient);
		const id = reportIdOf(message);
		if (id === undefined) return message;
		const record = composedRows(store).find((entry) => entry.id === id);
		const active = store.front ? store.front.rows.some((entry) => entry.id === id) : record !== undefined && record.archived !== true;
		if (active && !store.dropped.includes(id)) return message;
		if (record?.archived === true) return withText(message, `[Report ${id} is archived. Its record: ${recordLine(record)}.]`);
		if (record !== undefined && !active) return withText(message, `[Report ${id} is queued to enter context at the next boundary: ${recordLine(record)}.]`);
		if (store.dropped.includes(id)) return withText(message, `[I dropped report ${id} from view. Its record: ${record ? recordLine(record) : "(no line kept)"}. \`book\` with target=context, action=recall, id="${id}" brings it back.]`);
		if (record === undefined) return withText(message, `[Report ${id} was deleted from the brain and is no longer in context.]`);
		return message;
	});
}

// ─── A task's own steps ──────────────────────────────────────────────────────

/**
 * The steps a task has taken: everything behind its brief.
 * @returns {{ start: number, replies: number, results: { id: string, index: number, call?: { name: string, arguments: any }, tokens: number, chars: number, isError: boolean, first: string }[], notes: string[] } | undefined}
 *   undefined when the messages hold no brief (they are not a task's)
 */
export function stepsOf(messages) {
	const brief = messages.findLastIndex((message) => message.role === "toolResult" && textOf(message).startsWith(TASK_HEADER));
	if (brief < 0) return undefined;
	let start = brief + 1;
	while (start < messages.length && messages[start].role === "toolResult") start++;
	const calls = new Map();
	const results = [];
	const notes = [];
	let replies = 0;
	for (let index = start; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "assistant") {
			replies++;
			for (const call of callsOf(message)) calls.set(call.id, call);
			const text = textOf(message).trim();
			if (text !== "") notes.push(text);
		} else if (message.role === "toolResult") {
			const text = textOf(message);
			results.push({ id: `${POLICY.idPrefixes.taskStep}${results.length + 1}`, index, call: calls.get(message.toolCallId), tokens: messageTokens(message), chars: text.length, isError: message.isError === true, first: text.split("\n")[0] });
		}
	}
	return { start, replies, results, notes };
}

/** A call in a few words, for a list of what was done. */
export function callWords(call) {
	if (call === undefined) return "a call";
	const args = call.arguments ?? {};
	if (call.name === "read") {
		// Older stored transcripts used plural `paths`; replay them without exposing that retired call shape.
		if (args.paths !== undefined) return `read ${[].concat(args.paths ?? []).join(", ")}${args.offset !== undefined ? ` from line ${args.offset}` : ""}`;
		const target = args.path ?? args.id ?? args.ref?.id ?? "";
		return `read ${oneLine(String(target), POLICY.limits.context.bookWordsChars)}${args.range ? ` lines ${args.range}` : ""}`.trim();
	}
	if (call.name === "shelf") {
		const action = typeof args.action === "string" && args.action !== "" ? args.action : "?";
		const what = args.path ?? args.id ?? args.ref?.id ?? "";
		return `shelf ${action}${what === "" ? "" : ` ${oneLine(String(what), POLICY.limits.context.bookWordsChars)}`}${args.range ? ` lines ${args.range}` : ""}`.trim();
	}
	if (call.name === "search") return `search /${oneLine(args.pattern, POLICY.limits.context.searchPatternChars)}/${args.path ? ` in ${args.path}` : ""}`;
	if (call.name === "list") return `list ${args.path ?? "."}`;
	if (call.name === "write" || call.name === "edit") return `${call.name} ${args.path ?? ""}`;
	if (call.name === "shell") return `shell ${oneLine(args.command, POLICY.limits.context.shellCommandChars)}`;
	if (call.name === "book") {
		const target = typeof args.target === "string" && args.target !== "" ? args.target : "book";
		const action = typeof args.action === "string" && args.action !== "" ? args.action : "?";
		const what = args.id ?? args.ref?.id ?? args.path ?? args.name ?? args.kind ?? args.mode ?? args.text ?? args.gist ?? "";
		return `${target} ${action}${what === "" ? "" : ` ${oneLine(String(what), POLICY.limits.context.bookWordsChars)}`}`.trim();
	}
	return `${call.name} ${oneLine(JSON.stringify(args), POLICY.limits.context.genericCallChars)}`;
}

/**
 * The earlier reads that a new read makes pointless: the same files, and the new one shows at least the same lines.
 * Only where it pays: the old copy is large, and what the server must read again for it is not much more.
 * @param {ReturnType<typeof stepsOf>} steps  the steps before the new read
 * @param {{ path?: string, id?: string, range?: string, paths?: string[] | string, offset?: number, limit?: number }} args  a one-file read's arguments (`paths` is legacy stored-call compatibility)
 * @param {Record<string, string>} dropped  what is replaced already
 * @returns {string[]} step ids
 */
export function supersededBy(steps, args, dropped = {}) {
	const readTargets = (a) => (a?.paths !== undefined ? [].concat(a.paths ?? []) : [a?.path ?? a?.id].filter((entry) => typeof entry === "string" && entry !== ""));
	const paths = new Set(readTargets(args));
	if (paths.size === 0) return [];
	const whole = args.offset === undefined && args.limit === undefined && args.range === undefined;
	const ids = [];
	let behind = 0;
	for (const result of [...steps.results].reverse()) {
		const old = result.call;
		const size = dropped[result.id] === undefined ? result.tokens : 0;
		if (old?.name === "read" && !result.isError && dropped[result.id] === undefined) {
			const oldPaths = readTargets(old.arguments);
			const sameSlice = whole || (args.range !== undefined ? old.arguments?.range === args.range : old.arguments?.offset === args.offset && old.arguments?.limit === args.limit);
			const covered = oldPaths.length > 0 && oldPaths.every((path) => paths.has(path)) && sameSlice;
			if (covered && result.tokens >= POLICY.limits.context.usefulResultTokens && behind <= result.tokens * POLICY.limits.context.reuseRatio) ids.push(result.id);
		}
		behind += size;
	}
	return ids;
}

/**
 * The block that stands in for a task's collapsed steps.
 * @param {string} root
 * @param {{ contextWindow: number }} config
 * @param {NonNullable<ReturnType<typeof stepsOf>>} steps
 * @param {{ notes?: string[], shelf?: object[], cutShelf?: object[] }} state
 * @param {{ reason: string }} input
 */
export function taskBlock(root, brainDir, config, steps, state, { reason }) {
	const notes = [...(state.notes ?? []).map((note) => `- ${note}`), ...steps.notes.map((note) => `- ${note}`)];
	// The newest notes win when there are too many.
	let used = 0;
	const keptNotes = [];
	for (const note of [...notes].reverse()) {
		if (used + estimate(note) > POLICY.limits.context.keptNotesTokens && keptNotes.length > 0) break;
		used += estimate(note);
		keptNotes.unshift(note);
	}
	const done = steps.results.slice(-POLICY.limits.context.resultRows).map((result) => `${result.id} ${callWords(result.call)} → ${result.isError ? "failed: " : ""}${oneLine(result.first, POLICY.limits.context.resultFirstChars)}`);
	const shelf = shelfBlock(root, state.shelf ?? [], shelfSpace(config?.contextWindow), brainDir);
	state.shelf = shelf.items;
	state.cutShelf = shelf.shown.map(({ item, hash }) => ({ ...item, hash }));
	return [
		NOTE_OPEN,
		`${HEAD} ${reason}, so my steps up to here (${steps.replies === 1 ? "1 reply" : `${steps.replies} replies`}, ${steps.results.length === 1 ? "1 call" : `${steps.results.length} calls`}) were collapsed: their results are no longer in view. I am still the task, and the brief above still holds. What I kept:`,
		"",
		"My notes",
		keptNotes.length === 0 ? "(none)" : keptNotes.join("\n"),
		"",
		`My calls so far${steps.results.length > done.length ? `, the last ${done.length} of ${steps.results.length}` : ""} (call again for a result I need)`,
		done.length === 0 ? "(none)" : done.join("\n"),
		"",
		shelf.shown.length === 0 ? "My shelf is empty." : `My shelf: ${shelf.shown.length === 1 ? "1 item" : `${shelf.shown.length} items`}, as the files are now`,
		...shelf.shown.map((entry) => entry.text),
		...shelf.left.map((entry) => `(${shelfLabel(entry.item)} [${entry.item.id}] remains on the shelf but is not shown: ${entry.why}.)`),
		...shelf.stale.map((entry) => `(${shelfLabel(entry.item)} [${entry.item.id}] is stale: ${entry.why}.)`),
		"",
		"I go on with the brief from here. My final reply is still the report.",
		NOTE_CLOSE,
	].join("\n");
}

/** What a task is shown in place of a result it no longer needs. */
const marker = (result, why) => `[${result.id}: ${why} It was: ${callWords(result.call)}, about ${count(result.tokens)} tokens. Call again if I need it.]`;

/**
 * A task's messages as they are sent: collapsed steps replaced by their block, dropped results by one line, and
 * each large result marked with its id and size. What stands in front of the brief is not touched. The input is
 * not changed.
 * @param {readonly any[]} messages  the task's stored messages
 * @param {{ cut?: { steps: number, block: string, at: number }, dropped?: Record<string, string> } | undefined} state
 */
export function dressTask(messages, state) {
	const steps = stepsOf(messages);
	if (steps === undefined) return messages;
	const dropped = state?.dropped ?? {};
	const byIndex = new Map(steps.results.map((result) => [result.index, result]));
	const hidden = Math.min(state?.cut?.steps ?? 0, messages.length - steps.start);
	const out = messages.slice(0, steps.start);
	if (hidden > 0) out.push({ role: "user", content: [{ type: "text", text: state.cut.block }], timestamp: state.cut.at });
	for (let index = steps.start + hidden; index < messages.length; index++) {
		const message = messages[index];
		const result = byIndex.get(index);
		if (result === undefined) out.push(message);
		else if (dropped[result.id] !== undefined) out.push(withText(message, marker(result, dropped[result.id])));
		else if (result.chars >= TAG_MIN_CHARS) out.push(withText(message, `${textOf(message)}\n\n[${result.id} · about ${count(result.tokens)} tokens]`));
		else out.push(message);
	}
	return out;
}

/** Text without the tags `dressTask` adds (for the tests' stand-in). */
export const withoutTags = (text) => text.replace(/\n\n\[s\d+ · about [\d,]+ tokens\]$/g, "");

/** A task's state, made when first asked for. */
export function taskState(store, conversationId) {
	store.tasks[conversationId] ??= {};
	return store.tasks[conversationId];
}

// ─── The user's own hands on the context ────────────────────────────────────

/**
 * The user archives reports: their record lines leave the block the collapse keeps, so a project with a
 * thousand finished tasks does not read a thousand one-liners. The report stays on disk and recall by id
 * still finds it. Returns the line to show.
 */
export function archiveReports(brainDir, ids, when = VISIBILITY.now) {
	const store = loadContext(brainDir);
	const known = ids.filter((id) => composedRows(store).some((record) => record.id === id));
	const open = ids.filter((id) => !known.includes(id));
	if (known.length === 0) return `There is no report ${ids.join(", ")}. /context lists the kept ones.`;
	updateContext(brainDir, (next) => {
		for (const record of next.rows) if (record.species === ROW_SPECIES.composed && known.includes(record.id)) record.archived = true;
		if (visibleNow(when)) next.dropped = [...new Set([...next.dropped, ...known])];
		reflectRows(next, when, known);
	});
	return `${known.join(", ")} archived: the record ${known.length === 1 ? "line leaves" : "lines leave"} the kept block, the report ${known.length === 1 ? "stays" : "stay"} on disk, recall by id still finds ${known.length === 1 ? "it" : "them"}. ${open.length > 0 ? `No report ${open.join(", ")}.` : ""}`.trim();
}

/** The user brings archived reports back into the record. Returns the line to show. */
export function unarchiveReports(brainDir, ids, when = VISIBILITY.now) {
	const store = loadContext(brainDir);
	const held = ids.filter((id) => composedRows(store).some((record) => record.id === id && record.archived === true));
	const rest = ids.filter((id) => !held.includes(id));
	if (held.length === 0) return `${ids.join(", ")} ${ids.length === 1 ? "is" : "are"} not archived.`;
	updateContext(brainDir, (next) => {
		for (const record of next.rows) if (record.species === ROW_SPECIES.composed && held.includes(record.id)) delete record.archived;
		if (visibleNow(when)) next.dropped = next.dropped.filter((entry) => !held.includes(entry));
		reflectRows(next, when, held);
	});
	return `${held.join(", ")} back in the record: the next collapse lists ${held.length === 1 ? "its" : "their"} line${held.length === 1 ? "" : "s"} again. ${rest.length > 0 ? `${rest.join(", ")} ${rest.length === 1 ? "was" : "were"} not archived.` : ""}`.trim();
}

/**
 * The user deletes reports for good: the record line and the report's file are gone, and nothing recalls
 * them again. Returns the line to show.
 */
export function deleteReports(brainDir, ids, when = VISIBILITY.now) {
	const store = loadContext(brainDir);
	const known = ids.filter((id) => composedRows(store).some((record) => record.id === id));
	const open = ids.filter((id) => !known.includes(id));
	if (known.length === 0) return `There is no report ${ids.join(", ")}. /context lists the kept ones.`;
	updateContext(brainDir, (next) => {
		next.rows = next.rows.filter((record) => record.species !== ROW_SPECIES.composed || !known.includes(record.id));
		if (visibleNow(when)) next.dropped = next.dropped.filter((entry) => !known.includes(entry));
		reflectRows(next, when, known);
	});
	const gone = [];
	for (const id of known) {
		const file = join(reportsDir(brainDir), `${id}.md`);
		try {
			unlinkSync(file);
			gone.push(id);
		} catch {
			// The file was already gone; the record is deleted all the same.
		}
	}
	return `${known.join(", ")} deleted: the record ${known.length === 1 ? "line is" : "lines are"} gone and ${gone.length > 0 ? `${gone.length === 1 ? "its file is" : `${gone.length} files are`} gone from ${reportsDir(brainDir)}` : "their files were already gone"}. Nothing recalls ${known.length === 1 ? "it" : "them"} again. ${open.length > 0 ? `No report ${open.join(", ")}.` : ""}`.trim();
}

/** The user's message, as it shows in the talk, was edited: the line the context keeps is rewritten to match. */

/** Two shelf items are the same file. */
const sameItem = sameShelfItem;
// The same operations the agent has with `context`, for the person watching: /fold, /recall, /shelve and
// /unshelve on the terminal, and the keys of the Context tab in the full screen. Nothing here is a tool; the
// user is the one the requests are for, and these change the stored context exactly as the agent's calls do.

/** The user folds reports out of view, leaving their record lines. Returns the line to show. */
export function foldReports(brainDir, ids) {
	const store = loadContext(brainDir);
	const unknown = ids.filter((id) => !composedRows(store).some((record) => record.id === id));
	const foldable = ids.filter((id) => {
		const record = composedRows(store).find((entry) => entry.id === id);
		return record !== undefined && record.archived !== true && !store.dropped.includes(id);
	});
	if (foldable.length === 0) {
		const open = composedRows(store).filter((record) => record.archived !== true && !store.dropped.includes(record.id)).map((record) => record.id);
		return unknown.length === ids.length
			? `There is no report ${ids.join(", ")}. The kept ones: ${composedRows(store).map((record) => record.id).join(", ") || "none yet"}.`
			: `${ids.join(", ")} ${ids.length === 1 ? "is" : "are"} already out of view.${open.length > 0 ? ` In full: ${open.join(", ")}.` : ""}`;
	}
	updateContext(brainDir, (next) => {
		next.dropped = [...new Set([...next.dropped, ...foldable])];
	});
	const said = foldable.map((id) => `${id}: ${recordLine(composedRows(store).find((record) => record.id === id))}`).join("\n  ");
	return `${unknown.length > 0 ? `no report ${unknown.join(", ")}; ` : ""}out of view, the record line stands in ${foldable.length === 1 ? "its" : "their"} place:\n  ${said}\n/recall ${foldable.join(" ")} brings ${foldable.length === 1 ? "it" : "them"} back.`;
}

/** The user recalls a kept report. One that is only folded stands in view again; one that is not is printed for the user to read, and stays out of the model's view. Returns the line to show, or undefined. */
export function recallReport(brainDir, id) {
	const store = loadContext(brainDir);
	if (!composedRows(store).some((record) => record.id === id)) return undefined;
	if (store.dropped.includes(id)) {
		updateContext(brainDir, (next) => {
			next.dropped = next.dropped.filter((entry) => entry !== id);
		});
		return `${id} stands in its place again, in view.`;
	}
	const report = loadReport(brainDir, id);
	return `${id} is in view already. As it stands:\n${report ?? "(its file is gone)"}`;
}

/** The user shelves a file, as the agent does: snapshot it now and carry it through collapse. Throws ShelfError. */
export function shelveForUser(root, brainDir, config, path, lines) {
	const store = loadContext(brainDir);
	const { item, tokens, backing } = shelfItem(root, path, lines, brainDir, store.shelf);
	const others = store.shelf.filter((entry) => !sameItem(entry, item));
	const total = others.reduce((sum, entry) => sum + estimate(shelfText(root, entry, brainDir)), 0) + tokens;
	persistShelfSnapshot(brainDir, item, backing);
	updateContext(brainDir, (next) => {
		const at = next.shelf.findIndex((entry) => sameItem(entry, item));
		if (at >= 0) next.shelf[at] = item;
		else next.shelf.push(item);
	});
	return `${shelfLabel(item)} is on the shelf as ${item.id} (about ${count(tokens)} rendered tokens; the shelf then holds about ${count(total)}). For project files, the full backing snapshot is saved under .brain; the selected content is available now and after collapse, and every task begins with it read.\n\n${item.snapshot}`;
}

/** The user takes a file, or everything, off the shelf. Throws ShelfError for a name that is not on it. */
export function unshelveForUser(brainDir, path) {
	const store = loadContext(brainDir);
	const gone = path === "all" ? [...store.shelf] : store.shelf.filter((entry) => entry.id === path || shelfLabel(entry) === path || entry.path === path || entry.path === path.replace(/^\.\//, ""));
	if (gone.length === 0) throw new ShelfError(`${path} is not on the shelf.${store.shelf.length > 0 ? ` On it: ${store.shelf.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}.` : " The shelf is empty."}`);
	updateContext(brainDir, (next) => {
		next.shelf = next.shelf.filter((entry) => !gone.some((other) => sameItem(other, entry)));
	});
	cleanupShelfSnapshots(brainDir, gone);
	return `Taken off the shelf: ${gone.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}. A copy that stands in the context stays until the next collapse.`;
}

/**
 * What a task hands on to the main agent's shelf when it ends, and the cleaning up after it.
 * @returns {{ added: string[], snapshots: string[], refused: string[] }}
 */
export function endTaskContext(root, brainDir, config, conversationId) {
	const prior = loadContext(brainDir);
	const result = updateContext(brainDir, (store) => {
		const task = store.tasks[conversationId];
		delete store.tasks[conversationId];
		const added = [];
		const snapshots = [];
		const refused = [];
		for (const { handOn, ...item } of (task?.shelf ?? []).filter((entry) => entry.handOn === true)) {
			const existing = store.shelf.find((entry) => sameShelfItem(entry, item));
			const adopted = { ...item, ...(existing ? { id: existing.id } : {}) };
			if (typeof adopted.snapshot === "string") adopted.snapshot = shelfIdLine(adopted.snapshot, adopted);
			const others = store.shelf.filter((entry) => !sameShelfItem(entry, item));
			const backing = readShelfSnapshot(brainDir, item);
			if (backing !== undefined) persistShelfSnapshot(brainDir, adopted, backing);
			store.shelf = [...others, adopted];
			added.push(`${shelfLabel(adopted)} as ${adopted.id}`);
			snapshots.push(adopted.snapshot ?? resolveShelfText(root, adopted, brainDir));
		}
		return { added, snapshots, refused };
	});
	cleanupShelfSnapshots(brainDir, prior.tasks[conversationId]?.shelf ?? []);
	return result;
}
