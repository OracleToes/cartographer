// The `book` tool is the single interface to the agent's durable brain surfaces — ledger, plan, atlas, assessment,
// context, reports, Durable records, and project-file mutations. Project-file reading and working-memory shelving live
// in the top-level `read` and `shelf` tools. Focused contexts may update the shared brain; only the orchestrating
// context can change the plan. Domain operations live in src/ledger.mjs, src/plan.mjs, src/atlas.mjs,
// src/assessment.mjs and src/context.mjs; this file routes target/action calls to them. One flat declaration
// (llama.cpp-safe at the root) plus one capability table drive what is offered, validated and dispatched.
import { POLICY } from "../config.mjs";
import { projectFiles } from "./look.mjs";
import { ChangeError, confineWrite } from "./change.mjs";
import { noFileRecord, runFileRead } from "./read.mjs";
import { readBatchAllowance } from "../read-batch.mjs";
import { runShelf } from "./shelf.mjs";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { arr, bool, compile, int, obj, opt, str } from "@earendil-works/pi-schema";
import { describe, REFUSALS, STILL_TASK } from "../prompt.mjs";
import { applyOp, LedgerError, loadLedger, open, openCounts, prune, saveLedger } from "../ledger.mjs";
import { applyPlanOp, authorizationLine, isAuthorized, loadPlan, PlanError, savePlan } from "../plan.mjs";
import { applyAtlasOp, AtlasError, findNode, loadAtlas, saveAtlas } from "../atlas.mjs";
import { ASSESSMENT_MAX, assessmentPath, saveAssessment } from "../assessment.mjs";
import { noteAssessed, pin } from "../top.mjs";
import { loadContext, loadReport, messageTokens, recordLine, reportsInView, ShelfError, shelfItem, shelfLabel, shelfText, estimate, stepsOf, taskState, updateContext, persistShelfSnapshot, RECALLED, composedRows, applyContextRowAction, ContextRowError, sameShelfItem, cleanupShelfSnapshots, recordSoftForgetPending } from "../context.mjs";
import { ensureCatalog, fileReference, nativeReference, readReferenceVersion, rebindFile, resolveFile, validateReference, contentVersion } from "../catalog.mjs";
import { durableSummaries, durableRecordFor, scanAll } from "../index.mjs";
import { USER_NAME } from "../user.mjs";
import { clipNote, takeWarnings, warn } from "../warnings.mjs";

const count = (n) => Math.round(n).toLocaleString("en-US");
const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
const sameItem = sameShelfItem;
/** Fill a ref from what the brain already knows, so that an ID alone is enough: the kind from the target, the namespace from the catalog. The live version is used unless the caller pins one. */
const normalizeRef = (brainDir, ref, target) => {
	if (ref === null || ref === undefined || typeof ref !== "object") return ref;
	const out = { ...ref };
	if (out.namespace === undefined) {
		try { out.namespace = ensureCatalog(brainDir).namespace; } catch { /* left out; validation says what is missing */ }
	}
	if (out.kind === undefined && target !== "shelf") out.kind = target;
	return out;
};
/** Lift a top-level `id` into the normalized internal `ref` envelope when `ref` was not given directly, without mutating frozen inputs. */
const normalizeArgs = (brainDir, given) => {
	if (given === null || given === undefined || typeof given !== "object") return given;
	const trimmedId = typeof given.id === "string" && given.id.trim() !== "" ? given.id.trim() : undefined;
	const rawRef = given.ref !== undefined ? given.ref : (trimmedId !== undefined ? { id: trimmedId } : undefined);
	const ref = normalizeRef(brainDir, rawRef, given.target);
	const id = trimmedId ?? (typeof ref?.id === "string" && ref.id.trim() !== "" ? ref.id.trim() : undefined);
	const out = { ...given };
	if (id !== undefined) out.id = id;
	if (ref !== undefined) out.ref = ref;
	return out;
};
const isCatalogFileId = (id) => /^f(\d+|-[0-9a-f]{8}-)/i.test(String(id ?? ""));
/**
 * One source of truth for what exists: target → action → validation spec. The provider declaration (enums), the
 * local validator and the executor's dispatch all derive from this table; the tool description's capability
 * matrix is written to match it. Spec fields:
 *   ref: "required" → needs `id` (or `ref` when pinning `version`); namespace and kind are inferred
 *   pathOk: `id` (or `ref`) OR an explicit project-relative `path` locates the thing
 *   confirmOk: `id` (or `ref`), `name`, or `names` locates the atlas node(s) to confirm
 *   lookOk: `id` (or `ref`), `name`, or `path` locates the atlas node or file to inspect
 *   fields: required non-empty string arguments on the call itself
 *   exactFields: required non-empty string arguments preserved verbatim (including whitespace)
 *   stringFields: required string arguments that may be empty ("")
 */
const CAPABILITIES = {
	file: {
		create: { fields: ["path"], stringFields: ["content"] },
		edit: { pathOk: true, exactFields: ["oldText"], stringFields: ["newText"] },
		remove: { pathOk: true },
		rebind: { ref: "required", fields: ["expectedVersion", "path"] },
	},
	report: {
		list: {},
		read: { ref: "required" },
		recall: { ref: "required" },
		archive: { ref: "required" },
		restore: { ref: "required" },
		remove: { ref: "required" },
	},
	ledger: {
		list: {},
		read: { ref: "required" },
		add: { fields: ["kind", "text"] },
		edit: { ref: "required" },
		done: { ref: "required" },
		remove: { ref: "required" },
	},
	plan: {
		list: {},
		read: { ref: "required" },
		add: { fields: ["mode", "text"] },
		edit: { ref: "required" },
		done: { ref: "required" },
		remove: { ref: "required" },
		before: { ref: "required" },
		clear: {},
	},
	atlas: {
		list: {},
		read: { ref: "required" },
		add: { fields: ["name", "gist"] },
		edit: { ref: "required", fields: ["gist"] },
		link: { ref: "required" },
		unlink: { ref: "required" },
		confirm: { confirmOk: true },
		remove: { ref: "required" },
		rename: { ref: "required", fields: ["to"] },
		look: { lookOk: true },
		tree: {},
	},
	assessment: {
		write: { fields: ["text"] },
	},
	context: {
		list: {},
		read: { ref: "required" },
		recall: { ref: "required" },
		archive: { ref: "required" },
		restore: { ref: "required" },
		fold: { ref: "required" },
		note: { fields: ["text"] },
		collapse: {},
	},
	conversation: { list: {}, read: { ref: "required" } },
	message: { list: {}, read: { ref: "required" }, edit: { ref: "required" } },
	toolCall: { list: {}, read: { ref: "required" } },
	toolResult: { list: {}, read: { ref: "required" } },
	prompt: { list: {}, read: { ref: "required" } },
	tool: { list: {}, read: { ref: "required" } },
	schema: { list: {}, read: { ref: "required" } },
};
const UNIVERSAL_TARGETS = Object.keys(CAPABILITIES);
const UNIVERSAL_ACTIONS = [...new Set(Object.values(CAPABILITIES).flatMap((actions) => Object.keys(actions)))];
const capabilityFor = (target, action) => CAPABILITIES[target]?.[action];
const REFERENCE_SCHEMA = obj({
	id: str({ minLength: 1, maxLength: 256, description: "Stable ID of the entity. Pass top-level `id` instead unless pinning `version`." }),
	namespace: opt(str({ minLength: 16, description: "Brain-store namespace. Inferred from this brain when omitted." })),
	kind: opt(str({ minLength: 1, maxLength: 64, pattern: "^[a-z][A-Za-z0-9_-]{0,63}$", description: "Reference kind. Inferred from the target when omitted." })),
	version: opt(str({ description: "Exact immutable content version to pin; omit to resolve the live one." })),
});

const textResult = (text, details = {}) => ({ output: [{ type: "text", text }], details });
/** Append any "this was clipped for you" notes raised while the call ran. Every tool call drains, once. */
const withNotes = (result) => {
	const notes = takeWarnings();
	if (notes.length === 0) return result;
	return { ...result, output: [...(result?.output ?? []), { type: "text", text: notes.map((note) => `note: ${note}`).join("\n") }] };
};
const unsupported = (target, action) => fail(`Unsupported book operation: target=${JSON.stringify(target)}, action=${JSON.stringify(action)}. No target content was resolved.${guideFor(target, action) === undefined && CAPABILITIES[target] !== undefined ? ` Supported actions for ${target}: ${Object.keys(CAPABILITIES[target]).join(", ")}.` : ""}`);

