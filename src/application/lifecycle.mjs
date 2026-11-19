// Typed adapter for terminal-owned session lifecycle controls.
//
// The terminal retains live ownership of streams, context reset, approval, initiation, sandbox switching, and native
// selector probes. This module deliberately exposes only named capabilities plus UiResult dispatch: Screen receives
// neither terminal closures nor mutable managers.
import { createCapabilityRegistry } from "./capabilities.mjs";
import { ACTION_LAUNCH, ACTION_TARGET_KIND, createActionSpecRegistry } from "./action-specs.mjs";
import { UI_ACTION_INTENT, UI_CONFIRMATION, UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";
import { yieldToUi } from "./defer.mjs";
import { uiCancelled, uiError, uiErrorFrom, uiFailure } from "./result.mjs";

export const LIFECYCLE_ACTION = Object.freeze({
	stop: "lifecycle.stop",
	togglePause: "lifecycle.pause",
	refreshTop: "lifecycle.refresh-top",
	collapse: "lifecycle.collapse",
	freshContext: "lifecycle.fresh-context",
	toggleApproval: "lifecycle.approval.toggle",
	toggleInitiation: "lifecycle.initiation.toggle",
	toggleSandbox: "lifecycle.sandbox.toggle",
	selectorProbe: "lifecycle.selector-probe",
});

// Lifecycle actions are deliberately a sibling registry rather than entries in application.execute: their owner is
// the terminal composition, not a durable-domain service. The Screen can still use the same narrow action-launcher
// contract without discovering a terminal closure.
const LIFECYCLE_SPEC_REGISTRY = createActionSpecRegistry([
	...Object.values(LIFECYCLE_ACTION)
		.filter((id) => ![LIFECYCLE_ACTION.refreshTop, LIFECYCLE_ACTION.selectorProbe].includes(id))
		.map((id) => ({ id, launch: ACTION_LAUNCH.direct, target: { kind: ACTION_TARGET_KIND.none }, fields: [] })),
	{
		id: LIFECYCLE_ACTION.refreshTop,
		launch: ACTION_LAUNCH.dialog,
		target: { kind: ACTION_TARGET_KIND.none },
		fields: [{ id: "reason", label: "Reason", kind: "text", required: true, multiline: false, limit: 240, help: "Say why the top-of-context copy needs an explicit refresh." }],
	},
	{
		id: LIFECYCLE_ACTION.selectorProbe,
		launch: ACTION_LAUNCH.dialog,
		target: { kind: ACTION_TARGET_KIND.none },
		fields: [{ id: "path", label: "Optional project-relative JSON log path", kind: "path", required: false, multiline: false, limit: 1_024 }],
	},
]);
export const LIFECYCLE_ACTION_SPECS = LIFECYCLE_SPEC_REGISTRY.list();
export const lifecycleActionSpecFor = LIFECYCLE_SPEC_REGISTRY.get;

const text = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const unavailable = (reason = "This session lifecycle control is unavailable right now.") => ({ enabled: false, reason: text(reason) ?? "This session lifecycle control is unavailable right now." });

/** A late-bound bridge lets Screen compose its application facade before runTerminal has installed its lifecycle owner. */
export function createLifecycleBridge({ unavailableReason = "Terminal lifecycle controls are not attached to this Screen yet." } = {}) {
	let port;
	return Object.freeze({
		attach(next) {
			if (next === null || typeof next !== "object" || typeof next.execute !== "function" || typeof next.availability !== "function") throw new TypeError("A lifecycle bridge needs a typed terminal lifecycle port.");
			port = next;
			return true;
		},
		availability(action) {
			if (port === undefined) return unavailable(unavailableReason);
			try {
				const value = port.availability(action);
				if (value === true) return { enabled: true };
				if (value === undefined) return unavailable("The terminal did not report whether this lifecycle action is safe.");
				if (value === false) return unavailable();
				if (!record(value) || typeof value.enabled !== "boolean") return unavailable("The terminal supplied an invalid lifecycle availability state.");
				return value.enabled ? { enabled: true } : unavailable(value.reason);
			} catch (error) {
				return unavailable(`Lifecycle availability could not be read: ${error?.message ?? error}`);
			}
		},
		execute: (...args) => port?.execute(...args),
		attached: () => port !== undefined,
	});
}

const availabilityFromPort = (port, action) => {
	if (typeof port?.availability !== "function") return unavailable("This terminal has no lifecycle control port.");
	try {
		const value = port.availability(action);
		if (value === true) return { enabled: true };
		if (value === false) return unavailable();
		if (!record(value) || typeof value.enabled !== "boolean") return unavailable("The terminal supplied an invalid lifecycle availability state.");
		return value.enabled ? { enabled: true } : unavailable(value.reason);
	} catch (error) {
		return unavailable(`Lifecycle availability could not be read: ${error?.message ?? error}`);
	}
};
const availableFromPort = (action) => ({ port }) => availabilityFromPort(port, action);

export const LIFECYCLE_CAPABILITY_DEFINITIONS = Object.freeze([
	{ id: LIFECYCLE_ACTION.stop, label: "Stop agent work", category: "lifecycle", intent: UI_ACTION_INTENT.emergency, available: availableFromPort(LIFECYCLE_ACTION.stop) },
	{ id: LIFECYCLE_ACTION.togglePause, label: "Pause or resume stream", category: "lifecycle", intent: UI_ACTION_INTENT.mutate, available: availableFromPort(LIFECYCLE_ACTION.togglePause) },
	{ id: LIFECYCLE_ACTION.refreshTop, label: "Refresh context top", category: "lifecycle", intent: UI_ACTION_INTENT.mutate, available: availableFromPort(LIFECYCLE_ACTION.refreshTop) },
	{ id: LIFECYCLE_ACTION.collapse, label: "Collapse context", category: "lifecycle", intent: UI_ACTION_INTENT.mutate, available: availableFromPort(LIFECYCLE_ACTION.collapse) },
	{
		id: LIFECYCLE_ACTION.freshContext,
		label: "Start fresh context",
		category: "lifecycle",
		intent: UI_ACTION_INTENT.destructive,
		confirmation: UI_CONFIRMATION.acknowledge,
		available: availableFromPort(LIFECYCLE_ACTION.freshContext),
	},
	{ id: LIFECYCLE_ACTION.toggleApproval, label: "Toggle session approval", category: "lifecycle", intent: UI_ACTION_INTENT.destructive, available: availableFromPort(LIFECYCLE_ACTION.toggleApproval) },
	{ id: LIFECYCLE_ACTION.toggleInitiation, label: "Toggle session initiation", category: "lifecycle", intent: UI_ACTION_INTENT.mutate, available: availableFromPort(LIFECYCLE_ACTION.toggleInitiation) },
	{ id: LIFECYCLE_ACTION.toggleSandbox, label: "Toggle session sandbox", category: "lifecycle", intent: UI_ACTION_INTENT.destructive, available: availableFromPort(LIFECYCLE_ACTION.toggleSandbox) },
	{ id: LIFECYCLE_ACTION.selectorProbe, label: "Run native selector probe", category: "lifecycle", intent: UI_ACTION_INTENT.read, available: availableFromPort(LIFECYCLE_ACTION.selectorProbe) },
]);

const registry = createCapabilityRegistry(LIFECYCLE_CAPABILITY_DEFINITIONS);
const metadata = (options, now) => ({
	...(typeof options?.requestId === "string" && options.requestId !== "" ? { requestId: options.requestId } : {}),
	at: new Date(now()).toISOString(),
});
const invalidInput = (message, meta) => uiFailure(uiError({
	code: UI_ERROR_CODE.invalidInput,
	kind: UI_ERROR_KIND.validation,
	message,
	retryable: false,
}), { meta });
const blocked = (message, meta) => uiFailure(uiError({
	code: UI_ERROR_CODE.policyBlocked,
	kind: UI_ERROR_KIND.policy,
	message,
	retryable: false,
}), { meta });
const validResult = (value) => value !== null && typeof value === "object" && typeof value.ok === "boolean" && record(value.meta) && (value.ok ? value.data !== undefined : value.error !== undefined);
const confirmationFor = (capability) => capability.id === LIFECYCLE_ACTION.freshContext
	? {
		actionId: capability.id,
		target: "current context",
		summary: "Start a fresh context and clear kept talk, task records, shelf placements, and the collapse marker. Stored session history remains available.",
		strength: capability.confirmation,
	}
	: undefined;
const confirmed = (confirmation, request) => confirmation?.acknowledged === true && confirmation.actionId === request.actionId && confirmation.target === request.target;

/**
 * @param {{ port?: { availability?: (action: string) => boolean | { enabled: boolean, reason?: string }, execute?: (action: string, input: object, options: object) => Promise<object> | object }, now?: () => number }} options
 */
export function createLifecycleApplication({ port, now = () => Date.now() } = {}) {
	const context = Object.freeze({ port });
	const publicCapability = (id) => {
		const capability = registry.get(id);
		if (capability === undefined) return undefined;
		const { available, ...publicDefinition } = capability;
		return Object.freeze({ ...publicDefinition, availability: registry.availability(id, context) });
	};
	const capabilities = Object.freeze({
		get: publicCapability,
		availability: (id) => registry.availability(id, context),
		list: () => registry.list(context),
	});
	const execute = async (action, input = {}, options = {}) => {
		const meta = metadata(options, now);
		if (options.signal?.aborted === true) return uiCancelled({ meta });
		// Stop is the emergency path: do not insert a scheduler turn before the terminal aborts its live request.
		if (action !== LIFECYCLE_ACTION.stop) await yieldToUi();
		if (options.signal?.aborted === true) return uiCancelled({ meta });
		const capability = registry.get(action);
		if (capability === undefined) return uiFailure(uiError({
			code: UI_ERROR_CODE.unknownAction,
			kind: UI_ERROR_KIND.validation,
			message: "That lifecycle action is not registered.",
			retryable: false,
		}), { meta });
		if (!record(input)) return invalidInput("This lifecycle action needs an input object.", meta);
		const availability = registry.availability(action, context);
		if (availability?.enabled !== true) return blocked(availability?.reason ?? "This lifecycle action is unavailable right now.", meta);
		const confirmation = capability.confirmation === UI_CONFIRMATION.none ? undefined : confirmationFor(capability);
		if (confirmation !== undefined && !confirmed(options.confirmation, confirmation)) return uiFailure(uiError({
			code: UI_ERROR_CODE.confirmationRequired,
			kind: UI_ERROR_KIND.policy,
			message: confirmation.summary,
			retryable: false,
		}), { meta, confirmation });
		if (typeof port?.execute !== "function") return blocked("This terminal has no lifecycle control port.", meta);
		try {
			const result = await port.execute(action, input, { ...options, requestId: meta.requestId });
			if (validResult(result)) return result;
			return uiFailure(uiError({
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "The terminal returned an invalid lifecycle result.",
				retryable: true,
			}), { meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not complete that lifecycle action.",
				retryable: true,
			}), { meta });
		}
	};
	return Object.freeze({ capabilities, execute });
}
