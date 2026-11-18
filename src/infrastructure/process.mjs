// Promise-based child-process work for interactive presentation. Callers receive an exit fact; they never wait in a
// render or key handler with spawnSync/execSync.
import { spawn } from "node:child_process";

/**
 * Run one process without a shell and resolve its exit state. `timeoutMs` ends the child rather than leaving a
 * clipboard/helper process alive after its usefulness has passed.
 */
export function runProcess(command, args = [], { input, timeoutMs, stdio = ["ignore", "ignore", "ignore"], env = process.env } = {}) {
	return new Promise((resolve) => {
		let child;
		let timer;
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve(result);
		};
		try {
			child = spawn(command, args, { stdio, env });
		} catch (error) {
			finish({ error });
			return;
		}
		child.once("error", (error) => finish({ error }));
		child.once("close", (status, signal) => finish({ status, signal }));
		if (input !== undefined && child.stdin !== null) {
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		}
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timer = setTimeout(() => {
				child.kill();
				finish({ status: null, signal: "SIGTERM", timedOut: true });
			}, timeoutMs);
			timer.unref?.();
		}
	});
}
