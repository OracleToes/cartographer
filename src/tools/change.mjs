// The two tools a change task alters the project with: write and edit.
//
// They work only inside the project directory, and only for a task that runs a
// declared change move revision (the rule is in src/harness.mjs). Every path
// they accept is one a checkpoint holds, so whatever they do can be undone:
//   - not outside the project, also not through a symlinked folder;
//   - not the brain folder `.brain/` and not `.git/`;
//   - not a file that git ignores, and not one inside a nested git repository,
//     because checkpoints leave those out.
import { POLICY } from "../config.mjs";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { isIgnored } from "../checkpoints.mjs";
import { BRAIN } from "../project.mjs";
import { fileReference } from "../catalog.mjs";
import { USER_NAME } from "../user.mjs";
import { loadContext, taskState, updateContext } from "../context.mjs";
import { liveMove, loadPlan, targetAllows } from "../plan.mjs";

const CONTENT_MAX_BYTES = POLICY.limits.change.contentBytes;
const SURFACE_BYTES = POLICY.limits.change.surfaceBytes;
const SURFACE_LINES = POLICY.limits.change.surfaceLines;

export class ChangeError extends Error {}

const lineCount = (text) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
const bufferLineCount = (buffer) => {
	if (buffer.length === 0) return 0;
	let rows = 0;
	for (const byte of buffer) if (byte === 10) rows++;
	return rows + (buffer.at(-1) === 10 ? 0 : 1);
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** The actual changed spans, measured symmetrically before any write lands. A large one-line replacement is bounded
 * by bytes; multi-line changes are bounded by both added and removed lines. */
export function changedSurface(before, after) {
	const oldText = String(before ?? "");
	const newText = String(after ?? "");
	let head = 0;
	const common = Math.min(oldText.length, newText.length);
	while (head < common && oldText.charCodeAt(head) === newText.charCodeAt(head)) head++;
	let tail = 0;
	while (tail < oldText.length - head && tail < newText.length - head && oldText.charCodeAt(oldText.length - 1 - tail) === newText.charCodeAt(newText.length - 1 - tail)) tail++;
	const removed = oldText.slice(head, oldText.length - tail);
	const added = newText.slice(head, newText.length - tail);
	return { bytes: Buffer.byteLength(removed) + Buffer.byteLength(added), lines: lineCount(removed) + lineCount(added), added: { bytes: Buffer.byteLength(added), lines: lineCount(added) }, removed: { bytes: Buffer.byteLength(removed), lines: lineCount(removed) } };
}

/**
 * Turn what the model wrote into a path a change task may write to, or throw.
 * @param {string} root real path of the project
 * @returns {{ abs: string, rel: string }}
 */
export function confineWrite(root, brainDir, given) {
	if (typeof given !== "string" || given.trim() === "") throw new ChangeError("a path is needed");
	const abs = resolve(root, given.trim());
	const inside = (path) => path === root || path.startsWith(root + sep);
	if (!inside(abs)) throw new ChangeError(`${given} is outside the project; only files inside ${root} can be changed`);
	if (abs === root) throw new ChangeError(`${given} is the project folder, not a file`);
	const rel = relative(root, abs);
	const parts = rel.split(sep);
	if (parts[0] === BRAIN) throw new ChangeError(`${given} is in ${BRAIN}/, which is Cartographer's own folder; a task does not change it`);
	if (parts.includes(".git")) throw new ChangeError(`${given} is inside a .git folder; a task does not change git's own files`);
	// The nearest folder that exists decides where the file really lands: a symlinked folder may lead out.
	let existing = abs;
	while (!existsSync(existing)) existing = dirname(existing);
	if (existing === abs && lstatSync(abs).isSymbolicLink()) throw new ChangeError(`${given} is a symlink; change the file it points to instead`);
	if (!inside(realpathSync(existing))) throw new ChangeError(`${given} leads outside the project (a symlinked folder); it cannot be changed`);
	if (existing === abs && statSync(abs).isDirectory()) throw new ChangeError(`${given} is a folder, not a file`);
	if (existing !== abs && !statSync(existing).isDirectory()) throw new ChangeError(`${relative(root, existing)} is a file, so nothing can be created below it`);
	// A folder that is a git repository of its own is recorded by a checkpoint as one entry, without its files.
	for (let dir = dirname(abs); dir !== root; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) {
			throw new ChangeError(`${given} is inside ${relative(root, dir)}, a git repository of its own. Checkpoints do not hold its files, so a change there could not be undone`);
		}
	}
	if (isIgnored(root, brainDir, rel)) throw new ChangeError(`${given} is ignored by git. Checkpoints leave ignored files out, so a change there could not be undone; choose a path that is not ignored`);
	return { abs, rel };
}

