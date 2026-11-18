// The plan has two levels.
//
// An envelope (p<N>) is the user-visible intent and authorization boundary. It is
// never runnable. A move (m<N>) is one small, observable execution step under an
// envelope. Approval binds a move revision, never future work invented under an
// approved envelope. The plan is plain JSON in .brain/carto-plan.json and is read
// fresh whenever authority is needed.
import { POLICY } from "./config.mjs";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USER_NAME } from "./user.mjs";

export const MODES = POLICY.enums.planModes;
export const MOVE_STATUS = POLICY.enums.moveStatus;
const PLAN_ID = new RegExp(POLICY.patterns.planId);
const MOVE_ID = new RegExp(POLICY.patterns.moveId);
/** One envelope is one line in the state block. */
export const ITEM_MAX = POLICY.limits.plan.itemChars;
export const ITEMS_MAX = POLICY.limits.plan.items;
export const MOVES_MAX = POLICY.limits.plan.moves;
export const TARGETS_MAX = POLICY.limits.plan.targets;

export class PlanError extends Error {}

export const planPath = (brainDir) => join(brainDir, "carto-plan.json");
const empty = () => ({ version: 2, next: 1, nextMove: 1, items: [], moves: [] });
const flat = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const stamp = (now) => now instanceof Date ? now.toISOString() : typeof now === "number" ? new Date(now).toISOString() : String(now);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const moveTurns = (mode) => POLICY.limits.plan.moveTurns[mode] ?? POLICY.limits.plan.moveTurns.change;
const validMoveStatus = new Set(Object.values(MOVE_STATUS));
const ownObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value, label, max = ITEM_MAX) => {
	const kept = flat(value);
	if (kept === "") throw new PlanError(`${label} is required and was left out or empty.`);
	if (kept.length > max) throw new PlanError(`${label} must be ${max} characters or fewer.`);
	return kept;
};

