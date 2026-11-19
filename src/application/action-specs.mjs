// Pure launch metadata for registered application actions.
//
// Capability definitions remain authoritative for labels, category, intent, confirmation, and availability. These
// specs describe only an action's input shape and target kind. Screen placement, route selection, and widgets live
// elsewhere, so neither an application owner nor a renderer gains a second route to a mutable manager.

export const ACTION_LAUNCH = Object.freeze({
	direct: "direct",
	dialog: "dialog",
	existingControl: "existing-control",
});

export const ACTION_TARGET_KIND = Object.freeze({
	none: "none",
	request: "request",
	workspaceRow: "workspace-row",
	atlasFocus: "atlas-focus",
	file: "file",
	shellWindow: "shell-window",
	wake: "wake",
	modelRoute: "model-route",
	keptTalkSource: "kept-talk-source",
	setting: "setting",
	planEnvelope: "plan-envelope",
});

export const ACTION_FIELD_KIND = Object.freeze({
	text: "text",
	integer: "integer",
	boolean: "boolean",
	path: "path",
	lineRange: "line-range",
});

const text = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const freeze = (value) => Object.freeze(value);

const target = (kind = ACTION_TARGET_KIND.none, input) => ({ kind, ...(input === undefined ? {} : { input }) });
const field = (id, label, { kind = ACTION_FIELD_KIND.text, required = false, multiline = false, limit = 1_024, help } = {}) => ({
	id,
	label,
	kind,
	required,
	multiline,
	limit,
	...(help === undefined ? {} : { help }),
});

const normalizeField = (value, actionId, seen) => {
	if (!record(value)) throw new TypeError(`Action spec ${actionId} needs field objects.`);
	const id = text(value.id);
	const label = text(value.label);
	if (id === undefined || label === undefined) throw new TypeError(`Action spec ${actionId} needs a field id and label.`);
	if (seen.has(id)) throw new TypeError(`Action spec ${actionId} declares ${id} twice.`);
	seen.add(id);
	if (!Object.values(ACTION_FIELD_KIND).includes(value.kind)) throw new TypeError(`Action spec ${actionId} has an unknown field kind.`);
	if (!Number.isInteger(value.limit) || value.limit < 1) throw new TypeError(`Action spec ${actionId} needs a positive field limit.`);
	if (typeof value.required !== "boolean" || typeof value.multiline !== "boolean") throw new TypeError(`Action spec ${actionId} has invalid field flags.`);
	const help = value.help === undefined ? undefined : text(value.help);
	if (value.help !== undefined && help === undefined) throw new TypeError(`Action spec ${actionId} has blank field help.`);
	return freeze({ id, label, kind: value.kind, required: value.required, multiline: value.multiline, limit: value.limit, ...(help === undefined ? {} : { help }) });
};

const normalizeTarget = (value, actionId) => {
	if (!record(value) || !Object.values(ACTION_TARGET_KIND).includes(value.kind)) throw new TypeError(`Action spec ${actionId} has an unknown target kind.`);
	const input = value.input === undefined ? undefined : text(value.input);
	if (value.kind === ACTION_TARGET_KIND.none && input !== undefined) throw new TypeError(`Action spec ${actionId} cannot bind a none target.`);
	if (value.kind !== ACTION_TARGET_KIND.none && input === undefined) throw new TypeError(`Action spec ${actionId} needs a target input name.`);
	return freeze({ kind: value.kind, ...(input === undefined ? {} : { input }) });
};

const normalize = (value) => {
	if (!record(value)) throw new TypeError("An action spec must be an object.");
	const id = text(value.id);
	if (id === undefined) throw new TypeError("An action spec needs an id.");
	if (!Object.values(ACTION_LAUNCH).includes(value.launch)) throw new TypeError(`Action spec ${id} has an unknown launch strategy.`);
	if (!Array.isArray(value.fields)) throw new TypeError(`Action spec ${id} needs a fields array.`);
	const seen = new Set();
	const fields = freeze(value.fields.map((entry) => normalizeField(entry, id, seen)));
	if (value.launch === ACTION_LAUNCH.direct && fields.length !== 0) throw new TypeError(`Direct action spec ${id} cannot declare dialog fields.`);
	return freeze({ id, launch: value.launch, target: normalizeTarget(value.target, id), fields });
};

