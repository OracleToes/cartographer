// The two tools a change task alters the project with: write and edit.
//
// They work only inside the project directory, and only for a task that runs a
// change item of an authorized plan (the rule is in src/harness.mjs). Every path
// they accept is one a checkpoint holds, so whatever they do can be undone:
//   - not outside the project, also not through a symlinked folder;
//   - not the brain folder `.atlas/` and not `.git/`;
//   - not a file that git ignores, and not one inside a nested git repository,
//     because checkpoints leave those out.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { isIgnored } from "../checkpoints.mjs";
import { BRAIN } from "../project.mjs";

const CONTENT_MAX_BYTES = 1_000_000;

export class ChangeError extends Error {}

const lineCount = (text) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
	if (Buffer.byteLength(content) > CONTENT_MAX_BYTES) throw new ChangeError(`\`content\` is larger than ${CONTENT_MAX_BYTES / 1_000_000} MB; write the file in parts, or generate it another way`);
	const path = confineWrite(root, brainDir, given);
	const lines = lineCount(content);
	if (options.maxLines !== undefined && lines > options.maxLines) {
		throw new ChangeError(`\`content\` has ${plural(lines, "line")}; \`write\` may create at most ${plural(options.maxLines, "line")} of a new file. Start the file short and grow it with \`edit\`, one exact passage at a time`);
	}
	const had = existsSync(path.abs) ? lineCount(readFileSync(path.abs, "utf8")) : undefined;
	if (options.newOnly === true && had !== undefined) {
		throw new ChangeError(`${path.rel} already exists, so \`write\` will not replace it whole. Change it with \`edit\`, one exact passage at a time (or give a new path)`);
	}
	mkdirSync(dirname(path.abs), { recursive: true });
	writeFileSync(path.abs, content);
	return `Wrote ${path.rel}: ${plural(lines, "line")}, ${had === undefined ? "a new file" : `replacing a file of ${plural(had, "line")}`}.`;
}

/** Replace one passage of a file. @returns {string} what happened, one line */
export function editOne(root, brainDir, given, oldText, newText) {
	if (typeof oldText !== "string" || oldText === "") throw new ChangeError("`old_text` is required: the passage to replace, copied exactly from the file");
	if (typeof newText !== "string") throw new ChangeError("`new_text` is required: what replaces the passage (an empty string deletes it)");
	const path = confineWrite(root, brainDir, given);
	if (!existsSync(path.abs)) throw new ChangeError(`${path.rel} does not exist. Use \`write\` to create a file`);
	const buffer = readFileSync(path.abs);
	if (buffer.subarray(0, 8000).includes(0)) throw new ChangeError(`${path.rel} is not a text file`);
	const text = buffer.toString("utf8");
	const first = text.indexOf(oldText);
	if (first === -1) {
		throw new ChangeError(`\`old_text\` was not found in ${path.rel}. It must match the file exactly, spaces and line breaks included: read the file and copy the passage from it`);
	}
	const places = text.split(oldText).length - 1;
	if (places > 1) throw new ChangeError(`\`old_text\` is found ${places} times in ${path.rel}. Add the lines around the passage until it matches one place only`);
	if (oldText === newText) throw new ChangeError("`old_text` and `new_text` are the same, so nothing would change");
	writeFileSync(path.abs, text.slice(0, first) + newText + text.slice(first + oldText.length));
	const line = text.slice(0, first).split("\n").length;
	const before = oldText.split("\n").length;
	const after = newText === "" ? 0 : newText.split("\n").length;
	return `Edited ${path.rel}: ${plural(before, "line")} from line ${line} replaced by ${plural(after, "line")}.`;
}

const run = (work) => {
	try {
		return { output: [{ type: "text", text: work() }] };
	} catch (error) {
		if (error instanceof ChangeError) return { isError: true, output: [{ type: "text", text: `Refused: ${error.message}.` }] };
		throw error;
	}
};

/** @param {{ root: string, brainDir: string, write?: { newOnly?: boolean, maxLines?: number } }} project  root: real path of the project */
export function changeTools({ root, brainDir, write = {} }) {
	return [
		defineTool({
			name: "write",
			description: "Create a NEW file of the project with a short piece of boilerplate. `write` refuses to replace an existing file and will not write a long one: build and grow files with `edit`, one exact passage at a time. Folders are created as needed.",
			parameters: obj({
				path: str({ minLength: 1, pattern: "\\S", description: "Path relative to the project directory" }),
				content: str({ description: "The whole text of the file" }),
			}),
			executionMode: "sequential",
			// Writing the same text twice leaves the same file.
			replay: "safe",
				execute: async (args) => run(() => writeOne(root, brainDir, args.path, args.content, write)),
		}),
		defineTool({
			name: "edit",
			description: "Replace one passage of a text file. `old_text` must match exactly one place in the file, so copy it from what `read` showed you, without the line numbers.",
			parameters: obj({
				path: str({ minLength: 1, pattern: "\\S", description: "Path relative to the project directory" }),
				old_text: str({ minLength: 1, description: "The passage to replace, exactly as it is in the file" }),
				new_text: str({ description: "What replaces it. An empty string deletes the passage." }),
			}),
			executionMode: "sequential",
			// Not run a second time after a crash: the passage may already be replaced, and the task reads the file again.
			replay: "unsafe",
			execute: async (args) => run(() => editOne(root, brainDir, args.path, args.old_text, args.new_text)),
		}),
	];
}
