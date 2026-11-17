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
/** Rough character budget for a new file: the line cap is the main limit; this one stops a runaway. */
const WRITE_CHARS_PER_LINE = 250;
const writeBudget = (maxLines) => maxLines * WRITE_CHARS_PER_LINE;

export class ChangeError extends Error {}

const lineCount = (text) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Clip `content` to what the tool keeps of a new file: at most `maxLines` lines and at most
 * `maxLines * WRITE_CHARS_PER_LINE` characters, whichever binds first; whole lines, unless one line
 * is longer than the whole budget, in which case it is cut at the budget.
 * @returns {{ text: string, clipped: boolean }}
 */
export function clipWriteContent(content, maxLines) {
	const budget = writeBudget(maxLines);
	if (content.length <= budget && lineCount(content) <= maxLines) return { text: content, clipped: false };
	const lines = content.split("\n");
	const kept = [];
	let chars = 0;
	for (const line of lines) {
		if (kept.length >= maxLines) break;
		const add = kept.length === 0 ? line.length : line.length + 1;
		if (chars + add > budget) break;
		kept.push(line);
		chars += add;
	}
	if (kept.length === 0) return { text: lines[0].slice(0, budget), clipped: true };
	return { text: kept.join("\n"), clipped: true };
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

/**
 * Create a file. With `options` the mechanical limit for building from the ground up is enforced:
 * `newOnly` refuses to replace an existing file (use `edit`), and `maxLines` caps how long a brand-new
 * file may be. Called without options it keeps the old create-or-replace behaviour, for callers that
 * predate the limit (and for tests of the primitive itself).
 * @param {{ newOnly?: boolean, maxLines?: number }} [options]
 * @returns {string} what happened, one line
 */
export function writeOne(root, brainDir, given, content, options = {}) {
	if (typeof content !== "string") throw new ChangeError("`content` is required: the whole text of the file");
	let written = content;
	let atCap = false;
	if (options.maxLines !== undefined) {
		const clipped = clipWriteContent(content, options.maxLines);
		written = clipped.text;
		atCap = clipped.clipped
			|| lineCount(clipped.text) >= options.maxLines
			|| clipped.text.length >= writeBudget(options.maxLines);
	}
	if (Buffer.byteLength(written) > CONTENT_MAX_BYTES) throw new ChangeError(`\`content\` is larger than ${CONTENT_MAX_BYTES / 1_000_000} MB; write the file in parts, or generate it another way`);
	const path = confineWrite(root, brainDir, given);
	const lines = lineCount(written);
	const priorBytes = existsSync(path.abs) ? readFileSync(path.abs) : undefined;
	const had = priorBytes === undefined ? undefined : lineCount(priorBytes.toString("utf8"));
	if (options.newOnly === true && had !== undefined) {
		throw new ChangeError(`${path.rel} already exists, so \`write\` will not replace it whole. Change it with \`edit\`, one exact passage at a time (or give a new path)`);
	}
	mkdirSync(dirname(path.abs), { recursive: true });
	try {
		writeFileSync(path.abs, written, options.newOnly === true ? { flag: "wx" } : undefined);
	} catch (error) {
		if (options.newOnly === true && error.code === "EEXIST") throw new ChangeError(`${path.rel} was created by another operation; nothing was overwritten`);
		throw error;
	}
	let ref;
	try { ref = fileReference(root, brainDir, path.rel); }
	catch (error) {
		try {
			if (had === undefined) unlinkSync(path.abs);
			else writeFileSync(path.abs, priorBytes);
		} catch (rollbackError) {
			throw new ChangeError(`The write landed but its identity could not be recorded (${error.message}); rollback also failed (${rollbackError.message}). Stop and tell ${USER_NAME}.`);
		}
		throw new ChangeError(`The stable file identity could not be recorded (${error.message}); the file was restored and nothing was changed.`);
	}
	const cap = atCap ? ` — the most a new file created with write keeps (or ${writeBudget(options.maxLines)} characters); if you wrote more, the rest is not in the file, and the way to finish it is \`edit\`, anchored on the end of the file` : "";
	return `Wrote ${path.rel}: ${plural(lines, "line")}${had === undefined ? ", a new file" : `, replacing a file of ${plural(had, "line")}`}${cap}. File id: ${ref.id} (to read or change it: { "id": "${ref.id}" }).`;
}

/**
 * Delete a file. The path goes through the same door as write and edit: inside the project, not the brain, not
 * git's own files, not ignored, not through a symlink, not a folder. A checkpoint records the deletion, so
 * `/undo` brings the file back. @returns {string} what happened, one line
 */
export function removeOne(root, brainDir, given, { expectedVersion } = {}) {
	const path = confineWrite(root, brainDir, given);
	if (!existsSync(path.abs)) throw new ChangeError(`${path.rel} does not exist. Nothing was removed`);
	if (expectedVersion !== undefined) {
		const actual = createHash("sha256").update(readFileSync(path.abs)).digest("hex");
		if (actual !== expectedVersion) throw new ChangeError(`${path.rel} changed since version ${expectedVersion}; current version is ${actual}. Nothing was removed`);
	}
	unlinkSync(path.abs);
	return `Removed ${path.rel}.`;
}

/** Replace one passage of a file. @returns {string} what happened, one line */
export function editOne(root, brainDir, given, oldText, newText, { expectedVersion } = {}) {
	if (typeof oldText !== "string" || oldText === "") throw new ChangeError("`old_text` is required: the passage to replace, copied exactly from the file");
	if (typeof newText !== "string") throw new ChangeError("`new_text` is required: what replaces the passage (an empty string deletes it)");
	const path = confineWrite(root, brainDir, given);
	if (!existsSync(path.abs)) throw new ChangeError(`${path.rel} does not exist. Use \`write\` to create a file`);
	const buffer = readFileSync(path.abs);
	if (expectedVersion !== undefined) {
		const actual = createHash("sha256").update(buffer).digest("hex");
		if (actual !== expectedVersion) throw new ChangeError(`${path.rel} changed since version ${expectedVersion}; current version is ${actual}. Nothing was changed`);
	}
	if (buffer.subarray(0, POLICY.limits.change.binaryProbeChars).includes(0)) throw new ChangeError(`${path.rel} is not a text file`);
	const text = buffer.toString("utf8");
	const first = text.indexOf(oldText);
	if (first === -1) {
		throw new ChangeError(`\`old_text\` was not found in ${path.rel}. It must match the file exactly, spaces and line breaks included. If indentation is unclear, inspect the exact source with \`sed -n 'A,Bp' ${path.rel} | cat -A\` and retry without guessing`);
	}
	const places = text.split(oldText).length - 1;
	if (places > 1) throw new ChangeError(`\`old_text\` is found ${places} times in ${path.rel}. Add the lines around the passage until it matches one place only`);
	if (oldText === newText) throw new ChangeError("`old_text` and `new_text` are the same, so nothing would change");
	writeFileSync(path.abs, text.slice(0, first) + newText + text.slice(first + oldText.length));
	try { fileReference(root, brainDir, path.rel); }
	catch (error) {
		try { writeFileSync(path.abs, buffer); }
		catch (rollbackError) { throw new ChangeError(`The edit landed but its identity could not be recorded (${error.message}); rollback also failed (${rollbackError.message}). Stop and tell ${USER_NAME}.`); }
		throw new ChangeError(`The stable file identity could not be recorded (${error.message}); the file was restored and nothing was changed.`);
	}
	const line = text.slice(0, first).split("\n").length;
	const before = oldText.split("\n").length;
	const after = newText === "" ? 0 : newText.split("\n").length;
	return `Edited ${path.rel}: ${plural(before, "line")} from line ${line} replaced by ${plural(after, "line")}.`;
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

function recordFileUse(brainDir, conversationId) {
	updateContext(brainDir, (store) => {
		const task = taskState(store, conversationId);
		task.fileOps = (task.fileOps ?? 0) + 1;
	});
}

const authorizedRun = (brainDir, api, path, gate, work) => {
	try {
		fileAuthority(brainDir, api, path, gate);
		const text = work();
		recordFileUse(brainDir, api.conversationId);
		return { output: [{ type: "text", text }] };
	} catch (error) {
		if (error instanceof ChangeError) return { isError: true, output: [{ type: "text", text: `Refused: ${error.message}.` }] };
		throw error;
	}
};

/** @param {{ root: string, brainDir: string, gate?: { yolo: boolean }, write?: { newOnly?: boolean, maxLines?: number } }} project  root: real path of the project */
export function changeTools({ root, brainDir, gate, write = {} }) {
	return [
		defineTool({
			name: "write",
			description: "Create a NEW file of the project with a short piece of boilerplate. `write` refuses to replace an existing file; what it keeps of a new file is limited — beyond the limit the rest is not written and the result says so — so build and grow files with `edit`, one exact passage at a time. Folders are created as needed.",
			parameters: obj({
				path: str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "Path relative to the project directory" }),
				content: str({ maxLength: writeBudget(write.maxLines ?? 4096), description: "The whole text of the file; over the cap, the tail is not written" }),
			}),
			prepareArguments(args) {
				// Clipped here, before validation sees it, so an oversized call keeps the head of the file instead of being refused whole.
				const maxLines = write.maxLines ?? 4096;
				if (args !== null && typeof args === "object" && typeof args.content === "string") {
					const clipped = clipWriteContent(args.content, maxLines);
					if (clipped.clipped) return { ...args, content: clipped.text };
				}
				return args;
			},
			callers: ["tools"], // Internal primitive for book; the model uses target=file, action=create.
			executionMode: "sequential",
			// Writing the same text twice leaves the same file.
			replay: POLICY.enums.toolReplay.safe,
				execute: async (args, api) => authorizedRun(brainDir, api, args.path, gate, () => writeOne(root, brainDir, args.path, args.content, write)),
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
				execute: async (args, api) => authorizedRun(brainDir, api, args.path, gate, () => editOne(root, brainDir, args.path, args.old_text, args.new_text, { expectedVersion: args.expectedVersion })),
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
				execute: async (args, api) => authorizedRun(brainDir, api, args.path, gate, () => removeOne(root, brainDir, args.path, { expectedVersion: args.expectedVersion })),
		}),
	];
}
