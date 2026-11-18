// The graph: what the agent has understood about the project, as nodes.
//
// A node is a name, one line that says what it is (the gist), optional longer
// detail, links to other nodes, and links to files or folders. It needs neither
// kind of link: the agent decides what deserves a node, and not every file needs
// one. What a node is — a part of the project, a finding, a dead end — is said
// by its name and gist, which are free text; there is no class to fill in.
// Together with the tree (src/tree.mjs) this is the atlas.
//
// One thing is checked by the program. When a node links to a file, the file's
// fingerprint is kept with the link. A file that changed or disappeared since
// marks the node as possibly out of date, until someone rewrites or confirms it.
//
// It lives in <project>/.brain/carto-atlas.json as plain JSON so the user can read
// and edit it; the file is read again every time it is needed.
import { POLICY } from "./config.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRAIN } from "./project.mjs";
import { ago, since } from "./time.mjs";
import { confine, LookError } from "./tools/look.mjs";
import { cleanAnchor, DEPTH_MAX, isFolder } from "./tree.mjs";
import { USER_NAME } from "./user.mjs";
import { clipNote, warn } from "./warnings.mjs";

export const NAME_MAX = POLICY.limits.atlas.nameChars;
export const GIST_MAX = POLICY.limits.atlas.gistChars;
export const DETAIL_MAX = POLICY.limits.atlas.detailChars;
export const NODES_MAX = POLICY.limits.atlas.nodes;
export const LINKS_MAX = POLICY.limits.atlas.links;
export const FILES_MAX = POLICY.limits.atlas.files;
/** Characters the outline at the top of the context may take; beyond that the oldest nodes are listed by name only. */
export const OUTLINE_MAX = POLICY.limits.atlas.outlineChars;
const BIG_FILE = POLICY.limits.atlas.bigFileBytes;
const ATTENTION = POLICY.limits.atlas.attention;

export class AtlasError extends Error {}
const ID_PATTERN = new RegExp(POLICY.patterns.atlasId);
/** The next id after the highest one in use. */
const nextNodeId = (nodes) => `c${nodes.reduce((max, node) => { const match = typeof node?.id === "string" ? ID_PATTERN.exec(node.id) : null; return match ? Math.max(max, Number(match[1])) : max; }, 0) + 1}`;
/** Give every node an id, once. Files written before ids existed are migrated the first time they are read or written. */
export function ensureNodeIds(atlas) {
	const taken = new Set();
	for (const node of atlas.nodes ?? []) {
		const id = typeof node.id === "string" ? node.id : "";
		if (ID_PATTERN.test(id) && !taken.has(id)) taken.add(id);
		else node.id = "";
	}
	let candidate = 1;
	for (const node of atlas.nodes ?? []) {
		if (node.id !== "") continue;
		while (taken.has(`c${candidate}`)) candidate += 1;
		node.id = `c${candidate}`;
		taken.add(node.id);
	}
	return atlas;
}

/** A ref points at this; the name is for humans and for links between nodes. */
export const findNode = (atlas, idOrName) => {
	const wanted = String(idOrName ?? "").trim();
	return atlas.nodes.find((node) => node.id === wanted) ?? atlas.nodes.find((node) => node.name === normName(wanted));
};

