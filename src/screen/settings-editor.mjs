// Settings Configuration is a projection over the application's saved-source provenance. This module owns only
// presentation and form-ready values: it never imports a configuration file, environment, command line, or session
// manager. The Screen supplies a settled Settings snapshot and sends every write through settings.edit/settings.reset.

export const SETTINGS_SCOPE = Object.freeze({
	project: "project",
	install: "install",
});

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const valueText = (value) => {
	if (value === undefined) return "not configured";
	if (typeof value === "boolean") return value ? "on" : "off";
	if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
	return String(value);
};
const editorValue = (value) => Array.isArray(value) ? value.join("\n") : typeof value === "boolean" ? String(value) : value === undefined ? "" : String(value);
const layerName = (layer) => ({
	default: "built-in defaults",
	install: "install configuration",
	project: "project configuration",
	environment: "environment",
	"command-line": "command line",
})[layer] ?? "an unknown source";
const applyName = (apply) => ({
	"live-screen": "after the Screen refreshes",
	"next-request": "for the next request",
	reconnect: "after the provider reconnects",
	"next-session": "when Cartographer next starts",
})[apply] ?? "when its owner next reads configuration";

const sourceFor = (configuration, scope) => {
	const layer = Array.isArray(configuration?.layers) ? configuration.layers.find((entry) => entry?.layer === scope) : undefined;
	const revision = text(layer?.revision) ?? text(configuration?.revisions?.[scope]);
	return {
		scope,
		label: layerName(scope),
		...(typeof layer?.path === "string" && layer.path !== "" ? { path: layer.path } : {}),
		writable: layer?.writable === true,
		...(revision === undefined ? {} : { revision }),
	};
};

const contributionFor = (row, scope) => Array.isArray(row?.contributors) ? row.contributors.find((entry) => entry?.layer === scope) : undefined;
const sourceLine = (source) => {
	if (!record(source)) return "Current source: unavailable.";
	const path = text(source.path);
	return `Current source: ${layerName(source.layer)}${path === undefined ? "" : ` · ${path}`}.`;
};
const targetLine = (target) => {
	const path = text(target.path);
	if (target.writable !== true) return `Save target: ${target.label}${path === undefined ? "" : ` · ${path}`} · read-only.`;
	return `Save target: ${target.label}${path === undefined ? "" : ` · ${path}`} · writable.`;
};
const validationLine = (validation = {}) => {
	const kind = validation.kind;
	if (kind === "boolean") return "Value: true or false.";
	if (kind === "integer") return `Value: a whole number${validation.min === undefined ? "" : `, ${validation.min} or more`}${validation.max === undefined ? "" : `, up to ${validation.max}`}.`;
	if (kind === "number") return `Value: a number${validation.min === undefined ? "" : `, ${validation.min} or more`}.`;
	if (kind === "choice") return `Value: one of ${(validation.choices ?? []).map((choice) => JSON.stringify(choice)).join(", ")}.`;
	if (kind === "path-list") return "Value: one absolute or ~/ folder per line.";
	if (kind === "text" && validation.maxLength !== undefined) return `Value: one line, at most ${validation.maxLength} characters.`;
	return "Value: text.";
};
const riskLine = (row) => row?.risk === "guarded"
	? "Guarded: Cartographer asks for a typed confirmation when this change expands future shell access or weakens a saved safety default."
	: "Normal: the saved source is revalidated before it is written.";

/** The two persisted sources, as the settled Settings projection says they stand. */
export function settingsSources(settings) {
	const configuration = settings?.configuration;
	return [SETTINGS_SCOPE.project, SETTINGS_SCOPE.install].map((scope) => Object.freeze(sourceFor(configuration, scope)));
}

/** Select the next explicitly writable persistence target; defaulting never silently switches project to install. */
export function nextWritableSettingsScope(settings, current = SETTINGS_SCOPE.project) {
	const writable = settingsSources(settings).filter((source) => source.writable === true);
	if (writable.length === 0) return undefined;
	const at = writable.findIndex((source) => source.scope === current);
	return writable[(at + 1 + writable.length) % writable.length].scope;
}

