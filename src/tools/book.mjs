// The `book` tool is the single interface to the agent's durable surfaces — ledger, plan, books, atlas, context,
// Durable records, referenced entities and the shelf. Focused contexts may update the shared brain; only the
// orchestrating context can change the plan. Domain operations live in src/ledger.mjs, src/plan.mjs, src/books.mjs,
// src/atlas.mjs and src/context.mjs; this file routes target/action calls to them. One flat declaration
// (llama.cpp-safe at the root) plus one capability table drive what is offered, validated and dispatched.
import { POLICY } from "../config.mjs";
import { projectFiles } from "./look.mjs";
import { createHash } from "node:crypto";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { bool, compile, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { describe, REFUSALS, STILL_TASK } from "../prompt.mjs";
import { applyOp, LedgerError, loadLedger, open, openCounts, prune, saveLedger } from "../ledger.mjs";
import { applyPlanOp, authorizationLine, isAuthorized, loadPlan, PlanError, savePlan } from "../plan.mjs";
import { applyAtlasOp, AtlasError, loadAtlas, saveAtlas } from "../atlas.mjs";
import { applyBookOp, BookError, loadBooks, renderBook, saveBooks } from "../books.mjs";
import { ASSESSMENT_MAX, assessmentPath, saveAssessment } from "../assessment.mjs";
import { noteAssessed } from "../top.mjs";
import { pin } from "../top.mjs";
import { loadContext, loadReport, messageTokens, recordLine, reportsInView, ShelfError, shelfItem, shelfLabel, shelfReferenceItem, shelfText, estimate, stepsOf, taskState, updateContext, persistShelfSnapshot, RECALLED, composedRows, applyContextRowAction, ContextRowError, sameShelfItem, cleanupShelfSnapshots, recordSoftForgetPending } from "../context.mjs";
import { charsPerTokenNow } from "../calibrate.mjs";
import { ensureCatalog, fileReference, nativeReference, readReferenceVersion, rebindFile, resolveFile, retainReferenceVersion, validateReference, contentVersion } from "../catalog.mjs";
import { durableSummaries, durableRecordFor, scanAll } from "../index.mjs";
import { USER_NAME } from "../user.mjs";
import { takeWarnings, warn } from "../warnings.mjs";

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
/**
 * A shelf ref given an ID alone: find what kind of thing it is. Files and reports are cheap to check; the tool
 * registry and the durable index are tried after, and the durable index is the slow path, so it is tried last.
 * Returns the ref with its kind filled in, or undefined when nothing by that ID exists.
 */
const inferShelfRef = async (ref, root, brainDir, api, callContext) => {
	let namespace;
	try { namespace = ensureCatalog(brainDir).namespace; } catch { return undefined; }
	const filled = { ...ref, namespace };
	if (resolveFile(root, brainDir, { ...filled, kind: "file" }).status === "live") return { ...filled, kind: "file" };
	if (loadReport(brainDir, ref.id) !== undefined) return { ...filled, kind: "report" };
	for (const kind of ["schema", "message", "toolResult", "toolCall"]) {
		try {
			const found = await durableRecordFor(kind, ref.id, brainDir, api, callContext);
			if (found !== undefined) return { ...filled, kind };
		} catch { /* not this kind */ }
	}
	return undefined;
};
/**
 * One source of truth for what exists: target → action → validation spec. The provider declaration (enums), the
 * local validator and the executor's dispatch all derive from this table; the tool description's capability
 * matrix is written to match it. Spec fields:
 *   ref: "required" → needs a ref with an `id`; the namespace and kind are inferred, the live version is used
 *   pathOk: a ref OR an explicit project-relative path locates the thing (file read; shelf add)
 *   operation: "required" → needs the target-specific payload object; operationFields lists required non-empty
 *             string fields inside it; hint overrides the "an operation payload" wording
 *   fields: required non-empty string arguments on the call itself
 */
const CAPABILITIES = {
	file: {
		read: { pathOk: true },
		create: { fields: ["path", "content"] },
		edit: { ref: "required", fields: ["oldText", "newText"] },
		remove: { ref: "required" },
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
		add: { operation: "required" },
		edit: { ref: "required", operation: "required" },
		done: { ref: "required", operation: "required" },
		remove: { ref: "required", operation: "required" },
	},
	plan: {
		list: {},
		read: { ref: "required" },
		add: { operation: "required" },
		edit: { ref: "required", operation: "required" },
		done: { ref: "required", operation: "required" },
		remove: { ref: "required", operation: "required" },
		before: { ref: "required", operation: "required" },
	},
	atlas: {
		list: {},
		read: { ref: "required" },
		add: { operation: "required" },
		edit: { ref: "required", operation: "required" },
		link: { ref: "required", operation: "required" },
		unlink: { ref: "required", operation: "required" },
		confirm: { ref: "required", operation: "required" },
		remove: { ref: "required", operation: "required" },
		rename: { ref: "required", operation: "required", operationFields: ["to"] },
		look: { operation: "required", operationFields: ["name"] },
		tree: {},
	},
	assessment: {
		list: {},
		read: { ref: "required" },
		add: { operation: "required" },
		edit: { ref: "required", operation: "required" },
		done: { ref: "required", operation: "required" },
		remove: { ref: "required", operation: "required" },
		before: { ref: "required", operation: "required" },
	},
	practice: {
		list: {},
		read: { ref: "required" },
		add: { operation: "required" },
		edit: { ref: "required", operation: "required" },
		done: { ref: "required", operation: "required" },
		remove: { ref: "required", operation: "required" },
		before: { ref: "required", operation: "required" },
	},
	context: {
		list: {},
		read: { ref: "required" },
		archive: { ref: "required" },
		restore: { ref: "required" },
		fold: { operation: "required", operationFields: ["id"], hint: "operation { id }: the report to drop from view, like t12, or the task-step result ids" },
		note: { operation: "required", operationFields: ["text"], hint: "operation { text }: what to keep, with file paths and line numbers" },
		collapse: {},
	},
	conversation: { list: {}, read: { ref: "required" } },
	message: { list: {}, read: { ref: "required" }, edit: { ref: "required" } },
	toolCall: { list: {}, read: { ref: "required" } },
	toolResult: { list: {}, read: { ref: "required" } },
	prompt: { list: {}, read: { ref: "required" } },
	tool: { list: {}, read: { ref: "required" } },
	schema: { list: {}, read: { ref: "required" } },
	shelf: {
		list: {},
		// The namespace and the kind are inferred from the ID alone (src/tools/book.mjs, inferShelfRef); a full reference is not needed.
		add: { pathOk: true, refAlternative: "a ref or path", refInfer: true },
		remove: { fields: ["placementId"] },
	},
};
const UNIVERSAL_TARGETS = Object.keys(CAPABILITIES);
const UNIVERSAL_ACTIONS = [...new Set(Object.values(CAPABILITIES).flatMap((actions) => Object.keys(actions)))];
const capabilityFor = (target, action) => CAPABILITIES[target]?.[action];
const REFERENCE_SCHEMA = obj({
	id: str({ minLength: 1, maxLength: 256, description: "The stable ID of the entity, alone and always enough: it points at the live version. A file's ID comes from any `file read`; a record's ID from any `list`." }),
	namespace: opt(str({ minLength: 16, description: "Brain-store namespace. Inferred from this brain when omitted." })),
	kind: opt(str({ minLength: 1, maxLength: 64, pattern: "^[a-z][A-Za-z0-9_-]{0,63}$", description: "Reference kind. Inferred when omitted: from the target, or for target=shelf from what the ID is." })),
	version: opt(str({ description: "Exact immutable content version to pin; omit to resolve the live one." })),
});

const textResult = (text, details = {}) => ({ output: [{ type: "text", text }], details });
/** Append any "this was clipped for you" notes raised while the call ran. Every tool call drains, once. */
const withNotes = (result) => {
	const notes = takeWarnings();
	if (notes.length === 0) return result;
	return { ...result, output: [...(result?.output ?? []), { type: "text", text: notes.map((note) => `note: ${note}`).join("\n") }] };
};
function renderReadSelection(bytes, path, range, id) {
	let text;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw new Error("file is not valid UTF-8 text"); }
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	let from = 1;
	let to = Math.min(lines.length, POLICY.limits.look.readDefaultLines);
	if (range !== undefined && String(range).trim() !== "") {
		const match = /^(\d+)\s*(?:-|to|\.\.)\s*(\d+)$/.exec(String(range).trim());
		if (!match) throw new Error('range must look like "10-80"');
		from = Number(match[1]);
		to = Number(match[2]);
		if (from < 1 || to < from || to - from + 1 > POLICY.limits.look.readMaxLines) throw new Error(`range must be ${POLICY.limits.look.readMaxLines} lines or fewer, starting at line 1 or later`);
		if (from > lines.length && lines.length > 0) throw new Error(`file has ${lines.length} lines; line ${from} does not exist`);
		to = Math.min(to, lines.length);
	}
	const clip = POLICY.limits.look.lineChars;
	// A read returns at most about READ_TOKEN_CEILING tokens: a huge file is read in window-sized reads, not in one.
	const ceiling = POLICY.limits.look.readTokenCeiling;
	let ceilingHit = false;
	let taken = 0;
	const body = [];
	for (const line of lines.slice(Math.max(0, from - 1), to)) {
		const shown = line.length > clip ? `${line.slice(0, clip)} …[line cut: ${line.length} characters]` : line;
		const cost = Math.ceil(shown.length / charsPerTokenNow()) + 1;
		if (body.length > 0 && taken + cost > ceiling) { ceilingHit = true; break; }
		taken += cost;
		body.push(shown);
	}
	const last = from + body.length - 1;
	// The bytes as they are, so what is seen is what `edit` matches. A pathologically long line is cut and says so.
	const more = last < lines.length ? `\n${ceilingHit ? `(stopped at the ~${ceiling}-token read ceiling; ` : "("}${lines.length - last} more lines; ask for range ${last + 1}-${Math.min(lines.length, last + POLICY.limits.look.readDefaultLines)})` : "";
	return `== ${path} (lines ${from}-${Math.max(from - 1, last)} of ${lines.length}) · file ${id}\n${body.join("\n")}${more}`;
}
const unsupported = (target, action) => fail(`Unsupported book operation: target=${JSON.stringify(target)}, action=${JSON.stringify(action)}. No target content was resolved.${guideFor(target, action) === undefined && CAPABILITIES[target] !== undefined ? ` Supported actions for ${target}: ${Object.keys(CAPABILITIES[target]).join(", ")}.` : ""}`);

// ─── Error-attached guidance (Q3, 2026-11-15) ───────────────────────────────
// One line per action, appended ONLY to local failures, only for brain targets whose operation payloads are
// opaque to the declaration. Durable/report/file failures are already precise; the happy path never pays for this.
const ACTION_GUIDE = {
	ledger: {
		add: "kind (goal | question | note) and text — a goal also needs done_when; a note may take salient: true",
		edit: "id, plus text, done_when (done_when only on a goal), or salient: true/false (only on a note)",
		done: "id, plus an optional text outcome",
		remove: "id",
	},
	plan: {
		add: "mode (look | change) and text — before, network and standing optional (network/standing only with change)",
		edit: "id, plus text, mode, network or standing",
		done: "id, plus an optional text outcome",
		remove: "id",
		before: "id and before",
	},
	assessment: {
		add: "text (one short entry; the book implies the kind)",
		edit: "id and text",
		done: "id, plus an optional text outcome",
		remove: "id",
		before: "id and before",
	},
	practice: {
		add: "text (one short entry; the book implies the kind)",
		edit: "id and text",
		done: "id, plus an optional text outcome",
		remove: "id",
		before: "id and before",
	},
	atlas: {
		add: "name and gist — kind, detail, files and links optional; the node comes back with its `c<N>` id",
		edit: "the node `ref` names: gist and optional kind/detail/files/links — the name stays (`rename` moves it)",
		rename: "the node `ref` names, and `to` (its new name); what links to it is rewritten",
		confirm: "the node `ref` names — or several via operation `names`",
		link: "for the node `ref` names: files (paths) and/or links (node names or ids) — { files: [\"src/x.js\"], links: [\"other_node\"] }; the ref is the node, no `name` in the operation",
		unlink: "for the node `ref` names: files (paths) and/or links (node names or ids) to take off; the ref is the node, no `name` in the operation",
		remove: "the node `ref` names",
		look: "name (a node name, a node id such as c3, or a project path)",
		tree: "anchor and depth (folder of the project; anchor '.' is the root)",
	},
	context: {
		archive: "id",
		restore: "id",
		fold: "{ id } (an id like t12)",
		note: "{ text }",
		collapse: "{ text } optional",
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

function currentShelf(brainDir, conversationId, main) {
	const store = loadContext(brainDir);
	return main ? store.shelf : (store.tasks[conversationId]?.shelf ?? []);
}

const reportVersion = (body) => createHash("sha256").update(body).digest("hex");
const DURABLE_REF_KINDS = new Set(["message", "toolCall", "toolResult"]);
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
const BRAIN_TARGETS = new Set(["ledger", "plan", "atlas", "assessment", "practice", "context"]);
const BRAIN_MUTATIONS = {
	ledger: new Set(["add", "edit", "done", "remove"]),
	plan: new Set(["add", "edit", "done", "remove", "before"]),
	atlas: new Set(["add", "edit", "link", "unlink", "confirm", "remove", "rename"]),
	assessment: new Set(["add", "edit", "done", "remove", "before"]),
	practice: new Set(["add", "edit", "done", "remove", "before"]),
	context: new Set(["archive", "restore"]),
};
function listBrainRecords(target, brainDir) {
	if (target === "ledger") { const loaded = loadLedger(brainDir); if (!loaded.ledger) throw new Error(`The ledger cannot be read: ${loaded.error}`); return loaded.ledger.items; }
	if (target === "plan") { const loaded = loadPlan(brainDir); if (!loaded.plan) throw new Error(`The plan cannot be read: ${loaded.error}`); return loaded.plan.items; }
	if (target === "atlas") { const loaded = loadAtlas(brainDir); if (!loaded.atlas) throw new Error(`The atlas cannot be read: ${loaded.error}`); return loaded.atlas.nodes; }
	if (target === "assessment" || target === "practice") return loadBooks(brainDir).items.filter((item) => item.kind === target);
	if (target === "context") return composedRows(loadContext(brainDir));
	return [];
}
function brainRecord(target, brainDir, id) {
	const items = listBrainRecords(target, brainDir);
	const record = items.find((item) => item.id === id);
	return record === undefined ? undefined : { record, version: contentVersion(record) };
}

async function runUniversal({ root, brainDir, config, engine, gate }, given, api, callContext) {
	const main = api.conversationId === ROOT_CONVERSATION_ID;
	// Tool callers may reach here without prepareArguments: normalizing again is harmless.
	const args = { ...given, ref: normalizeRef(brainDir, given.ref, given.target) };
	const target = args.target;
	const action = args.action;
	if (target === "file" && action === "rebind") {
		if (!validateReference(args.ref) || args.ref.kind !== "file") return fail("file rebind needs a stable file reference.");
		if (typeof args.path !== "string" || typeof args.expectedVersion !== "string") return fail("file rebind needs a new confined path and the current expectedVersion.");
		try {
			const rebound = rebindFile(root, brainDir, args.ref, args.path, args.expectedVersion);
			return textResult(`Rebound the existing file identity to ${rebound.record.path}; content identity is preserved.`, { ref: rebound.ref, status: "live" });
		} catch (error) { return fail(`File rebind refused: ${error.message}.`); }
	}
	if (target === "file" && ["create", "edit", "remove"].includes(action)) {
		if (main) return fail("Project-file create/edit/remove must run in a focused change task for an authorized plan item.");
		if (typeof args.planItem !== "string" || args.planItem.trim() === "") return fail("Project-file create/edit/remove requires the authorized planItem carried by this focus.");
		// What this focus carries, recorded when it was created (src/tools/task.mjs) in the durable context store:
		// the plan item it carries out and that it is a change. Cheap to read, and right after a restart.
		// (An entry scan was tried; it cannot see an entry that sits after the first forty of a long conversation.)
		const task = loadContext(brainDir).tasks[api.conversationId];
		if (task?.mode !== POLICY.enums.planMode.change || task.item !== args.planItem) return fail("File mutation refused: this focus is not carrying that authorized change plan item.");
		let filePath = args.path;
		let expectedVersion;
		if (action === "create") {
			if (typeof filePath !== "string" || filePath.trim() === "" || typeof args.content !== "string") return fail("file create needs path and content.");
			const nested = await api.executeTool("write", { path: filePath, content: args.content }, callContext, { key: "book-file-create" });
			const output = nested.structuredOutput;
			return { isError: nested.isError, output: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output ?? nested.diagnostics) }], details: { target: "file", action, path: filePath, change: true } };
		}
		if (!validateReference(args.ref) || args.ref.kind !== "file") return fail(`file ${action} requires a stable file ref; paths alone are not mutation targets. An \`id\` alone is enough: { \"id\": \"f1\" }.`);
		if (args.expectedVersion !== undefined && (typeof args.expectedVersion !== "string" || !/^[0-9a-f]{64}$/.test(args.expectedVersion))) return fail("`expectedVersion` must be a 64-character SHA-256 digest, or be omitted: the file's ID always points at the live version.");
		const resolved = resolveFile(root, brainDir, args.ref);
		if (resolved.status !== "live") return fail(`File ${action} refused: resolver status ${resolved.status}. ${resolved.error ?? "Refresh the file reference."}`);
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
	if (target === "file" && action === "read") {
		let ref = args.ref;
		try {
			if (ref === undefined) {
				if (typeof args.path !== "string" || args.path.trim() === "") return fail(`file ${action} needs a stable \`ref\` or explicit project-relative \`path\`.`);
				ref = fileReference(root, brainDir, args.path);
			}
		} catch (error) { return fail(`Could not resolve the file reference: ${error.message}.`); }
		if (!validateReference(ref) || ref.kind !== "file") return fail("Invalid file reference; expected at least an `id`.");
		const result = resolveFile(root, brainDir, ref);
		const readablePinned = ["stale", "deleted"].includes(result.status) && result.bytes !== undefined && ref.version !== undefined;
		const record = result.record;
		if (result.status !== "live" && !readablePinned) return fail(`File resolution status: ${result.status}. ${result.error ?? `Requested ${result.requestedVersion ?? "current"}; current is ${result.currentVersion ?? "unavailable"}.`}`);
		if (result.bytes.byteLength > POLICY.limits.look.fileBytes) return fail(`The file is ${count(result.bytes.byteLength)} bytes, over the ${count(POLICY.limits.look.fileBytes)}-byte read limit. Ask for a smaller range with shelf.add.`);
		if (result.bytes.subarray(0, POLICY.limits.look.binaryProbeChars).includes(0)) return fail("This file appears to be binary and cannot be returned as text.");
		let selected;
		try { selected = renderReadSelection(result.bytes, record.path, args.range, ref.id); }
		catch (error) { return fail(`Cannot read the requested selection: ${error.message}.`); }
		return textResult(`${selected}${readablePinned ? `\n(a pinned historical version; the current content differs)` : ""}`, { ref: result.ref ?? ref, status: result.status, version: result.resolvedVersion ?? result.currentVersion });
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
			if (!validateReference(args.ref) || args.ref.kind !== target) return fail(`${target} ${action} needs a ${target} reference.`);
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
			const ref = nativeReference(brainDir, target, args.ref.id, found.version);
			return textResult(JSON.stringify(found.record, null, 2), { ref, status: "live" });
		}
		if (target === "context" && (action === "fold" || action === "note" || action === "collapse")) {
			// No ref, no precondition: fold takes operation {id}, note takes operation {text}, collapse is free-form.
			const payload = args.operation ?? {};
			if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return fail(`context ${action} needs an operation object with the target-specific fields.`);
			return runContext({ root, brainDir, config, engine }, { ops: [{ ...payload, action }] }, api);
		}
		if (target === "atlas" && (action === "look" || action === "tree")) {
			if (args.operation !== undefined && (args.operation === null || typeof args.operation !== "object" || Array.isArray(args.operation))) return fail(`The atlas ${action} operation needs an object with the target-specific fields.`);
			const { atlas, error } = loadAtlas(brainDir);
			if (atlas === undefined) return fail(`The atlas cannot be read: ${error}. Nothing was changed.`);
			const { plan } = loadPlan(brainDir);
			try {
				const result = applyAtlasOp(atlas, { ...(args.operation ?? {}), action }, { root, now: new Date(api.now()).toISOString(), by: main ? POLICY.enums.atlasAuthors.main : POLICY.enums.atlasAuthors.task, main, files: () => projectFiles(root), created: [], mayCreate: gate?.yolo === true || (plan !== undefined && isAuthorized(plan)) });
				if (result.changed) saveAtlas(brainDir, atlas);
				return textResult(result.line, { target, action, changed: result.changed, shown: result.shown });
			} catch (error) { return error instanceof AtlasError ? withGuide("atlas", action, fail(`Atlas ${action} refused: ${error.message}.`)) : Promise.reject(error); }
		}
		if (!BRAIN_MUTATIONS[target]?.has(action)) return unsupported(target, action);
		const isAdd = action === "add";
		if (target === "plan" && !main) return fail(`Tool call blocked: ${TASK_REFUSALS.plan} ${STILL_TASK}`);
		let current;
		if (!isAdd) {
			if (!validateReference(args.ref) || args.ref.kind !== target) return fail(`${target} ${action} needs a ${target} reference.`);
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
		if (args.operation !== undefined && (args.operation === null || typeof args.operation !== "object" || Array.isArray(args.operation))) return fail(`${target} ${action} needs an operation object with the target-specific fields.`);
		const operation = { ...(args.operation ?? {}), action };
		if (!isAdd) operation.id = args.ref.id;
		if ((target === "assessment" || target === "practice") && action === "add") operation.kind = target;
		if (target === "atlas") {
			const { atlas, error } = loadAtlas(brainDir);
			if (atlas === undefined) return fail(`The atlas cannot be read: ${error}. Nothing was changed.`);
			if (atlas.lastCall === api.taskId) return textResult("This atlas operation was already applied before a restart.", { replay: true });
			const atlasOp = { ...operation, ...(isAdd ? {} : { name: args.ref.id }) };
			const { plan } = loadPlan(brainDir);
			try {
				const result = applyAtlasOp(atlas, atlasOp, { root, now: new Date(api.now()).toISOString(), by: main ? POLICY.enums.atlasAuthors.main : POLICY.enums.atlasAuthors.task, main, files: () => projectFiles(root), created: [], mayCreate: gate?.yolo === true || (plan !== undefined && isAuthorized(plan)) });
				if (result.changed) { atlas.lastCall = api.taskId; saveAtlas(brainDir, atlas); }
				return textResult(result.line, { target, action, changed: result.changed, shown: result.shown });
			} catch (error) { return error instanceof AtlasError ? withGuide("atlas", action, fail(`Atlas ${action} refused: ${error.message}.`)) : Promise.reject(error); }
		}
		if (target === "ledger") return withGuide(target, action, runLedger({ brainDir, engine }, { ops: [operation] }, api));
		if (target === "plan") return withGuide(target, action, runPlan({ brainDir, gate }, { ops: [operation] }, api));
		if (target === "assessment" || target === "practice") return withGuide(target, action, runBooks({ brainDir }, { ops: [operation] }, api));
		if (target === "context") {
			if (action === "archive" || action === "restore") {
				try { return textResult(applyContextRowAction(brainDir, args.ref.id, action === "restore" ? POLICY.enums.actions.unarchive : POLICY.enums.actions.archive, args.operation?.when, api.taskId), { target, action, ref: args.ref }); }
				catch (error) { return withGuide(target, action, fail(`Context row ${action} refused: ${error.message}.`)); }
			}
			return withGuide(target, action, runContext({ root, brainDir, config, engine }, { ops: [operation] }, api));
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
	if (target === "shelf" && action === "list") {
		const items = currentShelf(brainDir, api.conversationId, main);
		return textResult(items.length === 0 ? "Shelf is empty." : items.map((item) => `${shelfLabel(item)} [placement ${item.id}]${item.target ? ` → ${JSON.stringify(item.target)}` : ""}`).join("\n"), { placements: items.map((item) => item.id) });
	}
	if (target === "shelf" && action === "add") {
		let ref = args.ref;
		let path = args.path;
		let pinnedDurable;
		if (ref !== undefined) {
			if (ref.kind === undefined) {
				const inferred = await inferShelfRef(ref, root, brainDir, api, callContext);
				if (inferred === undefined) return fail(`Nothing with the ID "${ref.id}" is a file, a report, a schema or a durable record; nothing was added. Give the ref a kind to say what it is.`);
				ref = inferred;
			}
			if (!validateReference(ref)) return fail("Invalid shelf target reference.");
			if (ref.kind === "file") {
				const resolved = resolveFile(root, brainDir, ref);
				if (resolved.status !== "live") return fail(`Cannot shelf file: resolver status ${resolved.status}. ${resolved.error ?? "The reference is not current."}`);
				path = resolved.record.path;
		} else if (ref.kind === "report") {
			const verified = await runUniversal({ root, brainDir, config, engine, gate }, { target: "report", action: "read", ref }, api, callContext);
			if (verified.isError) return verified;
			path = `report:${ref.id}`;
		} else if (ref.kind === "schema") {
			if (typeof ref.version !== "string") return fail("A schema shelf placement needs an exact version-pinned schema reference.");
			const retained = readReferenceVersion(brainDir, ref);
			if (retained === undefined) {
				// Explicit pin: retaining the current registry version here makes the pin self-sufficient.
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
			// The render path cannot reach the Durable store, so the placement is backed by the verified content at add time.
			const durable = await durableRecordFor(ref.kind, ref.id, brainDir, api, callContext);
			if (durable === undefined) return fail(`${ref.kind} ${ref.id} is unavailable (missing or soft-forgotten); nothing was shelved.`);
			if (ref.version !== undefined && ref.version !== durable.version) return fail(`Stale ${ref.kind} reference: requested ${ref.version}, current ${durable.version}. Re-list and pin the current version.`);
			pinnedDurable = { record: durable, ref: { namespace: ref.namespace, kind: ref.kind, id: ref.id, version: ref.version ?? durable.version } };
		} else return unsupported("shelf", "add for this reference kind");
		}
		if (ref?.kind !== "schema" && !DURABLE_REF_KINDS.has(ref?.kind ?? "") && (typeof path !== "string" || path.trim() === "")) return fail("shelf add needs a file reference or explicit project-relative path.");
		const mine = currentShelf(brainDir, api.conversationId, main);
		let picked;
		if (pinnedDurable !== undefined) {
			picked = shelfReferenceItem(pinnedDurable.ref, JSON.stringify(pinnedDurable.record.value, null, 2), brainDir, mine);
		} else {
			try { picked = shelfItem(root, ref?.kind === "schema" ? ref : path, args.range, brainDir, mine); }
			catch (error) { return fail(`Cannot add to shelf: ${error.message}.`); }
		}
		const item = { ...picked.item, ...(ref ? { target: ref } : {}) };
		persistShelfSnapshot(brainDir, item, picked.backing);
		const handOn = !main && args.handOn === true;
		updateContext(brainDir, (next) => {
			const list = main ? next.shelf : (taskState(next, api.conversationId).shelf ??= []);
			const at = list.findIndex((entry) => entry.id === item.id);
			if (at < 0) list.push({ ...item, ...(handOn ? { handOn: true } : {}) });
			else list[at] = { ...item, ...(handOn ? { handOn: true } : {}) };
		});
		return textResult(`Added ${shelfLabel(item)} to the shelf as placement ${item.id}; ${count(picked.tokens)} rendered tokens are in view now.\n\n${picked.item.snapshot}`, { placement: item.id, ref: item.target });
	}
	if (target === "shelf" && action === "remove") {
		const placementId = String(args.placementId ?? "");
		if (!placementId) return fail("shelf remove needs the exact shelf placementId, not the target ID.");
		if (loadContext(brainDir).appliedOperations?.includes(String(api.taskId))) {
			cleanupShelfSnapshots(brainDir, [{ id: placementId, type: "file" }]);
			return textResult(`Removed shelf placement ${placementId}; the target identity remains unchanged.`, { removedPlacement: placementId, replay: true });
		}
		const mine = currentShelf(brainDir, api.conversationId, main);
		const gone = mine.filter((item) => item.id === placementId);
		if (gone.length === 0) return fail(`No shelf placement ${placementId} exists in this context.`);
		updateContext(brainDir, (next) => {
			if (main) next.shelf = next.shelf.filter((item) => item.id !== placementId);
			else taskState(next, api.conversationId).shelf = mine.filter((item) => item.id !== placementId);
			next.appliedOperations = [...new Set([...(next.appliedOperations ?? []), String(api.taskId)])].slice(-POLICY.limits.context.operationReplay);
		});
		cleanupShelfSnapshots(brainDir, gone);
		return textResult(`Removed shelf placement ${placementId}; the target identity remains unchanged.`, { removedPlacement: placementId });
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
				const expected = { action: POLICY.enums.actions.add, mode: op.mode === POLICY.enums.planMode.look ? "look" : "change", text: "one-line description of what this item covers" };
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

/** The books' run: see the `assess` tool this replaces (src/tools/assess.mjs in the last release). */
function runBooks({ brainDir }, args, api) {
	// The old whole-text call, kept for a hand-written assessment.md and older callers.
	if (!Array.isArray(args.ops) || args.ops.length === 0) {
		let text = typeof args.text === "string" ? args.text.trim() : "";
		if (text === "") return fail("`text` is empty and `ops` holds nothing. Write an entry with `ops`, or the whole assessment with `text`.");
		if (text.length > ASSESSMENT_MAX) {
			warn(`The assessment was clipped from ${text.length} to ${ASSESSMENT_MAX} characters; the rest is dropped. Keep what I would need first with an empty context, and put the details in nodes of the atlas.`);
			text = `${text.slice(0, ASSESSMENT_MAX - 1).trimEnd()}…`;
		}
		saveAssessment(brainDir, text);
		noteAssessed(brainDir, text);
		return {
			output: [
				{
					type: "text",
					text: `Assessment saved (${text.length} characters) to ${assessmentPath(brainDir)}. The copy at the top of my context is replaced when a goal closes or a fresh context starts; until then this call is the text that counts.`,
				},
			],
			details: { shown: [`assessment written, ${text.length} characters`] },
		};
	}
	const book = loadBooks(brainDir);
	if (book.lastCall === api.taskId) {
		if (book.items.some((item) => item.kind === POLICY.enums.bookKind.assessment)) {
			const assessment = renderBook(book, POLICY.enums.bookKind.assessment);
			saveAssessment(brainDir, assessment);
			noteAssessed(brainDir, assessment);
		}
		return textResult("These book operations were already applied before a restart.", { replay: true });
	}
	const lines = [];
	const shown = [];
	let applied = 0;
	for (const [index, op] of args.ops.entries()) {
		try {
			const result = applyBookOp(book, op, api.now());
			lines.push(result.line);
			shown.push(result.shown);
			applied++;
		} catch (problem) {
			if (!(problem instanceof BookError)) throw problem;
			lines.push(`Op ${index + 1} (${op?.action ?? "?"}) not applied: ${problem.message}`);
		}
	}
	if (applied === 0) return fail(lines.join("\n"));
	book.lastCall = api.taskId;
	saveBooks(brainDir, book);
	// Keep assessment.md in step with the assessment entries, so the copy at the top of the
	// context, /assessment and the user's own edits still read the same text.
	const assessment = renderBook(book, POLICY.enums.bookKind.assessment);
	if (book.items.some((item) => item.kind === POLICY.enums.bookKind.assessment)) {
		saveAssessment(brainDir, assessment);
		noteAssessed(brainDir, assessment);
	}
	const practice = renderBook(book, POLICY.enums.bookKind.practice);
	return {
		output: [{ type: "text", text: `${lines.join("\n")}${practice === "" ? "" : `\n\nMy practice now reads:\n${practice}`}` }],
		details: { shown },
	};
}

/** The context operations' run: see the `context` tool this replaces (src/tools/context.mjs in the last release). */
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
				const text = String(op.text ?? "").trim();
				if (text === "") return fail("note needs `text`: what to keep, with file paths and line numbers.");
				updateContext(brainDir, (next) => {
					(taskState(next, api.conversationId).notes ??= []).push(text);
				});
				shown.push(`noted · ${count(text.length)} characters`);
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
		target: str({ enum: UNIVERSAL_TARGETS, description: "The referenced entity family, or shelf." }),
		action: str({ enum: UNIVERSAL_ACTIONS, description: "One target-specific operation. Unsupported target/action pairs fail closed." }),
		ref: opt(REFERENCE_SCHEMA),
		path: opt(str({ description: "Explicit project-relative locator, accepted only for file resolution and shelf add." })),
		range: opt(str({ description: 'File selection such as "10-80"; omitted means the full text selection.' })),
		placementId: opt(str({ description: "The exact temporary shelf placement ID, not its target ID." })),
		cursor: opt(str({ description: "Opaque page token from a previous list result; omit for the first page." })),
		planItem: opt(str({ description: "Required authorized change-plan item for file create/edit/remove." })),
		expectedVersion: opt(str({ description: "Optional SHA-256 content version precondition; omit it — a ref's ID always points at the live version. Supplied, it is enforced as a precondition." })),
		content: opt(str({ description: "Whole UTF-8 text for file create." })),
		oldText: opt(str({ description: "Exact passage to replace in file edit." })),
		newText: opt(str({ description: "Replacement passage in file edit." })),
		handOn: opt(bool({ description: "When adding from a focus, hand this placement to the shared shelf on return." })),
		operation: opt(unknown({ description: "One target-specific operation payload for brain-record mutations. `done` names the item by its id — for `plan`, `ledger`, `assessment` and `practice`: operation {id} (plus an optional `text` outcome). `context` takes fold {id}, note {text} and collapse {text?} the same way." })),
	});
	const validate = compile(validationSchema, { coerce: true });
	const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
	const joinList = (items) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
	/** The generic interpreter over CAPABILITIES; the one place the call grammar is enforced. */
	const checkCall = (target, action, args) => {
		const spec = capabilityFor(target, action);
		if (spec === undefined) return { unsupported: true };
		const problems = [];
		if (args.ref !== undefined && !validateReference(args.ref)) {
			// Where the kind can be inferred (the shelf: from what the ID is), an id-carrying ref is enough;
			// the executor resolves it and says precisely when it cannot.
			const idOnly = spec.refInfer === true && typeof args.ref === "object" && args.ref !== null && typeof args.ref.id === "string" && args.ref.id.trim() !== "";
			if (!idOnly) return { problems: [spec.refInfer === true ? "a ref with an `id` (the namespace and kind are inferred from it), or an explicit project-relative path" : "a ref with an `id`"] };
		}
		const kind = spec.refKind ?? target;
		const article = /^[aeiou]/i.test(kind) ? "an" : "a";
		if (spec.ref === "required" && args.ref === undefined) problems.push(`${article} ${kind} reference ({ \"id\": … } is enough)`);
		if (spec.pathOk && args.ref === undefined && !nonEmpty(args.path)) problems.push(spec.refAlternative ?? "ref or path");
		for (const field of spec.fields ?? []) if (!nonEmpty(args[field])) problems.push(field);
		if (spec.operation === "required") {
			if (args.operation === undefined) problems.push(spec.hint ?? "an operation payload");
			else for (const field of spec.operationFields ?? []) if (!nonEmpty(args.operation?.[field])) problems.push(`operation.${field}`);
		}
		return { problems };
	};
	return defineTool({
		name: "book",
		description: describe("book"),
		parameters: validationSchema,
		prepareArguments(args) {
			const result = validate.parse(args);
			if (!result.ok) {
				const path = (pointer) => pointer === "" ? "root" : pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")).join(".");
				const errors = [...result.errors].map((error) => `  - ${path(error.path)}: ${error.message}`).join("\n");
				// Do not echo the arguments: malformed text can be very large and the agent already has its original call.
				throw new Error(`Validation failed for tool "book":\n${errors}`);
			}
			const value = result.value;
			if (value.target === undefined || value.action === undefined) throw new Error('Validation failed for tool "book": target and action are both required.');
			const ref = normalizeRef(brainDir, value.ref, value.target);
			// The harness hands the call's arguments to tools deeply frozen; never mutate them, carry a new object.
			const prepared = ref === undefined ? { ...value } : { ...value, ref };
			const { unsupported, problems } = checkCall(value.target, value.action, prepared);
			if (unsupported === true) throw new Error(`Unsupported book operation: target=${JSON.stringify(value.target)}, action=${JSON.stringify(value.action)}. No target content was resolved.${CAPABILITIES[value.target] === undefined ? "" : ` Supported actions for ${value.target}: ${Object.keys(CAPABILITIES[value.target]).join(", ")}.`}`);
			if (problems.length > 0) {
				const guide = guideFor(value.target, value.action);
				throw new Error(`Validation failed for tool "book": ${value.target} ${value.action} needs ${joinList(problems)}.${guide === undefined ? "" : ` ${value.target} ${value.action} takes: ${guide}.`}`);
			}
			return prepared;
		},

		executionMode: "sequential",
		// Safe to run again after a crash: the ledger and the plan remember the last call they applied,
		// and the rest of the books change nothing when the same words are written twice.
		replay: POLICY.enums.toolReplay.safe,
		// Read-only operations run inline for every context; project changes go through the one gate (§6 of
		// docs/design.md). `file rebind` still dispatches to a short focus: it is a catalog identity write.
		execute: async (args, api, callContext) => {
			if (args.target !== undefined) {
				const main = api.conversationId === ROOT_CONVERSATION_ID;
				const mutation = args.target === "file" && ["create", "edit", "remove"].includes(args.action);
				if (main && mutation && (typeof args.planItem !== "string" || args.planItem.trim() === "")) return fail("file create/edit/remove needs an authorized change planItem; first get it approved in the plan.");
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
