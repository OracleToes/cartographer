import { createHash } from "node:crypto";
import { defineTool } from "@earendil-works/pi-durable";
import { POLICY } from "./config.mjs";
import { nativeReference, readReferenceVersion, retainReferenceVersion } from "./catalog.mjs";
import { BOOK_BRANCH_ACTIONS, bookBranchParameters, bookBranchVariants } from "./tools/book.mjs";
import { oneOf, obj, opt } from "@earendil-works/pi-schema";

export const SCHEMA_SELECTOR = "tool_schema";
const BOOK_BRANCHES = Object.keys(BOOK_BRANCH_ACTIONS);
const BOOK_ACTIONS = [...new Set(Object.values(BOOK_BRANCH_ACTIONS).flat())];
const VARIANTS = [...new Set([
	...BOOK_ACTIONS,
	...Object.values(POLICY.enums.atlasActions),
	...POLICY.enums.shellActions,
	"set-time", "set-path", "set-window", "text", "network", "standing", "open", "choices", "ref", "path", "file-ref", "report-ref", "schema-ref",
	...POLICY.enums.planModes,
	...POLICY.enums.ledgerKinds,
])];
const FIELD_CHOICES = ["links", "files", "both"];
const STRICT_KEYWORDS = new Set([
	"type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf",
	"description", "title", "default", "minLength", "maxLength", "pattern", "minimum", "maximum",
	"exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "uniqueItems", "format",
]);

const allowsNull = (schema) => schema?.type === "null" || (Array.isArray(schema?.type) && schema.type.includes("null")) || schema?.const === null || schema?.enum?.includes?.(null) || schema?.anyOf?.some(allowsNull);

/** Convert optional object properties to the OpenAI strict-required/nullable form, refusing unsupported schemas. */
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
			if (value.some((child) => child?.type === "object" || child?.type === "array" || child?.properties !== undefined || child?.items !== undefined)) {
				throw new Error(`Strict schema at ${location}.anyOf has an object/array union unsupported by strict sampling.`);
			}
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
			else if (child.type === "object" || child.properties !== undefined) throw new Error(`Optional object property ${location}.${name} must be selected as a required schema branch.`);
			else properties[name] = { anyOf: [child, { type: "null" }] };
		}
		schema.required = Object.keys(properties);
		schema.additionalProperties = false;
	}
	return schema;
}

function objectBranch(source, { allow, required, constants = {} }) {
	const schema = structuredClone(source);
	if (schema?.type !== "object" || !schema.properties) throw new Error("The selected operation has no object schema to specialize.");
	for (const condition of schema.allOf ?? []) {
		const keys = Object.keys(condition?.if?.properties ?? {});
		if (keys.some((key) => !["action", "match"].includes(key))) throw new Error("The selected action schema has an unrelated conditional that cannot be safely specialized.");
	}
	delete schema.allOf;
	for (const key of Object.keys(schema.properties)) if (!allow.includes(key)) delete schema.properties[key];
	for (const [key, value] of Object.entries(constants)) {
		const description = schema.properties[key]?.description;
		schema.properties[key] = { type: "string", const: value, ...(description ? { description } : {}) };
	}
	schema.required = [...new Set(required)];
	schema.additionalProperties = false;
	return schema;
}

function actionBranch(schema, action) {
	return (schema?.anyOf ?? []).find((branch) => branch.properties?.action?.const === action);
}

function atlasBranchSchema(source, action, field) {
	const op = source?.properties?.ops?.items;
	const branch = actionBranch(op, action);
	if (branch === undefined) throw new Error(`Atlas has no operation schema for ${action}.`);
	const item = structuredClone(branch);
	if ([POLICY.enums.atlasActions.link, POLICY.enums.atlasActions.unlink].includes(action)) {
		if (!["links", "files", "both"].includes(field)) throw new Error(`Atlas ${action} needs a links, files, or both field choice.`);
		if (field !== "both") delete item.properties[field === "links" ? "files" : "links"];
		delete item.anyOf;
		item.required = [...new Set([...(item.required ?? []), ...(field === "both" ? ["links", "files"] : [field])])];
	} else if ([POLICY.enums.atlasActions.add, POLICY.enums.atlasActions.edit].includes(action)) {
		// Empty arrays are equivalent to omission for these merge-style operations, avoiding a nullable array union.
		item.required = [...new Set([...(item.required ?? []), "links", "files"] )];
	}
	const shaped = structuredClone(source);
	shaped.properties.ops.items = item;
	shaped.properties.ops.minItems = 1;
	shaped.required = ["ops"];
	shaped.additionalProperties = false;
	return shaped;
}

