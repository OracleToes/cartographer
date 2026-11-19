// Promise-based filesystem seams for interactive presentation code. These ports check AbortSignal between bounded
// directory and file operations; they are the only filesystem work a migrated Screen query may await.
import { access, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";
import { POLICY } from "../config.mjs";
import { BRAIN } from "../project.mjs";

const text = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const aborted = (error) => error?.name === "AbortError" || error?.code === "ABORT_ERR";
const report = (callback, progress) => {
	try { callback?.(progress); } catch { /* A presentation listener never owns a filesystem operation. */ }
};

/** The stable cancellation shape shared by async filesystem ports and application query adapters. */
export class FilesystemAbortError extends Error {
	constructor(message = "Filesystem work was cancelled.") {
		super(message);
		this.name = "FilesystemAbortError";
		this.code = "ABORT_ERR";
	}
}

export const isFilesystemAbort = (error) => error instanceof FilesystemAbortError || aborted(error);
export const throwIfFilesystemAborted = (signal) => {
	if (signal?.aborted === true) throw new FilesystemAbortError();
};

const readOptions = (signal) => signal === undefined ? "utf8" : { encoding: "utf8", signal };
const inside = (root, path) => path === root || path.startsWith(`${root}${sep}`);
const SKIP_DIRS = new Set([...POLICY.enums.lookSkipDirs, BRAIN]);

/** Write an editor scratch file under the brain without blocking keyboard/render handling. */
export async function writeScratch(brainDir, name, text, { signal } = {}) {
	throwIfFilesystemAborted(signal);
	const dir = join(brainDir, "scratch");
	await mkdir(dir, { recursive: true });
	throwIfFilesystemAborted(signal);
	const file = join(dir, name);
	try {
		await writeFile(file, `${text}\n`, signal === undefined ? undefined : { signal });
	} catch (error) {
		if (isFilesystemAbort(error)) throw new FilesystemAbortError();
		throw error;
	}
	// Do not check the signal after writeFile: the scratch bytes are already durable, so a late cancellation must not
	// imply that the file did not appear.
	return file;
}

/** Read text selected by an external editor without blocking keyboard/render handling. */
export async function readText(file, { signal } = {}) {
	throwIfFilesystemAborted(signal);
	try {
		const result = await readFile(file, readOptions(signal));
		throwIfFilesystemAborted(signal);
		return result;
	} catch (error) {
		if (isFilesystemAbort(error)) throw new FilesystemAbortError();
		throw error;
	}
}

/** Whether a target still exists. Failed access is an ordinary false rather than a render-time exception. */
export async function pathExists(path, { signal } = {}) {
	throwIfFilesystemAborted(signal);
	try {
		await access(path);
		throwIfFilesystemAborted(signal);
		return true;
	} catch (error) {
		if (isFilesystemAbort(error) || signal?.aborted === true) throw new FilesystemAbortError();
		return false;
	}
}

/** Find the first matching text position in sorted source files without scanning them from a key handler. */
export async function findTextSource(dir, needle, { suffix, signal, reportProgress } = {}) {
	throwIfFilesystemAborted(signal);
	try {
		const entries = (await readdir(dir)).sort();
		for (const [index, entry] of entries.entries()) {
			throwIfFilesystemAborted(signal);
			if (suffix !== undefined && !entry.endsWith(suffix)) continue;
			const file = join(dir, entry);
			let source;
			try {
				source = await readText(file, { signal });
			} catch (error) {
				if (isFilesystemAbort(error)) throw error;
				continue;
			}
			report(reportProgress, { current: index + 1, total: entries.length, message: "Searching source files." });
			const at = source.indexOf(needle);
			if (at >= 0) return { file, line: source.slice(0, at).split("\n").length };
		}
	} catch (error) {
		if (isFilesystemAbort(error) || signal?.aborted === true) throw new FilesystemAbortError();
		// The source folder is not present or readable.
	}
	return undefined;
}

/** Find the first executable named in `names` on PATH without probing it synchronously in the screen. */
export async function findExecutable(names, { path = process.env.PATH ?? "", signal, reportProgress } = {}) {
	let checked = 0;
	const directories = path.split(delimiter).filter((dir) => dir !== "");
	for (const name of names) {
		if (typeof name !== "string" || name.trim() === "") continue;
		for (const dir of directories) {
			throwIfFilesystemAborted(signal);
			const candidate = join(dir, name);
			try {
				await access(candidate, constants.X_OK);
				throwIfFilesystemAborted(signal);
				return candidate;
			} catch (error) {
				if (isFilesystemAbort(error) || signal?.aborted === true) throw new FilesystemAbortError();
				// Not here.
			}
			checked++;
			report(reportProgress, { current: checked, total: directories.length * names.length, message: "Looking for an executable." });
		}
	}
	return undefined;
}

/**
 * List regular project files through asynchronous directory batches. It deliberately skips .git, .brain, and
 * dependency folders, never follows a directory symlink, and rejects a file symlink that resolves outside `root`.
 * The fallback mirrors the safe non-Git walk used by agent tools; an async Git listing can refine ignored paths
 * without returning to a synchronous Screen/query read.
 */
export async function listProjectFiles(root, { signal, reportProgress, maxFiles = POLICY.limits.look.walkFiles, fs = {} } = {}) {
	const project = text(root);
	if (project === undefined) throw new TypeError("A project file listing needs a root directory.");
	if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new TypeError("A project file listing needs a positive maximum.");
	const io = {
		readdir: fs.readdir ?? readdir,
		stat: fs.stat ?? stat,
		realpath: fs.realpath ?? realpath,
	};
	throwIfFilesystemAborted(signal);
	let realRoot;
	try {
		realRoot = await io.realpath(project);
		throwIfFilesystemAborted(signal);
	} catch (error) {
		if (isFilesystemAbort(error) || signal?.aborted === true) throw new FilesystemAbortError();
		// A missing root has the same empty projection semantics as the established synchronous fallback.
		return [];
	}
	const folders = [""];
	const files = [];
	let scanned = 0;
	while (folders.length > 0 && files.length < maxFiles) {
		throwIfFilesystemAborted(signal);
		const folder = folders.shift();
		let entries;
		try {
			entries = await io.readdir(join(project, folder), { withFileTypes: true });
			throwIfFilesystemAborted(signal);
		} catch (error) {
			if (isFilesystemAbort(error) || signal?.aborted === true) throw new FilesystemAbortError();
			continue;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (files.length >= maxFiles) break;
			throwIfFilesystemAborted(signal);
			const relativePath = folder === "" ? entry.name : `${folder}/${entry.name}`;
			const absolute = join(project, relativePath);
			scanned++;
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) folders.push(relativePath);
				report(reportProgress, { current: scanned, message: `Scanning project files · ${files.length} found.` });
				continue;
			}
			let details;
			try {
				if (entry.isSymbolicLink()) {
					const target = await io.realpath(absolute);
					throwIfFilesystemAborted(signal);
					if (!inside(realRoot, target)) continue;
					details = await io.stat(target);
				} else {
					// `Dirent` says this was a file, but stat supplies a current byte count and tolerates a deletion race.
					if (!entry.isFile()) continue;
					details = await io.stat(absolute);
				}
				throwIfFilesystemAborted(signal);
			} catch (error) {
				if (isFilesystemAbort(error) || signal?.aborted === true) throw new FilesystemAbortError();
				continue;
			}
			if (!details.isFile()) continue;
			files.push({ path: relativePath, bytes: details.size });
			report(reportProgress, { current: scanned, message: `Scanning project files · ${files.length} found.` });
		}
	}
	throwIfFilesystemAborted(signal);
	files.sort((left, right) => left.path.localeCompare(right.path));
	report(reportProgress, { current: files.length, total: files.length, message: `Found ${files.length} project files.` });
	return files;
}

