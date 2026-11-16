// A reply's project-file reads are one transient batch.
//
// `dressReads` puts every successful read from the newest such reply together at the end of the next request. A
// batch is deliberately short-lived: the next successful batch replaces all of it, while `shelf` is the explicit
// place for files that must survive a later batch or a collapse. This module keeps the batch bounded before disk is
// read, and gives every permitted call an even share of the existing read-output ceiling.
import { POLICY } from "./config.mjs";

const callsOf = (message) => (Array.isArray(message?.content) ? message.content.filter((part) => part.type === "toolCall") : []);

/** A project-file read, including an old stored `book file read` replay. */
export const isFileRead = (call) => call?.name === "read" || (call?.name === "book" && call.arguments?.action === "read" && call.arguments?.target === "file");

const batches = new Map();
const MAX_FILES = POLICY.limits.look.readMaxFiles;
const TOTAL_TOKENS = POLICY.limits.look.readTokenCeiling;

/** Name the target in a refusal: the path when given, otherwise the id. */
const displayOf = (args) => {
	if (typeof args?.path === "string" && args.path.trim() !== "") return args.path.trim();
	if (typeof args?.id === "string" && args.id.trim() !== "") return args.id.trim();
	if (typeof args?.ref?.id === "string" && args.ref.id.trim() !== "") return args.ref.id.trim();
	return "This file";
};

/**
 * Plan the read batch for the assistant reply whose calls are about to run. Calls beyond the fixed file bound are
 * refused, but every permitted call gets a stable share even when the Harness executes the calls in parallel.
 * A reply without project-file reads clears the prior plan for this conversation.
 * @param {string} conversationId
 * @param {object} message the assistant message that just arrived
 */
export function beginReadBatch(conversationId, message) {
	const reads = callsOf(message).filter(isFileRead);
	if (reads.length === 0) {
		batches.delete(conversationId);
		return;
	}
	const permitted = reads.slice(0, MAX_FILES);
	const base = Math.floor(TOTAL_TOKENS / permitted.length);
	const remainder = TOTAL_TOKENS % permitted.length;
	// Give the first calls the indivisible remainder in reply order, so every planned allowance sums exactly to the
	// old one-read ceiling. The reply owns this plan before its calls begin, so parallel execution cannot race it.
	const allowances = new Map();
	for (const [index, call] of permitted.entries()) {
		if (typeof call.id === "string" && call.id !== "") allowances.set(call.id, base + (index < remainder ? 1 : 0));
	}
	batches.set(conversationId, { allowances });
}

/**
 * Decide whether one project-file read belongs to the current reply's batch. Non-read calls always pass.
 * @returns {string | undefined} refusal text for `beforeTool`, or undefined to allow the call
 */
export function readBatchCheck(conversationId, call) {
	if (!isFileRead(call)) return undefined;
	const batch = batches.get(conversationId);
	if (batch === undefined) return undefined;
	if (typeof call?.id === "string" && batch.allowances.has(call.id)) return undefined;
	return `${displayOf(call.arguments)} was not read: this reply's read batch already has ${MAX_FILES} files. Start a later read batch, or put files that must survive it on \`shelf\` (action="add").`;
}

/** The per-call output allowance for the current read batch, or undefined outside one. */
export function readBatchAllowance(conversationId, callId) {
	if (typeof callId !== "string" || callId === "") return undefined;
	return batches.get(conversationId)?.allowances.get(callId);
}

const LEGACY_SHELF_ASK = /\n*<shelf-ask>[\s\S]*?<\/shelf-ask>\n?/g;

/** Strip legacy `<shelf-ask>` blocks left in older stored transcripts. */
export const withoutShelfAsk = (text) => String(text ?? "").replace(LEGACY_SHELF_ASK, "");
