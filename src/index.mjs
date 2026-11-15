// The Durable-record index for the `book` tool's durable targets — a namespace-scoped memo of derived records at
// `.atlas/catalog/index.json`. The probe asks one cheap question per conversation ("any entry newer than the watermark?")
// plus one per task table scan; when the answer is "no", list paths serve the memo without touching the store. When the
// answer is "yes", one full derivation rebuilds it. It is a memo, not a database: correctness never depends on it.
// Nested-call snapshots (NestedCallDoc) are read only when (re)building, and for a single `read`; never per list render.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NestedCallDoc } from "@earendil-works/pi-durable";
import { POLICY } from "./config.mjs";
import { ensureCatalog, contentVersion } from "./catalog.mjs";
import { loadContext } from "./context.mjs";

const INDEX_VERSION = 1;
const indexPath = (brainDir) => join(brainDir, "catalog", "index.json");

/** Load and validate the memo; undefined when missing, corrupt, or from another namespace (a fork invalidates it). */
export function loadDurableIndex(brainDir) {
	let raw;
	try { raw = readFileSync(indexPath(brainDir), "utf8"); } catch { return undefined; }
	try {
		const value = JSON.parse(raw);
		if (value?.version !== INDEX_VERSION || typeof value.namespace !== "string" || !Number.isFinite(value.highEntryId) || !Number.isFinite(value.highTaskId) || !Array.isArray(value.records)) return undefined;
		return value;
	} catch { return undefined; }
}

function saveDurableIndex(brainDir, index) {
	const path = indexPath(brainDir);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(index)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	} catch {
		try { renameSync(temp, path); } catch { /* a corrupt or racing save is a cache miss next time, never a correctness problem */ }
	}
}

const idComponent = (value) => {
	const text = String(value ?? "");
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text) ? text : createHash("sha256").update(text).digest("hex").slice(0, 16);
};
const oneLine = (value, max = 240) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Composite IDs for tool calls and nested calls: dotted, opaque, and short enough for any realistic input. */
export const toolCallId = (conversationId, entryId, callId) => `tc:${conversationId}:${entryId}:${idComponent(callId)}`;
export const nestedCallId = (parentTaskId, parentCallId, key) => `nt:${parentTaskId}:${idComponent(parentCallId)}:${idComponent(key)}`;

