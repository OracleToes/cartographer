// The stable vocabulary at Cartographer's application boundary.
//
// Domain modules are allowed to keep their precise internal errors. UI-facing services turn those into these
// small, safe values, so the full screen and the plain terminal do not need to infer state from display text.

export const UI_ERROR_KIND = Object.freeze({
	validation: "validation",
	notFound: "not-found",
	conflict: "conflict",
	unavailable: "unavailable",
	policy: "policy",
	transport: "transport",
	nativeGrammar: "native-grammar",
	cancelled: "cancelled",
	timeout: "timeout",
	internal: "internal",
});

export const UI_ERROR_CODE = Object.freeze({
	unknownAction: "UNKNOWN_ACTION",
	invalidInput: "INVALID_INPUT",
	notFound: "NOT_FOUND",
	conflict: "CONFLICT",
	actionRefused: "ACTION_REFUSED",
	confirmationRequired: "CONFIRMATION_REQUIRED",
	policyBlocked: "POLICY_BLOCKED",
	nativeGrammarRequired: "NATIVE_GRAMMAR_REQUIRED",
	transportFailed: "TRANSPORT_FAILED",
	cancelled: "CANCELLED",
	internal: "INTERNAL",
});

export const UI_ACTION_INTENT = Object.freeze({
	read: "read",
	mutate: "mutate",
	destructive: "destructive",
	emergency: "emergency",
});

export const UI_CONFIRMATION = Object.freeze({
	none: "none",
	acknowledge: "acknowledge",
	typed: "typed",
});

/**
 * @typedef {{
 *   requestId?: string,
 *   at: string,
 *   stale?: boolean,
 *   revision?: string | number,
 *   jobId?: string,
 * }} UiMeta
 */

/**
 * @typedef {{
 *   code: string,
 *   kind: string,
 *   message: string,
 *   detail?: string,
 *   field?: string,
 *   retryable: boolean,
 *   suggestedAction?: string,
 * }} UiError
 */

/** @typedef {{ level: "success" | "warning" | "error" | "info", message: string }} UiNotice */

/**
 * @typedef {{
 *   actionId: string,
 *   target: string,
 *   summary: string,
 *   strength: "acknowledge" | "typed",
 * }} UiConfirmation
 */

/**
 * @template T
 * @typedef {(
 *   { ok: true, data: T, meta: UiMeta, notices: UiNotice[] } |
 *   { ok: false, error: UiError, meta: UiMeta, confirmation?: UiConfirmation }
 * )} UiResult
 */
