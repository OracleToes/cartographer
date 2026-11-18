// One-way C5 archival migration for products that no longer exist at runtime.
//
// This is intentionally not a compatibility reader. It runs only while upgrading a
// brain that still has the retired storyteller or Case stores, copies their exact
// bytes into a static archive, converts story shelf placements into inert snapshots,
// and removes the live stores. The resulting archive is never a tool, a shelf resolver,
// or conference input.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LEGACY_CUTOVER_VERSION = 1;
// Every status other than an explicit terminal outcome is treated as resumable. This deliberately includes
// hand-edited, unknown, ready, and needs-user-input records rather than orphaning evidence.
const terminalCaseStatuses = new Set(["synthesized", "stopped"]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeName = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
const archiveRoot = (brainDir) => join(brainDir, "legacy");
const manifestPath = (brainDir) => join(archiveRoot(brainDir), "cutover-v1.json");
const rawPath = (brainDir, kind, name) => join(archiveRoot(brainDir), "raw", kind, name);
const exportPath = (brainDir, kind, name) => join(archiveRoot(brainDir), "exports", kind, `${name}.md`);
const storyDir = (brainDir) => join(brainDir, "storyteller");
const casesDir = (brainDir) => join(brainDir, "cases");
const contextPath = (brainDir) => join(brainDir, "carto-context.json");

export class LegacyCutoverError extends Error {}
export class LegacyCutoverBlockedError extends LegacyCutoverError {
	constructor(active) {
		const named = active.map((entry) => entry.id ?? entry.path).join(", ");
		super(`C5 cutover is blocked by active or resumable legacy Case material: ${named}. Start the pre-C5 release, explicitly stop each Case, repair any unreadable or malformed record, and then rerun Cartographer to archive terminal records. C5 will not retire unfinished or unclassifiable Case material by flag or automatic conversion.`);
		this.active = active;
	}
}

const atomicWrite = (path, data) => {
	mkdirSync(join(path, ".."), { recursive: true });
	const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	writeFileSync(temporary, data);
	renameSync(temporary, path);
};

const safeDirectoryFiles = (dir, suffix, label) => {
	if (!existsSync(dir)) return [];
	let entries;
	try {
		if (!lstatSync(dir).isDirectory()) throw new LegacyCutoverError(`${label} path ${dir} is not a directory.`);
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if (error instanceof LegacyCutoverError) throw error;
		throw new LegacyCutoverError(`Could not inventory ${label}: ${error.message}`);
	}
	const files = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isFile() || !entry.name.endsWith(suffix) || !safeName(entry.name)) {
			throw new LegacyCutoverError(`${label} contains unsupported entry ${JSON.stringify(entry.name)}. The cutover refuses to guess which bytes are safe to remove.`);
		}
		let raw;
		try {
			raw = readFileSync(join(dir, entry.name));
		} catch (error) {
			throw new LegacyCutoverError(`Could not read ${label} entry ${JSON.stringify(entry.name)}: ${error.message}`);
		}
		files.push({ name: entry.name, id: entry.name.slice(0, -suffix.length), raw, digest: sha256(raw) });
	}
	return files;
};

const readManifest = (brainDir) => {
	const path = manifestPath(brainDir);
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (value?.version !== LEGACY_CUTOVER_VERSION || value?.kind !== "cartographer-legacy-cutover") {
			throw new Error(`expected cutover version ${LEGACY_CUTOVER_VERSION}`);
		}
		return value;
	} catch (error) {
		throw new LegacyCutoverError(`The existing C5 archive manifest cannot be read: ${error.message}`);
	}
};

const parseCaseState = (entry) => {
	try {
		const value = JSON.parse(entry.raw.toString("utf8"));
		// This deliberately validates only the small terminal envelope needed for cutover, not the removed Case
		// runtime schema. A hand-edited JSON blob that merely claims `status: "stopped"` must not make C5 discard
		// potentially resumable work. The filename and durable record identity have to agree.
		if (value === null || typeof value !== "object" || Array.isArray(value) || !/^c\d+$/.test(entry.id) || value.id !== entry.id || typeof value.status !== "string") {
			return { status: "malformed", active: true };
		}
		return { status: value.status, active: !terminalCaseStatuses.has(value.status) };
	} catch {
		// An unreadable record may be a resumable or important record. Refuse destructive cutover unless the user
		// explicitly stops it through the pre-C5 runtime instead of assuming it was already terminal.
		return { status: "unreadable", active: true };
	}
};