// ─── Error-attached guidance (Q3, 2026-11-15) ───────────────────────────────
// One line per action, appended ONLY to local failures; the happy path never pays for this.
const ACTION_GUIDE = {
	ledger: {
		add: "kind (goal | question | note) and text — a goal also needs done_when; a note may take salient: true",
		edit: "id, plus text, done_when (only on a goal), salient: true/false (only on a note), or outcome (when closed)",
		done: "id, plus an optional text outcome",
		remove: "id",
	},
	plan: {
		add: "mode (look | change) and text — before, network and standing optional (network/standing only with change)",
		edit: "id, plus text, mode, network, standing, or outcome (when done)",
		done: "id, plus an optional text outcome",
		remove: "id",
		before: "id, plus optional before (omit to move to the end)",
		clear: "no other fields — clears the plan",
	},
	assessment: {
		write: "text (the whole assessment; it replaces the current one)",
	},
	file: {
		create: "path and content — a new file keeps at most the line cap (see the session's `writeLines`); the rest is not written and the result says so. The result names the new file's `File id:`",
		edit: "id or path, oldText and newText",
		remove: "id or path",
		rebind: "id, path and expectedVersion — a `read` header shows `· file f1 @<64 hex>`: the id and the digest",
	},
	atlas: {
		add: "name and gist — detail, files and links optional; the node comes back with its `c<N>` id",
		edit: "id (or node name) and gist — detail, files and links optional; `rename` changes the name",
		rename: "id (or node name) and `to` (its new name); what links to it is rewritten",
		confirm: "id (or node name) — or several via `names`",
		link: "id (or node name), plus `files` (paths) and/or `links` (node names or ids)",
		unlink: "id (or node name), plus `files` (paths) and/or `links` (node names or ids) to take off",
		remove: "id (or node name)",
		look: "id, name, or path (a node id such as c3, a node name, or a project path)",
		tree: "anchor and/or depth (folder of the project; anchor '.' is the root)",
	},
	context: {
		recall: "id (a report id like t12)",
		archive: "id",
		restore: "id",
		fold: "id (a report id like t12, or task-step result ids like s3)",
		note: "text (what to keep, with file paths and line numbers)",
		collapse: "optional text",
	},
};
const guideFor = (target, action) => ACTION_GUIDE[target]?.[action];
/** Append the one-line field summary to a failure result, when one exists. Success results pass through unchanged. */
const withGuide = (target, action, result) => {
	if (result === null || typeof result !== "object" || result.isError !== true) return result;
	const guide = guideFor(target, action);
	if (guide === undefined) return result;
	const parts = result.output ?? [];
	const textParts = parts.filter((part) => part?.type === "text");
	if (textParts.length === 0) return { ...result, output: [...parts, { type: "text", text: `${target} ${action} takes: ${guide}.` }] };
	let appended = false;
	return { ...result, output: parts.map((part) => {
		if (appended || part?.type !== "text") return part;
		appended = true;
		return { ...part, text: `${part.text}\n${target} ${action} takes: ${guide}.` };
	}) };
};