/** Validate launch metadata once and make identity lookup deterministic for adapters. */
export function createActionSpecRegistry(specs) {
	if (!Array.isArray(specs)) throw new TypeError("Action specs must be an array.");
	const byId = new Map();
	for (const raw of specs) {
		const spec = normalize(raw);
		if (byId.has(spec.id)) throw new TypeError(`Action spec ${spec.id} is declared twice.`);
		byId.set(spec.id, spec);
	}
	const list = freeze([...byId.values()]);
	return freeze({
		get: (id) => byId.get(id),
		list: () => list,
	});
}

const actionIds = (source, name) => {
	const list = Array.isArray(source) ? source : typeof source?.list === "function" ? source.list() : undefined;
	if (!Array.isArray(list)) throw new TypeError(`${name} need a list.`);
	const ids = list.map((entry) => text(entry?.id));
	if (ids.some((id) => id === undefined)) throw new TypeError(`${name} need ids.`);
	return ids;
};

/** Fail composition early if a registered action lacks schema metadata, or stale metadata outlives its capability. */
export function assertActionSpecParity(capabilities, specs = ACTION_SPECS) {
	const capabilityIds = actionIds(capabilities, "Capabilities");
	const specIds = actionIds(specs, "Action specs");
	const missing = capabilityIds.filter((id) => !specIds.includes(id));
	const extra = specIds.filter((id) => !capabilityIds.includes(id));
	if (missing.length > 0 || extra.length > 0) {
		const detail = [
			missing.length === 0 ? undefined : `missing specs: ${missing.join(", ")}`,
			extra.length === 0 ? undefined : `unknown specs: ${extra.join(", ")}`,
		].filter(Boolean).join("; ");
		throw new TypeError(`Action-spec parity failed (${detail}).`);
	}
	return freeze({ actionIds: freeze([...capabilityIds]) });
}

