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

let failed = 0;
for (const suite of suites) {
	const code = await new Promise((resolve) => {
		const child = spawn(process.execPath, [join(root, suite)], { stdio: "inherit", cwd: root });
		children.add(child);
		child.on("error", () => resolve(1));
		child.on("close", (exit) => resolve(exit ?? 1));
	});
	if (code !== 0) failed++;
}

clearTimeout(watchdog);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(failed === 0 ? `\nnpm test: all green in ${elapsed}s (budget ${BUDGET_MS / 1000}s)` : `\nnpm test: ${failed} suite(s) failed; ${elapsed}s (budget ${BUDGET_MS / 1000}s)`);
process.exit(failed === 0 ? 0 : 1);