function askBranchSchema(source, variant) {
	if (!["open", "choices"].includes(variant)) throw new Error("ask needs an open or choices branch selection.");
	const schema = structuredClone(source);
	if (variant === "choices") schema.required = [...new Set([...(schema.required ?? []), "choices"])];
	else delete schema.properties.choices;
	schema.additionalProperties = false;
	return schema;
}

function shellBranchSchema(source, action) {
	const root = source.properties;
	const actionValues = root.action?.enum ?? [];
	if (!actionValues.includes(action)) throw new Error(`Shell has no action ${action}.`);
	const schema = objectBranch(source, {
		allow: action === "run" ? ["action", "command", "window", "wait"]
			: action === "read" ? ["action", "window", "lines"]
				: action === "wait" ? ["action", "window", "seconds", "until"]
					: action === "send" ? ["action", "window", "text", "seconds"] : ["action", "window"],
		required: action === "run" ? ["action", "command"]
			: action === "read" || action === "wait" || action === "stop" || action === "close" ? ["action", "window"]
				: ["action", "window", "text"],
		constants: { action },
	});
	return schema;
}

function wakeBranchSchema(source, variant) {
	const set = POLICY.enums.actions.set;
	const remove = POLICY.enums.actions.remove;
	if (variant === "remove") return objectBranch(source, { allow: ["action", "id"], required: ["action", "id"], constants: { action: remove } });
	if (!["set-time", "set-path", "set-window"].includes(variant)) throw new Error(`Wake has no branch ${variant}.`);
	const allow = variant === "set-time" ? ["action", "note", "every", "times"]
		: variant === "set-path" ? ["action", "note", "path", "every", "times"]
			: ["action", "note", "window", "every", "times", "match"];
	const required = variant === "set-time" ? ["action", "note", "every"]
		: variant === "set-path" ? ["action", "note", "path"]
			: ["action", "note", "window"];
	return objectBranch(source, { allow, required, constants: { action: set } });
}

function selectedSchema(tool, source, choice, bookShape) {
	if (tool === "book") return bookShape(source, choice.branch, choice.action, choice.variant);
	if (tool === "atlas") return atlasBranchSchema(source, choice.variant, choice.field);
	if (tool === "shell") return shellBranchSchema(source, choice.variant);
	if (tool === "wake") return wakeBranchSchema(source, choice.variant);
	if (tool === "ask") return askBranchSchema(source, choice.variant);
	return structuredClone(source);
}

function nullableSchema(schema) {
	return schema?.anyOf?.some((branch) => branch.type === "null") || schema?.type === "null" || (Array.isArray(schema?.type) && schema.type.includes("null")) || schema?.enum?.includes?.(null) || schema?.const === null;
}

/** Remove strict-mode null sentinels only where the implementation's original schema marks that field optional. */
function cleanNullableArgs(value, schema) {
	if (Array.isArray(value)) return value.map((item) => cleanNullableArgs(item, schema?.items));
	if (value === null || typeof value !== "object") return value;
	const branches = schema?.anyOf ?? schema?.oneOf;
	if (Array.isArray(branches)) {
		const matching = branches.find((branch) => Object.entries(branch.properties ?? {}).every(([key, part]) => part.const === undefined || value[key] === part.const));
		if (matching) schema = matching;
	}
	if (schema?.type !== "object" && !schema?.properties) return value;
	const required = new Set(schema.required ?? []);
	const clean = {};
	for (const [key, item] of Object.entries(value)) {
		const child = schema.properties?.[key] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined);
		if (item === null && (nullableSchema(child) || !required.has(key))) continue;
		clean[key] = cleanNullableArgs(item, child);
	}
	return clean;
}

