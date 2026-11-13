// The graph: what the agent has understood about the project, as nodes.
//
// A node is a name, one line that says what it is (the gist), optional longer
// detail, links to other nodes, and links to files or folders. It needs neither
// kind of link: the agent decides what deserves a node, and not every file needs
// one. Together with the tree (src/tree.mjs) this is the atlas.
//
// One thing is checked by the program. When a node links to a file, the file's
// fingerprint is kept with the link. A file that changed or disappeared since
// marks the node as possibly out of date, until someone rewrites or confirms it.
//
// It lives in <project>/.atlas/carto-atlas.json as plain JSON so the user can read
// and edit it; the file is read again every time it is needed.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRAIN } from "./project.mjs";
import { ago, since } from "./time.mjs";
import { confine, LookError } from "./tools/look.mjs";
import { cleanAnchor, DEPTH_MAX, isFolder } from "./tree.mjs";

/** A node without a kind is a plain node. */
export const KINDS = ["component", "finding", "dead_end"];
export const NAME_MAX = 40;
export const GIST_MAX = 200;
export const DETAIL_MAX = 2000;
export const NODES_MAX = 200;
export const LINKS_MAX = 12;
export const FILES_MAX = 12;
/** Characters the outline at the top of the context may take; beyond that the oldest nodes are listed by name only. */
export const OUTLINE_MAX = 6000;
const BIG_FILE = 5_000_000;

export class AtlasError extends Error {}

export const atlasPath = (brainDir) => join(brainDir, "carto-atlas.json");
const empty = () => ({ version: 1, view: { anchor: "." }, nodes: [] });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const flat = (text) => String(text).replace(/\s+/g, " ").trim();
const sha = (data) => createHash("sha1").update(data).digest("hex");

