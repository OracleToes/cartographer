// Top-level `shelf`: the agent's working-memory bench for keeping several files, ranges, reports, stories,
// or pinned records in view together across reads and across collapses.
//
// `shelf add` persists a backing snapshot under `.brain/shelf/` and returns a one-line receipt; the snapshot body
// itself renders once (in `<state>` until the next collapse, and in `<context>` after collapse) so unshelving or
// narrowing a range frees context tokens on the very next request without leaving a duplicate copy in tool history.
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { bool, compile, obj, opt, str } from "@earendil-works/pi-schema";
import { POLICY } from "../config.mjs";
import {
	cleanupShelfSnapshots,
	composedRows,
	estimate,
	loadContext,
	loadReport,
	persistShelfSnapshot,
	shelfItem,
	shelfLabel,
	shelfReferenceItem,
	shelfSpace,
	shelfText,
	taskState,
	updateContext,
} from "../context.mjs";
import {
	ensureCatalog,
	fileReference,
	nativeReference,
	readReferenceVersion,
	resolveFile,
	retainReferenceVersion,
	validateReference,
} from "../catalog.mjs";
import { durableRecordFor } from "../index.mjs";
import { describe } from "../prompt.mjs";
import { readStory, STORY_ID } from "../story.mjs";
import { takeWarnings } from "../warnings.mjs";
import { noFileRecord } from "./read.mjs";

const count = (n) => Math.round(n).toLocaleString("en-US");
const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
const textResult = (text, details = {}) => ({ output: [{ type: "text", text }], details });
const isCatalogFileId = (id) => /^f(\d+|-[0-9a-f]{8}-)/i.test(String(id ?? ""));
const DURABLE_REF_KINDS = new Set(["conversation", "message", "toolCall", "toolResult", "prompt", "tool"]);

const SHELF_ACTIONS = ["add", "remove", "list"];
const SHELF_GUIDE = {
	add: 'id or path; optional range ("1-200"), ref (when pinning version), and handOn: true (in a focus, pass to the main shelf on return)',
	remove: 'id (such as sh1, f1, or "all") or path',
};

const REFERENCE_SCHEMA = obj({
	id: str({ minLength: 1, maxLength: 256, description: "Stable ID of the entity. Pass top-level `id` instead unless pinning `version`." }),
	namespace: opt(str({ minLength: 16, description: "Brain-store namespace. Inferred from this brain when omitted." })),
	kind: opt(str({ minLength: 1, maxLength: 64, pattern: "^[a-z][A-Za-z0-9_-]{0,63}$", description: "Reference kind (file, report, story, schema, message, toolCall, toolResult). Inferred from the ID when omitted." })),
	version: opt(str({ description: "Exact immutable content version to pin; omit to resolve the live one." })),
});

const withNotes = (result) => {
	const notes = takeWarnings();
	if (notes.length === 0) return result;
	return { ...result, output: [...(result?.output ?? []), { type: "text", text: notes.map((note) => `note: ${note}`).join("\n") }] };
};

const normalizeShelfRef = (brainDir, ref) => {
	if (ref === null || ref === undefined || typeof ref !== "object") return ref;
	const out = { ...ref };
	if (out.namespace === undefined) {
		try { out.namespace = ensureCatalog(brainDir).namespace; } catch { /* left out; validation says what is missing */ }
	}
	return out;
};

/** Normalize raw shelf arguments without mutating frozen harness objects. */
export const normalizeShelfArgs = (brainDir, given) => {
	if (given === null || given === undefined || typeof given !== "object") return given;
	const trimmedId = typeof given.id === "string" && given.id.trim() !== "" ? given.id.trim() : undefined;
	const rawRef = given.ref !== undefined ? given.ref : (trimmedId !== undefined ? { id: trimmedId } : undefined);
	const ref = normalizeShelfRef(brainDir, rawRef);
	const id = trimmedId ?? (typeof ref?.id === "string" && ref.id.trim() !== "" ? ref.id.trim() : undefined);
	const out = { ...given };
	if (id !== undefined) out.id = id;
	if (ref !== undefined) out.ref = ref;
	return out;
};

const currentShelf = (brainDir, conversationId, main) => {
	const store = loadContext(brainDir);
	return main ? store.shelf : (store.tasks[conversationId]?.shelf ?? []);
};

/**
 * Infer a shelf target kind from an ID alone: catalog file, report, consultation thread, Durable record,
 * or confined project-relative path passed in `id`.
 */
