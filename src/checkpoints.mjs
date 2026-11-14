// Checkpoints: a copy of the project's files taken before and after every change
// task, so that what a task did can be shown exactly and taken back.
//
// They are kept in a git repository of Cartographer's own, `.atlas/checkpoints.git`,
// with the project folder as its work tree. It works the same whether or not the
// project is a git repository, and it never touches the project's own `.git`: no
// commit, no ref, no index change there.
//
// The history only grows. An undo is a new checkpoint that holds the older files,
// so every state the project was in at a checkpoint stays recoverable.
//
// Files that git ignores are not in a checkpoint, which is why change tasks are not
// allowed to write to them (src/tools/change.mjs).
import { POLICY } from "./config.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRAIN } from "./project.mjs";

export class CheckpointError extends Error {}

const shadowDir = (brainDir) => join(brainDir, "checkpoints.git");

// Settings that must hold whatever the user's own git configuration says: the bytes of a file are stored and
// restored as they are, nothing is signed, no hook runs.
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

function git(root, brainDir, args, options = {}) {
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
	// Paths named to a command are taken as they are, not as patterns.
	if (options.literal) env.GIT_LITERAL_PATHSPECS = "1";
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) delete env[name];
	try {
		return execFileSync("git", ["--git-dir", shadowDir(brainDir), "--work-tree", root, ...SETTINGS, ...args], {
			cwd: root,
			env,
			encoding: "utf8",
			maxBuffer: POLICY.limits.git.maxBufferBytes,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		if (error.code === "ENOENT") throw new CheckpointError("git is not installed, and checkpoints need it");
		if (options.quiet) return undefined;
		throw new CheckpointError(`git ${args[0]} failed: ${String(error.stderr ?? error.message).trim().slice(0, POLICY.limits.git.errorChars)}`);
	}
}

/** Create the checkpoint repository when it is not there yet. */
function ensure(root, brainDir) {
	const dir = shadowDir(brainDir);
	if (existsSync(join(dir, "HEAD"))) return;
	mkdirSync(dir, { recursive: true });
	git(root, brainDir, ["init", "-q", "--initial-branch=checkpoints"]);
	// The brain is the agent's own state, not the project. Dependency folders are left out as they are for looking.
	mkdirSync(join(dir, "info"), { recursive: true });
	writeFileSync(join(dir, "info", "exclude"), `/${BRAIN}/\nnode_modules/\n`);
	// A project's .gitattributes may tell git to rewrite line endings or run filters. Not here: this file outranks
	// it, so every file is stored and restored byte for byte.
	writeFileSync(join(dir, "info", "attributes"), "* -text -filter -ident -working-tree-encoding\n");
}

const head = (root, brainDir) => git(root, brainDir, ["rev-parse", "-q", "--verify", "HEAD"], { quiet: true })?.trim();

/**
 * Record the project's files as they are now.
 * @param {string} label one line; `before <item>: …` and `undo <hash>` are read back by `undo()`
 * @returns {string} the checkpoint's id
 */
export function checkpoint(root, brainDir, label) {
	ensure(root, brainDir);
	git(root, brainDir, ["add", "-A", "."]);
	git(root, brainDir, ["commit", "-q", "--allow-empty", "--no-verify", "-m", label.replace(/\s+/g, " ").trim()]);
	return head(root, brainDir);
}

/**
 * Record what changed in the project since the last checkpoint as a step of its own, for the shell windows that
 * were running meanwhile with no task around them. It is a step like a change task's: `lastChange` shows it and
 * `undo` takes it back. Without windows nothing is recorded: what changed then is the user's own work.
 * @param {string[]} names  the windows that ran something since the last checkpoint
 * @returns {undefined | { names: string[], changes: ReturnType<typeof changesBetween> }}  undefined when nothing changed
 */
export function windowStep(root, brainDir, names) {
	if (names.length === 0) return undefined;
	// Before the first checkpoint there is nothing to compare with.
	if (!existsSync(join(shadowDir(brainDir), "HEAD"))) return undefined;
	const last = head(root, brainDir);
	if (last === undefined) return undefined;
	git(root, brainDir, ["add", "-A", "."]);
	if (git(root, brainDir, ["diff", "--cached", "--quiet", last], { quiet: true }) !== undefined) return undefined;
	const label = `window:${names.join("+")}`;
	// The step begins where the last checkpoint ended: a checkpoint with that one's files, under this step's name.
	const tree = git(root, brainDir, ["rev-parse", `${last}^{tree}`]).trim();
	const before = git(root, brainDir, ["commit-tree", tree, "-p", last, "-m", `before ${label}: files changed while ${names.length === 1 ? "the window" : "the windows"} ran, outside a task`]).trim();
	git(root, brainDir, ["update-ref", "HEAD", before]);
	git(root, brainDir, ["commit", "-q", "--allow-empty", "--no-verify", "-m", `after ${label}`]);
	return { names, changes: changesBetween(root, brainDir, before, head(root, brainDir)) };
}

/** Whether git ignores this path of the project, so that a checkpoint would not hold it. */
export function isIgnored(root, brainDir, rel) {
	ensure(root, brainDir);
	return git(root, brainDir, ["check-ignore", "-q", "--no-index", "--", rel], { quiet: true }) !== undefined;
}

/**
 * The files that differ between two checkpoints.
 * @returns {{ path: string, status: "new" | "changed" | "deleted", added?: number, removed?: number }[]}
 *   added and removed are line counts; absent for a file that is not text
 */
export function changesBetween(root, brainDir, from, to) {
	const range = to === undefined ? ["--cached", from] : [from, to];
	const status = new Map();
	const names = git(root, brainDir, ["diff", "--name-status", "--no-renames", "-z", ...range]).split("\0");
	for (let i = 0; i + 1 < names.length; i += 2) status.set(names[i + 1], { A: "new", D: "deleted" }[names[i]] ?? "changed");
	const changes = [];
	for (const record of git(root, brainDir, ["diff", "--numstat", "--no-renames", "-z", ...range]).split("\0")) {
		if (record === "") continue;
		const [added, removed, ...rest] = record.split("\t");
		const path = rest.join("\t");
		const change = { path, status: status.get(path) ?? "changed" };
		if (added !== "-") Object.assign(change, { added: Number(added), removed: Number(removed) });
		changes.push(change);
	}
	return changes;
}

/** "roll.py (+34)", "README.md (+3 −1)" */
function counts(change) {
	if (change.added === undefined) return "";
	const parts = [];
	if (change.added > 0) parts.push(`+${change.added}`);
	if (change.removed > 0) parts.push(`−${change.removed}`);
	return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

/** One line per changed file, for the agent and for the screen. */
export function changeLines(changes) {
	return changes.map((change) => `  ${change.status.padEnd(8)} ${change.path}${counts(change)}`);
}

/**
 * The changed files for the agent and the screen, bounded: a command can create thousands of files (a virtual
 * environment, a build folder), and a line for each would fill the agent's context. Past `max` files, a folder
 * with more than the configured threshold of changed files is given as one line.
 */
export function changeRecord(changes, max = POLICY.limits.checkpoints.changeRecordLines) {
	if (changes.length <= max) return changeLines(changes);
	const groups = new Map();
	for (const change of changes) {
		const cut = change.path.indexOf("/");
		const key = cut === -1 ? "" : change.path.slice(0, cut + 1);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(change);
	}
	const lines = [];
	for (const [folder, members] of groups) {
		if (folder === "" || members.length <= POLICY.limits.checkpoints.folderCollapseFiles) lines.push(...changeLines(members));
		else {
			const kinds = ["new", "changed", "deleted"].flatMap((status) => {
				const n = members.filter((change) => change.status === status).length;
				return n > 0 ? [`${n} ${status}`] : [];
			});
			lines.push(`  ${"folder".padEnd(8)} ${folder} ${members.length} files: ${kinds.join(", ")}`);
		}
	}
	if (lines.length <= max) return lines;
	return [...lines.slice(0, max), `  and ${lines.length - max} more lines like these`];
}

/** "2 files (+37 −1)" */
export function changeSummary(changes) {
	const added = changes.reduce((sum, change) => sum + (change.added ?? 0), 0);
	const removed = changes.reduce((sum, change) => sum + (change.removed ?? 0), 0);
	return `${changes.length} ${changes.length === 1 ? "file" : "files"}${counts({ added, removed })}`;
}

/** Every checkpoint, newest first. */
function history(root, brainDir) {
	if (!existsSync(join(shadowDir(brainDir), "HEAD")) || head(root, brainDir) === undefined) return [];
	return git(root, brainDir, ["log", "--format=%H%x09%cI%x09%s"])
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const [id, time, ...subject] = line.split("\t");
			return { id, time, label: subject.join("\t") };
		});
}

