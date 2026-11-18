// Typed controls for mutable Runtime managers.
//
// Shell windows and wake schedules stay owned by their established domain managers. This adapter gives terminal and
// future Runtime controls the same deferred, capability-checked result boundary as durable workspace actions; a
// renderer never needs to mutate a live manager directly.
import { POLICY } from "../config.mjs";
import { WakeError } from "../wakes.mjs";
import { WindowError } from "../windows.mjs";
import { createCapabilityRegistry } from "./capabilities.mjs";
import { UI_ACTION_INTENT, UI_CONFIRMATION, UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";
import { yieldToUi } from "./defer.mjs";
import { uiCancelled, uiError, uiErrorFrom, uiFailure, uiSuccess } from "./result.mjs";

export const RUNTIME_ACTION = Object.freeze({
	sendShell: "runtime.shell.send",
	closeShell: "runtime.shell.close",
	closeAllShells: "runtime.shell.close-all",
	removeWake: "runtime.wake.remove",
});

export const RUNTIME_CAPABILITY_DEFINITIONS = Object.freeze([
	{
		id: RUNTIME_ACTION.sendShell,
		label: "Send shell input",
		category: "runtime",
		intent: UI_ACTION_INTENT.mutate,
		available: ({ windows }) => typeof windows?.send === "function" ? true : { enabled: false, reason: "This session has no shell-window manager." },
	},
	{
		id: RUNTIME_ACTION.closeShell,
		label: "Close shell window",
		category: "runtime",
		intent: UI_ACTION_INTENT.destructive,
		confirmation: UI_CONFIRMATION.acknowledge,
		available: ({ windows }) => typeof windows?.close === "function" ? true : { enabled: false, reason: "This session has no shell-window manager." },
	},
	{
		id: RUNTIME_ACTION.closeAllShells,
		label: "Close all shell windows",
		category: "runtime",
		intent: UI_ACTION_INTENT.destructive,
		confirmation: UI_CONFIRMATION.acknowledge,
		available: ({ windows }) => typeof windows?.closeAll === "function" ? true : { enabled: false, reason: "This session has no shell-window manager." },
	},
	{
		id: RUNTIME_ACTION.removeWake,
		label: "Remove wake",
		category: "runtime",
		intent: UI_ACTION_INTENT.destructive,
		confirmation: UI_CONFIRMATION.acknowledge,
		available: ({ wakes }) => typeof wakes?.remove === "function" ? true : { enabled: false, reason: "This session has no wake schedule." },
	},
]);

export const RUNTIME_CAPABILITIES = createCapabilityRegistry(RUNTIME_CAPABILITY_DEFINITIONS);

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
const unavailable = (message, meta) => uiFailure(uiError({
	code: UI_ERROR_CODE.policyBlocked,
	kind: UI_ERROR_KIND.policy,
	message,
	retryable: false,
}), { meta });

const checkedInput = (action, input, meta) => {
	if (!isRecord(input)) return { result: invalidInput("This action needs an input object.", meta) };
	if (action === RUNTIME_ACTION.sendShell) {
		const name = nonEmpty(input.name);
		if (name === undefined) return { result: invalidInput("Choose a shell window before sending input.", meta, "name") };
		const line = nonEmpty(input.line);
		if (line === undefined) return { result: invalidInput("Shell input cannot be empty.", meta, "line") };
		return { value: { name, line } };
	}
	if (action === RUNTIME_ACTION.closeShell) {
		const name = nonEmpty(input.name);
		if (name === undefined) return { result: invalidInput("Choose a shell window before closing it.", meta, "name") };
		if (input.reason !== undefined && nonEmpty(input.reason) === undefined) return { result: invalidInput("A shell-close reason cannot be blank.", meta, "reason") };
		return { value: { name, ...(input.reason === undefined ? {} : { reason: input.reason.trim() }) } };
	}
	if (action === RUNTIME_ACTION.closeAllShells) {
		if (input.reason !== undefined && nonEmpty(input.reason) === undefined) return { result: invalidInput("A shell-close reason cannot be blank.", meta, "reason") };
		return { value: { ...(input.reason === undefined ? {} : { reason: input.reason.trim() }) } };
	}
	if (action === RUNTIME_ACTION.removeWake) {
		const id = nonEmpty(input.id);
		if (id === undefined) return { result: invalidInput("Choose a wake before removing it.", meta, "id") };
		return { value: { id } };
	}
	return { result: uiFailure(uiError({
		code: UI_ERROR_CODE.unknownAction,
		kind: UI_ERROR_KIND.validation,
		message: "That runtime action is not registered.",
		retryable: false,
	}), { meta }) };
};

const confirmationFor = (capability, input) => ({
	actionId: capability.id,
	target: input.name ?? input.id ?? "all",
	summary: capability.id === RUNTIME_ACTION.closeShell
		? `Close shell window ${input.name} and end anything running in it.`
		: capability.id === RUNTIME_ACTION.closeAllShells
			? "Close every shell window and end anything running in them."
			: input.id === "all"
				? "Remove every wake from this session."
				: `Remove wake ${input.id}.`,
	strength: capability.confirmation,
});
const confirmed = (confirmation, request) => confirmation?.acknowledged === true && confirmation.actionId === request.actionId && confirmation.target === request.target;

/**
 * @param {{
 *   windows?: { send?: (name: string, line: string, options?: { waitMs?: number, signal?: AbortSignal }) => Promise<any>, close?: (name: string, options?: { why?: string }) => object, closeAll?: (options?: { why?: string }) => string[] },
 *   wakes?: { remove?: (id: string) => any[] },
 *   shellSendWaitMs?: number,
 *   now?: () => number,
 * }} options
 */
export function createRuntimeApplication({ windows, wakes, shellSendWaitMs = POLICY.timing.terminal.shellSendWaitMs, now = () => Date.now() } = {}) {
	const context = { windows, wakes };

	const execute = async (action, input = {}, options = {}) => {
		const meta = metadata(options, now);
		if (options.signal?.aborted === true) return uiCancelled({ meta });
		await yieldToUi();
		if (options.signal?.aborted === true) return uiCancelled({ meta });
		const capability = RUNTIME_CAPABILITIES.get(action);
		if (capability === undefined) return uiFailure(uiError({
			code: UI_ERROR_CODE.unknownAction,
			kind: UI_ERROR_KIND.validation,
			message: "That runtime action is not registered.",
			retryable: false,
		}), { meta });
		const availability = RUNTIME_CAPABILITIES.availability(action, context);
		if (availability?.enabled !== true) return unavailable(availability?.reason ?? "This action is unavailable right now.", meta);
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
			if (action === RUNTIME_ACTION.sendShell) {
				const report = await windows.send(checked.value.name, checked.value.line, { waitMs: shellSendWaitMs, signal: options.signal });
				// Sending has already changed the live shell by the time its quiet-period wait finishes. Report that
				// truthfully even if the caller stopped waiting while the manager was gathering its report.
				const line = `Typed input into ${checked.value.name}.`;
				return uiSuccess({ action, target: checked.value.name, report, line }, { meta, notices: [{ level: "success", message: line }] });
			}
			if (action === RUNTIME_ACTION.closeShell) {
				const closed = windows.close(checked.value.name, { ...(checked.value.reason === undefined ? {} : { why: checked.value.reason }) });
				const line = closed.wasGone === true ? `Removed the retained record of shell window ${checked.value.name}.` : `Closed shell window ${checked.value.name}.`;
				return uiSuccess({ action, target: checked.value.name, closed, line }, { meta, notices: [{ level: "success", message: line }] });
			}
			if (action === RUNTIME_ACTION.closeAllShells) {
				const closed = windows.closeAll({ ...(checked.value.reason === undefined ? {} : { why: checked.value.reason }) });
				const count = closed.length;
				const line = count === 0 ? "No shell windows were open." : `Closed ${count} shell ${count === 1 ? "window" : "windows"}.`;
				return uiSuccess({ action, target: "all", closed, line }, { meta, notices: [{ level: "success", message: line }] });
			}
			const removed = wakes.remove(checked.value.id);
			const line = removed.length === 1 ? `Removed wake ${removed[0].id}.` : `Removed ${removed.length} wakes.`;
			return uiSuccess({ action, target: checked.value.id, removed, line }, { meta, notices: [{ level: "success", message: line }] });
		} catch (error) {
			if (error instanceof WindowError || error instanceof WakeError) {
				const message = error.message;
				const missing = /^(?:No wake is set\.|There is no (?:wake|window)\b)/.test(message);
				return uiFailure(uiError({
					code: missing ? UI_ERROR_CODE.notFound : UI_ERROR_CODE.actionRefused,
					kind: missing ? UI_ERROR_KIND.notFound : UI_ERROR_KIND.validation,
					message,
					retryable: false,
				}), { meta });
			}
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not complete that runtime action.",
				retryable: false,
			}), { meta });
		}
	};

	return Object.freeze({ capabilities: RUNTIME_CAPABILITIES, execute });
}
