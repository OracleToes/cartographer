// Typed recovery actions over Cartographer's checkpoint history.
//
// Checkpoint storage and the plan's move-revision rules remain authoritative in their existing domain modules. This
// adapter makes the user-facing undo path one typed action, so terminal and future Review controls never infer a
// partially completed recovery from printed command text.
import { CheckpointError, undo, windowStep } from "../checkpoints.mjs";
import { loadPlan, savePlan, undoMove } from "../plan.mjs";
import { createCapabilityRegistry } from "./capabilities.mjs";
import { UI_ACTION_INTENT, UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";
import { yieldToUi } from "./defer.mjs";
import { uiCancelled, uiError, uiErrorFrom, uiFailure, uiSuccess } from "./result.mjs";

export const REVIEW_ACTION = Object.freeze({
	undo: "review.undo",
	recordWindows: "review.record-windows",
});

export const REVIEW_CAPABILITY_DEFINITIONS = Object.freeze([
	{ id: REVIEW_ACTION.undo, label: "Undo last checkpoint change", category: "review", intent: UI_ACTION_INTENT.mutate },
	{
		id: REVIEW_ACTION.recordWindows,
		label: "Record shell window changes",
		category: "review",
		intent: UI_ACTION_INTENT.mutate,
		available: ({ windows }) => typeof windows?.takeActive === "function" ? true : { enabled: false, reason: "This session has no shell-window manager." },
	},
]);

export const REVIEW_CAPABILITIES = createCapabilityRegistry(REVIEW_CAPABILITY_DEFINITIONS);

const DEFAULT_OPERATIONS = Object.freeze({ loadPlan, savePlan, undo, undoMove, windowStep });
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

/**
 * @param {{
 *   root: string,
 *   brainDir: string,
 *   windows?: { takeActive?: () => string[] },
 *   operations?: typeof DEFAULT_OPERATIONS,
 *   now?: () => number,
 * }} options
 */
export function createReviewApplication({ root, brainDir, windows, operations = DEFAULT_OPERATIONS, now = () => Date.now() }) {
	if (nonEmpty(root) === undefined) throw new TypeError("A review application needs a project root.");
	if (nonEmpty(brainDir) === undefined) throw new TypeError("A review application needs a brain directory.");

	const execute = async (action, input = {}, options = {}) => {
		const meta = metadata(options, now);
		if (options.signal?.aborted === true) return uiCancelled({ meta });
		await yieldToUi();
		if (options.signal?.aborted === true) return uiCancelled({ meta });
		const capability = REVIEW_CAPABILITIES.get(action);
		if (capability === undefined) return uiFailure(uiError({
			code: UI_ERROR_CODE.unknownAction,
			kind: UI_ERROR_KIND.validation,
			message: "That review action is not registered.",
			retryable: false,
		}), { meta });
		const availability = REVIEW_CAPABILITIES.availability(action, { root, brainDir, windows });
		if (availability?.enabled !== true) return uiFailure(uiError({
			code: UI_ERROR_CODE.policyBlocked,
			kind: UI_ERROR_KIND.policy,
			message: availability?.reason ?? "This action is unavailable right now.",
			retryable: false,
		}), { meta });
		if (!isRecord(input)) return invalidInput("This review action does not take a command input.", meta);
		try {
			if (action === REVIEW_ACTION.recordWindows) {
				const step = operations.windowStep(root, brainDir, windows.takeActive());
				const line = step === undefined ? "No shell window changes need a checkpoint." : "Recorded shell window changes as a checkpoint.";
				return uiSuccess({ action, step, line }, {
					meta,
					notices: step === undefined ? [] : [{ level: "success", message: line }],
				});
			}
			const undone = operations.undo(root, brainDir);
			if (undone === undefined) {
				const line = "There is no change task left to undo.";
				return uiSuccess({ action, undone, line }, {
					meta,
					notices: [{ level: "info", message: line }],
				});
			}
			let plan;
			const loaded = operations.loadPlan(brainDir);
			if (loaded.plan === undefined) {
				plan = { state: "unavailable", message: "The plan file cannot be read, so the undo is not noted in it. Tell the agent which move you took back." };
			} else if (undone.item !== undefined) {
				try {
					const changed = operations.undoMove(loaded.plan, undone.item, new Date(now()).toISOString());
					operations.savePlan(brainDir, loaded.plan);
					plan = { state: "updated", line: changed.line, stale: changed.stale };
				} catch (error) {
					plan = { state: "failed", message: `The files were undone, but ${undone.item} could not be updated in the plan: ${error?.message ?? error}. Tell the agent before any further change.` };
				}
			} else plan = { state: "unchanged" };
			const line = `Undid ${undone.item ?? (undone.windows ? `window ${undone.windows.join(", ")}` : "change task")} · ${undone.text}`;
			const notices = [{ level: "success", message: line }];
			if (plan?.state === "unavailable" || plan?.state === "failed") notices.push({ level: "warning", message: plan.message });
			return uiSuccess({ action, undone, ...(plan === undefined ? {} : { plan }), line }, { meta, notices });
		} catch (error) {
			if (error instanceof CheckpointError) return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.actionRefused,
				kind: UI_ERROR_KIND.unavailable,
				message: error.message,
				retryable: true,
			}), { meta });
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: action === REVIEW_ACTION.recordWindows ? "Cartographer could not record the shell window changes." : "Cartographer could not undo the last checkpoint change.",
				retryable: false,
			}), { meta });
		}
	};

	return Object.freeze({ capabilities: REVIEW_CAPABILITIES, execute });
}
