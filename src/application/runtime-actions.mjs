// Typed controls for mutable Runtime managers.
//
// Shell windows, wake schedules, private task messages, and model routes stay owned by their established domain
// managers. This adapter gives terminal and future Runtime controls the same deferred, capability-checked result
// boundary as durable workspace actions; a renderer never needs to mutate a live manager directly.
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
	createWake: "runtime.wake.create",
	replaceWake: "runtime.wake.replace",
	removeWake: "runtime.wake.remove",
	routeTaskMessage: "runtime.task.message",
	ensureModel: "runtime.model.ensure",
	selectModel: "runtime.model.select",
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
		id: RUNTIME_ACTION.createWake,
		label: "Create wake",
		category: "runtime",
		intent: UI_ACTION_INTENT.mutate,
		available: ({ wakes }) => typeof wakes?.set === "function" ? true : { enabled: false, reason: "This session has no wake schedule." },
	},
	{
		id: RUNTIME_ACTION.replaceWake,
		label: "Replace wake",
		category: "runtime",
		intent: UI_ACTION_INTENT.mutate,
		available: ({ wakes }) => typeof wakes?.replace === "function" ? true : { enabled: false, reason: "This session cannot replace scheduled wakes." },
	},
	{
		id: RUNTIME_ACTION.removeWake,
		label: "Remove wake",
		category: "runtime",
		intent: UI_ACTION_INTENT.destructive,
		confirmation: UI_CONFIRMATION.acknowledge,
		available: ({ wakes }) => typeof wakes?.remove === "function" ? true : { enabled: false, reason: "This session has no wake schedule." },
	},
	{
		id: RUNTIME_ACTION.routeTaskMessage,
		label: "Message active task",
		category: "runtime",
		intent: UI_ACTION_INTENT.mutate,
		available: ({ work }) => typeof work?.tell === "function" ? true : { enabled: false, reason: "This session has no active-task message router." },
	},
	{
		id: RUNTIME_ACTION.ensureModel,
		label: "Connect model route",
		category: "runtime",
		intent: UI_ACTION_INTENT.read,
		available: ({ models }) => typeof models?.ensure === "function" ? true : { enabled: false, reason: "This session has no model-route manager." },
	},
	{
		id: RUNTIME_ACTION.selectModel,
		label: "Select model route",
		category: "runtime",
		intent: UI_ACTION_INTENT.mutate,
		available: ({ models }) => typeof models?.select === "function" ? true : { enabled: false, reason: "This session has no model-route manager." },
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

const wakeKinds = new Set(Object.values(POLICY.enums.wakeKinds));
const whole = (value) => Number.isInteger(value) ? value : undefined;
/** A wake replace is a complete new trigger, never a patch against cached lifecycle fields. */
const checkedWakeInput = (action, input, meta) => {
	const kind = nonEmpty(input.kind)?.toLowerCase();
	if (kind === undefined || !wakeKinds.has(kind)) return { result: invalidInput("Choose a time, file, or window trigger.", meta, "kind") };
	const note = nonEmpty(input.note);
	if (note === undefined) return { result: invalidInput("A wake needs a note for the agent.", meta, "note") };
	const every = whole(input.every);
	if (every === undefined) return { result: invalidInput("Wake cadence must be a whole number of seconds.", meta, "every") };
	const times = whole(input.times);
	if (times === undefined || times < 0) return { result: invalidInput("Wake repetitions must be zero or a positive whole number.", meta, "times") };
	const path = nonEmpty(input.path);
	const window = nonEmpty(input.window);
	const match = input.match === undefined ? undefined : nonEmpty(input.match);
	if (kind === POLICY.enums.wakeKinds.time) {
		if (path !== undefined || window !== undefined || match !== undefined) return { result: invalidInput("A time wake has no file, shell window, or match text.", meta, "kind") };
	} else if (kind === POLICY.enums.wakeKinds.file) {
		if (path === undefined) return { result: invalidInput("Choose a project file or folder for this wake.", meta, "path") };
		if (window !== undefined || match !== undefined) return { result: invalidInput("A file wake has no shell window or match text.", meta, "kind") };
	} else {
		if (window === undefined) return { result: invalidInput("Choose a shell window for this wake.", meta, "window") };
		if (path !== undefined) return { result: invalidInput("A window wake has no project file path.", meta, "kind") };
	}
	const id = action === RUNTIME_ACTION.replaceWake ? nonEmpty(input.id) : undefined;
	if (action === RUNTIME_ACTION.replaceWake && id === undefined) return { result: invalidInput("Choose a wake before replacing it.", meta, "id") };
	return { value: {
		...(id === undefined ? {} : { id }),
		wanted: {
			note,
			every,
			times,
			...(kind === POLICY.enums.wakeKinds.file ? { path } : {}),
			...(kind === POLICY.enums.wakeKinds.window ? { window, ...(match === undefined ? {} : { match }) } : {}),
		},
	} };
};

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
	if (action === RUNTIME_ACTION.createWake || action === RUNTIME_ACTION.replaceWake) return checkedWakeInput(action, input, meta);
	if (action === RUNTIME_ACTION.removeWake) {
		const id = nonEmpty(input.id);
		if (id === undefined) return { result: invalidInput("Choose a wake before removing it.", meta, "id") };
		return { value: { id } };
	}
	if (action === RUNTIME_ACTION.routeTaskMessage) {
		const text = nonEmpty(input.text);
		if (text === undefined) return { result: invalidInput("A task message cannot be empty.", meta, "text") };
		return { value: { text } };
	}
	if (action === RUNTIME_ACTION.ensureModel) return { value: {} };
	if (action === RUNTIME_ACTION.selectModel) {
		const modelId = nonEmpty(input.modelId);
		if (modelId === undefined) return { result: invalidInput("Choose a model route before selecting it.", meta, "modelId") };
		if (input.contextWindow !== undefined && (!Number.isInteger(input.contextWindow) || input.contextWindow <= 0)) return { result: invalidInput("A model context window must be a positive whole number.", meta, "contextWindow") };
		return { value: { modelId, ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }) } };
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
const modelFailure = (error, meta) => {
	const name = error?.name;
	if (name === "ModelServerUnavailableError") return uiFailure(uiError({
		code: UI_ERROR_CODE.transportFailed,
		kind: UI_ERROR_KIND.transport,
		message: error.message,
		retryable: true,
	}), { meta });
	if (name === "ModelRouteError") return uiFailure(uiError({
		code: UI_ERROR_CODE.notFound,
		kind: UI_ERROR_KIND.notFound,
		message: error.message,
		retryable: true,
	}), { meta });
	if (name === "NativeGrammarError") return uiFailure(uiError({
		code: UI_ERROR_CODE.nativeGrammarRequired,
		kind: UI_ERROR_KIND.nativeGrammar,
		message: error.message,
		retryable: true,
	}), { meta });
	return uiFailure(uiErrorFrom(error, {
		code: UI_ERROR_CODE.internal,
		kind: UI_ERROR_KIND.internal,
		message: "Cartographer could not complete that model action.",
		retryable: true,
	}), { meta });
};