const target = (value) => {
	const kept = String(value ?? "").trim().replace(/^\.\//, "");
	if (kept === "" || kept === "." || kept.split("/").includes("..") || kept.startsWith("/")) throw new PlanError("Every `targets` entry must be one project-relative file path.");
	return kept;
};

const targets = (value, required) => {
	if (value === undefined && !required) return undefined;
	if (!Array.isArray(value) || value.length === 0) throw new PlanError("`targets` must name one or more project-relative file paths.");
	if (value.length > TARGETS_MAX) throw new PlanError(`\`targets\` has ${value.length} paths; one move may name at most ${TARGETS_MAX}. Split the work.`);
	const kept = value.map(target);
	if (new Set(kept).size !== kept.length) throw new PlanError("`targets` repeats a path.");
	return kept;
};

const turns = (value, mode) => {
	if (value === undefined) return moveTurns(mode);
	if (!Number.isInteger(value) || value < 1 || value > POLICY.limits.plan.moveTurns.max) {
		throw new PlanError(`\`turns\` must be a whole number from 1 to ${POLICY.limits.plan.moveTurns.max}.`);
	}
	return value;
};

/** The fixed small resource budget that travels with one move, not with its envelope. */
function moveBudget(raw, mode) {
	const source = ownObject(raw) ? raw : {};
	const replies = turns(source.replies, mode);
	const defaultFiles = mode === POLICY.enums.planMode.change ? POLICY.limits.plan.moveBudget.fileOps : 0;
	const defaultCommands = mode === POLICY.enums.planMode.change ? POLICY.limits.plan.moveBudget.commandStarts : 0;
	const whole = (value, fallback, label) => {
		if (value === undefined) return fallback;
		if (!Number.isInteger(value) || value < 0 || value > fallback) throw new PlanError(`\`${label}\` must be a whole number from 0 to ${fallback}.`);
		return value;
	};
	return {
		replies,
		fileOps: whole(source.fileOps, defaultFiles, "budget.fileOps"),
		commandStarts: whole(source.commandStarts, defaultCommands, "budget.commandStarts"),
	};
}

/** Change capability is declared per move; an envelope can grant network, never a move by itself. */
function moveCapabilities(raw, parent) {
	const source = raw === undefined ? {} : raw;
	if (!ownObject(source)) throw new PlanError("`capabilities` must be an object when supplied.");
	const bool = (key, fallback) => {
		if (source[key] === undefined) return fallback;
		if (typeof source[key] !== "boolean") throw new PlanError(`\`capabilities.${key}\` must be true or false.`);
		return source[key];
	};
	if (parent.mode !== POLICY.enums.planMode.change) return { files: false, commands: false, network: false };
	const capabilities = {
		files: bool("files", true),
		commands: bool("commands", true),
		network: bool("network", parent.network === true),
	};
	if (capabilities.network && parent.network !== true) throw new PlanError("This envelope does not grant network access to a move.");
	return capabilities;
}

const envelopeAt = (plan, id) => plan.items.find((item) => item.id === id);
const moveAt = (plan, id) => plan.moves.find((move) => move.id === id);
export const findEnvelope = envelopeAt;
export const findMove = moveAt;
export const isMove = (entry) => typeof entry?.parent === "string" && MOVE_ID.test(entry.id ?? "");
export const movesOf = (plan, parent) => plan.moves.filter((move) => move.parent === parent);

const envelopeOpen = (item) => item.status === POLICY.enums.entryStatus.open && item.archived !== true;
const moveOpen = (move) => move.status === MOVE_STATUS.open && move.archived !== true;
const parentOf = (plan, move) => envelopeAt(plan, move.parent);
const changeMove = (plan, move) => parentOf(plan, move)?.mode === POLICY.enums.planMode.change;
const approved = (move) => move.approvedRevision === move.revision;

/** A v1 plan becomes envelopes with no executable moves. It is intentionally not authorized after migration. */
function migrateV1(raw, path) {
	if (!Array.isArray(raw.items)) return { error: `${path} must hold an object with an "items" list` };
	const seen = new Set();
	const items = [];
	for (const [index, source] of raw.items.entries()) {
		const where = `${path}, item ${index + 1}`;
		if (source === null || typeof source !== "object") return { error: `${where} is not an object` };
		if (typeof source.id !== "string" || !PLAN_ID.test(source.id)) return { error: `${where} needs an "id" like "p3"` };
		if (seen.has(source.id)) return { error: `${where} repeats the id ${source.id}` };
		if (!MODES.includes(source.mode)) return { error: `${where} needs a \"mode\" that is one of ${MODES.join(", ")}` };
		if (typeof source.text !== "string" || flat(source.text) === "") return { error: `${where} needs a \"text\"` };
		seen.add(source.id);
		const item = {
			id: source.id,
			mode: source.mode,
			text: flat(source.text),
			status: source.status === POLICY.enums.entryStatus.done ? POLICY.enums.entryStatus.done : POLICY.enums.entryStatus.open,
			revision: 1,
			legacy: true,
		};
		if (source.mode === POLICY.enums.planMode.change && source.network === true) item.network = true;
		if (source.mode === POLICY.enums.planMode.change && source.standing === true) item.standing = true;
		if (typeof source.outcome === "string" && flat(source.outcome) !== "") item.outcome = flat(source.outcome);
		if (source.archived === true) item.archived = true;
		items.push(item);
	}
	const highest = items.reduce((max, item) => Math.max(max, Number(item.id.slice(1))), 0);
	const next = Number.isInteger(raw.next) && raw.next > highest ? raw.next : highest + 1;
	return { plan: { version: 2, next, nextMove: 1, items, moves: [], ...(typeof raw.lastCall === "string" ? { lastCall: raw.lastCall } : {}), migrated: true } };
}

function normalizeEnvelope(raw, where, seen) {
	if (raw === null || typeof raw !== "object") throw new PlanError(`${where} is not an object`);
	if (typeof raw.id !== "string" || !PLAN_ID.test(raw.id)) throw new PlanError(`${where} needs an \"id\" like \"p3\"`);
	if (seen.has(raw.id)) throw new PlanError(`${where} repeats the id ${raw.id}`);
	if (!MODES.includes(raw.mode)) throw new PlanError(`${where} needs a \"mode\" that is one of ${MODES.join(", ")}`);
	const item = {
		id: raw.id,
		mode: raw.mode,
		text: text(raw.text, `${where} needs a \"text\"`),
		status: raw.status === POLICY.enums.entryStatus.done ? POLICY.enums.entryStatus.done : POLICY.enums.entryStatus.open,
		revision: Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1,
	};
	const doneWhen = raw.doneWhen ?? raw.done_when;
	if (typeof doneWhen === "string" && flat(doneWhen) !== "") item.doneWhen = text(doneWhen, `${where} \"doneWhen\"`);
	if (item.mode === POLICY.enums.planMode.change && item.status === POLICY.enums.entryStatus.open && item.doneWhen === undefined && raw.legacy !== true) {
		throw new PlanError(`${where} needs \"doneWhen\": how the envelope will be known complete.`);
	}
	if (item.mode === POLICY.enums.planMode.change && raw.network === true) item.network = true;
	if (item.mode === POLICY.enums.planMode.change && raw.standing === true) item.standing = true;
	if (raw.archived === true) item.archived = true;
	if (raw.legacy === true) item.legacy = true;
	if (typeof raw.outcome === "string" && flat(raw.outcome) !== "") item.outcome = flat(raw.outcome);
	if (typeof raw.closed === "string") item.closed = raw.closed;
	if (typeof raw.undone === "string") item.undone = raw.undone;
	seen.add(item.id);
	return item;
}

function normalizeMove(raw, where, plan, seen) {
	if (raw === null || typeof raw !== "object") throw new PlanError(`${where} is not an object`);
	if (typeof raw.id !== "string" || !MOVE_ID.test(raw.id)) throw new PlanError(`${where} needs an \"id\" like \"m3\"`);
	if (seen.has(raw.id)) throw new PlanError(`${where} repeats the id ${raw.id}`);
	if (typeof raw.parent !== "string" || envelopeAt(plan, raw.parent) === undefined) throw new PlanError(`${where} names no envelope in \"parent\"`);
	const parent = envelopeAt(plan, raw.parent);
	const action = text(raw.action ?? raw.text, `${where} needs an \"action\"`);
	if (raw.budget !== undefined && !ownObject(raw.budget)) throw new PlanError(`${where} \"budget\" must be an object.`);
	const budget = moveBudget({ ...(ownObject(raw.budget) ? raw.budget : {}), ...(raw.turns === undefined ? {} : { replies: raw.turns }) }, parent.mode);
	const item = {
		id: raw.id,
		parent: raw.parent,
		action,
		// `text` remains in the file for older readers. It always mirrors `action`.
		text: action,
		doneWhen: text(raw.doneWhen ?? raw.done_when, `${where} needs \"doneWhen\"`),
		capabilities: moveCapabilities(raw.capabilities, parent),
		budget,
		turns: budget.replies,
		revision: Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1,
		parentRevision: Number.isInteger(raw.parentRevision) && raw.parentRevision > 0 ? raw.parentRevision : parent.revision,
		status: validMoveStatus.has(raw.status) ? raw.status : MOVE_STATUS.open,
	};
	if (parent.mode === POLICY.enums.planMode.change) {
		item.targets = targets(raw.targets, true);
		item.proof = text(raw.proof, `${where} needs \"proof\"`, POLICY.limits.plan.proofChars);
	} else {
		const maybeTargets = raw.targets === undefined ? undefined : targets(raw.targets, false);
		if (maybeTargets !== undefined) item.targets = maybeTargets;
		if (typeof raw.proof === "string" && flat(raw.proof) !== "") item.proof = text(raw.proof, `${where} \"proof\"`, POLICY.limits.plan.proofChars);
	}
	if (raw.archived === true) item.archived = true;
	if (raw.approvedRevision === item.revision) {
		item.approvedRevision = item.revision;
		if (typeof raw.approvedAt === "string") item.approvedAt = raw.approvedAt;
	}
	if (typeof raw.startedAt === "string") item.startedAt = raw.startedAt;
	if (raw.reported !== undefined && raw.reported !== null && typeof raw.reported === "object") item.reported = raw.reported;
	if (typeof raw.acceptedReview === "string" && flat(raw.acceptedReview) !== "") item.acceptedReview = text(raw.acceptedReview, `${where} \"acceptedReview\"`, POLICY.limits.plan.proofChars);
	if (typeof raw.blocked === "string") item.blocked = raw.blocked;
	if (typeof raw.outcome === "string") item.outcome = raw.outcome;
	if (typeof raw.closed === "string") item.closed = raw.closed;
	if (typeof raw.undone === "string") item.undone = raw.undone;
	seen.add(item.id);
	return item;
}

/**
 * Read the plan. A malformed file is reported and never overwritten. Version 1 is
 * read as an intentionally unapproved set of legacy envelopes; the next save
 * writes version 2.
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
	if (raw === null || typeof raw !== "object" || !Array.isArray(raw.items)) return { error: `${path} must hold an object with an \"items\" list` };
	if (raw.version !== 2) return migrateV1(raw, path);
	if (!Array.isArray(raw.moves)) return { error: `${path} version 2 needs a \"moves\" list` };
	try {
		const seenPlans = new Set();
		const items = raw.items.map((item, index) => normalizeEnvelope(item, `${path}, envelope ${index + 1}`, seenPlans));
		const plan = { version: 2, next: 1, nextMove: 1, items, moves: [] };
		const seenMoves = new Set();
		plan.moves = raw.moves.map((move, index) => normalizeMove(move, `${path}, move ${index + 1}`, plan, seenMoves));
		const highestPlan = items.reduce((max, item) => Math.max(max, Number(item.id.slice(1))), 0);
		const highestMove = plan.moves.reduce((max, move) => Math.max(max, Number(move.id.slice(1))), 0);
		plan.next = Number.isInteger(raw.next) && raw.next > highestPlan ? raw.next : highestPlan + 1;
		plan.nextMove = Number.isInteger(raw.nextMove) && raw.nextMove > highestMove ? raw.nextMove : highestMove + 1;
		if (typeof raw.lastCall === "string") plan.lastCall = raw.lastCall;
		return { plan };
	} catch (error) {
		return { error: error instanceof PlanError ? error.message : `${path} cannot be read (${error.message})` };
	}
}

export function savePlan(brainDir, plan) {
	const path = planPath(brainDir);
	const saved = { ...plan, version: 2 };
	delete saved.migrated;
	writeFileSync(`${path}.tmp`, `${JSON.stringify(saved, null, 2)}\n`);
	renameSync(`${path}.tmp`, path);
}

/** Open envelopes, optionally of one mode. */
export const openItems = (plan, mode) => plan.items.filter((item) => envelopeOpen(item) && (mode === undefined || item.mode === mode));
export const openOnce = (plan) => openItems(plan).filter((item) => item.standing !== true);
export const openStanding = (plan) => openItems(plan).filter((item) => item.standing === true);
export const openMoves = (plan, parent) => plan.moves.filter((move) => moveOpen(move) && (parent === undefined || move.parent === parent));
export const reportedMoves = (plan) => plan.moves.filter((move) => move.status === MOVE_STATUS.reported && move.archived !== true);

/** Change moves which await explicit human approval. */
export function waiting(plan) {
	return plan.moves.filter((move) => {
		const parent = parentOf(plan, move);
		return moveOpen(move) && parent !== undefined && envelopeOpen(parent) && move.parentRevision === parent.revision && parent.mode === POLICY.enums.planMode.change && !approved(move);
	});
}

/** A ready move has exact current approval. `yolo` is deliberately not remembered in the plan. */
export function mayRun(plan, move, yolo = false) {
	const parent = typeof move === "string" ? moveAt(plan, move) : move;
	if (parent === undefined) return false;
	const envelope = parentOf(plan, parent);
	if (envelope === undefined || !envelopeOpen(envelope) || !moveOpen(parent) || parent.parentRevision !== envelope.revision) return false;
	if (envelope.mode !== POLICY.enums.planMode.change) return true;
	return yolo || approved(parent);
}

/** There is no global plan authorization. This remains for callers that ask whether some approved move exists. */
export function isAuthorized(plan) {
	return plan.moves.some((move) => mayRun(plan, move));
}

/** Ready moves are the only plan records a focus may receive. */
export const runnableMoves = (plan, { yolo = false } = {}) => plan.moves.filter((move) => mayRun(plan, move, yolo));

export const awaitsApproval = (plan) => waiting(plan).length > 0;
export const planWaits = (plan) => waiting(plan).length > 0;

/** Check a live execution token before a focus mutates the project. */
export function liveMove(plan, id, revision, { yolo = false } = {}) {
	const move = moveAt(plan, id);
	if (move === undefined) return { error: `There is no move ${JSON.stringify(id)}.` };
	const envelope = parentOf(plan, move);
	if (envelope === undefined || !envelopeOpen(envelope)) return { error: `${move.id}'s envelope is no longer open.` };
	if (move.archived === true || envelope.archived === true) return { error: `${move.id} is archived.` };
	if (move.revision !== revision || move.parentRevision !== envelope.revision) return { error: `${move.id} changed after this focus started.` };
	if (move.status !== MOVE_STATUS.running) return { error: `${move.id} is ${move.status}, not running.` };
	if (envelope.mode !== POLICY.enums.planMode.change) return { error: `${move.id} is a look move and cannot change files.` };
	if (!yolo && !approved(move)) return { error: `${move.id}'s approved revision is no longer current.` };
	return { envelope, move };
}

export const targetAllows = (move, path) => Array.isArray(move?.targets) && move.targets.includes(String(path ?? "").replace(/^\.\//, ""));

/** Reserve one ready move for one focus. A second focus cannot claim it. */
export function startMove(plan, id, now, { yolo = false } = {}) {
	const move = moveAt(plan, id);
	if (move === undefined) throw new PlanError(`There is no move ${JSON.stringify(id)}.`);
	const envelope = parentOf(plan, move);
	if (envelope === undefined) throw new PlanError(`${move.id} names an envelope that no longer exists.`);
	if (!mayRun(plan, move, yolo)) {
		if (move.status !== MOVE_STATUS.open) throw new PlanError(`${move.id} is ${move.status}; make a successor move instead of running it again.`);
		if (envelope.mode === POLICY.enums.planMode.change) throw new PlanError(`${move.id} is not approved at its current revision.`);
		throw new PlanError(`${move.id} is not ready.`);
	}
	if (plan.moves.some((other) => other.status === MOVE_STATUS.running)) throw new PlanError("Another move is still running; one focus runs at a time.");
	move.status = MOVE_STATUS.running;
	move.startedAt = stamp(now);
	delete move.blocked;
	delete move.undone;
	return { envelope, move };
}

/** Record a completed focus. This only records a claim; the orchestrator accepts a reported move later. */
export function reportMove(plan, id, revision, result, now) {
	const move = moveAt(plan, id);
	if (move === undefined || move.revision !== revision) return { changed: false, line: `${id} changed while its focus ran; its result was not accepted.` };
	if (move.status !== MOVE_STATUS.running) return { changed: false, line: `${id} is ${move.status}; its result was not accepted.` };
	const closureGap = typeof result?.closureGap === "string" ? flat(result.closureGap) : "";
	const claimed = result?.done === true && closureGap === "";
	const report = {
		at: stamp(now),
		claimed,
		...(typeof result?.report === "string" ? { id: result.report } : {}),
		...(Array.isArray(result?.changes) ? { changes: result.changes } : {}),
		...(Array.isArray(result?.commands) ? { commands: result.commands } : {}),
		...(ownObject(result?.checkpoints) ? { checkpoints: result.checkpoints } : {}),
		...(ownObject(result?.staging) ? { staging: result.staging } : {}),
		...(typeof result?.proof === "string" && flat(result.proof) !== "" ? { proof: flat(result.proof) } : {}),
		...(typeof result?.closureGap === "string" && flat(result.closureGap) !== "" ? { closureGap: flat(result.closureGap) } : {}),
		...(typeof result?.reason === "string" ? { reason: result.reason } : {}),
	};
	if (claimed) {
		move.status = MOVE_STATUS.reported;
		move.reported = report;
		delete move.blocked;
		return { changed: true, line: `${move.id} reported completion. Review its evidence, then accept the move.` };
	}
	move.status = MOVE_STATUS.blocked;
	move.blocked = typeof result?.reason === "string" && result.reason !== "" ? result.reason : closureGap !== "" ? `Closure gap: ${closureGap}` : "The focus returned not done.";
	move.reported = report;
	return { changed: true, line: `${move.id} is blocked: ${move.blocked}` };
}

/** Mark a move blocked when it cannot even reach return, for example a checkpoint failure. */
export function blockMove(plan, id, revision, reason, now) {
	const move = moveAt(plan, id);
	if (move === undefined || move.revision !== revision || move.status !== MOVE_STATUS.running) return false;
	move.status = MOVE_STATUS.blocked;
	move.blocked = flat(reason) || "The focus did not finish.";
	move.reported = { at: stamp(now), claimed: false, reason: move.blocked };
	return true;
}

function incompleteMoves(plan, parent) {
	return movesOf(plan, parent).filter((move) => move.status !== MOVE_STATUS.done && move.status !== MOVE_STATUS.superseded);
}

function invalidateEnvelopeMoves(plan, envelope, why) {
	let changed = 0;
	for (const move of movesOf(plan, envelope.id)) {
		if (move.status === MOVE_STATUS.done || move.status === MOVE_STATUS.superseded) continue;
		move.revision++;
		move.parentRevision = envelope.revision;
		// An envelope never expands a child's capability by implication. Taking network away takes it
		// away from every incomplete move; granting it leaves each existing move as narrowly declared.
		if (envelope.mode !== POLICY.enums.planMode.change) move.capabilities = { files: false, commands: false, network: false };
		else move.capabilities = moveCapabilities({ ...move.capabilities, network: envelope.network === true && move.capabilities?.network === true }, envelope);
		delete move.approvedRevision;
		delete move.approvedAt;
		if (move.status === MOVE_STATUS.running || move.status === MOVE_STATUS.reported) {
			move.status = MOVE_STATUS.blocked;
			move.blocked = why;
		} else {
			move.status = MOVE_STATUS.open;
			delete move.blocked;
		}
		changed++;
	}
	return changed;
}

function envelopeLine(item) {
	const fields = [item.mode, item.network ? "network" : undefined, item.standing ? "standing" : undefined].filter(Boolean).join(", ");
	const outcome = item.status === POLICY.enums.entryStatus.done && item.outcome ? ` → ${item.outcome}` : "";
	const acceptance = item.doneWhen ? ` (done when: ${item.doneWhen})` : item.legacy ? " (legacy envelope: add an observable done-when line and moves)" : "";
	const undone = item.undone ? ` (undone by ${USER_NAME})` : "";
	return `${item.id} [${fields}] ${item.text}${acceptance}${outcome}${undone}`;
}

function moveLine(move) {
	const state = move.status === MOVE_STATUS.done ? "done" : move.status === MOVE_STATUS.reported ? "reported" : move.status === MOVE_STATUS.running ? "running" : move.status === MOVE_STATUS.blocked ? "blocked" : approved(move) ? "approved" : "waits for approval";
	const targetsText = Array.isArray(move.targets) && move.targets.length > 0 ? ` · ${move.targets.join(", ")}` : "";
	const capabilities = move.capabilities?.network ? " · network" : "";
	const budget = move.budget ?? { replies: move.turns, fileOps: undefined, commandStarts: undefined };
	const limits = ` · ${budget.replies} replies${budget.fileOps !== undefined ? ` · ${budget.fileOps} file ops` : ""}${budget.commandStarts !== undefined ? ` · ${budget.commandStarts} commands` : ""}`;
	return `${move.id} [${state}${limits}${capabilities}] ${move.action ?? move.text}${targetsText}`;
}

/** One compact line for envelopes and moves, as the agent and user see them. */
export function itemLine(item) {
	return isMove(item) ? moveLine(item) : envelopeLine(item);
}

const addEnvelope = (plan, op) => {
	if (!MODES.includes(op.mode)) throw new PlanError(`\`mode\` is ${JSON.stringify(op.mode)}; it is look or change.`);
	if (plan.items.length >= ITEMS_MAX) throw new PlanError(`The plan has ${ITEMS_MAX} envelopes, which is its limit. Remove finished ones, or clear the plan.`);
	if (op.network === true && op.mode !== POLICY.enums.planMode.change) throw new PlanError("`network` goes with a change envelope.");
	if (op.standing === true && op.mode !== POLICY.enums.planMode.change) throw new PlanError("`standing` goes with a change envelope.");
	const item = {
		id: `${POLICY.idPrefixes.plan}${plan.next++}`,
		mode: op.mode,
		text: text(op.text, "`text`"),
		status: POLICY.enums.entryStatus.open,
		revision: 1,
	};
	if (op.mode === POLICY.enums.planMode.change) item.doneWhen = text(op.done_when ?? op.doneWhen, "`done_when` (the envelope's observable completion condition)");
	else if (typeof (op.done_when ?? op.doneWhen) === "string" && flat(op.done_when ?? op.doneWhen) !== "") item.doneWhen = text(op.done_when ?? op.doneWhen, "`done_when`");
	if (op.network === true) item.network = true;
	if (op.standing === true) item.standing = true;
	if (typeof op.before === "string" && op.before !== "") {
		const at = plan.items.findIndex((entry) => entry.id === op.before);
		if (at < 0) throw new PlanError(`\`before\` names no envelope: ${JSON.stringify(op.before)}.`);
		plan.items.splice(at, 0, item);
	} else plan.items.push(item);
	return { line: `${item.id} added as an authorization envelope. Add its executable moves before it can run.`, shown: `+ ${envelopeLine(item)}` };
};

const editEnvelope = (plan, item, op) => {
	const has = ["text", "mode", "network", "standing", "done_when", "doneWhen", "outcome"].some((key) => own(op, key));
	if (!has) throw new PlanError("An envelope edit needs `text`, `mode`, `done_when`, `network`, `standing` or `outcome`.");
	if (item.status === POLICY.enums.entryStatus.done) {
		if (!own(op, "outcome")) throw new PlanError(`${item.id} is done; only its outcome may change.`);
		item.outcome = text(op.outcome, "`outcome`");
		return { line: `${item.id} changed.`, shown: envelopeLine(item) };
	}
	const nextMode = own(op, "mode") ? op.mode : item.mode;
	if (!MODES.includes(nextMode)) throw new PlanError(`\`mode\` is ${JSON.stringify(nextMode)}; it is look or change.`);
	const nextNetwork = own(op, "network") ? op.network === true : item.network === true;
	const nextStanding = own(op, "standing") ? op.standing === true : item.standing === true;
	if (nextNetwork && nextMode !== POLICY.enums.planMode.change) throw new PlanError("`network` goes with a change envelope.");
	if (nextStanding && nextMode !== POLICY.enums.planMode.change) throw new PlanError("`standing` goes with a change envelope.");
	const nextText = own(op, "text") ? text(op.text, "`text`") : item.text;
	const givenDoneWhen = own(op, "done_when") ? op.done_when : own(op, "doneWhen") ? op.doneWhen : item.doneWhen;
	const nextDoneWhen = nextMode === POLICY.enums.planMode.change ? text(givenDoneWhen, "`done_when` (the envelope's observable completion condition)") : (typeof givenDoneWhen === "string" && flat(givenDoneWhen) !== "" ? text(givenDoneWhen, "`done_when`") : undefined);
	const changed = nextMode !== item.mode || nextNetwork !== (item.network === true) || nextStanding !== (item.standing === true) || nextText !== item.text || nextDoneWhen !== item.doneWhen;
	item.mode = nextMode;
	item.text = nextText;
	if (nextDoneWhen !== undefined) item.doneWhen = nextDoneWhen;
	else delete item.doneWhen;
	if (nextNetwork) item.network = true;
	else delete item.network;
	if (nextStanding) item.standing = true;
	else delete item.standing;
	delete item.legacy;
	if (!changed) return { line: `${item.id} did not change.`, shown: envelopeLine(item), withdrawn: false };
	item.revision++;
	const invalidated = invalidateEnvelopeMoves(plan, item, `The envelope ${item.id} changed while this move was incomplete.`);
	return {
		line: `${item.id} changed.${invalidated > 0 ? ` Its ${plural(invalidated, "incomplete move")} need approval again.` : ""}`,
		shown: envelopeLine(item),
		withdrawn: invalidated > 0,
	};
};

const addMove = (plan, op) => {
	if (plan.moves.length >= MOVES_MAX) throw new PlanError(`The plan has ${MOVES_MAX} moves, which is its limit. Complete, remove, or clear work first.`);
	const parent = envelopeAt(plan, String(op.parent ?? "").trim());
	if (parent === undefined) throw new PlanError("`parent` names no authorization envelope.");
	if (!envelopeOpen(parent)) throw new PlanError(`${parent.id} is not open; add a new envelope for further work.`);
	const mode = parent.mode;
	// `action` is the operation discriminator here (`addMove`); the move's own action
	// travels in `text` so one call cannot accidentally store the discriminator as work.
	const action = text(op.text ?? op.moveAction ?? op.move_action, "`text` (one concrete execution action)");
	if (op.budget !== undefined && !ownObject(op.budget)) throw new PlanError("`budget` must be an object.");
	const budget = moveBudget({ ...(ownObject(op.budget) ? op.budget : {}), ...(op.turns === undefined ? {} : { replies: op.turns }) }, mode);
	const move = {
		id: `${POLICY.idPrefixes.move}${plan.nextMove++}`,
		parent: parent.id,
		action,
		text: action,
		doneWhen: text(op.done_when ?? op.doneWhen, "`done_when` (the move's observable completion condition)"),
		capabilities: moveCapabilities(op.capabilities, parent),
		budget,
		turns: budget.replies,
		revision: 1,
		parentRevision: parent.revision,
		status: MOVE_STATUS.open,
	};
	if (mode === POLICY.enums.planMode.change) {
		move.targets = targets(op.targets, true);
		move.proof = text(op.proof, "`proof` (the evidence this move must return)", POLICY.limits.plan.proofChars);
	} else {
		const maybeTargets = op.targets === undefined ? undefined : targets(op.targets, false);
		if (maybeTargets !== undefined) move.targets = maybeTargets;
		if (typeof op.proof === "string" && flat(op.proof) !== "") move.proof = text(op.proof, "`proof`", POLICY.limits.plan.proofChars);
	}
	plan.moves.push(move);
	return { line: `${move.id} added under ${parent.id}. It waits for approval when it changes files.`, shown: `+ ${moveLine(move)}` };
};

const editMove = (plan, move, op) => {
	if (move.status === MOVE_STATUS.done || move.status === MOVE_STATUS.superseded) throw new PlanError(`${move.id} is ${move.status}; add a successor move instead.`);
	const parent = parentOf(plan, move);
	if (parent === undefined) throw new PlanError(`${move.id} names an envelope that no longer exists.`);
	const has = ["text", "moveAction", "move_action", "done_when", "doneWhen", "targets", "proof", "turns", "capabilities", "budget"].some((key) => own(op, key));
	if (!has) throw new PlanError("A move edit needs `text`, `done_when`, `targets`, `proof`, `turns`, `capabilities` or `budget`.");
	// `action` is the operation discriminator (`editMove`), never a replacement for
	// the declared work. `text` is the public field; aliases keep direct callers clear.
	const nextAction = own(op, "text") ? text(op.text, "`text`") : own(op, "moveAction") ? text(op.moveAction, "`moveAction`") : own(op, "move_action") ? text(op.move_action, "`move_action`") : (move.action ?? move.text);
	const nextDoneWhen = own(op, "done_when") ? text(op.done_when, "`done_when`") : own(op, "doneWhen") ? text(op.doneWhen, "`done_when`") : move.doneWhen;
	if (own(op, "budget") && !ownObject(op.budget)) throw new PlanError("`budget` must be an object.");
	const nextBudget = moveBudget({ ...(ownObject(move.budget) ? move.budget : {}), ...(ownObject(op.budget) ? op.budget : {}), ...(own(op, "turns") ? { replies: op.turns } : {}) }, parent.mode);
	const nextCapabilities = own(op, "capabilities") ? moveCapabilities({ ...move.capabilities, ...op.capabilities }, parent) : moveCapabilities(move.capabilities, parent);
	const nextTargets = parent.mode === POLICY.enums.planMode.change ? (own(op, "targets") ? targets(op.targets, true) : move.targets) : (own(op, "targets") ? targets(op.targets, false) : move.targets);
	const nextProof = parent.mode === POLICY.enums.planMode.change ? (own(op, "proof") ? text(op.proof, "`proof`", POLICY.limits.plan.proofChars) : move.proof) : (own(op, "proof") ? (typeof op.proof === "string" && flat(op.proof) !== "" ? text(op.proof, "`proof`", POLICY.limits.plan.proofChars) : undefined) : move.proof);
	const changed = nextAction !== (move.action ?? move.text) || nextDoneWhen !== move.doneWhen || JSON.stringify(nextBudget) !== JSON.stringify(move.budget ?? { replies: move.turns }) || JSON.stringify(nextCapabilities) !== JSON.stringify(move.capabilities) || JSON.stringify(nextTargets) !== JSON.stringify(move.targets) || nextProof !== move.proof;
	if (!changed) return { line: `${move.id} did not change.`, shown: moveLine(move), withdrawn: false };
	move.action = nextAction;
	move.text = nextAction;
	move.doneWhen = nextDoneWhen;
	move.budget = nextBudget;
	move.turns = nextBudget.replies;
	move.capabilities = nextCapabilities;
	if (nextTargets !== undefined) move.targets = nextTargets;
	else delete move.targets;
	if (nextProof !== undefined) move.proof = nextProof;
	else delete move.proof;
	move.revision++;
	move.parentRevision = parent.revision;
	delete move.approvedRevision;
	delete move.approvedAt;
	if (move.status === MOVE_STATUS.running || move.status === MOVE_STATUS.reported) {
		move.status = MOVE_STATUS.blocked;
		move.blocked = `${move.id} changed while it was incomplete.`;
	} else {
		move.status = MOVE_STATUS.open;
		delete move.blocked;
	}
	return { line: `${move.id} changed and needs approval again.`, shown: moveLine(move), withdrawn: true };
};

const acceptMove = (plan, move, op, now) => {
	if (move.status !== MOVE_STATUS.reported) throw new PlanError(`${move.id} is ${move.status}; only a reported move can be accepted.`);
	if (move.reported?.claimed !== true) throw new PlanError(`${move.id} did not claim completion.`);
	if (typeof move.reported?.closureGap === "string" && flat(move.reported.closureGap) !== "") throw new PlanError(`${move.id} reported a closure gap: ${flat(move.reported.closureGap)}. Revise the move or plan a successor instead of accepting it.`);
	const parent = parentOf(plan, move);
	if (parent === undefined || !envelopeOpen(parent)) throw new PlanError(`${move.id}'s envelope is no longer open.`);
	if (move.parentRevision !== parent.revision) throw new PlanError(`${move.id} belongs to an earlier revision of ${parent.id}; it cannot be accepted as current work.`);
	if (typeof move.reported?.id !== "string" || move.reported.id.trim() === "") throw new PlanError(`${move.id} has no durable focus report to review.`);
	if (parent.mode === POLICY.enums.planMode.change) {
		if (!ownObject(move.reported?.checkpoints) || typeof move.reported.checkpoints.before !== "string" || typeof move.reported.checkpoints.after !== "string") {
			throw new PlanError(`${move.id} has no before-and-after checkpoint evidence to review.`);
		}
		if (!Array.isArray(move.reported.changes)) throw new PlanError(`${move.id} has no changed-path evidence to review.`);
		const outside = move.reported.changes.filter((change) => typeof change?.path !== "string" || !targetAllows(move, change.path));
		if (outside.length > 0) throw new PlanError(`${move.id}'s report names changes outside its declared targets.`);
		if (typeof move.reported.proof !== "string" || flat(move.reported.proof) === "") throw new PlanError(`${move.id} has no stated proof for its required evidence.`);
	} else if (move.proof !== undefined && (typeof move.reported?.proof !== "string" || flat(move.reported.proof) === "")) {
		throw new PlanError(`${move.id} has no stated proof for its required evidence.`);
	}
	const review = text(op?.review, "`review` (how the reported proof witnesses this move's done-when)", POLICY.limits.plan.proofChars);
	move.status = MOVE_STATUS.done;
	move.closed = stamp(now);
	move.acceptedReview = review;
	move.outcome = `accepted after report${move.reported?.id ? ` ${move.reported.id}` : ""}`;
	delete move.approvedRevision;
	delete move.approvedAt;
	return { line: `${move.id} accepted.`, shown: moveLine(move) };
};

const completeEnvelope = (plan, item, op, now) => {
	if (item.status === POLICY.enums.entryStatus.done) return { line: `${item.id} was already done.`, shown: envelopeLine(item) };
	const incomplete = incompleteMoves(plan, item.id);
	if (incomplete.length > 0) throw new PlanError(`${item.id} still has ${incomplete.map((move) => `${move.id} (${move.status})`).join(", ")}. Accept or supersede every move before the envelope can be done.`);
	if (movesOf(plan, item.id).length === 0) throw new PlanError(`${item.id} has no execution moves. Add and complete declared moves before closing it.`);
	item.status = POLICY.enums.entryStatus.done;
	item.closed = stamp(now);
	if (typeof op.text === "string" && flat(op.text) !== "") item.outcome = text(op.text, "`text`");
	else if (typeof op.outcome === "string" && flat(op.outcome) !== "") item.outcome = text(op.outcome, "`outcome`");
	else item.outcome = item.doneWhen ?? "all declared moves accepted";
	delete item.undone;
	return { line: `${item.id} is done.`, shown: envelopeLine(item) };
};

/**
 * Apply one plan operation in place. The book tool, screen, terminal commands and
 * task completion all use this one semantic engine.
 */
export function applyPlanOp(plan, op, now, { yolo = false } = {}) {
	const action = op?.action;
	if (action === "clear") {
		const count = plan.items.length;
		plan.items = [];
		plan.moves = [];
		return { line: "The plan is empty now.", shown: `cleared (${plural(count, "envelope")})` };
	}
	if (action === "add") return addEnvelope(plan, op);
	if (action === "addMove") return addMove(plan, op);
	const id = String(op?.id ?? "").trim();
	const envelope = envelopeAt(plan, id);
	const move = moveAt(plan, id);
	if (action === "edit") {
		if (envelope === undefined) throw new PlanError(`There is no envelope ${JSON.stringify(id)}.`);
		return editEnvelope(plan, envelope, op);
	}
	if (action === "editMove") {
		if (move === undefined) throw new PlanError(`There is no move ${JSON.stringify(id)}.`);
		return editMove(plan, move, op);
	}
	if (action === "acceptMove") {
		if (move === undefined) throw new PlanError(`There is no move ${JSON.stringify(id)}.`);
		return acceptMove(plan, move, op, now);
	}
	if (action === POLICY.enums.actions.done) {
		if (move !== undefined) return acceptMove(plan, move, op, now);
		if (envelope === undefined) throw new PlanError(`There is no plan record ${JSON.stringify(id)}.`);
		return completeEnvelope(plan, envelope, op, now);
	}
	if (action === POLICY.enums.actions.remove) {
		if (move !== undefined) {
			if (move.status === MOVE_STATUS.running) throw new PlanError(`${move.id} is running and cannot be removed.`);
			plan.moves.splice(plan.moves.indexOf(move), 1);
			return { line: `${move.id} removed.`, shown: `- ${move.id}` };
		}
		if (envelope === undefined) throw new PlanError(`There is no envelope ${JSON.stringify(id)}.`);
		if (plan.moves.some((entry) => entry.parent === envelope.id && entry.status === MOVE_STATUS.running)) throw new PlanError(`${envelope.id} has a running move and cannot be removed.`);
		const gone = plan.moves.filter((entry) => entry.parent === envelope.id).length;
		plan.moves = plan.moves.filter((entry) => entry.parent !== envelope.id);
		plan.items.splice(plan.items.indexOf(envelope), 1);
		return { line: `${envelope.id} removed${gone > 0 ? ` with ${plural(gone, "move")}` : ""}.`, shown: `- ${envelope.id}` };
	}
	if (action === POLICY.enums.actions.before) {
		if (envelope === undefined) throw new PlanError(`There is no envelope ${JSON.stringify(id)}.`);
		const from = plan.items.indexOf(envelope);
		plan.items.splice(from, 1);
		if (op.before === undefined || String(op.before).trim() === "") plan.items.push(envelope);
		else {
			const at = plan.items.findIndex((entry) => entry.id === String(op.before).trim());
			if (at < 0) throw new PlanError(`\`before\` names no envelope: ${JSON.stringify(op.before)}.`);
			plan.items.splice(at, 0, envelope);
		}
		return { line: `${envelope.id} moved.`, shown: envelopeLine(envelope) };
	}
	throw new PlanError(`Unknown action ${JSON.stringify(action)}; the actions are add, edit, done, remove, before, clear, addMove, editMove and acceptMove.`);
}

/** Approve exact current move revisions. `p<N>` expands to its current waiting moves. */
export function approve(plan, now, ids) {
	const pending = waiting(plan);
	const wanted = ids === undefined ? pending.map((move) => move.id) : ids.filter((id) => typeof id === "string" && id !== "");
	const approvedIds = [];
	const unknown = [];
	for (const given of wanted) {
		const id = String(given).trim();
		const candidates = PLAN_ID.test(id) ? pending.filter((move) => move.parent === id) : pending.filter((move) => move.id === id);
		if (candidates.length === 0) {
			unknown.push(id);
			continue;
		}
		for (const move of candidates) {
			move.approvedRevision = move.revision;
			move.approvedAt = stamp(now);
			delete move.undone;
			approvedIds.push(move.id);
		}
	}
	return { approved: [...new Set(approvedIds)], unknown };
}

/** Decline exact current move revisions. A declined move is retained as superseded evidence. */
export function deny(plan, now, ids, reason = "") {
	const pending = waiting(plan);
	const wanted = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id.trim() !== "") : [];
	const denied = [];
	const unknown = [];
	for (const given of wanted) {
		const id = String(given).trim();
		const candidates = PLAN_ID.test(id) ? pending.filter((move) => move.parent === id) : pending.filter((move) => move.id === id);
		if (candidates.length === 0) { unknown.push(id); continue; }
		for (const move of candidates) {
			move.status = MOVE_STATUS.superseded;
			move.closed = stamp(now);
			move.outcome = flat(reason) || `${USER_NAME} declined this move.`;
			delete move.approvedRevision;
			delete move.approvedAt;
			denied.push(move.id);
		}
	}
	return { denied: [...new Set(denied)], unknown };
}

/** `/approve` with no ID: approve the current snapshot, never future moves. */
export function authorize(plan, now) {
	return approve(plan, now).approved.length;
}

/** A move-specific undo invalidates later accepted sibling moves for orchestration review. */
export function undoMove(plan, id, now) {
	const move = moveAt(plan, id);
	if (move === undefined) throw new PlanError(`There is no move ${JSON.stringify(id)}.`);
	const parent = parentOf(plan, move);
	if (parent === undefined) throw new PlanError(`${move.id} names an envelope that no longer exists.`);
	move.revision++;
	move.parentRevision = parent.revision;
	move.status = MOVE_STATUS.open;
	move.undone = stamp(now);
	delete move.approvedRevision;
	delete move.approvedAt;
	delete move.outcome;
	delete move.closed;
	delete move.acceptedReview;
	delete move.blocked;
	delete move.reported;
	delete move.startedAt;
	const at = plan.moves.indexOf(move);
	let stale = 0;
	for (const later of plan.moves.slice(at + 1)) {
		if (later.parent !== parent.id || later.status !== MOVE_STATUS.done) continue;
		later.status = MOVE_STATUS.blocked;
		later.blocked = `${move.id} was undone; review this later move before running or accepting it.`;
		stale++;
	}
	parent.status = POLICY.enums.entryStatus.open;
	parent.undone = stamp(now);
	delete parent.outcome;
	delete parent.closed;
	return { line: `${move.id} is open again and needs approval.${stale > 0 ? ` ${plural(stale, "later move")} now need review.` : ""}`, stale };
}

/** Compact summary in the state block. */
export function planSummary(plan) {
	if (plan.items.length === 0) return "no plan";
	const open = openItems(plan).length;
	const done = plan.items.length - open;
	const pending = waiting(plan).length;
	const ready = plan.moves.filter((move) => changeMove(plan, move) && mayRun(plan, move)).length;
	const reports = reportedMoves(plan).length;
	return `${plural(plan.items.length, "envelope")}${done > 0 ? `, ${done} done` : ""}${plan.moves.length > 0 ? ` · ${plural(plan.moves.length, "move")}` : ""}${pending > 0 ? ` · ${plural(pending, "move")} ${pending === 1 ? "waits" : "wait"} for approval` : ready > 0 ? ` · ${plural(ready, "move")} approved` : ""}${reports > 0 ? ` · ${plural(reports, "report")} to accept` : ""}`;
}

export const YOLO_LINE = "approval: OFF (yolo) · declared change moves may run without /approve, but each still has its own targets, limits, checkpoint and report · /undo takes one move back, /stop stops the agent";

/** First line of the rendered plan. */
export function authorizationLine(plan, { yolo = false } = {}) {
	const pending = waiting(plan);
	const ready = plan.moves.filter((move) => changeMove(plan, move) && mayRun(plan, move));
	const needsMoves = openItems(plan, POLICY.enums.planMode.change).filter((item) => movesOf(plan, item.id).length === 0);
	if (yolo && (pending.length > 0 || ready.length > 0)) return "Approval is off: declared change moves may run, within their own limits.";
	if (pending.length > 0) return `Not approved: ${plural(pending.length, "change move")} wait for ${USER_NAME}.`;
	if (ready.length > 0) return `Authorized by ${USER_NAME}: ${plural(ready.length, "change move")} may run.`;
	if (needsMoves.length > 0) return `No executable move is ready: ${names(needsMoves)} need decomposition.`;
	return "No change move is waiting for approval.";
}

const names = (items) => items.map((item) => item.id).join(", ");

/** Render envelopes with their moves. */
export function renderPlan(plan, options = {}) {
	if (plan.items.length === 0) return "There is no plan.";
	const lines = [authorizationLine(plan, options)];
	const archived = plan.items.filter((item) => item.archived === true).length;
	for (const item of plan.items) {
		if (item.archived === true) continue;
		if (item.status === POLICY.enums.entryStatus.done && !options.done) continue;
		lines.push(`${item.status === POLICY.enums.entryStatus.done ? "✓ " : ""}${envelopeLine(item)}`);
		for (const move of movesOf(plan, item.id)) {
			if (move.archived === true) continue;
			lines.push(`  ${move.status === MOVE_STATUS.done ? "✓ " : ""}${moveLine(move)}`);
		}
	}
	const done = plan.items.filter((item) => item.status === POLICY.enums.entryStatus.done && item.archived !== true);
	if (!options.done && done.length > 0) lines.push(`(done envelopes: ${done.map((item) => item.id).join(", ")})`);
	if (archived > 0) lines.push(`(${plural(archived, "archived envelope")} not shown)`);
	return lines.join("\n");
}
