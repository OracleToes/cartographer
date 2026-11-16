import { POLICY } from "./config.mjs";
const PLAN_ID = new RegExp(POLICY.patterns.planId);
const QUESTION_ID = new RegExp(POLICY.patterns.questionId);
// What waits for the user: one list, gathered from the plan (change items awaiting approval) and the ledger
// (questions of taste). The agent does not stop for the user; each request waits independently while the agent
// goes on with whatever does not depend on its answer. The user answers in their own time: /requests lists them,
// /approve and /deny decide, /answer answers a question — or the user's own words in the chat carry the decision
// out (see approvalWords below). This file gathers the list and carries a decision out; each request stays
// in the book it belongs to.
import { loadLedger, saveLedger } from "./ledger.mjs";
import { approve, itemLine, loadPlan, savePlan, waiting } from "./plan.mjs";
import { USER_HEAD } from "./user.mjs";
import { clipNote, warn } from "./warnings.mjs";

/**
 * @param {string} brainDir
 * @param {{ yolo?: boolean }} [more]  yolo: approval is off in this session, so no change item waits
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
// The catch this closes: the user writes "yes" or "approved p1" as a message instead of typing /approve, and the
// gate (a change task is only carried out for an authorized item) refuses the work they just approved. An unambiguous
// affirmative, optionally naming items of the plan, approves what waits. Anything less clear is not an approval:
// the line goes to the agent as written.
const APPROVAL = /^(?:i\s+)?(?:y(?:es|eah|ep)|yeah|ok(?:ay)?|sure|approved?|go(?:\s+ahead)?|go\s+for\s+it|do\s+it|proceed|lgtm|ship(?:\s+it)?|looks\s+good|sounds\s+good)(?:(?:[ ,]+p\d+)|(?:,?\s+(?:the\s+)?(?:plan|it|them|all|everything)))*[.!]*$/i;

/**
 * Approve waiting change items from what the user typed, without the slash command.
 * Bare words authorize the waiting change items that do NOT reach the network; an item marked `network`
 * needs to be named (approvalWords("approved p2")) or the slash command. A line that only names network
 * items is still an approval of them — naming is deliberate.
 * @returns {string[] | undefined} the approved ids, or undefined when the line is not an approval or nothing waits
 */
export function approvalWords(brainDir, text, now = new Date().toISOString()) {
	const line = String(text ?? "").trim();
	if (!APPROVAL.test(line)) return undefined;
	const { plan } = loadPlan(brainDir);
	if (plan === undefined) return undefined;
	const pending = waiting(plan);
	if (pending.length === 0) return undefined;
	const asked = line.match(/p\d+/gi)?.map((id) => id.toLowerCase());
	// Unambiguous, item by item: the user named it, so it runs. Anything else on the line does not ride along.
	const ids = asked === undefined
		? pending.filter((item) => item.network !== true).map((item) => item.id)
		: pending.filter((item) => asked.includes(item.id)).map((item) => item.id);
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