/** One selected setting plus its explicit save target; this is the only form/action context the Screen needs. */
export function settingsWriteTarget(settings, row, scope = SETTINGS_SCOPE.project) {
	if (!record(row) || typeof row.key !== "string" || row.key === "") throw new TypeError("A Settings write target needs one known configuration row.");
	const target = sourceFor(settings?.configuration, scope);
	const saved = contributionFor(row, scope);
	return Object.freeze({
		key: row.key,
		scope,
		label: row.label ?? row.key,
		writable: target.writable,
		...(target.path === undefined ? {} : { path: target.path }),
		...(target.revision === undefined ? {} : { expectedRevision: target.revision }),
		hasOverride: saved !== undefined,
		shadowed: saved !== undefined && row.source?.layer !== scope,
		value: saved === undefined ? row.effectiveValue : saved.value,
	});
}

/** A Form field derived only from the settled schema detail attached to a Settings row. */
export function settingsEditorField(row, target) {
	if (!record(row) || typeof row.key !== "string" || row.key === "") throw new TypeError("A Settings editor field needs one configuration row.");
	const validation = record(row.validation) ? row.validation : {};
	const kind = validation.kind;
	const value = target?.value ?? row.effectiveValue;
	const help = [
		validationLine(validation),
		`Saved changes take effect ${applyName(row.apply)}.`,
		...(row.risk === "guarded" ? ["This setting may need typed confirmation before it is saved."] : []),
	].join(" ");
	return Object.freeze({
		id: "value",
		label: row.label ?? row.key,
		limit: Number.isInteger(validation.maxLength) ? Math.max(1, validation.maxLength) : kind === "path-list" ? 8_192 : 4_096,
		multiline: kind === "path-list",
		value: editorValue(value),
		help,
	});
}

/**
 * The compact Configuration collection. Enter opens each row's provenance inspector, which keeps identity, value,
 * source, and timing visible before longer explanatory text; the Screen owns editing/reset keys around this model.
 */
export function settingsConfigurationView({ settings, scope = SETTINGS_SCOPE.project } = {}) {
	const configuration = settings?.configuration;
	const rows = Array.isArray(configuration?.rows) ? configuration.rows.filter((row) => record(row) && typeof row.key === "string" && row.key !== "") : [];
	const target = sourceFor(configuration, scope);
	const header = [
		[["Configuration", "bold"], [`  · save target: ${target.label}${target.writable === true ? "" : " (read-only)"}`, target.writable === true ? "muted" : "warn"]],
		[["Every known saved setting is listed with its effective value and source. Environment and command-line values are shown but are not writable here.", "muted"]],
	];
	if (rows.length === 0) return {
		header,
		items: [{
			key: "configuration:unavailable",
			plain: true,
			head: [["  Configuration provenance is unavailable. Refresh Settings after its saved sources can be read.", "warn"]],
		}],
	};
	return {
		header,
		items: rows.map((row) => {
			const write = settingsWriteTarget(settings, row, scope);
			const source = record(row.source) ? row.source : {};
			const saved = contributionFor(row, scope);
			const sourceState = source.layer === scope ? "" : `  · ${layerName(source.layer)}`;
			const body = [
				`Effective value: ${row.displayValue ?? valueText(row.effectiveValue)}.`,
				sourceLine(source),
				targetLine(target),
				saved === undefined
					? `No ${target.label} override is saved for this setting.`
					: write.shadowed
						? `A ${target.label} override is saved (${valueText(saved.value)}), but ${layerName(source.layer)} currently overrides it.`
						: `This ${target.label} override is effective now.`,
				`Applies ${applyName(row.apply)}.`,
				riskLine(row),
				validationLine(row.validation),
				"Enter or e edits this source · x resets this source override · s chooses a writable source.",
			].join("\n");
			return {
				key: `setting:${row.key}`,
				head: [[`${row.label ?? row.key}  `, "bold"], [row.displayValue ?? valueText(row.effectiveValue), ""], [sourceState, source.layer === "environment" || source.layer === "command-line" ? "warn" : "muted"]],
				body,
				copy: `${row.label ?? row.key}: ${row.displayValue ?? valueText(row.effectiveValue)}\n${body}`,
				setting: Object.freeze({ row, write }),
			};
		}),
	};
}
