// Typed actions over the mutable talk that a future context collapse may keep.
//
// The Durable transcript and active conversation are deliberately outside this narrow seam. These actions change
// only the separately stored kept-talk projection, preserving the isolation that lets someone correct or forget a
// future collapse source without rewriting a sent request.
import { removeTalkSource, reviseTalkSource, talkSourceKey } from "../context.mjs";
import { createCapabilityRegistry } from "./capabilities.mjs";
import { UI_ACTION_INTENT, UI_CONFIRMATION, UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";
import { uiCancelled, uiError, uiErrorFrom, uiFailure, uiSuccess } from "./result.mjs";

export const TALK_ACTION = Object.freeze({
	revise: "talk.revise-source",
	forget: "talk.forget-source",
});

export const TALK_CAPABILITY_DEFINITIONS = Object.freeze([
	{ id: TALK_ACTION.revise, label: "Revise kept talk", category: "chat", intent: UI_ACTION_INTENT.mutate },
	{ id: TALK_ACTION.forget, label: "Forget kept talk", category: "chat", intent: UI_ACTION_INTENT.destructive, confirmation: UI_CONFIRMATION.acknowledge },
]);

export const TALK_CAPABILITIES = createCapabilityRegistry(TALK_CAPABILITY_DEFINITIONS);

const DEFAULT_OPERATIONS = Object.freeze({ removeTalkSource, reviseTalkSource, talkSourceKey });
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

const sourceInput = (input, meta, sourceKeyOf = talkSourceKey) => {
	if (!isRecord(input)) return { result: invalidInput("This action needs an input object.", meta) };
	const sourceKey = sourceKeyOf(input.source);
	if (sourceKey === undefined) return { result: invalidInput("Choose a kept source before changing it.", meta, "source") };
	return { value: { source: input.source, sourceKey } };
};

const checkedInput = (action, input, meta, sourceKeyOf) => {
	const checked = sourceInput(input, meta, sourceKeyOf);
	if (checked.result !== undefined) return checked;
	if (action === TALK_ACTION.forget) return checked;
	if (action === TALK_ACTION.revise) {
		const text = nonEmpty(input.text);
		if (text === undefined) return { result: invalidInput("Kept talk cannot be empty.", meta, "text") };
		return { value: { ...checked.value, text } };
	}
	return { result: uiFailure(uiError({
		code: UI_ERROR_CODE.unknownAction,
		kind: UI_ERROR_KIND.validation,
		message: "That kept-talk action is not registered.",
		retryable: false,
	}), { meta }) };
};

const confirmationFor = (capability, sourceKey) => ({
	actionId: capability.id,
	target: sourceKey,
	summary: "Remove this source from a future kept talk collapse. The Durable transcript, active conversation, and sent requests stay unchanged.",
	strength: capability.confirmation,
});
const confirmed = (confirmation, request) => confirmation?.acknowledged === true && confirmation.actionId === request.actionId && confirmation.target === request.target;
const missingSource = (meta) => uiFailure(uiError({
	code: UI_ERROR_CODE.notFound,
	kind: UI_ERROR_KIND.notFound,
	message: "This source is no longer in the kept talk, so it is left unchanged.",
	retryable: false,
}), { meta });

/**
 * @param {{
 *   brainDir: string,
 *   operations?: typeof DEFAULT_OPERATIONS,
 *   now?: () => number,
 * }} options
 */
export function createTalkApplication({ brainDir, operations = DEFAULT_OPERATIONS, now = () => Date.now() }) {
	if (nonEmpty(brainDir) === undefined) throw new TypeError("A kept-talk application needs a brain directory.");

	const execute = async (action, input = {}, options = {}) => {
		const meta = metadata(options, now);
		if (options.signal?.aborted === true) return uiCancelled({ meta });
		const capability = TALK_CAPABILITIES.get(action);
		if (capability === undefined) return uiFailure(uiError({
			code: UI_ERROR_CODE.unknownAction,
			kind: UI_ERROR_KIND.validation,
			message: "That kept-talk action is not registered.",
			retryable: false,
		}), { meta });
		const availability = TALK_CAPABILITIES.availability(action, { brainDir });
		if (availability?.enabled !== true) return uiFailure(uiError({
			code: UI_ERROR_CODE.policyBlocked,
			kind: UI_ERROR_KIND.policy,
			message: availability?.reason ?? "This action is unavailable right now.",
			retryable: false,
		}), { meta });
		const checked = checkedInput(action, input, meta, operations.talkSourceKey);
		if (checked.result !== undefined) return checked.result;
		if (capability.confirmation !== UI_CONFIRMATION.none) {
			const request = confirmationFor(capability, checked.value.sourceKey);
			if (!confirmed(options.confirmation, request)) return uiFailure(uiError({
				code: UI_ERROR_CODE.confirmationRequired,
				kind: UI_ERROR_KIND.policy,
				message: request.summary,
				retryable: false,
			}), { meta, confirmation: request });
		}
		try {
			const changed = action === TALK_ACTION.revise
				? operations.reviseTalkSource(brainDir, checked.value.source, checked.value.text)
				: operations.removeTalkSource(brainDir, checked.value.source);
			if (!changed) return missingSource(meta);
			const line = action === TALK_ACTION.revise
				? "The kept source is edited for a future collapse; active context and sent requests stay unchanged."
				: "Removed from future kept talk; the Durable transcript, active conversation, and sent requests stay unchanged.";
			return uiSuccess({ action, target: checked.value.sourceKey, line }, {
				meta,
				notices: [{ level: "success", message: line }],
			});
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not complete that kept-talk action.",
				retryable: false,
			}), { meta });
		}
	};

	return Object.freeze({ capabilities: TALK_CAPABILITIES, execute });
}
