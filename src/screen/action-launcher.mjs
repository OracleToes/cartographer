// Presentation-only action launch state machine.
//
// The launcher turns a capability plus pure action spec into a direct dispatch, schema dialog, existing control, or
// settled target picker. It owns neither projections nor durable behavior: Screen composition supplies settled rows
// and application.execute. Consequently a route transition never reads a live manager, and pending action requests
// cannot accidentally run twice.
import { ACTION_FIELD_KIND, ACTION_LAUNCH, ACTION_TARGET_KIND } from "../application/action-specs.mjs";

const text = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const frozen = (value) => Object.freeze(value);
const promise = (value) => value !== null && typeof value === "object" && typeof value.then === "function";

const titleFor = (capability, placement) => text(placement?.formTitle) ?? text(capability?.label) ?? "Action";
const unavailable = (capability) => capability?.availability?.enabled === false
	? text(capability.availability.reason) ?? "This action is unavailable right now."
	: undefined;
const targetLabel = (candidate) => text(candidate?.label) ?? text(candidate?.id) ?? "unnamed target";
const candidateKey = (candidate) => text(candidate?.key) ?? text(candidate?.id) ?? text(candidate?.value);
const candidateValue = (candidate) => candidate?.value ?? candidate?.id;

const targetInput = (candidate, value) => {
	if (candidate.input === undefined) return { value };
	if (!record(candidate.input)) throw new TypeError(`Action target ${candidateKey(candidate) ?? "?"} input must be an object.`);
	return { ...candidate.input };
};

/** Normalize already-settled projection rows for a target picker without exposing the projection owner. */
export function normalizeActionTargets(targets = []) {
	if (!Array.isArray(targets)) throw new TypeError("Action targets must be an array.");
	const seen = new Set();
	return targets.map((candidate) => {
		if (!record(candidate)) throw new TypeError("An action target must be an object.");
		const key = candidateKey(candidate);
		if (key === undefined) throw new TypeError("An action target needs a stable key.");
		if (seen.has(key)) throw new TypeError(`Action target ${key} is declared twice.`);
		seen.add(key);
		const value = candidateValue(candidate);
		if (value === undefined && candidate.input === undefined) throw new TypeError(`Action target ${key} needs a value or input.`);
		const input = targetInput(candidate, value);
		return frozen({
			key,
			...(value === undefined ? {} : { value }),
			input: frozen(input),
			label: targetLabel(candidate),
			...(text(candidate.detail) === undefined ? {} : { detail: text(candidate.detail) }),
			...(candidate.disabled === true ? { disabled: true, disabledReason: text(candidate.disabledReason) ?? "This target is unavailable right now." } : {}),
		});
	});
}

/**
 * Return the requested target from a settled source. `selected` may be a scalar key/value or a complete candidate.
 * No fallback reaches into a manager: no target gives the caller a refreshable unavailable result instead.
 */
export function resolveActionTarget({ kind, selected, targets = [] } = {}) {
	if (!Object.values(ACTION_TARGET_KIND).includes(kind)) throw new TypeError("An action target needs a known kind.");
	if (kind === ACTION_TARGET_KIND.none) return frozen({ state: "ready", input: {} });
	const choices = normalizeActionTargets(targets);
	const selectedKey = record(selected) ? candidateKey(selected) : text(selected);
	const selectedValue = record(selected) ? candidateValue(selected) : selected;
	const found = choices.find((choice) => choice.key === selectedKey || choice.value === selectedValue);
	if (found !== undefined && !found.disabled) return frozen({ state: "ready", target: found, input: found.input });
	if (choices.length === 0) return frozen({
		state: "unavailable",
		reason: "No current target is available in this settled view. Refresh and try again.",
	});
	return frozen({ state: "pick", targets: choices });
}

const parseField = (field, value) => {
	if (field.kind !== ACTION_FIELD_KIND.integer) return value;
	if (value.trim() === "") return value;
	if (!/^-?\d+$/.test(value.trim())) return { error: `${field.label} must be a whole number.` };
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : { error: `${field.label} is outside the supported range.` };
};

