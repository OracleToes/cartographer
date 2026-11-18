// Typed decisions over the request queue. The queue itself remains a projection of the ledger and plan; this facade
// owns only the user decisions that mutate those durable books, so screen and terminal do not infer outcomes from
// their display lines.
import { answerQuestion, approveRequests, denyRequest } from "../requests.mjs";
import { createCapabilityRegistry } from "./capabilities.mjs";
import { UI_ACTION_INTENT, UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";
import { uiCancelled, uiError, uiErrorFrom, uiFailure, uiSuccess } from "./result.mjs";

export const REQUEST_ACTION = Object.freeze({
	approve: "request.approve",
	deny: "request.deny",
	answer: "request.answer",
});

export const REQUEST_CAPABILITY_DEFINITIONS = Object.freeze([
	{ id: REQUEST_ACTION.approve, label: "Approve request", category: "requests", intent: UI_ACTION_INTENT.mutate },
	{ id: REQUEST_ACTION.deny, label: "Deny request", category: "requests", intent: UI_ACTION_INTENT.mutate },
	{ id: REQUEST_ACTION.answer, label: "Answer request", category: "requests", intent: UI_ACTION_INTENT.mutate },
]);

export const REQUEST_CAPABILITIES = createCapabilityRegistry(REQUEST_CAPABILITY_DEFINITIONS);

const DEFAULT_OPERATIONS = Object.freeze({ answerQuestion, approveRequests, denyRequest });
const nonEmpty = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const metadata = (options, now) => ({
	...(typeof options?.requestId === "string" && options.requestId !== "" ? { requestId: options.requestId } : {}),
	at: new Date(now()).toISOString(),
});
const invalid = (message, field, meta) => uiFailure(uiError({
	code: UI_ERROR_CODE.invalidInput,
	kind: UI_ERROR_KIND.validation,
	message,
	field,
	retryable: false,
}), { meta });
const missing = (message, meta) => uiFailure(uiError({
	code: UI_ERROR_CODE.notFound,
	kind: UI_ERROR_KIND.notFound,
	message,
	retryable: false,
}), { meta });

const checked = (action, input, meta) => {
	if (!isRecord(input)) return { result: invalid("This action needs an input object.", undefined, meta) };
	if (action === REQUEST_ACTION.approve) {
		if (input.ids !== undefined && (!Array.isArray(input.ids) || input.ids.some((id) => nonEmpty(id) === undefined))) return { result: invalid("Request approvals need a list of request IDs.", "ids", meta) };
		return { value: { ids: (input.ids ?? []).map((id) => id.trim()) } };
	}
	const id = nonEmpty(input.id);
	if (id === undefined) return { result: invalid("Choose a request before deciding it.", "id", meta) };
	if (action === REQUEST_ACTION.deny) {
		if (input.reason !== undefined && typeof input.reason !== "string") return { result: invalid("A denial reason must be text.", "reason", meta) };
		return { value: { id, reason: typeof input.reason === "string" ? input.reason.trim() : "" } };
	}
	if (action === REQUEST_ACTION.answer) {
		const answer = nonEmpty(input.text);
		if (answer === undefined) return { result: invalid("An answer cannot be empty.", "text", meta) };
		return { value: { id, text: answer } };
	}
	return { result: uiFailure(uiError({
		code: UI_ERROR_CODE.unknownAction,
		kind: UI_ERROR_KIND.validation,
		message: "That request action is not registered.",
		retryable: false,
	}), { meta }) };
};

/** @param {{ brainDir: string, operations?: typeof DEFAULT_OPERATIONS, now?: () => number }} options */
export function createRequestApplication({ brainDir, operations = DEFAULT_OPERATIONS, now = () => Date.now() }) {
	if (nonEmpty(brainDir) === undefined) throw new TypeError("A request application needs a brain directory.");

	const execute = async (action, input = {}, options = {}) => {
		const meta = metadata(options, now);
		if (options.signal?.aborted === true) return uiCancelled({ meta });
		const capability = REQUEST_CAPABILITIES.get(action);
		if (capability === undefined) return uiFailure(uiError({
			code: UI_ERROR_CODE.unknownAction,
			kind: UI_ERROR_KIND.validation,
			message: "That request action is not registered.",
			retryable: false,
		}), { meta });
		const availability = REQUEST_CAPABILITIES.availability(action, { brainDir });
		if (availability?.enabled !== true) return uiFailure(uiError({
			code: UI_ERROR_CODE.policyBlocked,
			kind: UI_ERROR_KIND.policy,
			message: availability?.reason ?? "This action is unavailable right now.",
			retryable: false,
		}), { meta });
		const inputResult = checked(action, input, meta);
		if (inputResult.result !== undefined) return inputResult.result;
		try {
			if (action === REQUEST_ACTION.approve) {
				const result = operations.approveRequests(brainDir, inputResult.value.ids, new Date(now()).toISOString());
				const line = result.items.length === 0 ? "No current request was approved." : `Approved ${result.items.join(", ")}.`;
				return uiSuccess({ action, approved: result.items, unknown: result.unknown, line }, {
					meta,
					notices: [{ level: result.items.length === 0 ? "info" : "success", message: line }],
				});
			}
			if (action === REQUEST_ACTION.deny) {
				const result = operations.denyRequest(brainDir, inputResult.value.id, inputResult.value.reason, now());
				if (result === undefined) return missing("This request no longer waits for a decision.", meta);
				const line = `${inputResult.value.id} was turned down${inputResult.value.reason === "" ? "" : `: ${inputResult.value.reason}`}.`;
				return uiSuccess({ action, target: inputResult.value.id, request: result, line }, {
					meta,
					notices: [{ level: "success", message: line }],
				});
			}
			const result = operations.answerQuestion(brainDir, inputResult.value.id, inputResult.value.text, now());
			if (result === undefined) return missing("This question is no longer open.", meta);
			const line = `${inputResult.value.id} was answered.`;
			return uiSuccess({ action, target: inputResult.value.id, request: result, line }, {
				meta,
				notices: [{ level: "success", message: line }],
			});
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not complete that request decision.",
				retryable: false,
			}), { meta });
		}
	};

	return Object.freeze({ capabilities: REQUEST_CAPABILITIES, execute });
}
