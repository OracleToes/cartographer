// A normal writable-command stage: a disposable source copy outside the project.
//
// It is deliberately narrower than a project checkout and never a general-purpose scratch workspace.
// A command can alter only `work`; this module turns that work tree into a bounded candidate
// and, only after the ordinary move gate has accepted it, applies the candidate atomically.
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { POLICY } from "./config.mjs";
import { confineWrite } from "./tools/change.mjs";

const FORMAT = 1;
const METADATA = "stage.json";
const STAGE_PREFIX = "cartographer-stage-";
const EXCLUDED = new Set([".git", ".brain", "node_modules"]);

export class StageError extends Error {}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const pathInside = (root, path) => path === root || path.startsWith(root + sep);

const modeOf = (stats) => stats.mode & 0o777;
const lineCount = (text) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
const binary = (buffer) => buffer.subarray(0, POLICY.limits.change.binaryProbeChars).includes(0);

function stageParent() {
	const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	const parent = join(tmpdir(), `cartographer-${uid}`);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	try { chmodSync(parent, 0o700); } catch { /* A restrictive umask already did enough on platforms without chmod. */ }
	let stats;
	try { stats = lstatSync(parent); } catch { throw new StageError("The private command-stage parent cannot be read."); }
	if (!stats.isDirectory() || stats.isSymbolicLink()) throw new StageError("The private command-stage parent is not a real directory.");
	return realpathSync(parent);
}

function allowedRoot(path) {
	if (typeof path !== "string" || path === "") return false;
	const parent = stageParent();
	const absolute = resolve(path);
	const rel = relative(parent, absolute);
	return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`${sep}..${sep}`) && basename(absolute).startsWith(STAGE_PREFIX);
}

function stageId(root) {
	return `${process.pid}-${basename(root).slice(STAGE_PREFIX.length)}-${randomUUID().slice(0, 8)}`;
}

