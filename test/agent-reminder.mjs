/**
 * Mandatory test-run reminder (AGENTS.md §5, §9, §10).
 *
 * Every test run — whether through `npm test` (`test/guard.mjs`) or any
 * individual test suite — must echo these instructions. Never remove or
 * silence this reminder.
 */
export const AGENT_REMINDER = [
  "[AGENTS.md REMINDER — DO NOT REMOVE FROM TESTS]",
  "- Read ALL LINES of AGENTS.md immediately if you have not already read it this turn.",
  "- If this turn started with a compacted session summary, inform OracleToes once in this reply.",
  "- Never remove this reminder from the test harness or any test suite.",
].join("\n");

let printed = false;

export function printAgentReminder() {
  if (printed) return;
  printed = true;
  process.stdout.write(`\n${AGENT_REMINDER}\n`);
}

// When a test file is run directly (outside `test/guard.mjs`), echo the
// reminder on exit so no test run ever skips it. When run via `test/guard.mjs`,
// the guard prints it once at the very end of the suite output.
if (process.env.CARTO_GUARD_REMINDER !== "1") {
  process.once("exit", printAgentReminder);
}