/** Schema-local form validation. Domain validation remains authoritative after application.execute. */
export function actionInputFromDrafts(fields, drafts) {
	if (!Array.isArray(fields) || !(drafts instanceof Map)) throw new TypeError("Action form validation needs fields and drafts.");
	const input = {};
	for (const field of fields) {
		const raw = String(drafts.get(field.id) ?? "");
		if (field.required && raw.trim() === "") return frozen({ ok: false, field: field.id, message: `${field.label} is required.` });
		if (raw.length > field.limit) return frozen({ ok: false, field: field.id, message: `${field.label} is too long.` });
		const parsed = parseField(field, raw);
		if (record(parsed) && parsed.error !== undefined) return frozen({ ok: false, field: field.id, message: parsed.error });
		if (raw !== "") input[field.id] = parsed;
	}
	return frozen({ ok: true, input });
}

/**
 * Pure state transition from palette/local shortcut to a direct request, dialog request, or target picker request.
 * A settled target may supply a complete `input` object for actions such as request approval or settings reset; a
 * simple candidate uses the spec's declared target input name.
 */
export function actionLaunchPlan({ capability, spec, placement, selected, targets = [] } = {}) {
	if (!record(capability) || text(capability.id) === undefined) throw new TypeError("An action launch needs a capability.");
	if (!record(spec) || spec.id !== capability.id) throw new TypeError("An action launch needs its matching action spec.");
	const blocked = unavailable(capability);
	if (blocked !== undefined) return frozen({ state: "unavailable", reason: blocked });
	const resolved = resolveActionTarget({ kind: spec.target.kind, selected, targets });
	if (resolved.state !== "ready") return resolved;
	const input = spec.target.input === undefined
		? {}
		: Object.hasOwn(resolved.input, "value")
			? { [spec.target.input]: resolved.input.value }
			: { ...resolved.input };
	if (spec.launch === ACTION_LAUNCH.direct) return frozen({ state: "execute", actionId: spec.id, input });
	if (spec.launch === ACTION_LAUNCH.existingControl) return frozen({ state: "existing-control", actionId: spec.id, input, reason: "This action opens its established Screen control." });
	return frozen({ state: "dialog", actionId: spec.id, title: titleFor(capability, placement), fields: spec.fields, input });
}

const requestKey = (actionId, input) => {
	try { return `${actionId}\u0000${JSON.stringify(input)}`; }
	catch { return actionId; }
};

/**
 * A request id is allocated once per user activation and stays occupied until application.execute settles. The gate
 * is intentionally application-agnostic so a Form, ConfirmDialog, and palette all share the same duplicate guard.
 */
export class ActionRequestGate {
	constructor({ execute, requestId = (() => `screen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`) } = {}) {
		if (typeof execute !== "function") throw new TypeError("An action request gate needs an execute function.");
		if (typeof requestId !== "function") throw new TypeError("An action request gate needs a request id factory.");
		this.execute = execute;
		this.requestId = requestId;
		this.pending = new Set();
	}
	busy(actionId, input = {}) { return this.pending.has(requestKey(actionId, input)); }
	async run(actionId, input = {}, options = {}) {
		const key = text(options.dedupeKey) ?? requestKey(actionId, input);
		if (this.pending.has(key)) return frozen({ ok: false, duplicate: true, message: "That action is already finishing." });
		const id = text(options.requestId) ?? text(this.requestId());
		if (id === undefined) throw new TypeError("An action request id cannot be blank.");
		this.pending.add(key);
		try {
			return await this.execute(actionId, input, { ...options, requestId: id });
		} finally {
			this.pending.delete(key);
		}
	}
}

