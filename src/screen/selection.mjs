// Stable identity selection for screen collections.
//
// Views rebuild their item objects as deferred projections settle. This state model keeps selection by identity rather
// than object reference, falls back predictably when an item disappears, and leaves scrolling/rendering to the caller.
const identity = (item) => item?.key;

/**
 * A small synchronous selection state model shared by collections. Items with no identity are intentionally ignored:
 * headings and layout rows cannot become action targets by accident.
 */
export function createSelection({ keyOf = identity } = {}) {
	if (typeof keyOf !== "function") throw new TypeError("A selection model needs an identity reader.");
	let selected;
	const entries = (items) => (Array.isArray(items) ? items : []).flatMap((item) => {
		const key = keyOf(item);
		return key === undefined || key === null ? [] : [{ item, key }];
	});
	const locate = (items, key = selected) => entries(items).find((entry) => entry.key === key);
	const reconcile = (items) => {
		const list = entries(items);
		if (!list.some((entry) => entry.key === selected)) selected = list[0]?.key;
		return selected;
	};
	const select = (items, key) => {
		if (locate(items, key) === undefined) return false;
		selected = key;
		return true;
	};
	const move = (items, by = 0) => {
		const list = entries(items);
		if (list.length === 0) return false;
		const at = list.findIndex((entry) => entry.key === selected);
		const delta = Number.isFinite(by) ? Math.trunc(by) : 0;
		const next = Math.max(0, Math.min(list.length - 1, (at < 0 ? 0 : at) + delta));
		selected = list[next].key;
		return true;
	};
	const first = (items) => {
		selected = entries(items)[0]?.key;
		return selected;
	};
	const last = (items) => {
		selected = entries(items).at(-1)?.key;
		return selected;
	};
	return Object.freeze({
		key: () => selected,
		selected: (items) => locate(items)?.item,
		reconcile,
		select,
		move,
		first,
		last,
		clear: () => {
			const had = selected !== undefined;
			selected = undefined;
			return had;
		},
	});
}