const readContextSource = (brainDir, required) => {
	const path = contextPath(brainDir);
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path);
		const value = JSON.parse(raw.toString("utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("it is not an object");
		return { name: "carto-context.json", raw, digest: sha256(raw), value };
	} catch (error) {
		if (!required) return undefined;
		throw new LegacyCutoverError(`The context store must be repaired before storyteller shelf placements can be migrated: ${error.message}`);
	}
};

const referenceType = (value) => typeof value?.type === "string" ? value.type : typeof value?.kind === "string" ? value.kind : undefined;
const legacyStoryId = (value) => typeof value === "string" && /^st(?:\d+|-\d{8}-\d{6}-[a-z0-9]{4})$/.test(value) ? value : undefined;
const storyIdOf = (item) => {
	if (referenceType(item?.ref) === "story" && typeof item.ref.id === "string") return item.ref.id;
	if (referenceType(item?.target) === "story" && typeof item.target.id === "string") return item.target.id;
	const legacyPath = /^story:(.+)$/.exec(typeof item?.path === "string" ? item.path : "");
	return legacyPath === null ? undefined : legacyStoryId(legacyPath[1]);
};
const hasStoryTarget = (item) => referenceType(item?.target) === "story";

/** Every persisted shelf scope that may still contain a live storyteller reference. */
function shelfScopes(context) {
	const found = [];
	const direct = (name, items) => {
		if (Array.isArray(items)) found.push({ name, items, replace: (index, value) => { items[index] = value; } });
	};
	direct("main shelf", context?.shelf);
	direct("front shelf", context?.front?.shelf);
	for (const [conversationId, task] of Object.entries(context?.tasks ?? {})) {
		direct(`focus shelf ${conversationId}`, task?.shelf);
		if (Array.isArray(task?.evidence)) {
			const items = task.evidence.map((entry) => entry?.item);
			found.push({
				name: `focus evidence ${conversationId}`,
				items,
				replace: (index, value) => { task.evidence[index] = { ...task.evidence[index], item: value }; },
			});
		}
	}
	return found;
}

const legacyContextTasks = (context) => Object.entries(context?.tasks ?? {})
	.filter(([, task]) => task !== null && typeof task === "object" && typeof task.caseId === "string")
	.map(([conversationId, task]) => ({ id: task.caseId, conversationId, phase: task.phase }));

const activeContextTasks = (context, cases) => {
	const statuses = new Map(cases.map((entry) => [entry.id, entry]));
	return legacyContextTasks(context).filter((entry) => statuses.get(entry.id)?.active !== false);
};

