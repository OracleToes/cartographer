// The whole test suite, with a hard wall-clock budget. If everything together takes longer than
// BUDGET_MS, the run fails: slow tests are how a suite becomes a tax.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUDGET_MS = 10_000;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const suites = ["test/unit.mjs", "test/run.mjs"];
const started = Date.now();

const children = new Set();
const watchdog = setTimeout(() => {
	console.error(`\nThe whole test suite took longer than ${BUDGET_MS / 1000} seconds (budget: ${BUDGET_MS} ms); failing.`);
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
	process.exit(1);
}, BUDGET_MS);

const runSuite = (suite) => new Promise((resolve) => {
	const child = spawn(process.execPath, [join(root, suite)], { stdio: "inherit", cwd: root });
	children.add(child);
	let settled = false;
	const finish = (code) => {
		if (settled) return;
		settled = true;
		children.delete(child);
		resolve(code);
	};
	child.once("error", () => finish(1));
	child.once("close", (exit) => finish(exit ?? 1));
});

// The suites use isolated temp projects and standalone servers. Start both together so the immutable aggregate
// watchdog measures their real wall clock rather than paying one suite's process lifetime before the other starts.
const codes = await Promise.all(suites.map(runSuite));
const failed = codes.filter((code) => code !== 0).length;

clearTimeout(watchdog);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(failed === 0 ? `\nnpm test: all green in ${elapsed}s (budget ${BUDGET_MS / 1000}s)` : `\nnpm test: ${failed} suite(s) failed; ${elapsed}s (budget ${BUDGET_MS / 1000}s)`);
process.exit(failed === 0 ? 0 : 1);