/** Recursively scan a paged query to completion. */
export async function scanAll(fetch) {
	const records = [];
	let cursor;
	do {
		const page = await fetch(cursor);
		records.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return records;
}

/** The probe: true when nothing has been committed since the memo was built. Runs inside a commit, tiny reads only. */
async function indexFresh(tx, stored) {
	const conversations = await scanAll((cursor) => tx.scanConversations({}, POLICY.limits.taskHistory.contextEntries, cursor));
	for (const conversation of conversations) {
		const page = await tx.scanEntries({ conversationId: conversation.id, order: "ascending", minEntryId: stored.highEntryId + 1 }, 1);
		if (page.items.length > 0) return false;
	}
	const newest = await tx.scanTasks({ kind: "pi.tool", order: "descending" }, 1);
	return Number(newest.items[0]?.id ?? 0) <= Number(stored.highTaskId);
}

const stripValue = ({ value, ...record }) => record;

const sortRecords = (records) => records.sort((a, b) =>
	Number(a.conversationId ?? Number.MAX_SAFE_INTEGER) - Number(b.conversationId ?? Number.MAX_SAFE_INTEGER)
	|| Number(a.entryId ?? Number.MAX_SAFE_INTEGER) - Number(b.entryId ?? Number.MAX_SAFE_INTEGER)
	|| Number(a.taskId ?? 0) - Number(b.taskId ?? 0)
	|| a.kind.localeCompare(b.kind)
	|| String(a.id).localeCompare(String(b.id)),
);

/** Derive the records of one stored entry (message, prompt, tool calls, tool results). Shared by full builds. */
function deriveEntryRecords(entry, tasksByCall, taskById) {
	const records = [];
	const messages = Array.isArray(entry.model) ? entry.model : [];
	const push = (record) => records.push(record);
	for (const message of messages) {
		if (["user", "assistant"].includes(message.role) && !(Array.isArray(message.content) && message.content.some((part) => part?.type === "toolCall"))) {
			const value = { role: message.role, message, entryId: entry.id, conversationId: entry.conversationId };
			push({ kind: "message", id: String(entry.id), version: contentVersion(message), summary: oneLine(message.role), provenance: { entryId: entry.id, conversationId: entry.conversationId }, value, conversationId: entry.conversationId, entryId: entry.id, locator: { conversationId: entry.conversationId, entryId: entry.id } });
			break;
		}
	}
	for (const message of messages) {
		if (!Array.isArray(message?.content)) continue;
		for (const part of message.content) {
			if (part?.type !== "toolCall") continue;
			const id = toolCallId(entry.conversationId, entry.id, part.id);
			const task = tasksByCall.get(`${entry.id}:${part.id}`);
			const resultEntryId = task?.state?.outcome?.result?.kind === "model" ? task.state.outcome.result.entryId : undefined;
			const provenance = { conversationId: entry.conversationId, assistantEntryId: entry.id, providerCallId: part.id, ...(task ? { toolTaskId: task.id } : {}), ...(resultEntryId !== undefined ? { resultEntryId } : {}) };
			push({ kind: "toolCall", id, version: contentVersion(part), summary: oneLine(part.name), provenance, value: { ...provenance, call: part }, conversationId: entry.conversationId, entryId: entry.id, taskId: task?.id, locator: { conversationId: entry.conversationId, entryId: entry.id } });
		}
	}
	if (entry.kind === "pi.tool-result") {
		const task = taskById.get(entry.byTaskId);
		const input = task?.input;
		const call = input?.kind === "model" ? { assistantEntryId: input.assistant, providerCallId: input.callId } : undefined;
		const value = { entry: entry.model?.[0], diagnostics: entry.data, entryId: entry.id, taskId: entry.byTaskId, ...(call ? { call } : {}) };
		const provenance = { resultEntryId: entry.id, taskId: entry.byTaskId, ...(call ?? {}) };
		push({ kind: "toolResult", id: String(entry.id), version: contentVersion(value), summary: oneLine(value.entry?.content ?? entry.data?.code ?? entry.id), provenance, value, conversationId: entry.conversationId, entryId: entry.id, taskId: entry.byTaskId, locator: { conversationId: entry.conversationId, entryId: entry.id } });
	}
	if (entry.kind === "pi.system") {
		const value = { entryId: entry.id, messages };
		push({ kind: "prompt", id: String(entry.id), version: contentVersion(value), summary: oneLine(messages.find((m) => m.role === "system")?.content ?? "system prompt", 120), provenance: { entryId: entry.id }, value, conversationId: entry.conversationId, entryId: entry.id, locator: { conversationId: entry.conversationId, entryId: entry.id } });
	}
	return records;
}

/**
 * Records of nested calls (a tool that called a tool). The call record stands on its own; the result record exists only
 * when the nested-call document does (it is resolved by the caller, outside the transaction). A nested call whose result
 * document is missing — still running, or interrupted — yields no `toolResult` record: one that does not exist is not a record.
 */
function nestedCallRecords(tasks) {
	const records = [];
	for (const task of tasks) {
		const input = task.input;
		if (input?.kind !== "nested") continue;
		const id = nestedCallId(input.parent, input.parentCallId, input.key);
		const provenance = { conversationId: task.conversationId, parentTaskId: input.parent, parentCallId: input.parentCallId, nestedKey: input.key, toolTaskId: task.id };
		const locator = { conversationId: task.conversationId, taskId: task.id, nested: { parent: input.parent, parentCallId: input.parentCallId, key: input.key } };
		records.push({ kind: "toolCall", id, version: contentVersion(input.call), summary: oneLine(input.call?.name), provenance, value: { ...provenance, call: input.call }, conversationId: task.conversationId, taskId: task.id, locator });
		records.push({ kind: "toolResult", id, version: contentVersion({ pendingNested: id }), summary: oneLine(input.call?.name), provenance: { ...provenance, resultFor: id }, value: undefined, resultPending: true, conversationId: task.conversationId, taskId: task.id, locator });
	}
	return records;
}

/** Tool registry records: constant within the process, so derived fresh every time and never memoized. */
function toolRecords(target, api) {
	return api.registry.tools().map(({ extension, tool }) => {
		const id = `${extension.name}:${tool.name}`;
		const schema = tool.parameters ?? {};
		const value = target === "schema" ? schema : { extension: extension.name, name: tool.name, description: tool.description, schema };
		return { kind: target, id, version: contentVersion(value), summary: oneLine(target === "schema" ? id : tool.name), provenance: { extension: extension.name, tool: tool.name }, value, locator: { tool: id } };
	});
}

/** The soft-forget filter is context-store state, not Durable state: applied at query time so the memo stays valid. */
function forgottenFilter(records, brainDir) {
	const forgotten = new Set(loadContext(brainDir).forgottenEntries ?? []);
	if (forgotten.size === 0) return records;
	return records.filter((record) => record.kind !== "message" || !forgotten.has(String(record.id)));
}

const DURABLE_MEMO_KINDS = ["conversation", "message", "toolCall", "toolResult", "prompt"];

/**
 * The full derivation, one pass. Returns { records, highEntryId, highTaskId, pendingNested } where pendingNested lists
 * the nested tasks whose result docs still need resolving (caller does it outside the transaction).
 */
async function deriveAll(tx) {
	const conversations = (await scanAll((cursor) => tx.scanConversations({}, POLICY.limits.taskHistory.contextEntries, cursor))).sort((a, b) => Number(a.id) - Number(b.id));
	const entries = [];
	for (const conversation of conversations) {
		const page = await scanAll((cursor) => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, POLICY.limits.taskHistory.contextEntries, cursor));
		entries.push(...page);
	}
	const tasks = await scanAll((cursor) => tx.scanTasks({ kind: "pi.tool", order: "ascending" }, POLICY.limits.taskHistory.contextEntries, cursor));
	const taskById = new Map(tasks.map((task) => [task.id, task]));
	const tasksByCall = new Map();
	for (const task of tasks) {
		const input = task.input;
		if (input?.kind === "model") tasksByCall.set(`${input.assistant}:${input.callId}`, task);
	}
	const records = [];
	for (const record of conversations) {
		records.push({ kind: "conversation", id: String(record.id), version: contentVersion(record), summary: `conversation ${record.id}`, provenance: { conversationId: record.id }, value: record, conversationId: record.id, locator: { conversationId: record.id } });
	}
	for (const entry of entries) records.push(...deriveEntryRecords(entry, tasksByCall, taskById));
	records.push(...nestedCallRecords(tasks));
	return { records: sortRecords(records), highEntryId: Math.max(0, ...entries.map((entry) => Number(entry.id))), highTaskId: Math.max(0, ...tasks.map((task) => Number(task.id))) };
}

