// Presentation placement for registered application actions.
//
// This registry deliberately contains routes, settled target sources, shortcut labels, and form titles—but no mutable
// manager or domain import. It is the Screen half of the capability/action contract: the application owns the action,
// while this file says where a person can launch it from a settled projection.

export const ACTION_TARGET_SOURCE = Object.freeze({
	none: "none",
	requests: "requests",
	workspaceRows: "workspace-rows",
	atlasNodes: "atlas-nodes",
	files: "files",
	shellWindows: "shell-windows",
	wakes: "wakes",
	modelRoutes: "model-routes",
	keptTalk: "kept-talk",
	settings: "settings",
	planEnvelopes: "plan-envelopes",
});

const text = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const freeze = (value) => Object.freeze(value);
const route = (tab, view) => ({ tab, view });
const placement = (id, { route: at, targetSource = ACTION_TARGET_SOURCE.none, shortcut, paletteText, formTitle, terminalPath } = {}) => ({
	id,
	route: at,
	targetSource,
	...(shortcut === undefined ? {} : { shortcut }),
	...(paletteText === undefined ? {} : { paletteText }),
	...(formTitle === undefined ? {} : { formTitle }),
	...(terminalPath === undefined ? {} : { terminalPath }),
});

const normalizeRoute = (value, id) => {
	if (!record(value)) throw new TypeError(`Action placement ${id} needs a route.`);
	const tab = text(value.tab);
	const view = text(value.view);
	if (tab === undefined || view === undefined) throw new TypeError(`Action placement ${id} needs a tab and view.`);
	return freeze({ tab, view });
};

const normalize = (value) => {
	if (!record(value)) throw new TypeError("An action placement must be an object.");
	const id = text(value.id);
	if (id === undefined) throw new TypeError("An action placement needs an id.");
	if (!Object.values(ACTION_TARGET_SOURCE).includes(value.targetSource)) throw new TypeError(`Action placement ${id} has an unknown settled target source.`);
	const optional = (key) => {
		if (value[key] === undefined) return undefined;
		const normalized = text(value[key]);
		if (normalized === undefined) throw new TypeError(`Action placement ${id} has a blank ${key}.`);
		return normalized;
	};
	const shortcut = optional("shortcut");
	const paletteText = optional("paletteText");
	const formTitle = optional("formTitle");
	const terminalPath = optional("terminalPath");
	return freeze({
		id,
		route: normalizeRoute(value.route, id),
		targetSource: value.targetSource,
		...(shortcut === undefined ? {} : { shortcut }),
		...(paletteText === undefined ? {} : { paletteText }),
		...(formTitle === undefined ? {} : { formTitle }),
		...(terminalPath === undefined ? {} : { terminalPath }),
	});
};

/** One presentation placement per known action; callers can resolve by id without another action list. */
export function createActionPlacementRegistry(placements) {
	if (!Array.isArray(placements)) throw new TypeError("Action placements must be an array.");
	const byId = new Map();
	for (const raw of placements) {
		const entry = normalize(raw);
		if (byId.has(entry.id)) throw new TypeError(`Action placement ${entry.id} is declared twice.`);
		byId.set(entry.id, entry);
	}
	const list = freeze([...byId.values()]);
	return freeze({ get: (id) => byId.get(id), list: () => list });
}

const idsOf = (source, name) => {
	const list = Array.isArray(source) ? source : typeof source?.list === "function" ? source.list() : undefined;
	if (!Array.isArray(list)) throw new TypeError(`${name} need a list.`);
	const ids = list.map((entry) => text(entry?.id));
	if (ids.some((id) => id === undefined)) throw new TypeError(`${name} need ids.`);
	return ids;
};

