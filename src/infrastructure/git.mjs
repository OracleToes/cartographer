// Abort-aware Git reads for settled Screen projections. Checkpoint mutation remains in its established domain owner;
// this adapter only reconstructs the same review facts with spawned Git commands and a disposable index, so a
// cancelled inspection never rewrites the checkpoint repository's durable index.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POLICY } from "../config.mjs";
import { isProcessAbort, runProcess } from "./process.mjs";

const SETTINGS = [
	"user.name=Cartographer",
	"user.email=cartographer@localhost",
	"commit.gpgsign=false",
	"core.hooksPath=/dev/null",
	"core.autocrlf=false",
	"core.safecrlf=false",
	"core.fsmonitor=false",
	"core.quotePath=false",
	"gc.auto=0",
	"advice.addEmbeddedRepo=false",
].flatMap((setting) => ["-c", setting]);

const text = (value) => typeof value === "string" ? value.trim() : "";
const shadowDir = (brainDir) => join(brainDir, "checkpoints.git");
const report = (callback, progress) => {
	try { callback?.(progress); } catch { /* Presentation progress never owns a spawned read. */ }
};

export class GitAbortError extends Error {
	constructor(message = "Git review work was cancelled.") {
		super(message);
		this.name = "GitAbortError";
		this.code = "ABORT_ERR";
	}
}

export class GitReadError extends Error {
	constructor(message, { cause } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "GitReadError";
	}
}

export const isGitAbort = (error) => error instanceof GitAbortError || isProcessAbort(error);
const throwIfAborted = (signal) => {
	if (signal?.aborted === true) throw new GitAbortError();
};
const detail = (result) => text(result?.stderr) || text(result?.stdout) || text(result?.error?.message) || "no detail was returned";
const checkpointEnv = (base, { literal = false, indexFile } = {}) => {
	const env = { ...base, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) delete env[name];
	if (literal) env.GIT_LITERAL_PATHSPECS = "1";
	if (indexFile !== undefined) env.GIT_INDEX_FILE = indexFile;
	return env;
};
const projectEnv = (base) => ({ ...base, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });

const newestTask = (log) => {
	for (let index = 0; index < log.length; index++) {
		const { label } = log[index];
		if (label.startsWith("undo ")) {
			const undone = log.findIndex((entry) => entry.id === label.slice(5).trim());
			if (undone === -1) return undefined;
			index = undone;
		} else if (label.startsWith("before ") && label !== "before undo") {
			const next = log[index - 1];
			return { before: log[index], after: next?.label.startsWith("after ") ? next : undefined };
		}
	}
	return undefined;
};

const parseBefore = (label) => {
	const [, item, task] = /^before (\S+?): (.*)$/.exec(label) ?? [];
	if (item?.startsWith("window:")) return { windows: item.slice(7).split("+"), text: task ?? label };
	return { item, text: task ?? label };
};

/**
 * Provide genuine asynchronous Git reads for the Screen's tree and Diff projections. A custom `run`/`fs` seam keeps
 * cancellation and failure cases deterministic without turning a synchronous checkpoint helper into a pretend job.
 */