/** Return stable text for a direct-file surface comparison, refusing a binary replacement path. */
function textFromBuffer(buffer, path) {
	if (buffer.subarray(0, POLICY.limits.change.binaryProbeChars).includes(0)) throw new ChangeError(`${path} is not a text file`);
	return buffer.toString("utf8");
}

/** Resolve a create (or legacy replacement) without touching disk. */
function prepareWrite(root, brainDir, given, content, options = {}) {
	if (typeof content !== "string") throw new ChangeError("`content` is required: the whole text of the file");
	if (Buffer.byteLength(content) > CONTENT_MAX_BYTES) throw new ChangeError(`\`content\` is larger than ${CONTENT_MAX_BYTES / 1_000_000} MB; split the local outcome into bounded changes`);
	const path = confineWrite(root, brainDir, given);
	const beforeBuffer = existsSync(path.abs) ? readFileSync(path.abs) : undefined;
	if (options.newOnly === true && beforeBuffer !== undefined) throw new ChangeError(`${path.rel} already exists; file create does not replace it whole. Use an exact edit or plan another local outcome`);
	const before = beforeBuffer === undefined ? "" : textFromBuffer(beforeBuffer, path.rel);
	return { kind: beforeBuffer === undefined ? "create" : "replace", path, beforeBuffer, before, after: content };
}

/** Resolve an exact edit without touching disk. */
function prepareEdit(root, brainDir, given, oldText, newText, { expectedVersion } = {}) {
	if (typeof oldText !== "string" || oldText === "") throw new ChangeError("`old_text` is required: the passage to replace, copied exactly from the file");
	if (typeof newText !== "string") throw new ChangeError("`new_text` is required: what replaces the passage (an empty string deletes it)");
	const path = confineWrite(root, brainDir, given);
	if (!existsSync(path.abs)) throw new ChangeError(`${path.rel} does not exist. Use \`write\` to create a file`);
	const beforeBuffer = readFileSync(path.abs);
	if (expectedVersion !== undefined) {
		const actual = digest(beforeBuffer);
		if (actual !== expectedVersion) throw new ChangeError(`${path.rel} changed since version ${expectedVersion}; current version is ${actual}. Nothing was changed`);
	}
	const before = textFromBuffer(beforeBuffer, path.rel);
	const first = before.indexOf(oldText);
	if (first === -1) throw new ChangeError(`\`old_text\` was not found in ${path.rel}. It must match the file exactly, spaces and line breaks included. If indentation is unclear, inspect the exact source with \`sed -n 'A,Bp' ${path.rel} | cat -A\` and retry without guessing`);
	const places = before.split(oldText).length - 1;
	if (places > 1) throw new ChangeError(`\`old_text\` is found ${places} times in ${path.rel}. Add the lines around the passage until it matches one place only`);
	if (oldText === newText) throw new ChangeError("`old_text` and `new_text` are the same, so nothing would change");
	return { kind: "edit", path, beforeBuffer, before, after: before.slice(0, first) + newText + before.slice(first + oldText.length), line: before.slice(0, first).split("\n").length, replaced: lineCount(oldText), replacement: lineCount(newText) };
}

/** Resolve a removal without touching disk. */
function prepareRemove(root, brainDir, given, { expectedVersion } = {}) {
	const path = confineWrite(root, brainDir, given);
	if (!existsSync(path.abs)) throw new ChangeError(`${path.rel} does not exist. Nothing was removed`);
	const beforeBuffer = readFileSync(path.abs);
	if (expectedVersion !== undefined) {
		const actual = digest(beforeBuffer);
		if (actual !== expectedVersion) throw new ChangeError(`${path.rel} changed since version ${expectedVersion}; current version is ${actual}. Nothing was removed`);
	}
	const binary = beforeBuffer.subarray(0, POLICY.limits.change.binaryProbeChars).includes(0);
	return binary
		? { kind: "remove", path, beforeBuffer, before: "", after: "", surface: { bytes: beforeBuffer.length, lines: bufferLineCount(beforeBuffer), added: { bytes: 0, lines: 0 }, removed: { bytes: beforeBuffer.length, lines: bufferLineCount(beforeBuffer) } } }
		: { kind: "remove", path, beforeBuffer, before: beforeBuffer.toString("utf8"), after: "" };
}

/** Refuse a changed surface before disk is touched. This is deliberately separate from file-operation count. */
function surfaceAuthority(task, prepared) {
	const surface = prepared.surface ?? changedSurface(prepared.before, prepared.after);
	const used = task.changedSurface ?? { bytes: 0, lines: 0 };
	const total = { bytes: (used.bytes ?? 0) + surface.bytes, lines: (used.lines ?? 0) + surface.lines };
	if (total.bytes > SURFACE_BYTES || total.lines > SURFACE_LINES) {
		throw new ChangeError(`the proposed ${prepared.kind} changes ${surface.bytes} bytes and ${surface.lines} lines; this focus has ${Math.max(0, SURFACE_BYTES - (used.bytes ?? 0))} bytes and ${Math.max(0, SURFACE_LINES - (used.lines ?? 0))} lines of changed surface remaining. Nothing was changed; return blocked and plan a successor move or a more deliberate bounded construction`);
	}
	if (prepared.kind === "create" && Array.isArray(task.removedPaths) && task.removedPaths.includes(prepared.path.rel)) {
		throw new ChangeError(`${prepared.path.rel} was removed in this focus and cannot be recreated as a rewrite path. Plan a successor move`);
	}
	return { surface, total };
}

