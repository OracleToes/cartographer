/**
 * The suite's budget guard (AGENTS.md §5).
 *
 * `npm test` runs `npm run build` and then this script. This script spawns
 * `node --test` over every `test/*.test.mjs` file, measured from spawn to
 * exit, with the budget enforced by aborting the suite at 10 seconds.
 *
 * A suite that runs past the budget is killed and the command exits 1 with
 * a plain message — that is a failure, not a pass. The fix is to improve
 * the slow test or drop the worst offender, then re-run npm test.
 *
 * The measured quantity is the `node --test` run itself; the build is
 * outside the budget because it is a distinct step and already gates on its
 * own exit code.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const BUDGET_MS = 10_000;

const files = readdirSync("test")
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("test", name));

// Files run concurrently, not one after another. Every test file here owns its
// own temp root and its own CARTO_HOME, so nothing they do can reach across;
// what this buys is wall time, and the budget below is wall time.
const child = spawn(process.execPath, ["--test", "--test-concurrency=4", ...files], {
  stdio: "inherit",
  detached: true,
});

let aborted = false;
const timer = setTimeout(() => {
  aborted = true;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
}, BUDGET_MS);

process.on("SIGINT", () => {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
});

child.on("exit", (code) => {
  clearTimeout(timer);
  if (aborted) {
    console.error("");
    console.error(`the test suite has exceeded ${BUDGET_MS / 1000} seconds — aborting the run`);
    console.error("improve the slow test or drop the worst offender, then re-run npm test");
    process.exit(1);
  }
  process.exit(code ?? 1);
});