const reportVersion = (body) => createHash("sha256").update(body).digest("hex");
const DURABLE_TARGETS = new Set(["conversation", "message", "toolCall", "toolResult", "prompt", "tool", "schema"]);
// Lists are hard-capped and paged with an opaque cursor; the cap is policy, the cursor is base64url JSON.
const LIST_CURSOR_MAX_BYTES = POLICY.limits.book.listCursorTokens * 4;
const encodeCursor = (offset, kind) => Buffer.from(JSON.stringify({ o: offset, k: kind })).toString("base64url");
const decodeCursor = (raw, kind) => {
	const text = String(raw ?? "");
	if (text.length === 0 || text.length > LIST_CURSOR_MAX_BYTES) throw new Error("the cursor is not valid for this target");
	let value;
	try { value = JSON.parse(Buffer.from(text, "base64url").toString("utf8")); } catch { throw new Error("the cursor is not valid for this target"); }
	if (value === null || typeof value !== "object" || !Number.isInteger(value.o) || value.o < 0 || value.k !== kind) throw new Error("the cursor is not valid for this target");
	return value.o;
};
const listPage = (items, args, kind) => {
	const offset = args.cursor === undefined ? 0 : decodeCursor(args.cursor, kind);
	const cap = POLICY.limits.book.listCap;
	const page = items.slice(offset, offset + cap);
	const next = offset + page.length < items.length ? encodeCursor(offset + page.length, kind) : undefined;
	return { page, next, total: items.length, shown: page.length };
};
const listFooter = ({ page, next, total }) => (next === undefined ? "" : `\n(${page.length} of ${total} shown; pass cursor "${next}" for the next page.)`);
const summaryLine = (record) => String(record.summary ?? record.id ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
/** Namespace-qualified reference without touching the registry/catalog again. */
const listRef = (namespace, kind, id, version) => ({ namespace, kind, id, ...(version ? { version } : {}) });
const BRAIN_TARGETS = new Set(["ledger", "plan", "atlas", "context"]);
const BRAIN_MUTATIONS = {
	ledger: new Set(["add", "edit", "done", "remove"]),
	plan: new Set(["add", "edit", "done", "remove", "before", "clear"]),
	atlas: new Set(["add", "edit", "link", "unlink", "confirm", "remove", "rename"]),
	context: new Set(["archive", "restore"]),
};
function listBrainRecords(target, brainDir) {
	if (target === "ledger") { const loaded = loadLedger(brainDir); if (!loaded.ledger) throw new Error(`The ledger cannot be read: ${loaded.error}`); return loaded.ledger.items; }
	if (target === "plan") { const loaded = loadPlan(brainDir); if (!loaded.plan) throw new Error(`The plan cannot be read: ${loaded.error}`); return loaded.plan.items; }
	if (target === "atlas") { const loaded = loadAtlas(brainDir); if (!loaded.atlas) throw new Error(`The atlas cannot be read: ${loaded.error}`); return loaded.atlas.nodes; }
	if (target === "context") return composedRows(loadContext(brainDir));
	return [];
}
function brainRecord(target, brainDir, id) {
	if (target === "atlas") {
		const loaded = loadAtlas(brainDir);
		if (!loaded.atlas) throw new Error(`The atlas cannot be read: ${loaded.error}`);
		const record = findNode(loaded.atlas, id);
		return record === undefined ? undefined : { record, version: contentVersion(record) };
	}
	const items = listBrainRecords(target, brainDir);
	const record = items.find((item) => item.id === id);
	return record === undefined ? undefined : { record, version: contentVersion(record) };
}

async function runUniversal({ root, brainDir, config, engine, gate }, given, api, callContext) {
	const main = api.conversationId === ROOT_CONVERSATION_ID;
	if (typeof given?.id === "string" && given.id.trim() !== "" && typeof given?.ref?.id === "string" && given.id.trim() !== given.ref.id.trim()) {
		return fail("`id` and `ref.id` do not match; pass `id` alone unless pinning `ref.version`.");
	}
	// Tool callers may reach here without prepareArguments: normalizing again is harmless.
	const args = normalizeArgs(brainDir, given);
	const target = args.target;
	const action = args.action;
	if (target === "file" && action === "rebind") {
		if (!validateReference(args.ref) || args.ref.kind !== "file") return fail("file rebind needs a stable file `id`.");
		if (typeof args.path !== "string" || typeof args.expectedVersion !== "string") return fail("file rebind needs a new confined path and the current expectedVersion.");
		try {
			const rebound = rebindFile(root, brainDir, args.ref, args.path, args.expectedVersion);
			return textResult(`Rebound the existing file identity to ${rebound.record.path}; content identity is preserved.`, { ref: rebound.ref, status: "live" });
		} catch (error) { return fail(`File rebind refused: ${error.message}.`); }
	}
	if (target === "file" && ["create", "edit", "remove"].includes(action)) {
		if (main) return fail("Project-file create/edit/remove must run in a focused change task for an authorized plan item.");
		// What this focus carries, recorded when it was created (src/tools/task.mjs) in the durable context store:
		// the plan item it carries out and that it is a change. Inferred automatically; an explicit planItem must match.
		const task = loadContext(brainDir).tasks[api.conversationId];
		if (task?.mode !== POLICY.enums.planMode.change || typeof task.item !== "string" || task.item.trim() === "") {
			return fail("File mutation refused: this focus is not carrying an authorized change plan item.");
		}
		if (args.planItem !== undefined && String(args.planItem).trim() !== "" && args.planItem !== task.item) {
			return fail("File mutation refused: this focus is not carrying that authorized change plan item.");
		}
		let filePath = args.path;
		let expectedVersion;
		if (action === "create") {
			if (typeof filePath !== "string" || filePath.trim() === "" || typeof args.content !== "string") return fail("file create needs path and content.");
			const nested = await api.executeTool("write", { path: filePath, content: args.content }, callContext, { key: "book-file-create" });
			const output = nested.structuredOutput;
			return { isError: nested.isError, output: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output ?? nested.diagnostics) }], details: { target: "file", action, path: filePath, change: true } };
		}
		let ref = args.ref;
		if (ref === undefined) {
			if (typeof args.path !== "string" || args.path.trim() === "") return fail(`file ${action} needs \`id\` or project-relative \`path\`.`);
			try {
				const confined = confineWrite(root, brainDir, args.path);
				if (!existsSync(confined.abs)) return fail(`File ${action} refused: ${confined.rel} does not exist.`);
				ref = fileReference(root, brainDir, confined.rel);
			} catch (error) { return fail(`File ${action} refused: ${error.message}.`); }
		}
		if (!validateReference(ref) || ref.kind !== "file") return fail(`file ${action} needs a file \`id\` or \`path\`.`);
		if (args.expectedVersion !== undefined && (typeof args.expectedVersion !== "string" || !/^[0-9a-f]{64}$/.test(args.expectedVersion))) return fail("`expectedVersion` must be a 64-character SHA-256 digest, or be omitted: the file's ID always points at the live version.");
		let resolved = resolveFile(root, brainDir, ref);
		if (resolved.status !== "live" && resolved.error === "No catalog record exists for this file identity." && ref.version === undefined && !isCatalogFileId(ref.id)) {
			try {
				const confined = confineWrite(root, brainDir, ref.id);
				if (existsSync(confined.abs)) {
					ref = fileReference(root, brainDir, confined.rel);
					resolved = resolveFile(root, brainDir, ref);
				}
			} catch (error) {
				if (error instanceof ChangeError) return fail(`File ${action} refused: ${error.message}.`);
			}
		}
		if (resolved.status !== "live") return fail(`File ${action} refused: ${resolved.error === "No catalog record exists for this file identity." ? noFileRecord(ref.id) : `resolver status ${resolved.status}. ${resolved.error ?? "Refresh the file reference."}`}`);
		if (args.expectedVersion !== undefined && resolved.currentVersion !== args.expectedVersion) return fail(`Stale file ${action}: expected ${args.expectedVersion}, current ${resolved.currentVersion}. Nothing was ${action === "remove" ? "removed" : "changed"}.`);
		filePath = resolved.record.path;
		// The ID points at the live version; the version handed to the nested call is resolved here, never asked of the agent.
		expectedVersion = resolved.currentVersion;
		if (action === "remove") {
			// Deletion goes through the same gate as write and edit: confined, checkpoint-recorded, undoable.
			const nested = await api.executeTool("rm", { path: filePath, expectedVersion }, callContext, { key: "book-file-remove" });
			const output = nested.structuredOutput;
			return { isError: nested.isError, output: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output ?? nested.diagnostics) }], details: { target: "file", action, path: filePath, expectedVersion, change: true } };
		}
		if (typeof args.oldText !== "string" || args.oldText === "" || typeof args.newText !== "string") return fail("file edit needs exact oldText and newText.");
		const nested = await api.executeTool("edit", { path: filePath, old_text: args.oldText, new_text: args.newText, expectedVersion }, callContext, { key: "book-file-edit" });
		const output = nested.structuredOutput;
		return { isError: nested.isError, output: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output ?? nested.diagnostics) }], details: { target: "file", action, path: filePath, expectedVersion, change: true } };
	}
	// Unadvertised transcript-replay fallback: new calls go through the top-level `read` tool.
	if (target === "file" && action === "read") {
		const tokenCeiling = readBatchAllowance(api?.conversationId, api?.callId);
		return runFileRead({ root, brainDir }, args, tokenCeiling === undefined ? undefined : { tokenCeiling });
	}
	if (DURABLE_TARGETS.has(target)) {
		if (target === "schema" && action === "read" && validateReference(args.ref) && args.ref.kind === "schema" && args.ref.version !== undefined) {
			let current;
			try { current = nativeReference(brainDir, "schema", args.ref.id); }
			catch (error) { return fail(`Could not resolve schema reference: ${error.message}.`); }
			if (args.ref.namespace !== current.namespace) return fail("Schema reference belongs to another brain-store namespace.");
			const retained = readReferenceVersion(brainDir, args.ref);
			if (retained !== undefined) return textResult(JSON.stringify(retained, null, 2), { ref: args.ref, status: "live", retained: true });
		}
		if (action === "list") {
			let records;
			try { records = await durableSummaries(target, brainDir, api, callContext); }
			catch (error) { return fail(`Could not resolve ${target} records: ${error.message}.`); }
			if (records.length === 0) return textResult(`${target} is empty in this conversation.`, { target, count: 0 });
			let namespace;
			try { namespace = ensureCatalog(brainDir).namespace; }
			catch (error) { return fail(`The brain-store catalog cannot be read: ${error.message}.`); }
			const items = records.map((record) => ({ ref: listRef(namespace, target, record.id, record.version), summary: summaryLine(record), provenance: record.provenance }));
			let paged;
			try { paged = listPage(items, args, target); } catch (error) { return fail(`Could not list ${target} records: ${error.message}.`); }
			return textResult(`${JSON.stringify(paged.page, null, 2)}${listFooter(paged)}`, { target, count: paged.total, shown: paged.shown, ...(paged.next ? { cursor: paged.next } : {}) });
		}
		if (action === "edit" && target === "message") {
			if (!validateReference(args.ref) || args.ref.kind !== target) return fail("message edit needs a stable message ref.");
			const currentNamespace = nativeReference(brainDir, target, args.ref.id);
			if (args.ref.namespace !== currentNamespace.namespace) return fail("Message reference belongs to another brain-store namespace.");
			let item;
			try { item = await durableRecordFor("message", args.ref.id, brainDir, api, callContext); }
			catch (error) { return fail(`Could not resolve message records: ${error.message}.`); }
			if (item === undefined) {
				const forgotten = loadContext(brainDir).forgottenEntries ?? [];
				if (forgotten.includes(args.ref.id)) return textResult("Message updated.", { status: "soft_forgotten", replay: true });
				// Crash recovery: the forget marker may exist in the transcript even though this store lost the update.
				let markerExists = false;
				try {
					markerExists = await api.commit(async (tx) => {
						const conversations = await scanAll((cursor) => tx.scanConversations({}, POLICY.limits.taskHistory.contextEntries, cursor));
						for (const conversation of conversations) {
							const entries = await scanAll((cursor) => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, POLICY.limits.taskHistory.contextEntries, cursor));
							if (entries.some((entry) => entry.kind === "carto.book.soft-forget" && String(entry.data?.target) === String(args.ref.id))) return true;
						}
						return false;
					}, callContext);
				} catch { markerExists = false; }
				if (markerExists) {
					updateContext(brainDir, (store) => {
						store.forgottenEntries = [...new Set([...(store.forgottenEntries ?? []), String(args.ref.id)])];
						const strip = (shelf) => (Array.isArray(shelf) ? shelf.filter((placement) => !(placement?.target?.kind === "message" && placement.target.id === String(args.ref.id))) : shelf);
						store.shelf = strip(store.shelf);
						for (const task of Object.values(store.tasks ?? {})) if (Array.isArray(task?.shelf)) task.shelf = strip(task.shelf);
						if (store.front && Array.isArray(store.front.shelf)) store.front.shelf = strip(store.front.shelf);
					});
					return textResult("Message updated.", { status: "soft_forgotten", replay: true });
				}
				return fail("Message is unavailable or already removed from ordinary recall.");
			}
			const expected = args.expectedVersion ?? args.ref.version ?? item.version;
			if (expected !== item.version) return fail(`Stale message edit: expectedVersion must match current version ${item.version}. Nothing was changed.`);
			const owner = item.provenance.conversationId;
			const entryId = item.provenance.entryId;
			const timestamp = item.value.message.timestamp;
			const text = typeof item.value.message.content === "string" ? item.value.message.content : (item.value.message.content ?? []).flatMap((part) => part?.type === "text" ? [part.text] : []).join("");
			try {
				await api.commit(async (tx) => {
					let cursor;
					do {
						const page = await tx.scanEntries({ conversationId: owner, order: "ascending" }, POLICY.limits.taskHistory.contextEntries, cursor);
					if (page.items.some((entry) => entry.kind === "carto.book.soft-forget" && entry.data?.operationId === String(api.taskId))) return;
					cursor = page.next;
				} while (cursor !== undefined);
					const original = await tx.entry(entryId);
					if (original === undefined || original.conversationId !== owner || !original.model?.some((message) => ["user", "assistant"].includes(message.role))) throw new Error("The selected message is no longer visible in its conversation.");
					await tx.appendEntry(owner, { kind: "carto.book.soft-forget", edits: [{ target: entryId, action: "omit" }], data: { operationId: String(api.taskId), target: String(entryId) } });
				}, callContext);
				recordSoftForgetPending(brainDir, { operationId: String(api.taskId), entryId: String(entryId), timestamp, text });
				const removedShelf = [];
				updateContext(brainDir, (store) => {
					store.forgottenEntries = [...new Set([...(store.forgottenEntries ?? []), String(entryId)])];
					store.chat = store.chat.filter((line) => !(line.at === timestamp && line.text === text));
					const strip = (shelf) => shelf.filter((placement) => {
						if (placement.target?.kind === "message" && placement.target.id === String(entryId)) { removedShelf.push(placement); return false; }
						return true;
					});
					store.shelf = strip(store.shelf);
					for (const task of Object.values(store.tasks)) if (Array.isArray(task?.shelf)) task.shelf = strip(task.shelf);
					if (store.front && Array.isArray(store.front.shelf)) store.front.shelf = strip(store.front.shelf);
				});
				if (removedShelf.length) cleanupShelfSnapshots(brainDir, removedShelf);
				return textResult("Message updated.", { status: "soft_forgotten" });
			} catch (error) { return fail(`Message edit refused: ${error.message}.`); }
		}
		if (action !== "read") return unsupported(target, action);
		if (!validateReference(args.ref) || args.ref.kind !== target) return fail(`${target} ${action} needs a ${target} reference.`);
		let currentNamespace;
		try { currentNamespace = nativeReference(brainDir, target, args.ref.id); }
		catch (error) { return fail(`Could not resolve ${target} reference: ${error.message}.`); }
		if (args.ref.namespace !== currentNamespace.namespace) return fail(`${target} reference belongs to another brain-store namespace.`);
		let found;
		try { found = await durableRecordFor(target, args.ref.id, brainDir, api, callContext); }
		catch (error) { return fail(`Could not resolve ${target} records: ${error.message}.`); }
		if (found === undefined) {
			if (target === "message" && loadContext(brainDir).forgottenEntries?.includes(args.ref.id)) return fail("Message is no longer available through ordinary recall.");
			const historical = args.ref.version === undefined ? undefined : readReferenceVersion(brainDir, args.ref);
			if (historical === undefined) return fail(`${target} ${args.ref.id} is deleted or inaccessible.`);
			return textResult(JSON.stringify(historical, null, 2), { ref: args.ref, status: "stale" });
		}
		if (args.ref.version !== undefined && args.ref.version !== found.version) {
			const historical = readReferenceVersion(brainDir, args.ref);
			if (historical === undefined) return fail(`${target} reference is stale: requested ${args.ref.version}, current ${found.version}; the requested immutable version is unavailable.`);
			return textResult(JSON.stringify(historical, null, 2), { ref: args.ref, status: "stale", currentVersion: found.version });
		}
		const ref = nativeReference(brainDir, target, found.id, found.version);
		return textResult(JSON.stringify(found.value, null, 2), { ref, status: "live" });
	}
	if (target === "assessment") {
		if (action !== "write") return unsupported(target, action);
		let text = typeof args.text === "string" ? args.text.trim() : "";
		if (text === "") return withGuide(target, action, fail("assessment write needs `text`: the whole assessment; it replaces the current one."));
		if (text.length > ASSESSMENT_MAX) {
			const clipped = `${text.slice(0, ASSESSMENT_MAX - 1).trimEnd()}…`;
			warn(clipNote("The assessment", text, clipped, ASSESSMENT_MAX, { extra: "Keep what I would need first with an empty context, and put the details in nodes of the atlas.", remedy: "the same call again with the shorter text (there is no partial edit of the assessment)" }));
			text = clipped;
		}
		saveAssessment(brainDir, text);
		noteAssessed(brainDir, text);
		return textResult(`Assessment saved (${text.length} characters) to ${assessmentPath(brainDir)}. The copy at the top of my context is replaced when a goal closes or a fresh context starts; until then this call is the text that counts.`, { target, action, shown: [`assessment written, ${text.length} characters`] });
	}
	if (BRAIN_TARGETS.has(target)) {
		if (action === "list") {
			let records;
			try { records = listBrainRecords(target, brainDir); }
			catch (error) { return fail(error.message); }
			if (records.length === 0) return textResult(`${target} is empty.`, { target, count: 0 });
			let namespace;
			try { namespace = ensureCatalog(brainDir).namespace; }
			catch (error) { return fail(`The brain-store catalog cannot be read: ${error.message}.`); }
			const items = records.map((record) => {
				const id = record.id;
				return { ref: listRef(namespace, target, id, contentVersion(record)), summary: String(record.text ?? record.gist ?? record.brief ?? record.name ?? record.id ?? "").replace(/\s+/g, " ").slice(0, 240) };
			});
			let paged;
			try { paged = listPage(items, args, target); } catch (error) { return fail(`Could not list ${target} records: ${error.message}.`); }
			return textResult(`${JSON.stringify(paged.page, null, 2)}${listFooter(paged)}`, { target, count: paged.total, shown: paged.shown, ...(paged.next ? { cursor: paged.next } : {}) });
		}
		if (action === "read") {
			if (!validateReference(args.ref) || args.ref.kind !== target) return fail(`${target} ${action} needs a ${target} \`id\`.`);
			let current;
			try { current = nativeReference(brainDir, target, args.ref.id); }
			catch (error) { return fail(`Could not resolve ${target} reference: ${error.message}.`); }
			if (args.ref.namespace !== current.namespace) return fail(`The ${target} reference belongs to another brain-store namespace.`);
			let found;
			try { found = brainRecord(target, brainDir, args.ref.id); }
			catch (error) { return fail(error.message); }
			if (found === undefined) {
				const historical = args.ref.version === undefined ? undefined : readReferenceVersion(brainDir, args.ref);
				if (historical === undefined) return fail(`${target} ${args.ref.id} is deleted or unavailable.`);
				return textResult(JSON.stringify(historical, null, 2), { ref: args.ref, status: "stale" });
			}
			if (args.ref.version !== undefined && args.ref.version !== found.version) {
				const historical = readReferenceVersion(brainDir, args.ref);
				if (historical === undefined) return fail(`${target} reference is stale: requested ${args.ref.version}, current ${found.version}; historical content is unavailable.`);
				return textResult(JSON.stringify(historical, null, 2), { ref: args.ref, status: "stale", currentVersion: found.version });
			}
			const ref = nativeReference(brainDir, target, found.record.id ?? args.ref.id, found.version);
			return textResult(JSON.stringify(found.record, null, 2), { ref, status: "live" });
		}
		if (target === "context" && (action === "fold" || action === "recall" || action === "note" || action === "collapse")) {
			const contextOp = {
				action,
				...(args.id !== undefined ? { id: args.id } : {}),
				...(args.text !== undefined ? { text: args.text } : {}),
			};
			return withGuide(target, action, runContext({ root, brainDir, config, engine }, { ops: [contextOp] }, api));
		}
		if (target === "atlas" && (action === "look" || action === "tree")) {
			const { atlas, error } = loadAtlas(brainDir);
			if (atlas === undefined) return fail(`The atlas cannot be read: ${error}. Nothing was changed.`);
			const { plan } = loadPlan(brainDir);
			const atlasOp = action === "look"
				? { action, ...(args.name !== undefined || args.path !== undefined || args.id !== undefined ? { name: args.name ?? args.path ?? args.id } : {}) }
				: { action, ...(args.anchor !== undefined ? { anchor: args.anchor } : {}), ...(args.depth !== undefined ? { depth: args.depth } : {}) };
			try {
				const result = applyAtlasOp(atlas, atlasOp, { root, now: new Date(api.now()).toISOString(), by: main ? POLICY.enums.atlasAuthors.main : POLICY.enums.atlasAuthors.task, main, files: () => projectFiles(root), created: [], mayCreate: gate?.yolo === true || (plan !== undefined && isAuthorized(plan)) });
				if (result.changed) saveAtlas(brainDir, atlas);
				return textResult(result.line, { target, action, changed: result.changed, shown: result.shown });
			} catch (error) { return error instanceof AtlasError ? withGuide("atlas", action, fail(`Atlas ${action} refused: ${error.message}.`)) : Promise.reject(error); }
		}
		if (!BRAIN_MUTATIONS[target]?.has(action)) return unsupported(target, action);
		if (target === "plan" && !main) return fail(`Tool call blocked: ${TASK_REFUSALS.plan} ${STILL_TASK}`);
		const needsRef = action !== "add" && !(target === "plan" && action === "clear") && !(target === "atlas" && action === "confirm" && args.ref === undefined);
		let current;
		if (needsRef) {
			if (!validateReference(args.ref) || args.ref.kind !== target) return fail(`${target} ${action} needs a ${target} \`id\`.`);
			try {
				const namespace = nativeReference(brainDir, target, args.ref.id);
				if (args.ref.namespace !== namespace.namespace) return fail(`The ${target} reference belongs to another brain-store namespace.`);
			} catch (error) { return fail(`Could not resolve ${target} reference: ${error.message}.`); }
			try { current = brainRecord(target, brainDir, args.ref.id); }
			catch (error) { return fail(error.message); }
			if (current === undefined) return fail(`${target} ${args.ref.id} is deleted or unavailable.`);
			const expected = args.expectedVersion ?? args.ref.version ?? current.version;
			if (expected !== current.version) return fail(`Stale ${target} mutation: expectedVersion must match current version ${current.version}. Nothing was changed.`);
		}
		if (target === "atlas") {
			const { atlas, error } = loadAtlas(brainDir);
			if (atlas === undefined) return fail(`The atlas cannot be read: ${error}. Nothing was changed.`);
			if (atlas.lastCall === api.taskId) return textResult("This atlas operation was already applied before a restart.", { replay: true });
			const atlasOp = {
				action,
				...(needsRef ? { name: current.record.id } : args.name !== undefined ? { name: args.name } : {}),
				...(args.gist !== undefined ? { gist: args.gist } : {}),
				...(args.detail !== undefined ? { detail: args.detail } : {}),
				...(args.files !== undefined ? { files: args.files } : {}),
				...(args.links !== undefined ? { links: args.links } : {}),
				...(args.to !== undefined ? { to: args.to } : {}),
				...(args.names !== undefined ? { names: args.names } : {}),
			};
			const { plan } = loadPlan(brainDir);
			try {
				const result = applyAtlasOp(atlas, atlasOp, { root, now: new Date(api.now()).toISOString(), by: main ? POLICY.enums.atlasAuthors.main : POLICY.enums.atlasAuthors.task, main, files: () => projectFiles(root), created: [], mayCreate: gate?.yolo === true || (plan !== undefined && isAuthorized(plan)) });
				if (result.changed) { atlas.lastCall = api.taskId; saveAtlas(brainDir, atlas); }
				return textResult(result.line, { target, action, changed: result.changed, shown: result.shown });
			} catch (error) { return error instanceof AtlasError ? withGuide("atlas", action, fail(`Atlas ${action} refused: ${error.message}.`)) : Promise.reject(error); }
		}
		if (target === "ledger") {
			const ledgerOp = {
				action,
				...(needsRef ? { id: current.record.id } : {}),
				...(args.kind !== undefined ? { kind: args.kind } : {}),
				...(args.text !== undefined ? { text: args.text } : action === "done" && args.outcome !== undefined ? { text: args.outcome } : {}),
				...(args.done_when !== undefined ? { done_when: args.done_when } : {}),
				...(args.salient !== undefined ? { salient: args.salient } : {}),
				...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
			};
			return withGuide(target, action, runLedger({ brainDir, engine }, { ops: [ledgerOp] }, api));
		}
		if (target === "plan") {
			const planOp = {
				action,
				...(needsRef ? { id: current.record.id } : {}),
				...(args.mode !== undefined ? { mode: args.mode } : {}),
				...(args.text !== undefined ? { text: args.text } : action === "done" && args.outcome !== undefined ? { text: args.outcome } : {}),
				...(args.before !== undefined ? { before: args.before } : {}),
				...(args.network !== undefined ? { network: args.network } : {}),
				...(args.standing !== undefined ? { standing: args.standing } : {}),
				...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
			};
			return withGuide(target, action, runPlan({ brainDir, gate }, { ops: [planOp] }, api));
		}
		if (target === "context") {
			if (action === "archive" || action === "restore") {
				try { return textResult(applyContextRowAction(brainDir, current.record.id, action === "restore" ? POLICY.enums.actions.unarchive : POLICY.enums.actions.archive, undefined, api.taskId), { target, action, ref: args.ref }); }
				catch (error) { return withGuide(target, action, fail(`Context row ${action} refused: ${error.message}.`)); }
			}
		}
	}
	if (target === "report" && action === "list") {
		let reportNamespace;
		try { reportNamespace = ensureCatalog(brainDir).namespace; } catch (error) { return fail(`The brain-store catalog cannot be read: ${error.message}.`); }
		const reports = composedRows(loadContext(brainDir)).map((row) => {
			const body = loadReport(brainDir, row.id);
			if (body === undefined) return undefined;
			return { ref: listRef(reportNamespace, "report", row.id, reportVersion(body)), archived: row.archived === true, summary: row.brief ?? row.outcome ?? "" };
		}).filter(Boolean);
		if (reports.length === 0) return textResult("No reports are available.", { target, count: 0 });
		let paged;
		try { paged = listPage(reports, args, "report"); } catch (error) { return fail(`Could not list reports: ${error.message}.`); }
		return textResult(`${JSON.stringify(paged.page, null, 2)}${listFooter(paged)}`, { target, count: paged.total, shown: paged.shown, ...(paged.next ? { cursor: paged.next } : {}) });
	}
	if (target === "report" && ["read", "recall", "archive", "restore", "remove"].includes(action)) {
		const ref = args.ref;
		if (!validateReference(ref) || ref.kind !== "report") return fail("Invalid report reference; expected at least an `id`.");
		let current;
		try {
			current = nativeReference(brainDir, "report", ref.id);
			if (ref.namespace !== current.namespace) return fail("Report reference belongs to another brain-store namespace.");
		} catch (error) { return fail(`Could not resolve report reference: ${error.message}.`); }
		const store = loadContext(brainDir);
		const row = composedRows(store).find((entry) => entry.id === ref.id);
		const body = row === undefined ? undefined : loadReport(brainDir, ref.id);
		if (body === undefined) return fail(`Report ${ref.id} is deleted or unavailable.`);
		const version = reportVersion(body);
		if (ref.version !== undefined && ref.version !== version) return fail(`Report version is stale: requested ${ref.version}, current ${version}.`);
		if (action === "read") return textResult(body, { status: "live", ref: { ...current, version } });
		if (action === "recall") return runContext({ root, brainDir, config, engine }, { ops: [{ action: POLICY.enums.actions.recall, id: ref.id }] }, api);
		const expected = args.expectedVersion ?? ref.version ?? version;
		if (expected !== version) return fail(`Stale report mutation: expectedVersion must match current version ${version}. Nothing was changed.`);
		try {
			const rowAction = action === "archive" ? POLICY.enums.actions.archive : action === "restore" ? POLICY.enums.actions.unarchive : POLICY.enums.actions.delete;
			return textResult(applyContextRowAction(brainDir, ref.id, rowAction, undefined, api.taskId), { status: action === "remove" ? "deleted" : "live", ref: { ...current, version } });
		} catch (error) { return fail(`Report ${action} refused: ${error.message}.`); }
	}
	// Unadvertised transcript-replay fallback: new calls go through the top-level `shelf` tool.
	if (target === "shelf") {
		return runShelf({ root, brainDir, config }, action, args, api, callContext);
	}
	return unsupported(target, action);
}

