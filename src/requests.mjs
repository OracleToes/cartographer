// What waits for the user: one list over all the agent's books.
//
// The agent does not stop for the user. A change item it adds to the plan waits for approval; a matter of taste
// becomes a question in the ledger; a change to its own prompt is a proposal. Each of these is a request, and the
// agent goes on with whatever does not depend on one. The user answers in their own time: /requests lists them,
// /approve and /deny decide, /answer answers a question. This file gathers the list and carries a decision out;
// each request stays in the book it belongs to.
import { loadLedger, saveLedger } from "./ledger.mjs";
import { approve, itemLine, loadPlan, savePlan, waiting } from "./plan.mjs";
import { decide, loadProposals, proposalDiff, proposalLine } from "./proposals.mjs";

/**
 * @param {string} brainDir
 * @param {{ yolo?: boolean }} [more]  yolo: the user has switched approval off, so no change item waits
 * @returns {{ id: string, kind: "approval" | "question" | "prompt", text: string, detail?: string[] }[]}
 */
export function listRequests(brainDir, { yolo = false } = {}) {
	const out = [];
	const { plan } = loadPlan(brainDir);
	if (plan !== undefined && !yolo) for (const item of waiting(plan)) out.push({ id: item.id, kind: "approval", text: itemLine(item) });
	const { ledger } = loadLedger(brainDir);
	if (ledger !== undefined) for (const item of ledger.items) if (item.kind === "question" && item.status === "open" && item.archived !== true) out.push({ id: item.id, kind: "question", text: `${item.id}  ${item.text}` });
	for (const item of loadProposals(brainDir).items) out.push({ id: item.id, kind: "prompt", text: proposalLine(item), detail: proposalDiff(item) });
	return out;
}

/** The requests as lines for the agent's state block; "" when nothing waits. */
export function requestLines(brainDir, more) {
	const all = listRequests(brainDir, more);
	if (all.length === 0) return "";
	const label = { approval: "approval", question: "an answer", prompt: "a decision on your prompt" };
	return all.map((request) => `  ${request.kind === "approval" ? request.text : request.text} · waits for ${label[request.kind]}`).join("\n");
}

/**
 * The user approves requests: the ones named, or everything that can be approved (change items and proposals;
 * a question is answered, not approved).
 * @returns {{ items: string[], proposals: any[], unknown: string[] }}
 */
export function approveRequests(brainDir, coreDir, ids, now = new Date().toISOString()) {
	const wanted = (ids ?? []).filter((id) => id !== "");
	const all = wanted.length === 0;
	const done = { items: [], proposals: [], unknown: [] };
	const { plan } = loadPlan(brainDir);
	if (plan !== undefined) {
		const ids = all ? waiting(plan).map((item) => item.id) : wanted.filter((id) => /^p\d+$/.test(id));
		const result = ids.length === 0 ? { approved: [], unknown: wanted.filter((id) => /^p\d+$/.test(id)) } : approve(plan, now, ids);
		done.items = result.approved;
		done.unknown.push(...result.unknown);
		if (result.approved.length > 0) savePlan(brainDir, plan);
	}
	const proposals = loadProposals(brainDir).items.filter((item) => all || wanted.includes(item.id));
	for (const item of proposals) {
		const result = decide(brainDir, coreDir, item.id, true);
		if (result !== undefined) done.proposals.push(result.item);
	}
	for (const id of wanted) if (!/^p\d+$/.test(id) && !proposals.some((item) => item.id === id)) done.unknown.push(id);
	return done;
}

/**
 * The user turns a request down: a change item is taken out of the plan, a proposal is dropped, a question is
 * closed as not to be pursued.
 * @returns {undefined | { kind: string, text: string }} undefined when nothing of that name waits
 */
export function denyRequest(brainDir, coreDir, id, reason, now = Date.now()) {
	if (/^p\d+$/.test(id)) {
		const { plan } = loadPlan(brainDir);
		const item = plan === undefined ? undefined : waiting(plan).find((entry) => entry.id === id);
		if (item === undefined) return undefined;
		plan.items.splice(plan.items.indexOf(item), 1);
		savePlan(brainDir, plan);
		return { kind: "approval", text: itemLine(item) };
	}
	if (/^x\d+$/.test(id)) {
		const result = decide(brainDir, coreDir, id, false);
		return result === undefined ? undefined : { kind: "prompt", text: proposalLine(result.item) };
	}
	if (/^q\d+$/.test(id)) return answerQuestion(brainDir, id, reason === "" ? "The user does not want this pursued." : `The user does not want this pursued: ${reason}`, now);
	return undefined;
}

/**
 * The user answers a question of the ledger: it is closed with their answer as its outcome.
 * @returns {undefined | { kind: "question", text: string }}
 */
export function answerQuestion(brainDir, id, answer, now = Date.now()) {
	const { ledger } = loadLedger(brainDir);
	const item = ledger?.items.find((entry) => entry.id === id && entry.kind === "question" && entry.status === "open");
	if (item === undefined) return undefined;
	item.status = "done";
	item.closed = now;
	item.outcome = String(answer).replace(/\s+/g, " ").trim().slice(0, 400);
	saveLedger(brainDir, ledger);
	return { kind: "question", text: item.text };
}
