/**
 * The suite's budget guard (AGENTS.md §5).
 *
 * `npm test` runs this script, which builds and then runs every test. The
 * budget covers both phases, enforced by aborting the process group at 10 seconds.
 *
 * A suite that runs past the budget is killed and the command exits 1 with
 * a plain message — that is a failure, not a pass. The fix is to improve
 * the slow test or drop the worst offender, then re-run npm test.
 *
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BUDGET_MS = 10_000;

// The collapse worker also imports fast-suite, which imports these small suites.
// Everything else is still discovered automatically as its own test worker.
const grouped = new Set([
  "brain.test.mjs", "brain-store.test.mjs", "freshness.test.mjs", "gitignore.test.mjs",
  "handles.test.mjs", "project-tree.test.mjs", "projection.test.mjs", "state-block.test.mjs", "ui-views.test.mjs",
  "compose.test.mjs", "person.test.mjs",
]);
const files = readdirSync("test")
  .filter((name) => name.endsWith(".test.mjs") && !grouped.has(name))
  .sort()
  .map((name) => join("test", name));

// The build and the runner share one wall-clock deadline and one process
// group at a time. Do not run the suite against an incomplete build.
let child;
let aborted = false;
const killChild = () => {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
};
const timer = setTimeout(() => {
  aborted = true;
  killChild();
}, BUDGET_MS);
process.on("SIGINT", killChild);

const run = (command, args) => new Promise((resolve, reject) => {
  child = spawn(command, args, { stdio: "inherit", detached: true });
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});

try {
  const started = performance.now();
  // npm has already put node_modules/.bin on PATH. Run the very same build
  // script directly rather than paying for a second npm startup.
  const build = JSON.parse(readFileSync("package.json", "utf8")).scripts.build;
  let code = await run("sh", ["-c", build]);
  console.log(`Build: ${((performance.now() - started) / 1000).toFixed(2)}s`);
  if (code === 0 && !aborted) {
    code = await run(process.execPath, ["--test", "--test-reporter=spec", "--test-concurrency=4", ...files]);
  }
  clearTimeout(timer);
  if (aborted) {
    console.error(`build and test suite exceeded ${BUDGET_MS / 1000} seconds — aborting the run`);
    process.exit(1);
  }
  process.exit(code);
} catch (error) {
  clearTimeout(timer);
  console.error(error);
  process.exit(1);
}