/** The only book that belongs exclusively to the orchestrator is the plan. */
const TASK_REFUSALS = { plan: REFUSALS.taskWritesPlan };

/** The label an operation carries when it could not be applied ("add g1"). */
const opLabel = (op, second) => `${op?.action ?? "?"} ${op?.id ?? op?.[second] ?? ""}`.trim();

/** The ledger's run: see the `ledger` tool this replaces (src/tools/ledger.mjs in the last release). */
function runLedger({ brainDir, engine }, args, api) {
	const ops = Array.isArray(args.ops) ? args.ops : [];
	if (ops.length === 0) return fail("`ops` is empty: give at least one operation.");
	const { ledger, error } = loadLedger(brainDir);
	if (ledger === undefined) {
		return fail(`The ledger cannot be read: ${error}. It was probably edited by hand. Nothing was changed. Tell ${USER_NAME}; they have to repair the file.`);
	}
	// This call ran before and was cut off after saving (a crash, then a restart): do not apply it twice.
	if (ledger.lastCall === api.taskId) {
		return { output: [{ type: "text", text: `These operations were already applied, before a restart.\nOpen: ${openCounts(ledger)}.` }], details: { shown: ["(applied before the restart)"] } };
	}

	const lines = [];
	const shown = [];
	let applied = 0;
	const now = new Date(api.now()).toISOString();
	const goalsBefore = new Set(open(ledger, POLICY.enums.ledgerKind.goal).map((item) => item.id));
	for (const [index, op] of ops.entries()) {
		try {
			const result = applyOp(ledger, op, now);
			lines.push(result.line);
			shown.push(result.shown);
			applied++;
		} catch (problem) {
			if (!(problem instanceof LedgerError)) throw problem;
			lines.push(`Op ${index + 1} (${opLabel(op, "kind")}) not applied: ${problem.message}`);
		}
	}
	if (applied === 0) return fail(lines.join("\n"));
	if (applied < ops.length) lines.push(`${applied} of ${ops.length} applied and saved; send only the ones not applied again.`);
	lines.push(`Open: ${openCounts(ledger)}.`);
	// A goal that closes is a moment to bring the top of the context up to date (src/top.mjs). Done before the
	// ledger is saved: a crash in between then repeats both, and neither is done twice.
	const closed = [...goalsBefore].filter((id) => ledger.items.find((item) => item.id === id)?.status === POLICY.enums.entryStatus.done);
	let pinned = false;
	if (closed.length > 0) {
		pinned = pin(brainDir, { now: api.now(), reason: `goal ${closed.join(", ")} was closed` }).changed;
		if (pinned) lines.push("The copy of my assessment and graph at the top of my context was rewritten to what they are now.");
		// And the moment to collapse the context: the work for that goal is done (src/engine.mjs).
		engine?.want(`goal ${closed.join(", ")} was closed`);
	}
	prune(ledger);
	ledger.lastCall = api.taskId;
	saveLedger(brainDir, ledger);
	return { output: [{ type: "text", text: lines.join("\n") }], details: { shown, ...(pinned ? { pinned: true } : {}) } };
}