/** Ensure a prepared operation is still comparing against the exact bytes it inspected. */
function unchangedSincePrepared(prepared) {
	const exists = existsSync(prepared.path.abs);
	if (prepared.beforeBuffer === undefined) return !exists;
	return exists && digest(readFileSync(prepared.path.abs)) === digest(prepared.beforeBuffer);
}

/** Apply an already-authorized operation and undo it if its stable catalog identity cannot be recorded. */
function commitPrepared(root, brainDir, prepared) {
	if (!unchangedSincePrepared(prepared)) throw new ChangeError(`${prepared.path.rel} changed after this operation was prepared. Nothing was changed; read it again before retrying`);
	if (prepared.kind === "remove") {
		unlinkSync(prepared.path.abs);
		return `Removed ${prepared.path.rel}.`;
	}
	mkdirSync(dirname(prepared.path.abs), { recursive: true });
	try {
		writeFileSync(prepared.path.abs, prepared.after, prepared.beforeBuffer === undefined ? { flag: "wx" } : undefined);
	} catch (error) {
		if (prepared.beforeBuffer === undefined && error.code === "EEXIST") throw new ChangeError(`${prepared.path.rel} was created by another operation; nothing was overwritten`);
		throw error;
	}
	let ref;
	try { ref = fileReference(root, brainDir, prepared.path.rel); }
	catch (error) {
		try {
			if (prepared.beforeBuffer === undefined) unlinkSync(prepared.path.abs);
			else writeFileSync(prepared.path.abs, prepared.beforeBuffer);
		} catch (rollbackError) {
			throw new ChangeError(`The ${prepared.kind} landed but its identity could not be recorded (${error.message}); rollback also failed (${rollbackError.message}). Stop and tell ${USER_NAME}.`);
		}
		throw new ChangeError(`The stable file identity could not be recorded (${error.message}); the file was restored and nothing was changed.`);
	}
	if (prepared.kind === "edit") return `Edited ${prepared.path.rel}: ${plural(prepared.replaced, "line")} from line ${prepared.line} replaced by ${plural(prepared.replacement, "line")}.`;
	return `Wrote ${prepared.path.rel}: ${plural(lineCount(prepared.after), "line")}${prepared.beforeBuffer === undefined ? ", a new file" : `, replacing a file of ${plural(lineCount(prepared.before), "line")}`}. File id: ${ref.id} (to read or change it: { "id": "${ref.id}" }).`;
}

/**
 * Create a file, or replace it only when the low-level caller explicitly opts out of create-only behavior. The
 * focused tool path always measures and authorizes the full before/after surface first.
 */
export function writeOne(root, brainDir, given, content, options = {}) {
	return commitPrepared(root, brainDir, prepareWrite(root, brainDir, given, content, options));
}

/** Delete one regular project file without bypassing the shared preparation rules. */
export function removeOne(root, brainDir, given, options = {}) {
	return commitPrepared(root, brainDir, prepareRemove(root, brainDir, given, options));
}

/** Replace one exact passage of a file without bypassing the shared preparation rules. */
export function editOne(root, brainDir, given, oldText, newText, options = {}) {
	return commitPrepared(root, brainDir, prepareEdit(root, brainDir, given, oldText, newText, options));
}

/**
 * The primitive is also an authority boundary. `book` resolves stable file identities before it calls this,
 * but a tool-to-tool call still cannot turn a broad envelope or a stale focus into a write.
 */
function fileAuthority(brainDir, api, path, gate) {
	const task = loadContext(brainDir).tasks[api?.conversationId];
	if (task?.mode !== POLICY.enums.planMode.change || typeof task.move !== "string" || !Number.isInteger(task.revision)) {
		throw new ChangeError("this focus is not carrying a live authorized change move");
	}
	const { plan, error } = loadPlan(brainDir);
	if (plan === undefined) throw new ChangeError(`the plan cannot be read (${error})`);
	const live = liveMove(plan, task.move, task.revision, { yolo: gate?.yolo === true });
	if (live.error !== undefined) throw new ChangeError(live.error);
	if (live.move.capabilities?.files !== true) throw new ChangeError(`${live.move.id} does not allow direct file operations`);
	if (!targetAllows(live.move, path)) throw new ChangeError(`${String(path).replace(/^\.\//, "")} is outside ${live.move.id}'s declared targets (${live.move.targets.join(", ")})`);
	const ceiling = live.move.budget?.fileOps ?? POLICY.limits.plan.moveBudget.fileOps;
	if ((task.fileOps ?? 0) >= ceiling) throw new ChangeError(`${live.move.id} already used all ${ceiling} direct file operations; return blocked and plan a successor move`);
	return { task, move: live.move, ceiling };
}

