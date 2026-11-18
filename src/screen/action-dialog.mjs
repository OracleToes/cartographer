// Generic schema-derived action form.
//
// The dialog owns only local field affordances. It turns a spec's drafts into action input and delegates execution to
// its caller, so domain validation, confirmation, revision checks, and mutation remain behind application.execute.
import { actionInputFromDrafts } from "./action-launcher.mjs";
import { Form } from "./parts.mjs";

const text = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const fieldsForForm = (fields) => fields.map((field) => ({
	id: field.id,
	label: field.label,
	limit: field.limit,
	multiline: field.multiline,
	required: field.required,
	...(field.help === undefined ? {} : { help: field.help }),
}));

/** A Form whose fields and draft coercion come from one pure application action specification. */
export class ActionDialog extends Form {
	/**
	 * @param {{
	 *   actionId: string,
	 *   title?: string,
	 *   fields: object[],
	 *   input?: object,
	 *   keyOf: (data: string) => string | undefined,
	 *   close: () => void,
	 *   flash: (text: string) => void,
	 *   redraw?: () => void,
	 *   submit: (input: object) => boolean | Promise<boolean>,
	 *   cancel?: () => void,
	 * }} given
	 */
	constructor(given) {
		if (!record(given)) throw new TypeError("An action dialog needs its options.");
		const actionId = text(given.actionId);
		if (actionId === undefined) throw new TypeError("An action dialog needs an action id.");
		if (!Array.isArray(given.fields)) throw new TypeError("An action dialog needs fields.");
		if (given.fields.length === 0) throw new TypeError("An action dialog needs at least one field.");
		if (given.input !== undefined && !record(given.input)) throw new TypeError("An action dialog input must be an object.");
		if (typeof given.submit !== "function") throw new TypeError("An action dialog needs a submit callback.");
		const check = (drafts) => actionInputFromDrafts(given.fields, drafts);
		super({
			title: text(given.title) ?? "Action",
			fields: fieldsForForm(given.fields),
			keyOf: given.keyOf,
			close: given.close,
			flash: given.flash,
			redraw: given.redraw,
			validate: (drafts) => {
				const outcome = check(drafts);
				return outcome.ok ? undefined : { field: outcome.field, message: outcome.message };
			},
			save: (drafts) => {
				const outcome = check(drafts);
				if (!outcome.ok) {
					given.flash(outcome.message);
					return false;
				}
				return given.submit({ ...(given.input ?? {}), ...outcome.input });
			},
		});
		this.actionId = actionId;
		this.cancel = typeof given.cancel === "function" ? given.cancel : () => {};
	}
	handleInput(data) {
		// Form closes for both a successful save and Escape. Only the explicit Escape path abandons the launch; a
		// successful save remains available for ActionLauncher to present or to replace with confirmation.
		if (!this.saving && this.given.keyOf(data) === "escape") {
			this.cancel();
			return void this.given.close();
		}
		return super.handleInput(data);
	}
}