/**
 * Add current byte sizes to a Git-provided project path list without returning to a synchronous stat walk. Paths are
 * still confined to `root`, and symlinks may resolve only to regular files inside that root. Git filtering and file
 * metadata therefore stay independently abortable, so a superseded Screen tree never has to finish either batch.
 */
export async function describeProjectFiles(root, paths, { signal, reportProgress, maxFiles = POLICY.limits.look.walkFiles, fs = {} } = {}) {
	const project = text(root);
	if (project === undefined) throw new TypeError("A project file description needs a root directory.");
	if (!Array.isArray(paths)) throw new TypeError("A project file description needs a path array.");
	if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new TypeError("A project file description needs a positive maximum.");
	const io = {
		lstat: fs.lstat ?? lstat,
		stat: fs.stat ?? stat,
		realpath: fs.realpath ?? realpath,
	};
	throwIfFilesystemAborted(signal);
	let realRoot;
	try {
		realRoot = await io.realpath(project);
		throwIfFilesystemAborted(signal);
	} catch (error) {
		if (isFilesystemAbort(error) || signal?.aborted === true) throw new FilesystemAbortError();
		return [];
	}
	const lexicalRoot = resolve(project);
	const wanted = [...new Set(paths.filter((path) => typeof path === "string" && path !== ""))]
		.filter((path) => path !== BRAIN && !path.startsWith(`${BRAIN}/`))
		.filter((path) => {
			const candidate = resolve(project, path);
			return inside(lexicalRoot, candidate);
		})
		.sort((left, right) => left.localeCompare(right))
		.slice(0, maxFiles);
	const files = [];
	for (const [index, relativePath] of wanted.entries()) {
		throwIfFilesystemAborted(signal);
		const absolute = resolve(project, relativePath);
		try {
			const entry = await io.lstat(absolute);
			throwIfFilesystemAborted(signal);
			let details;
			if (entry.isSymbolicLink()) {
				const target = await io.realpath(absolute);
				throwIfFilesystemAborted(signal);
				if (!inside(realRoot, target)) continue;
				details = await io.stat(target);
			} else {
				if (!entry.isFile()) continue;
				details = await io.stat(absolute);
			}
			throwIfFilesystemAborted(signal);
			if (!details.isFile()) continue;
			files.push({ path: relativePath, bytes: details.size });
		} catch (error) {
			if (isFilesystemAbort(error) || signal?.aborted === true) throw new FilesystemAbortError();
			continue;
		} finally {
			report(reportProgress, { current: index + 1, total: wanted.length, message: `Checking project files · ${files.length} found.` });
		}
	}
	throwIfFilesystemAborted(signal);
	report(reportProgress, { current: files.length, total: files.length, message: `Found ${files.length} project files.` });
	return files;
}