/** The plan's run: see the `plan` tool this replaces (src/tools/plan.mjs in the last release). */
function runPlan({ brainDir, gate }, args, api) {
	const ops = Array.isArray(args.ops) ? args.ops : [];
	if (ops.length === 0) return fail("`ops` is empty: give at least one operation.");
	const { plan, error } = loadPlan(brainDir);
	if (plan === undefined) return fail(`The plan cannot be read: ${error}. It was probably edited by hand. Nothing was changed. Tell ${USER_NAME}; they have to repair the file.`);
	if (plan.lastCall === api.taskId) {
		return { output: [{ type: "text", text: `These operations were already applied, before a restart.\n${authorizationLine(plan)}` }], details: { shown: ["(applied before the restart)"] } };
	}

	const lines = [];
	const shown = [];
	let applied = 0;
	let withdrawn = false;
	const now = new Date(api.now()).toISOString();
	for (const [index, op] of ops.entries()) {
		try {
			const result = applyPlanOp(plan, op, now, { yolo: gate?.yolo === true });
			lines.push(result.line);
			shown.push(result.shown);
			withdrawn ||= result.withdrawn === true;
			applied++;
		} catch (problem) {
			if (!(problem instanceof PlanError)) throw problem;
			let message = problem.message;
			if (op?.action === POLICY.enums.actions.add && (typeof op.text !== "string" || op.text.trim() === "")) {
				const expected = { target: "plan", action: POLICY.enums.actions.add, mode: op.mode === POLICY.enums.planMode.look ? "look" : "change", text: "one-line description of what this item covers" };
				message += `\n\nCall received (exact arguments):\n${JSON.stringify(args, null, 2)}\n\nExpected shape for a plan add:\n${JSON.stringify(expected, null, 2)}\nThe item's wording belongs in \`text\`, not \`lines\`. Correct the call; do not repeat it unchanged.`;
			}
			lines.push(`Op ${index + 1} (${opLabel(op, "mode")}) not applied: ${message}`);
		}
	}
	if (applied === 0) return fail(lines.join("\n"));
	if (applied < ops.length) lines.push(`${applied} of ${ops.length} applied and saved; send only the ones not applied again.`);
	if (plan.items.length > 0) lines.push(authorizationLine(plan, { yolo: gate?.yolo === true }));
	if (withdrawn) shown.push("authorization withdrawn: a change item was added or changed");
	plan.lastCall = api.taskId;
	savePlan(brainDir, plan);
	return { output: [{ type: "text", text: lines.join("\n") }], details: { shown } };
}

