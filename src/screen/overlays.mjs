// One modal owner for the full-screen shell.
//
// pi-tui provides focus-capturing overlays. This small adapter gives Cartographer one application modal at a time,
// so a delayed async action cannot stack a second form or confirmation above the first one. It deliberately owns no
// rendering or domain work; components receive only a close callback and retain their own synchronous input state.

const noop = () => {};

/**
 * @param {{
 *   show: (component: object, options?: object) => { hide?: () => void },
 *   restoreFocus?: () => void,
 *   redraw?: () => void,
 * }} given
 */
export function createOverlayManager({ show, restoreFocus = noop, redraw = noop } = {}) {
	if (typeof show !== "function") throw new TypeError("An overlay manager needs a show function.");
	let active;

	const close = (record) => {
		if (record === undefined || record.closed) return false;
		record.closed = true;
		if (active === record) active = undefined;
		try {
			record.handle?.hide?.();
		} catch {
			// A terminal may have gone away while an asynchronous action settles. The screen's state still closes.
		}
		try { restoreFocus(); } catch { /* Focus restoration cannot leave a stale modal active. */ }
		try { redraw(); } catch { /* A redraw request is best effort during shutdown. */ }
		return true;
	};

	/**
	 * Build and show one focus-capturing application modal. `undefined` means another application modal is already
	 * active; callers leave that modal alone rather than replacing a draft or confirmation unexpectedly.
	 */
	const open = (create, options = {}) => {
		if (active !== undefined) return undefined;
		if (typeof create !== "function") throw new TypeError("An overlay needs a component factory.");
		const record = { closed: false, component: undefined, handle: undefined };
		active = record;
		const dismiss = () => close(record);
		try {
			record.component = create(Object.freeze({ close: dismiss }));
			if (record.component === null || typeof record.component !== "object" || typeof record.component.render !== "function") throw new TypeError("An overlay factory must return a component.");
			record.handle = show(record.component, options);
		} catch (error) {
			if (active === record) active = undefined;
			throw error;
		}
		if (record.closed) {
			record.handle?.hide?.();
			return undefined;
		}
		return Object.freeze({
			component: record.component,
			close: dismiss,
			isOpen: () => active === record && !record.closed,
		});
	};

	return Object.freeze({
		open,
		dismiss: () => close(active),
		hasOpen: () => active !== undefined && !active.closed,
	});
}
