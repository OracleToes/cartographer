import { POLICY } from "./config.mjs";
const PLAN_ID = new RegExp(POLICY.patterns.planId);
const QUESTION_ID = new RegExp(POLICY.patterns.questionId);
// What waits for the user: one list over all the agent's books.
//
// The agent does not stop for the user. A change item it adds to the plan waits for approval; a matter of taste
// becomes a question in the ledger. Each request can wait independently while the agent goes on with whatever
// does not depend on its answer. The user answers in their own time: /requests lists them,
// /approve and /deny decide, /answer answers a question. This file gathers the list and carries a decision out;
// each request stays in the book it belongs to.
import { loadLedger, saveLedger } from "./ledger.mjs";
import { approve, itemLine, loadPlan, savePlan, waiting } from "./plan.mjs";

/**
 * @param {string} brainDir
 * @param {{ yolo?: boolean }} [more]  yolo: the user has switched approval off, so no change item waits
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

/** The requests as lines for the agent's state block; "" when nothing waits. */
export function requestLines(brainDir, more) {
	const all = listRequests(brainDir, more);
	if (all.length === 0) return "";
	const label = { approval: "approval", question: "an answer" };
	return all.map((request) => `  ${request.kind === "approval" ? request.text : request.text} · waits for ${label[request.kind]}`).join("\n");
}

/** Approve named change items, or all waiting change items when no ids are supplied. */
export function approveRequests(brainDir, ids, now = new Date().toISOString()) {
	const wanted = (ids ?? []).filter((id) => id !== "");
	const all = wanted.length === 0;
	const done = { items: [], unknown: [] };
	const { plan } = loadPlan(brainDir);
	if (plan !== undefined) {
		const selected = all ? waiting(plan).map((item) => item.id) : wanted.filter((id) => PLAN_ID.test(id));
		const result = selected.length === 0 ? { approved: [], unknown: wanted.filter((id) => PLAN_ID.test(id)) } : approve(plan, now, selected);
		done.items = result.approved;
		done.unknown.push(...result.unknown);
		if (result.approved.length > 0) savePlan(brainDir, plan);
	}
	for (const id of wanted) if (!PLAN_ID.test(id)) done.unknown.push(id);
	return done;
}

/** Turn down a waiting change item, or close a question as not to be pursued. */
export function denyRequest(brainDir, id, reason, now = Date.now()) {
	if (PLAN_ID.test(id)) {
		const { plan } = loadPlan(brainDir);
		const item = plan === undefined ? undefined : waiting(plan).find((entry) => entry.id === id);
		if (item === undefined) return undefined;
		plan.items.splice(plan.items.indexOf(item), 1);
		savePlan(brainDir, plan);
		return { kind: "approval", text: itemLine(item) };
	}
	if (QUESTION_ID.test(id)) return answerQuestion(brainDir, id, reason === "" ? "The user does not want this pursued." : `The user does not want this pursued: ${reason}`, now);
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
	item.outcome = String(answer).replace(/\s+/g, " ").trim().slice(0, POLICY.limits.requests.outcomeChars);
	saveLedger(brainDir, ledger);
	return { kind: POLICY.enums.ledgerKind.question, text: item.text };
}
