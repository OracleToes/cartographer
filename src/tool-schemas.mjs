import { createHash } from "node:crypto";
import { defineTool } from "@earendil-works/pi-durable";
import { POLICY } from "./config.mjs";
import { nativeReference, readReferenceVersion, retainReferenceVersion } from "./catalog.mjs";
import { BOOK_BRANCH_ACTIONS, bookTargetParameters } from "./tools/book.mjs";
import { oneOf, obj } from "@earendil-works/pi-schema";

const BOOK_BRANCHES = Object.keys(BOOK_BRANCH_ACTIONS);
const STRICT_KEYWORDS = new Set([
	"type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf",
	"description", "title", "default", "minLength", "maxLength", "pattern", "minimum", "maximum",
	"exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "uniqueItems", "format",
]);
const bookBranchRequest = obj({ target: oneOf(BOOK_BRANCHES, { description: "Select one book branch to load its full action schema; this does not perform an operation." }) });
const allowsNull = (schema) => schema?.type === "null" || (Array.isArray(schema?.type) && schema.type.includes("null")) || schema?.const === null || schema?.enum?.includes?.(null) || schema?.anyOf?.some(allowsNull);

/** Convert optional object properties to the provider's strict-required/nullable form, refusing unsupported schemas. */
function strictSchema(schema, location = "$") {
	if (schema === null || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`Strict schema at ${location} must be an object.`);
	for (const [key, value] of Object.entries(schema)) {
		if (!STRICT_KEYWORDS.has(key)) throw new Error(`Strict schema at ${location} uses unsupported keyword ${key}; refusing a non-strict fallback.`);
		if (key === "properties") {
			if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Strict schema at ${location}.properties must be an object.`);
			for (const [name, child] of Object.entries(value)) value[name] = strictSchema(child, `${location}.properties.${name}`);
		} else if (key === "items") {
			schema.items = strictSchema(value, `${location}.items`);
		} else if (key === "anyOf") {
			if (!Array.isArray(value) || value.length === 0) throw new Error(`Strict schema at ${location}.anyOf must be non-empty.`);
			schema.anyOf = value.map((child, index) => strictSchema(child, `${location}.anyOf[${index}]`));
		}
	}
	if (schema.type === "object") {
		if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new Error(`Strict schema at ${location} allows additional properties.`);
		const properties = schema.properties ?? {};
		const required = new Set(Array.isArray(schema.required) ? schema.required : []);
		if ([...required].some((key) => !(key in properties))) throw new Error(`Strict schema at ${location} requires a missing property.`);
		for (const [name, child] of Object.entries(properties)) {
			if (required.has(name) || allowsNull(child)) continue;
			if (child.type === "array") properties[name] = { ...child, type: ["array", "null"] };
			else properties[name] = { anyOf: [child, { type: "null" }] };
		}
		schema.required = Object.keys(properties);
		schema.additionalProperties = false;
	} else if (schema.properties !== undefined && Array.isArray(schema.required)) {
		if (schema.required.some((key) => !(key in schema.properties))) throw new Error(`Strict schema at ${location} requires a missing property.`);
	}
	return schema;
}

/** Remove strict-mode null sentinels only where the original schema marks that field optional. */
function cleanNullableArgs(value, schema) {
	if (Array.isArray(value)) return value.map((item) => cleanNullableArgs(item, schema?.items));
	if (value === null || typeof value !== "object") return value;
	const branches = schema?.anyOf ?? schema?.oneOf;
	if (Array.isArray(branches)) {
		const matching = branches.find((branch) => matchesSchema(value, branch, { requireAll: false }));
		if (matching) schema = matching;
	}
	if (schema?.type !== "object" && !schema?.properties) return value;
	const required = new Set(schema.required ?? []);
	const clean = {};
	for (const [key, item] of Object.entries(value)) {
		const child = schema.properties?.[key] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined);
		if (item === null && (allowsNull(child) || !required.has(key))) continue;
		clean[key] = cleanNullableArgs(item, child);
	}
	return clean;
}

/** A lightweight shape check to select the right local cleanup schema; full validation remains tool-local. */
function matchesSchema(value, schema, { requireAll = true } = {}) {
	if (value === null) return allowsNull(schema);
	if (schema?.const !== undefined && value !== schema.const) return false;
	if (Array.isArray(schema?.enum) && !schema.enum.includes(value)) return false;
	if (Array.isArray(schema?.anyOf) && !schema.anyOf.some((branch) => matchesSchema(value, branch, { requireAll }))) return false;
	if (Array.isArray(schema?.type) && !schema.type.some((type) => matchesSchema(value, { ...schema, type }, { requireAll }))) return false;
	if (schema?.type === "object" || schema?.properties !== undefined) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
		if (requireAll && (schema.required ?? []).some((key) => !Object.hasOwn(value, key))) return false;
		if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties ?? {}, key))) return false;
		return Object.entries(schema.properties ?? {}).every(([key, child]) => !Object.hasOwn(value, key) || matchesSchema(value[key], child, { requireAll }));
	}
	if (schema?.type === "array") return Array.isArray(value) && value.every((item) => matchesSchema(item, schema.items, { requireAll }));
	if (schema?.type === "string") return typeof value === "string";
	if (schema?.type === "integer") return Number.isInteger(value);
	if (schema?.type === "number") return typeof value === "number" && Number.isFinite(value);
	if (schema?.type === "boolean") return typeof value === "boolean";
	if (Array.isArray(schema?.required)) return value !== null && typeof value === "object" && schema.required.every((key) => Object.hasOwn(value, key));
	return true;
}

function isBookBranchRequest(args) {
	return args !== null && typeof args === "object" && !Array.isArray(args)
		&& typeof args.target === "string" && BOOK_BRANCHES.includes(args.target)
		&& Object.keys(args).length === 1;
}

function providerTool(payload, name) {
	if (!Array.isArray(payload?.tools)) throw new Error("The provider request has no tools array; strict book schema routing is unavailable.");
	const tool = payload.tools.find((entry) => entry?.type === "function" && entry.function?.name === name);
	if (!tool) throw new Error(`Provider request did not contain the top-level ${name} tool; refusing to send an incomplete request.`);
	return tool;
}

/**
 * Keep all top-level tools visible. `book` first exposes its target choices; a `book` call with only a target
 * loads that branch's complete schema, and the next request exposes that schema on the ordinary `book` tool.
 */
export function createToolSchemaLifecycle(tools, { schemaBudgetTokens = 4096, brainDir } = {}) {
	const operations = tools.filter((tool) => tool.callers === undefined || tool.callers.includes("model"));
	const byName = new Map(operations.map((tool) => [tool.name, tool]));
	const book = byName.get("book");
	if (book === undefined) throw new Error("The top-level book tool is required for hierarchical schema routing.");
	const pending = new Map();

	async function loadBookBranch(args, api) {
		const target = args.target;
		let parameters;
		try {
			parameters = strictSchema(bookTargetParameters(book.parameters, target));
		} catch (error) {
			return { isError: true, output: [{ type: "text", text: `Cannot load a strict schema for book.${target}: ${error.message} No operation was enabled.` }] };
		}
		const schemaVersionText = JSON.stringify(parameters);
		const schemaText = JSON.stringify(parameters, null, 2);
		const schemaVersion = createHash("sha256").update(schemaVersionText).digest("hex");
		const schemaId = `cartographer:book:${target}:tree`;
		const schemaRef = brainDir === undefined ? undefined : nativeReference(brainDir, "schema", schemaId, schemaVersion);
		const referenceText = schemaRef === undefined ? "" : `Schema reference: ${JSON.stringify(schemaRef)}\n`;
		const prelude = `${referenceText}Loaded the complete book.${target} action schema into the next request's context. Use it for the next book operation.\n\n`;
		const estimatedTokens = Math.ceil((schemaText.length + prelude.length + 32) / POLICY.estimation.charsPerToken);
		if (estimatedTokens > schemaBudgetTokens) return { isError: true, output: [{ type: "text", text: `The book.${target} schema is about ${estimatedTokens} tokens, above the ${schemaBudgetTokens}-token schema budget; no operation was enabled.` }] };
		if (brainDir !== undefined) retainReferenceVersion(brainDir, schemaRef, parameters);
		pending.set(api.conversationId, { name: "book", branch: target, parameters, description: book.description, prelude, schemaVersion, schemaRef });
		return {
			output: [{ type: "text", text: `Loaded the book.${target} schema into request context. No book operation was performed; call book with a ${target} action next.` }],
			details: {
				schemaRef: { ...(schemaRef ?? {}), estimatedTokens },
				schemaSelection: { tool: "book", branch: target, phase: "book-target", description: book.description },
			},
		};
	}

	return {
		pending,
		isBookBranchRequest: (call) => call?.name === "book" && isBookBranchRequest(call.arguments),
		normalizeTool: (tool) => {
			const originalPrepare = tool.prepareArguments;
			const originalExecute = tool.execute;
			return {
				...tool,
				prepareArguments: (args) => {
					if (tool.name === "book" && isBookBranchRequest(args)) return args;
					const selected = [...pending.values()].find((entry) => entry.name === tool.name && matchesSchema(args, entry.parameters, { requireAll: false }));
					const cleaned = cleanNullableArgs(args, selected?.parameters ?? tool.parameters);
					return originalPrepare ? originalPrepare(cleaned) : cleaned;
				},
				...(originalExecute ? { execute: async (args, api, ...rest) => tool.name === "book" && isBookBranchRequest(args)
					? loadBookBranch(args, api)
					: originalExecute(args, api, ...rest) } : {}),
			};
		},
		/** Keep every top-level call available; only swap the `book` schema between target selection and branch use. */
		beforeProviderRequest: ({ payload, model }, api) => {
			if (model.api !== "openai-completions") throw new Error(`Strict on-demand book schemas require the OpenAI-compatible adapter; ${model.api} cannot be verified.`);
			const selection = pending.get(api.conversationId);
			const parameters = selection === undefined
				? strictSchema(structuredClone(bookBranchRequest))
				: strictSchema(structuredClone(selection.parameters));
			const declared = providerTool(payload, "book");
			const description = selection === undefined
				? "Select a book target to load its full action schema; this call does not perform an operation. Then call book again using that branch's schema."
				: selection.description;
			const tools = payload.tools.map((entry) => entry === declared
				? { ...entry, function: { ...entry.function, description, parameters, strict: true } }
				: entry);
			return { payload: { ...payload, tools } };
		},
		beforeTool: (call, api) => {
			if (call.parent !== undefined || call.name !== "book") return undefined;
			if (isBookBranchRequest(call.arguments)) return undefined;
			const selection = pending.get(api.conversationId);
			if (selection === undefined || selection.branch !== call.arguments?.target) return { block: `Tool call refused: load the book.${call.arguments?.target ?? "?"} schema first by calling book with only its target.` };
			if (!matchesSchema(call.arguments, selection.parameters, { requireAll: false })) return { block: `Tool call refused: arguments do not match the loaded book.${selection.branch} schema. The operation was not run; retry with that branch's required fields and action.` };
			return { arguments: cleanNullableArgs(call.arguments, selection.parameters) };
		},
		afterResponse: (message, api) => {
			const selection = pending.get(api.conversationId);
			if (selection === undefined) return;
			const count = (message.content ?? []).filter((part) => part.type === "toolCall" && part.name === "book" && !isBookBranchRequest(part.arguments)).length;
			if (count > 0) {
				selection.remaining = count;
				selection.failed = false;
			} else pending.delete(api.conversationId);
		},
		afterTool: (call, result, api) => {
			if (call.parent !== undefined || call.name !== "book" || isBookBranchRequest(call.arguments)) return;
			const selection = pending.get(api.conversationId);
			if (selection === undefined || selection.branch !== call.arguments?.target) return;
			if (result?.isError) selection.failed = true;
			if (Number.isInteger(selection.remaining)) selection.remaining--;
			const done = selection.remaining === undefined || selection.remaining <= 0;
			if (done && !selection.failed) pending.delete(api.conversationId);
			const details = result?.details !== null && typeof result?.details === "object" && !Array.isArray(result.details) ? result.details : {};
			return { ...result, details: { ...details, selectedSchemaRef: selection.schemaRef ?? { tool: "book", branch: selection.branch, version: selection.schemaVersion } } };
		},
		forRequest: (messages, conversationId) => {
			let selection = pending.get(conversationId);
			const probeIds = new Set(messages.flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
				? message.content.filter((part) => part.type === "toolCall" && part.name === "book" && isBookBranchRequest(part.arguments)).map((part) => part.id)
				: []));
			const branchResults = messages.filter((message) => message.role === "toolResult" && message.toolName === "book" && probeIds.has(message.toolCallId));
			let activeSchemaResult = selection === undefined ? undefined : branchResults.findLast((message) => message.details?.schemaRef?.version === selection.schemaVersion);
			if (selection === undefined) {
				const latest = branchResults.at(-1);
				if (latest?.isError === true) {
					const index = messages.indexOf(latest);
					if (!messages.slice(index + 1).some((message) => message.role === "assistant")) activeSchemaResult = latest;
				}
			}
			if (selection === undefined && brainDir !== undefined) {
				const candidate = branchResults.at(-1);
				if (candidate?.details?.schemaRef?.version && candidate.details.schemaSelection?.phase === "book-target") {
					const ref = candidate.details.schemaRef;
					const index = messages.indexOf(candidate);
					const tail = messages.slice(index + 1);
					const meta = candidate.details.schemaSelection;
					const lastOperationResult = tail.findLast((message) => message.role === "toolResult" && message.toolName === "book" && message.details?.selectedSchemaRef?.version === ref.version);
					const lastAssistant = tail.findLast((message) => message.role === "assistant");
					const answeredWithoutOperation = lastAssistant?.stopReason === "stop" && !(lastAssistant.content ?? []).some((part) => part.type === "toolCall" && part.name === "book" && !isBookBranchRequest(part.arguments));
					const calls = (lastAssistant?.content ?? []).filter((part) => part.type === "toolCall" && part.name === "book" && !isBookBranchRequest(part.arguments));
					const callIds = new Set(calls.map((call) => call.id));
					const results = tail.filter((message) => message.role === "toolResult" && message.toolName === "book" && callIds.has(message.toolCallId));
					const pendingCall = calls.length > 0 && (results.length < calls.length || results.some((message) => message.isError === true));
					if (!answeredWithoutOperation && (pendingCall || (calls.length === 0 && (lastOperationResult === undefined || lastOperationResult.isError === true)))) {
						const parameters = readReferenceVersion(brainDir, ref);
						if (parameters !== undefined) {
							const referenceText = `Schema reference: ${JSON.stringify(ref)}\n`;
							const prelude = `${referenceText}Loaded the complete book.${meta.branch} action schema into the request context. Use it for the next book operation.\n\n`;
							selection = { name: "book", branch: meta.branch, description: meta.description, parameters, prelude, schemaVersion: ref.version, schemaRef: ref };
							pending.set(conversationId, selection);
							activeSchemaResult = candidate;
						}
					}
				}
			}
			if (selection !== undefined && activeSchemaResult !== undefined) {
				const index = messages.indexOf(activeSchemaResult);
				const tail = messages.slice(index + 1);
				const lastAssistant = tail.findLast((message) => message.role === "assistant");
				const answeredWithoutOperation = lastAssistant?.stopReason === "stop" && !(lastAssistant.content ?? []).some((part) => part.type === "toolCall" && part.name === "book" && !isBookBranchRequest(part.arguments));
				const calls = (lastAssistant?.content ?? []).filter((part) => part.type === "toolCall" && part.name === "book" && !isBookBranchRequest(part.arguments));
				const callIds = new Set(calls.map((call) => call.id));
				const results = tail.filter((message) => message.role === "toolResult" && message.toolName === "book" && callIds.has(message.toolCallId));
				const finishedSuccessfully = calls.length > 0 && results.length === calls.length && results.every((message) => message.isError !== true);
				if (answeredWithoutOperation || finishedSuccessfully) {
					pending.delete(conversationId);
					selection = undefined;
					activeSchemaResult = undefined;
				}
			}
			const removeIds = new Set(branchResults.filter((message) => message !== activeSchemaResult).map((message) => message.toolCallId).filter(Boolean));
			let dressed = removeIds.size === 0 ? messages : messages.flatMap((message) => {
				if (message.role === "toolResult" && message.toolName === "book" && removeIds.has(message.toolCallId)) return [];
				if (message.role === "assistant" && Array.isArray(message.content)) {
					const content = message.content.filter((part) => !(part.type === "toolCall" && part.name === "book" && removeIds.has(part.id)));
					if (content.length === 0) return [];
					return [{ ...message, content }];
				}
				return [message];
			});
			if (selection !== undefined) {
				const schemaText = JSON.stringify(selection.parameters, null, 2);
				dressed = [...dressed, { role: "user", content: [{ type: "text", text: `${selection.prelude ?? `Cartographer schema context for book.${selection.branch}. Use this for the next book call.\n\n`}${schemaText}` }] }];
			}
			return dressed;
		},
	};
}
