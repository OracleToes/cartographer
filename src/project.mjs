// Which folder is the project, and its brain folder `.atlas/`.
//
// The brain is the only thing Cartographer keeps per project. The program itself
// lives once in the core folder; a project holds no copy of it.
//
// The folder name `.atlas/` is shared with the Orchestrator pi extension, which keeps
// its own files there (graph.json, ledger.json, working-direction.json). Cartographer
// leaves those alone, and a folder that holds only those is not a Cartographer brain.
import { POLICY } from "./config.mjs";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const BRAIN = POLICY.sentinels.brainDir;
/** The file that makes an `.atlas/` folder a Cartographer brain. */
const SESSION = "session.sqlite";

export class ProjectError extends Error {}

/** Whether `dir` has a brain that Cartographer set up. */
export const hasBrain = (dir) => existsSync(join(dir, BRAIN, SESSION));

/** The home folder and the root of the disk are never a project unless the user says so with --here. */
function isCatchAll(dir) {
	return dir === "/" || dir === realpathSync(homedir());
}

/**
 * The project a directory belongs to. Going up from the directory, the first folder that has a Cartographer brain
 * or is the top of a git repository is the project. The search stops below the home folder and the root of the
 * disk: a brain or a repository there (dotfiles, an earlier mistake) must not swallow every folder under it.
 * When nothing is found, the directory itself is the project.
 * @returns {{ root: string, why: "brain" | "git" | "here" }}
 */
export function findProject(cwd) {
	const start = realpathSync(resolve(cwd));
	for (let dir = start; !isCatchAll(dir); dir = dirname(dir)) {
		if (hasBrain(dir)) return { root: dir, why: "brain" };
		if (existsSync(join(dir, ".git"))) return { root: dir, why: "git" };
		if (dirname(dir) === dir) break;
	}
	return { root: start, why: "here" };
}

/** Refuse the home folder and the root of the disk as a project, unless allowed. */
export function checkProject(root, options = {}) {
	if (isCatchAll(root) && !options.allowHome) {
		throw new ProjectError(
			`${root} is not a project folder. Run carto from inside a project, or pass --here to use this folder anyway.`,
		);
	}
}

/**
 * Create what is missing of the brain folder. An `.atlas/` folder that is already there, from the Orchestrator
 * extension, is completed, and its files are left as they are.
 * @returns {{ brainDir: string, created: boolean }}  created: this project had no Cartographer brain before
 */
export function setUpBrain(root) {
	const brainDir = join(root, BRAIN);
	const created = !hasBrain(root);
	mkdirSync(join(brainDir, "plugins"), { recursive: true });
	// The session database changes constantly and belongs to this machine. The rest is yours to commit or not.
	const ignore = join(brainDir, ".gitignore");
	// So do what the context engine keeps (src/context.mjs) and the wakes the agent set: the state of one session.
	const wanted = ["session.sqlite*", "carto.lock", "checkpoints.git/", "home/", "carto-context.json", "reports/", "carto-wakes.json", "export/"];
	const have = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
	const lines = have.split("\n").map((line) => line.trim());
	// A file that ignores everything (the Orchestrator extension writes one) already covers these.
	const missing = lines.includes("*") ? [] : wanted.filter((line) => !lines.includes(line));
	if (missing.length > 0) writeFileSync(ignore, `${have}${have === "" || have.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
	return { brainDir, created };
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

/**
 * One process writes a brain at a time. Returns a function that releases the lock.
 * A lock left by a process that no longer exists is taken over.
 */
export function lockBrain(brainDir) {
	const path = join(brainDir, "carto.lock");
	if (existsSync(path)) {
		const pid = Number(readFileSync(path, "utf8").trim());
		if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) {
			throw new ProjectError(`Cartographer is already running in this project (process ${pid}). One runs at a time per project.`);
		}
	}
	writeFileSync(path, `${process.pid}\n`);
	return () => {
		try {
			if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path, { force: true });
		} catch {
			// Already gone.
		}
	};
}
