// The read gate: one transient `read` comes back per reply, in every turn.
//
// Because `dressReads` holds one transient read at the tail of the request and folds earlier reads to one line,
// running two `read` calls in the same reply would drop the first before the model ever saw it. `beforeTool` lets
// the first file read of a reply through and refuses the rest with a direct pointer to `shelf`, where several files
// stay in view together across turns and collapses. `shelf` calls themselves are never gated here.
const callsOf = (message) => (Array.isArray(message?.content) ? message.content.filter((part) => part.type === "toolCall") : []);
const isFileRead = (call) => call?.name === "read" || (call?.name === "book" && call.arguments?.action === "read" && call.arguments?.target === "file");

/** In-flight gate per conversation for the reply whose tool calls are currently running. */
const gates = new Map();

/** Name the target in a refusal: the path when given, otherwise the id. */
const displayOf = (args) => {
	if (typeof args?.path === "string" && args.path.trim() !== "") return args.path.trim();
	if (typeof args?.id === "string" && args.id.trim() !== "") return args.id.trim();
	if (typeof args?.ref?.id === "string" && args.ref.id.trim() !== "") return args.ref.id.trim();
	return "This file";
};

/**
 * Plan the file-read gate for the assistant reply whose tool calls are about to run.
 * A reply without file reads clears any prior gate for that conversation.
 * @param {string} conversationId
 * @param {object} message  the assistant message that just arrived
 */
export function beginReadGate(conversationId, message) {
	const planned = callsOf(message).filter(isFileRead).length;
	if (planned === 0) {
		gates.delete(conversationId);
		return;
	}
	gates.set(conversationId, { ran: false });
}

/**
 * Decide whether one tool call may run: the first file read of a planned reply runs; further file reads in the same
 * reply are refused before reading disk and point at `shelf`. Non-read calls always pass.
 * @returns {string | undefined} refusal text for `beforeTool`, or undefined to allow the call
 */
export function readGateCheck(conversationId, call) {
	if (!isFileRead(call)) return undefined;
	const gate = gates.get(conversationId);
	if (gate === undefined) return undefined;
	if (!gate.ran) {
		gate.ran = true;
		return undefined;
	}
	return `${displayOf(call.arguments)} was not read: \`read\` holds one file in view at a time. Call \`shelf\` (action="add") to hold several files in view together, or \`read\` it on the next step.`;
}

const LEGACY_SHELF_ASK = /\n*<shelf-ask>[\s\S]*?<\/shelf-ask>\n?/g;

/** Strip legacy `<shelf-ask>` blocks left in older stored transcripts. */
export const withoutShelfAsk = (text) => String(text ?? "").replace(LEGACY_SHELF_ASK, "");