/** The context operations' run, now carried by flat `book` target=context actions. */
function runContext({ root, brainDir, config, engine }, args, api) {
	const main = api.conversationId === ROOT_CONVERSATION_ID;
	const ops = Array.isArray(args.ops) ? args.ops : [];
	let store = loadContext(brainDir);
	const messages = engine.messagesOf(api.conversationId) ?? [];
	const lines = [];
	const shown = [];
	try {
		for (const op of ops) {
			const action = op?.action;
			if ([POLICY.enums.actions.archive, POLICY.enums.actions.unarchive, POLICY.enums.actions.delete].includes(action)) {
				const id = String(op.id ?? "").trim();
				if (id === "") return fail(`${action} needs \`id\`: the context row to change.`);
				const result = applyContextRowAction(brainDir, id, action, op.when, api.taskId);
				store = loadContext(brainDir);
				shown.push(`${action} ${id}`);
				lines.push(`${result}${op.when === POLICY.enums.contextVisibility.nextBoundary ? " The saved change takes effect in context at the next boundary." : " It takes effect in context now."}`);
				continue;
			}
			if (action === POLICY.enums.actions.recall) {
				const id = String(op.id ?? "").trim();
				if (id === "") return fail(`recall needs \`id\`: the report to bring back.${composedRows(store).length > 0 ? ` Kept: ${composedRows(store).slice(-POLICY.limits.bookTool.keptBookEntries).map((record) => record.id).join(", ")}.` : " No report is kept yet."}`);
				const report = loadReport(brainDir, id);
				if (report === undefined) return fail(`There is no report ${id}.${composedRows(store).length > 0 ? ` Kept: ${composedRows(store).slice(-POLICY.limits.bookTool.keptBookEntries).map((record) => record.id).join(", ")}.` : " No report is kept yet."}`);
				if (reportsInView(messages).has(id) && !store.dropped.includes(id)) return fail(`Report ${id} is still in my context, further up: nothing was added.`);
				// A report the main agent dropped comes back by this, too.
				if (main && store.dropped.includes(id)) {
					updateContext(brainDir, (next) => {
						next.dropped = next.dropped.filter((entry) => entry !== id);
					});
					shown.push(`recalled ${id} · back in its place`);
					lines.push(`Report ${id} stands in its place again, further up.`);
					continue;
				}
				shown.push(`recalled ${id} · about ${count(estimate(report))} tokens`);
				lines.push(`${report}\n\n${RECALLED}`);
				continue;
			}

			if (action === POLICY.enums.actions.shelve) {
				const mine = main ? store.shelf : (store.tasks[api.conversationId]?.shelf ?? []);
				const { item, tokens, backing } = shelfItem(root, op.path, op.lines, brainDir, mine);
				const others = mine.filter((entry) => !sameItem(entry, item));
				const total = others.reduce((sum, entry) => sum + estimate(shelfText(root, entry, brainDir)), 0) + tokens;
				persistShelfSnapshot(brainDir, item, backing);
				const handOn = !main && op.hand_on === true;
				updateContext(brainDir, (next) => {
					const list = main ? next.shelf : (taskState(next, api.conversationId).shelf ??= []);
					const at = list.findIndex((entry) => sameItem(entry, item));
					const entry = { ...item, ...(handOn ? { handOn: true } : {}) };
					if (at >= 0) list[at] = entry;
					else list.push(entry);
				});
				store = loadContext(brainDir);
				const size = `about ${count(tokens)} rendered tokens; the shelf then holds about ${count(total)}`;
				shown.push(`shelved ${shelfLabel(item)} as ${item.id} · about ${count(tokens)} rendered tokens${handOn ? " · handed on to the main agent at the end" : ""}`);
				lines.push(
					main
						? `${shelfLabel(item)} is on my shelf as ${item.id} (${size}). For project files, the full snapshot is backed under .brain; selected content is in view now and will stand at the start after the next collapse; every task begins with it read.\n\n${item.snapshot}`
						: `${shelfLabel(item)} is on my shelf as ${item.id} (${size}). For project files, the full snapshot is backed under .brain; selected content is in view now and stays when my steps are collapsed.${handOn ? " When I return, it goes onto the orchestrating context's shelf as well." : ""}\n\n${item.snapshot}`,
				);
				continue;
			}

			if (action === POLICY.enums.actions.unshelve) {
				const given = String(op.path ?? "").trim();
				if (given === "") return fail("unshelve needs `path`: a file or shelf item ID to take off the shelf, or all.");
				const mine = main ? store.shelf : (store.tasks[api.conversationId]?.shelf ?? []);
				const gone = given === "all" ? mine : mine.filter((entry) => entry.id === given || shelfLabel(entry) === given || entry.path === given || entry.path === given.replace(/^\.\//, ""));
				if (gone.length === 0) return fail(`${given} is not on my shelf.${mine.length > 0 ? ` On it: ${mine.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}.` : " The shelf is empty."}`);
				updateContext(brainDir, (next) => {
					if (main) next.shelf = next.shelf.filter((entry) => !gone.some((other) => sameItem(other, entry)));
					else taskState(next, api.conversationId).shelf = mine.filter((entry) => !gone.some((other) => sameItem(other, entry)));
				});
				cleanupShelfSnapshots(brainDir, gone);
				shown.push(`unshelved ${gone.map((item) => `${shelfLabel(item)} as ${item.id}`).join(", ")}`);
				lines.push(`Taken off my shelf: ${gone.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}.${main ? " A copy that stands in my context stays there until the next collapse." : ""}`);
				continue;
			}

			if (action === POLICY.enums.actions.fold) {
				const ids = String(op.id ?? "")
					.split(/[\s,]+/)
					.filter((id) => id !== "");
				if (ids.length === 0) return fail(`fold needs \`id\`: ${main ? "the report to drop from view, like t12" : "the step to drop, like s3; large results end with a mark that names theirs"}.`);
				if (main) {
					const inView = reportsInView(messages);
					const unknown = ids.filter((id) => !inView.has(id) || store.dropped.includes(id));
					if (unknown.length > 0) {
						const open = [...inView.keys()].filter((id) => !store.dropped.includes(id));
						return fail(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in my context in full, so there is nothing to drop.${open.length > 0 ? ` In full: ${open.join(", ")}.` : " No report is."}`);
					}
					updateContext(brainDir, (next) => {
						next.dropped = [...new Set([...next.dropped, ...ids])];
					});
					const freed = ids.reduce((sum, id) => sum + inView.get(id).tokens, 0);
					const first = Math.min(...ids.map((id) => inView.get(id).index));
					const again = messages.slice(first + 1).reduce((sum, message) => sum + messageTokens(message), 0);
					shown.push(`dropped ${ids.join(", ")} · about ${count(freed)} tokens freed`);
					lines.push(
						`Dropped from view: ${ids.join(", ")}, about ${count(freed)} tokens. In ${ids.length === 1 ? "its" : "their"} place stands the record line. The server reads what follows again, about ${count(again)} tokens. ${ids.length === 1 ? `Its record: ${recordLine(composedRows(store).find((record) => record.id === ids[0]) ?? { id: ids[0], at: Date.now(), mode: POLICY.enums.planMode.look, brief: "?", outcome: "?" })}` : "recall brings one back."}`,
					);
					continue;
				}
				const steps = stepsOf(messages);
				const mine = store.tasks[api.conversationId] ?? {};
				const hidden = mine.cut?.steps ?? 0;
				const inView = (steps?.results ?? []).filter((result) => result.index >= steps.start + hidden && mine.dropped?.[result.id] === undefined);
				const unknown = ids.filter((id) => !inView.some((result) => result.id === id));
				if (unknown.length > 0) {
					const large = inView.filter((result) => result.tokens >= POLICY.limits.context.largeResultTokens);
					return fail(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a result in my view.${large.length > 0 ? ` My larger results: ${large.map((result) => `${result.id} (${engine.callWords(result.call)}, about ${count(result.tokens)} tokens)`).join("; ")}.` : " I have no large result in view."}`);
				}
				const picked = inView.filter((result) => ids.includes(result.id));
				updateContext(brainDir, (next) => {
					const task = taskState(next, api.conversationId);
					task.dropped ??= {};
					for (const id of ids) task.dropped[id] = "I dropped this result.";
				});
				const freed = picked.reduce((sum, result) => sum + result.tokens, 0);
				const again = messages.slice(Math.min(...picked.map((result) => result.index)) + 1).reduce((sum, message) => sum + messageTokens(message), 0);
				shown.push(`dropped ${ids.join(", ")} · about ${count(freed)} tokens freed`);
				lines.push(`Dropped: ${ids.join(", ")}, about ${count(freed)} tokens. The server reads what follows again, about ${count(again)} tokens.`);
				continue;
			}

			if (action === POLICY.enums.actions.note) {
				if (main) return fail(REFUSALS.mainNotes);
				const raw = String(op.text ?? "").trim();
				if (raw === "") return fail("note needs `text`: what to keep, with file paths and line numbers.");
				const noteMax = POLICY.limits.task.noteChars;
				const note = raw.length > noteMax ? (() => {
					const clipped = `${raw.slice(0, noteMax - 1).trimEnd()}…`;
					warn(clipNote("`text` (the note)", raw, clipped, noteMax, { remedy: "nothing edits a note; put the substance in the ledger and keep the note short" }));
					return clipped;
				})() : raw;
				updateContext(brainDir, (next) => {
					(taskState(next, api.conversationId).notes ??= []).push(note);
				});
				shown.push(`noted · ${count(note.length)} characters`);
				lines.push("Noted. It stays when my steps are collapsed.");
				continue;
			}

			if (action === POLICY.enums.actions.collapse) {
				const why = String(op.text ?? "").replace(/\s+/g, " ").trim().slice(0, POLICY.limits.bookTool.refusalChars);
				if (main) {
					engine.want(why === "" ? "I asked for it" : `I asked for it: ${why}`, { asked: true, byAgent: true });
					shown.push("collapse asked for");
					lines.push("My context is collapsed when the calls of this reply are done. My next request begins with what was kept.");
					continue;
				}
				if (stepsOf(messages) === undefined) return fail("My steps cannot be found, so nothing was collapsed.");
				updateContext(brainDir, (next) => {
					Object.assign(taskState(next, api.conversationId), { pending: "now", reason: why === "" ? "I asked for it" : `I asked for it (${why})` });
				});
				shown.push("collapse of its steps asked for");
				lines.push("My steps so far are collapsed before my next reply. I keep the brief, my notes, my shelf and one line for each call.");
				continue;
			}
			return fail("`action` is one of archive, unarchive, delete, recall, shelve, unshelve, fold, note, collapse. To keep a note in view across collapses, use `target=ledger, action=add` with `kind=note` and `salient: true`.");
		}
	} catch (problem) {
		if (!(problem instanceof ShelfError) && !(problem instanceof ContextRowError)) throw problem;
		return fail(problem.message);
	}
	return { output: [{ type: "text", text: lines.join("\n") }], details: { shown } };
}

/**
 * @param {{ root: string, brainDir: string, config: object, engine: object, gate?: { yolo: boolean } }} input
 */
export function bookTool({ root, brainDir, config, engine, gate }) {
	/** One flat declaration: the provider grammar stays a root-level object (llama.cpp/Qwen-safe), closed enums, everything optional except target and action. */
	const validationSchema = obj({
		target: str({ enum: UNIVERSAL_TARGETS, description: "The surface to act on: file (create/edit/remove/rebind), report, ledger, plan, atlas, assessment, context, or a Durable record family. Use top-level `read` and `shelf` to inspect or pin files." }),
		action: str({ enum: UNIVERSAL_ACTIONS, description: "One action on that target. Unsupported target/action pairs fail closed." }),
		id: opt(str({ minLength: 1, maxLength: 256, description: "Stable ID of the item to act on (plan p1, ledger g1/q1/n1, atlas c1 or node name, file f1, report t1, Durable record). Points at the live version." })),
		ref: opt(REFERENCE_SCHEMA),
		path: opt(str({ description: "Project-relative file path for file create/edit/remove/rebind or atlas look." })),
		cursor: opt(str({ description: "Opaque page token from a previous list result; omit for the first page." })),
		text: opt(str({ description: "Body text for ledger add/edit/done, plan add/edit/done, assessment write, or context note/collapse." })),
		kind: opt(str({ enum: Object.values(POLICY.enums.ledgerKind), description: "Ledger entry kind on ledger add: goal, question, or note." })),
		done_when: opt(str({ description: "Observable completion test for a ledger goal (required on ledger add when kind is goal; editable on a goal)." })),
		salient: opt(bool({ description: "Mark or unmark a ledger note as salient so it stands in every request and across collapses." })),
		mode: opt(str({ enum: Object.values(POLICY.enums.planMode), description: "Plan item mode on plan add/edit: look or change." })),
		before: opt(str({ description: "Plan item ID to insert or move this item before (omit on plan before to move to the end)." })),
		network: opt(bool({ description: "Allow outbound network access on a change plan item." })),
		standing: opt(bool({ description: "Allow long-lived processes on a change plan item." })),
		outcome: opt(str({ description: "Outcome wording when editing an already closed ledger entry or done plan item." })),
		name: opt(str({ description: "Atlas node name on atlas add, confirm, or look." })),
		gist: opt(str({ description: "One-line summary of an atlas node on atlas add/edit." })),
		detail: opt(str({ description: "Expanded body of an atlas node on atlas add/edit (empty string clears it)." })),
		files: opt(arr(str(), { description: "Project-relative file paths linked to an atlas node on add/edit/link/unlink." })),
		links: opt(arr(str(), { description: "Related atlas node names or IDs on add/edit/link/unlink." })),
		to: opt(str({ description: "New node name on atlas rename." })),
		names: opt(arr(str(), { description: "Multiple atlas node names or IDs on atlas confirm." })),
		anchor: opt(str({ description: 'Project folder to root the file tree at on atlas tree ("." resets to the project root).' })),
		depth: opt(int({ minimum: 1, maximum: 6, description: "Directory levels (1-6) to draw on atlas tree." })),
		content: opt(str({ description: "Whole UTF-8 text for file create." })),
		oldText: opt(str({ description: "Exact passage to replace in file edit." })),
		newText: opt(str({ description: "Replacement passage in file edit (empty string deletes oldText)." })),
		expectedVersion: opt(str({ description: "Optional SHA-256 content version precondition (required on file rebind; omit elsewhere for the live version)." })),
		planItem: opt(str({ description: "Optional authorized change plan item ID on file create/edit/remove; inferred from the active change focus when omitted." })),
	});
	const validate = compile(validationSchema, { coerce: true });
	const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
	const joinList = (items) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
	/** The generic interpreter over CAPABILITIES; the one place the call grammar is enforced. */
	const checkCall = (target, action, args, rawArgs = args) => {
		const spec = capabilityFor(target, action);
		if (spec === undefined) return { unsupported: true };
		if (nonEmpty(rawArgs?.id) && typeof rawArgs?.ref?.id === "string" && rawArgs.id.trim() !== rawArgs.ref.id.trim()) {
			return { problems: ["matching `id` and `ref.id` (pass `id` alone unless pinning `ref.version`)"] };
		}
		const problems = [];
		if (args.ref !== undefined && !validateReference(args.ref)) {
			const idOnly = spec.refInfer === true && typeof args.ref === "object" && args.ref !== null && nonEmpty(args.ref.id);
			if (!idOnly) return { problems: [spec.refInfer === true ? "id or path" : "`id` (or `ref` with `id`)"] };
		}
		if (spec.ref === "required" && args.ref === undefined) problems.push("`id`");
		if (spec.pathOk && args.ref === undefined && !nonEmpty(args.path)) problems.push(spec.refAlternative ?? "`id` or `path`");
		if (spec.confirmOk && args.ref === undefined && !nonEmpty(args.name) && !(Array.isArray(args.names) && args.names.some(nonEmpty))) problems.push("`id` (or `names`)");
		if (spec.lookOk && args.ref === undefined && !nonEmpty(args.name) && !nonEmpty(args.path)) problems.push("`id`, `name` or `path`");
		for (const field of spec.fields ?? []) if (!nonEmpty(args[field])) problems.push(field);
		for (const field of spec.exactFields ?? []) if (typeof args[field] !== "string" || args[field] === "") problems.push(field);
		for (const field of spec.stringFields ?? []) if (typeof args[field] !== "string") problems.push(field);
		return { problems };
	};
	return defineTool({
		name: "book",
		description: describe("book"),
		parameters: validationSchema,
		prepareArguments(args) {
			if (args !== null && typeof args === "object") {
				if (args.target === "shelf") {
					throw new Error('Validation failed for tool "book": the shelf is now the top-level `shelf` tool — call `shelf` with action="add" | "remove" | "list", `id` or `path`, and optional `range`.');
				}
				if (args.target === "file" && args.action === "read") {
					throw new Error('Validation failed for tool "book": reading project files is now the top-level `read` tool — call `read` with `path` or `id` and optional `range`, or `shelf` (action="add") to keep several files in view. Supported book actions for file: create, edit, remove, rebind.');
				}
			}
			const result = validate.parse(args);
			if (!result.ok) {
				const path = (pointer) => pointer === "" ? "root" : pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")).join(".");
				const errors = [...result.errors].map((error) => `  - ${path(error.path)}: ${error.message}`).join("\n");
				// Do not echo the arguments: malformed text can be very large and the agent already has its original call.
				throw new Error(`Validation failed for tool "book":\n${errors}`);
			}
			const value = result.value;
			if (value.target === undefined || value.action === undefined) throw new Error('Validation failed for tool "book": target and action are both required.');
			// The harness hands the call's arguments to tools deeply frozen; never mutate them, carry a new object.
			const prepared = normalizeArgs(brainDir, value);
			const { unsupported, problems } = checkCall(value.target, value.action, prepared, value);
			if (unsupported === true) throw new Error(`Unsupported book operation: target=${JSON.stringify(value.target)}, action=${JSON.stringify(value.action)}. No target content was resolved.${CAPABILITIES[value.target] === undefined ? "" : ` Supported actions for ${value.target}: ${Object.keys(CAPABILITIES[value.target]).join(", ")}.`}`);
			if (problems.length > 0) {
				const guide = guideFor(value.target, value.action);
				throw new Error(`Validation failed for tool "book": ${value.target} ${value.action} needs ${joinList(problems)}.${guide === undefined ? "" : ` ${value.target} ${value.action} takes: ${guide}.`}`);
			}
			return prepared;
		},

		executionMode: "sequential",
		// Safe to run again after a crash: the ledger and the plan remember the last call they applied,
		// and the rest of the brain changes nothing when the same words are written twice.
		replay: POLICY.enums.toolReplay.safe,
		// Read-only operations run inline for every context; project changes go through the one gate (§6 of
		// docs/design.md). `file rebind` still dispatches to a short focus: it is a catalog identity write.
		execute: async (args, api, callContext) => {
			if (args.target !== undefined) {
				const main = api.conversationId === ROOT_CONVERSATION_ID;
				takeWarnings(); // drop any note raised before this call started, so a call reports only its own
				if (main && args.target === "file" && args.action === "rebind") {
					const taskArgs = {
						brief: `Perform exactly one bounded book operation, then return immediately. Call book once with these exact arguments: ${JSON.stringify(args)}. Do not broaden scope, do not make project changes, and return its result.`,
					};
					const task = await api.executeTool("task", taskArgs, callContext, { key: "book-focus" });
					const nested = task.structuredOutput;
					const report = typeof nested === "string" ? nested : Array.isArray(nested) ? nested.flatMap((part) => part?.type === "text" ? [part.text] : []).join("\\n") : JSON.stringify(nested ?? task.diagnostics);
					return withNotes({ isError: task.isError, output: [{ type: "text", text: report }], details: { target: args.target, action: args.action, focus: true, ...(task.details ?? {}) } });
				}
				return withNotes(await runUniversal({ root, brainDir, config, engine, gate }, args, api, callContext));
			}
			return withNotes(fail('Validation failed for tool "book": target and action are both required.'));
		},
	});
}
