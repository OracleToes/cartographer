// A keyboard-safe acknowledgement dialog for a typed application confirmation request.
//
// The application owns whether an action needs confirmation and validates the action/target again when it executes.
// This component only makes that request legible, keeps focus inside its overlay, and prevents duplicate submits while
// the asynchronous acknowledgement is settling.
import { paint, wrap } from "./text.mjs";
import { TOKEN } from "./tokens.mjs";

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const withoutLast = (text) => {
	let at = 0;
	for (const part of SEGMENTER.segment(text)) at = part.index;
	return text.slice(0, at);
};
const isPromise = (value) => value !== null && typeof value === "object" && typeof value.then === "function";

/**
 * A standard destructive-action confirmation. Acknowledgement accepts Enter or y. A typed confirmation requires
 * the exact target (or an explicit `phrase`) before it will execute.
 */
export class ConfirmDialog {
	/**
	 * @param {{
	 *   title?: string,
	 *   confirmation: { actionId: string, target: string, summary: string, strength?: "acknowledge" | "typed" },
	 *   keyOf: (data: string) => string | undefined,
	 *   close: () => void,
	 *   confirm: () => boolean | Promise<boolean>,
	 *   flash: (text: string) => void,
	 *   redraw?: () => void,
	 *   phrase?: string,
	 * }} given
	 */
	constructor(given) {
		this.given = given;
		this.capturesViewportInput = true;
		this.pending = false;
		this.typed = "";
		this.expected = String(given.phrase ?? given.confirmation.target ?? "");
	}
	get typedRequired() {
		return this.given.confirmation.strength === "typed";
	}
	invalidate() {}
	confirm() {
		if (this.pending) return void this.given.flash("confirmation is still finishing");
		if (this.typedRequired && this.typed !== this.expected) return void this.given.flash(`type ${this.expected} exactly before confirming`);
		let outcome;
		try {
			outcome = this.given.confirm();
		} catch (error) {
			this.given.flash(`could not confirm: ${error?.message ?? error}`);
			return;
		}
		if (!isPromise(outcome)) {
			if (outcome) this.given.close();
			return;
		}
		this.pending = true;
		this.given.redraw?.();
		void Promise.resolve(outcome)
			.then((didConfirm) => {
				if (didConfirm) this.given.close();
			})
			.catch((error) => this.given.flash(`could not confirm: ${error?.message ?? error}`))
			.finally(() => {
				this.pending = false;
				this.given.redraw?.();
			});
	}
	insert(key) {
		if (typeof key !== "string" || [...key].length !== 1 || key < " " || key === "\x7f") return;
		this.typed += key;
	}
	handleInput(data) {
		const key = this.given.keyOf(data);
		if (this.pending) return void this.given.flash(key === "escape" ? "confirmation is still finishing" : "confirming…");
		if (key === "escape" || (!this.typedRequired && key === "n")) return void this.given.close();
		if (this.typedRequired) {
			if (key === "backspace" || key === "delete") {
				this.typed = withoutLast(this.typed);
				return;
			}
			if (key === "enter") return void this.confirm();
			return void this.insert(key);
		}
		if (key === "enter" || key === "y") return void this.confirm();
	}
	handleMouse() {
		return { handled: true };
	}
	footer() {
		if (this.pending) return "Confirming… the action stays open until Cartographer replies";
		if (this.typedRequired) return `Type ${this.expected} · Enter confirm · Esc cancel`;
		return "Enter or y confirm · Esc or n cancel";
	}
	render(width) {
		const inner = Math.max(10, width - 6);
		const row = (spans) => paint([["   ", ""], ...spans], width, TOKEN.surface.overlay);
		const confirmation = this.given.confirmation;
		const title = this.given.title ?? "Confirm action";
		const target = `Target · ${confirmation.target}`;
		const summary = wrap(confirmation.summary, inner - 2);
		const rows = [
			paint([], width, TOKEN.surface.overlay),
			row([[` ${title}`, `${TOKEN.feedback.warning} ${TOKEN.emphasis.strong}`]]),
			row([[` ${confirmation.actionId}`, TOKEN.text.secondary], [" · ", TOKEN.text.muted], [target, TOKEN.text.primary]]),
			paint([], width, TOKEN.surface.overlay),
			...summary.map((line) => row([[` ${line}`, TOKEN.text.primary]])),
		];
		if (this.typedRequired) {
			rows.push(paint([], width, TOKEN.surface.overlay));
			rows.push(row([[` Type ${this.expected} to confirm`, TOKEN.text.secondary]]));
			rows.push(row([[` › ${this.typed || " "}`, this.typed === this.expected ? TOKEN.feedback.success : TOKEN.text.primary]]));
		}
		rows.push(paint([], width, TOKEN.surface.overlay));
		rows.push(row([[this.footer(), this.pending ? TOKEN.interaction.loading : TOKEN.text.muted]]));
		rows.push(paint([], width, TOKEN.surface.overlay));
		return rows;
	}
}