/** A name as it is stored: lower case, words joined by "_". Whatever the agent writes finds the same node again. */
export function normName(name) {
	return String(name ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

/**
 * Read the atlas. A file that cannot be understood is reported, never overwritten: `error` says what is wrong and
 * `atlas` is then undefined.
 * @returns {{ atlas?: ReturnType<typeof empty>, error?: string }}
 */
export function loadAtlas(brainDir) {
	const path = atlasPath(brainDir);
	if (!existsSync(path)) return { atlas: empty() };
	let raw;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { error: `${path} is not valid JSON (${error.message})` };
	}
	if (raw === null || typeof raw !== "object" || !Array.isArray(raw.nodes)) return { error: `${path} must hold an object with a "nodes" list` };
	const seen = new Set();
	const nodes = [];
	const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
	for (const [index, node] of raw.nodes.entries()) {
		const where = `${path}, node ${index + 1}`;
		if (node === null || typeof node !== "object") return { error: `${where} is not an object` };
		const name = normName(node.name);
		if (name === "") return { error: `${where}: "name" is missing` };
		if (seen.has(name)) return { error: `${where}: the name ${name} is used twice` };
		if (typeof node.gist !== "string" || node.gist.trim() === "") return { error: `${where} (${name}): "gist" is missing` };
		if (node.kind !== undefined && !KINDS.includes(node.kind)) return { error: `${where} (${name}): "kind" must be one of ${KINDS.join(", ")}, or left out` };
		if (node.links !== undefined && !strings(node.links)) return { error: `${where} (${name}): "links" must be a list of node names` };
		if (node.files !== undefined && !strings(node.files)) return { error: `${where} (${name}): "files" must be a list of paths` };
		seen.add(name);
		nodes.push({
			...node,
			name,
			links: [...new Set((node.links ?? []).map(normName).filter((link) => link !== "" && link !== name))],
			files: [...new Set((node.files ?? []).map(cleanAnchor))],
			seen: node.seen !== null && typeof node.seen === "object" ? node.seen : {},
		});
	}
	const view = raw.view !== null && typeof raw.view === "object" ? raw.view : {};
	return { atlas: { ...raw, version: 1, view: { anchor: cleanAnchor(view.anchor), ...(Number.isInteger(view.depth) ? { depth: view.depth } : {}) }, nodes } };
}

/** Write the atlas so that a reader never sees half a file. */
export function saveAtlas(brainDir, atlas) {
	const path = atlasPath(brainDir);
	const temp = `${path}.${process.pid}.tmp`;
	// What a reader looks for first comes first.
	const nodes = atlas.nodes.map(({ name, kind, gist, detail, links, files, ...rest }) => ({ name, ...(kind ? { kind } : {}), gist, ...(detail ? { detail } : {}), links, files, ...rest }));
	writeFileSync(temp, `${JSON.stringify({ ...atlas, nodes }, null, "\t")}\n`);
	renameSync(temp, path);
}

// ─── Files ──────────────────────────────────────────────────────────────────

const prints = new Map(); // full path -> { size, mtimeMs, print }

/**
 * What a file or folder looks like now, in a few characters: a file by its content, a folder by the names in it.
 * @returns {{ print: string, changed: number } | undefined}  undefined when it is not there; changed: when it last changed (ms)
 */
export function fingerprint(root, rel) {
	const abs = join(root, rel);
	let info;
	try {
		info = statSync(abs);
	} catch {
		return undefined;
	}
	if (info.isDirectory()) {
		let names = [];
		try {
			names = readdirSync(abs).filter((name) => name !== ".git" && name !== BRAIN);
		} catch {}
		return { print: `d:${sha(names.sort().join("\0")).slice(0, 12)}`, changed: info.mtimeMs };
	}
	if (info.size > BIG_FILE) return { print: `s:${info.size}:${Math.floor(info.mtimeMs)}`, changed: info.mtimeMs };
	const known = prints.get(abs);
	if (known !== undefined && known.size === info.size && known.mtimeMs === info.mtimeMs) return { print: known.print, changed: info.mtimeMs };
	let print;
	try {
		print = `f:${sha(readFileSync(abs)).slice(0, 12)}`;
	} catch {
		return undefined;
	}
	prints.set(abs, { size: info.size, mtimeMs: info.mtimeMs, print });
	return { print, changed: info.mtimeMs };
}

/**
 * How each file a node links to stands against the node.
 * @returns {{ path: string, state: "same" | "changed" | "gone", changed?: number }[]}
 */
export function fileStates(root, node) {
	return node.files.map((path) => {
		const now = fingerprint(root, path);
		if (now === undefined) return { path, state: "gone" };
		const then = node.seen[path];
		// A link written by hand has no fingerprint yet: taken as true until the node is next written.
		return { path, state: then === undefined || then === now.print ? "same" : "changed", changed: now.changed };
	});
}

/**
 * The nodes that may no longer be true, each with why.
 * @returns {{ name: string, why: string[] }[]}
 */
export function staleNodes(root, atlas, now = Date.now()) {
	const stale = [];
	for (const node of atlas.nodes) {
		const why = fileStates(root, node).flatMap((file) => (file.state === "gone" ? [`${file.path} is gone`] : file.state === "changed" ? [`${file.path} changed ${ago(now - file.changed)}`] : []));
		if (why.length > 0) stale.push({ name: node.name, why });
	}
	return stale;
}

/** For the tree: which nodes link to which path. */
export function fileMarks(atlas) {
	const marks = new Map();
	for (const node of atlas.nodes) {
		for (const path of node.files) marks.set(path, [...(marks.get(path) ?? []), node.name]);
	}
	return marks;
}

/** How many of `files` a node links to, directly or through a folder above them. */
export function linkedCount(atlas, files) {
	const linked = new Set(atlas.nodes.flatMap((node) => node.files));
	if (linked.has(".")) return files.length;
	return files.filter((path) => {
		if (linked.has(path)) return true;
		for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1)) if (linked.has(path.slice(0, cut))) return true;
		return false;
	}).length;
}

// ─── Operations ─────────────────────────────────────────────────────────────

function find(atlas, given) {
	const name = normName(given);
	const node = atlas.nodes.find((entry) => entry.name === name);
	if (node === undefined) {
		const names = atlas.nodes.map((entry) => entry.name);
		const listed = names.length === 0 ? "The graph has no nodes yet." : `Nodes: ${names.slice(0, 40).join(", ")}${names.length > 40 ? `, and ${names.length - 40} more` : ""}.`;
		throw new AtlasError(`There is no node ${name || "(no name given)"}. ${listed}`);
	}
	return node;
}

function checkedGist(value) {
	if (typeof value !== "string" || value.trim() === "") throw new AtlasError("`gist` (one line that says what this is) is required and was left out or empty.");
	const text = flat(value);
	if (text.length > GIST_MAX) throw new AtlasError(`\`gist\` is ${text.length} characters; the limit is ${GIST_MAX}. Say it in one line and put the rest into \`detail\`.`);
	return text;
}