export const atlasPath = (brainDir) => join(brainDir, "carto-atlas.json");
const emptyAttention = () => ({ epoch: 0, nodes: {}, gaps: {} });
const empty = () => ({ version: 1, view: { anchor: "." }, attention: emptyAttention(), nodes: [] });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const flat = (text) => String(text).replace(/\s+/g, " ").trim();
const sha = (data) => createHash("sha1").update(data).digest("hex");
const nonnegativeInteger = (value, fallback = 0) => Number.isInteger(value) && value >= 0 ? value : fallback;
const dateText = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
const attentionKind = (value) => {
	const text = flat(value ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	return text === "" ? "work" : text.slice(0, 40);
};

/** The compact evidence an attention entry keeps. Scores are deliberately derived, never stored. */
function attentionSignal(value, epoch) {
	if (value === null || typeof value !== "object") return undefined;
	const at = dateText(value.at);
	const path = typeof value.path === "string" && value.path.trim() !== "" ? cleanAnchor(value.path) : undefined;
	const label = typeof value.label === "string" && flat(value.label) !== "" ? flat(value.label).slice(0, ATTENTION.focusReasonChars) : undefined;
	return {
		epoch: Math.min(epoch, nonnegativeInteger(value.epoch, epoch)),
		...(at === undefined ? {} : { at }),
		kind: attentionKind(value.kind),
		...(path === undefined ? {} : { path }),
		...(label === undefined ? {} : { label }),
	};
}

/** Keep attention bounded and tied to admitted atlas ids, even when a person edited the JSON by hand. */
function normalizedAttention(raw, nodes) {
	const source = raw !== null && typeof raw === "object" ? raw : {};
	const epoch = nonnegativeInteger(source.epoch);
	const ids = new Set(nodes.map((node) => node.id));
	const records = source.nodes !== null && typeof source.nodes === "object" && !Array.isArray(source.nodes) ? source.nodes : {};
	const nodeSignals = {};
	for (const [id, value] of Object.entries(records)) {
		if (!ids.has(id)) continue;
		const signal = attentionSignal(value, epoch);
		if (signal !== undefined) nodeSignals[id] = signal;
	}
	const rawGaps = source.gaps !== null && typeof source.gaps === "object" && !Array.isArray(source.gaps) ? source.gaps : {};
	const gaps = Object.entries(rawGaps)
		.map(([path, value]) => [cleanAnchor(path), attentionSignal(value, epoch)])
		.filter(([path, signal]) => path !== "" && signal !== undefined)
		.sort(([, a], [, b]) => b.epoch - a.epoch || String(b.at ?? "").localeCompare(String(a.at ?? "")))
		.slice(0, ATTENTION.gaps);
	return { epoch, nodes: nodeSignals, gaps: Object.fromEntries(gaps) };
}

/** The focus is a view fact: it names a stable node id or a project path, never prose guessed from a task. */
function normalizedFocus(raw, nodes) {
	if (raw === null || typeof raw !== "object") return undefined;
	const target = raw.target;
	const reason = typeof raw.reason === "string" ? flat(raw.reason).slice(0, ATTENTION.focusReasonChars) : "";
	const by = Object.values(POLICY.enums.atlasAuthors).includes(raw.by) ? raw.by : undefined;
	const at = dateText(raw.at);
	if (reason === "" || by === undefined || at === undefined || target === null || typeof target !== "object") return undefined;
	if (target.kind === "node") {
		const node = nodes.find((entry) => entry.id === target.id);
		if (node === undefined) return undefined;
		// Archive hides a node from the active map but does not silently clear a person's explicit lens.
		return { target: { kind: "node", id: node.id }, reason, by, at };
	}
	if (target.kind === "path" && typeof target.path === "string" && target.path.trim() !== "") {
		const path = cleanAnchor(target.path);
		if (path.startsWith("/") || path.split("/").includes("..") || /^(\.brain|\.atlas|\.git)(\/|$)/.test(path)) return undefined;
		return { target: { kind: "path", path }, reason, by, at };
	}
	return undefined;
}

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
		if (node.links !== undefined && !strings(node.links)) return { error: `${where} (${name}): "links" must be a list of node names` };
		if (node.files !== undefined && !strings(node.files)) return { error: `${where} (${name}): "files" must be a list of paths` };
		seen.add(name);
		delete node.kind; // a kind-era `kind` is not read nor kept
		nodes.push({
			...node,
			name,
			links: [...new Set((node.links ?? []).map(normName).filter((link) => link !== "" && link !== name))],
			files: [...new Set((node.files ?? []).map(cleanAnchor))],
			seen: node.seen !== null && typeof node.seen === "object" ? node.seen : {},
		});
	}
	// The ref system: every node carries a `c<N>` id. Files written before ids existed are given one here.
	ensureNodeIds({ nodes });
	const view = raw.view !== null && typeof raw.view === "object" ? raw.view : {};
	const { focus: rawFocus, anchor, depth, ...viewRest } = view;
	const focus = normalizedFocus(rawFocus, nodes);
	return {
		atlas: {
			...raw,
			version: 1,
			view: { ...viewRest, anchor: cleanAnchor(anchor), ...(Number.isInteger(depth) ? { depth } : {}), ...(focus === undefined ? {} : { focus }) },
			attention: normalizedAttention(raw.attention, nodes),
			nodes,
		},
	};
}

/** Write the atlas so that a reader never sees half a file. */
export function saveAtlas(brainDir, atlas) {
	ensureNodeIds(atlas);
	atlas.attention = normalizedAttention(atlas.attention, atlas.nodes);
	const view = atlas.view !== null && typeof atlas.view === "object" ? atlas.view : {};
	const { focus: rawFocus, anchor, depth, ...viewRest } = view;
	const focus = normalizedFocus(rawFocus, atlas.nodes);
	atlas.view = { ...viewRest, anchor: cleanAnchor(anchor), ...(Number.isInteger(depth) ? { depth } : {}), ...(focus === undefined ? {} : { focus }) };
	const path = atlasPath(brainDir);
	const temp = `${path}.${process.pid}.tmp`;
	// What a reader looks for first comes first.
	const nodes = atlas.nodes.map(({ id, name, gist, detail, links, files, ...rest }) => ({ id, name, gist, ...(detail ? { detail } : {}), links, files, ...rest }));
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
		if (node.archived === true) continue;
		const why = fileStates(root, node).flatMap((file) => (file.state === "gone" ? [`${file.path} is gone`] : file.state === "changed" ? [`${file.path} changed ${ago(now - file.changed)}`] : []));
		if (why.length > 0) stale.push({ name: node.name, why });
	}
	return stale;
}

/** For the tree: which nodes link to which path. */
export function fileMarks(atlas) {
	const marks = new Map();
	for (const node of atlas.nodes) {
		if (node.archived === true) continue;
		for (const path of node.files) marks.set(path, [...(marks.get(path) ?? []), node.name]);
	}
	return marks;
}

/** How many of `files` a node links to, directly or through a folder above them. */
export function linkedCount(atlas, files) {
	const linked = new Set(atlas.nodes.filter((node) => node.archived !== true).flatMap((node) => node.files));
	if (linked.has(".")) return files.length;
	return files.filter((path) => {
		if (linked.has(path)) return true;
		for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1)) if (linked.has(path.slice(0, cut))) return true;
		return false;
	}).length;
}

// ─── Attention ──────────────────────────────────────────────────────────────