/** Resolve the deferred nested-result snapshots outside the transaction; patches records in place or drops the ones without a result. */
async function fillNestedResults(records, api, callContext) {
	const kept = [];
	for (const record of records) {
		if (record.resultPending !== true) { kept.push(record); continue; }
		const { parent, key } = record.locator.nested;
		let snapshot;
		try { snapshot = await api.snapshot(NestedCallDoc, parent, key, callContext); } catch { snapshot = undefined; }
		if (snapshot?.result === undefined) continue;
		record.version = contentVersion(snapshot.result);
		record.value = snapshot.result;
		delete record.resultPending;
		kept.push(record);
	}
	return kept;
}

/**
 * All derived records (values included), rebuilding the memo when it is missing, corrupt, from another namespace, or
 * stale. A fresh memo serves summaries straight from the file; values are then located by descriptor, not re-derived.
 */
export async function durableIndex(brainDir, api, callContext) {
	let namespace;
	try { namespace = ensureCatalog(brainDir).namespace; } catch (error) { throw new Error(`The brain-store catalog cannot be read: ${error.message}`); }
	const stored = loadDurableIndex(brainDir);
	const probe = await api.commit(async (tx) => stored !== undefined && stored.namespace === namespace && await indexFresh(tx, stored), callContext);
	if (probe) return { records: stored.records, fresh: true, namespace };
	const built = await api.commit(async (tx) => deriveAll(tx), callContext);
	const records = await fillNestedResults(built.records, api, callContext);
	saveDurableIndex(brainDir, { version: INDEX_VERSION, namespace, highEntryId: built.highEntryId, highTaskId: built.highTaskId, records: records.map(stripValue) });
	return { records, fresh: false, namespace };
}