/**
 * Paths the agent gave, as project paths that exist. A path that names nothing yet is created, as an empty file
 * (or a folder, when it ends with a slash): a node may be written for a file that is planned, and the map and the
 * project then agree from the start. `created` collects what was made, so that the agent is told. Making a file
 * changes the project, so it is done only while changes may be made at all (`mayCreate`: the plan is authorized,
 * or approval is switched off).
 */
function checkedFiles(root, given, created = [], mayCreate = false) {
	if (given === undefined || given === null) return [];
	if (!Array.isArray(given)) throw new AtlasError("`files` is a list of paths.");
	return given.map((path) => {
		let rel;
		try {
			rel = confine(root, String(path)).rel;
		} catch (error) {
			if (!(error instanceof LookError)) throw error;
			throw new AtlasError(`\`files\`: ${error.message}.`);
		}
		if (!existsSync(join(root, rel))) {
			if (rel === "" || /^(\.atlas|\.git)(\/|$)/.test(rel)) throw new AtlasError(`\`files\`: there is no file or folder ${rel} in the project, and none can be made there.`);
			if (!mayCreate) throw new AtlasError(`\`files\`: there is no file or folder ${rel} in the project. Check the path against the tree. If the file is planned, write the node without it for now, since a node needs no file: once the user has authorized the plan, linking a missing file creates it, empty.`);
			const folder = /\/\s*$/.test(String(path));
			try {
				if (folder) mkdirSync(join(root, rel), { recursive: true });
				else {
					mkdirSync(dirname(join(root, rel)), { recursive: true });
					writeFileSync(join(root, rel), "", { flag: "wx" });
				}
			} catch (error) {
				throw new AtlasError(`\`files\`: there is no file or folder ${rel} in the project, and it could not be created (${error.code ?? error.message}). Check the path against the tree; a node needs no file.`);
			}
			created.push(folder ? `${rel}/` : rel);
		}
		return rel;
	});
}

function checkedLinks(given, own) {
	if (given === undefined || given === null) return [];
	if (!Array.isArray(given)) throw new AtlasError("`links` is a list of node names.");
	return [...new Set(given.map(normName).filter((name) => name !== "" && name !== own))];
}

const kindWord = (node) => (node.kind === undefined ? "node" : node.kind.replace("_", " "));

/** Every file link of the node is taken as checked now. */
function stampFiles(root, node, paths = node.files) {
	for (const path of paths) {
		const now = fingerprint(root, path);
		if (now !== undefined) node.seen[path] = now.print;
	}
	for (const path of Object.keys(node.seen)) if (!node.files.includes(path)) delete node.seen[path];
}

function missingLinks(atlas, node) {
	const names = new Set(atlas.nodes.map((entry) => entry.name));
	return node.links.filter((link) => !names.has(link));
}

/** One node in full, as `look` shows it. */
export function renderNode(root, atlas, node, now = Date.now()) {
	const age = since(node.written, now);
	const lines = [`${node.name} (${kindWord(node)})${age === undefined ? "" : ` · written ${ago(age)}`}${node.by ? ` by ${node.by === "task" ? "a task" : node.by === "main" ? "the main agent" : "the user"}` : ""}`, node.gist];
	if (node.detail) lines.push("Detail:", node.detail);
	if (node.files.length > 0) {
		lines.push("Files:");
		for (const file of fileStates(root, node)) {
			const state = file.state === "gone" ? "is gone" : file.state === "changed" ? `changed ${ago(now - file.changed)}, after this node was written: the node may be out of date` : "unchanged since this node was written";
			lines.push(`  ${file.path}  (${state})`);
		}
	}
	const gistOf = (name) => atlas.nodes.find((entry) => entry.name === name)?.gist ?? "(no node of this name yet)";
	if (node.links.length > 0) {
		lines.push("Links to:");
		for (const link of node.links) lines.push(`  ${link}  ${gistOf(link)}`);
	}
	const from = atlas.nodes.filter((entry) => entry.links.includes(node.name));
	if (from.length > 0) {
		lines.push("Linked from:");
		for (const entry of from) lines.push(`  ${entry.name}  ${entry.gist}`);
	}
	return lines.join("\n");
}

/** One line for a node, as the outline and the terminal show it. */
export function nodeLine(node) {
	const files = node.files.length > 0 ? `  [${node.files.join(", ")}]` : "";
	const links = node.links.length > 0 ? `  → ${node.links.join(", ")}` : "";
	return `${node.name}  ${node.gist}${files}${links}${node.detail ? "  (+detail)" : ""}`;
}

