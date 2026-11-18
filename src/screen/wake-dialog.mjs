// Complete wake-trigger form for the Runtime action boundary.
//
// Wakes change shape by trigger kind, but this component owns only local drafts and affordances. It receives an
// already-settled target/suggestion snapshot and delegates the complete replacement or creation request to the
// ActionLauncher callback; the Runtime action and wake manager remain authoritative.
import { POLICY } from "../config.mjs";
import { EVERY_MAX, NOTE_MAX, WAKE_MIN } from "../wakes.mjs";
import { Form } from "./parts.mjs";

const text = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const whole = (value) => /^\d+$/.test(String(value ?? "").trim()) ? Number(String(value).trim()) : undefined;
const KINDS = Object.freeze([POLICY.enums.wakeKinds.time, POLICY.enums.wakeKinds.file, POLICY.enums.wakeKinds.window]);
const knownKind = (value) => KINDS.includes(String(value ?? "").trim().toLowerCase()) ? String(value).trim().toLowerCase() : undefined;

/** Convert local drafts to the complete action input expected by runtime.wake.create/replace. */
export function wakeInputFromDrafts(drafts) {
	if (!(drafts instanceof Map)) throw new TypeError("Wake input needs form drafts.");
	const kind = knownKind(drafts.get("kind"));
	if (kind === undefined) return { ok: false, field: "kind", message: "Trigger kind must be time, file, or window." };
	const note = text(drafts.get("note"));
	if (note === undefined) return { ok: false, field: "note", message: "A wake needs a note for the agent." };
	const every = whole(drafts.get("every"));
	if (every === undefined) return { ok: false, field: "every", message: "Cadence must be a whole number of seconds." };
	const times = whole(drafts.get("times"));
	if (times === undefined) return { ok: false, field: "times", message: "Repetitions must be zero or a positive whole number." };
	if (kind === POLICY.enums.wakeKinds.file) {
		const path = text(drafts.get("path"));
		if (path === undefined) return { ok: false, field: "path", message: "Choose a project file or folder for this wake." };
		return { ok: true, input: { kind, note, every, times, path } };
	}
	if (kind === POLICY.enums.wakeKinds.window) {
		const window = text(drafts.get("window"));
		if (window === undefined) return { ok: false, field: "window", message: "Choose a shell window for this wake." };
		const match = text(drafts.get("match"));
		return { ok: true, input: { kind, note, every, times, window, ...(match === undefined ? {} : { match }) } };
	}
	return { ok: true, input: { kind, note, every, times } };
}

const fields = ({ input = {}, windowSuggestions = [] } = {}) => {
	const kind = knownKind(input.kind) ?? POLICY.enums.wakeKinds.time;
	const suggestions = windowSuggestions.length === 0 ? "Settled Shells names are suggested when available; validation remains with the scheduler." : `Settled Shells names: ${windowSuggestions.join(", ")}. You may enter another name; the scheduler remains authoritative.`;
	return [
		{ id: "kind", label: "Trigger kind", value: kind, required: true, limit: 6, help: "time, file, or window. Tab moves through only the fields used by that trigger." },
		{ id: "note", label: "Agent note", value: typeof input.note === "string" ? input.note : "", required: true, multiline: true, limit: NOTE_MAX, help: "Say what the agent should inspect or do when this wake fires." },
		{ id: "every", label: "Cadence seconds", value: Number.isInteger(input.every) ? String(input.every) : String(WAKE_MIN), required: true, limit: 10, help: `Whole seconds, from the configured minimum through ${EVERY_MAX}.` },
		{ id: "times", label: "Repetitions", value: Number.isInteger(input.times) ? String(input.times) : String(POLICY.limits.wake.timesDefault), required: true, limit: 10, help: "0 repeats until removed; otherwise this many firings are scheduled." },
		{ id: "path", label: "Project file or folder", value: typeof input.path === "string" ? input.path : "", required: true, limit: 4_096, help: "File wakes watch only paths inside this project; .brain is excluded." },
		{ id: "window", label: "Shell window", value: typeof input.window === "string" ? input.window : "", required: true, limit: 240, help: suggestions },
		{ id: "match", label: "Line contains", value: typeof input.match === "string" ? input.match : "", limit: 1_024, help: "Optional: fire only after output contains this text." },
	];
};

/**
 * A small dynamic form: kind drives which trigger-specific fields can be edited. Every save still sends a complete
 * trigger, so a replacement cannot retain schedule/history state or quietly patch an old trigger.
 */
export class WakeDialog extends Form {
	/**
	 * @param {{ title?: string, input?: object, windowSuggestions?: string[], keyOf: Function, close: Function,
	 *   flash: Function, redraw?: Function, submit: (input: object) => boolean | Promise<boolean>, cancel?: Function }} given
	 */
	constructor(given = {}) {
		if (typeof given.submit !== "function") throw new TypeError("A wake dialog needs a submit callback.");
		super({
			title: typeof given.title === "string" && given.title.trim() !== "" ? given.title.trim() : "Wake trigger",
			fields: fields(given),
			keyOf: given.keyOf,
			close: given.close,
			flash: given.flash,
			redraw: given.redraw,
			validate: (drafts) => {
				const outcome = wakeInputFromDrafts(drafts);
				return outcome.ok ? undefined : { field: outcome.field, message: outcome.message };
			},
			save: (drafts) => {
				const outcome = wakeInputFromDrafts(drafts);
				if (!outcome.ok) {
					given.flash(outcome.message);
					return false;
				}
				// Keep only the durable selected id across a replacement. Trigger fields are complete fresh input, never
				// stale values from a prior kind (for example a former file path on a new time wake).
				return given.submit({ ...(typeof given.input?.id === "string" && given.input.id !== "" ? { id: given.input.id } : {}), ...outcome.input });
			},
		});
		this.cancel = typeof given.cancel === "function" ? given.cancel : () => {};
		this.syncKind();
	}
	syncKind() {
		const kind = knownKind(this.drafts[0]);
		const field = (id) => this.given.fields.find((entry) => entry.id === id);
		const enabled = (id, when) => {
			const entry = field(id);
			if (entry === undefined) return;
			entry.disabled = !when;
			if (!when) this.errors.delete(id);
		};
		enabled("path", kind === POLICY.enums.wakeKinds.file);
		enabled("window", kind === POLICY.enums.wakeKinds.window);
		enabled("match", kind === POLICY.enums.wakeKinds.window);
	}
	handleInput(data) {
		if (!this.saving && this.given.keyOf(data) === "escape") {
			this.cancel();
			return void this.given.close();
		}
		super.handleInput(data);
		this.syncKind();
		this.given.redraw?.();
	}
}