const RAW_ACTION_SPECS = [
	// Context
	{ id: "context.pin-top", launch: ACTION_LAUNCH.dialog, target: target(), fields: [field("reason", "Reason", { required: true, limit: 240, help: "Say why the top-of-context copy needs an explicit refresh." })] },
	{ id: "context.clear-kept", launch: ACTION_LAUNCH.direct, target: target(), fields: [] },

	// Requests
	{ id: "request.approve", launch: ACTION_LAUNCH.direct, target: target(ACTION_TARGET_KIND.request, "ids"), fields: [] },
	{ id: "request.deny", launch: ACTION_LAUNCH.dialog, target: target(ACTION_TARGET_KIND.request, "id"), fields: [field("reason", "Reason", { multiline: true, limit: 2_048, help: "Optional context for the agent when a request is turned down." })] },
	{ id: "request.answer", launch: ACTION_LAUNCH.dialog, target: target(ACTION_TARGET_KIND.request, "id"), fields: [field("text", "Answer", { required: true, multiline: true, limit: 4_096 })] },

	// Review
	// Screen reuses the established recovery bridge, which first records active shell changes before it requests undo.
	{ id: "review.undo", launch: ACTION_LAUNCH.existingControl, target: target(), fields: [] },
	{ id: "review.record-windows", launch: ACTION_LAUNCH.direct, target: target(), fields: [] },

	// Runtime
	{ id: "runtime.shell.send", launch: ACTION_LAUNCH.dialog, target: target(ACTION_TARGET_KIND.shellWindow, "name"), fields: [field("line", "Input", { required: true, limit: 4_096 })] },
	{ id: "runtime.shell.close", launch: ACTION_LAUNCH.dialog, target: target(ACTION_TARGET_KIND.shellWindow, "name"), fields: [field("reason", "Reason", { multiline: true, limit: 1_024, help: "Optional record of why this shell is being closed." })] },
	{ id: "runtime.shell.close-all", launch: ACTION_LAUNCH.dialog, target: target(), fields: [field("reason", "Reason", { multiline: true, limit: 1_024, help: "Optional record of why every shell is being closed." })] },
	// Wake trigger fields change with the selected kind, so Screen owns the schema-derived WakeDialog while the
	// application action remains the sole validator and scheduler mutator.
	{ id: "runtime.wake.create", launch: ACTION_LAUNCH.existingControl, target: target(), fields: [] },
	{ id: "runtime.wake.replace", launch: ACTION_LAUNCH.existingControl, target: target(ACTION_TARGET_KIND.wake, "id"), fields: [] },
	{ id: "runtime.wake.remove", launch: ACTION_LAUNCH.direct, target: target(ACTION_TARGET_KIND.wake, "id"), fields: [] },
	{ id: "runtime.task.message", launch: ACTION_LAUNCH.dialog, target: target(), fields: [field("text", "Message", { required: true, multiline: true, limit: 4_096 })] },
	{ id: "runtime.model.ensure", launch: ACTION_LAUNCH.direct, target: target(), fields: [] },
	{ id: "runtime.model.select", launch: ACTION_LAUNCH.direct, target: target(ACTION_TARGET_KIND.modelRoute, "modelId"), fields: [] },

	// Kept talk
	{ id: "talk.revise-source", launch: ACTION_LAUNCH.dialog, target: target(ACTION_TARGET_KIND.keptTalkSource, "source"), fields: [field("text", "Text", { required: true, multiline: true, limit: 16_384 })] },
	{ id: "talk.forget-source", launch: ACTION_LAUNCH.direct, target: target(ACTION_TARGET_KIND.keptTalkSource, "source"), fields: [] },

	// Workspace
	{ id: "workspace.archive", launch: ACTION_LAUNCH.direct, target: target(ACTION_TARGET_KIND.workspaceRow, "id"), fields: [] },
	{ id: "workspace.unarchive", launch: ACTION_LAUNCH.direct, target: target(ACTION_TARGET_KIND.workspaceRow, "id"), fields: [] },
	{ id: "workspace.delete", launch: ACTION_LAUNCH.direct, target: target(ACTION_TARGET_KIND.workspaceRow, "id"), fields: [] },
	{ id: "workspace.fold", launch: ACTION_LAUNCH.direct, target: target(ACTION_TARGET_KIND.workspaceRow, "id"), fields: [] },
	{ id: "workspace.recall", launch: ACTION_LAUNCH.direct, target: target(ACTION_TARGET_KIND.workspaceRow, "id"), fields: [] },
	{ id: "workspace.toggle-fold", launch: ACTION_LAUNCH.direct, target: target(ACTION_TARGET_KIND.workspaceRow, "id"), fields: [] },
	{ id: "workspace.settle", launch: ACTION_LAUNCH.existingControl, target: target(ACTION_TARGET_KIND.workspaceRow, "id"), fields: [] },
	{ id: "workspace.focus-atlas", launch: ACTION_LAUNCH.dialog, target: target(ACTION_TARGET_KIND.atlasFocus, "target"), fields: [field("reason", "Reason", { required: true, multiline: true, limit: 1_024 })] },
	{ id: "workspace.unfocus-atlas", launch: ACTION_LAUNCH.direct, target: target(), fields: [] },
	{ id: "workspace.shelve", launch: ACTION_LAUNCH.dialog, target: target(ACTION_TARGET_KIND.file, "path"), fields: [field("lines", "Lines", { kind: ACTION_FIELD_KIND.lineRange, limit: 40, help: "Optional inclusive range, such as 12-28." })] },
	{ id: "workspace.unshelve", launch: ACTION_LAUNCH.direct, target: target(ACTION_TARGET_KIND.workspaceRow, "id"), fields: [] },
	{ id: "workspace.add", launch: ACTION_LAUNCH.existingControl, target: target(), fields: [] },
	{ id: "workspace.add-move", launch: ACTION_LAUNCH.existingControl, target: target(ACTION_TARGET_KIND.planEnvelope, "parent"), fields: [] },
	{ id: "workspace.edit", launch: ACTION_LAUNCH.existingControl, target: target(ACTION_TARGET_KIND.workspaceRow, "id"), fields: [] },

	// Settings
	{ id: "settings.edit", launch: ACTION_LAUNCH.existingControl, target: target(ACTION_TARGET_KIND.setting, "key"), fields: [] },
	{ id: "settings.reset", launch: ACTION_LAUNCH.direct, target: target(ACTION_TARGET_KIND.setting, "key"), fields: [] },
];

const REGISTRY = createActionSpecRegistry(RAW_ACTION_SPECS);
export const ACTION_SPECS = REGISTRY.list();
export const actionSpecFor = REGISTRY.get;