/**
 * The newest change task that is still in effect: the checkpoint taken before it, and the one after it when the
 * task ran to its end. An earlier undo is skipped together with everything it took back, as in an editor.
 */
function newestTask(log) {
	for (let i = 0; i < log.length; i++) {
		const { label } = log[i];
		if (label.startsWith("undo ")) {
			const undone = log.findIndex((entry) => entry.id === label.slice(5).trim());
			if (undone === -1) return undefined;
			i = undone; // the loop steps past it
		} else if (label.startsWith("before ") && label !== "before undo") {
			const next = log[i - 1];
			return { before: log[i], after: next?.label.startsWith("after ") ? next : undefined };
		}
	}
	return undefined;
}

/** `before p2: write the roller` → { item: "p2", text: "write the roller" } */
function parseBefore(label) {
	const [, item, text] = /^before (\S+?): (.*)$/.exec(label) ?? [];
	// A step of shell windows that ran with no task around (`windowStep`) belongs to no plan item.
	if (item?.startsWith("window:")) return { windows: item.slice(7).split("+"), text: text ?? label };
	return { item, text: text ?? label };
}

/**
 * What the newest change task that is still in effect changed. For a task that was cut off there is no checkpoint
 * after it, so the comparison is with the files as they are now.
 * @returns {undefined | { item?: string, text: string, time: string, finished: boolean, changes: ReturnType<typeof changesBetween>, patch: string }}
 */
