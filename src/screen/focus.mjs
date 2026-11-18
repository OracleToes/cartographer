// Focus ownership for the persistent screen shell.
//
// Components keep their own cursor/focus details. The shell only needs to remember which stable region should regain
// terminal focus after a modal, editor handoff, or other temporary interruption. This model has no rendering or TUI
// dependency and never lets a missing region replace the last known good focus.

/**
 * @param {{
 *   initial: string,
 *   resolve: (id: string) => object | undefined,
 *   apply: (target: object, id: string) => void,
 * }} given
 */
export function createFocusManager({ initial, resolve, apply } = {}) {
	if (typeof initial !== "string" || initial.trim() === "") throw new TypeError("A focus manager needs an initial region.");
	if (typeof resolve !== "function") throw new TypeError("A focus manager needs a region resolver.");
	if (typeof apply !== "function") throw new TypeError("A focus manager needs a focus applier.");
	let active = initial;

	const focus = (id) => {
		if (typeof id !== "string" || id.trim() === "") return false;
		let target;
		try { target = resolve(id); } catch { return false; }
		if (target === undefined || target === null) return false;
		try { apply(target, id); } catch { return false; }
		active = id;
		return true;
	};
	return Object.freeze({
		active: () => active,
		focus,
		restore: () => focus(active),
		is: (id) => active === id,
	});
}