/** Summary records (no values) for list paths, with the soft-forget filter applied. */
export async function durableSummaries(target, brainDir, api, callContext) {
	if (target === "tool" || target === "schema") return toolRecords(target, api);
	const { records } = await durableIndex(brainDir, api, callContext);
	return forgottenFilter(records.filter((record) => record.kind === target), brainDir);
}

/**
 * One record with its value, or undefined. Fresh memo → point reads bounded by the entry itself; otherwise one full
 * derivation (which rebuilds the memo as a side effect). Nested single records take the full-derivation path.
 */
export async function durableRecordFor(target, id, brainDir, api, callContext) {
	if (target === "tool" || target === "schema") return toolRecords(target, api).find((record) => record.id === id);
	let namespace;
	try { namespace = ensureCatalog(brainDir).namespace; } catch (error) { throw new Error(`The brain-store catalog cannot be read: ${error.message}`); }
	const stored = loadDurableIndex(brainDir);
	const located = await api.commit(async (tx) => {
		if (stored === undefined || stored.namespace !== namespace || !(await indexFresh(tx, stored))) return undefined;
		return stored.records.find((record) => record.kind === target && record.id === id);
	}, callContext);
	if (stored !== undefined && located !== undefined && located.locator?.nested === undefined) {
		// Fast path: re-derive this one record from its bounded source, keeping the memo's linkage.
		const single = await api.commit(async (tx) => {
			if (located.locator.entryId !== undefined) {
				const page = await tx.scanEntries({ conversationId: located.locator.conversationId, order: "ascending", minEntryId: Number(located.locator.entryId), maxEntryId: Number(located.locator.entryId) }, 1);
				const entry = page.items[0];
				if (entry === undefined) return undefined;
				const tasksByCall = new Map(); const taskById = new Map();
				if (target === "toolCall" || target === "toolResult") {
					const tasks = await scanAll((cursor) => tx.scanTasks({ kind: "pi.tool", order: "ascending" }, POLICY.limits.taskHistory.contextEntries, cursor));
					for (const task of tasks) { taskById.set(task.id, task); const input = task.input; if (input?.kind === "model") tasksByCall.set(`${input.assistant}:${input.callId}`, task); }
				}
				const derived = deriveEntryRecords(entry, tasksByCall, taskById).find((record) => record.kind === target && record.id === id);
				return derived;
			}
			if (target === "conversation") {
				const record = await tx.conversation(Number(located.locator.conversationId));
				return record === undefined ? undefined : { kind: "conversation", id: String(record.id), version: contentVersion(record), summary: `conversation ${record.id}`, provenance: { conversationId: record.id }, value: record, conversationId: record.id, locator: { conversationId: record.id } };
			}
			return undefined;
		}, callContext);
		if (single !== undefined) {
			if (target === "message" && single.kind === "message") {
				if ((new Set(loadContext(brainDir).forgottenEntries ?? [])).has(String(single.id))) return undefined;
			}
			return single;
		}
		// Fall through to the full derivation (the source moved under us; the memo will rebuild).
	}
	// Slow path: one full derivation. Rebuilds the memo when it is missing/stale, which is the common case after a change.
	const built = await durableIndex(brainDir, api, callContext);
	for (const record of built.records) {
		if (record.kind !== target || record.id !== id) continue;
		if (record.kind === "message" && (new Set(loadContext(brainDir).forgottenEntries ?? [])).has(String(record.id))) return undefined;
		return record;
	}
	return undefined;
}

