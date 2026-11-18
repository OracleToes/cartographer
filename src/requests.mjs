import { POLICY } from "./config.mjs";
const PLAN_ID = new RegExp(POLICY.patterns.planId);
const MOVE_ID = new RegExp(POLICY.patterns.moveId);
const QUESTION_ID = new RegExp(POLICY.patterns.questionId);
// What waits for the user: one list, gathered from the plan (declared change moves awaiting approval) and the ledger
// (questions of taste). The agent does not stop for the user; each request waits independently while the agent
// goes on with whatever does not depend on its answer. The user answers in their own time: /requests lists them,
// /approve and /deny decide, /answer answers a question — or the user's own words in the chat carry the decision
// out (see approvalWords below). This file gathers the list and carries a decision out; each request stays
// in the book it belongs to.
import { loadLedger, saveLedger } from "./ledger.mjs";
import { approve, deny, itemLine, loadPlan, savePlan, waiting } from "./plan.mjs";
import { USER_HEAD } from "./user.mjs";
import { clipNote, warn } from "./warnings.mjs";

/**
 * @param {string} brainDir
 * @param {{ yolo?: boolean }} [more]  yolo: approval is off in this session, so no change move waits
 * @returns {{ id: string, kind: "approval" | "question", text: string }[]}
 */
export function listRequests(brainDir, { yolo = false } = {}) {
	const out = [];
	const { plan } = loadPlan(brainDir);
	if (plan !== undefined && !yolo) for (const item of waiting(plan)) out.push({ id: item.id, kind: "approval", text: itemLine(item) });
	const { ledger } = loadLedger(brainDir);
	if (ledger !== undefined) for (const item of ledger.items) if (item.kind === POLICY.enums.ledgerKind.question && item.status === POLICY.enums.entryStatus.open && item.archived !== true) out.push({ id: item.id, kind: POLICY.enums.ledgerKind.question, text: `${item.id}  ${item.text}` });
	return out;
}


// ─── Approval in the user's own words ─────────────────────────────────────────
// A visible yes can approve only the current declared move revision. It never gives a
// broad envelope or a future move permission.
const APPROVAL = /^(?:i\s+)?(?:y(?:es|eah|ep)|yeah|ok(?:ay)?|sure|approved?|go(?:\s+ahead)?|go\s+for\s+it|do\s+it|proceed|lgtm|ship(?:\s+it)?|looks\s+good|sounds\s+good)(?:(?:[ ,]+[pm]\d+)|(?:,?\s+(?:the\s+)?(?:plan|it|them|all|everything)))*[.!]*$/i;
const networkMove = (move) => move.capabilities?.network === true;

/**
 * Approve waiting moves from what the user typed, without the slash command.
 * A named p<N> snapshots its currently waiting children. A bare affirmative only
 * approves one non-network move; it never sweeps in a network move or future work.
 * @returns {string[] | undefined} approved move ids
 */
export function approvalWords(brainDir, text, now = new Date().toISOString()) {
	const line = String(text ?? "").trim();
	if (!APPROVAL.test(line)) return undefined;
	const { plan } = loadPlan(brainDir);
	if (plan === undefined) return undefined;
	const pending = waiting(plan);
	if (pending.length === 0) return undefined;
	const asked = line.match(/[pm]\d+/gi)?.map((id) => id.toLowerCase());
	const SCOPE = /(?:the\s+)?(?:plan|it|them|all|everything)\b/i;
	let ids;
	if (asked !== undefined) ids = asked;
	else if (SCOPE.test(line)) ids = pending.filter((move) => !networkMove(move)).map((move) => move.id);
	else {
		const open = pending.filter((move) => !networkMove(move));
		ids = open.length === 1 ? [open[0].id] : [];
	}
	if (ids.length === 0) return undefined;
	const result = approve(plan, now, ids);
	if (result.approved.length === 0) return undefined;
	savePlan(brainDir, plan);
	return result.approved;
}

/** The requests as lines for the agent's state block; "" when nothing waits. */
export function requestLines(brainDir, more) {
	const all = listRequests(brainDir, more);
	if (all.length === 0) return "";
	const label = { approval: "approval", question: "an answer" };
	return all.map((request) => `  ${request.text} · waits for ${label[request.kind]}`).join("\n");
}

/** Approve named move or envelope snapshots, or all waiting move revisions when no ids are supplied. */
export function approveRequests(brainDir, ids, now = new Date().toISOString()) {
	const wanted = (ids ?? []).filter((id) => id !== "");
	const all = wanted.length === 0;
	const done = { items: [], unknown: [] };
	const { plan } = loadPlan(brainDir);
	if (plan !== undefined) {
		const selected = all ? waiting(plan).map((move) => move.id) : wanted.filter((id) => PLAN_ID.test(id) || MOVE_ID.test(id));
		const result = selected.length === 0 ? { approved: [], unknown: wanted.filter((id) => PLAN_ID.test(id) || MOVE_ID.test(id)) } : approve(plan, now, selected);
		done.items = result.approved;
		done.unknown.push(...result.unknown);
		if (result.approved.length > 0) savePlan(brainDir, plan);
	}
	for (const id of wanted) if (!PLAN_ID.test(id) && !MOVE_ID.test(id)) done.unknown.push(id);
	return done;
}

/** Turn down a waiting move (or the current child snapshot of an envelope), or close a question. */
export function denyRequest(brainDir, id, reason, now = Date.now()) {
	if (PLAN_ID.test(id) || MOVE_ID.test(id)) {
		const { plan } = loadPlan(brainDir);
		if (plan === undefined) return undefined;
		const result = deny(plan, now, [id], reason);
		if (result.denied.length === 0) return undefined;
		savePlan(brainDir, plan);
		return { kind: "approval", text: result.denied.map((moveId) => itemLine(plan.moves.find((move) => move.id === moveId))).join("\n") };
	}
	if (QUESTION_ID.test(id)) return answerQuestion(brainDir, id, reason === "" ? `${USER_HEAD} does not want this pursued.` : `${USER_HEAD} does not want this pursued: ${reason}`, now);
	return undefined;
}

/**
 * The user answers a question of the ledger: it is closed with their answer as its outcome.
 * @returns {undefined | { kind: "question", text: string }}
 */
export function answerQuestion(brainDir, id, answer, now = Date.now()) {
	const { ledger } = loadLedger(brainDir);
	const item = ledger?.items.find((entry) => entry.id === id && entry.kind === POLICY.enums.ledgerKind.question && entry.status === POLICY.enums.entryStatus.open);
	if (item === undefined) return undefined;
	item.status = POLICY.enums.entryStatus.done;
	item.closed = now;
	const flat = String(answer).replace(/\s+/g, " ").trim();
	if (flat.length <= POLICY.limits.requests.outcomeChars) item.outcome = flat;
	else {
		// Nothing is lost silently: the user's words are clipped only with a note, and the record shows the cut.
		const clipped = `${flat.slice(0, POLICY.limits.requests.outcomeChars - 1).trimEnd()}…`;
		warn(clipNote("The answer", flat, clipped, POLICY.limits.requests.outcomeChars, { extra: "The full answer was sent to the agent when it was typed.", ask: false }));
		item.outcome = clipped;
	}
	saveLedger(brainDir, ledger);
	return { kind: POLICY.enums.ledgerKind.question, text: item.text };
}