function cleanRelative(path) {
	if (typeof path !== "string" || path === "" || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new StageError("A staged manifest contains an invalid path.");
	return path;
}

function bounded(total, label, limit) {
	if (total > limit) throw new StageError(`${label} exceeds its fixed ${limit.toLocaleString("en-US")} byte stage limit.`);
}

function manifestDigest(entries) {
	return sha256(JSON.stringify(entries.map(({ path, digest, bytes, mode }) => ({ path, digest, bytes, mode }))));
}

/** Walk a source tree without ever following a symlink. `source` skips durable and dependency trees; `candidate` refuses them. */
function scanTree(root, { source = false, storageLimit = POLICY.limits.stage.storageBytes } = {}) {
	const base = realpathSync(root);
	const entries = [];
	let files = 0;
	let bytes = 0;
	const walk = (directory, prefix) => {
		let names;
		try { names = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
		catch (error) { throw new StageError(`The staged tree cannot be read at ${prefix || "."}: ${error.message}`); }
		for (const entry of names) {
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			const absolute = join(directory, entry.name);
			if (EXCLUDED.has(entry.name)) {
				if (source) continue;
				throw new StageError(`The staged candidate contains forbidden ${rel}; .git, .brain, and node_modules cannot be a staged change path.`);
			}
			let stats;
			try { stats = lstatSync(absolute); } catch (error) { throw new StageError(`The staged tree changed while it was read at ${rel}: ${error.message}`); }
			if (stats.isSymbolicLink()) throw new StageError(`${rel} is a symbolic link. A staged source or candidate may contain only real folders and regular files.`);
			if (stats.isDirectory()) {
				walk(absolute, rel);
				continue;
			}
			if (!stats.isFile()) throw new StageError(`${rel} is not a regular file. A staged source or candidate may not contain special files.`);
			if (stats.size > POLICY.limits.stage.fileBytes) throw new StageError(`${rel} exceeds the ${POLICY.limits.stage.fileBytes.toLocaleString("en-US")} byte per-file stage limit.`);
			files += 1;
			if (files > POLICY.limits.stage.sourceFiles) throw new StageError(`The staged tree exceeds its ${POLICY.limits.stage.sourceFiles.toLocaleString("en-US")} file limit.`);
			bytes += stats.size;
			bounded(bytes, "The staged tree", storageLimit);
			const body = readFileSync(absolute);
			if (body.length !== stats.size) throw new StageError(`${rel} changed while it was read.`);
			entries.push({ path: cleanRelative(rel), digest: sha256(body), bytes: body.length, mode: modeOf(stats) });
		}
	};
	walk(base, "");
	return { entries, digest: manifestDigest(entries), files, bytes };
}

function copySource(root, work) {
	const source = scanTree(root, { source: true, storageLimit: POLICY.limits.stage.sourceBytes });
	for (const entry of source.entries) {
		const from = join(root, ...entry.path.split("/"));
		const to = join(work, ...entry.path.split("/"));
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		copyFileSync(from, to);
		try { chmodSync(to, entry.mode); } catch { /* The copied contents and digest remain the authority. */ }
	}
	return source;
}

function writeMetadata(root, value) {
	writeFileSync(join(root, METADATA), `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function readMetadata(record) {
	if (!allowedRoot(record?.root)) throw new StageError("This command-stage root was not created by Cartographer.");
	const root = resolve(record.root);
	const file = join(root, METADATA);
	let value;
	try { value = JSON.parse(readFileSync(file, "utf8")); }
	catch (error) { throw new StageError(`The command-stage receipt cannot be read: ${error.message}`); }
	if (value === null || typeof value !== "object" || value.format !== FORMAT || value.kind !== "normal-command-stage") throw new StageError("The command-stage receipt has an unknown format.");
	if (typeof value.id !== "string" || value.id !== record.id || typeof value.project !== "string" || typeof value.work !== "string") throw new StageError("The command-stage receipt does not match this focus.");
	const work = resolve(root, value.work);
	if (!pathInside(root, work) || work !== join(root, "work")) throw new StageError("The command-stage work path is invalid.");
	if (!Array.isArray(value.source?.entries) || typeof value.source?.digest !== "string" || !Number.isInteger(value.source?.files) || !Number.isInteger(value.source?.bytes)) throw new StageError("The command-stage source manifest is invalid.");
	const paths = new Set();
	const entries = value.source.entries.map((entry) => {
		if (entry === null || typeof entry !== "object") throw new StageError("The command-stage source manifest has an invalid entry.");
		const path = cleanRelative(entry.path);
		if (paths.has(path) || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest) || !Number.isInteger(entry.bytes) || entry.bytes < 0 || !Number.isInteger(entry.mode)) throw new StageError("The command-stage source manifest has an invalid entry.");
		paths.add(path);
		return { path, digest: entry.digest, bytes: entry.bytes, mode: entry.mode };
	});
	if (manifestDigest(entries) !== value.source.digest) throw new StageError("The command-stage source manifest digest is invalid.");
	return {
		id: value.id,
		root,
		work,
		home: join(root, "home"),
		tmp: join(root, "tmp"),
		project: value.project,
		source: { entries, digest: value.source.digest, files: value.source.files, bytes: value.source.bytes },
		createdAt: value.createdAt,
		ownerPid: value.ownerPid,
		mounts: Array.isArray(value.mounts) ? value.mounts : [],
	};
}

/** Create a single private materialized source tree for one sandboxed change focus. */
export function createStage({ root }) {
	let sourceRoot;
	try {
		sourceRoot = realpathSync(root);
		if (!statSync(sourceRoot).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new StageError(`The project cannot be materialized for a command stage: ${error.message}`);
	}
	const parent = stageParent();
	const stageRoot = join(parent, `${STAGE_PREFIX}${process.pid}-${randomUUID()}`);
	mkdirSync(stageRoot, { mode: 0o700 });
	try { chmodSync(stageRoot, 0o700); } catch { /* see stageParent */ }
	try {
		const work = join(stageRoot, "work");
		mkdirSync(work, { mode: 0o700 });
		const source = copySource(sourceRoot, work);
		mkdirSync(join(stageRoot, "home"), { mode: 0o700 });
		mkdirSync(join(stageRoot, "tmp"), { mode: 0o700 });
		const mounts = [];
		const dependencies = join(sourceRoot, "node_modules");
		try {
			if (lstatSync(dependencies).isDirectory() && !lstatSync(dependencies).isSymbolicLink()) {
				// Bubblewrap binds this source read-only over the empty placeholder. It never participates in the candidate.
				mkdirSync(join(work, "node_modules"), { mode: 0o700 });
				mounts.push({ source: dependencies, target: "node_modules" });
			}
		} catch { /* Dependency trees are optional and never become writable stage input. */ }
		const id = stageId(stageRoot);
		const value = {
			format: FORMAT,
			kind: "normal-command-stage",
			id,
			project: sourceRoot,
			work: "work",
			createdAt: Date.now(),
			ownerPid: process.pid,
			source,
			mounts,
		};
		writeMetadata(stageRoot, value);
		return {
			id,
			root: stageRoot,
			work,
			home: join(stageRoot, "home"),
			tmp: join(stageRoot, "tmp"),
			source: { digest: source.digest, files: source.files, bytes: source.bytes },
			mounts,
		};
	} catch (error) {
		try { rmSync(stageRoot, { recursive: true, force: true, maxRetries: 1 }); } catch { /* The original error is more useful. */ }
		throw error instanceof StageError ? error : new StageError(`The command stage could not be created: ${error.message}`);
	}
}

/** Restore a serialised stage record only after its own immutable receipt verifies it. */
export function loadStage(record) {
	const stage = readMetadata(record);
	if (record.source?.digest !== undefined && record.source.digest !== stage.source.digest) throw new StageError("The command-stage source digest no longer matches its task record.");
	return stage;
}

/** Remove read-only dependency mount placeholders after every stage-owned shell is closed. */
function removePlaceholders(stage) {
	for (const mount of stage.mounts) {
		if (mount === null || typeof mount !== "object" || mount.target !== "node_modules") throw new StageError("The command-stage dependency mount receipt is invalid.");
		const target = join(stage.work, mount.target);
		if (!pathInside(stage.work, target)) throw new StageError("The command-stage dependency mount target is invalid.");
		try { rmdirSync(target); }
		catch (error) {
			if (error?.code === "ENOENT") continue;
			throw new StageError(`The read-only dependency placeholder was changed outside the sandbox: ${error.message}`);
		}
	}
}

/** Turn a closed stage work tree into a bounded manifest-backed candidate. */
export function collectStageCandidate(record) {
	const stage = loadStage(record);
	removePlaceholders(stage);
	const candidate = scanTree(stage.work, { storageLimit: POLICY.limits.stage.storageBytes });
	const before = new Map(stage.source.entries.map((entry) => [entry.path, entry]));
	const after = new Map(candidate.entries.map((entry) => [entry.path, entry]));
	const paths = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right));
	const changes = [];
	for (const path of paths) {
		const oldEntry = before.get(path);
		const newEntry = after.get(path);
		if (oldEntry !== undefined && newEntry !== undefined && oldEntry.digest === newEntry.digest && oldEntry.mode === newEntry.mode) continue;
		if (oldEntry !== undefined && newEntry !== undefined && oldEntry.mode !== newEntry.mode) throw new StageError(`${path} changes executable or permission bits. Normal staged command promotion changes file content only.`);
		if (oldEntry === undefined && newEntry !== undefined && (newEntry.mode & 0o111) !== 0) throw new StageError(`${path} is a new executable file. Normal staged command promotion does not create executable files.`);
		changes.push({ path, status: oldEntry === undefined ? "new" : newEntry === undefined ? "deleted" : "changed", ...(oldEntry === undefined ? {} : { before: oldEntry }), ...(newEntry === undefined ? {} : { after: newEntry }) });
	}
	if (changes.length > POLICY.limits.stage.candidateFiles) throw new StageError(`The staged candidate changes ${changes.length} files, above its fixed ${POLICY.limits.stage.candidateFiles}-file collection limit.`);
	return { stage, candidate: { digest: candidate.digest, files: candidate.files, bytes: candidate.bytes }, changes };
}

function measureTextSurface(before, after) {
	let head = 0;
	const common = Math.min(before.length, after.length);
	while (head < common && before.charCodeAt(head) === after.charCodeAt(head)) head += 1;
	let tail = 0;
	while (tail < before.length - head && tail < after.length - head && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail += 1;
	const removed = before.slice(head, before.length - tail);
	const added = after.slice(head, after.length - tail);
	return { bytes: Buffer.byteLength(removed) + Buffer.byteLength(added), lines: lineCount(removed) + lineCount(added), added: { bytes: Buffer.byteLength(added), lines: lineCount(added) }, removed: { bytes: Buffer.byteLength(removed), lines: lineCount(removed) } };
}

function stageFile(stage, path) {
	const file = join(stage.work, ...path.split("/"));
	if (!pathInside(stage.work, file)) throw new StageError("The candidate path is outside its work tree.");
	return file;
}

function currentSource(root) {
	return scanTree(root, { source: true, storageLimit: POLICY.limits.stage.sourceBytes });
}

/** Validate every candidate operation before any live project path is written. */
export function prepareStagePromotion({ root, brainDir, record, targets, fileOpsUsed = 0, fileOpsLimit, changedSurfaceUsed = { bytes: 0, lines: 0 } }) {
	const collected = collectStageCandidate(record);
	const { stage, changes } = collected;
	const current = currentSource(root);
	if (current.digest !== stage.source.digest) throw new StageError("The live project changed after this command stage was materialized. Its candidate was discarded without applying a stale diff.");
	if (!Array.isArray(targets) || targets.length === 0) throw new StageError("The running move has no declared target list for this staged candidate.");
	for (const change of changes) {
		if (!targets.includes(change.path)) throw new StageError(`${change.path} is outside this move's declared targets (${targets.join(", ")}). The staged candidate was not applied.`);
		try { confineWrite(root, brainDir, change.path); }
		catch (error) { throw new StageError(`${change.path} cannot be promoted: ${error.message}`); }
	}
	const remainingOperations = Math.max(0, (Number.isInteger(fileOpsLimit) ? fileOpsLimit : 0) - (Number.isInteger(fileOpsUsed) ? fileOpsUsed : 0));
	if (changes.length > remainingOperations) throw new StageError(`The staged candidate needs ${changes.length} file operations, but this focus has ${remainingOperations} remaining. It was not applied.`);
	const prepared = [];
	let total = { bytes: changedSurfaceUsed.bytes ?? 0, lines: changedSurfaceUsed.lines ?? 0 };
	for (const change of changes) {
		const live = join(root, ...change.path.split("/"));
		const original = existsSync(live) ? readFileSync(live) : undefined;
		if (change.before === undefined ? original !== undefined : original === undefined || sha256(original) !== change.before.digest) throw new StageError(`${change.path} no longer has the bytes the stage inspected. The candidate was not applied.`);
		const candidate = change.after === undefined ? undefined : readFileSync(stageFile(stage, change.path));
		if (candidate !== undefined && (candidate.length !== change.after.bytes || sha256(candidate) !== change.after.digest)) throw new StageError(`${change.path} changed after its candidate manifest was collected.`);
		if (candidate !== undefined && binary(candidate)) throw new StageError(`${change.path} is binary in the staged candidate. Normal staged command promotion only creates or changes text files.`);
		if (change.status === "changed" && original !== undefined && binary(original)) throw new StageError(`${change.path} changes a binary file. Normal staged command promotion only changes text files.`);
		let surface;
		if (change.status === "deleted" && original !== undefined && binary(original)) {
			const lines = original.length === 0 ? 0 : [...original].filter((byte) => byte === 10).length + (original.at(-1) === 10 ? 0 : 1);
			surface = { bytes: original.length, lines, added: { bytes: 0, lines: 0 }, removed: { bytes: original.length, lines } };
		} else surface = measureTextSurface(original?.toString("utf8") ?? "", candidate?.toString("utf8") ?? "");
		total = { bytes: total.bytes + surface.bytes, lines: total.lines + surface.lines };
		prepared.push({ ...change, live, original, candidate, surface });
	}
	if (total.bytes > POLICY.limits.change.surfaceBytes || total.lines > POLICY.limits.change.surfaceLines) {
		throw new StageError(`The staged candidate would use ${total.bytes} bytes and ${total.lines} lines of changed surface; this focus may use at most ${POLICY.limits.change.surfaceBytes} bytes and ${POLICY.limits.change.surfaceLines} lines. It was not applied.`);
	}
	return { collected, prepared, total };
}

function replaceAtomically(path, content, mode) {
	const folder = dirname(path);
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	const temp = join(folder, `.${basename(path)}.cartographer-stage-${process.pid}-${randomUUID()}`);
	try {
		writeFileSync(temp, content, { mode });
		try { chmodSync(temp, mode); } catch { /* Content and the prevalidated target remain primary. */ }
		renameSync(temp, path);
	} catch (error) {
		try { unlinkSync(temp); } catch { /* best effort */ }
		throw error;
	}
}

/** Apply a fully prepared candidate. A failed write restores every earlier path or names the fatal rollback gap. */
export function applyStagePromotion(prepared) {
	const applied = [];
	try {
		for (const operation of prepared.prepared) {
			if (operation.status === "deleted") {
				unlinkSync(operation.live);
			} else {
				const mode = operation.before?.mode ?? 0o644;
				replaceAtomically(operation.live, operation.candidate, mode);
			}
			applied.push(operation);
		}
	} catch (error) {
		const rollback = [];
		for (const operation of applied.reverse()) {
			try {
				if (operation.original === undefined) {
					if (existsSync(operation.live)) unlinkSync(operation.live);
				} else replaceAtomically(operation.live, operation.original, operation.before?.mode ?? 0o644);
			} catch (rollbackError) {
				rollback.push(`${operation.path}: ${rollbackError.message}`);
			}
		}
		if (rollback.length > 0) throw new StageError(`A staged candidate apply failed (${error.message}) and rollback failed for ${rollback.join("; ")}. Stop and tell the user.`);
		throw new StageError(`A staged candidate apply failed (${error.message}); every earlier path was restored and nothing was applied.`);
	}
	return {
		changes: prepared.prepared.map((operation) => ({
			path: operation.path,
			status: operation.status,
			...(binary(operation.original ?? Buffer.alloc(0)) || binary(operation.candidate ?? Buffer.alloc(0)) ? {} : { added: operation.surface.added.lines, removed: operation.surface.removed.lines }),
		})),
		surface: prepared.total,
		files: prepared.prepared.length,
	};
}

/** Remove only a stage root whose generated name remains under Cartographer's private runtime parent. */
export function disposeStage(record) {
	if (!allowedRoot(record?.root)) return { removed: false, error: "The stage root was not a Cartographer-generated private path." };
	try {
		rmSync(resolve(record.root), { recursive: true, force: true, maxRetries: 2 });
		return { removed: true };
	} catch (error) {
		return { removed: false, error: error.message };
	}
}

/** On a new process, discard only dead-process stages for this same project. */
export function cleanupStaleStages({ root }) {
	let project;
	try { project = realpathSync(root); } catch { return []; }
	let names;
	try { names = readdirSync(stageParent()).filter((name) => name.startsWith(STAGE_PREFIX)); } catch { return []; }
	const removed = [];
	for (const name of names) {
		const stageRoot = join(stageParent(), name);
		let metadata;
		try { metadata = JSON.parse(readFileSync(join(stageRoot, METADATA), "utf8")); } catch { continue; }
		if (metadata?.kind !== "normal-command-stage" || metadata.project !== project || !Number.isInteger(metadata.ownerPid) || metadata.ownerPid === process.pid) continue;
		let alive = true;
		try { process.kill(metadata.ownerPid, 0); } catch (error) { alive = error.code === "EPERM"; }
		if (alive) continue;
		const result = disposeStage({ root: stageRoot });
		if (result.removed) removed.push(stageRoot);
	}
	return removed;
}
