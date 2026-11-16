// One place for "this was trimmed or adjusted for you" notes, raised by the write paths and drained by the tool
// layer (src/tools/book.mjs), so the agent is told exactly what was done to its input instead of getting it
// refused blind. Notes accumulate until the tool call ends, then ride on the result as `note:` lines.
const pending = [];

/** Record a note: something was trimmed or adjusted, and the agent should know. */
export const warn = (message) => pending.push(message);

/** Drain the notes, oldest first. After draining the list is empty. */
export const takeWarnings = () => pending.splice(0, pending.length);
/**
 * Tell the agent its text was clipped, show the clip, and force the decision.
 * @param {string} what      what was clipped, e.g. "`gist`" or "The name of the node"
 * @param {string} original   the text as the agent wrote it
 * @param {string} clipped    the text as it was stored (may carry an ellipsis)
 * @param {number} limit      the character limit
 * @param {object} [options]
 * @param {string} [options.extra]    site advice, e.g. "put the rest into `detail`"
 * @param {string} [options.remedy]   how to fix it, e.g. "the book edit for the entry" (default: "the edit tool")
 * @param {boolean} [options.ask]     false when there is nothing for the agent to edit (the record keeps the cut)
 */
export const clipNote = (what, original, clipped, limit, { extra, remedy, ask = true } = {}) => {
	const said = `${what} was clipped from ${String(original).length} to ${limit} characters; the rest is dropped.${extra ? ` ${extra}` : ""} It says: "${clipped}".`;
	if (!ask) return said;
	return `${said} Should I edit it? Yes or no — if yes, I use ${remedy ?? "the edit tool"} and keep it to ${limit} characters; if it clips again the same question comes back. If no, the clipped version stands.`;
};