/** Whether two project paths meet at a file, a folder, or the project root. */
const relatedPath = (left, right) => {
	const a = cleanAnchor(left);
	const b = cleanAnchor(right);
	return a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

/** The active, non-archived nodes whose file links cover `path`, directly or through a folder. */
export function nodesForPath(atlas, path) {
	const wanted = cleanAnchor(path);
	return atlas.nodes.filter((node) => node.archived !== true && node.files.some((file) => relatedPath(file, wanted)));
}

function ensureAttention(atlas) {
	ensureNodeIds(atlas);
	atlas.attention = normalizedAttention(atlas.attention, atlas.nodes);
	return atlas.attention;
}

const sourceText = (signal, age) => {
	const through = signal.path === undefined ? signal.kind.replaceAll("_", " ") : `${signal.kind.replaceAll("_", " ")} ${signal.path}`;
	if (age === 0) return `${through} this work epoch`;
	return `${through} ${age} work ${age === 1 ? "epoch" : "epochs"} ago`;
};

/**
 * Record one bounded batch of facts from the harness or an atlas operation. The atlas owns the epoch and the
 * path-to-node interpretation; callers never calculate heat. An observation has optional `paths`, `nodes`,
 * `kind`, and `label` fields. Its paths may be a file or a folder.
 */
export function observeAtlas(atlas, observations, { at = new Date().toISOString() } = {}) {
	const attention = ensureAttention(atlas);
	const time = dateText(at) ?? new Date().toISOString();
	const events = (Array.isArray(observations) ? observations : [observations])
		.filter((event) => event !== null && typeof event === "object")
		.map((event) => ({
			paths: [...new Set((Array.isArray(event.paths) ? event.paths : []).filter((path) => typeof path === "string" && path.trim() !== "").map(cleanAnchor))],
			nodes: [...new Set((Array.isArray(event.nodes) ? event.nodes : []).filter((node) => typeof node === "string" && node.trim() !== "").map((node) => node.trim()))],
			kind: attentionKind(event.kind),
			...(typeof event.label === "string" && flat(event.label) !== "" ? { label: flat(event.label).slice(0, ATTENTION.focusReasonChars) } : {}),
		}))
		.filter((event) => event.paths.length > 0 || event.nodes.length > 0);
	if (events.length === 0) return { changed: false, epoch: attention.epoch, nodes: [], gaps: [] };
	attention.epoch += 1;
	const epoch = attention.epoch;
	const touched = new Set();
	const gaps = new Set();
	const touch = (node, event, path) => {
		if (node === undefined || node.archived === true) return;
		attention.nodes[node.id] = { epoch, at: time, kind: event.kind, ...(path === undefined ? {} : { path }), ...(event.label === undefined ? {} : { label: event.label }) };
		touched.add(node.id);
	};
	for (const event of events) {
		for (const token of event.nodes) touch(findNode(atlas, token), event);
		for (const path of event.paths) {
			const mapped = nodesForPath(atlas, path);
				if (mapped.length === 0) {
					attention.gaps[path] = { epoch, at: time, kind: event.kind, path, ...(event.label === undefined ? {} : { label: event.label }) };
					gaps.add(path);
				} else {
					delete attention.gaps[path];
					for (const node of mapped) touch(node, event, path);
				}
		}
	}
	// A node written after a gap makes that gap resolved, even when it was linked to a broader folder.
	for (const path of Object.keys(attention.gaps)) if (nodesForPath(atlas, path).length > 0) delete attention.gaps[path];
	const keptGaps = Object.entries(attention.gaps)
		.sort(([, a], [, b]) => b.epoch - a.epoch || String(b.at ?? "").localeCompare(String(a.at ?? "")))
		.slice(0, ATTENTION.gaps);
	attention.gaps = Object.fromEntries(keptGaps);
	return { changed: true, epoch, nodes: [...touched], gaps: [...gaps] };
}

const activeEvents = (active) => (Array.isArray(active) ? active : active === undefined ? [] : [active])
	.filter((event) => event !== null && typeof event === "object")
	.map((event) => ({
		paths: [...new Set((Array.isArray(event.paths) ? event.paths : []).filter((path) => typeof path === "string" && path.trim() !== "").map(cleanAnchor))],
		nodes: [...new Set((Array.isArray(event.nodes) ? event.nodes : []).filter((node) => typeof node === "string" && node.trim() !== "").map((node) => node.trim()))],
		kind: attentionKind(event.kind),
		label: typeof event.label === "string" && flat(event.label) !== "" ? flat(event.label).slice(0, ATTENTION.focusReasonChars) : undefined,
	}))
	.filter((event) => event.paths.length > 0 || event.nodes.length > 0);

/** A running declared move is a live overlay, not durable focus. Its targets remain exact project paths. */
export function activeMoveOverlays(plan) {
	const moves = Array.isArray(plan?.moves) ? plan.moves : [];
	return moves
		.filter((move) => move?.status === POLICY.enums.moveStatus.running && move.archived !== true && Array.isArray(move.targets) && move.targets.length > 0)
		.map((move) => ({
			kind: "move",
			paths: move.targets,
			label: `${move.id} targets ${move.targets.join(", ")}`,
		}));
}

const appendReason = (map, key, reason) => {
	const list = map.get(key) ?? [];
	if (!list.includes(reason)) list.push(reason);
	map.set(key, list);
};

const entriesOf = (atlas, reasons, except = new Set()) => [...reasons]
	.filter(([id]) => !except.has(id))
	.map(([id, why]) => ({ node: atlas.nodes.find((node) => node.id === id), why }))
	.filter((entry) => entry.node !== undefined)
	.sort((a, b) => a.node.name.localeCompare(b.node.name));

/**
 * The one local, explainable attention map used by the state block, terminal and screen. `active` is a temporary
 * task overlay; it never writes over `view.focus`. `idle` only changes how callers render the candidate queue.
 */
export function attentionSnapshot(root, atlas, { active, now = Date.now() } = {}) {
	const attention = ensureAttention(atlas);
	const nodes = atlas.nodes.filter((node) => node.archived !== true);
	const direct = new Map();
	const warm = new Map();
	const nearby = new Map();
	const gaps = new Map();
	const activeLabels = [];
	const addNode = (node, reason) => {
		if (node !== undefined && node.archived !== true) appendReason(direct, node.id, reason);
	};
	const addPath = (path, reason) => {
		const mapped = nodesForPath(atlas, path);
		if (mapped.length === 0) appendReason(gaps, cleanAnchor(path), reason);
		else for (const node of mapped) addNode(node, reason);
	};
	const focus = atlas.view?.focus;
	if (focus?.target?.kind === "node") {
		const node = atlas.nodes.find((entry) => entry.id === focus.target.id && entry.archived !== true);
		if (node !== undefined) addNode(node, `focus: ${focus.reason}`);
	} else if (focus?.target?.kind === "path") addPath(focus.target.path, `focus: ${focus.reason}`);
	for (const event of activeEvents(active)) {
		const label = event.label ?? event.kind.replaceAll("_", " ");
		if (!activeLabels.includes(label)) activeLabels.push(label);
		for (const token of event.nodes) addNode(findNode(atlas, token), label);
		for (const path of event.paths) addPath(path, label);
	}
	for (const node of nodes) {
		const signal = attention.nodes[node.id];
		if (signal === undefined) continue;
		const age = Math.max(0, attention.epoch - signal.epoch);
		const reason = sourceText(signal, age);
		if (age <= ATTENTION.hotEpochs) appendReason(direct, node.id, reason);
		else if (age <= ATTENTION.warmEpochs) appendReason(warm, node.id, reason);
	}
	for (const [path, signal] of Object.entries(attention.gaps)) {
		if (nodesForPath(atlas, path).length > 0) continue;
		// A path with no node is a mapping debt, not an ordinary heat score. It stays visible until a later
		// observation finds an existing node that covers it (or bounded gap retention displaces it).
		const age = Math.max(0, attention.epoch - signal.epoch);
		appendReason(gaps, path, sourceText(signal, age));
	}
	const directIds = new Set(direct.keys());
	for (const node of nodes) {
		if (!directIds.has(node.id)) continue;
		for (const other of nodes) {
			if (other.id === node.id || (!node.links.includes(other.name) && !other.links.includes(node.name))) continue;
			appendReason(nearby, other.id, `linked to ${node.name}`);
		}
	}
	const care = new Map();
	if (root !== undefined) {
		for (const stale of staleNodes(root, atlas, now)) {
			const node = atlas.nodes.find((entry) => entry.name === stale.name);
			if (node !== undefined) care.set(node.id, [...stale.why]);
		}
		// A hand-written link with no saved fingerprint has not been verified by Cartographer yet. This is a
		// distinct check signal: it does not make an old node cold or change what the node claims.
		for (const node of nodes) {
			const unchecked = node.files.filter((path) => node.seen?.[path] === undefined && fingerprint(root, path) !== undefined);
			if (unchecked.length > 0) care.set(node.id, [...(care.get(node.id) ?? []), `verification needed for ${unchecked.join(", ")}`]);
		}
	}
	const knownNames = new Set(nodes.map((node) => node.name));
	for (const node of nodes) {
		const missing = node.links.filter((link) => !knownNames.has(link));
		if (missing.length > 0) care.set(node.id, [...(care.get(node.id) ?? []), `links to missing ${missing.join(", ")}`]);
	}
	const nearbyOrWarm = new Map();
	for (const [id, reasons] of nearby) nearbyOrWarm.set(id, [...reasons, ...(warm.get(id) ?? [])]);
	for (const [id, reasons] of warm) if (!nearbyOrWarm.has(id)) nearbyOrWarm.set(id, [...reasons]);
	// Heat and checking pressure are independent facts. A hot node may need checking too; neither condition hides
	// the other or turns ordinary recency into a claim that its structural record is false.
	const hot = entriesOf(atlas, direct);
	const warmEntries = entriesOf(atlas, nearbyOrWarm, directIds);
	const careEntries = entriesOf(atlas, care);
	const liveIds = new Set([...direct.keys(), ...warm.keys(), ...nearby.keys(), ...care.keys()]);
	const inbound = new Map(nodes.map((node) => [node.id, nodes.filter((other) => other.links.includes(node.name)).length]));
	const candidates = nodes
		.filter((node) => {
			if (liveIds.has(node.id)) return false;
			const signal = attention.nodes[node.id];
			const age = Math.max(0, attention.epoch - (signal?.epoch ?? 0));
			return attention.epoch >= ATTENTION.candidateEpochs && age >= ATTENTION.candidateEpochs && (inbound.get(node.id) ?? 0) === 0 && node.links.length <= 1;
		})
		.map((node) => {
			const signal = attention.nodes[node.id];
			const age = Math.max(0, attention.epoch - (signal?.epoch ?? 0));
			const reasons = [signal === undefined ? `no attention recorded in ${attention.epoch} work epochs` : `cold for ${age} work epochs since ${sourceText(signal, age)}`, "no node links to it", ...(node.links.length === 0 ? ["no outgoing graph link"] : [`${node.links.length} outgoing graph link`])];
			return { node, age, reasons };
		})
		.sort((a, b) => b.age - a.age || a.node.name.localeCompare(b.node.name));
	const shown = (entries) => entries.slice(0, ATTENTION.listed);
	return {
		epoch: attention.epoch,
		focus: focus === undefined ? undefined : {
			...focus,
			label: focus.target.kind === "node" ? atlas.nodes.find((node) => node.id === focus.target.id)?.name ?? focus.target.id : focus.target.path,
			...(focus.target.kind === "node" && atlas.nodes.find((node) => node.id === focus.target.id)?.archived === true ? { archived: true } : {}),
		},
		active: activeLabels,
		hot: shown(hot),
		warm: shown(warmEntries),
		care: shown(careEntries),
		gaps: [...gaps].map(([path, why]) => ({ path, why })).sort((a, b) => a.path.localeCompare(b.path)).slice(0, ATTENTION.listed),
		candidates: candidates.slice(0, ATTENTION.candidates),
		candidateCount: candidates.length,
	};
}

const attentionNodeLine = ({ node, why }) => `${node.id}  ${node.name}  ${node.gist}${why.length > 0 ? `  (${why.join("; ")})` : ""}`;

/** The shared text projection. It names why a row is here; the screen styles these same objects separately. */
export function renderAttention(snapshot, { idle = false } = {}) {
	const lines = [];
	if (snapshot.focus !== undefined) lines.push(`Focus: ${snapshot.focus.label}${snapshot.focus.archived ? " (archived; restore it to make it active)" : ""} — set by ${snapshot.focus.by === POLICY.enums.atlasAuthors.main ? "Cartographer" : snapshot.focus.by === POLICY.enums.atlasAuthors.task ? "a focus" : USER_NAME}: ${snapshot.focus.reason}`);
	if (snapshot.active.length > 0) lines.push(`Active work: ${snapshot.active.join("; ")}.`);
	const section = (title, entries, line = attentionNodeLine) => {
		if (entries.length === 0) return;
		lines.push(title);
		for (const entry of entries) lines.push(`  ${line(entry)}`);
	};
	section("Hot now", snapshot.hot);
	section("Nearby", snapshot.warm);
	section("Mapping gaps", snapshot.gaps, (gap) => `${gap.path}  ${gap.why.join("; ")} · no atlas node links this path`);
	section("Needs checking", snapshot.care);
	if (snapshot.candidateCount > 0) {
		if (!idle) lines.push(`Cold candidates: ${snapshot.candidateCount} held for Atlas maintenance after active work.`);
		else {
			lines.push(`Cold candidates: ${snapshot.candidateCount}`);
			for (const candidate of snapshot.candidates) lines.push(`  ${candidate.node.id}  ${candidate.node.name}  ${candidate.node.gist}  (${candidate.reasons.join("; ")})`);
		}
	}
	return lines.join("\n");
}

/** A short status line for places where the full local map would be too much. */
export function attentionSummary(snapshot) {
	const parts = [];
	if (snapshot.focus !== undefined) parts.push(`focus ${snapshot.focus.label}`);
	if (snapshot.hot.length > 0) parts.push(`${snapshot.hot.length} hot`);
	if (snapshot.care.length > 0) parts.push(`${snapshot.care.length} need checking`);
	if (snapshot.gaps.length > 0) parts.push(`${snapshot.gaps.length} mapping ${snapshot.gaps.length === 1 ? "gap" : "gaps"}`);
	if (snapshot.candidateCount > 0) parts.push(`${snapshot.candidateCount} cold ${snapshot.candidateCount === 1 ? "candidate" : "candidates"}`);
	return parts.join(" · ");
}

// ─── Operations ─────────────────────────────────────────────────────────────

function find(atlas, given) {
	const wanted = String(given ?? "").trim();
	const node = findNode(atlas, wanted);
	if (node === undefined) {
		const listedNodes = atlas.nodes.map((entry) => `${entry.id} ${entry.name}`);
		const listed = listedNodes.length === 0 ? "The graph has no nodes yet." : `Nodes: ${listedNodes.slice(0, POLICY.limits.atlas.listedNodes).join(", ")}${listedNodes.length > POLICY.limits.atlas.listedNodes ? `, and ${listedNodes.length - POLICY.limits.atlas.listedNodes} more` : ""}.`;
		throw new AtlasError(`There is no node ${wanted || "(no name given)"}. ${listed}`);
	}
	return node;
}

function checkedGist(value) {
	if (typeof value !== "string" || value.trim() === "") throw new AtlasError("`gist` (one line that says what this is) is required and was left out or empty.");
	const text = flat(value);
	if (text.length > GIST_MAX) {
		const clipped = `${text.slice(0, GIST_MAX - 1).trimEnd()}…`;
		warn(clipNote("`gist`", text, clipped, GIST_MAX, { extra: "Put the rest into `detail` if you still want it kept.", remedy: "the edit action for the node (`book` atlas edit)" }));
		return clipped;
	}
	return text;
}

function checkedFocusReason(value) {
	if (typeof value !== "string" || value.trim() === "") throw new AtlasError("`reason` is required: say why this node or path is the current focus.");
	const text = flat(value);
	if (text.length <= ATTENTION.focusReasonChars) return text;
	const clipped = `${text.slice(0, ATTENTION.focusReasonChars - 1).trimEnd()}…`;
	warn(clipNote("`reason`", text, clipped, ATTENTION.focusReasonChars, { remedy: "atlas focus" }));
	return clipped;
}

const authorOf = (who) => Object.values(POLICY.enums.atlasAuthors).includes(who?.by)
	? who.by
	: who?.main === true
		? POLICY.enums.atlasAuthors.main
		: POLICY.enums.atlasAuthors.user;

/**
 * Paths the agent gave, as project paths that exist. Callers may opt in to creating a missing empty path, but the
 * public book path keeps that off: project files are created only through a declared move's file action. `created`
 * remains for controlled internal callers that can prove their own authority.
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
			if (rel === "" || /^(\.brain|\.atlas|\.git)(\/|$)/.test(rel)) throw new AtlasError(`\`files\`: there is no file or folder ${rel} in the project, and none can be made there.`);
			if (!mayCreate) throw new AtlasError(`\`files\`: there is no file or folder ${rel} in the project. Check the path against the tree. A node needs no file: create it through a declared move's file action first, then link it.`);
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

function checkedLinks(given, own, atlas) {
	if (given === undefined || given === null) return [];
	if (!Array.isArray(given)) throw new AtlasError("`links` is a list of node names or ids.");
	// A link may be written as the node it points at, by its id or by its name; the graph stores names.
	const canonical = (token) => {
		const text = String(token ?? "").trim();
		return atlas?.nodes.find((entry) => entry.id === text)?.name ?? normName(text);
	};
	return [...new Set(given.map(canonical).filter((name) => name !== "" && name !== own))];
}

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
	const lines = [`${node.id}  ${node.name} (node)${age === undefined ? "" : ` · written ${ago(age)}`}${node.by ? ` by ${node.by === POLICY.enums.atlasAuthors.task ? "a task" : node.by === POLICY.enums.atlasAuthors.main ? "the main agent" : `${USER_NAME}`}` : ""}`, node.gist];
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
	return `${node.id}  ${node.name}  ${node.gist}${files}${links}${node.detail ? "  (+detail)" : ""}`;
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
	const author = authorOf(who);
	ensureNodeIds(atlas);
	ensureAttention(atlas);
	const attend = (events) => observeAtlas(atlas, events, { at: now });
	switch (op?.action) {
		case POLICY.enums.atlasActions.add:
		case POLICY.enums.atlasActions.edit: {
			const byId = findNode(atlas, op.name);
			let name = byId?.name ?? normName(op.name);
			if (name === "") throw new AtlasError("`name` is required: a short name for the node, such as dice_roll.");
			if (name.length > NAME_MAX) {
				const original = name;
				name = name.slice(0, NAME_MAX);
				warn(clipNote("The name of the node", original, name, NAME_MAX, { remedy: "the rename action for the node (`book` atlas rename)" }));
			}
			const gist = checkedGist(op.gist);
			let detail;
			if (op.detail !== undefined && op.detail !== null) {
				detail = String(op.detail).trim();
				if (detail.length > DETAIL_MAX) {
					const clipped = `${detail.slice(0, DETAIL_MAX - 1).trimEnd()}…`;
					warn(clipNote("`detail`", detail, clipped, DETAIL_MAX, { extra: "Split it over two nodes if you still want it kept.", remedy: "the edit action for the node (`book` atlas edit)" }));
					detail = clipped;
				}
			}
			const files = checkedFiles(root, op.files, who.created, who.mayCreate === true);
			const links = checkedLinks(op.links, name, atlas);
			let node = atlas.nodes.find((entry) => entry.name === name);
			const fresh = node === undefined;
			if (op.action === POLICY.enums.atlasActions.add && !fresh) throw new AtlasError(`There is a node ${name} already; \`edit\` rewrites it.`);
			if (op.action === POLICY.enums.atlasActions.edit && fresh) throw new AtlasError(`There is no node ${name} to edit; \`add\` writes a new one.`);
			if (fresh) {
				if (atlas.nodes.length >= NODES_MAX) throw new AtlasError(`The graph has ${NODES_MAX} nodes, which is its limit. Remove nodes that no longer matter, or fold several into one.`);
				node = { id: nextNodeId(atlas.nodes), name, gist, links: [], files: [], seen: {} };
			}
			const allFiles = [...new Set([...node.files, ...files])];
			const allLinks = [...new Set([...node.links, ...links])];
			if (allFiles.length > FILES_MAX) throw new AtlasError(`That would give ${name} ${allFiles.length} file links; the limit is ${FILES_MAX}. Link the folder, or split the node.`);
			if (allLinks.length > LINKS_MAX) throw new AtlasError(`That would give ${name} ${allLinks.length} links; the limit is ${LINKS_MAX}.`);
			node.gist = gist;
			if (detail !== undefined) {
				if (detail === "") delete node.detail;
				else node.detail = detail;
			}
			node.files = allFiles;
			node.links = allLinks;
			// Whoever writes a node says it is true now, of the files as they are now.
			stampFiles(root, node);
			node.written = now;
			node.by = author;
			if (fresh) atlas.nodes.push(node);
			attend([{ kind: "atlas", nodes: [node.id], label: fresh ? "wrote atlas node" : "rewrote atlas node" }]);
			const missing = missingLinks(atlas, node);
			return {
				...unmet(`${node.id} ${name} ${fresh ? "written" : "rewritten"}.`, missing, (names) => ` It links to ${names.join(", ")}, which ${names.length === 1 ? "is not a node" : "are not nodes"} yet.`),
				shown: `${fresh ? "+" : "~"} ${nodeLine(node)}`,
				changed: true,
			};
		}
		case POLICY.enums.atlasActions.link:
		case POLICY.enums.atlasActions.unlink: {
			const node = find(atlas, op.name);
			const files = op.action === POLICY.enums.atlasActions.link ? checkedFiles(root, op.files, who.created, who.mayCreate === true) : (Array.isArray(op.files) ? op.files : []).map(cleanAnchor);
			const links = checkedLinks(op.links, node.name, atlas);
			if (files.length === 0 && links.length === 0) throw new AtlasError(`\`${op.action}\` needs \`links\` (node names), \`files\` (paths), or both.`);
			if (op.action === POLICY.enums.atlasActions.link) {
				const allFiles = [...new Set([...node.files, ...files])];
				const allLinks = [...new Set([...node.links, ...links])];
				if (allFiles.length > FILES_MAX) throw new AtlasError(`That would give ${node.name} ${allFiles.length} file links; the limit is ${FILES_MAX}. Link the folder, or split the node.`);
				if (allLinks.length > LINKS_MAX) throw new AtlasError(`That would give ${node.name} ${allLinks.length} links; the limit is ${LINKS_MAX}.`);
				const added = files.filter((path) => !node.files.includes(path));
				node.files = allFiles;
				node.links = allLinks;
				stampFiles(root, node, added);
				const missing = missingLinks(atlas, node).filter((link) => links.includes(link));
				attend([{ kind: "atlas", nodes: [node.id, ...links], paths: files, label: "linked atlas node" }]);
				return {
					...unmet(`${node.id} ${node.name} linked to ${[...links, ...files].join(", ")}.`, missing, (names) => ` ${names.join(", ")} ${names.length === 1 ? "is not a node" : "are not nodes"} yet.`),
					shown: `~ ${nodeLine(node)}`,
					changed: true,
				};
			}
			const had = [...links.filter((link) => node.links.includes(link)), ...files.filter((path) => node.files.includes(path))];
			if (had.length === 0) throw new AtlasError(`${node.name} has none of these links. Its links: ${[...node.links, ...node.files].join(", ") || "none"}.`);
			node.links = node.links.filter((link) => !links.includes(link));
			node.files = node.files.filter((path) => !files.includes(path));
			stampFiles(root, node, []);
			attend([{ kind: "atlas", nodes: [node.id], label: "unlinked atlas node" }]);
			return { line: `${node.id} ${node.name} no longer links to ${had.join(", ")}.`, shown: `~ node ${nodeLine(node)}`, changed: true };
		}
		case POLICY.enums.atlasActions.confirm: {
			const given = Array.isArray(op.names) ? op.names : op.name !== undefined ? [op.name] : [];
			if (given.length === 0) throw new AtlasError("`names` is required: the nodes I checked and found still true.");
			const lines = [];
			const done = [];
			for (const each of given) {
				const node = findNode(atlas, each);
				if (node === undefined) {
					lines.push(`There is no node ${String(each ?? "").trim() || "(no name given)"}.`);
					continue;
				}
				const name = node.name;
				const gone = fileStates(root, node).filter((file) => file.state === "gone").map((file) => file.path);
				stampFiles(root, node);
				done.push(name);
				lines.push(gone.length > 0 ? `${node.id} ${name} confirmed, but ${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} gone: unlink ${gone.length === 1 ? "it" : "them"}, or link what replaced ${gone.length === 1 ? "it" : "them"}.` : `${node.id} ${name} confirmed.`);
			}
			if (done.length === 0) throw new AtlasError(lines.join(" "));
			attend([{ kind: "confirm", nodes: done, label: "confirmed atlas node" }]);
			return { line: lines.join(" "), shown: `✓ confirmed ${done.join(", ")}`, changed: true };
		}
		case POLICY.enums.atlasActions.rename: {
			const existing = findNode(atlas, op.name);
			const from = existing?.name ?? normName(op.name);
			let to = normName(op.to);
			if (from === "") throw new AtlasError("`name` is the node as it is.");
			if (to === "") throw new AtlasError("`to` is the name the node should have: lowercase letters, digits and underscores.");
			if (to.length > NAME_MAX) {
				const original = to;
				to = to.slice(0, NAME_MAX);
				warn(clipNote("`to` (the name the node should have)", original, to, NAME_MAX, { remedy: "the rename action for the node (`book` atlas rename)" }));
			}
			if (from === to) return { line: `${from} is its name already.`, changed: false };
			if (atlas.nodes.some((entry) => entry.name === to)) throw new AtlasError(`There is a node ${to} already; pick another name.`);
			const node = find(atlas, from);
			node.name = to;
			// Links are names: what pointed at the old name points at the new one now.
			for (const other of atlas.nodes) other.links = other.links.map((link) => (link === from ? to : link));
			attend([{ kind: "atlas", nodes: [node.id], label: "renamed atlas node" }]);
			return { line: `${node.id} ${from} is ${to} now; what links to it was rewritten to match.`, shown: `~ node ${nodeLine(node)}`, changed: true };
		}
		case POLICY.enums.atlasActions.remove: {
			const node = find(atlas, op.name);
			if (atlas.view?.focus?.target?.kind === "node" && atlas.view.focus.target.id === node.id) {
				throw new AtlasError(`${node.id} ${node.name} is the explicit focus. Replace or clear that focus before removing the node.`);
			}
			atlas.nodes.splice(atlas.nodes.indexOf(node), 1);
			delete atlas.attention.nodes[node.id];
			let dropped = 0;
			for (const other of atlas.nodes) {
				if (!other.links.includes(node.name)) continue;
				other.links = other.links.filter((link) => link !== node.name);
				dropped++;
			}
			return { line: `${node.id} ${node.name} removed.${dropped > 0 ? ` ${plural(dropped, "link")} to it went with it.` : ""}`, shown: `- ${node.name}  ${node.gist}`, changed: true };
		}
		case POLICY.enums.atlasActions.archive: {
			const node = find(atlas, op.name);
			if (node.archived === true) return { line: `${node.id} ${node.name} is archived already.`, changed: false };
			node.archived = true;
			delete atlas.attention.nodes[node.id];
			const focused = atlas.view?.focus?.target?.kind === "node" && atlas.view.focus.target.id === node.id;
			return { line: `${node.id} ${node.name} archived: it leaves the active map and stays in the atlas file.${focused ? " Its explicit focus lens remains and will become active again when it is restored." : " Restore it when it matters again."}`, shown: `v archived ${node.name}`, changed: true };
		}
		case POLICY.enums.atlasActions.restore: {
			const node = find(atlas, op.name);
			if (node.archived !== true) return { line: `${node.id} ${node.name} is already in the active map.`, changed: false };
			delete node.archived;
			attend([{ kind: "restore", nodes: [node.id], label: "restored atlas node" }]);
			return { line: `${node.id} ${node.name} is back in the active map.`, shown: `v restored ${node.name}`, changed: true };
		}
		case POLICY.enums.atlasActions.focus: {
			const reason = checkedFocusReason(op.reason);
			if ((op.name === undefined || op.name === null || String(op.name).trim() === "") === (op.path === undefined || op.path === null || String(op.path).trim() === "")) {
				throw new AtlasError("`focus` needs exactly one node `id`/`name` or one project `path`.");
			}
			const view = { ...atlas.view };
			const previous = view.focus?.target?.kind === "node"
				? atlas.nodes.find((entry) => entry.id === view.focus.target.id)?.name ?? view.focus.target.id
				: view.focus?.target?.kind === "path" ? view.focus.target.path : undefined;
			const focusedLine = (label) => previous === undefined ? `Focus is ${label}: ${reason}.` : `Focus changed from ${previous} to ${label}: ${reason}.`;
			if (op.name !== undefined && op.name !== null && String(op.name).trim() !== "") {
				const node = find(atlas, op.name);
				if (node.archived === true) throw new AtlasError(`${node.id} ${node.name} is archived. Restore it before focusing it.`);
				view.focus = { target: { kind: "node", id: node.id }, reason, by: author, at: dateText(now) ?? new Date().toISOString() };
				atlas.view = view;
				attend([{ kind: "focus", nodes: [node.id], label: reason }]);
				return { line: focusedLine(`${node.id} ${node.name}`), shown: `focus ${node.name}`, changed: true };
			}
			let path;
			try { path = confine(root, op.path).rel; }
			catch (error) {
				if (!(error instanceof LookError)) throw error;
				throw new AtlasError(`\`path\`: ${error.message}.`);
			}
			if (!existsSync(join(root, path)) || /^(\.brain|\.atlas|\.git)(\/|$)/.test(path)) throw new AtlasError(`\`path\`: ${path} is not a project file or folder I can focus.`);
			view.focus = { target: { kind: "path", path }, reason, by: author, at: dateText(now) ?? new Date().toISOString() };
			atlas.view = view;
			attend([{ kind: "focus", paths: [path], label: reason }]);
			return { line: focusedLine(path), shown: `focus ${path}`, changed: true };
		}
		case POLICY.enums.atlasActions.unfocus: {
			if (atlas.view?.focus === undefined) return { line: "The atlas has no explicit focus.", changed: false };
			delete atlas.view.focus;
			return { line: "The explicit atlas focus is cleared; live task targets still make their own temporary overlay.", shown: "focus cleared", changed: true };
		}
		case POLICY.enums.atlasActions.look: {
			const node = findNode(atlas, op.name);
			if (node !== undefined) {
				if (node.archived !== true) attend([{ kind: "atlas_look", nodes: [node.id], label: "looked at atlas node" }]);
				return { line: renderNode(root, atlas, node, Date.parse(now)), changed: node.archived !== true };
			}
			// Not a node: perhaps a path. Then the nodes that link to it, or to a folder above it.
			let rel;
			try {
				rel = typeof op.name === "string" && existsSync(confine(root, op.name).abs) ? confine(root, op.name).rel : undefined;
			} catch {
				rel = undefined;
			}
			if (rel === undefined) find(atlas, op.name);
			const about = atlas.nodes.filter((entry) => entry.archived !== true && entry.files.some((path) => path === rel || path === "." || rel.startsWith(`${path}/`)));
			attend([{ kind: "atlas_look", paths: [rel], label: "looked at atlas path" }]);
			if (about.length === 0) return { line: `No node links to ${rel}.`, changed: true };
			return { line: [`Nodes that link to ${rel}, or to a folder above it:`, ...about.map((entry) => `  ${nodeLine(entry)}`)].join("\n"), changed: true };
		}
		case POLICY.enums.atlasActions.tree: {
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
			throw new AtlasError(`Unknown action ${JSON.stringify(op?.action)}; the actions are add, edit, link, unlink, confirm, rename, focus, unfocus, archive, restore, remove, look, tree.`);
	}
}

// ─── What is shown ──────────────────────────────────────────────────────────

/**
 * Every node on one line, alphabetical. When that is longer than `max` characters, the nodes written longest ago
 * are listed by name only.
 */
export function renderOutline(atlas, max = OUTLINE_MAX) {
	if (atlas.nodes.length === 0) return "The graph has no nodes yet.";
	const shown = atlas.nodes.filter((node) => node.archived !== true);
	if (shown.length === 0) return `Every node is archived; \`book\` (target=atlas, action=look) shows one, and nothing of them stands in the outline.`;
	const short = new Set();
	const oldestFirst = [...shown].sort((a, b) => String(a.written ?? "").localeCompare(String(b.written ?? "")));
	const render = () => {
		const lines = [];
		const nodes = shown.filter((node) => !short.has(node.name)).sort((a, b) => a.name.localeCompare(b.name));
		for (const node of nodes) lines.push(`  ${nodeLine(node)}`);
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

/** What a node says structurally, in a few characters: attention and focus stay out so the frozen top copy stays cache-friendly. */
export function nodeHash(node) {
	return sha(JSON.stringify([node.gist, node.detail ?? "", [...node.links].sort(), [...node.files].sort(), node.archived === true])).slice(0, 12);
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

/** "12 nodes", for the user. */
export function atlasSummary(atlas) {
	if (atlas.nodes.length === 0) return "no nodes";
	return plural(atlas.nodes.length, "node");
}