export function createGitReviewReader({ run = runProcess, env = process.env, fs = {}, temporaryDir = tmpdir() } = {}) {
	if (typeof run !== "function") throw new TypeError("Git review reads need an asynchronous process runner.");
	const io = { mkdtemp: fs.mkdtemp ?? mkdtemp, rm: fs.rm ?? rm };
	const invoke = async (args, { cwd, environment, signal, quiet = false, missingOk = false, reportProgress, message, maxOutputBytes = POLICY.limits.git.maxBufferBytes } = {}) => {
		throwIfAborted(signal);
		report(reportProgress, { message });
		let result;
		try {
			result = await run("git", args, {
				cwd,
				env: environment,
				signal,
				maxOutputBytes,
			});
		} catch (error) {
			if (signal?.aborted === true || isProcessAbort(error)) throw new GitAbortError();
			if (quiet) return undefined;
			throw new GitReadError(`Git could not ${message?.toLowerCase() ?? "complete the review read"}: ${text(error?.message) || "an unknown process error"}.`, { cause: error });
		}
		if (signal?.aborted === true || result?.aborted === true) throw new GitAbortError();
		if (result?.outputLimit === true) throw new GitReadError(`Git produced more than ${maxOutputBytes} bytes while it tried to ${message?.toLowerCase() ?? "read review data"}.`);
		if (result?.error !== undefined || result?.status !== 0) {
			// A missing repository is an ordinary empty Git projection; a missing Git executable is not.
			if (result?.error?.code === "ENOENT") throw new GitReadError("Git is not installed, so this review projection is unavailable.", { cause: result.error });
			if (quiet || missingOk) return undefined;
			throw new GitReadError(`Git could not ${message?.toLowerCase() ?? "complete the review read"}: ${detail(result).slice(0, POLICY.limits.git.errorChars)}.`);
		}
		return String(result.stdout ?? "");
	};
	const checkpoint = (root, brainDir, args, options = {}) => invoke([
		"--git-dir", shadowDir(brainDir),
		"--work-tree", root,
		...SETTINGS,
		...args,
	], {
		cwd: root,
		environment: checkpointEnv(env, options),
		...options,
	});
	const project = (root, args, options = {}) => invoke(args, {
		cwd: root,
		environment: projectEnv(env),
		maxOutputBytes: POLICY.limits.git.checkpointBufferBytes,
		...options,
	});
	const history = async (root, brainDir, { signal, reportProgress } = {}) => {
		const head = await checkpoint(root, brainDir, ["rev-parse", "-q", "--verify", "HEAD"], {
			signal,
			quiet: true,
			reportProgress,
			message: "Read checkpoint history",
		});
		if (text(head) === "") return [];
		const output = await checkpoint(root, brainDir, ["log", "--format=%H%x09%cI%x09%s"], {
			signal,
			reportProgress,
			message: "Read checkpoint history",
		});
		return output.split("\n").filter((line) => line !== "").map((line) => {
			const [id, time, ...subject] = line.split("\t");
			return { id, time, label: subject.join("\t") };
		});
	};
	const changesBetween = async (root, brainDir, from, to, { signal, reportProgress, indexFile } = {}) => {
		const range = to === undefined ? ["--cached", from] : [from, to];
		const status = new Map();
		const names = await checkpoint(root, brainDir, ["diff", "--name-status", "--no-renames", "-z", ...range], {
			signal,
			reportProgress,
			indexFile,
			message: "Read changed checkpoint paths",
		});
		const records = names.split("\0");
		for (let index = 0; index + 1 < records.length; index += 2) {
			const [kind, path] = [records[index], records[index + 1]];
			if (path !== "") status.set(path, { A: "new", D: "deleted" }[kind] ?? "changed");
		}
		const numstat = await checkpoint(root, brainDir, ["diff", "--numstat", "--no-renames", "-z", ...range], {
			signal,
			reportProgress,
			indexFile,
			message: "Read changed checkpoint sizes",
		});
		const changes = [];
		for (const entry of numstat.split("\0")) {
			if (entry === "") continue;
			const [added, removed, ...rest] = entry.split("\t");
			const path = rest.join("\t");
			const change = { path, status: status.get(path) ?? "changed" };
			if (added !== "-") Object.assign(change, { added: Number(added), removed: Number(removed) });
			changes.push(change);
		}
		return changes;
	};
	const patchBetween = (root, brainDir, range, { signal, reportProgress, indexFile } = {}) => checkpoint(root, brainDir, ["diff", "--no-renames", "--no-color", ...range], {
		signal,
		reportProgress,
		indexFile,
		message: "Read checkpoint patch",
	});
	/** A cancelled or failed inspection can leave only a disposable index, never a changed checkpoints.git index. */
	const withStagedProject = async (root, brainDir, base, { signal, reportProgress } = {}, read) => {
		throwIfAborted(signal);
		const directory = await io.mkdtemp(join(temporaryDir, "cartographer-review-"));
		const indexFile = join(directory, "index");
		try {
			await checkpoint(root, brainDir, ["read-tree", base], {
				signal,
				reportProgress,
				indexFile,
				message: "Prepare checkpoint comparison",
			});
			// This reads the current work tree into the temporary index. If cancelled after this effect, there is no
			// durable index to undo; cleanup stops waiting and removes the private comparison state.
			await checkpoint(root, brainDir, ["add", "-A", "."], {
				signal,
				reportProgress,
				indexFile,
				message: "Stage current project for comparison",
			});
			throwIfAborted(signal);
			return await read(indexFile);
		} finally {
			try { await io.rm(directory, { recursive: true, force: true }); } catch { /* an already-cancelled read keeps its primary result */ }
		}
	};
	const lastChange = async (root, brainDir, { signal, reportProgress } = {}) => {
		const task = newestTask(await history(root, brainDir, { signal, reportProgress }));
		if (task === undefined) return undefined;
		if (task.after !== undefined) {
			const [changes, patch] = await Promise.all([
				changesBetween(root, brainDir, task.before.id, task.after.id, { signal, reportProgress }),
				patchBetween(root, brainDir, [task.before.id, task.after.id], { signal, reportProgress }),
			]);
			throwIfAborted(signal);
			return { ...parseBefore(task.before.label), time: task.before.time, finished: true, changes, patch };
		}
		return withStagedProject(root, brainDir, task.before.id, { signal, reportProgress }, async (indexFile) => {
			const [changes, patch] = await Promise.all([
				changesBetween(root, brainDir, task.before.id, undefined, { signal, reportProgress, indexFile }),
				patchBetween(root, brainDir, ["--cached", task.before.id], { signal, reportProgress, indexFile }),
			]);
			throwIfAborted(signal);
			return { ...parseBefore(task.before.label), time: task.before.time, finished: false, changes, patch };
		});
	};
	const changeSince = async (root, brainDir, since, { signal, reportProgress } = {}) => {
		const steps = (await history(root, brainDir, { signal, reportProgress }))
			.filter((entry) => entry.label.startsWith("before ") && entry.label !== "before undo" && Date.parse(entry.time) >= since - POLICY.limits.git.undoTimestampToleranceMs);
		const first = steps.at(-1);
		if (first === undefined) return undefined;
		return withStagedProject(root, brainDir, first.id, { signal, reportProgress }, async (indexFile) => {
			const [changes, patch] = await Promise.all([
				changesBetween(root, brainDir, first.id, undefined, { signal, reportProgress, indexFile }),
				patchBetween(root, brainDir, ["--cached", first.id], { signal, reportProgress, indexFile }),
			]);
			throwIfAborted(signal);
			return { steps: steps.length, changes, patch };
		});
	};
	const uncommitted = async (root, { signal, reportProgress } = {}) => {
		const inside = await project(root, ["rev-parse", "--is-inside-work-tree"], {
			signal,
			quiet: true,
			missingOk: true,
			reportProgress,
			message: "Check project Git repository",
		});
		if (text(inside) !== "true") return undefined;
		const status = await project(root, ["status", "--short", "--untracked-files=all"], {
			signal,
			quiet: true,
			missingOk: true,
			reportProgress,
			message: "Read project Git status",
		}) ?? "";
		let patch = await project(root, ["diff", "--no-color", "HEAD"], {
			signal,
			quiet: true,
			missingOk: true,
			reportProgress,
			message: "Read project Git patch",
		});
		if (patch === undefined) patch = await project(root, ["diff", "--no-color"], {
			signal,
			quiet: true,
			missingOk: true,
			reportProgress,
			message: "Read project Git patch",
		});
		throwIfAborted(signal);
		return { status, patch: patch ?? "" };
	};
	/** Git provides the exact existing Screen tree contract when a project repository is available; otherwise caller falls back to async directory traversal. */
	const projectFiles = async (root, { signal, reportProgress } = {}) => {
		const inside = await project(root, ["rev-parse", "--is-inside-work-tree"], {
			signal,
			quiet: true,
			missingOk: true,
			reportProgress,
			message: "Check project Git repository",
		});
		if (text(inside) !== "true") return undefined;
		const listed = await project(root, ["ls-files", "-co", "--exclude-standard", "-z"], {
			signal,
			quiet: true,
			missingOk: true,
			reportProgress,
			message: "List project Git files",
		});
		if (listed === undefined) return undefined;
		throwIfAborted(signal);
		return listed.split("\0").filter((path) => path !== "");
	};
	return Object.freeze({ lastChange, changeSince, uncommitted, projectFiles });
}
