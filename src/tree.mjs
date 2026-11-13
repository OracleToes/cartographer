// The tree: the project's files as they are, drawn for the agent.
//
// Nobody writes it. It is read from the disk each time it is shown, so it cannot
// be out of date. The main agent has no tools that look at files; the tree is how
// it sees where things are. It shows a few levels below an anchor folder: the
// agent moves the anchor into a folder to look around there, and back to the
// project root, and sets how many levels are drawn (the `atlas` tool, src/tools/atlas.mjs).
//
// A file or folder that a node of the graph links to carries the node's name, so
// the agent sees what it has written something about and what is blank.
import { statSync } from "node:fs";
import { join } from "node:path";
import { projectFiles } from "./tools/look.mjs";

export const DEPTH_DEFAULT = 3;
export const DEPTH_MAX = 6;
/** Lines the tree may take in the state block; beyond that it is drawn smaller. */
export const TREE_LINES = 60;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "." for the project root, otherwise a path without leading "./" or trailing "/". */
export function cleanAnchor(anchor) {
	const text = String(anchor ?? ".")
		.trim()
		.replace(/^(\.\/)+/, "")
		.replace(/\/+$/, "");
	return text === "" || text === "/" ? "." : text;
}

/** Whether `anchor` is a folder of the project that holds at least one listed file. */
export function isFolder(root, files, anchor) {
	if (anchor === ".") return true;
	try {
		if (!statSync(join(root, anchor)).isDirectory()) return false;
	} catch {
		return false;
	}
	return files.some((path) => path.startsWith(`${anchor}/`));
}

function nest(files, anchor) {
	const top = { dirs: new Map(), files: [], count: 0 };
	const prefix = anchor === "." ? "" : `${anchor}/`;
	for (const path of files) {
		if (!path.startsWith(prefix)) continue;
		const parts = path.slice(prefix.length).split("/");
		let node = top;
		node.count++;
		for (const part of parts.slice(0, -1)) {
			if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [], count: 0 });
			node = node.dirs.get(part);
			node.count++;
		}
		node.files.push(parts.at(-1));
	}
	return top;
}

function draw(node, path, level, depth, cap, marks, lines) {
	const entries = [...[...node.dirs.keys()].sort().map((name) => ({ name, dir: node.dirs.get(name) })), ...node.files.sort().map((name) => ({ name }))];
	const indent = "  ".repeat(level - 1);
	const mark = (rel) => {
		const names = marks.get(rel);
		if (names === undefined || names.length === 0) return "";
		return `  [${names.slice(0, 3).join(", ")}${names.length > 3 ? `, +${names.length - 3}` : ""}]`;
	};
	for (const [index, entry] of entries.entries()) {
		if (index >= cap) {
			const rest = entries.slice(index);
			const folders = rest.filter((item) => item.dir !== undefined).length;
			lines.push(`${indent}… ${[folders > 0 ? plural(folders, "more folder") : "", rest.length - folders > 0 ? plural(rest.length - folders, "more file") : ""].filter(Boolean).join(", ")}`);
			break;
		}
		const rel = path === "" ? entry.name : `${path}/${entry.name}`;
		if (entry.dir === undefined) lines.push(`${indent}${entry.name}${mark(rel)}`);
		else if (level < depth) {
			lines.push(`${indent}${entry.name}/${mark(rel)}`);
			draw(entry.dir, rel, level + 1, depth, cap, marks, lines);
		} else lines.push(`${indent}${entry.name}/  (${plural(entry.dir.count, "file")})${mark(rel)}`);
	}
}

/**
 * Draw the files under `anchor`, `depth` levels deep. A drawing longer than `maxLines` is made smaller: first by
 * showing fewer entries of each folder, then fewer levels.
 * @param {string[]} files  every file of the project, as relative paths
 * @param {{ anchor?: string, depth?: number, marks?: Map<string, string[]>, maxLines?: number }} options
 * @returns {{ lines: string[], depth: number, cap: number, under: number }}  depth and cap as drawn; under: files below the anchor
 */
export function drawTree(files, { anchor = ".", depth = DEPTH_DEFAULT, marks = new Map(), maxLines = TREE_LINES } = {}) {
	const top = nest(files, anchor);
	const base = anchor === "." ? "" : anchor;
	let last;
	for (let levels = depth; levels >= 1; levels--) {
		for (const cap of [Number.POSITIVE_INFINITY, 30, 12, 6]) {
			const lines = [];
			draw(top, base, 1, levels, cap, marks, lines);
			last = { lines, depth: levels, cap, under: top.count };
			if (lines.length <= maxLines) return last;
		}
	}
	return { ...last, lines: [...last.lines.slice(0, maxLines - 1), `… ${plural(last.lines.length - maxLines + 1, "more line")}`] };
}

/**
 * The tree as the agent is shown it: one line that says what is drawn, then the drawing.
 * @param {string} root
 * @param {{ anchor?: string, depth?: number }} view  what the agent asked for; a folder that is gone falls back to the root
 * @param {{ marks?: Map<string, string[]>, depth?: number, files?: string[], maxLines?: number }} options  depth: the default
 */
export function treeSection(root, view = {}, options = {}) {
	const files = options.files ?? projectFiles(root);
	let anchor = cleanAnchor(view.anchor);
	let lost = "";
	if (!isFolder(root, files, anchor)) {
		lost = ` The anchor was ${anchor}, which is no longer a folder with files in it.`;
		anchor = ".";
	}
	const asked = Number.isInteger(view.depth) ? Math.min(DEPTH_MAX, Math.max(1, view.depth)) : Math.min(DEPTH_MAX, options.depth ?? DEPTH_DEFAULT);
	if (files.length === 0) return { text: `The project directory holds no files yet.${lost}`, anchor, depth: asked, files };
	const drawn = drawTree(files, { anchor, depth: asked, marks: options.marks, maxLines: options.maxLines });
	const where = anchor === "." ? `From the project root, ${plural(asked, "level")} deep: ${plural(files.length, "file")} in all.` : `From ${anchor}/ (the anchor you set), ${plural(asked, "level")} deep: ${drawn.under} of the project's ${plural(files.length, "file")} are under it. \`atlas\` with a tree operation and anchor "." returns to the project root.`;
	const smaller = [];
	if (drawn.depth < asked) smaller.push(`${plural(drawn.depth, "level")} deep`);
	if (Number.isFinite(drawn.cap)) smaller.push(`at most ${drawn.cap} entries of a folder`);
	const fit = smaller.length > 0 ? ` Drawn ${smaller.join(" and ")} to keep it short: move the anchor into a folder to see all of it.` : "";
	// Below the root the anchor heads the drawing, so that every line still reads as a path from the project root.
	const lines = anchor === "." ? drawn.lines : [`${anchor}/`, ...drawn.lines.map((line) => `  ${line}`)];
	return { text: `${where}${fit}${lost}\n${lines.join("\n")}`, anchor, depth: asked, files };
}
