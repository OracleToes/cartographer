// One place for "this was trimmed or adjusted for you" notes, raised by the write paths and drained by the tool
// layer (src/tools/book.mjs), so the agent is told exactly what was done to its input instead of getting it
// refused blind. Notes accumulate until the tool call ends, then ride on the result as `note:` lines.
const pending = [];

/** Record a note: something was trimmed or adjusted, and the agent should know. */
export const warn = (message) => pending.push(message);

/** Drain the notes, oldest first. After draining the list is empty. */
export const takeWarnings = () => pending.splice(0, pending.length);