function matchesSchema(value, schema) {
	if (value === null) return allowsNull(schema);
	if (schema?.const !== undefined && value !== schema.const) return false;
	if (Array.isArray(schema?.enum) && !schema.enum.includes(value)) return false;
	if (Array.isArray(schema?.anyOf) && !schema.anyOf.some((branch) => matchesSchema(value, branch))) return false;
	if (Array.isArray(schema?.type) && !schema.type.some((type) => matchesSchema(value, { ...schema, type }))) return false;
	if (schema?.type === "object" || schema?.properties !== undefined) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
		if ((schema.required ?? []).some((key) => !Object.hasOwn(value, key))) return false;
		if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties ?? {}, key))) return false;
		return Object.entries(schema.properties ?? {}).every(([key, child]) => !Object.hasOwn(value, key) || matchesSchema(value[key], child));
	}
	if (schema?.type === "array") return Array.isArray(value) && value.every((item) => matchesSchema(item, schema.items));
	if (schema?.type === "string") return typeof value === "string";
	if (schema?.type === "integer") return Number.isInteger(value);
	if (schema?.type === "number") return typeof value === "number" && Number.isFinite(value);
	if (schema?.type === "boolean") return typeof value === "boolean";
	if (Array.isArray(schema?.required)) return value !== null && typeof value === "object" && schema.required.every((key) => Object.hasOwn(value, key));
	return true;
}

function providerTool(payload, name) {
	if (!Array.isArray(payload?.tools)) throw new Error("The selected provider request has no tools array; strict tool routing is unavailable.");
	const tool = payload.tools.find((entry) => entry?.type === "function" && entry.function?.name === name);
	if (!tool) throw new Error(`Provider request did not contain the selected tool ${name}; refusing to send an unconstrained request.`);
	return tool;
}

/**
 * Two-phase tool schema lifecycle. The provider sees only a compact selector until it chooses an operation;
 * the next request contains only that operation with a strict schema. Invalid calls retain the selection for retry.
 */
