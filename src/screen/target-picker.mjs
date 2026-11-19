// A settled-projection target chooser for action launch.
//
// It receives immutable target candidates from Screen composition and never imports a manager or starts a query. A
// target that disappeared is therefore shown as unavailable or asks the caller to refresh instead of being resolved
// again from live state.
import { normalizeActionTargets } from "./action-launcher.mjs";
import { cut, paint, wrap } from "./text.mjs";
import { TOKEN } from "./tokens.mjs";

const isPromise = (value) => value !== null && typeof value === "object" && typeof value.then === "function";

export class TargetPicker {
	/**
	 * @param {{
	 *   title?: string,
	 *   targets: object[],
	 *   keyOf: (data: string) => string | undefined,
	 *   choose: (target: object) => boolean | Promise<boolean>,
	 *   close: () => void,
	 *   flash: (text: string) => void,
	 *   redraw?: () => void,
	 *   cancel?: () => void,
	 * }} given
	 */
	constructor(given) {
		if (given === null || typeof given !== "object") throw new TypeError("A target picker needs its options.");
		if (typeof given.keyOf !== "function") throw new TypeError("A target picker needs a key reader.");
		if (typeof given.choose !== "function") throw new TypeError("A target picker needs a choose callback.");
		if (typeof given.close !== "function") throw new TypeError("A target picker needs a close callback.");
		if (typeof given.flash !== "function") throw new TypeError("A target picker needs a feedback callback.");
		this.given = given;
		this.capturesViewportInput = true;
		this.targets = normalizeActionTargets(given.targets);
		this.index = 0;
		this.pending = false;
		this.cancel = typeof given.cancel === "function" ? given.cancel : () => {};
	}
	invalidate() {}
	selected() {
		this.index = Math.max(0, Math.min(this.targets.length - 1, this.index));
		return this.targets[this.index];
	}
	move(by) {
		if (this.targets.length === 0) return;
		this.index = Math.max(0, Math.min(this.targets.length - 1, this.index + by));
	}
	choose() {
		if (this.pending) return void this.given.flash("that action is still finishing");
		const target = this.selected();
		if (target === undefined) return void this.given.flash("no current target is available; refresh and try again");
		if (target.disabled) return void this.given.flash(target.disabledReason);
		let outcome;
		try {
			outcome = this.given.choose(target);
		} catch (error) {
			this.given.flash(`could not open that target: ${error?.message ?? error}`);
			return;
		}
		if (!isPromise(outcome)) {
			if (outcome) this.given.close();
			return;
		}
		this.pending = true;
		this.given.redraw?.();
		void Promise.resolve(outcome)
			.then((opened) => {
				if (opened) this.given.close();
			})
			.catch((error) => this.given.flash(`could not open that target: ${error?.message ?? error}`))
			.finally(() => {
				this.pending = false;
				this.given.redraw?.();
			});
	}
	handleInput(data) {
		const key = this.given.keyOf(data);
		if (this.pending) return void this.given.flash(key === "escape" ? "that action is still finishing" : "opening…");
		if (key === "escape") {
			this.cancel();
			return void this.given.close();
		}
		if (key === "enter") return void this.choose();
		if (key === "up" || key === "k" || key === "ctrl+p") return void this.move(-1);
		if (key === "down" || key === "j" || key === "ctrl+n") return void this.move(1);
		if (key === "home") {
			this.index = 0;
			return;
		}
		if (key === "end") {
			this.index = Math.max(0, this.targets.length - 1);
			return;
		}
		if (key === "pageUp") return void this.move(-6);
		if (key === "pageDown") return void this.move(6);
	}
	handleMouse() {
		return { handled: true };
	}
	footer() {
		return this.pending ? "Opening… the target stays here until Cartographer replies" : "↑ ↓ move · Enter choose · Esc cancel";
	}
	render(width) {
		const inner = Math.max(10, width - 6);
		const row = (spans, selected = false) => paint([["   ", ""], ...spans], width, selected ? TOKEN.interaction.selected : TOKEN.surface.overlay);
		const title = this.given.title ?? "Choose target";
		const rows = [
			paint([], width, TOKEN.surface.overlay),
			row([[` ${title}`, `${TOKEN.text.primary} ${TOKEN.emphasis.strong}`]]),
			row([[" Choose from the settled view", TOKEN.text.muted]]),
			paint([], width, TOKEN.surface.overlay),
		];
		if (this.targets.length === 0) rows.push(row([[" No current target is available. Refresh and try again.", TOKEN.feedback.warning]]));
		else {
			const start = Math.max(0, Math.min(this.targets.length - 8, this.index - 4));
			const visible = this.targets.slice(start, start + 8);
			for (const [offset, target] of visible.entries()) {
				const index = start + offset;
				const selected = index === this.index;
				const prefix = selected ? "› " : "  ";
				const label = cut(target.label, Math.max(8, inner - 18));
				const suffix = target.disabled ? " unavailable" : "";
				rows.push(row([[prefix, target.disabled ? TOKEN.text.muted : TOKEN.text.primary], [label, target.disabled ? TOKEN.text.muted : TOKEN.text.primary], [suffix, target.disabled ? TOKEN.feedback.warning : TOKEN.text.muted]], selected));
			}
			if (visible.length < this.targets.length) rows.push(row([[` … ${this.targets.length - visible.length} more`, TOKEN.text.muted]]));
			const selected = this.selected();
			const detail = selected?.disabled ? selected.disabledReason : selected?.detail;
			if (detail !== undefined && detail !== "") {
				rows.push(paint([], width, TOKEN.surface.overlay));
				for (const line of wrap(detail, inner - 2).slice(0, 2)) rows.push(row([[` ${line}`, selected?.disabled ? TOKEN.feedback.warning : TOKEN.text.secondary]]));
			}
		}
		rows.push(paint([], width, TOKEN.surface.overlay));
		rows.push(row([[this.footer(), this.pending ? TOKEN.interaction.loading : TOKEN.text.muted]]));
		rows.push(paint([], width, TOKEN.surface.overlay));
		return rows;
	}
}
