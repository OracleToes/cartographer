// Promise-based child-process work for interactive presentation. Callers receive an exit fact; they never wait in a
// render or key handler with spawnSync/execSync. An AbortSignal ends the child and settles only after its streams
// close, so a cancelled projection cannot leave a Git/helper process running behind it.
import { spawn } from "node:child_process";

export class ProcessAbortError extends Error {
	constructor(message = "Process work was cancelled.") {
		super(message);
		this.name = "ProcessAbortError";
		this.code = "ABORT_ERR";
	}
}

export const isProcessAbort = (value) => value instanceof ProcessAbortError || value?.aborted === true || value?.name === "AbortError" || value?.code === "ABORT_ERR";

const outputLimit = (value) => Number.isSafeInteger(value) && value > 0 ? value : 64 * 1024 * 1024;

/**
 * Run one process without a shell and resolve its exit state. Output is bounded across stdout and stderr. `signal`
 * stops the child rather than merely abandoning its promise; `timeoutMs` has the same ownership. A caller can decide
 * whether an ordinary non-zero status is expected without catching a process-control exception.
 */
export function runProcess(command, args = [], {
	input,
	timeoutMs,
	stdio = ["ignore", "pipe", "pipe"],
	env = process.env,
	cwd,
	signal,
	maxOutputBytes,
} = {}) {
	if (signal?.aborted === true) return Promise.resolve({ status: null, signal: "SIGTERM", stdout: "", stderr: "", aborted: true });
	return new Promise((resolve) => {
		let child;
		let timer;
		let settled = false;
		let aborted = false;
		let timedOut = false;
		let limited = false;
		let captured = 0;
		const stdout = [];
		const stderr = [];
		const maximum = outputLimit(maxOutputBytes);
		const asText = (chunks) => Buffer.concat(chunks).toString("utf8");
		const removeAbort = () => signal?.removeEventListener?.("abort", abort);
		const finish = (result) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			removeAbort();
			resolve({
				...result,
				stdout: asText(stdout),
				stderr: asText(stderr),
				...(aborted ? { aborted: true } : {}),
				...(timedOut ? { timedOut: true } : {}),
				...(limited ? { outputLimit: true } : {}),
			});
		};
		const terminate = () => {
			try { child?.kill("SIGTERM"); } catch { /* close/error below remains the source of the exit fact */ }
		};
		const append = (target) => (chunk) => {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			const room = maximum - captured;
			if (room > 0) {
				const kept = bytes.length <= room ? bytes : bytes.subarray(0, room);
				target.push(kept);
				captured += kept.length;
			}
			if (bytes.length > room && !limited) {
				limited = true;
				terminate();
			}
		};
		const abort = () => {
			aborted = true;
			terminate();
		};
		try {
			child = spawn(command, args, { stdio, env, ...(cwd === undefined ? {} : { cwd }) });
		} catch (error) {
			finish({ error });
			return;
		}
		child.stdout?.on("data", append(stdout));
		child.stderr?.on("data", append(stderr));
		child.once("error", (error) => finish({ error }));
		child.once("close", (status, closeSignal) => finish({ status, signal: closeSignal }));
		if (input !== undefined && child.stdin !== null) {
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		}
		if (signal !== undefined) {
			signal.addEventListener?.("abort", abort, { once: true });
			if (signal.aborted === true) abort();
		}
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				terminate();
			}, timeoutMs);
			timer.unref?.();
		}
	});
}