function recordFileUse(brainDir, conversationId, prepared, total) {
	updateContext(brainDir, (store) => {
		const task = taskState(store, conversationId);
		task.fileOps = (task.fileOps ?? 0) + 1;
		task.changedSurface = total;
		if (prepared.kind === "remove") task.removedPaths = [...new Set([...(task.removedPaths ?? []), prepared.path.rel])];
	});
}

const surfaceLine = (total) => `Direct changed surface: ${total.bytes}/${SURFACE_BYTES} bytes and ${total.lines}/${SURFACE_LINES} lines used; ${Math.max(0, SURFACE_BYTES - total.bytes)} bytes and ${Math.max(0, SURFACE_LINES - total.lines)} lines remain.`;

const authorizedRun = (root, brainDir, api, path, gate, prepare) => {
	try {
		const authority = fileAuthority(brainDir, api, path, gate);
		const prepared = prepare();
		const measured = surfaceAuthority(authority.task, prepared);
		const text = commitPrepared(root, brainDir, prepared);
		recordFileUse(brainDir, api.conversationId, prepared, measured.total);
		return { output: [{ type: "text", text: `${text}\n${surfaceLine(measured.total)}` }] };
	} catch (error) {
		if (error instanceof ChangeError) return { isError: true, output: [{ type: "text", text: `Refused: ${error.message}.` }] };
		throw error;
	}
};

/** @param {{ root: string, brainDir: string, gate?: { yolo: boolean }, write?: { newOnly?: boolean } }} project  root: real path of the project */
export function changeTools({ root, brainDir, gate, write = {} }) {
	return [
		defineTool({
			name: "write",
			description: "Create one new UTF-8 project file. The proposed whole file is measured before anything lands; an over-limit create is refused atomically, never clipped. Folders are created as needed.",
			parameters: obj({
				path: str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "Path relative to the project directory" }),
				content: str({ maxLength: CONTENT_MAX_BYTES, description: "The whole UTF-8 text of the new file. It must fit the focus's remaining changed-surface allowance." }),
			}),
			callers: ["tools"], // Internal primitive for book; the model uses target=file, action=create.
			executionMode: "sequential",
			// Writing the same text twice leaves the same file.
			replay: POLICY.enums.toolReplay.safe,
			execute: async (args, api) => authorizedRun(root, brainDir, api, args.path, gate, () => prepareWrite(root, brainDir, args.path, args.content, { newOnly: write.newOnly !== false })),
		}),
		defineTool({
			name: "edit",
			description: "Replace one exact passage. Copy the passage exactly as it stands in `read` output, whitespace included. If an exact match fails, inspect bytes with `sed -n 'A,Bp' path | cat -A`; do not guess.",
			parameters: obj({
				path: str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "Path relative to the project directory" }),
				old_text: str({ minLength: POLICY.validation.nonEmptyStringMinLength, description: "The passage to replace, exactly as it is in the file" }),
				new_text: str({ description: "What replaces it. An empty string deletes the passage." }),
				expectedVersion: opt(str({ description: "Optional SHA-256 content precondition used by book file edits." })),
			}),
			callers: ["tools"], // Internal primitive for book; the model uses target=file, action=edit.
			executionMode: "sequential",
			// Not run a second time after a crash: the passage may already be replaced, and the task reads the file again.
			replay: POLICY.enums.toolReplay.unsafe,
				execute: async (args, api) => authorizedRun(root, brainDir, api, args.path, gate, () => prepareEdit(root, brainDir, args.path, args.old_text, args.new_text, { expectedVersion: args.expectedVersion })),
		}),
		defineTool({
			name: "rm",
			description: "Delete one project file. Folders are not removed. A checkpoint records the deletion, so /undo brings the file back.",
			parameters: obj({
				path: str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "Path relative to the project directory" }),
				expectedVersion: opt(str({ description: "Optional SHA-256 content precondition used by book file removes." })),
			}),
			callers: ["tools"], // Internal primitive for book; the model uses target=file, action=remove.
			executionMode: "sequential",
			// Not run a second time after a crash: the file may already be gone, and the task reads the folder again.
			replay: POLICY.enums.toolReplay.unsafe,
				execute: async (args, api) => authorizedRun(root, brainDir, api, args.path, gate, () => prepareRemove(root, brainDir, args.path, { expectedVersion: args.expectedVersion })),
		}),
	];
}
