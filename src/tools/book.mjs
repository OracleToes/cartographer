// The `book` tool is the shared interface to the agent's durable books — ledger, plan, project/practice books,
// and context. Focused contexts may update the shared brain; only the orchestrating context can change the plan.
// Domain operations live in src/ledger.mjs, src/plan.mjs, src/books.mjs, and src/context.mjs. This tool routes
// the current shared call shape to those operations while preserving their validation and non-plan safeguards.
import { POLICY } from "../config.mjs";
import { createHash } from "node:crypto";
import { defineTool, NestedCallDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { arr, bool, compile, lit, obj, oneOf, opt, str, union, unknown } from "@earendil-works/pi-schema";
import { describe, REFUSALS, STILL_TASK } from "../prompt.mjs";
import { applyOp, KINDS, LedgerError, loadLedger, open, openCounts, prune, saveLedger, TEXT_MAX as LEDGER_TEXT_MAX } from "../ledger.mjs";
import { applyPlanOp, authorizationLine, isAuthorized, ITEM_MAX, loadPlan, MODES, PlanError, savePlan } from "../plan.mjs";
import { applyAtlasOp, AtlasError, loadAtlas, saveAtlas } from "../atlas.mjs";
import { applyBookOp, BOOK_KINDS, BOOK_TEXT_MAX, BookError, loadBooks, renderBook, saveBooks } from "../books.mjs";
import { ASSESSMENT_MAX, assessmentPath, saveAssessment } from "../assessment.mjs";
import { noteAssessed } from "../top.mjs";
import { pin } from "../top.mjs";
import { loadContext, loadReport, messageTokens, recordLine, reportsInView, ShelfError, shelfItem, shelfLabel, shelfText, estimate, stepsOf, taskState, updateContext, persistShelfSnapshot, RECALLED, composedRows, curatedRows, applyCuratedRowOp, applyContextRowAction, ContextRowError, sameShelfItem, cleanupShelfSnapshots } from "../context.mjs";
import { fileReference, nativeReference, readReferenceVersion, rebindFile, resolveFile, retainReferenceVersion, validateReference } from "../catalog.mjs";
import { atlasOperationSchema } from "./atlas.mjs";

const count = (n) => Math.round(n).toLocaleString("en-US");
const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
const ok = (text, shown) => ({ output: [{ type: "text", text }], details: { shown: [].concat(shown) } });
const sameItem = sameShelfItem;
const CONTEXT_WHEN = Object.values(POLICY.enums.contextVisibility);
const UNIVERSAL_TARGETS = ["file", "report", "ledger", "plan", "atlas", "assessment", "practice", "conversation", "message", "toolCall", "toolResult", "prompt", "tool", "schema", "shelf"];
const UNIVERSAL_ACTIONS = ["inspect", "read", "list", "create", "add", "edit", "done", "archive", "restore", "remove", "recall", "before", "link", "unlink", "confirm", "rebind"];
const REFERENCE_SCHEMA = obj({
	namespace: str({ minLength: 16, description: "Persistent brain-store namespace." }),
	kind: str({ minLength: 1, description: "Reference kind; must match target." }),
	id: str({ minLength: 1, description: "Stable native or catalog ID, never a path or label." }),
	version: opt(str({ description: "Exact immutable content version; omit to resolve current." })),
});

const textResult = (text, details = {}) => ({ output: [{ type: "text", text }], details });
function renderReadSelection(bytes, path, range) {
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
	const body = lines.slice(Math.max(0, from - 1), to).map((line, index) => `${String(from + index).padStart(String(to).length)} │ ${line.length > clip ? `${line.slice(0, clip)} …[line cut]` : line}`);
	const more = to < lines.length ? `\n(${lines.length - to} more lines; ask for range ${to + 1}-${Math.min(lines.length, to + POLICY.limits.look.readDefaultLines)}.)` : "";
	return `== ${path} (lines ${from}-${Math.max(from - 1, to)} of ${lines.length})\n${body.join("\n")}${more}`;
}
const unsupported = (target, action) => fail(`Unsupported book operation: target=${JSON.stringify(target)}, action=${JSON.stringify(action)}. No target content was resolved.`);

function currentShelf(brainDir, conversationId, main) {
	const store = loadContext(brainDir);
	return main ? store.shelf : (store.tasks[conversationId]?.shelf ?? []);
}

const digestJson = (value) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const DURABLE_TARGETS = new Set(["conversation", "message", "toolCall", "toolResult", "prompt", "tool", "schema"]);
const BRAIN_TARGETS = new Set(["ledger", "plan", "atlas", "assessment", "practice", "context"]);
const BRAIN_MUTATIONS = {
	ledger: new Set(["add", "edit", "done", "remove"]),
	plan: new Set(["add", "edit", "done", "remove", "before"]),
	atlas: new Set(["add", "edit", "link", "unlink", "confirm", "remove"]),
	assessment: new Set(["add", "edit", "done", "remove", "before"]),
	practice: new Set(["add", "edit", "done", "remove", "before"]),
	context: new Set(["add", "edit", "done", "remove", "before", "archive", "restore"]),
};
function listBrainRecords(target, brainDir) {
	if (target === "ledger") { const loaded = loadLedger(brainDir); if (!loaded.ledger) throw new Error(`The ledger cannot be read: ${loaded.error}`); return loaded.ledger.items; }
	if (target === "plan") { const loaded = loadPlan(brainDir); if (!loaded.plan) throw new Error(`The plan cannot be read: ${loaded.error}`); return loaded.plan.items; }
	if (target === "atlas") { const loaded = loadAtlas(brainDir); if (!loaded.atlas) throw new Error(`The atlas cannot be read: ${loaded.error}`); return loaded.atlas.nodes; }
	if (target === "assessment" || target === "practice") return loadBooks(brainDir).items.filter((item) => item.kind === target);
	if (target === "context") return curatedRows(loadContext(brainDir));
	return [];
}
function brainRecord(target, brainDir, id) {
	const items = listBrainRecords(target, brainDir);
	const record = target === "atlas" ? items.find((item) => item.name === id) : items.find((item) => item.id === id);
	return record === undefined ? undefined : { record, version: digestJson(record) };
}

async function durableConversations(api, callContext) {
	return api.commit(async (tx) => {
		const records = [];
		let cursor;
		do {
			const page = await tx.scanConversations({}, POLICY.limits.taskHistory.contextEntries, cursor);
			records.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		return records;
	}, callContext);
}

async function durableEntries(api, conversationId, callContext) {
	return api.commit(async (tx) => {
		const conversations = conversationId === undefined ? await tx.scanConversations({}, POLICY.limits.taskHistory.contextEntries) : { items: [{ id: conversationId }] };
		const owners = [...conversations.items];
		let conversationCursor = conversations.next;
		while (conversationCursor !== undefined) {
			const page = await tx.scanConversations({}, POLICY.limits.taskHistory.contextEntries, conversationCursor);
			owners.push(...page.items);
			conversationCursor = page.next;
		}
		const records = [];
		for (const owner of owners) {
			let cursor;
			do {
				const page = await tx.scanEntries({ conversationId: owner.id, order: "ascending" }, POLICY.limits.taskHistory.contextEntries, cursor);
				records.push(...page.items);
				cursor = page.next;
			} while (cursor !== undefined);
		}
		return records;
	}, callContext);
}

async function durableTasks(api, callContext) {
	return api.commit(async (tx) => {
		const records = [];
		let cursor;
		do {
			const page = await tx.scanTasks({ kind: "pi.tool", order: "ascending" }, POLICY.limits.taskHistory.contextEntries, cursor);
			records.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		return records;
	}, callContext);
}

async function durableRecords(target, brainDir, api, callContext) {
	if (target === "tool" || target === "schema") {
		return api.registry.tools().map(({ extension, tool }) => {
			const id = `${extension.name}:${tool.name}`;
			const schema = tool.parameters ?? {};
			const value = target === "schema" ? schema : { extension: extension.name, name: tool.name, description: tool.description, schema };
			return { id, value, version: digestJson(value), provenance: { extension: extension.name, tool: tool.name } };
		});
	}
	if (target === "conversation") {
		const conversations = await durableConversations(api, callContext);
		return conversations.map((record) => ({ id: String(record.id), value: record, version: digestJson(record) }));
	}
	const entries = await durableEntries(api, undefined, callContext);
	const tasks = ["toolCall", "toolResult"].includes(target) ? await durableTasks(api, callContext) : [];
	const records = [];
	for (const entry of entries) {
		const messages = Array.isArray(entry.model) ? entry.model : [];
		if (target === "message") {
			for (const message of messages) if (["user", "assistant"].includes(message.role) && !(Array.isArray(message.content) && message.content.some((part) => part?.type === "toolCall"))) {
				const value = { role: message.role, message, entryId: entry.id, conversationId: entry.conversationId };
				records.push({ id: String(entry.id), value, version: digestJson(message), provenance: { entryId: entry.id, conversationId: entry.conversationId } });
				break;
			}
		} else if (target === "toolCall") {
			for (const message of messages) for (const part of Array.isArray(message.content) ? message.content : []) if (part?.type === "toolCall") {
				const id = JSON.stringify([entry.conversationId, entry.id, part.id]);
				const task = tasks.find((record) => record.input?.kind === "model" && record.input.assistant === entry.id && record.input.callId === part.id);
				const resultEntryId = task?.state?.outcome?.result?.kind === "model" ? task.state.outcome.result.entryId : undefined;
				const provenance = { conversationId: entry.conversationId, assistantEntryId: entry.id, providerCallId: part.id, ...(task ? { toolTaskId: task.id } : {}), ...(resultEntryId !== undefined ? { resultEntryId } : {}) };
				const value = { ...provenance, call: part };
				records.push({ id, value, version: digestJson(part), provenance });
			}
		} else if (target === "toolResult" && entry.kind === "pi.tool-result") {
			const task = tasks.find((record) => record.id === entry.byTaskId);
			const input = task?.input;
			const call = input?.kind === "model" ? { assistantEntryId: input.assistant, providerCallId: input.callId } : undefined;
			const value = { entry: entry.model?.[0], diagnostics: entry.data, entryId: entry.id, taskId: entry.byTaskId, ...(call ? { call } : {}) };
			records.push({ id: String(entry.id), value, version: digestJson(value), provenance: { resultEntryId: entry.id, taskId: entry.byTaskId, ...(call ?? {}) } });
		} else if (target === "prompt" && entry.kind === "pi.system") {
			const value = { entryId: entry.id, messages };
			records.push({ id: String(entry.id), value, version: digestJson(value), provenance: { entryId: entry.id } });
		}
	}
	if (target === "toolCall" || target === "toolResult") {
		for (const task of tasks) {
			const input = task.input;
			if (input?.kind !== "nested") continue;
			const id = JSON.stringify([task.conversationId, input.parent, input.parentCallId, input.key]);
			const provenance = { conversationId: task.conversationId, parentTaskId: input.parent, parentCallId: input.parentCallId, nestedKey: input.key, toolTaskId: task.id };
			let nestedResult;
			try { nestedResult = await api.snapshot(NestedCallDoc, input.parent, input.key, callContext); } catch { nestedResult = undefined; }
			const value = { ...provenance, call: input.call, ...(nestedResult?.result ? { result: nestedResult.result } : {}) };
			if (target === "toolCall") records.push({ id, value, version: digestJson(input.call), provenance });
			else if (nestedResult?.result !== undefined) records.push({ id: `nested:${id}`, value: nestedResult.result, version: digestJson(nestedResult.result), provenance: { ...provenance, resultFor: id } });
		}
	}
	if (target === "message") {
		const forgotten = new Set(loadContext(brainDir).forgottenEntries ?? []);
		return records.filter((record) => !forgotten.has(record.id));
	}
	return records;
}

async function runUniversal({ root, brainDir, config, engine, gate }, args, api, callContext) {
	const main = api.conversationId === ROOT_CONVERSATION_ID;
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
	if (target === "file" && ["create", "edit"].includes(action)) {
		if (main) return fail("Project-file create/edit must run in a focused change task for an authorized plan item.");
		if (typeof args.planItem !== "string" || args.planItem.trim() === "") return fail("Project-file create/edit requires the authorized planItem carried by this focus.");
		const task = await api.commit(async (tx) => {
			const entries = await tx.scanEntries({ conversationId: api.conversationId, order: "ascending" }, POLICY.limits.taskHistory.contextEntries);
			return entries.items.find((entry) => entry.conversationId === api.conversationId && entry.kind === "carto.brief")?.data;
		}, callContext);
		if (task?.mode !== POLICY.enums.planMode.change || task.item !== args.planItem) return fail("File mutation refused: this focus is not carrying that authorized change plan item.");
		let filePath = args.path;
		let expectedVersion;
		if (action === "create") {
			if (typeof filePath !== "string" || filePath.trim() === "" || typeof args.content !== "string") return fail("file create needs path and content.");
			const nested = await api.executeTool("write", { path: filePath, content: args.content }, callContext, { key: "book-file-create" });
			const output = nested.structuredOutput;
			return { isError: nested.isError, output: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output ?? nested.diagnostics) }], details: { target: "file", action, path: filePath, change: true } };
		}
		if (!validateReference(args.ref) || args.ref.kind !== "file") return fail("file edit requires a stable file ref; paths alone are not mutation targets.");
		if (typeof args.expectedVersion !== "string" || !/^[0-9a-f]{64}$/.test(args.expectedVersion)) return fail("file edit requires the current SHA-256 expectedVersion.");
		const resolved = resolveFile(root, brainDir, args.ref);
		if (resolved.status !== "live") return fail(`File edit refused: resolver status ${resolved.status}. ${resolved.error ?? "Refresh the file reference."}`);
		if (resolved.currentVersion !== args.expectedVersion) return fail(`Stale file edit: expected ${args.expectedVersion}, current ${resolved.currentVersion}. Nothing was changed.`);
		filePath = resolved.record.path;
		if (typeof args.oldText !== "string" || args.oldText === "" || typeof args.newText !== "string") return fail("file edit needs exact oldText and newText.");
		expectedVersion = args.expectedVersion;
		const nested = await api.executeTool("edit", { path: filePath, old_text: args.oldText, new_text: args.newText, expectedVersion }, callContext, { key: "book-file-edit" });
		const output = nested.structuredOutput;
		return { isError: nested.isError, output: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output ?? nested.diagnostics) }], details: { target: "file", action, path: filePath, expectedVersion, change: true } };
	}
	if (target === "file" && ["inspect", "read"].includes(action)) {
		let ref = args.ref;
		try {
			if (ref === undefined) {
				if (typeof args.path !== "string" || args.path.trim() === "") return fail(`file ${action} needs a stable \`ref\` or explicit project-relative \`path\`.`);
				ref = fileReference(root, brainDir, args.path);
			}
		} catch (error) { return fail(`Could not resolve the file reference: ${error.message}.`); }
		if (!validateReference(ref) || ref.kind !== "file") return fail("Invalid file reference; expected { namespace, kind: \"file\", id, version? }.");
		const result = resolveFile(root, brainDir, ref);
		const readablePinned = action === "read" && ["stale", "deleted"].includes(result.status) && result.bytes !== undefined && ref.version !== undefined;
		const record = result.record;
		if (action === "inspect") return textResult(JSON.stringify({ ref: result.ref ?? ref, kind: "file", path: record?.path, status: result.status, requestedVersion: result.requestedVersion, currentVersion: result.currentVersion, bytes: result.bytes?.byteLength, error: result.error, actions: result.status === "live" ? ["inspect", "read", "edit", "rebind", "shelf.add"] : ["inspect"] }, null, 2), { ref: result.ref ?? ref, status: result.status });
		if (result.status !== "live" && !readablePinned) return fail(`File resolution status: ${result.status}. ${result.error ?? `Requested ${result.requestedVersion ?? "current"}; current is ${result.currentVersion ?? "unavailable"}.`}`);
		if (result.bytes.byteLength > POLICY.limits.look.fileBytes) return fail(`The file is ${count(result.bytes.byteLength)} bytes, over the ${count(POLICY.limits.look.fileBytes)}-byte read limit. Ask for a smaller range with shelf.add.`);
		if (result.bytes.subarray(0, POLICY.limits.look.binaryProbeChars).includes(0)) return fail("This file appears to be binary and cannot be returned as text.");
		let selected;
		try { selected = renderReadSelection(result.bytes, record.path, args.range); }
		catch (error) { return fail(`Cannot read the requested selection: ${error.message}.`); }
		return textResult(`${selected} [${result.resolvedVersion ?? result.currentVersion}]${readablePinned ? ` · pinned historical version; current is ${result.currentVersion}` : ""}`, { ref: result.ref ?? ref, status: result.status, version: result.resolvedVersion ?? result.currentVersion });
	}
	if (DURABLE_TARGETS.has(target)) {
		if (target === "schema" && ["inspect", "read"].includes(action) && validateReference(args.ref) && args.ref.kind === "schema" && args.ref.version !== undefined) {
			let current;
			try { current = nativeReference(brainDir, "schema", args.ref.id); }
			catch (error) { return fail(`Could not resolve schema reference: ${error.message}.`); }
			if (args.ref.namespace !== current.namespace) return fail("Schema reference belongs to another brain-store namespace.");
			const retained = readReferenceVersion(brainDir, args.ref);
			if (retained !== undefined) return textResult(action === "inspect" ? JSON.stringify({ ref: args.ref, kind: "schema", status: "live", retained: true }, null, 2) : JSON.stringify(retained, null, 2), { ref: args.ref, status: "live", retained: true });
		}
		let records;
		try { records = await durableRecords(target, brainDir, api, callContext); }
		catch (error) { return fail(`Could not resolve ${target} records: ${error.message}.`); }
		if (action === "list") {
			const items = records.map((record) => {
				const ref = nativeReference(brainDir, target, record.id, record.version);
				if (target !== "message" && target !== "toolCall" && target !== "toolResult") retainReferenceVersion(brainDir, ref, record.value);
				return { ref, summary: String(record.value?.message?.role ?? record.value?.name ?? record.value?.call?.name ?? record.value?.entry?.content ?? record.value?.id ?? record.id).replace(/\s+/g, " ").slice(0, 240), provenance: record.provenance };
			});
			return textResult(items.length ? JSON.stringify(items, null, 2) : `${target} is empty in this conversation.`, { target, count: items.length });
		}
		if (action === "edit" && target === "message") {
			if (!validateReference(args.ref) || args.ref.kind !== target) return fail("message edit needs a stable message ref.");
			const currentNamespace = nativeReference(brainDir, target, args.ref.id);
			if (args.ref.namespace !== currentNamespace.namespace) return fail("Message reference belongs to another brain-store namespace.");
			const item = records.find((entry) => entry.id === args.ref.id);
			if (item === undefined) return loadContext(brainDir).forgottenEntries?.includes(args.ref.id) ? textResult("Message updated.", { status: "soft_forgotten", replay: true }) : fail("Message is unavailable or already removed from ordinary recall.");
			const expected = args.expectedVersion ?? args.ref.version;
			if (typeof expected !== "string" || expected !== item.version) return fail(`Stale message edit: expectedVersion must match current version ${item.version}. Nothing was changed.`);
			const owner = item.provenance.conversationId;
			const entryId = item.provenance.entryId;
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
				const removedShelf = [];
				updateContext(brainDir, (store) => {
					store.forgottenEntries = [...new Set([...(store.forgottenEntries ?? []), String(entryId)])];
					const timestamp = item.value.message.timestamp;
					const text = typeof item.value.message.content === "string" ? item.value.message.content : (item.value.message.content ?? []).flatMap((part) => part?.type === "text" ? [part.text] : []).join("");
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
		if (!["inspect", "read"].includes(action)) return unsupported(target, action);
		if (!validateReference(args.ref) || args.ref.kind !== target) return fail(`${target} ${action} needs a ${target} reference.`);
		let currentNamespace;
		try { currentNamespace = nativeReference(brainDir, target, args.ref.id); }
		catch (error) { return fail(`Could not resolve ${target} reference: ${error.message}.`); }
		if (args.ref.namespace !== currentNamespace.namespace) return fail(`${target} reference belongs to another brain-store namespace.`);
		const found = records.find((entry) => entry.id === args.ref.id);
		if (found === undefined) {
			if (target === "message" && loadContext(brainDir).forgottenEntries?.includes(args.ref.id)) return fail("Message is no longer available through ordinary recall.");
			const historical = args.ref.version === undefined ? undefined : readReferenceVersion(brainDir, args.ref);
			if (historical === undefined) return fail(`${target} ${args.ref.id} is deleted or inaccessible.`);
			return textResult(action === "inspect" ? JSON.stringify({ ref: args.ref, kind: target, status: "stale", historical: true }, null, 2) : JSON.stringify(historical, null, 2), { ref: args.ref, status: "stale" });
		}
		if (args.ref.version !== undefined && args.ref.version !== found.version) {
			const historical = readReferenceVersion(brainDir, args.ref);
			if (historical === undefined) return fail(`${target} reference is stale: requested ${args.ref.version}, current ${found.version}; the requested immutable version is unavailable.`);
			return textResult(action === "inspect" ? JSON.stringify({ ref: args.ref, kind: target, status: "stale", currentVersion: found.version, historical: true }, null, 2) : JSON.stringify(historical, null, 2), { ref: args.ref, status: "stale", currentVersion: found.version });
		}
		const ref = nativeReference(brainDir, target, found.id, found.version);
		if (target !== "message" && target !== "toolCall" && target !== "toolResult") retainReferenceVersion(brainDir, ref, found.value);
		return textResult(action === "inspect" ? JSON.stringify({ ref, kind: target, status: "live", provenance: found.provenance, summary: found.value?.name ?? found.value?.message?.role ?? found.value?.call?.name }, null, 2) : JSON.stringify(found.value, null, 2), { ref, status: "live" });
	}
	if (BRAIN_TARGETS.has(target)) {
		if (action === "list") {
			let records;
			try { records = listBrainRecords(target, brainDir); }
			catch (error) { return fail(error.message); }
			const items = records.map((record) => {
				const id = target === "atlas" ? record.name : record.id;
				const ref = nativeReference(brainDir, target, id, digestJson(record));
				retainReferenceVersion(brainDir, ref, record);
				return { ref, summary: String(record.text ?? record.gist ?? record.brief ?? record.name ?? record.id ?? "").replace(/\s+/g, " ").slice(0, 240) };
			});
			return textResult(items.length ? JSON.stringify(items, null, 2) : `${target} is empty.`, { target, count: items.length });
		}
		if (["inspect", "read"].includes(action)) {
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
				return action === "inspect"
					? textResult(JSON.stringify({ ref: args.ref, target, status: "stale", historical: true }, null, 2), { ref: args.ref, status: "stale" })
					: textResult(JSON.stringify(historical, null, 2), { ref: args.ref, status: "stale" });
			}
			if (args.ref.version !== undefined && args.ref.version !== found.version) {
				const historical = readReferenceVersion(brainDir, args.ref);
				if (historical === undefined) return fail(`${target} reference is stale: requested ${args.ref.version}, current ${found.version}; historical content is unavailable.`);
				return action === "inspect"
					? textResult(JSON.stringify({ ref: args.ref, target, status: "stale", currentVersion: found.version, historical: true }, null, 2), { ref: args.ref, status: "stale", currentVersion: found.version })
					: textResult(JSON.stringify(historical, null, 2), { ref: args.ref, status: "stale", currentVersion: found.version });
			}
			const ref = nativeReference(brainDir, target, args.ref.id, found.version);
			retainReferenceVersion(brainDir, ref, found.record);
			if (action === "inspect") {
				const { text, gist, detail, outcome, doneWhen, ...metadata } = found.record;
				return textResult(JSON.stringify({ ref, target, status: "live", metadata, actions: ["inspect", "read", ...(BRAIN_MUTATIONS[target] ?? [])] }, null, 2), { ref, status: "live" });
			}
			return textResult(JSON.stringify(found.record, null, 2), { ref, status: "live" });
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
			const expected = args.expectedVersion ?? args.ref.version;
			if (typeof expected !== "string" || expected !== current.version) return fail(`Stale ${target} mutation: expectedVersion must match current version ${current.version}. Nothing was changed.`);
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
				const result = applyAtlasOp(atlas, atlasOp, { root, now: new Date(api.now()).toISOString(), by: main ? POLICY.enums.atlasAuthors.main : POLICY.enums.atlasAuthors.task, main, files: () => [], created: [], mayCreate: gate?.yolo === true || (plan !== undefined && isAuthorized(plan)) });
				if (result.changed) { atlas.lastCall = api.taskId; saveAtlas(brainDir, atlas); }
				return textResult(result.line, { target, action, changed: result.changed, shown: result.shown });
			} catch (error) { return error instanceof AtlasError ? fail(`Atlas ${action} refused: ${error.message}.`) : Promise.reject(error); }
		}
		if (target === "ledger") return runLedger({ brainDir, engine }, { ops: [operation] }, api);
		if (target === "plan") return runPlan({ brainDir, gate }, { ops: [operation] }, api);
		if (target === "assessment" || target === "practice") return runBooks({ brainDir }, { ops: [operation] }, api);
		if (target === "context") {
			if (action === "archive" || action === "restore") {
				try { return textResult(applyContextRowAction(brainDir, args.ref.id, action === "restore" ? POLICY.enums.actions.unarchive : POLICY.enums.actions.archive, args.operation?.when, api.taskId), { target, action, ref: args.ref }); }
				catch (error) { return fail(`Context row ${action} refused: ${error.message}.`); }
			}
			return runContext({ root, brainDir, config, engine }, { ops: [operation] }, api);
		}
	}
	if (target === "report" && action === "list") {
		const reports = composedRows(loadContext(brainDir)).map((row) => {
			const body = loadReport(brainDir, row.id);
			if (body === undefined) return undefined;
			const version = createHash("sha256").update(body).digest("hex");
			return { ref: nativeReference(brainDir, "report", row.id, version), archived: row.archived === true, summary: row.brief ?? row.outcome ?? "" };
		}).filter(Boolean);
		return textResult(reports.length ? JSON.stringify(reports, null, 2) : "No reports are available.", { target, count: reports.length });
	}
	if (target === "report" && ["inspect", "read", "recall", "archive", "restore", "remove"].includes(action)) {
		const ref = args.ref;
		if (!validateReference(ref) || ref.kind !== "report") return fail("Invalid report reference; expected { namespace, kind: \"report\", id, version? }.");
		try {
			const current = nativeReference(brainDir, "report", ref.id);
			if (ref.namespace !== current.namespace) return fail("Report reference belongs to another brain-store namespace.");
		} catch (error) { return fail(`Could not resolve report reference: ${error.message}.`); }
		const store = loadContext(brainDir);
		const row = composedRows(store).find((entry) => entry.id === ref.id);
		const body = row === undefined ? undefined : loadReport(brainDir, ref.id);
		if (body === undefined) return fail(`Report ${ref.id} is deleted or unavailable.`);
		const version = createHash("sha256").update(body).digest("hex");
		if (ref.version !== undefined && ref.version !== version) return fail(`Report version is stale: requested ${ref.version}, current ${version}.`);
		if (action === "inspect") return textResult(JSON.stringify({ ref: { ...current, version }, kind: "report", status: "live", archived: row.archived === true, actions: ["inspect", "read", "recall", "archive", "restore", "remove", "shelf.add"] }, null, 2), { status: "live", ref: { ...current, version } });
		if (action === "read") return textResult(body, { status: "live", ref: { ...current, version } });
		if (action === "recall") return runContext({ root, brainDir, config, engine }, { ops: [{ action: POLICY.enums.actions.recall, id: ref.id }] }, api);
		const expected = args.expectedVersion ?? ref.version;
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
		if (ref !== undefined) {
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
			if (retained === undefined) return fail("The pinned schema version is unavailable; no shelf placement was added.");
		} else return unsupported("shelf", "add for this reference kind");
		}
		if (ref?.kind !== "schema" && (typeof path !== "string" || path.trim() === "")) return fail("shelf add needs a file reference or explicit project-relative path.");
		const mine = currentShelf(brainDir, api.conversationId, main);
		let picked;
		try { picked = shelfItem(root, ref?.kind === "schema" ? ref : path, args.range, brainDir, mine); }
		catch (error) { return fail(`Cannot add to shelf: ${error.message}.`); }
		const item = { ...picked.item, ...(ref ? { target: ref } : {}) };
		const others = mine.filter((entry) => !sameItem(entry, item));
		const total = others.reduce((sum, entry) => sum + estimate(shelfText(root, entry, brainDir)), 0) + picked.tokens;
		if (total > config.shelfTokens) return fail(`${shelfLabel(item)} would put about ${count(total)} of ${count(config.shelfTokens)} shelf tokens into context. Choose a smaller range or remove a placement first.`);
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
		return fail(`The ledger cannot be read: ${error}. It was probably edited by hand. Nothing was changed. Tell the user; they have to repair the file.`);
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
		if (pinned) lines.push("The copy of your assessment and graph at the top of your context was rewritten to what they are now.");
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
	if (plan === undefined) return fail(`The plan cannot be read: ${error}. It was probably edited by hand. Nothing was changed. Tell the user; they have to repair the file.`);
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
		const text = typeof args.text === "string" ? args.text.trim() : "";
		if (text === "") return fail("`text` is empty and `ops` holds nothing. Write an entry with `ops`, or the whole assessment with `text`.");
		if (text.length > ASSESSMENT_MAX) return fail(`The assessment is ${text.length} characters; the limit is ${ASSESSMENT_MAX}. Keep what you would need first with an empty context; details belong in nodes of the atlas.`);
		saveAssessment(brainDir, text);
		noteAssessed(brainDir, text);
		return {
			output: [
				{
					type: "text",
					text: `Assessment saved (${text.length} characters) to ${assessmentPath(brainDir)}. The copy at the top of your context is replaced when a goal closes or a fresh context starts; until then this call is the text that counts.`,
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
		output: [{ type: "text", text: `${lines.join("\n")}${practice === "" ? "" : `\n\nYour practice now reads:\n${practice}`}` }],
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
			if ([POLICY.enums.actions.add, POLICY.enums.actions.done, POLICY.enums.actions.edit, POLICY.enums.actions.remove, POLICY.enums.actions.before].includes(action)) {
				const result = applyCuratedRowOp(brainDir, op, api.now(), api.taskId);
				store = loadContext(brainDir);
				shown.push(result.shown);
				lines.push(`${result.line}${op.when === POLICY.enums.contextVisibility.nextBoundary ? " This is saved now and enters context at the next boundary." : " It is saved and in context now."}`);
				continue;
			}
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
				if (reportsInView(messages).has(id) && !store.dropped.includes(id)) return fail(`Report ${id} is still in your context, further up: nothing was added.`);
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
				if (total > config.shelfTokens) {
					return fail(
						`${shelfLabel(item)} is about ${count(tokens)} rendered tokens, and the shelf would then put ${count(total)} of at most ${count(config.shelfTokens)} into context. Shelve a smaller range or take something off first${others.length > 0 ? `: ${others.map(shelfLabel).join(", ")}` : ""}.`,
					);
				}
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
				const size = `about ${count(tokens)} rendered tokens; the shelf then puts ${count(total)} of ${count(config.shelfTokens)} into context`;
				shown.push(`shelved ${shelfLabel(item)} as ${item.id} · about ${count(tokens)} rendered tokens${handOn ? " · handed on to the main agent at the end" : ""}`);
				lines.push(
					main
						? `${shelfLabel(item)} is on your shelf as ${item.id} (${size}). For project files, the full snapshot is backed under .atlas; selected content is in view now and will stand at the start after the next collapse; every task begins with it read.\n\n${item.snapshot}`
						: `${shelfLabel(item)} is on your shelf as ${item.id} (${size}). For project files, the full snapshot is backed under .atlas; selected content is in view now and stays when your steps are collapsed.${handOn ? " When you return, it goes onto the main agent's shelf as well." : ""}\n\n${item.snapshot}`,
				);
				continue;
			}

			if (action === POLICY.enums.actions.unshelve) {
				const given = String(op.path ?? "").trim();
				if (given === "") return fail("unshelve needs `path`: a file or shelf item ID to take off the shelf, or all.");
				const mine = main ? store.shelf : (store.tasks[api.conversationId]?.shelf ?? []);
				const gone = given === "all" ? mine : mine.filter((entry) => entry.id === given || shelfLabel(entry) === given || entry.path === given || entry.path === given.replace(/^\.\//, ""));
				if (gone.length === 0) return fail(`${given} is not on your shelf.${mine.length > 0 ? ` On it: ${mine.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}.` : " The shelf is empty."}`);
				updateContext(brainDir, (next) => {
					if (main) next.shelf = next.shelf.filter((entry) => !gone.some((other) => sameItem(other, entry)));
					else taskState(next, api.conversationId).shelf = mine.filter((entry) => !gone.some((other) => sameItem(other, entry)));
				});
				cleanupShelfSnapshots(brainDir, gone);
				shown.push(`unshelved ${gone.map((item) => `${shelfLabel(item)} as ${item.id}`).join(", ")}`);
				lines.push(`Taken off your shelf: ${gone.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}.${main ? " A copy that stands in your context stays there until the next collapse." : ""}`);
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
						return fail(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in your context in full, so there is nothing to drop.${open.length > 0 ? ` In full: ${open.join(", ")}.` : " No report is."}`);
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
					return fail(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a result in your view.${large.length > 0 ? ` Your larger results: ${large.map((result) => `${result.id} (${engine.callWords(result.call)}, about ${count(result.tokens)} tokens)`).join("; ")}.` : " You have no large result in view."}`);
				}
				const picked = inView.filter((result) => ids.includes(result.id));
				updateContext(brainDir, (next) => {
					const task = taskState(next, api.conversationId);
					task.dropped ??= {};
					for (const id of ids) task.dropped[id] = "You dropped this result.";
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
				lines.push("Noted. It stays when your steps are collapsed.");
				continue;
			}

			if (action === POLICY.enums.actions.collapse) {
				const why = String(op.text ?? "").replace(/\s+/g, " ").trim().slice(0, POLICY.limits.bookTool.refusalChars);
				if (main) {
					engine.want(why === "" ? "you asked for it" : `you asked for it: ${why}`, { asked: true, byAgent: true });
					shown.push("collapse asked for");
					lines.push("Your context is collapsed when the calls of this reply are done. Your next request begins with what was kept.");
					continue;
				}
				if (stepsOf(messages) === undefined) return fail("Your steps cannot be found, so nothing was collapsed.");
				updateContext(brainDir, (next) => {
					Object.assign(taskState(next, api.conversationId), { pending: "now", reason: why === "" ? "You asked for it" : `You asked for it (${why})` });
				});
				shown.push("collapse of its steps asked for");
				lines.push("Your steps so far are collapsed before your next reply. You keep the brief, your notes, your shelf and one line for each call.");
				continue;
			}
			return fail("`action` is one of add, edit, done, remove, before, archive, unarchive, delete, recall, shelve, unshelve, fold, note, collapse.");
		}
	} catch (problem) {
		if (!(problem instanceof ShelfError) && !(problem instanceof ContextRowError)) throw problem;
		return fail(problem.message);
	}
	return { output: [{ type: "text", text: lines.join("\n") }], details: { shown } };
}

// Send the same full conditional schema to the model that local validation enforces, so each book/action
// advertises its actual required fields instead of a compact shape with every operation field optional.
const line = (description, maxLength) => str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", ...(maxLength === undefined ? {} : { maxLength }), description });
const entryId = (description = "The entry (g1, q5, n7).") => line(description);

const LEDGER_OP = union([
	obj(
		{ action: lit(POLICY.enums.actions.add), kind: oneOf(KINDS, { description: "goal, question or note." }), text: line("The entry itself, one line in your words.", LEDGER_TEXT_MAX), done_when: opt(line("For a goal: how you and the user will know it is reached.", LEDGER_TEXT_MAX)) },
		{ allOf: [
			{ if: { properties: { kind: lit(POLICY.enums.ledgerKind.goal) }, required: ["kind"] }, then: { required: ["done_when"] } },
			{ if: { properties: { kind: oneOf(POLICY.enums.ledgerNonGoalKinds) }, required: ["kind"] }, then: { not: { required: ["done_when"] } } },
		], description: "Add a ledger entry; goals need a done-when line." },
	),
	obj({ action: lit(POLICY.enums.actions.done), id: entryId(), text: opt(line("How it ended, one line.", LEDGER_TEXT_MAX)) }, { description: "Close a ledger entry." }),
	obj(
		{ action: lit(POLICY.enums.actions.edit), id: entryId(), text: opt(line("The new wording, one line.", LEDGER_TEXT_MAX)), done_when: opt(line("For a goal: its new done-when line.", LEDGER_TEXT_MAX)) },
		{ anyOf: [{ required: ["text"] }, { required: ["done_when"] }], description: "Edit an entry; change its wording or a goal's done-when line." },
	),
	obj({ action: lit(POLICY.enums.actions.remove), id: entryId() }, { description: "Remove a ledger entry." }),
]);

const PLAN_OP = union([
	obj(
		{ action: lit(POLICY.enums.actions.add), mode: oneOf(MODES, { description: "look: the task only reads. change: it writes files, which needs the user's authorization." }), text: line("Required: one line saying what this item covers.", ITEM_MAX), network: opt(bool({ description: "For a change item: true lets its commands reach the network." })), standing: opt(bool({ description: "For a change item: true makes this a duty that stays open." })), before: opt(entryId("Put the new item in front of this one (p3). Default: at the end.")) },
		{ allOf: [{ if: { properties: { mode: lit(POLICY.enums.planMode.look) }, required: ["mode"] }, then: { not: { anyOf: [{ required: ["network"] }, { required: ["standing"] }] } } }], description: "Add a plan item; look items cannot have change-only flags." },
	),
	obj({ action: lit(POLICY.enums.actions.done), id: entryId("The item (p1, p4)."), text: opt(line("What came of it, one line.", ITEM_MAX)) }, { description: "Mark a plan item finished." }),
	obj(
		{ action: lit(POLICY.enums.actions.edit), id: entryId("The item (p1, p4)."), text: opt(line("The new wording, one line.", ITEM_MAX)), mode: opt(oneOf(MODES, { description: "look or change." })), network: opt(bool({ description: "For a change item: true lets its commands reach the network." })), standing: opt(bool({ description: "For a change item: true makes this a duty that stays open." })) },
		{ allOf: [{ if: { properties: { mode: lit(POLICY.enums.planMode.look) }, required: ["mode"] }, then: { not: { anyOf: [{ required: ["network"] }, { required: ["standing"] }] } } }], anyOf: [{ required: ["text"] }, { required: ["mode"] }, { required: ["network"] }, { required: ["standing"] }], description: "Edit a plan item; look items cannot have change-only flags." },
	),
	obj({ action: lit(POLICY.enums.actions.remove), id: entryId("The item (p1, p4).") }, { description: "Remove a plan item." }),
	obj({ action: lit(POLICY.enums.actions.before), id: entryId("The plan item to move (p1, p4)."), before: opt(entryId("The item to stand in front of; omit to move it to the end.")) }, { description: "Reorder an open or finished plan item." }),
	obj({ action: lit(POLICY.enums.actions.clear) }, { description: "Clear the plan." }),
]);

const BOOKS_OP = union([
	obj({ action: lit(POLICY.enums.actions.add), kind: oneOf(BOOK_KINDS, { description: "assessment or practice." }), text: line("One short entry, in your words.", BOOK_TEXT_MAX), before: opt(entryId("Put the new entry in front of this one.")) }, { description: "Add an assessment or practice entry." }),
	obj({ action: lit(POLICY.enums.actions.edit), id: entryId("The entry (a3, r7)."), text: line("The new wording of this one entry.", BOOK_TEXT_MAX) }, { description: "Reword one entry." }),
	obj({ action: lit(POLICY.enums.actions.done), id: entryId("The entry (a3, r7)."), text: opt(line("How it was settled, one line.", POLICY.limits.books.outcomeChars)) }, { description: "Settle an entry." }),
	obj({ action: lit(POLICY.enums.actions.remove), id: entryId("The entry (a3, r7).") }, { description: "Remove an entry." }),
	obj({ action: lit(POLICY.enums.actions.before), id: entryId("The entry (a3, r7)."), before: opt(entryId("The entry to stand in front of.")) }, { description: "Reorder an entry." }),
]);

const CONTEXT_OP = union([
	obj({ action: lit(POLICY.enums.actions.add), text: line("A self-contained context row to keep." , POLICY.limits.context.curatedRowChars), before: opt(entryId("Put the row in front of this curated row.")), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Add a curated context row; now makes it visible after this call, next-boundary at the next collapse." }),
	obj({ action: lit(POLICY.enums.actions.edit), id: entryId("The curated row (c1)."), text: line("The complete replacement text for this row.", POLICY.limits.context.curatedRowChars), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Edit a curated context row." }),
	obj({ action: lit(POLICY.enums.actions.done), id: entryId("The curated row (c1)."), text: opt(line("How it was settled.", POLICY.limits.context.curatedRowChars)), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Mark a curated row done." }),
	obj({ action: lit(POLICY.enums.actions.remove), id: entryId("The curated row (c1)."), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Remove a curated context row." }),
	obj({ action: lit(POLICY.enums.actions.before), id: entryId("The curated row to move (c1)."), before: opt(entryId("The curated row to stand in front of.")), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Reorder curated context rows." }),
	obj({ action: lit(POLICY.enums.actions.archive), id: entryId("The context row (c1 or t12)."), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Archive a context row without deleting its content." }),
	obj({ action: lit(POLICY.enums.actions.unarchive), id: entryId("The archived context row (c1 or t12)."), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Restore an archived context row." }),
	obj({ action: lit(POLICY.enums.actions.delete), id: entryId("The context row to delete (c1 or t12)."), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Delete a context row and its content." }),
	obj({ action: lit(POLICY.enums.actions.recall), id: entryId("The report to bring back (t12).") }, { description: "Recall a kept report." }),
	obj({ action: lit(POLICY.enums.actions.shelve), path: line("A project file/range or typed reference such as report:t12."), lines: opt(line('For files, a line range such as "10-80"; omit for the whole file.')), hand_on: opt(bool({ description: "In a task, put this file or reference on the main agent's shelf when you return." })) }, { description: "Keep a file or typed reference in view." }),
	obj({ action: lit(POLICY.enums.actions.unshelve), path: line('A shelf item ID or file/reference to take off the shelf, or "all".') }, { description: "Take a shelf item off the shelf; its ID is shown with each entry." }),
	obj({ action: lit(POLICY.enums.actions.fold), id: entryId("A report id (t12) or task step ids (s3, s5), separated by commas.") }, { description: "Fold a finished report or step." }),
	obj({ action: lit(POLICY.enums.actions.note), text: line("What the task must keep, with file paths and line numbers.") }, { description: "Keep a finding in task context." }),
	obj({ action: lit(POLICY.enums.actions.collapse), text: opt(line("Why to collapse, in a few words.")) }, { description: "Collapse context now." }),
]);

const branchFor = (book, operations) => ({
	if: { properties: { book: lit(book) }, required: ["book"] },
	then: { properties: { ops: arr(operations, { minItems: POLICY.validation.nonEmptyArrayMinItems }) }, required: ["ops"], not: { required: ["text"] } },
});
// The legacy whole-assessment form keeps its length check in `runBooks`: rejecting a very long value in the
// schema makes the validator echo the entire argument back into the conversation instead of the concise limit error.
const BOOK_CONDITIONS = [
	branchFor(POLICY.enums.bookName.ledger, LEDGER_OP),
	branchFor(POLICY.enums.bookName.plan, PLAN_OP),
	branchFor(POLICY.enums.bookName.context, CONTEXT_OP),
	{
		if: { properties: { book: lit(POLICY.enums.bookName.books) }, required: ["book"] },
		then: {
			properties: { ops: arr(BOOKS_OP, { minItems: POLICY.validation.nonEmptyArrayMinItems }), text: line("The whole assessment, for the legacy write form.") },
			anyOf: [{ required: ["ops"] }, { required: ["text"] }],
			not: { required: ["ops", "text"] },
		},
	},
];

export const BOOK_BRANCH_ACTIONS = {
	file: ["inspect", "read", "create", "edit", "rebind"],
	report: ["list", "inspect", "read", "recall", "archive", "restore", "remove"],
	ledger: ["list", "inspect", "read", "add", "edit", "done", "remove"],
	plan: ["list", "inspect", "read", "add", "edit", "done", "remove", "before"],
	atlas: ["list", "inspect", "read", "add", "edit", "link", "unlink", "confirm", "remove"],
	assessment: ["list", "inspect", "read", "add", "edit", "done", "remove", "before"],
	practice: ["list", "inspect", "read", "add", "edit", "done", "remove", "before"],
	context: ["list", "inspect", "read", "add", "edit", "done", "remove", "before", "archive", "restore"],
	conversation: ["list", "inspect", "read"],
	message: ["list", "inspect", "read", "edit"],
	toolCall: ["list", "inspect", "read"],
	toolResult: ["list", "inspect", "read"],
	prompt: ["list", "inspect", "read"],
	tool: ["list", "inspect", "read"],
	schema: ["list", "inspect", "read"],
	shelf: ["list", "add", "remove"],
};

const operationBranch = (schema, action) => (schema?.anyOf ?? []).find((branch) => branch.properties?.action?.const === action);

export function bookBranchVariants(target, action) {
	if (target === "file" && ["inspect", "read"].includes(action)) return ["ref", "path"];
	if (target === "shelf" && action === "add") return ["file-ref", "report-ref", "schema-ref", "path"];
	if (target === "atlas" && ["link", "unlink"].includes(action)) return ["links", "files", "both"];
	if (target === "ledger" && action === "add") return [...KINDS];
	if (target === "plan" && action === "add") return [...MODES];
	if (target === "plan" && action === "edit") return [...MODES, "text", "network", "standing"];
	return [];
}

/** The exact target/action projection used by both the provider and the persistent schema reference. */
export function bookBranchParameters(source, target, action, variant) {
	if (!BOOK_BRANCH_ACTIONS[target]?.includes(action)) throw new Error(`The book target ${target} does not support ${action}.`);
	const schema = structuredClone(source);
	for (const condition of schema.allOf ?? []) {
		const keys = Object.keys(condition?.if?.properties ?? {});
		if (keys.length !== 1 || keys[0] !== "book") throw new Error("The book schema contains a conditional outside the legacy interface; it cannot be safely specialized.");
	}
	const props = schema.properties;
	const keep = new Set(["target", "action"]);
	let required = ["target", "action"];
	const include = (...keys) => keys.forEach((key) => keep.add(key));
	const require = (...keys) => { include(...keys); required.push(...keys); };
	let operationSchema;
	let refKind;
	let refVersionRequired = false;

	if (target === "file") {
		if (action === "inspect" || action === "read") {
			if (!["ref", "path"].includes(variant)) throw new Error(`file.${action} needs a locator choice: ref or path.`);
			if (variant === "ref") { require("ref"); refKind = "file"; } else require("path");
			if (action === "read") include("range");
		}
		if (action === "create") require("path", "content", "planItem");
		if (action === "edit") { require("ref", "planItem", "expectedVersion", "oldText", "newText"); refKind = "file"; }
		if (action === "rebind") { require("ref", "expectedVersion", "path"); refKind = "file"; }
	} else if (target === "report") {
		if (action !== "list") { require("ref"); refKind = "report"; }
		if (["archive", "restore", "remove"].includes(action)) include("expectedVersion");
	} else if (DURABLE_TARGETS.has(target)) {
		if (["inspect", "read"].includes(action)) { require("ref"); refKind = target; }
		if (target === "message" && action === "edit") { require("ref"); refKind = target; include("expectedVersion"); }
	} else if (BRAIN_TARGETS.has(target)) {
		if (["inspect", "read"].includes(action)) { require("ref"); refKind = target; }
		if (BRAIN_MUTATIONS[target]?.has(action)) {
			if (action !== "add") { require("ref"); refKind = target; include("expectedVersion"); }
			if (target === "context" && ["archive", "restore"].includes(action)) {
				require("operation");
				operationSchema = obj({ when: opt(oneOf(CONTEXT_WHEN)) });
			} else {
				require("operation");
				const operations = target === "ledger" ? LEDGER_OP : target === "plan" ? PLAN_OP : target === "atlas" ? undefined : ["assessment", "practice"].includes(target) ? BOOKS_OP : CONTEXT_OP;
				operationSchema = target === "atlas" ? atlasOperationSchema(action) : operationBranch(operations, action);
				if (target === "atlas" && action !== "add" && operationSchema?.properties?.name !== undefined) {
					delete operationSchema.properties.name;
					operationSchema.required = (operationSchema.required ?? []).filter((key) => key !== "name");
				}
				if (target === "atlas" && ["link", "unlink"].includes(action)) {
					if (!["links", "files", "both"].includes(variant)) throw new Error(`atlas.${action} needs a links, files, or both branch.`);
					if (variant !== "both") delete operationSchema.properties[variant === "links" ? "files" : "links"];
					delete operationSchema.anyOf;
					operationSchema.required = [...new Set([...(operationSchema.required ?? []), ...(variant === "both" ? ["links", "files"] : [variant])])];
				}
				if (operationSchema === undefined && target === "plan" && action === "before") {
					const add = operationBranch(PLAN_OP, "add");
					operationSchema = obj({ action: lit(action), id: add.properties.before, before: opt(add.properties.before) });
				}
				if (operationSchema === undefined) throw new Error(`No exact ${target} operation schema exists for ${action}.`);
				operationSchema = specializeOperation(target, action, operationSchema, variant);
			}
		}
	} else if (target === "shelf") {
		if (action === "add") {
			if (!["file-ref", "report-ref", "schema-ref", "path"].includes(variant)) throw new Error("shelf.add needs a locator choice: file-ref, report-ref, schema-ref, or path.");
			if (variant === "path") { require("path"); include("range"); }
			else {
				require("ref");
				refKind = variant === "file-ref" ? "file" : variant === "report-ref" ? "report" : "schema";
				refVersionRequired = variant === "schema-ref";
				if (variant === "file-ref") include("range");
			}
			include("handOn");
		}
		if (action === "remove") require("placementId");
	}
	if (operationSchema !== undefined) props.operation = operationSchema;
	for (const key of Object.keys(props)) if (!keep.has(key)) delete props[key];
	if (refKind !== undefined && props.ref !== undefined) {
		props.ref = structuredClone(props.ref);
		props.ref.properties.kind = { type: "string", const: refKind, description: `Reference kind must be ${refKind}.` };
		if (refVersionRequired) props.ref.required = [...new Set([...(props.ref.required ?? []), "version"])];
	}
	props.target = { type: "string", const: target, description: props.target?.description ?? "Selected book target." };
	props.action = { type: "string", const: action, description: props.action?.description ?? "Selected book action." };
	schema.required = [...new Set(required)];
	delete schema.allOf;
	schema.additionalProperties = false;
	return schema;
}

const schemaAllowsNull = (schema) => schema?.type === "null" || (Array.isArray(schema?.type) && schema.type.includes("null")) || schema?.const === null || schema?.enum?.includes?.(null) || schema?.anyOf?.some(schemaAllowsNull);
function nonNullSchema(schema) {
	if (schema?.type === "null" || schema?.const === null) return { type: "null" };
	if (schema?.anyOf) {
		const branches = schema.anyOf.filter((branch) => !(branch?.type === "null" || branch?.const === null));
		if (branches.length === 1) return structuredClone(branches[0]);
		if (branches.length > 1) return { anyOf: structuredClone(branches) };
	}
	if (Array.isArray(schema?.type) && schema.type.includes("null")) return { ...structuredClone(schema), type: schema.type.filter((type) => type !== "null") };
	return structuredClone(schema);
}
const withNullable = (schema) => schemaAllowsNull(schema) ? structuredClone(schema) : { anyOf: [structuredClone(schema), { type: "null" }] };

/** Strict-schema tree for one book target: all actions/variants for that target, and none from sibling targets. */
export function bookTargetParameters(source, target) {
	const actions = BOOK_BRANCH_ACTIONS[target];
	if (!actions) throw new Error(`The book target ${target} has no operation tree.`);
	const projections = actions.flatMap((action) => {
		const variants = bookBranchVariants(target, action);
		return (variants.length === 0 ? [undefined] : variants).map((variant) => bookBranchParameters(source, target, action, variant));
	});
	const sourceProps = source.properties ?? {};
	const keys = new Set(projections.flatMap((schema) => Object.keys(schema.properties ?? {})));
	keys.delete("book"); keys.delete("ops"); keys.delete("text");
	const properties = {};
	for (const key of keys) {
		if (key === "target") properties.target = { type: "string", const: target, description: "Selected book target." };
		else if (key === "action") properties.action = oneOf(actions, { description: `An action supported by ${target}.` });
		else if (key === "operation") {
			const branches = [...new Map(projections.map((schema) => schema.properties?.operation).filter(Boolean).map((branch) => [JSON.stringify(branch), branch])).values()];
			properties.operation = { anyOf: [...branches, { type: "null" }] };
		} else properties[key] = structuredClone(sourceProps[key]);
	}
	const anyOf = projections.map((projection) => {
		const required = new Set(projection.required ?? []);
		const branchProps = {};
		for (const key of keys) {
			if (key === "target") { branchProps.target = projection.properties.target; continue; }
			if (key === "action") { branchProps.action = projection.properties.action; continue; }
			const property = projection.properties?.[key];
			branchProps[key] = property === undefined ? { type: "null" } : required.has(key) ? nonNullSchema(property) : withNullable(property);
		}
		return { type: "object", properties: branchProps, required: [...new Set(["target", ...(projection.required ?? [])])], additionalProperties: false };
	});
	return { type: "object", properties, required: ["target", "action"], anyOf, additionalProperties: false };
}

function specializeOperation(target, action, operationSchema, variant) {
	const schema = structuredClone(operationSchema);
	for (const condition of schema.allOf ?? []) {
		const keys = Object.keys(condition?.if?.properties ?? {});
		const allowed = target === "ledger" && action === "add" ? ["kind"] : target === "plan" && ["add", "edit"].includes(action) ? ["mode"] : [];
		if (keys.length === 0 || keys.some((key) => !allowed.includes(key))) throw new Error(`The ${target}.${action} operation has an unsupported conditional; refusing to drop it.`);
	}
	delete schema.allOf;
	if (["assessment", "practice"].includes(target) && action === "add") {
		schema.properties.kind = { type: "string", const: target, description: `The selected ${target} book.` };
	}
	if (target === "ledger" && action === "add") {
		if (![...KINDS].includes(variant)) throw new Error("ledger.add needs a kind choice (goal, question, or note) to specialize its schema.");
		schema.properties.kind = { type: "string", const: variant, description: "The selected ledger entry kind." };
		if (variant === POLICY.enums.ledgerKind.goal) schema.required = [...new Set([...(schema.required ?? []), "done_when"])];
		else delete schema.properties.done_when;
	}
	if (target === "plan" && ["add", "edit"].includes(action)) {
		if (action === "add" && !MODES.includes(variant)) throw new Error("plan.add needs a mode choice (look or change) to specialize its schema.");
		if (action === "edit" && ![...MODES, "text", "network", "standing"].includes(variant)) throw new Error("plan.edit needs a mode or field choice (look, change, text, network, or standing) to specialize its schema.");
		if (variant === POLICY.enums.planMode.look) {
			schema.properties.mode = { type: "string", const: variant, description: "The selected plan mode." };
			delete schema.properties.network;
			delete schema.properties.standing;
			schema.required = [...new Set([...(schema.required ?? []), "mode"])];
		} else if (variant === POLICY.enums.planMode.change) {
			schema.properties.mode = { type: "string", const: variant, description: "The selected plan mode." };
			schema.required = [...new Set([...(schema.required ?? []), "mode"])];
		} else {
			const field = variant;
			if (!["text", "network", "standing"].includes(field)) throw new Error("plan.edit selected an unknown field branch.");
			for (const key of ["mode", "text", "network", "standing"]) if (key !== field) delete schema.properties[key];
			schema.required = [...new Set([...(schema.required ?? []), field])];
			delete schema.anyOf;
		}
	}
	return schema;
}

/**
 * @param {{ root: string, brainDir: string, config: object, engine: object, gate?: { yolo: boolean } }} input
 */
export function bookTool({ root, brainDir, config, engine, gate }) {
	const validationSchema = obj(
		{
			// Legacy book/ops calls remain readable for old sessions; all new calls use target+action below.
			book: opt(oneOf(POLICY.enums.bookNames, {
				description: "Legacy compatibility only. New calls use target and action.",
			})),
			ops: opt(arr(unknown(), { description: "Legacy compatibility only: exactly one operation per call." })),
			text: opt(line("Legacy whole-assessment replacement only.")),
			target: opt(oneOf(UNIVERSAL_TARGETS, { description: "The referenced entity family, or shelf." })),
			action: opt(oneOf(UNIVERSAL_ACTIONS, { description: "One target-specific operation. Unsupported target/action pairs fail closed." })),
			ref: opt(REFERENCE_SCHEMA),
			path: opt(str({ description: "Explicit project-relative locator, accepted only for file resolution." })),
			range: opt(str({ description: 'File selection such as "10-80"; omitted means the full text selection.' })),
			placementId: opt(str({ description: "The exact temporary shelf placement ID, not its target ID." })),
			planItem: opt(str({ description: "Required authorized change-plan item for file create/edit." })),
			expectedVersion: opt(str({ description: "Required SHA-256 content version for file edit; stale versions are rejected." })),
			content: opt(str({ description: "Whole UTF-8 text for file create." })),
			oldText: opt(str({ description: "Exact passage to replace in file edit." })),
			newText: opt(str({ description: "Replacement passage in file edit." })),
			handOn: opt(bool({ description: "When adding from a focus, hand this placement to the shared shelf on return." })),
			operation: opt(unknown({ description: "One target-specific operation payload for brain-record mutations." })),

		},
		{ allOf: BOOK_CONDITIONS },
	);
	const validate = compile(validationSchema, { coerce: true });
	return defineTool({
		name: "book",
		description: describe("book"),
		parameters: validationSchema,
		prepareArguments(args) {
			const result = validate.parse(args);
			if (result.ok) {
				const value = result.value;
				const hasTarget = value.target !== undefined;
				const hasAction = value.action !== undefined;
				if (hasTarget !== hasAction) throw new Error("Validation failed for tool \"book\": target and action are both required.");
				if (hasTarget) {
					if (value.book !== undefined || value.ops !== undefined || value.text !== undefined) throw new Error("Validation failed for tool \"book\": use exactly one interface: target+action or the legacy book form, never both.");
					if (value.ref !== undefined && !validateReference(value.ref)) throw new Error("Validation failed for tool \"book\": ref must be { namespace, kind, id, version? }.");
					const target = value.target;
					const action = value.action;
					const requireRef = () => { if (value.ref === undefined) throw new Error(`Validation failed for tool \"book\": ${target} ${action} needs a typed ref.`); };
					if (target === "file" && ["inspect", "read"].includes(action) && value.ref === undefined && value.path === undefined) throw new Error(`Validation failed for tool \"book\": file ${action} needs ref or path.`);
					if (target === "file" && action === "create" && (typeof value.path !== "string" || typeof value.content !== "string")) throw new Error("Validation failed for tool \"book\": file create needs path and content.");
					if (target === "file" && action === "edit") { requireRef(); if (typeof value.expectedVersion !== "string" || typeof value.oldText !== "string" || typeof value.newText !== "string") throw new Error("Validation failed for tool \"book\": file edit needs ref, expectedVersion, oldText, and newText."); }
					if (target === "file" && action === "rebind") { requireRef(); if (typeof value.expectedVersion !== "string" || typeof value.path !== "string") throw new Error("Validation failed for tool \"book\": file rebind needs ref, expectedVersion, and path."); }
					if (target === "report" && ["inspect", "read", "recall", "archive", "restore", "remove"].includes(action)) requireRef();
					if (target === "report" && ["archive", "restore", "remove"].includes(action) && value.expectedVersion === undefined && value.ref?.version === undefined) throw new Error("Validation failed for tool \"book\": report mutations need expectedVersion or a version-pinned ref.");
					if (DURABLE_TARGETS.has(target) && ["inspect", "read"].includes(action)) requireRef();
					if (target === "message" && action === "edit") { requireRef(); if (value.expectedVersion === undefined && value.ref?.version === undefined) throw new Error("Validation failed for tool \"book\": message edit needs expectedVersion or a version-pinned ref."); }
					if (target === "shelf" && action === "add" && value.ref === undefined && value.path === undefined) throw new Error("Validation failed for tool \"book\": shelf add needs a ref or path.");
					if (target === "shelf" && action === "remove" && !value.placementId) throw new Error("Validation failed for tool \"book\": shelf remove needs placementId.");
					if (BRAIN_TARGETS.has(target)) {
						if (["inspect", "read"].includes(action)) requireRef();
						if (BRAIN_MUTATIONS[target]?.has(action)) {
							if (action !== "add") requireRef();
							if (value.operation === undefined && !(target === "context" && ["archive", "restore"].includes(action))) throw new Error(`Validation failed for tool \"book\": ${target} ${action} needs an operation payload.`);
							if (action !== "add" && value.expectedVersion === undefined && value.ref?.version === undefined) throw new Error(`Validation failed for tool \"book\": ${target} ${action} needs expectedVersion (or a version-pinned ref).`);
						}
					}
					return value;
				}
				if (value.book === undefined) throw new Error("Validation failed for tool \"book\": use target+action.");
				if (Array.isArray(value.ops) && value.ops.length !== 1) throw new Error("Validation failed for tool \"book\": exactly one operation per call; send one op at a time.");
				return value;
			}
			const path = (pointer) => pointer === "" ? "root" : pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")).join(".");
			const issues = [...result.errors];
			const planAdds = args?.book === POLICY.enums.bookName.plan && Array.isArray(args.ops) ? args.ops.filter((op) => op?.action === POLICY.enums.actions.add) : [];
			const hasRootPlanText = args?.book === POLICY.enums.bookName.plan && Object.hasOwn(args, "text");
			if (hasRootPlanText) {
				// The conditional schema also reports this as an opaque `not` failure; replace it with the actionable cause.
				for (let index = issues.length - 1; index >= 0; index--) {
					if (issues[index].path === "" && issues[index].keyword === "not") issues.splice(index, 1);
				}
				issues.push({ path: "/text", message: "root text is only for the legacy whole-assessment form with book=books; plan wording belongs inside each add operation" });
			}
			const errors = issues.map((error) => `  - ${path(error.path)}: ${error.message}`).join("\n");
			const hints = planAdds.some((op) => op.mode === undefined || op.text === undefined)
				? '\nPlan add shape: {"action":"add","mode":"look or change","text":"one-line plan item"}. Put both `mode` and `text` in every add operation.'
				: "";
			// Do not echo the arguments: malformed text can be very large and the agent already has its original call.
			throw new Error(`Validation failed for tool "book":\n${errors}${hints}`);
		},

		executionMode: "sequential",
		// Safe to run again after a crash: the ledger and the plan remember the last call they applied,
		// and the rest of the books change nothing when the same words are written twice.
		replay: POLICY.enums.toolReplay.safe,
		execute: async (args, api, callContext) => {
			if (args.target !== undefined) {
				const main = api.conversationId === ROOT_CONVERSATION_ID;
				const mutation = args.target === "file" && ["create", "edit"].includes(args.action);
				const externalWork = args.target === "file" && ["inspect", "read", "create", "edit", "rebind"].includes(args.action)
					|| args.target === "report" && ["inspect", "read"].includes(args.action)
					|| DURABLE_TARGETS.has(args.target) && ["list", "inspect", "read", "edit"].includes(args.action)
					|| args.target === "shelf" && args.action === "add";
				if (main && mutation && (typeof args.planItem !== "string" || args.planItem.trim() === "")) return fail("file create/edit needs an authorized change planItem; first get it approved in the plan.");
				if (main && externalWork) {
					const focusedArgs = args.target === "shelf" && args.action === "add" ? { ...args, handOn: true } : args;
					const taskArgs = {
						brief: `Perform exactly one bounded book operation, then return immediately. Call book once with these exact arguments: ${JSON.stringify(focusedArgs)}. Do not broaden scope, do not make project changes except the explicitly requested authorized operation, and return its result.`,
						...(mutation ? { item: args.planItem } : {}),
					};
					const task = await api.executeTool("task", taskArgs, callContext, { key: "book-focus" });
					const nested = task.structuredOutput;
					const report = typeof nested === "string" ? nested : Array.isArray(nested) ? nested.flatMap((part) => part?.type === "text" ? [part.text] : []).join("\\n") : JSON.stringify(nested ?? task.diagnostics);
					return { isError: task.isError, output: [{ type: "text", text: report }], details: { target: args.target, action: args.action, focus: true, ...(task.details ?? {}) } };
				}
				return await runUniversal({ root, brainDir, config, engine, gate }, args, api, callContext);
			}
			const book = args.book;
			if (book === POLICY.enums.bookName.plan && api.conversationId !== ROOT_CONVERSATION_ID) {
				return fail(`Tool call blocked: ${TASK_REFUSALS.plan} ${STILL_TASK}`);
			}
			const runner = { ledger: runLedger, plan: runPlan, books: runBooks, context: runContext }[book];
			if (runner === undefined) return fail(`\`book\` is one of ledger, plan, books, context.`);
			const result = runner({ root, brainDir, config, engine, gate }, args, api);
			result.details = { book, ...result.details };
			return result;
		},
	});
}