const fromRegistry = (registry, id, name) => {
	if (typeof registry?.get !== "function") throw new TypeError(`An action launcher needs a ${name} registry.`);
	return registry.get(id);
};
const sameRoute = (left, right) => left?.tab === right?.tab && left?.view === right?.view;
const readyTargets = (value) => {
	if (Array.isArray(value)) return { state: "ready", targets: value };
	if (value === undefined) return { state: "unavailable", reason: "That target view is not settled. Refresh and try again." };
	if (!record(value)) throw new TypeError("An action target source must return an object or array.");
	if (value.state === "loading") return { state: "loading" };
	if (value.state === "unavailable") return { state: "unavailable", reason: text(value.reason) ?? "That target view is not available. Refresh and try again." };
	if (value.state !== undefined && value.state !== "ready") throw new TypeError("An action target source returned an unknown state.");
	if (!Array.isArray(value.targets)) throw new TypeError("A ready action target source needs targets.");
	return { state: "ready", targets: value.targets, selected: value.selected };
};
const opened = (value) => value === true || record(value) && value.opened !== false;

/**
 * Coordinate the Screen side of an action launch without reading a manager. `begin` records an action before a
 * palette closes; `resume` later consumes only the destination's settled target source. The injected presentation
 * callbacks keep this state machine usable in a terminal adapter and compact unit tests alike.
 */
