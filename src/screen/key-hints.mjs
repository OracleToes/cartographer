// Contextual footer hints for the persistent screen shell.
//
// The shell supplies its route-specific key meanings; capability presentation supplies the enabled/disabled facts.
// Keeping those inputs separate lets a footer describe only actions that are actually registered and currently
// available, without asking live managers from a render.

const text = (value) => typeof value === "string" ? value.trim() : "";

const capabilityIds = (hint) => {
	const listed = hint.capabilities ?? (hint.capability === undefined ? [] : [hint.capability]);
	if (!Array.isArray(listed) || listed.some((id) => text(id) === "")) throw new TypeError("A key hint capability needs a non-empty id.");
	return Object.freeze([...new Set(listed.map(text))]);
};

const hint = (value) => {
	if (typeof value === "string") {
		const label = text(value);
		if (label === "") throw new TypeError("A key hint needs text.");
		return Object.freeze({ text: label, capabilities: Object.freeze([]) });
	}
	if (value === null || typeof value !== "object") throw new TypeError("A key hint needs text.");
	const label = text(value.text);
	if (label === "") throw new TypeError("A key hint needs text.");
	if (value.when !== undefined && typeof value.when !== "function") throw new TypeError("A key hint condition must be a function.");
	return Object.freeze({ text: label, capabilities: capabilityIds(value), ...(value.when === undefined ? {} : { when: value.when }) });
};

const hints = (value, label) => {
	if (!Array.isArray(value)) throw new TypeError(`Key hints need ${label}.`);
	return Object.freeze(value.map(hint));
};

const availability = (capabilities) => {
	if (capabilities === undefined) return undefined;
	if (!Array.isArray(capabilities)) throw new TypeError("Key hints need capability presentation as an array.");
	const byId = new Map();
	for (const capability of capabilities) {
		const id = text(capability?.id);
		if (id === "") throw new TypeError("A presented capability needs an id.");
		byId.set(id, capability?.availability?.enabled !== false);
	}
	return byId;
};

/**
 * Compose route-local and shell-global footer hints. A hint may name one `capability`, an any-of `capabilities`
 * list, and/or a local `when(context)` predicate. With no capability presentation supplied, the configured hints
 * remain visible so isolated component rendering can still use this model.
 */
export function createKeyHints({ typing, fallback = [], global = [], routes = {} } = {}) {
	const typingText = text(typing);
	if (typingText === "") throw new TypeError("Key hints need typing-mode text.");
	if (routes === null || typeof routes !== "object" || Array.isArray(routes)) throw new TypeError("Key hints need route definitions.");
	const routeHints = new Map();
	for (const [route, values] of Object.entries(routes)) {
		const id = text(route);
		if (id === "") throw new TypeError("A key-hint route needs an id.");
		if (routeHints.has(id)) throw new TypeError(`Key-hint route ${id} is declared twice.`);
		routeHints.set(id, hints(values, `hints for ${id}`));
	}
	const fallbackHints = hints(fallback, "fallback hints");
	const globalHints = hints(global, "global hints");
	const visible = (entry, presented, context) => {
		if (entry.when !== undefined && !entry.when(context)) return false;
		if (entry.capabilities.length === 0 || presented === undefined) return true;
		return entry.capabilities.some((id) => presented.get(id) === true);
	};
	return Object.freeze({
		text: ({ mode = "command", route, capabilities, context } = {}) => {
			if (mode === "type") return typingText;
			const presented = availability(capabilities);
			const local = routeHints.get(text(route)) ?? fallbackHints;
			return [...local, ...globalHints].filter((entry) => visible(entry, presented, context)).map((entry) => entry.text).join(" · ");
		},
	});
}