export function createToolSchemaLifecycle(tools, { schemaBudgetTokens = 4096, brainDir, bookShape = bookBranchParameters } = {}) {
	const operations = tools.filter((tool) => tool.name !== SCHEMA_SELECTOR && (tool.callers === undefined || tool.callers.includes("model")));
	const byName = new Map(operations.map((tool) => [tool.name, tool]));
	const pending = new Map();
	const toolNames = operations.map((tool) => tool.name);
	const selector = defineTool({
		name: SCHEMA_SELECTOR,
		description: "Choose the operation to perform next. This only loads that operation's exact argument schema; it does not perform the operation. Then call the selected tool with arguments matching its schema.",
		parameters: obj({
			tool: oneOf(toolNames, { description: "The exact tool to use next." }),
			branch: opt(oneOf(BOOK_BRANCHES, { description: "For book, the selected target branch; otherwise omit." })),
			action: opt(oneOf(BOOK_ACTIONS, { description: "For book, the operation within the selected target branch; otherwise omit." })),
			variant: opt(oneOf(VARIANTS, { description: "For a conditional tool, select the exact operation branch; for book operation payloads, select a ledger kind, plan mode, or locator when requested." })),
			field: opt(oneOf(FIELD_CHOICES, { description: "For atlas link/unlink, choose node links, project files, or both." })),
		}),
		constrainedSampling: { type: "json_schema", strict: "require" },
		executionMode: "sequential",
		replay: POLICY.enums.toolReplay.safe,
		execute: async (args, api) => {
			const selected = byName.get(args.tool);
			if (!selected) return { isError: true, output: [{ type: "text", text: `Unknown operation ${JSON.stringify(args.tool)}; choose one of the listed tools.` }] };
			const choice = { branch: args.branch, action: args.action, variant: args.variant, field: args.field };
			if (args.tool === "book" && (choice.branch === undefined || choice.action === undefined)) return { isError: true, output: [{ type: "text", text: "Choose both the book target branch (for example atlas, ledger, or plan) and its action before loading its schema." }] };
			if (args.tool !== "book" && (choice.branch !== undefined || choice.action !== undefined)) return { isError: true, output: [{ type: "text", text: "Only book schema selections use branch and action; omit both for other tools." }] };
			if (args.tool === "book") {
				if (choice.field !== undefined) return { isError: true, output: [{ type: "text", text: "The field choice is only used for atlas link/unlink; omit it for book." }] };
				const choices = bookBranchVariants(choice.branch, choice.action);
				if (choices.length > 0 && !choices.includes(choice.variant)) return { isError: true, output: [{ type: "text", text: `Book ${choice.branch}.${choice.action} needs variant ${choices.join(" or ")}; select one before loading its schema.` }] };
				if (choices.length === 0 && choice.variant !== undefined) return { isError: true, output: [{ type: "text", text: `Book ${choice.branch}.${choice.action} has no variant; omit it.` }] };
			}
			if (choice.field !== undefined && !(args.tool === "atlas" && [POLICY.enums.atlasActions.link, POLICY.enums.atlasActions.unlink].includes(choice.variant))) return { isError: true, output: [{ type: "text", text: "The field choice is only used for atlas link/unlink; omit it otherwise." }] };
			if (args.tool === "atlas" && [POLICY.enums.atlasActions.link, POLICY.enums.atlasActions.unlink].includes(choice.variant) && choice.field === undefined) return { isError: true, output: [{ type: "text", text: `Atlas ${choice.variant} needs a field choice: links, files, or both.` }] };
			if (args.tool === "atlas" && ![POLICY.enums.atlasActions.link, POLICY.enums.atlasActions.unlink].includes(choice.variant) && choice.field !== undefined) return { isError: true, output: [{ type: "text", text: "Only atlas link/unlink uses a field choice." }] };
			if (["atlas", "shell", "wake", "ask"].includes(args.tool) && choice.variant === undefined) return { isError: true, output: [{ type: "text", text: `${args.tool} needs an exact operation branch before its schema can be loaded.` }] };
			if (!["book", "atlas", "shell", "wake", "ask"].includes(args.tool) && choice.variant !== undefined) return { isError: true, output: [{ type: "text", text: `${args.tool} has no operation variant; omit it.` }] };
			let parameters;
			try {
				parameters = strictSchema(selectedSchema(args.tool, selected.parameters, choice, bookShape));
			} catch (error) {
				return { isError: true, output: [{ type: "text", text: `Cannot load a strict schema for ${args.tool}${choice.branch === undefined ? "" : `.${choice.branch}.${choice.action}`}${choice.variant === undefined ? "" : `.${choice.variant}`}: ${error.message} No operation was enabled.` }] };
			}
			const schemaText = JSON.stringify(parameters);
			const schemaVersion = createHash("sha256").update(schemaText).digest("hex");
			const schemaId = args.tool === "book" ? `cartographer:book:${choice.branch}:${choice.action}${choice.variant ? `:${choice.variant}` : ""}` : `cartographer:${selected.name}${choice.variant ? `:${choice.variant}` : ""}${choice.field ? `:${choice.field}` : ""}`;
			const schemaRef = brainDir === undefined ? undefined : nativeReference(brainDir, "schema", schemaId, schemaVersion);
			const referenceText = schemaRef === undefined ? "" : `Schema reference: ${JSON.stringify(schemaRef)}\n`;
			const label = choice.branch === undefined ? `${selected.name}${choice.variant ? `.${choice.variant}` : ""}${choice.field ? `.${choice.field}` : ""}` : `book.${choice.branch}.${choice.action}${choice.variant ? `.${choice.variant}` : ""}`;
			const prelude = `${referenceText}Loaded the full schema for ${label}. Make the operation call now.\n\n`;
			const estimatedTokens = Math.ceil((schemaText.length + prelude.length + 32) / POLICY.estimation.charsPerToken);
			if (estimatedTokens > schemaBudgetTokens) return { isError: true, output: [{ type: "text", text: `The ${selected.name} schema is about ${estimatedTokens} tokens, above the ${schemaBudgetTokens}-token schema budget; no operation was enabled.` }] };
			if (brainDir !== undefined) retainReferenceVersion(brainDir, schemaRef, parameters);
			const selection = { name: selected.name, ...choice, parameters, description: selected.description, schemaVersion, schemaRef };
			pending.set(api.conversationId, selection);
			return {
				output: [{ type: "text", text: `${prelude.replace(". Make the operation call now.", ` (about ${estimatedTokens} tokens). Make the operation call now.`)}${schemaText}` }],
				details: {
					schemaRef: { ...(schemaRef ?? {}), estimatedTokens },
					schemaSelection: { tool: selected.name, branch: choice.branch, action: choice.action, variant: choice.variant, field: choice.field, description: selected.description },
				},
			};
		},
	});

	return {
		selector,
		pending,
		normalizeTool: (tool) => {
			const originalPrepare = tool.prepareArguments;
			return {
				...tool,
				prepareArguments: (args) => {
					const selected = [...pending.values()].find((entry) => entry.name === tool.name && matchesSchema(args, entry.parameters));
					const cleaned = cleanNullableArgs(args, selected?.parameters ?? tool.parameters);
					return originalPrepare ? originalPrepare(cleaned) : cleaned;
				},
			};
		},

		/** Replace the provider's wire tool set before sending. No missing strict support is silently downgraded. */
		beforeProviderRequest: ({ payload, model }, api) => {
			if (model.api !== "openai-completions") throw new Error(`Strict on-demand schemas require the OpenAI-compatible adapter; ${model.api} cannot be verified.`);
			const selection = pending.get(api.conversationId);
			if (selection === undefined) {
				const compact = providerTool(payload, SCHEMA_SELECTOR);
				const parameters = strictSchema(structuredClone(compact.function.parameters));
				return { payload: { ...payload, tools: [{ ...compact, function: { ...compact.function, parameters, strict: true } }] } };
			}
			const declared = providerTool(payload, selection.name);
			const schema = strictSchema(structuredClone(selection.parameters));
			return {
				payload: {
					...payload,
					tools: [{ ...declared, function: { ...declared.function, description: selection.description, parameters: schema, strict: true } }],
				},
			};
		},
		beforeTool: (call, api) => {
			if (call.parent !== undefined || call.name === SCHEMA_SELECTOR) return undefined;
			const selection = pending.get(api.conversationId);
			if (selection === undefined || selection.name !== call.name) return { block: `Tool call refused: ${call.name} has no matching on-demand schema selection. Choose its schema first.` };
			if (!matchesSchema(call.arguments, selection.parameters)) return { block: `Tool call refused: arguments do not match the selected strict ${selection.name} schema. The operation was not run; retry with the required fields and exact selected branch.` };
			const args = cleanNullableArgs(call.arguments, selection.parameters);
			if (selection.name === "book" && (args?.target !== selection.branch || args?.action !== selection.action)) return { block: `Tool call refused: the selected book operation is ${selection.branch}.${selection.action}; target and action must match it.` };
			if (selection.name === "atlas" && !args?.ops?.every((op) => op.action === selection.variant && (selection.field === undefined || (selection.field === "both" ? Object.hasOwn(op, "links") && Object.hasOwn(op, "files") : Object.hasOwn(op, selection.field) && !Object.hasOwn(op, selection.field === "links" ? "files" : "links"))))) return { block: `Tool call refused: the selected atlas action is ${selection.variant}${selection.field ? ` with ${selection.field}` : ""}.` };
			if (selection.name === "ask" && (selection.variant === "choices" ? !Array.isArray(args?.choices) : args?.choices !== undefined)) return { block: `Tool call refused: the selected ask branch is ${selection.variant}.` };
			if (selection.name === "shell" && args?.action !== selection.variant) return { block: `Tool call refused: the selected shell action is ${selection.variant}.` };
			if (selection.name === "wake" && (selection.variant === "remove" ? args?.action !== POLICY.enums.actions.remove : args?.action !== POLICY.enums.actions.set)) return { block: `Tool call refused: the selected wake branch is ${selection.variant}.` };
			return { arguments: args };
		},
		afterResponse: (message, api) => {
			const selection = pending.get(api.conversationId);
			if (selection === undefined) return;
			const count = (message.content ?? []).filter((part) => part.type === "toolCall" && part.name === selection.name).length;
			if (count > 0) {
				selection.remaining = count;
				selection.failed = false;
			} else pending.delete(api.conversationId);
		},
		afterTool: (call, result, api) => {
			if (call.parent !== undefined || call.name === SCHEMA_SELECTOR) return;
			const selection = pending.get(api.conversationId);
			if (selection?.name !== call.name) return;
			if (result?.isError) selection.failed = true;
			if (Number.isInteger(selection.remaining)) selection.remaining--;
			const done = selection.remaining === undefined || selection.remaining <= 0;
			if (done && !selection.failed) pending.delete(api.conversationId);
			const details = result?.details !== null && typeof result?.details === "object" && !Array.isArray(result.details) ? result.details : {};
			return { ...result, details: { ...details, schemaRef: selection.schemaRef ?? { tool: selection.name, branch: selection.branch, action: selection.action, version: selection.schemaVersion } } };
		},
		forRequest: (messages, conversationId) => {
			let selection = pending.get(conversationId);
			const selectorResults = messages.filter((message) => message.role === "toolResult" && message.toolName === SCHEMA_SELECTOR);
			let activeSchemaResult = selection === undefined ? undefined : selectorResults.findLast((message) => message.details?.schemaRef?.version === selection.schemaVersion);
			if (selection === undefined) {
				const latestSelectorResult = selectorResults.at(-1);
				if (latestSelectorResult?.isError === true) {
					const at = messages.indexOf(latestSelectorResult);
					if (!messages.slice(at + 1).some((message) => message.role === "assistant")) activeSchemaResult = latestSelectorResult;
				}
			}
			if (selection === undefined && brainDir !== undefined) {
				const candidate = selectorResults.at(-1);
				if (candidate?.details?.schemaRef?.version && candidate.details.schemaSelection) {
					const ref = candidate.details.schemaRef;
					const index = messages.indexOf(candidate);
					const meta = candidate.details.schemaSelection;
					const tail = messages.slice(index + 1);
					const lastOperationResult = tail.findLast((message) => message.role === "toolResult" && message.toolName === meta.tool && message.details?.schemaRef?.version === ref.version);
					const lastAssistant = tail.findLast((message) => message.role === "assistant");
					const answeredWithoutOperation = lastAssistant?.stopReason === "stop" && !(lastAssistant.content ?? []).some((part) => part.type === "toolCall" && part.name === meta.tool);
					const calls = (lastAssistant?.content ?? []).filter((part) => part.type === "toolCall" && part.name === meta.tool);
					const callIds = new Set(calls.map((call) => call.id));
					const results = tail.filter((message) => message.role === "toolResult" && message.toolName === meta.tool && callIds.has(message.toolCallId));
					const pendingCall = calls.length > 0 && (results.length < calls.length || results.some((message) => message.isError === true));
					if (!answeredWithoutOperation && (pendingCall || (calls.length === 0 && (lastOperationResult === undefined || lastOperationResult.isError === true)))) {
						const parameters = readReferenceVersion(brainDir, ref);
						if (parameters !== undefined) {
							selection = { name: meta.tool, branch: meta.branch, action: meta.action, variant: meta.variant, field: meta.field, description: meta.description, parameters, schemaVersion: ref.version, schemaRef: ref };
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
				const answeredWithoutOperation = lastAssistant?.stopReason === "stop" && !(lastAssistant.content ?? []).some((part) => part.type === "toolCall" && part.name === selection.name);
				const calls = (lastAssistant?.content ?? []).filter((part) => part.type === "toolCall" && part.name === selection.name);
				const callIds = new Set(calls.map((call) => call.id));
				const results = tail.filter((message) => message.role === "toolResult" && message.toolName === selection.name && callIds.has(message.toolCallId));
				const finishedSuccessfully = calls.length > 0 && results.length === calls.length && results.every((message) => message.isError !== true);
				if (answeredWithoutOperation || finishedSuccessfully) {
					pending.delete(conversationId);
					selection = undefined;
					activeSchemaResult = undefined;
				}
			}
			const removeIds = new Set(selectorResults.filter((message) => message !== activeSchemaResult).map((message) => message.toolCallId).filter(Boolean));
			if (removeIds.size === 0) return messages;
			return messages.flatMap((message) => {
				if (message.role === "toolResult" && message.toolName === SCHEMA_SELECTOR && removeIds.has(message.toolCallId)) return [];
				if (message.role === "assistant" && Array.isArray(message.content)) {
					const content = message.content.filter((part) => !(part.type === "toolCall" && part.name === SCHEMA_SELECTOR && removeIds.has(part.id)));
					if (content.length === 0) return [];
					return [{ ...message, content }];
				}
				return [message];
			});
		},
	};
}