/**
 * @param {{
 *   windows?: { send?: (name: string, line: string, options?: { waitMs?: number, signal?: AbortSignal }) => Promise<any>, close?: (name: string, options?: { why?: string }) => object, closeAll?: (options?: { why?: string }) => string[] },
 *   wakes?: { set?: (wanted: { note: string, every?: number, times?: number, path?: string, window?: string, match?: string }) => object, replace?: (id: string, wanted: { note: string, every?: number, times?: number, path?: string, window?: string, match?: string }) => { previous: object, wake: object }, remove?: (id: string) => any[] },
 *   work?: { tell?: (text: string) => boolean | { kind?: string } | Promise<boolean | { kind?: string }> },
 *   models?: { ensure?: () => Promise<object>, select?: (modelId: string, limits?: { contextWindow?: number }) => Promise<object | false> },
 *   shellSendWaitMs?: number,
 *   now?: () => number,
 * }} options
 */
export function createRuntimeApplication({ windows, wakes, work, models, shellSendWaitMs = POLICY.timing.terminal.shellSendWaitMs, now = () => Date.now() } = {}) {
	const context = { windows, wakes, work, models };

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
			if (action === RUNTIME_ACTION.routeTaskMessage) {
				const route = await work.tell(checked.value.text);
				const routed = route === true || route?.kind === "task";
				return uiSuccess({ action, routed }, { meta, notices: routed ? [{ level: "success", message: "The message will reach the running task at its next step." }] : [] });
			}
			if (action === RUNTIME_ACTION.ensureModel) {
				const limits = await models.ensure();
				const line = "The active model route is ready.";
				return uiSuccess({ action, limits, line }, { meta, notices: [{ level: "success", message: line }] });
			}
			if (action === RUNTIME_ACTION.selectModel) {
				const limits = await models.select(checked.value.modelId, checked.value.contextWindow === undefined ? {} : { contextWindow: checked.value.contextWindow });
				if (limits === false) return uiFailure(uiError({
					code: UI_ERROR_CODE.notFound,
					kind: UI_ERROR_KIND.notFound,
					message: `No model route named ${JSON.stringify(checked.value.modelId)} is available in this session.`,
					retryable: true,
				}), { meta });
				const line = `Selected model route ${checked.value.modelId}.`;
				return uiSuccess({ action, modelId: checked.value.modelId, limits, line }, { meta, notices: [{ level: "success", message: line }] });
			}
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
			if (action === RUNTIME_ACTION.createWake) {
				const wake = wakes.set(checked.value.wanted);
				const line = `Created wake ${wake.id}.`;
				return uiSuccess({ action, target: wake.id, wake, line }, { meta, notices: [{ level: "success", message: line }] });
			}
			if (action === RUNTIME_ACTION.replaceWake) {
				const replacement = wakes.replace(checked.value.id, checked.value.wanted);
				const line = `Replaced wake ${replacement.wake.id}; its schedule and firing history start over.`;
				return uiSuccess({ action, target: replacement.wake.id, ...replacement, line }, { meta, notices: [{ level: "success", message: line }] });
			}
			const removed = wakes.remove(checked.value.id);
			const line = removed.length === 1 ? `Removed wake ${removed[0].id}.` : `Removed ${removed.length} wakes.`;
			return uiSuccess({ action, target: checked.value.id, removed, line }, { meta, notices: [{ level: "success", message: line }] });
		} catch (error) {
			if (action === RUNTIME_ACTION.ensureModel || action === RUNTIME_ACTION.selectModel) return modelFailure(error, meta);
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
