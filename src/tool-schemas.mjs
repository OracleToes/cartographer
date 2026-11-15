import { createHash } from "node:crypto";
import { defineTool } from "@earendil-works/pi-durable";
import { POLICY } from "./config.mjs";
import { nativeReference, readReferenceVersion, retainReferenceVersion } from "./catalog.mjs";
import { BOOK_BRANCH_ACTIONS, bookTargetParameters } from "./tools/book.mjs";

const BOOK_BRANCHES = Object.keys(BOOK_BRANCH_ACTIONS);
const BOOK_ACTIONS = [...new Set(Object.values(BOOK_BRANCH_ACTIONS).flat())];
const BOOK_COMPACT_PARAMETERS = {
	type: "object",
	properties: {
		target: { type: "string", enum: BOOK_BRANCHES, description: "The book target for this operation." },
		action: { type: "string", enum: BOOK_ACTIONS, description: "The action to perform on that target." },
	},
	required: ["target"],
	additionalProperties: true,
};
const STRICT_KEYWORDS = new Set([
	"type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf",
	"description", "title", "default", "minLength", "maxLength", "pattern", "minimum", "maximum",
	"exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "uniqueItems", "format",
]);
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

function bookReplayContext(selection, originalCall) {
	const schema = JSON.stringify(selection.parameters, null, 2);
	return `Available parameters for the book tool (target: ${selection.branch}):\n${schema}\n\nCurrent requested book call: ${JSON.stringify(originalCall)}. Reissue this call using the schema above, preserving its intent and including all required arguments.`;
}

function providerTool(payload, name) {
	if (!Array.isArray(payload?.tools)) throw new Error("The provider request has no tools array; strict book schema routing is unavailable.");
	const tool = payload.tools.find((entry) => entry?.type === "function" && entry.function?.name === name);
	if (!tool) throw new Error(`Provider request did not contain the top-level ${name} tool; refusing to send an incomplete request.`);
	return tool;
}

/**
 * Keep all top-level tools visible. Intercept the hidden target-routing response before it is stored as a tool call,
 * then continue with the selected branch schema and original target intent in request context.
 */
