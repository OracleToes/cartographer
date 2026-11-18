// Constructors for the one result shape presentation code is allowed to consume.
import { UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";

const text = (value, fallback) => (typeof value === "string" && value.trim() !== "" ? value.trim() : fallback);

/** Make metadata deterministic when a caller supplies `at`, and useful by default everywhere else. */
export function uiMeta(meta = {}) {
	const rawAt = meta.at ?? Date.now();
	const at = rawAt instanceof Date ? rawAt.toISOString() : typeof rawAt === "string" ? rawAt : new Date(rawAt).toISOString();
	return { ...meta, at };
}

/** Make a UI-safe issue without retaining an exception stack or arbitrary provider payload. */
export function uiError({
	code = UI_ERROR_CODE.internal,
	kind = UI_ERROR_KIND.internal,
	message = "Cartographer could not complete that action.",
	detail,
	field,
	retryable = false,
	suggestedAction,
} = {}) {
	return {
		code: text(code, UI_ERROR_CODE.internal),
		kind: text(kind, UI_ERROR_KIND.internal),
		message: text(message, "Cartographer could not complete that action."),
		...(typeof detail === "string" && detail.trim() !== "" ? { detail: detail.trim() } : {}),
		...(typeof field === "string" && field.trim() !== "" ? { field: field.trim() } : {}),
		retryable: retryable === true,
		...(typeof suggestedAction === "string" && suggestedAction.trim() !== "" ? { suggestedAction: suggestedAction.trim() } : {}),
	};
}

/** Turn an expected or unexpected thrown value into a safe application error. */
export function uiErrorFrom(error, options = {}) {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	return uiError({
		...options,
		message: options.message ?? message ?? "Cartographer could not complete that action.",
	});
}

/** @template T */
export function uiSuccess(data, { meta, notices = [] } = {}) {
	return {
		ok: true,
		data,
		meta: uiMeta(meta),
		notices: notices.filter((notice) => notice !== undefined),
	};
}

/** @template T */
export function uiFailure(error, { meta, confirmation } = {}) {
	return {
		ok: false,
		error: uiError(error),
		meta: uiMeta(meta),
		...(confirmation === undefined ? {} : { confirmation }),
	};
}

/** A cancelled request is neither an internal failure nor a success notice. */
export function uiCancelled({ meta, message = "The action was cancelled." } = {}) {
	return uiFailure({
		code: UI_ERROR_CODE.cancelled,
		kind: UI_ERROR_KIND.cancelled,
		message,
		retryable: true,
	}, { meta });
}