const uniqueActive = (entries) => {
	const seen = new Set();
	return entries.filter((entry) => {
		const key = String(entry.id ?? entry.path);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

const asText = (bytes) => {
	try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { return undefined; }
};

const storyExport = (entry) => {
	const text = asText(entry.raw);
	return [
		`# Archived legacy storyteller ${entry.id}`,
		"",
		"This is a static C5 archive export. Cartographer no longer parses, resumes, shelves, or sends this material to a model.",
		`Original bytes: raw/storyteller/${entry.name} · SHA-256 ${entry.digest}`,
		"",
		"## Original transcript bytes",
		"",
		text === undefined ? "The original file was not valid UTF-8. Its exact bytes are retained at the raw path named above." : text,
		"",
	].join("\n");
};

const caseExport = (entry, state) => {
	const text = asText(entry.raw);
	return [
		`# Archived legacy Case ${entry.id}`,
		"",
		"This is a static C5 archive export. Cartographer no longer loads, resumes, or renders Case records.",
		`Original bytes: raw/cases/${entry.name} · SHA-256 ${entry.digest}`,
		`Recorded legacy status: ${state.status ?? "unknown"}.`,
		"",
		"## Original record bytes",
		"",
		text === undefined ? "The original file was not valid UTF-8. Its exact bytes are retained at the raw path named above." : `\`\`\`json\n${text}\n\`\`\``,
		"",
	].join("\n");
};

const contextExport = (entry) => {
	const text = asText(entry.raw);
	return [
		"# Archived C5 migration context",
		"",
		"This is a static C5 archive export of the context store before legacy shelf pointers and retired Case task metadata were removed. Cartographer does not load it as a live context.",
		`Original bytes: raw/context/${entry.name} · SHA-256 ${entry.digest}`,
		"",
		"## Original context bytes",
		"",
		text === undefined ? "The original file was not valid UTF-8. Its exact bytes are retained at the raw path named above." : `\`\`\`json\n${text}\n\`\`\``,
		"",
	].join("\n");
};

const writeExactArchive = (path, raw, digest) => {
	if (existsSync(path)) {
		const current = readFileSync(path);
		if (sha256(current) !== digest) throw new LegacyCutoverError(`Archive collision at ${path}: existing bytes do not match the legacy source digest.`);
		return;
	}
	atomicWrite(path, raw);
};

const stableShelfId = (item, storyId, ordinal) => {
	if (typeof item?.id === "string" && /^sh(?:\d+|-[A-Za-z0-9-]+)$/.test(item.id)) return item.id;
	return `sh-legacy-${sha256(`${storyId}:${ordinal}`).slice(0, 16)}`;
};
const shelfSnapshot = (id, story) => {
	const text = [
		`== Archived legacy consultation ${story.id} ==`,
		"This is an immutable C5 migration snapshot, not a live thread. The original bytes remain under .brain/legacy/ and cannot enter a conference.",
		`Archive: ${story.export} · SHA-256 ${story.digest}`,
		"",
		story.text,
	].join("\n");
	const [first, ...rest] = text.split("\n");
	return `${first} [shelf id ${id}]${rest.length === 0 ? "" : `\n${rest.join("\n")}`}`;
};

const archivedStory = (entry) => ({
	id: entry.id,
	name: entry.name,
	digest: entry.digest,
	raw: `raw/storyteller/${entry.name}`,
	export: `exports/storyteller/${entry.id}.md`,
	text: storyExport(entry),
});

const verifyArchiveEntries = (brainDir, kind, entries) => {
	if (entries === undefined) return;
	if (!Array.isArray(entries)) throw new LegacyCutoverError(`The prior C5 archive manifest has an invalid ${kind} list.`);
	for (const entry of entries) {
		if (typeof entry?.id !== "string" || !safeName(entry.id) || typeof entry?.name !== "string" || !safeName(entry.name) || typeof entry?.digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest)) {
			throw new LegacyCutoverError(`The prior C5 archive manifest has an invalid ${kind} entry.`);
		}
		const path = rawPath(brainDir, kind, entry.name);
		if (!existsSync(path)) throw new LegacyCutoverError(`The prior C5 archive is missing ${entry.raw ?? path}; it cannot safely finish migration.`);
		const raw = readFileSync(path);
		if (sha256(raw) !== entry.digest) throw new LegacyCutoverError(`The prior C5 archive digest for ${kind} ${entry.id} no longer matches its raw bytes.`);
	}
};

const verifyContextEntry = (brainDir, entry) => {
	if (entry === undefined) return;
	if (entry === null || typeof entry !== "object" || entry.name !== "carto-context.json" || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest)) {
		throw new LegacyCutoverError("The prior C5 archive manifest has an invalid context entry.");
	}
	const path = rawPath(brainDir, "context", entry.name);
	if (!existsSync(path)) throw new LegacyCutoverError(`The prior C5 archive is missing ${entry.raw ?? path}; it cannot safely finish migration.`);
	if (sha256(readFileSync(path)) !== entry.digest) throw new LegacyCutoverError("The prior C5 archive digest for the migration context no longer matches its raw bytes.");
};

const archivedContext = (brainDir, entry) => entry === undefined ? undefined : {
	...entry,
	raw: readFileSync(rawPath(brainDir, "context", entry.name)),
};

const archiveEntriesFromManifest = (brainDir, manifest) => {
	verifyArchiveEntries(brainDir, "storyteller", manifest?.storyteller);
	return (manifest?.storyteller ?? []).map((entry) => {
		const raw = readFileSync(rawPath(brainDir, "storyteller", entry.name));
		return archivedStory({ id: entry.id, name: entry.name, digest: entry.digest, raw });
	});
};

/** Inspect all retired live stores without changing them. */
export function inventoryLegacyProducts(brainDir) {
	const storyteller = safeDirectoryFiles(storyDir(brainDir), ".md", "legacy storyteller store");
	const cases = safeDirectoryFiles(casesDir(brainDir), ".json", "legacy Case store").map((entry) => ({ ...entry, ...parseCaseState(entry) }));
	const contextSource = readContextSource(brainDir, storyteller.length > 0 || cases.length > 0);
	const context = contextSource?.value;
	const storyShelves = [];
	for (const scope of shelfScopes(context)) {
		for (const [index, item] of scope.items.entries()) {
			const storyId = storyIdOf(item);
			if (storyId !== undefined) storyShelves.push({ scope: scope.name, index, id: item?.id, storyId });
		}
	}
	const active = uniqueActive([
		...cases.filter((entry) => entry.active).map((entry) => ({ id: entry.id, path: `cases/${entry.name}`, status: entry.status })),
		...activeContextTasks(context, cases).map((entry) => ({ id: entry.id, path: `context task ${entry.conversationId}`, status: "resumable task metadata" })),
	]);
	return { storyteller, cases, context, contextSource, storyShelves, active };
}

/**
 * Archive and remove the retired product data once. Every active or resumable Case blocks this operation; it must
 * first be explicitly stopped by the pre-C5 runtime. Calls are idempotent after an interrupted archive attempt.
 */
export function migrateLegacyProducts(brainDir, { at = Date.now() } = {}) {
	const prior = readManifest(brainDir);
	verifyArchiveEntries(brainDir, "storyteller", prior?.storyteller);
	verifyArchiveEntries(brainDir, "cases", prior?.cases);
	verifyContextEntry(brainDir, prior?.context);
	const inventory = inventoryLegacyProducts(brainDir);
	const archivedStories = archiveEntriesFromManifest(brainDir, prior);
	const currentStories = inventory.storyteller.map(archivedStory);
	const stories = new Map([...archivedStories, ...currentStories].map((entry) => [entry.id, entry]));
	const active = inventory.active;
	if (active.length > 0) throw new LegacyCutoverBlockedError(active);

	const contextNeedsRetirement = inventory.storyShelves.length > 0 || legacyContextTasks(inventory.context).length > 0;
	const currentContext = contextNeedsRetirement && prior?.context === undefined ? inventory.contextSource : undefined;
	const retainedContext = prior?.context ?? (currentContext === undefined ? undefined : {
		name: currentContext.name,
		digest: currentContext.digest,
		raw: `raw/context/${currentContext.name}`,
		export: `exports/context/${currentContext.name}.md`,
	});
	const exportMissing = (entries, kind) => entries.some((entry) => !existsSync(exportPath(brainDir, kind, entry.id)));
	const contextExportMissing = retainedContext !== undefined && !existsSync(exportPath(brainDir, "context", retainedContext.name));
	const needsMigration = inventory.storyteller.length > 0 || inventory.cases.length > 0 || contextNeedsRetirement || (prior !== undefined && prior.state !== "completed") || exportMissing(prior?.storyteller ?? [], "storyteller") || exportMissing(prior?.cases ?? [], "cases") || contextExportMissing;
	if (!needsMigration) return { migrated: false, inventory: { storyteller: 0, cases: 0, shelfPlacements: 0 } };

	const createdAt = prior?.createdAt ?? new Date(at).toISOString();
	const manifest = {
		version: LEGACY_CUTOVER_VERSION,
		kind: "cartographer-legacy-cutover",
		createdAt,
		storyteller: [...stories.values()].map(({ raw, text, ...entry }) => entry).sort((left, right) => left.id.localeCompare(right.id)),
		cases: [
			...(prior?.cases ?? []),
			...inventory.cases.filter((entry) => !(prior?.cases ?? []).some((priorEntry) => priorEntry.id === entry.id)).map((entry) => ({
				id: entry.id,
				name: entry.name,
				digest: entry.digest,
				status: entry.status ?? "unknown",
				raw: `raw/cases/${entry.name}`,
				export: `exports/cases/${entry.id}.md`,
			})),
		].sort((left, right) => String(left.id).localeCompare(String(right.id))),
		...(retainedContext === undefined ? {} : { context: retainedContext }),
	};

	// Archive every source before changing a live context pointer or removing a source directory.
	for (const story of currentStories) {
		writeExactArchive(rawPath(brainDir, "storyteller", story.name), inventory.storyteller.find((entry) => entry.id === story.id).raw, story.digest);
		atomicWrite(exportPath(brainDir, "storyteller", story.id), story.text);
	}
	for (const entry of inventory.cases) {
		writeExactArchive(rawPath(brainDir, "cases", entry.name), entry.raw, entry.digest);
		atomicWrite(exportPath(brainDir, "cases", entry.id), caseExport(entry, entry));
	}
	if (currentContext !== undefined) {
		writeExactArchive(rawPath(brainDir, "context", currentContext.name), currentContext.raw, currentContext.digest);
		atomicWrite(exportPath(brainDir, "context", currentContext.name), contextExport(currentContext));
	}
	// A prior staged archive may have outlived its live sources. Recreate missing readable exports from exact
	// archived bytes rather than needing any former story/Case/context runtime parser.
	for (const story of archivedStories) atomicWrite(exportPath(brainDir, "storyteller", story.id), story.text);
	for (const entry of prior?.cases ?? []) {
		const raw = readFileSync(rawPath(brainDir, "cases", entry.name));
		atomicWrite(exportPath(brainDir, "cases", entry.id), caseExport({ ...entry, raw }, entry));
	}
	const priorContext = archivedContext(brainDir, prior?.context);
	if (priorContext !== undefined) atomicWrite(exportPath(brainDir, "context", priorContext.name), contextExport(priorContext));
	// This durable staging manifest is the recovery boundary. If a process dies after this write, a later C5 run
	// validates the archived bytes and completes pointer conversion/removal without needing any live parser.
	atomicWrite(manifestPath(brainDir), `${JSON.stringify({ ...manifest, state: "archived" }, null, "\t")}\n`);

	let migratedShelves = 0;
	let removedCaseTasks = 0;
	if (inventory.context !== undefined) {
		const context = inventory.context;
		for (const scope of shelfScopes(context)) {
			for (const [index, item] of scope.items.entries()) {
				const storyId = storyIdOf(item);
				if (storyId === undefined) continue;
				const story = stories.get(storyId);
				if (story === undefined) throw new LegacyCutoverError(`Shelf placement ${item?.id ?? `${scope.name}#${index}`} points at legacy thread ${storyId}, but no source or archive bytes exist for it.`);
				const id = stableShelfId(item, storyId, index);
				const next = {
					...item,
					id,
					type: "file",
					path: `archived legacy consultation ${storyId}`,
					snapshot: shelfSnapshot(id, story),
					legacyArchive: { kind: "storyteller", id: storyId, digest: story.digest, export: story.export },
				};
				delete next.ref;
				if (hasStoryTarget(next)) delete next.target;
				scope.replace(index, next);
				migratedShelves += 1;
			}
		}
		for (const [conversationId, task] of Object.entries(context.tasks ?? {})) {
			if (task !== null && typeof task === "object" && typeof task.caseId === "string") {
				delete context.tasks[conversationId];
				removedCaseTasks += 1;
			}
		}
		if (migratedShelves > 0 || removedCaseTasks > 0) atomicWrite(contextPath(brainDir), `${JSON.stringify(context, null, "\t")}\n`);
	}

	// The archive now has exact originals, exports, and no live shelf pointers. Removing the retired stores last
	// leaves an interrupted run restartable without a live reader or data loss.
	if (existsSync(storyDir(brainDir))) rmSync(storyDir(brainDir), { recursive: true, force: true });
	if (existsSync(casesDir(brainDir))) rmSync(casesDir(brainDir), { recursive: true, force: true });
	manifest.state = "completed";
	manifest.completedAt = new Date(at).toISOString();
	manifest.shelfPlacementsMigrated = Math.max(prior?.shelfPlacementsMigrated ?? 0, migratedShelves);
	manifest.caseTaskStatesRetired = Math.max(prior?.caseTaskStatesRetired ?? 0, removedCaseTasks);
	atomicWrite(manifestPath(brainDir), `${JSON.stringify(manifest, null, "\t")}\n`);
	return {
		migrated: true,
		inventory: { storyteller: manifest.storyteller.length, cases: manifest.cases.length, shelfPlacements: migratedShelves, retiredCaseTasks: removedCaseTasks },
		archive: manifestPath(brainDir),
	};
}
