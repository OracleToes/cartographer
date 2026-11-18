// One registry for an action's label, safety level, and availability.
import { UI_CONFIRMATION } from "./contracts.mjs";

const requiredText = (value, name) => {
	if (typeof value !== "string" || value.trim() === "") throw new TypeError(`A capability needs a non-empty ${name}.`);
	return value.trim();
};

const availabilityOf = (capability, context) => {
	const raw = typeof capability.available === "function" ? capability.available(context) : capability.available;
	if (raw === undefined || raw === true) return { enabled: true };
	if (raw === false) return { enabled: false, reason: "This action is unavailable right now." };
	if (raw === null || typeof raw !== "object" || typeof raw.enabled !== "boolean") throw new TypeError(`Capability ${capability.id} returned an invalid availability state.`);
	return raw.enabled ? { enabled: true } : { enabled: false, reason: typeof raw.reason === "string" && raw.reason.trim() !== "" ? raw.reason.trim() : "This action is unavailable right now." };
};

const normalize = (definition) => {
	if (definition === null || typeof definition !== "object") throw new TypeError("A capability must be an object.");
	const id = requiredText(definition.id, "id");
	const label = requiredText(definition.label, "label");
	const category = requiredText(definition.category, "category");
	const confirmation = definition.confirmation ?? UI_CONFIRMATION.none;
	if (!Object.values(UI_CONFIRMATION).includes(confirmation)) throw new TypeError(`Capability ${id} has an unknown confirmation policy.`);
	return Object.freeze({ ...definition, id, label, category, confirmation });
};

const presentation = (capability, context) => {
	const { available, ...publicCapability } = capability;
	return { ...publicCapability, availability: availabilityOf(capability, context) };
};

/**
 * Keep capability metadata and runtime availability together without letting a feature invent a second action list.
 * @param {Array<{ id: string, label: string, category: string, available?: boolean | ((context: any) => boolean | { enabled: boolean, reason?: string }) }>} definitions
 */
export function createCapabilityRegistry(definitions) {
	if (!Array.isArray(definitions)) throw new TypeError("Capability definitions must be an array.");
	const byId = new Map();
	for (const definition of definitions) {
		const capability = normalize(definition);
		if (byId.has(capability.id)) throw new TypeError(`Capability ${capability.id} is declared twice.`);
		byId.set(capability.id, capability);
	}
	return Object.freeze({
		get: (id) => byId.get(id),
		availability: (id, context = {}) => {
			const capability = byId.get(id);
			return capability === undefined ? undefined : availabilityOf(capability, context);
		},
		list: (context = {}) => [...byId.values()].map((capability) => presentation(capability, context)),
	});
}