/**
 * A result line that may end by naming links to nodes that do not exist. `settle` writes the line again once the
 * rest of a call was applied, so that a node written later in the same call is not reported as missing.
 */
function unmet(base, missing, say) {
	const lineFor = (names) => `${base}${names.length > 0 ? say(names) : ""}`;
	return { line: lineFor(missing), settle: (atlas) => lineFor(missing.filter((name) => !atlas.nodes.some((node) => node.name === name))) };
}

/**
 * Apply one operation to `atlas` (changed in place).
 * @param {{ root: string, now: string, by: "main" | "task" | "user", main: boolean, files?: () => string[] }} who
 *   main: whether the main agent is calling; files: lists the project's files, for the tree operation
 * @returns {{ line: string, shown?: string, changed: boolean }} line: what the agent is told; shown: what the user is shown
 */
export function applyAtlasOp(atlas, op, who) {
	const { root, now } = who;
	switch (op?.action) {
		case "add":
		case "edit": {
			const name = normName(op.name);
			if (name === "") throw new AtlasError("`name` is required: a short name for the node, such as dice_roll.");
			if (name.length > NAME_MAX) throw new AtlasError(`The name is ${name.length} characters; the limit is ${NAME_MAX}.`);
			const gist = checkedGist(op.gist);
			if (op.kind !== undefined && op.kind !== null && op.kind !== "" && op.kind !== "node" && !KINDS.includes(op.kind)) {
				throw new AtlasError(`\`kind\` is ${JSON.stringify(op.kind)}; it is one of ${KINDS.join(", ")}, or left out for a plain node.`);
			}
			let detail;
			if (op.detail !== undefined && op.detail !== null) {
				detail = String(op.detail).trim();
				if (detail.length > DETAIL_MAX) throw new AtlasError(`\`detail\` is ${detail.length} characters; the limit is ${DETAIL_MAX}. Keep what matters, or split it over two nodes.`);
			}
			const files = checkedFiles(root, op.files, who.created, who.mayCreate === true);
			const links = checkedLinks(op.links, name);
			let node = atlas.nodes.find((entry) => entry.name === name);
			const fresh = node === undefined;
			if (op.action === "add" && !fresh) throw new AtlasError(`There is a node ${name} already; \`edit\` rewrites it.`);
			if (op.action === "edit" && fresh) throw new AtlasError(`There is no node ${name} to edit; \`add\` writes a new one.`);
			if (fresh) {
				if (atlas.nodes.length >= NODES_MAX) throw new AtlasError(`The graph has ${NODES_MAX} nodes, which is its limit. Remove nodes that no longer matter, or fold several into one.`);
				node = { name, gist, links: [], files: [], seen: {} };
			}
			const allFiles = [...new Set([...node.files, ...files])];
			const allLinks = [...new Set([...node.links, ...links])];
			if (allFiles.length > FILES_MAX) throw new AtlasError(`That would give ${name} ${allFiles.length} file links; the limit is ${FILES_MAX}. Link the folder, or split the node.`);
			if (allLinks.length > LINKS_MAX) throw new AtlasError(`That would give ${name} ${allLinks.length} links; the limit is ${LINKS_MAX}.`);
			node.gist = gist;
			if (op.kind === "node" || op.kind === "") delete node.kind;
			else if (KINDS.includes(op.kind)) node.kind = op.kind;
			if (detail !== undefined) {
				if (detail === "") delete node.detail;
				else node.detail = detail;
			}
			node.files = allFiles;
			node.links = allLinks;
			// Whoever writes a node says it is true now, of the files as they are now.
			stampFiles(root, node);
			node.written = now;
			node.by = who.by;
			if (fresh) atlas.nodes.push(node);
			const missing = missingLinks(atlas, node);
			return {
				...unmet(`${name} ${fresh ? "written" : "rewritten"}.`, missing, (names) => ` It links to ${names.join(", ")}, which ${names.length === 1 ? "is not a node" : "are not nodes"} yet.`),
				shown: `${fresh ? "+" : "~"} ${kindWord(node)} ${nodeLine(node)}`,
				changed: true,
			};
		}
		case "link":
		case "unlink": {
			const node = find(atlas, op.name);
			const files = op.action === "link" ? checkedFiles(root, op.files, who.created, who.mayCreate === true) : (Array.isArray(op.files) ? op.files : []).map(cleanAnchor);
			const links = checkedLinks(op.links, node.name);
			if (files.length === 0 && links.length === 0) throw new AtlasError(`\`${op.action}\` needs \`links\` (node names), \`files\` (paths), or both.`);
			if (op.action === "link") {
				const allFiles = [...new Set([...node.files, ...files])];
				const allLinks = [...new Set([...node.links, ...links])];
				if (allFiles.length > FILES_MAX) throw new AtlasError(`That would give ${node.name} ${allFiles.length} file links; the limit is ${FILES_MAX}. Link the folder, or split the node.`);
				if (allLinks.length > LINKS_MAX) throw new AtlasError(`That would give ${node.name} ${allLinks.length} links; the limit is ${LINKS_MAX}.`);
				const added = files.filter((path) => !node.files.includes(path));
				node.files = allFiles;
				node.links = allLinks;
				stampFiles(root, node, added);
				const missing = missingLinks(atlas, node).filter((link) => links.includes(link));
				return {
					...unmet(`${node.name} linked to ${[...links, ...files].join(", ")}.`, missing, (names) => ` ${names.join(", ")} ${names.length === 1 ? "is not a node" : "are not nodes"} yet.`),
					shown: `~ ${kindWord(node)} ${nodeLine(node)}`,
					changed: true,
				};
			}
			const had = [...links.filter((link) => node.links.includes(link)), ...files.filter((path) => node.files.includes(path))];
			if (had.length === 0) throw new AtlasError(`${node.name} has none of these links. Its links: ${[...node.links, ...node.files].join(", ") || "none"}.`);
			node.links = node.links.filter((link) => !links.includes(link));
			node.files = node.files.filter((path) => !files.includes(path));
			stampFiles(root, node, []);
			return { line: `${node.name} no longer links to ${had.join(", ")}.`, shown: `~ ${kindWord(node)} ${nodeLine(node)}`, changed: true };
		}
		case "confirm": {
			const given = Array.isArray(op.names) ? op.names : op.name !== undefined ? [op.name] : [];
			if (given.length === 0) throw new AtlasError("`names` is required: the nodes you checked and found still true.");
			const lines = [];
			const done = [];
			for (const each of given) {
				const name = normName(each);
				const node = atlas.nodes.find((entry) => entry.name === name);
				if (node === undefined) {
					lines.push(`There is no node ${name}.`);
					continue;
				}
				const gone = fileStates(root, node).filter((file) => file.state === "gone").map((file) => file.path);
				stampFiles(root, node);
				done.push(name);
				lines.push(gone.length > 0 ? `${name} confirmed, but ${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} gone: unlink ${gone.length === 1 ? "it" : "them"}, or link what replaced ${gone.length === 1 ? "it" : "them"}.` : `${name} confirmed.`);
			}
			if (done.length === 0) throw new AtlasError(lines.join(" "));
			return { line: lines.join(" "), shown: `✓ confirmed ${done.join(", ")}`, changed: true };
		}
		case "remove": {
			const node = find(atlas, op.name);
			atlas.nodes.splice(atlas.nodes.indexOf(node), 1);
			let dropped = 0;
			for (const other of atlas.nodes) {
				if (!other.links.includes(node.name)) continue;
				other.links = other.links.filter((link) => link !== node.name);
				dropped++;
			}
			return { line: `${node.name} removed.${dropped > 0 ? ` ${plural(dropped, "link")} to it went with it.` : ""}`, shown: `- ${kindWord(node)} ${node.name}  ${node.gist}`, changed: true };
		}
		case "look": {
			const name = normName(op.name);
			const node = atlas.nodes.find((entry) => entry.name === name);
			if (node !== undefined) return { line: renderNode(root, atlas, node, Date.parse(now)), changed: false };
			// Not a node: perhaps a path. Then the nodes that link to it, or to a folder above it.
			let rel;
			try {
				rel = typeof op.name === "string" && existsSync(confine(root, op.name).abs) ? confine(root, op.name).rel : undefined;
			} catch {
				rel = undefined;
			}
			if (rel === undefined) find(atlas, op.name);
			const about = atlas.nodes.filter((entry) => entry.files.some((path) => path === rel || path === "." || rel.startsWith(`${path}/`)));
			if (about.length === 0) return { line: `No node links to ${rel}.`, changed: false };
			return { line: [`Nodes that link to ${rel}, or to a folder above it:`, ...about.map((entry) => `  ${nodeLine(entry)}`)].join("\n"), changed: false };
		}
		case "tree": {
			if (!who.main) throw new AtlasError("The tree's anchor and depth belong to the main agent's view. In a task, `list` shows any folder.");
			const view = { ...atlas.view };
			if (op.anchor !== undefined && op.anchor !== null) {
				let anchor = cleanAnchor(op.anchor);
				if (anchor !== ".") {
					try {
						anchor = confine(root, anchor).rel;
					} catch (error) {
						if (!(error instanceof LookError)) throw error;
						throw new AtlasError(`\`anchor\`: ${error.message}.`);
					}
				}
				if (!isFolder(root, who.files?.() ?? [], anchor)) throw new AtlasError(`\`anchor\`: ${anchor} is not a folder of the project with files in it. The anchor is a folder; "." is the project root.`);
				view.anchor = anchor;
			}
			if (op.depth !== undefined && op.depth !== null) {
				if (!Number.isInteger(op.depth) || op.depth < 1 || op.depth > DEPTH_MAX) throw new AtlasError(`\`depth\` is a whole number from 1 to ${DEPTH_MAX}.`);
				view.depth = op.depth;
			}
			if (op.anchor === undefined && op.depth === undefined) throw new AtlasError('A tree operation needs `anchor` (a folder; "." is the project root), `depth`, or both.');
			atlas.view = view;
			const where = view.anchor === "." ? "the project root" : `${view.anchor}/`;
			return { line: `The tree is now drawn from ${where}${view.depth !== undefined ? `, ${plural(view.depth, "level")} deep` : ""}: see the state block below.`, shown: `tree from ${where}${view.depth !== undefined ? `, depth ${view.depth}` : ""}`, changed: true };
		}
		default:
			throw new AtlasError(`Unknown action ${JSON.stringify(op?.action)}; the actions are add, edit, link, unlink, confirm, remove, look, tree.`);
	}
}

