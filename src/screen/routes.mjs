// Navigation state for the persistent screen shell.
//
// A route is a stable tab plus its remembered subview. The manager owns the transitions while the caller keeps the
// state object it already exposes to its parts, so a route change can consistently cancel/refresh projections without
// making rendering or individual key handlers decide what navigation means.

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const registry = (items, kind, { required = true } = {}) => {
	if (!Array.isArray(items) || (required && items.length === 0)) throw new TypeError(`A route manager needs one or more ${kind}s.`);
	const byId = new Map();
	for (const item of items) {
		if (item === null || typeof item !== "object" || typeof item.id !== "string" || item.id.trim() === "") throw new TypeError(`Every ${kind} needs an id.`);
		if (byId.has(item.id)) throw new TypeError(`Route ${kind} ${item.id} is declared twice.`);
		byId.set(item.id, item);
	}
	return byId;
};

const wrapped = (items, current, by) => {
	if (items.length === 0 || !Number.isFinite(by)) return undefined;
	const at = items.findIndex((item) => item.id === current);
	const start = at < 0 ? 0 : at;
	const delta = Math.trunc(by);
	return items[((start + delta) % items.length + items.length) % items.length]?.id;
};

/**
 * @param {{
 *   tabs: { id: string }[],
 *   views?: Record<string, { id: string }[]>,
 *   state: { tab: string, view: Record<string, string | undefined> },
 *   onChange?: (change: { previous: { tab: string, view?: string, id: string }, current: { tab: string, view?: string, id: string }, changed: boolean }) => void,
 * }} given
 */
export function createRouteManager({ tabs, views = {}, state, onChange = () => {} } = {}) {
	const tabsById = registry(tabs, "tab");
	if (views === null || typeof views !== "object" || Array.isArray(views)) throw new TypeError("A route manager needs view definitions.");
	if (state === null || typeof state !== "object" || state.view === null || typeof state.view !== "object" || Array.isArray(state.view)) throw new TypeError("A route manager needs tab and view state.");
	if (typeof onChange !== "function") throw new TypeError("A route manager change callback must be a function.");
	for (const tab of Object.keys(views)) if (!tabsById.has(tab)) throw new TypeError(`Route views name unknown tab ${tab}.`);
	const viewsFor = new Map([...tabsById.keys()].map((tab) => [tab, Object.freeze([...(views[tab] ?? [])]) ]));
	for (const choices of viewsFor.values()) registry(choices, "view", { required: false });
	if (!tabsById.has(state.tab)) throw new TypeError(`Route state names unknown tab ${state.tab}.`);
	for (const [tab, choices] of viewsFor) {
		if (choices.length === 0) continue;
		if (state.view[tab] === undefined) state.view[tab] = choices[0].id;
		else if (!choices.some((view) => view.id === state.view[tab])) throw new TypeError(`Route state names unknown view ${state.view[tab]} for ${tab}.`);
	}

	const current = () => {
		const tab = state.tab;
		const view = (viewsFor.get(tab) ?? []).length === 0 ? undefined : state.view[tab];
		return Object.freeze({ tab, ...(view === undefined ? {} : { view }), id: view === undefined ? tab : `${tab}.${view}` });
	};
	const change = (tab, view, explicitView = false) => {
		if (!tabsById.has(tab)) return false;
		const choices = viewsFor.get(tab);
		if (explicitView && !choices.some((choice) => choice.id === view)) return false;
		if (!explicitView && choices.length > 0 && !choices.some((choice) => choice.id === state.view[tab])) return false;
		const previous = current();
		state.tab = tab;
		if (explicitView) state.view[tab] = view;
		const next = current();
		onChange(Object.freeze({ previous, current: next, changed: previous.id !== next.id }));
		return true;
	};
	const setTab = (tab) => change(tab);
	const setView = (view) => change(state.tab, view, true);
	const setRoute = (route) => {
		if (route === null || typeof route !== "object" || typeof route.tab !== "string") return false;
		return change(route.tab, route.view, has(route, "view"));
	};

	return Object.freeze({
		current,
		id: () => current().id,
		views: (tab = state.tab) => [...(viewsFor.get(tab) ?? [])],
		setTab,
		setView,
		setRoute,
		stepTab: (by) => {
			const tab = wrapped(tabs, state.tab, by);
			return tab === undefined ? false : setTab(tab);
		},
		stepView: (by) => {
			const choices = viewsFor.get(state.tab) ?? [];
			const view = wrapped(choices, state.view[state.tab], by);
			return view === undefined ? false : setView(view);
		},
	});
}
