// The three tools a task looks at the project with: read, search, list.
//
// They only read, and only inside the project directory. A path that leaves the
// project, also through a symlink, is refused. The brain folder is left out of
// listings and searches: it is the agent's own state, not the project.
import { POLICY } from "../config.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-durable";
import { arr, bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import { BRAIN } from "../project.mjs";

const READ_DEFAULT_LINES = POLICY.limits.look.readDefaultLines;
const READ_MAX_LINES = POLICY.limits.look.readMaxLines;
const READ_MAX_FILES = POLICY.limits.look.readMaxFiles;
const LINE_MAX_CHARS = POLICY.limits.look.lineChars;
const FILE_MAX_BYTES = POLICY.limits.look.fileBytes;
const SEARCH_DEFAULT = POLICY.limits.look.searchDefault;
const SEARCH_MAX = POLICY.limits.look.searchMax;
const LIST_MAX_LINES = POLICY.limits.look.listLines;
const WALK_MAX_FILES = POLICY.limits.look.walkFiles;
const SKIP_DIRS = new Set([...POLICY.enums.lookSkipDirs, BRAIN]);

export class LookError extends Error {}

/**
 * Turn what the model wrote into a path inside the project, or throw.
 * @param {string} root real path of the project
 * @param {string} given
 * @returns {{ abs: string, rel: string }}
 */
export function confine(root, given) {
	if (typeof given !== "string" || given.trim() === "") throw new LookError("a path is needed");
	const abs = resolve(root, given.trim());
	const inside = (path) => path === root || path.startsWith(root + sep);
	if (!inside(abs)) throw new LookError(`${given} is outside the project; only paths inside ${root} can be looked at`);
	// A symlink inside the project may point out of it.
	if (existsSync(abs) && !inside(realpathSync(abs))) throw new LookError(`${given} leads outside the project (a symlink); it cannot be looked at`);
	return { abs, rel: relative(root, abs) || "." };
}

/**
 * Whether a listed path is a file that may be looked at. A symlink counts only when it leads to a file inside the
 * project: one that leads out would let `search` read what `read` refuses.
 */
function isProjectFile(root, rel) {
	try {
		const abs = join(root, rel);
		if (!lstatSync(abs).isSymbolicLink()) return statSync(abs).isFile();
		const real = realpathSync(abs);
		return real.startsWith(root + sep) && statSync(real).isFile();
	} catch {
		return false; // Removed meanwhile, or a symlink to nothing.
	}
}

/** Every file of the project as a relative path, sorted. Follows .gitignore when the project is a git repository. */
export function projectFiles(root) {
	let files;
	if (existsSync(join(root, ".git"))) {
		try {
			const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
				cwd: root,
				encoding: "utf8",
				maxBuffer: POLICY.limits.look.maxBufferBytes,
				stdio: ["ignore", "pipe", "ignore"],
			});
			files = out.split("\0").filter((path) => path !== "");
		} catch {
			files = undefined;
		}
	}
	if (files === undefined) {
		files = [];
		const walk = (dir) => {
			if (files.length >= WALK_MAX_FILES) return;
			let entries;
			try {
				entries = readdirSync(join(root, dir), { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
				// Symlinked folders are not walked: they may lead out of the project, or back into it in a loop.
				if (entry.isDirectory()) {
					if (!SKIP_DIRS.has(entry.name)) walk(rel);
				} else files.push(rel);
			}
		};
		walk("");
	}
	return files.filter((path) => path !== BRAIN && !path.startsWith(`${BRAIN}/`) && isProjectFile(root, path)).sort();
}

function isBinary(buffer) {
	return buffer.subarray(0, POLICY.limits.look.binaryProbeChars).includes(0);
}

function globToRegExp(glob) {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*") {
			if (glob[i + 1] === "*") {
				out += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else out += "[^/]*";
		} else if (char === "?") out += "[^/]";
		else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

/** A glob without a slash is matched against the file name, one with a slash against the whole path. */
function matchesGlob(path, glob) {
	if (glob === undefined || glob === "") return true;
	const regex = globToRegExp(glob);
	return glob.includes("/") ? regex.test(path) : regex.test(path.slice(path.lastIndexOf("/") + 1));
}

const clip = (line) => (line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)} …[line cut, ${line.length} characters]` : line);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sizeOf = (bytes) => (bytes < POLICY.limits.format.kibibyte ? `${bytes} B` : bytes < POLICY.limits.format.mebibyte ? `${(bytes / POLICY.limits.format.kibibyte).toFixed(1)} KB` : `${(bytes / POLICY.limits.format.mebibyte).toFixed(1)} MB`);

// ─── read ────────────────────────────────────────────────────────────────────

/** @returns {string} what the model sees for one file */
export function readOne(root, given, offset, limit) {
	let path;
	try {
		path = confine(root, given);
	} catch (error) {
		return `== ${given}\nRefused: ${error.message}`;
	}
	if (!existsSync(path.abs)) return `== ${path.rel}\nNot found. Use \`list\` or \`search\` to find the right path.`;
	const stat = statSync(path.abs);
	if (stat.isDirectory()) return `== ${path.rel}\nThis is a directory. Use \`list\` to see what is in it.`;
	if (stat.size > FILE_MAX_BYTES) return `== ${path.rel}\nToo large to read (${sizeOf(stat.size)}). Use \`search\` to find the part you need.`;
	const buffer = readFileSync(path.abs);
	if (isBinary(buffer)) return `== ${path.rel}\nA binary file (${sizeOf(stat.size)}); it has no text to read.`;
	const lines = buffer.toString("utf8").split("\n");
	if (lines.at(-1) === "") lines.pop();
	const first = Math.max(1, Math.floor(offset ?? 1));
	const count = Math.max(1, Math.min(READ_MAX_LINES, Math.floor(limit ?? READ_DEFAULT_LINES)));
	if (lines.length === 0) return `== ${path.rel}\n(empty file)`;
	if (first > lines.length) return `== ${path.rel}\nThe file has ${lines.length} lines; line ${first} does not exist.`;
	const last = Math.min(lines.length, first + count - 1);
	const width = String(last).length;
	const body = lines.slice(first - 1, last).map((line, i) => `${String(first + i).padStart(width)}  ${clip(line)}`);
	const more = last < lines.length ? `\n(${lines.length - last} more lines; continue with offset ${last + 1})` : "";
	return `== ${path.rel} (lines ${first}-${last} of ${lines.length})\n${body.join("\n")}${more}`;
}