export async function inferShelfRef(ref, root, brainDir, api, callContext) {
	let namespace;
	try { namespace = ensureCatalog(brainDir).namespace; } catch { return undefined; }
	const filled = { ...ref, namespace };
	if (resolveFile(root, brainDir, { ...filled, kind: "file" }).status === "live") return { ...filled, kind: "file" };
	if (loadReport(brainDir, ref.id) !== undefined && composedRows(loadContext(brainDir)).some((row) => row.id === ref.id)) {
		return { ...filled, kind: "report" };
	}
	if (STORY_ID.test(String(ref.id)) && readStory(brainDir, ref.id) !== undefined) return { ...filled, kind: "story" };
	for (const kind of ["schema", "message", "toolResult", "toolCall"]) {
		try {
			const found = await durableRecordFor(kind, ref.id, brainDir, api, callContext);
			if (found !== undefined) return { ...filled, kind };
		} catch { /* not this kind */ }
	}
	if (ref.version === undefined && !isCatalogFileId(ref.id)) {
		try {
			const fileRef = fileReference(root, brainDir, ref.id);
			return { namespace: fileRef.namespace, kind: "file", id: fileRef.id };
		} catch { /* not an existing confined project file */ }
	}
	return undefined;
}

/** Shared shelf executor used by top-level `shelf` and unadvertised `book` transcript replay. */
export async function runShelf({ root, brainDir, config }, action, args, api, callContext) {
	const main = api.conversationId === ROOT_CONVERSATION_ID;
	if (action === "list") {
		const items = currentShelf(brainDir, api.conversationId, main);
		return textResult(
			items.length === 0
				? "Shelf is empty."
				: items.map((item) => `${shelfLabel(item)} [placement ${item.id}]${item.target ? ` → ${JSON.stringify(item.target)}` : ""}`).join("\n"),
			{ placements: items.map((item) => item.id) },
		);
	}
	if (action === "add") {
		const mine = currentShelf(brainDir, api.conversationId, main);
		let ref = args.ref;
		let path = args.path;
		let effectiveRange = args.range;
		let pinnedDurable;
		// Passing an existing placement ID (`sh1`) refreshes that placement from disk or updates its line range.
		const wantedPlacementId = typeof args.id === "string" && args.ref?.kind === undefined && args.ref?.version === undefined ? args.id.trim() : undefined;
		const existingPlacement = wantedPlacementId !== undefined ? mine.find((entry) => entry.id === wantedPlacementId) : undefined;
		if (existingPlacement !== undefined) {
			if (existingPlacement.ref !== undefined) {
				const kind = existingPlacement.ref.type ?? existingPlacement.ref.kind;
				ref = {
					namespace: existingPlacement.ref.namespace ?? ensureCatalog(brainDir).namespace,
					kind,
					id: existingPlacement.ref.id,
					...(existingPlacement.ref.version ? { version: existingPlacement.ref.version } : {}),
				};
			} else {
				path = existingPlacement.path;
				ref = undefined;
				if (effectiveRange === undefined && existingPlacement.from !== undefined && existingPlacement.to !== undefined) {
					effectiveRange = `${existingPlacement.from}-${existingPlacement.to}`;
				}
			}
		}
		if (ref !== undefined) {
			if (ref.kind === undefined) {
				const inferred = await inferShelfRef(ref, root, brainDir, api, callContext);
				if (inferred === undefined) {
					return fail(`Nothing with the ID "${ref.id}" is a file, a report, a consultation transcript, a schema or a durable record; nothing was added. Pass a project-relative \`path\`, or give \`ref.kind\` to say what it is.`);
				}
				ref = inferred;
			}
			if (!validateReference(ref)) return fail("Invalid shelf target reference.");
			if (ref.kind === "file") {
				let resolved = resolveFile(root, brainDir, ref);
				if (resolved.status !== "live" && resolved.error === "No catalog record exists for this file identity." && ref.version === undefined && !isCatalogFileId(ref.id)) {
					try {
						const fileRef = fileReference(root, brainDir, ref.id);
						ref = { namespace: fileRef.namespace, kind: "file", id: fileRef.id };
						resolved = resolveFile(root, brainDir, ref);
					} catch { /* keep missing-record error */ }
				}
				if (resolved.status !== "live") {
					return fail(`Cannot shelf file: ${resolved.error === "No catalog record exists for this file identity." ? noFileRecord(ref.id) : `resolver status ${resolved.status}. ${resolved.error ?? "The reference is not current."}`}`);
				}
				path = resolved.record.path;
			} else if (ref.kind === "report") {
				const current = nativeReference(brainDir, "report", ref.id);
				if (ref.namespace !== current.namespace) return fail("Report reference belongs to another brain-store namespace.");
				const row = composedRows(loadContext(brainDir)).find((entry) => entry.id === ref.id);
				const body = row === undefined ? undefined : loadReport(brainDir, ref.id);
				if (body === undefined) return fail(`Report ${ref.id} is deleted or unavailable.`);
				path = `report:${ref.id}`;
			} else if (ref.kind === "story") {
				if (!STORY_ID.test(String(ref.id)) || readStory(brainDir, ref.id) === undefined) {
					return fail(`Story ${ref.id} is unavailable; nothing was shelved.`);
				}
				path = `story:${ref.id}`;
			} else if (ref.kind === "schema") {
				if (typeof ref.version !== "string") return fail("A schema shelf placement needs an exact version-pinned schema reference.");
				const retained = readReferenceVersion(brainDir, ref);
				if (retained === undefined) {
					let current;
					try { current = await durableRecordFor("schema", ref.id, brainDir, api, callContext); }
					catch (error) { return fail(`Could not resolve schema reference: ${error.message}.`); }
					const currentNamespace = nativeReference(brainDir, "schema", ref.id).namespace;
					if (ref.namespace !== currentNamespace) return fail("Schema reference belongs to another brain-store namespace.");
					if (current === undefined || current.version !== ref.version) return fail("The pinned schema version is unavailable and is not the current one; no shelf placement was added.");
					try { retainReferenceVersion(brainDir, ref, current.value); }
					catch (error) { return fail(`The schema version could not be retained: ${error.message}.`); }
				}
			} else if (DURABLE_REF_KINDS.has(ref.kind)) {
				const durable = await durableRecordFor(ref.kind, ref.id, brainDir, api, callContext);
				if (durable === undefined) return fail(`${ref.kind} ${ref.id} is unavailable (missing or soft-forgotten); nothing was shelved.`);
				if (ref.version !== undefined && ref.version !== durable.version) {
					return fail(`Stale ${ref.kind} reference: requested ${ref.version}, current ${durable.version}. Re-list and pin the current version.`);
				}
				pinnedDurable = { record: durable, ref: { namespace: ref.namespace, kind: ref.kind, id: ref.id, version: ref.version ?? durable.version } };
			} else {
				return fail(`Unsupported shelf reference kind ${JSON.stringify(ref.kind)}. Supported kinds: file, report, story, schema, message, toolCall, toolResult.`);
			}
		}
		if (ref?.kind !== "schema" && !DURABLE_REF_KINDS.has(ref?.kind ?? "") && (typeof path !== "string" || path.trim() === "")) {
			return fail(`shelf add needs \`id\` or project-relative \`path\`. shelf add takes: ${SHELF_GUIDE.add}.`);
		}
		let picked;
		if (pinnedDurable !== undefined) {
			picked = shelfReferenceItem(pinnedDurable.ref, JSON.stringify(pinnedDurable.record.value, null, 2), brainDir, mine);
		} else {
			try { picked = shelfItem(root, ref?.kind === "schema" ? ref : path, effectiveRange, brainDir, mine); }
			catch (error) { return fail(`Cannot add to shelf: ${error.message}`); }
		}
		const item = { ...picked.item, ...(ref ? { target: ref } : picked.item.target ? { target: picked.item.target } : {}) };
		persistShelfSnapshot(brainDir, item, picked.backing);
		const handOn = !main && args.handOn === true;
		let updatedList = [];
		updateContext(brainDir, (next) => {
			const list = main ? next.shelf : (taskState(next, api.conversationId).shelf ??= []);
			const at = list.findIndex((entry) => entry.id === item.id);
			const stored = { ...item, ...(handOn ? { handOn: true } : {}) };
			if (at < 0) list.push(stored);
			else list[at] = stored;
			updatedList = [...list];
		});
		const totalTokens = updatedList.reduce((sum, entry) => {
			try { return sum + estimate(shelfText(root, entry, brainDir)); } catch { return sum; }
		}, 0);
		const percent = Math.round((totalTokens / shelfSpace(config?.contextWindow)) * 100);
		return textResult(
			`Added ${shelfLabel(item)} to the shelf as placement ${item.id} (about ${count(picked.tokens)} tokens; shelf at ${percent}% of capacity, shown in the state block and carried through collapse).`,
			{ placement: item.id, ref: item.target, paths: item.type === "file" && typeof item.path === "string" ? [item.path] : [], tokens: picked.tokens },
		);
	}
	if (action === "remove") {
		const wanted = String(args.id ?? args.ref?.id ?? args.path ?? "").trim();
		if (!wanted) return fail(`shelf remove needs \`id\` or \`path\`. shelf remove takes: ${SHELF_GUIDE.remove}.`);
		if (loadContext(brainDir).appliedOperations?.includes(String(api.taskId))) {
			cleanupShelfSnapshots(brainDir, [{ id: wanted, type: "file" }]);
			return textResult(`Removed shelf placement ${wanted}; the target identity remains unchanged.`, { removedPlacement: wanted, replay: true });
		}
		const mine = currentShelf(brainDir, api.conversationId, main);
		const normalizedWanted = wanted.replace(/^\.\//, "");
		const gone = wanted === "all"
			? mine
			: mine.filter((item) => item.id === wanted || item.target?.id === wanted || item.ref?.id === wanted || shelfLabel(item) === wanted || item.path === wanted || item.path === normalizedWanted);
		if (gone.length === 0) {
			return fail(`No shelf item ${JSON.stringify(wanted)} exists in this context.${mine.length > 0 ? ` On it: ${mine.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}.` : " The shelf is empty."}`);
		}
		const removedIds = new Set(gone.map((item) => item.id));
		updateContext(brainDir, (next) => {
			if (main) next.shelf = next.shelf.filter((item) => !removedIds.has(item.id));
			else taskState(next, api.conversationId).shelf = mine.filter((item) => !removedIds.has(item.id));
			next.appliedOperations = [...new Set([...(next.appliedOperations ?? []), String(api.taskId)])].slice(-POLICY.limits.context.operationReplay);
		});
		cleanupShelfSnapshots(brainDir, gone);
		const label = gone.map((item) => item.id).join(", ");
		return textResult(`Removed shelf placement ${label}; the target identity remains unchanged.`, {
			removedPlacement: gone.length === 1 ? gone[0].id : gone.map((item) => item.id),
		});
	}
	return fail(`Unsupported shelf action ${JSON.stringify(action)}. Supported actions: ${SHELF_ACTIONS.join(", ")}.`);
}

/**
 * @param {{ root: string, brainDir: string, config?: object }} input
 */
export function shelfTool({ root, brainDir, config }) {
	const validationSchema = obj({
		action: str({ enum: SHELF_ACTIONS, description: "Shelf operation: add (pin, update range, or refresh), remove, or list." }),
		path: opt(str({ minLength: 1, pattern: "\\S", description: "Project-relative file path on add or remove." })),
		id: opt(str({ minLength: 1, maxLength: 256, description: 'Placement or target ID: sh1, file f1 (or path), report t1, story st1, Durable record, or "all" on remove.' })),
		range: opt(str({ description: `Optional line selection on add, such as "1-200" (at most ${POLICY.limits.look.readMaxLines} lines). Re-adding a shelved file updates its range and refreshes its snapshot.` })),
		ref: opt(REFERENCE_SCHEMA),
		handOn: opt(bool({ description: "When adding from a focused task, pass the placement to the orchestrating shelf on return." })),
	});
	const validate = compile(validationSchema, { coerce: true });
	const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
	return defineTool({
		name: "shelf",
		description: describe("shelf"),
		parameters: validationSchema,
		prepareArguments(args) {
			const parsed = validate.parse(args);
			if (!parsed.ok) {
				const path = (pointer) => pointer === "" ? "root" : pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")).join(".");
				const errors = [...parsed.errors].map((error) => `  - ${path(error.path)}: ${error.message}`).join("\n");
				throw new Error(`Validation failed for tool "shelf":\n${errors}`);
			}
			const value = parsed.value;
			if (nonEmpty(value.id) && typeof value.ref?.id === "string" && value.id.trim() !== value.ref.id.trim()) {
				throw new Error('Validation failed for tool "shelf": matching `id` and `ref.id` are required (pass `id` alone unless pinning `ref.version`).');
			}
			const prepared = normalizeShelfArgs(brainDir, value);
			if (value.action === "add" || value.action === "remove") {
				const hasRef = prepared.ref !== undefined && nonEmpty(prepared.ref.id);
				const hasPath = nonEmpty(prepared.path);
				if (!hasRef && !hasPath) {
					throw new Error(`Validation failed for tool "shelf": shelf ${value.action} needs \`id\` or \`path\`. shelf ${value.action} takes: ${SHELF_GUIDE[value.action]}.`);
				}
			}
			return prepared;
		},
		executionMode: "sequential",
		replay: POLICY.enums.toolReplay.safe,
		execute: async (args, api, callContext) => {
			takeWarnings();
			return withNotes(await runShelf({ root, brainDir, config }, args.action, args, api, callContext));
		},
	});
}