export function createToolSchemaLifecycle(tools, { schemaBudgetTokens = 4096, brainDir } = {}) {
	const operations = tools.filter((tool) => tool.callers === undefined || tool.callers.includes("model"));
	const byName = new Map(operations.map((tool) => [tool.name, tool]));
	const book = byName.get("book");
	if (book === undefined) throw new Error("The top-level book tool is required for hierarchical schema routing.");
	const pending = new Map();
	const replays = new Map();
	const replayAttempts = new Map();

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
		const contextText = `Available parameters for the book tool (target: ${target}):\n${schemaText}`;
		const estimatedTokens = Math.ceil((contextText.length + 32) / POLICY.estimation.charsPerToken);
		if (estimatedTokens > schemaBudgetTokens) return { isError: true, output: [{ type: "text", text: `The book.${target} schema is about ${estimatedTokens} tokens, above the ${schemaBudgetTokens}-token schema budget; no operation was enabled.` }] };
		if (brainDir !== undefined) retainReferenceVersion(brainDir, schemaRef, parameters);
		pending.set(api.conversationId, { name: "book", branch: target, parameters, description: book.description, contextText, schemaVersion, schemaRef });
		return {
			output: [{ type: "text", text: "Routed." }],
			details: {
				schemaRef: { ...(schemaRef ?? {}), estimatedTokens },
				schemaSelection: { tool: "book", branch: target, phase: "branch-route", description: book.description },
			},
		};
	}

	async function interceptBookRouting(message, api) {
		const candidate = (message.content ?? []).find((part) => part.type === "toolCall" && part.name === "book"
			&& BOOK_BRANCHES.includes(part.arguments?.target));
		if (candidate === undefined) return false;
		const conversationId = api.conversationId;
		let selection = pending.get(conversationId);
		const mustRoute = selection === undefined || selection.branch !== candidate.arguments.target || isBookBranchRequest(candidate.arguments);
		if (!mustRoute) return false;
		const attempts = replayAttempts.get(conversationId) ?? 0;
		if (attempts >= 3) {
			pending.delete(conversationId);
			replays.delete(conversationId);
			replayAttempts.delete(conversationId);
			message.content = [{ type: "text", text: `I couldn't complete the book.${candidate.arguments.target} operation from its schema. Please clarify the action you want.` }];
			message.stopReason = "stop";
			return true;
		}
		if (selection?.branch !== candidate.arguments.target) {
			const result = await loadBookBranch({ target: candidate.arguments.target }, api);
			if (result.isError === true) {
				pending.delete(conversationId);
				replayAttempts.delete(conversationId);
				message.content = [{ type: "text", text: result.output?.map((part) => part.text ?? "").join("\n") || `Could not prepare the book.${candidate.arguments.target} operation.` }];
				message.stopReason = "stop";
				return true;
			}
			selection = pending.get(conversationId);
		}
		selection.originalCall = structuredClone(candidate.arguments);
		selection.contextText = bookReplayContext(selection, selection.originalCall);
		const route = {
			branch: selection.branch,
			originalCall: selection.originalCall,
			...(selection.schemaRef === undefined ? {} : { schemaRef: selection.schemaRef }),
			schemaVersion: selection.schemaVersion,
		};
		message.diagnostics = [...(message.diagnostics ?? []), { type: "cartographer_book_schema_replay", timestamp: Date.now(), details: route }];
		message.content = [];
		message.stopReason = "stop";
		replayAttempts.set(conversationId, attempts + 1);
		replays.set(conversationId, route);
		return true;
	}

	return {
		pending,
		hasReplay: (conversationId) => replays.has(conversationId),
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
				...(originalExecute ? { execute: async (args, api, ...rest) => {
					if (tool.name !== "book" || !isBookBranchRequest(args)) return originalExecute(args, api, ...rest);
					const active = pending.get(api.conversationId);
					if (active !== undefined) return { isError: true, output: [{ type: "text", text: `The book.${active.branch} schema is already active for this request.` }] };
					return loadBookBranch(args, api);
				} } : {}),
			};
		},
		/** Keep the provider tool list static and compact; branch detail lives only in conversation context. */
		beforeProviderRequest: ({ payload, model }) => {
			if (model.api !== "openai-completions") throw new Error(`Compact on-demand book routing requires the OpenAI-compatible adapter; ${model.api} cannot be verified.`);
			const declared = providerTool(payload, "book");
			const { strict: _strict, ...functionDefinition } = declared.function;
			const tools = payload.tools.map((entry) => entry === declared
				? { ...entry, function: { ...functionDefinition, description: book.description, parameters: structuredClone(BOOK_COMPACT_PARAMETERS) } }
				: entry);
			return { payload: { ...payload, tools } };
		},
		beforeTool: (call, api) => {
			if (call.parent !== undefined || call.name !== "book") return undefined;
			if (isBookBranchRequest(call.arguments)) return undefined;
			const selection = pending.get(api.conversationId);
			if (selection === undefined || selection.branch !== call.arguments?.target) return { block: `Tool call refused: the book.${call.arguments?.target ?? "?"} request could not be routed. The operation was not run; retry the request.` };
			if (!matchesSchema(call.arguments, selection.parameters, { requireAll: false })) return { block: `Tool call refused: arguments do not match the book.${selection.branch} schema. The operation was not run; retry with the required fields and a supported action.` };
			return { arguments: cleanNullableArgs(call.arguments, selection.parameters) };
		},
		afterResponse: async (message, api) => {
			if (await interceptBookRouting(message, api)) return;
			const calls = (message.content ?? []).filter((part) => part.type === "toolCall");
			const selection = pending.get(api.conversationId);
			if (selection === undefined) return;
			const count = calls.filter((part) => part.name === "book" && part.arguments?.target === selection.branch).length;
			if (count > 0) {
				selection.remaining = count;
				selection.failed = false;
			} else if (calls.length === 0) {
				pending.delete(api.conversationId);
				replayAttempts.delete(api.conversationId);
			}
		},
		afterTool: (call, result, api) => {
			if (call.parent !== undefined || call.name !== "book" || isBookBranchRequest(call.arguments)) return;
			const selection = pending.get(api.conversationId);
			if (selection === undefined || selection.branch !== call.arguments?.target) return;
			if (result?.isError) selection.failed = true;
			if (Number.isInteger(selection.remaining)) selection.remaining--;
			const done = selection.remaining === undefined || selection.remaining <= 0;
			if (done && !selection.failed) {
				pending.delete(api.conversationId);
				replayAttempts.delete(api.conversationId);
			}
			const details = result?.details !== null && typeof result?.details === "object" && !Array.isArray(result.details) ? result.details : {};
			return { ...result, details: { ...details, selectedSchemaRef: selection.schemaRef ?? { tool: "book", branch: selection.branch, version: selection.schemaVersion } } };
		},
		forRequest: (messages, conversationId) => {
			let selection = pending.get(conversationId);
			const routeMarkers = messages.flatMap((message, index) => message.role === "assistant"
				? (message.diagnostics ?? []).filter((entry) => entry.type === "cartographer_book_schema_replay").map((entry) => ({ message, index, route: entry.details }))
				: []);
			const probeIds = new Set(messages.flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
				? message.content.filter((part) => part.type === "toolCall" && part.name === "book" && isBookBranchRequest(part.arguments)).map((part) => part.id)
				: []));
			const routeResults = messages.filter((message) => message.role === "toolResult" && message.toolName === "book" && probeIds.has(message.toolCallId)
				&& (message.details?.schemaSelection?.phase === "branch-route" || message.details?.schemaSelection?.phase === "book-target")
				&& typeof message.details?.schemaRef?.version === "string");
			if (selection === undefined && brainDir !== undefined) {
				const marker = routeMarkers.at(-1);
				const result = routeResults.at(-1);
				const branch = marker?.route?.branch ?? result?.details?.schemaSelection?.branch;
				const ref = marker?.route?.schemaRef ?? result?.details?.schemaRef;
				const originalCall = marker?.route?.originalCall ?? { target: branch };
				const routeIndex = marker?.index ?? messages.indexOf(result);
				if (typeof branch === "string" && ref?.version && routeIndex >= 0) {
					const tail = messages.slice(routeIndex + 1);
					const calls = tail.flatMap((message) => message.role === "assistant" ? (message.content ?? []).filter((part) => part.type === "toolCall"
						&& part.name === "book" && !isBookBranchRequest(part.arguments) && part.arguments?.target === branch) : []);
					const callIds = new Set(calls.map((call) => call.id));
					const results = tail.filter((message) => message.role === "toolResult" && message.toolName === "book" && callIds.has(message.toolCallId));
					const lastAssistant = tail.findLast((message) => message.role === "assistant");
					const answeredWithoutOperation = lastAssistant?.stopReason === "stop" && calls.length === 0;
					const completed = calls.length > 0 && results.length === calls.length && results.every((message) => message.isError !== true);
					if (!answeredWithoutOperation && !completed) {
						const parameters = readReferenceVersion(brainDir, ref);
						if (parameters !== undefined) {
							selection = { name: "book", branch, description: book.description, parameters, originalCall, schemaVersion: ref.version, schemaRef: ref };
							selection.contextText = bookReplayContext(selection, originalCall);
							pending.set(conversationId, selection);
						}
					}
				}
			}
			const hiddenIds = new Set(routeResults.map((message) => message.toolCallId));
			const hiddenMarkerIndexes = new Set(routeMarkers.map((marker) => marker.index));
			const hiddenContinuationUsers = new Set();
			for (const marker of routeMarkers) {
				for (let index = marker.index + 1; index < messages.length; index++) {
					const message = messages[index];
					if (message.role !== "user") continue;
					const empty = message.content === "" || message.content === "\u2063" || (Array.isArray(message.content) && message.content.length === 0);
					if (empty) hiddenContinuationUsers.add(index);
					break;
				}
			}
			let dressed = messages.flatMap((message, index) => {
				if (hiddenMarkerIndexes.has(index) || hiddenContinuationUsers.has(index)) return [];
				if (message.role === "toolResult" && hiddenIds.has(message.toolCallId)) return [];
				if (message.role === "assistant" && Array.isArray(message.content)) {
					const content = message.content.filter((part) => !(part.type === "toolCall" && part.name === "book" && hiddenIds.has(part.id)));
					if (content.length === 0) return [];
					return [{ ...message, content }];
				}
				return [message];
			});
			if (selection !== undefined) dressed = [...dressed, { role: "user", content: [{ type: "text", text: selection.contextText ?? bookReplayContext(selection, selection.originalCall ?? { target: selection.branch }) }] }];
			replays.delete(conversationId);
			return dressed;
		},
	};
}