export function lastChange(root, brainDir) {
	const task = newestTask(history(root, brainDir));
	if (task === undefined) return undefined;
	if (task.after === undefined) git(root, brainDir, ["add", "-A", "."]);
	const range = task.after === undefined ? ["--cached", task.before.id] : [task.before.id, task.after.id];
	return {
		...parseBefore(task.before.label),
		time: task.before.time,
		finished: task.after !== undefined,
		changes: changesBetween(root, brainDir, task.before.id, task.after?.id),
		patch: git(root, brainDir, ["diff", "--no-renames", "--no-color", ...range]),
	};
}

/**
 * Take back the newest change task that is still in effect: every file it changed becomes what it was before the
 * task, and files it created are removed. Files the task did not touch stay as they are. For a task that was cut
 * off, which files it touched is not known, so the whole project goes back to the checkpoint before it.
 * The files as they are now are recorded first, so an undo loses nothing.
 * @returns {undefined | { item?: string, text: string, time: string, changes: ReturnType<typeof changesBetween> }}
 *   undefined when there is nothing to undo; changes: what the undo did to the files
 */
export function undo(root, brainDir) {
	const task = newestTask(history(root, brainDir));
	if (task === undefined) return undefined;
	const now = checkpoint(root, brainDir, "before undo");
	if (task.after === undefined) {
		// Index and files become the older checkpoint's; files it did not have are removed. Ignored files are not touched.
		git(root, brainDir, ["read-tree", "--reset", "-u", task.before.id]);
	} else {
		const paths = changesBetween(root, brainDir, task.before.id, task.after.id).map((change) => change.path);
		const had = new Set(git(root, brainDir, ["ls-tree", "-r", "--name-only", "-z", task.before.id]).split("\0"));
		const back = paths.filter((path) => had.has(path));
		for (let i = 0; i < back.length; i += POLICY.limits.git.checkoutBatchItems) git(root, brainDir, ["checkout", "-q", task.before.id, "--", ...back.slice(i, i + POLICY.limits.git.checkoutBatchItems)], { literal: true });
		// A file the task created is removed, and so is a folder that this leaves empty.
		for (const path of paths.filter((path) => !had.has(path))) {
			rmSync(join(root, path), { force: true });
			for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) {
				try {
					rmdirSync(join(root, dir));
				} catch {
					break; // not empty, or already gone
				}
			}
		}
	}
	git(root, brainDir, ["add", "-A", "."]);
	git(root, brainDir, ["commit", "-q", "--allow-empty", "--no-verify", "-m", `undo ${task.before.id}`]);
	return { ...parseBefore(task.before.label), time: task.before.time, changes: changesBetween(root, brainDir, now, head(root, brainDir)) };
}

/**
 * Everything the agent's steps have changed since a moment (the start of this run of carto): the files as they
 * were before the first step after it, compared with the files as they are now.
 * @param {number} since  milliseconds
 * @returns {undefined | { steps: number, changes: ReturnType<typeof changesBetween>, patch: string }}  undefined when no step was taken since
 */
export function changeSince(root, brainDir, since) {
	const steps = history(root, brainDir).filter((entry) => entry.label.startsWith("before ") && entry.label !== "before undo" && Date.parse(entry.time) >= since - POLICY.limits.git.undoTimestampToleranceMs);
	const first = steps.at(-1);
	if (first === undefined) return undefined;
	git(root, brainDir, ["add", "-A", "."]);
	return {
		steps: steps.length,
		changes: changesBetween(root, brainDir, first.id),
		patch: git(root, brainDir, ["diff", "--no-renames", "--no-color", "--cached", first.id]),
	};
}

/**
 * What the project's own repository says is uncommitted: `git status` and `git diff HEAD`, asked of the project
 * and not of the checkpoints. Files git does not know yet are listed and not shown.
 * @returns {undefined | { status: string, patch: string }}  undefined when the project is no git repository
 */
export function uncommitted(root) {
	const run = (args) => {
		try {
			return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: POLICY.limits.git.checkpointBufferBytes, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
		} catch {
			return undefined;
		}
	};
	if (run(["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") return undefined;
	const status = run(["status", "--short", "--untracked-files=all"]) ?? "";
	const patch = run(["diff", "--no-color", "HEAD"]) ?? run(["diff", "--no-color"]) ?? "";
	return { status, patch };
}
