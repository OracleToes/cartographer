// The first application facade: typed, UI-safe workspace row actions.
//
// `src/ops.mjs` is the existing authoritative implementation. It still returns historical display lines and uses
// synchronous storage internally, so this adapter intentionally contains that transitional seam. Presentation
// code consumes the structured result below rather than inferring success from those lines; later async storage
// work stays behind this facade instead of changing every caller again.
import { ShelfError, foldReports, recallReport } from "../context.mjs";
import { ADD_BOOKS, addTemplate, applyAdd, archiveRow, dropRow, editRow, foldRow, settleRow, unarchiveRow, unshelveRow } from "../ops.mjs";
import { createCapabilityRegistry } from "./capabilities.mjs";
import { UI_ACTION_INTENT, UI_CONFIRMATION, UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";
import { uiCancelled, uiError, uiErrorFrom, uiFailure, uiSuccess } from "./result.mjs";

export const WORKSPACE_ACTION = Object.freeze({
	archive: "workspace.archive",
	unarchive: "workspace.unarchive",
	delete: "workspace.delete",
	fold: "workspace.fold",
	recall: "workspace.recall",
	toggleFold: "workspace.toggle-fold",
	settle: "workspace.settle",
	unshelve: "workspace.unshelve",
	add: "workspace.add",
	edit: "workspace.edit",
});

export const WORKSPACE_CAPABILITY_DEFINITIONS = Object.freeze([
	{ id: WORKSPACE_ACTION.archive, label: "Archive", category: "workspace", intent: UI_ACTION_INTENT.mutate },
	{ id: WORKSPACE_ACTION.unarchive, label: "Restore", category: "workspace", intent: UI_ACTION_INTENT.mutate },
	{ id: WORKSPACE_ACTION.delete, label: "Delete", category: "workspace", intent: UI_ACTION_INTENT.destructive, confirmation: UI_CONFIRMATION.acknowledge },
	{ id: WORKSPACE_ACTION.fold, label: "Fold report", category: "workspace", intent: UI_ACTION_INTENT.mutate },
	{ id: WORKSPACE_ACTION.recall, label: "Recall report", category: "workspace", intent: UI_ACTION_INTENT.mutate },
	{ id: WORKSPACE_ACTION.toggleFold, label: "Toggle report fold", category: "workspace", intent: UI_ACTION_INTENT.mutate },
	{ id: WORKSPACE_ACTION.settle, label: "Settle", category: "workspace", intent: UI_ACTION_INTENT.mutate },
	{ id: WORKSPACE_ACTION.unshelve, label: "Unshelve", category: "workspace", intent: UI_ACTION_INTENT.mutate },
	{ id: WORKSPACE_ACTION.add, label: "Add", category: "workspace", intent: UI_ACTION_INTENT.mutate },
	{ id: WORKSPACE_ACTION.edit, label: "Edit", category: "workspace", intent: UI_ACTION_INTENT.mutate },
]);

export const WORKSPACE_CAPABILITIES = createCapabilityRegistry(WORKSPACE_CAPABILITY_DEFINITIONS);

const DEFAULT_OPERATIONS = Object.freeze({
	addTemplate,
	applyAdd,
	archiveRow,
	dropRow,
	editRow,
	foldReports,
	foldRow,
	recallReport,
	settleRow,
	unarchiveRow,
	unshelveRow,
});

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
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

const idInput = (input, meta) => {
	if (!isRecord(input)) return { result: invalidInput("This action needs an input object.", meta) };
	const id = nonEmpty(input.id);
	if (id === undefined) return { result: invalidInput("Choose an item before running this action.", meta, "id") };
	return { value: { id } };
};

const checkedInput = (action, input, meta) => {
	if (action === WORKSPACE_ACTION.archive || action === WORKSPACE_ACTION.unarchive || action === WORKSPACE_ACTION.delete || action === WORKSPACE_ACTION.fold || action === WORKSPACE_ACTION.recall || action === WORKSPACE_ACTION.toggleFold || action === WORKSPACE_ACTION.unshelve) return idInput(input, meta);
	if (action === WORKSPACE_ACTION.settle) {
		const checked = idInput(input, meta);
		if (checked.result !== undefined) return checked;
		if (input.review !== undefined && typeof input.review !== "string") return { result: invalidInput("An acceptance review must be text.", meta, "review") };
		return { value: { ...checked.value, ...(typeof input.review === "string" ? { review: input.review } : {}) } };
	}
	if (action === WORKSPACE_ACTION.add) {
		if (!isRecord(input)) return { result: invalidInput("Adding a row needs an input object.", meta) };
		const book = nonEmpty(input.book);
		if (book === undefined || !ADD_BOOKS.includes(book)) return { result: invalidInput(`Choose one of ${ADD_BOOKS.join(", ")} before adding a row.`, meta, "book") };
		if (typeof input.text !== "string") return { result: invalidInput("The new row must be supplied as JSON text.", meta, "text") };
		return { value: { book, text: input.text } };
	}
	if (action === WORKSPACE_ACTION.edit) {
		const checked = idInput(input, meta);
		if (checked.result !== undefined) return checked;
		if (!isRecord(input.changes)) return { result: invalidInput("An edit needs the fields that changed.", meta, "changes") };
		return { value: { id: checked.value.id, changes: input.changes } };
	}
	return { result: uiFailure(uiError({
		code: UI_ERROR_CODE.unknownAction,
		kind: UI_ERROR_KIND.validation,
		message: "That workspace action is not registered.",
		retryable: false,
	}), { meta }) };
};

const confirmationFor = (capability, input) => ({
	actionId: capability.id,
	target: input.id,
	summary: `Delete ${input.id} permanently. This cannot be undone.`,
	strength: capability.confirmation,
});

const confirmed = (confirmation, request) => confirmation?.acknowledged === true && confirmation.actionId === request.actionId && confirmation.target === request.target;

/** Normalize the historical `ops` text contract at one seam, not in each UI component. */
export function workspaceOutcome(action, target, line, meta) {
	const text = String(line ?? "").trim();
	if (text === "") return uiFailure(uiError({
		code: UI_ERROR_CODE.internal,
		kind: UI_ERROR_KIND.internal,
		message: "The workspace operation completed without a result.",
		retryable: false,
	}), { meta });
	if (/^There is no\b/.test(text)) return uiFailure(uiError({
		code: UI_ERROR_CODE.notFound,
		kind: UI_ERROR_KIND.notFound,
		message: text,
		retryable: false,
	}), { meta });
	if (/^(?:Only a composed report row folds:|A report has no settled:|A node is (?:confirmed|added) from|There is no add for)/.test(text)) return uiFailure(uiError({
		code: UI_ERROR_CODE.actionRefused,
		kind: UI_ERROR_KIND.validation,
		message: text,
		retryable: false,
	}), { meta });
	if (text.startsWith("!")) {
		const message = text.replace(/^!\s*/, "");
		const unavailable = /cannot be read|could not be read/i.test(message);
		return uiFailure(uiError({
			code: UI_ERROR_CODE.actionRefused,
			kind: unavailable ? UI_ERROR_KIND.unavailable : UI_ERROR_KIND.validation,
			message,
			retryable: unavailable,
		}), { meta });
	}
	if (/\balready\.?$|\bis already out of view\b|\bis not archived\.?$|\bcannot be archived\.?$/i.test(text)) return uiFailure(uiError({
		code: UI_ERROR_CODE.conflict,
		kind: UI_ERROR_KIND.conflict,
		message: text,
		retryable: false,
	}), { meta });
	return uiSuccess({ action, target, line: text }, {
		meta,
		notices: [{ level: "success", message: text }],
	});
}

/**
 * @param {{
 *   brainDir: string,
 *   root: string,
 *   operations?: typeof DEFAULT_OPERATIONS,
 *   now?: () => number,
 * }} options
 */
export function createWorkspaceApplication({ brainDir, root, operations = DEFAULT_OPERATIONS, now = () => Date.now() }) {
	if (nonEmpty(brainDir) === undefined) throw new TypeError("A workspace application needs a brain directory.");
	if (nonEmpty(root) === undefined) throw new TypeError("A workspace application needs a project root.");

	const execute = async (action, input = {}, options = {}) => {
		const meta = metadata(options, now);
		if (options.signal?.aborted === true) return uiCancelled({ meta });
		const capability = WORKSPACE_CAPABILITIES.get(action);
		if (capability === undefined) return uiFailure(uiError({
			code: UI_ERROR_CODE.unknownAction,
			kind: UI_ERROR_KIND.validation,
			message: "That workspace action is not registered.",
			retryable: false,
		}), { meta });
		const availability = WORKSPACE_CAPABILITIES.availability(action, { brainDir, root });
		if (availability?.enabled !== true) return uiFailure(uiError({
			code: UI_ERROR_CODE.policyBlocked,
			kind: UI_ERROR_KIND.policy,
			message: availability?.reason ?? "This action is unavailable right now.",
			retryable: false,
		}), { meta });
		const checked = checkedInput(action, input, meta);
		if (checked.result !== undefined) return checked.result;
		if (capability.confirmation !== UI_CONFIRMATION.none) {
			const request = confirmationFor(capability, checked.value);
			if (!confirmed(options.confirmation, request)) return uiFailure(uiError({
				code: UI_ERROR_CODE.confirmationRequired,
				kind: UI_ERROR_KIND.policy,
				message: request.summary,
				retryable: false,
			}), { meta, confirmation: request });
		}
		try {
			let line;
			switch (action) {
				case WORKSPACE_ACTION.archive: line = operations.archiveRow(brainDir, checked.value.id); break;
				case WORKSPACE_ACTION.unarchive: line = operations.unarchiveRow(brainDir, checked.value.id); break;
				case WORKSPACE_ACTION.delete: line = operations.dropRow(brainDir, checked.value.id); break;
				case WORKSPACE_ACTION.fold: line = operations.foldReports(brainDir, [checked.value.id]); break;
				case WORKSPACE_ACTION.recall: line = operations.recallReport(brainDir, checked.value.id) ?? `There is no report ${checked.value.id}. /context lists the kept ones.`; break;
				case WORKSPACE_ACTION.toggleFold: line = operations.foldRow(brainDir, checked.value.id); break;
				case WORKSPACE_ACTION.settle: line = operations.settleRow(brainDir, checked.value.id, root, checked.value.review); break;
				case WORKSPACE_ACTION.unshelve: line = operations.unshelveRow(brainDir, checked.value.id); break;
				case WORKSPACE_ACTION.add: line = operations.applyAdd(brainDir, checked.value.book, checked.value.text, root); break;
				case WORKSPACE_ACTION.edit: line = operations.editRow(brainDir, checked.value.id, checked.value.changes, root); break;
				default: return uiFailure(uiError({
					code: UI_ERROR_CODE.unknownAction,
					kind: UI_ERROR_KIND.validation,
					message: "That workspace action is not registered.",
					retryable: false,
				}), { meta });
			}
			const target = checked.value.id ?? checked.value.book;
			return workspaceOutcome(action, target, line, meta);
		} catch (error) {
			if (error instanceof ShelfError) return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.notFound,
				kind: UI_ERROR_KIND.notFound,
				message: error.message,
				retryable: false,
			}), { meta });
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not complete that workspace action.",
				retryable: false,
			}), { meta });
		}
	};

	const template = async (book, options = {}) => {
		const meta = metadata(options, now);
		if (options.signal?.aborted === true) return uiCancelled({ meta });
		if (!ADD_BOOKS.includes(book)) return invalidInput(`Choose one of ${ADD_BOOKS.join(", ")} before adding a row.`, meta, "book");
		return uiSuccess({ book, text: operations.addTemplate(book) }, { meta });
	};

	return Object.freeze({ capabilities: WORKSPACE_CAPABILITIES, execute, template });
}