// ─── search ──────────────────────────────────────────────────────────────────

/** @returns {string} */
export function searchProject(root, args) {
	const max = Math.max(1, Math.min(SEARCH_MAX, Math.floor(args.max ?? SEARCH_DEFAULT)));
	let regex;
	let note = "";
	try {
		regex = new RegExp(args.pattern, args.ignore_case ? "i" : "");
	} catch (error) {
		// A pattern that is not a valid regular expression is searched for as plain text.
		regex = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), args.ignore_case ? "i" : "");
		note = `(the pattern is not a valid regular expression: ${error.message}; searched for it as plain text)\n`;
	}
	let scope = "";
	if (args.path !== undefined && args.path !== "" && args.path !== ".") {
		const path = confine(root, args.path);
		if (!existsSync(path.abs)) return `Nothing to search: ${path.rel} does not exist.`;
		scope = path.rel;
	}
	const files = projectFiles(root).filter(
		(path) => (scope === "" || path === scope || path.startsWith(`${scope}/`)) && matchesGlob(path, args.glob),
	);
	const hits = [];
	let total = 0;
	let filesWithHits = 0;
	let skipped = 0;
	for (const path of files) {
		let buffer;
		try {
			const stat = statSync(join(root, path));
			if (!stat.isFile() || stat.size > FILE_MAX_BYTES) {
				skipped++;
				continue;
			}
			buffer = readFileSync(join(root, path));
		} catch {
			continue;
		}
		if (isBinary(buffer)) continue;
		const lines = buffer.toString("utf8").split("\n");
		let inFile = 0;
		for (let i = 0; i < lines.length; i++) {
			if (!regex.test(lines[i])) continue;
			total++;
			inFile++;
			if (hits.length < max) hits.push(`${path}:${i + 1}: ${clip(lines[i].trim()).slice(0, POLICY.limits.look.searchHitChars)}`);
		}
		if (inFile > 0) filesWithHits++;
	}
	const where = `${scope === "" ? "the project" : scope}${args.glob ? ` (files matching ${args.glob})` : ""}`;
	if (total === 0) return `${note}No match for /${args.pattern}/ in ${where} (${plural(files.length, "file")} searched).`;
	const head = `${note}${total} match${total === 1 ? "" : "es"} in ${plural(filesWithHits, "file")} of ${where}${total > hits.length ? `; the first ${hits.length} are shown, narrow the pattern or path to see the rest` : ""}.`;
	const tail = skipped > 0 ? `\n(${plural(skipped, "file")} over ${sizeOf(FILE_MAX_BYTES)} not searched)` : "";
	return `${head}\n${hits.join("\n")}${tail}`;
}

