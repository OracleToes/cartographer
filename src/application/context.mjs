// Typed actions over the durable context projections that sit outside a provider request.
//
// The top-of-context copy is deliberately refreshed only at explicit safe moments. This facade keeps that
// lifecycle operation behind the same UI result and capability boundary as the Workspace and Talk actions.
import { pin } from "../top.mjs";
import { createCapabilityRegistry } from "./capabilities.mjs";
import { UI_ACTION_INTENT, UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";
import { uiCancelled, uiError, uiErrorFrom, uiFailure, uiSuccess } from "./result.mjs";

export const CONTEXT_ACTION = Object.freeze({
	pinTop: "context.pin-top",
});

export const CONTEXT_CAPABILITY_DEFINITIONS = Object.freeze([
	{ id: CONTEXT_ACTION.pinTop, label: "Refresh context top", category: "runtime", intent: UI_ACTION_INTENT.mutate },
]);

export const CONTEXT_CAPABILITIES = createCapabilityRegistry(CONTEXT_CAPABILITY_DEFINITIONS);

const DEFAULT_OPERATIONS = Object.freeze({ pin });
const nonEmpty = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const metadata = (options, now) => ({
	...(typeof options?.requestId === "string" && options.requestId !== "" ? { requestId: options.requestId } : {}),
	at: new Date(now()).toISOString(),
});
const invalidInput = (message, meta, field) => uiFailure(uiError({
	code: UI_ERROR_CODE.invalidInput,
	kind: UI_ERROR_KIND.validation,
	message,
	field,
	retryable: false,
}), { meta });

const pinTopInput = (input, meta) => {
	if (!isRecord(input)) return { result: invalidInput("Refreshing the context top needs an input object.", meta) };
	const reason = nonEmpty(input.reason);
	if (reason === undefined) return { result: invalidInput("Say why the context top is being refreshed.", meta, "reason") };
	return { value: { reason } };
};

/**
 * @param {{
 *   brainDir: string,
 *   operations?: typeof DEFAULT_OPERATIONS,
 *   now?: () => number,
 * }} options
 */
export function createContextApplication({ brainDir, operations = DEFAULT_OPERATIONS, now = () => Date.now() }) {
	if (nonEmpty(brainDir) === undefined) throw new TypeError("A context application needs a brain directory.");

	const execute = async (action, input = {}, options = {}) => {
		const meta = metadata(options, now);
		if (options.signal?.aborted === true) return uiCancelled({ meta });
		const capability = CONTEXT_CAPABILITIES.get(action);
		if (capability === undefined) return uiFailure(uiError({
			code: UI_ERROR_CODE.unknownAction,
			kind: UI_ERROR_KIND.validation,
			message: "That context action is not registered.",
			retryable: false,
		}), { meta });
		const availability = CONTEXT_CAPABILITIES.availability(action, { brainDir });
		if (availability?.enabled !== true) return uiFailure(uiError({
			code: UI_ERROR_CODE.policyBlocked,
			kind: UI_ERROR_KIND.policy,
			message: availability?.reason ?? "This action is unavailable right now.",
			retryable: false,
		}), { meta });
		const checked = action === CONTEXT_ACTION.pinTop ? pinTopInput(input, meta) : undefined;
		if (checked?.result !== undefined) return checked.result;
		try {
			const result = operations.pin(brainDir, { reason: checked.value.reason, now: now() });
			if (result.error !== undefined) return uiFailure(uiError({
				code: UI_ERROR_CODE.actionRefused,
				kind: UI_ERROR_KIND.unavailable,
				message: `The graph cannot be read, so the copy stays as it is: ${result.error}`,
				retryable: true,
			}), { meta });
			const line = result.changed
				? "The top of the context was refreshed from the current assessment and graph."
				: "The copy at the top of the context is already current.";
			return uiSuccess({ action, target: "top", changed: result.changed, line }, {
				meta,
				notices: [{ level: result.changed ? "success" : "info", message: line }],
			});
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not refresh the context top.",
				retryable: false,
			}), { meta });
		}
	};

	return Object.freeze({ capabilities: CONTEXT_CAPABILITIES, execute });
}