export class ActionLauncher {
	/**
	 * @param {{
	 *   capabilities: { get: (id: string) => object | undefined },
	 *   specs: { get: (id: string) => object | undefined },
	 *   placements: { get: (id: string) => object | undefined },
	 *   execute: (actionId: string, input: object, options?: object) => Promise<object>,
	 *   currentRoute?: () => { tab: string, view: string } | undefined,
	 *   navigate?: (route: { tab: string, view: string }) => boolean | Promise<boolean>,
	 *   targetsFor?: (placement: object, pending: object) => object[] | { state?: string, targets?: object[], selected?: object, reason?: string } | undefined,
	 *   openDialog?: (given: { plan: object, submit: (input: object) => Promise<boolean> }) => boolean | { opened?: boolean, close?: () => void },
	 *   openTargetPicker?: (given: { title: string, targets: object[], choose: (target: object) => boolean | Promise<boolean> }) => boolean | { opened?: boolean, close?: () => void },
	 *   openConfirmation?: (given: { confirmation: object, confirm: () => Promise<boolean> }) => boolean | { opened?: boolean, close?: () => void },
	 *   openExistingControl?: (given: { plan: object, placement: object }) => boolean | Promise<boolean>,
	 *   present?: (result: object, pending: object) => void,
	 *   flash?: (message: string) => void,
	 *   defer?: (work: () => void) => void,
	 *   requestId?: () => string,
	 * }} given
	 */
	constructor(given = {}) {
		if (!record(given)) throw new TypeError("An action launcher needs its options.");
		if (typeof given.execute !== "function") throw new TypeError("An action launcher needs an execute callback.");
		this.capabilities = given.capabilities;
		this.specs = given.specs;
		this.placements = given.placements;
		this.currentRoute = typeof given.currentRoute === "function" ? given.currentRoute : () => undefined;
		this.navigate = typeof given.navigate === "function" ? given.navigate : () => true;
		this.targetsFor = typeof given.targetsFor === "function" ? given.targetsFor : () => [];
		this.openDialog = typeof given.openDialog === "function" ? given.openDialog : () => false;
		this.openTargetPicker = typeof given.openTargetPicker === "function" ? given.openTargetPicker : () => false;
		this.openConfirmation = typeof given.openConfirmation === "function" ? given.openConfirmation : () => false;
		this.openExistingControl = typeof given.openExistingControl === "function" ? given.openExistingControl : () => false;
		this.present = typeof given.present === "function" ? given.present : () => {};
		this.flash = typeof given.flash === "function" ? given.flash : () => {};
		this.defer = typeof given.defer === "function" ? given.defer : (work) => setTimeout(work, 0);
		this.gate = new ActionRequestGate({ execute: given.execute, ...(given.requestId === undefined ? {} : { requestId: given.requestId }) });
		this.pending = undefined;
	}
	state() {
		if (this.pending === undefined) return frozen({ state: "idle" });
		return frozen({ state: this.pending.phase, actionId: this.pending.actionId, route: this.pending.placement.route });
	}
	clear() {
		const pending = this.pending;
		this.pending = undefined;
		return pending;
	}
	/** Start an action but do not open a second overlay yet; callers invoke resume after a palette has closed. */
	async begin(actionId) {
		if (this.pending !== undefined) {
			this.flash("Finish or cancel the action already open first.");
			return false;
		}
		const capability = fromRegistry(this.capabilities, actionId, "capability");
		const spec = fromRegistry(this.specs, actionId, "action-spec");
		const placement = fromRegistry(this.placements, actionId, "action-placement");
		if (capability === undefined || spec === undefined || placement === undefined) {
			this.flash("This action has no complete Screen launch contract.");
			return false;
		}
		const blocked = unavailable(capability);
		if (blocked !== undefined) {
			this.flash(blocked);
			return false;
		}
		this.pending = { actionId, capability, spec, placement, phase: "routing", close: undefined, requestId: undefined };
		if (!sameRoute(this.currentRoute(), placement.route)) {
			let moved;
			try { moved = this.navigate(placement.route); }
			catch (error) {
				this.clear();
				this.flash(`Could not open that action: ${error?.message ?? error}`);
				return false;
			}
			if (promise(moved)) moved = await moved;
			if (moved === false) {
				this.clear();
				this.flash("That action's Screen route is unavailable.");
				return false;
			}
			this.pending.phase = "waiting-for-route";
		}
		return true;
	}
	/** Begin and resolve immediately when no palette/route transition needs to get out of the way. */
	async launch(actionId) {
		if (!await this.begin(actionId)) return false;
		return this.resume();
	}
	/** Let Screen composition signal that a deferred route projection has settled. */
	onRouteSettled(route = this.currentRoute()) {
		if (this.pending === undefined || !sameRoute(this.pending.placement.route, route)) return false;
		void this.resume();
		return true;
	}
	async resume() {
		const pending = this.pending;
		if (pending === undefined) return false;
		if (!sameRoute(this.currentRoute(), pending.placement.route)) return true;
		if (["dialog", "picker", "confirmation", "executing", "existing-control"].includes(pending.phase)) return true;
		let source;
		try {
			source = pending.spec.target.kind === ACTION_TARGET_KIND.none ? { state: "ready", targets: [] } : readyTargets(this.targetsFor(pending.placement, pending));
		} catch (error) {
			this.clear();
			this.flash(`Could not read that settled target view: ${error?.message ?? error}`);
			return false;
		}
		if (source.state === "loading") {
			pending.phase = "waiting-for-targets";
			return true;
		}
		if (source.state === "unavailable") {
			this.clear();
			this.flash(source.reason);
			return false;
		}
		return this.resolve(pending, source.selected, source.targets);
	}
	async choose(target) {
		const pending = this.pending;
		if (pending === undefined) return false;
		let source;
		try { source = readyTargets(this.targetsFor(pending.placement, pending)); }
		catch (error) {
			this.clear();
			this.flash(`Could not read that settled target view: ${error?.message ?? error}`);
			return false;
		}
		if (source.state !== "ready") {
			this.clear();
			this.flash(source.state === "loading" ? "That target view is still loading." : source.reason);
			return false;
		}
		// A target picker is itself an overlay. Dismiss it before opening the action's form/confirmation so the shared
		// overlay owner never stacks modals; the picker also closes on this true result, harmlessly idempotent.
		if (pending.phase === "picker") {
			pending.close?.();
			this.defer(() => {
				if (this.pending === pending) void this.resolve(pending, target, source.targets);
			});
			return true;
		}
		return this.resolve(pending, target, source.targets);
	}
	async resolve(pending, selected, targets) {
		let plan;
		try { plan = actionLaunchPlan({ capability: pending.capability, spec: pending.spec, placement: pending.placement, selected, targets }); }
		catch (error) {
			this.clear();
			this.flash(`Could not prepare that action: ${error?.message ?? error}`);
			return false;
		}
		if (plan.state === "unavailable") {
			this.clear();
			this.flash(plan.reason);
			return false;
		}
		if (plan.state === "pick") {
			pending.phase = "picker";
			const openedPicker = this.openTargetPicker({
				title: `Choose target · ${titleFor(pending.capability, pending.placement)}`,
				targets: plan.targets,
				choose: (target) => this.choose(target),
			});
			if (promise(openedPicker)) {
				const openedAsync = await openedPicker;
				if (!opened(openedAsync)) this.clear();
				return opened(openedAsync);
			}
			if (record(openedPicker) && typeof openedPicker.close === "function") pending.close = openedPicker.close;
			if (!opened(openedPicker)) this.clear();
			return opened(openedPicker);
		}
		if (plan.state === "existing-control") {
			pending.phase = "existing-control";
			let openedControl;
			try { openedControl = this.openExistingControl({ plan, placement: pending.placement }); }
			catch (error) {
				this.clear();
				this.flash(`Could not open that action: ${error?.message ?? error}`);
				return false;
			}
			if (promise(openedControl)) openedControl = await openedControl;
			this.clear();
			return opened(openedControl);
		}
		if (plan.state === "dialog") {
			pending.phase = "dialog";
			const openedDialog = this.openDialog({
				plan,
				submit: (input) => this.dispatch(pending, plan.actionId, input, { fromDialog: true }),
			});
			if (promise(openedDialog)) {
				const openedAsync = await openedDialog;
				if (!opened(openedAsync)) this.clear();
				return opened(openedAsync);
			}
			if (record(openedDialog) && typeof openedDialog.close === "function") pending.close = openedDialog.close;
			if (!opened(openedDialog)) this.clear();
			return opened(openedDialog);
		}
		return this.dispatch(pending, plan.actionId, plan.input, { fromDialog: false });
	}
	async dispatch(pending, actionId, input, { confirmation, fromDialog }) {
		if (this.pending !== pending) return false;
		pending.phase = "executing";
		let result;
		try {
			result = await this.gate.run(actionId, input, {
				...(pending.requestId === undefined ? {} : { requestId: pending.requestId }),
				...(confirmation === undefined ? {} : { confirmation }),
			});
		} catch (error) {
			pending.phase = fromDialog ? "dialog" : confirmation === undefined ? "idle" : "confirmation";
			if (!fromDialog && confirmation === undefined) this.clear();
			this.flash(`Could not complete that action: ${error?.message ?? error}`);
			return false;
		}
		if (result?.duplicate === true) {
			pending.phase = fromDialog ? "dialog" : confirmation === undefined ? "idle" : "confirmation";
			this.flash(result.message);
			return false;
		}
		if (typeof result?.meta?.requestId === "string" && result.meta.requestId !== "") pending.requestId = result.meta.requestId;
		if (result?.ok === true) {
			this.present(result, pending);
			this.clear();
			return true;
		}
		if (result?.confirmation !== undefined) {
			pending.phase = "confirmation";
			const open = () => {
				if (this.pending !== pending) return;
				const confirmationOpened = this.openConfirmation({
					confirmation: result.confirmation,
					confirm: () => this.dispatch(pending, actionId, input, {
						confirmation: { ...result.confirmation, acknowledged: true },
						fromDialog: false,
					}),
				});
				if (!opened(confirmationOpened)) {
					this.clear();
					this.flash("Could not open the required confirmation.");
				}
			};
			// A dialog must be dismissed before another focus-capturing confirmation can appear. The close is idempotent,
			// and defer lets an overlay owner finish that dismissal before it receives the next component.
			if (fromDialog && typeof pending.close === "function") {
				pending.close();
				this.defer(open);
			} else open();
			return true;
		}
		this.present(result, pending);
		if (fromDialog) pending.phase = "dialog";
		else if (confirmation !== undefined) pending.phase = "confirmation";
		else this.clear();
		return false;
	}
}