// ─── list ────────────────────────────────────────────────────────────────────

/** @returns {string} */
export function listProject(root, args) {
	const depth = Math.max(POLICY.validation.positiveIntegerMin, Math.min(POLICY.limits.tree.maxDepth, Math.floor(args.depth ?? POLICY.limits.tree.listDefaultDepth)));
	const path = confine(root, args.path === undefined || args.path === "" ? "." : args.path);
	if (!existsSync(path.abs)) return `${path.rel} does not exist.`;
	if (!statSync(path.abs).isDirectory()) return `${path.rel} is a file. Use \`read\` to see it.`;
	const prefix = path.rel === "." ? "" : `${path.rel}/`;
	const files = projectFiles(root).filter((file) => file.startsWith(prefix));
	if (files.length === 0) {
		// Said plainly, so that an empty folder is not listed a second time to make sure.
		const name = path.rel === "." ? "The project folder" : path.rel;
		const present = readdirSync(path.abs).filter((entry) => !(path.rel === "." && (entry === BRAIN || entry === ".git")));
		if (present.length === 0) return `${name} is empty: there are no files or folders in it, hidden ones included. (A .git folder and Cartographer's own .atlas folder are never listed.)`;
		return `${name} has no files to list: what is in it is ignored by git, or is an empty folder.`;
	}
	// Build the tree down to `depth`; deeper folders are shown with a file count.
	const lines = [];
	const folders = new Map();
	for (const file of files) {
		const parts = file.slice(prefix.length).split("/");
		if (parts.length <= depth) {
			lines.push({ key: parts.join("/"), text: `${"  ".repeat(parts.length - 1)}${parts.at(-1)}`, file });
			for (let i = 1; i < parts.length; i++) folders.set(parts.slice(0, i).join("/"), { level: i - 1, name: parts[i - 1], deep: 0 });
		} else {
			const key = parts.slice(0, depth).join("/");
			const folder = folders.get(key) ?? { level: depth - 1, name: parts[depth - 1], deep: 0 };
			folder.deep++;
			folders.set(key, folder);
			for (let i = 1; i < depth; i++) if (!folders.has(parts.slice(0, i).join("/"))) folders.set(parts.slice(0, i).join("/"), { level: i - 1, name: parts[i - 1], deep: 0 });
		}
	}
	for (const [key, folder] of folders) {
		lines.push({ key: `${key}/`, text: `${"  ".repeat(folder.level)}${folder.name}/${folder.deep > 0 ? `  (${plural(folder.deep, "file")} deeper)` : ""}` });
	}
	lines.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const shown = lines.slice(0, LIST_MAX_LINES).map((line) => {
		if (line.file === undefined) return line.text;
		let size = "";
		try {
			size = `  ${sizeOf(statSync(join(root, line.file)).size)}`;
		} catch {
			// Removed since it was listed.
		}
		return `${line.text}${size}`;
	});
	const cut = lines.length > LIST_MAX_LINES ? `\n(${lines.length - LIST_MAX_LINES} more entries; list a subfolder to see them)` : "";
	return `${path.rel === "." ? "project" : path.rel}: ${plural(files.length, "file")}\n${shown.join("\n")}${cut}`;
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const text = (value) => ({ output: [{ type: "text", text: value }] });

/** @param {string} root real path of the project */
export function lookTools(root) {
	return [
		defineTool({
			name: "read",
			description: `Read text files of the project, with line numbers. Up to ${READ_MAX_FILES} files in one call; ${READ_DEFAULT_LINES} lines of each unless you set \`limit\`.`,
			parameters: obj({
				paths: arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S" }), { minItems: POLICY.validation.nonEmptyArrayMinItems, maxItems: READ_MAX_FILES, description: "Paths relative to the project directory" }),
				offset: opt(int({ minimum: POLICY.validation.positiveIntegerMin, description: `First line to read, counting from ${POLICY.validation.positiveIntegerMin}. Default ${POLICY.validation.positiveIntegerMin}.` })),
				limit: opt(int({ minimum: POLICY.validation.positiveIntegerMin, maximum: READ_MAX_LINES, description: `How many lines of each file. Default ${READ_DEFAULT_LINES}, at most ${READ_MAX_LINES}.` })),
			}),
			replay: POLICY.enums.toolReplay.safe,
			execute: async (args) => {
				const paths = (Array.isArray(args.paths) ? args.paths : [args.paths]).filter((path) => typeof path === "string" && path !== "");
				if (paths.length === 0) return { ...text("`paths` is empty: name at least one file."), isError: true };
				const taken = paths.slice(0, READ_MAX_FILES);
				const parts = taken.map((path) => readOne(root, path, args.offset, args.limit));
				if (paths.length > taken.length) parts.push(`(${paths.length - taken.length} more paths were not read: at most ${READ_MAX_FILES} per call)`);
				return text(parts.join("\n\n"));
			},
		}),
		defineTool({
			name: "search",
			description:
				"Search the text of the project's files for a regular expression. Returns matching lines as path:line: text. Files that git ignores are not searched.",
			parameters: obj({
				pattern: str({ minLength: POLICY.validation.nonEmptyStringMinLength, description: "Regular expression (JavaScript syntax). Plain words work too." }),
				path: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "Folder or file to search in, relative to the project. Default: the whole project." })),
				glob: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, description: "Only files whose name matches, for example *.ts" })),
				ignore_case: opt(bool({ description: "Match upper and lower case alike. Default false." })),
				max: opt(int({ minimum: POLICY.validation.positiveIntegerMin, maximum: SEARCH_MAX, description: `Most matching lines to return. Default ${SEARCH_DEFAULT}, at most ${SEARCH_MAX}.` })),
			}),
			replay: POLICY.enums.toolReplay.safe,
			execute: async (args) => {
				if (typeof args.pattern !== "string" || args.pattern === "") return { ...text("`pattern` is empty: say what to search for."), isError: true };
				try {
					return text(searchProject(root, args));
				} catch (error) {
					if (error instanceof LookError) return { ...text(`Refused: ${error.message}`), isError: true };
					throw error;
				}
			},
		}),
		defineTool({
			name: "list",
			description: "List the files of the project or of one folder, as a tree with sizes. Files that git ignores are not listed.",
			parameters: obj({
				path: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "Folder relative to the project. Default: the project directory." })),
				depth: opt(int({ minimum: POLICY.validation.positiveIntegerMin, maximum: POLICY.limits.tree.maxDepth, description: `How many levels to show. Default ${POLICY.limits.tree.listDefaultDepth}, at most ${POLICY.limits.tree.maxDepth}.` })),
			}),
			replay: POLICY.enums.toolReplay.safe,
			execute: async (args) => {
				try {
					return text(listProject(root, args));
				} catch (error) {
					if (error instanceof LookError) return { ...text(`Refused: ${error.message}`), isError: true };
					throw error;
				}
			},
		}),
	];
}