// ─── What is shown ──────────────────────────────────────────────────────────

const HEADINGS = [
	["component", "Components"],
	["finding", "Findings"],
	[undefined, "Other nodes"],
	["dead_end", "Dead ends (tried and ruled out)"],
];

/**
 * Every node on one line, grouped by kind. When that is longer than `max` characters, the nodes written longest ago
 * are listed by name only.
 */
export function renderOutline(atlas, max = OUTLINE_MAX) {
	if (atlas.nodes.length === 0) return "The graph has no nodes yet.";
	const shown = atlas.nodes.filter((node) => node.archived !== true);
	if (shown.length === 0) return `Every node is archived by you; \`atlas\` look shows one, and nothing of them stands in the outline.`;
	const short = new Set();
	const oldestFirst = [...shown].sort((a, b) => String(a.written ?? "").localeCompare(String(b.written ?? "")));
	const render = () => {
		const lines = [];
		for (const [kind, heading] of HEADINGS) {
			const nodes = shown.filter((node) => node.kind === kind && !short.has(node.name)).sort((a, b) => a.name.localeCompare(b.name));
			if (nodes.length === 0) continue;
			lines.push(`${heading}:`);
			for (const node of nodes) lines.push(`  ${nodeLine(node)}`);
		}
		if (short.size > 0) lines.push(`By name only, to keep this short (\`atlas\` look shows one): ${[...short].sort().join(", ")}`);
		const archived = atlas.nodes.length - shown.length;
		if (archived > 0) lines.push(`(${archived} archived ${archived === 1 ? "node" : "nodes"} not shown)`);
		return lines.join("\n");
	};
	let text = render();
	for (const node of oldestFirst) {
		if (text.length <= max) break;
		short.add(node.name);
		text = render();
	}
	return text;
}

/** What a node says, in a few characters: two nodes with the same hash say the same. */
export function nodeHash(node) {
	return sha(JSON.stringify([node.kind ?? "", node.gist, node.detail ?? "", [...node.links].sort(), [...node.files].sort()])).slice(0, 12);
}

/** name -> hash, for telling later what was written or removed since. */
export const nodeHashes = (atlas) => Object.fromEntries(atlas.nodes.map((node) => [node.name, nodeHash(node)]));

/**
 * What differs between two sets of node hashes.
 * @returns {{ written: string[], removed: string[] }}
 */
export function nodeChanges(before, after) {
	return {
		written: Object.keys(after).filter((name) => before[name] !== after[name]),
		removed: Object.keys(before).filter((name) => after[name] === undefined),
	};
}

/** "12 nodes" with how many of each kind, for the user. */
export function atlasSummary(atlas) {
	if (atlas.nodes.length === 0) return "no nodes";
	return plural(atlas.nodes.length, "node");
}