/** Keep palette completion honest: all registered actions must have exactly one Screen placement. */
export function assertActionPlacementParity(capabilities, placements = ACTION_PLACEMENTS) {
	const capabilityIds = idsOf(capabilities, "Capabilities");
	const placementIds = idsOf(placements, "Action placements");
	const missing = capabilityIds.filter((id) => !placementIds.includes(id));
	const extra = placementIds.filter((id) => !capabilityIds.includes(id));
	if (missing.length > 0 || extra.length > 0) {
		const detail = [
			missing.length === 0 ? undefined : `missing placements: ${missing.join(", ")}`,
			extra.length === 0 ? undefined : `unknown placements: ${extra.join(", ")}`,
		].filter(Boolean).join("; ");
		throw new TypeError(`Action-placement parity failed (${detail}).`);
	}
	return freeze({ actionIds: freeze([...capabilityIds]) });
}

const RAW_ACTION_PLACEMENTS = [
	// Context
	placement("context.pin-top", { route: route("context", "parts"), shortcut: "p", paletteText: "Refresh context top", formTitle: "Refresh context top", terminalPath: "/pin" }),
	placement("context.clear-kept", { route: route("context", "parts"), shortcut: "N", paletteText: "Start fresh context", terminalPath: "terminal lifecycle bridge" }),

	// Requests
	placement("request.approve", { route: route("carto", "requests"), targetSource: ACTION_TARGET_SOURCE.requests, shortcut: "a", paletteText: "Approve request", terminalPath: "/approve ID" }),
	placement("request.deny", { route: route("carto", "requests"), targetSource: ACTION_TARGET_SOURCE.requests, shortcut: "n", paletteText: "Deny request", formTitle: "Deny request", terminalPath: "/deny ID [reason]" }),
	placement("request.answer", { route: route("carto", "requests"), targetSource: ACTION_TARGET_SOURCE.requests, shortcut: "e", paletteText: "Answer request", formTitle: "Answer request", terminalPath: "/answer ID words" }),

	// Review
	placement("review.undo", { route: route("diff", "last"), shortcut: "u", paletteText: "Undo last checkpoint change", terminalPath: "/undo" }),
	placement("review.record-windows", { route: route("diff", "last"), paletteText: "Record shell window changes", terminalPath: "checkpoint bridge" }),

	// Runtime
	placement("runtime.shell.send", { route: route("shells", "list"), targetSource: ACTION_TARGET_SOURCE.shellWindows, shortcut: "s", paletteText: "Send shell input", formTitle: "Send shell input", terminalPath: "/send NAME line" }),
	placement("runtime.shell.close", { route: route("shells", "list"), targetSource: ACTION_TARGET_SOURCE.shellWindows, shortcut: "d", paletteText: "Close shell window", formTitle: "Close shell window", terminalPath: "/kill NAME" }),
	placement("runtime.shell.close-all", { route: route("shells", "list"), shortcut: "D", paletteText: "Close all shell windows", formTitle: "Close all shell windows", terminalPath: "/kill all" }),
	placement("runtime.wake.remove", { route: route("shells", "wakes"), targetSource: ACTION_TARGET_SOURCE.wakes, shortcut: "d", paletteText: "Remove wake", terminalPath: "/wakes remove ID" }),
	placement("runtime.task.message", { route: route("chat", "work"), shortcut: "m", paletteText: "Message active task", formTitle: "Message active task", terminalPath: "task-message boundary" }),
	placement("runtime.model.ensure", { route: route("context", "routes"), shortcut: "Enter", paletteText: "Connect model route", terminalPath: "/model" }),
	placement("runtime.model.select", { route: route("context", "routes"), targetSource: ACTION_TARGET_SOURCE.modelRoutes, shortcut: "Enter", paletteText: "Select model route", terminalPath: "/model NAME" }),

	// Kept talk
	placement("talk.revise-source", { route: route("chat", "conversation"), targetSource: ACTION_TARGET_SOURCE.keptTalk, shortcut: "e", paletteText: "Revise kept talk", formTitle: "Revise kept talk" }),
	placement("talk.forget-source", { route: route("chat", "conversation"), targetSource: ACTION_TARGET_SOURCE.keptTalk, shortcut: "d", paletteText: "Forget kept talk" }),

	// Workspace
	placement("workspace.archive", { route: route("carto", "atlas"), targetSource: ACTION_TARGET_SOURCE.workspaceRows, shortcut: "v", paletteText: "Archive workspace row", terminalPath: "/archive ID" }),
	placement("workspace.unarchive", { route: route("carto", "atlas"), targetSource: ACTION_TARGET_SOURCE.workspaceRows, shortcut: "v", paletteText: "Restore workspace row", terminalPath: "/unarchive ID" }),
	placement("workspace.delete", { route: route("carto", "atlas"), targetSource: ACTION_TARGET_SOURCE.workspaceRows, shortcut: "d", paletteText: "Delete workspace row", terminalPath: "/delete ID --yes" }),
	placement("workspace.fold", { route: route("carto", "hands"), targetSource: ACTION_TARGET_SOURCE.workspaceRows, paletteText: "Fold report", terminalPath: "/fold ID" }),
	placement("workspace.recall", { route: route("carto", "hands"), targetSource: ACTION_TARGET_SOURCE.workspaceRows, paletteText: "Recall report", terminalPath: "/report ID" }),
	placement("workspace.toggle-fold", { route: route("carto", "hands"), targetSource: ACTION_TARGET_SOURCE.workspaceRows, shortcut: "f", paletteText: "Toggle report fold", terminalPath: "/fold ID" }),
	placement("workspace.settle", { route: route("carto", "ledger"), targetSource: ACTION_TARGET_SOURCE.workspaceRows, shortcut: "t", paletteText: "Settle workspace row", terminalPath: "/done ID" }),
	placement("workspace.focus-atlas", { route: route("carto", "atlas"), targetSource: ACTION_TARGET_SOURCE.atlasNodes, paletteText: "Focus atlas", formTitle: "Focus atlas", terminalPath: "/focus NODE_OR_PATH reason" }),
	placement("workspace.unfocus-atlas", { route: route("carto", "atlas"), paletteText: "Clear atlas focus", terminalPath: "/unfocus" }),
	placement("workspace.shelve", { route: route("carto", "tree"), targetSource: ACTION_TARGET_SOURCE.files, shortcut: "a", paletteText: "Shelve file", formTitle: "Shelve file", terminalPath: "/shelve PATH [lines]" }),
	placement("workspace.unshelve", { route: route("carto", "hands"), targetSource: ACTION_TARGET_SOURCE.workspaceRows, shortcut: "x", paletteText: "Unshelve file", terminalPath: "/unshelve ID" }),
	placement("workspace.add", { route: route("carto", "ledger"), shortcut: "n", paletteText: "Add workspace row", terminalPath: "/new" }),
	placement("workspace.add-move", { route: route("carto", "plan"), targetSource: ACTION_TARGET_SOURCE.planEnvelopes, shortcut: "n", paletteText: "Add plan move", terminalPath: "/new" }),
	placement("workspace.edit", { route: route("carto", "atlas"), targetSource: ACTION_TARGET_SOURCE.workspaceRows, shortcut: "e", paletteText: "Edit workspace row", terminalPath: "/edit ID" }),

	// Settings
	placement("settings.edit", { route: route("settings", "configuration"), targetSource: ACTION_TARGET_SOURCE.settings, shortcut: "e", paletteText: "Edit saved setting", terminalPath: "Settings editor" }),
	placement("settings.reset", { route: route("settings", "configuration"), targetSource: ACTION_TARGET_SOURCE.settings, shortcut: "x", paletteText: "Reset saved setting override", terminalPath: "Settings editor" }),
];

const REGISTRY = createActionPlacementRegistry(RAW_ACTION_PLACEMENTS);
export const ACTION_PLACEMENTS = REGISTRY.list();
export const actionPlacementFor = REGISTRY.get;
