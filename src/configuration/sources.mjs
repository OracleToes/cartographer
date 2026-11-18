// Configuration source precedence and safe provenance facts.
//
// Source resolution is kept apart from file I/O so startup can keep its synchronous launch path while the
// application Settings reader can acquire the same facts asynchronously through the repository.
import { join } from "node:path";

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => Array.isArray(value) ? value.map(clone) : record(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
const freeze = (value) => Object.freeze(value);

export const CONFIGURATION_SOURCE = freeze({
	defaults: "default",
	install: "install",
	project: "project",
	environment: "environment",
	commandLine: "command-line",
});

const source = (layer, values, { path, writable = false } = {}) => freeze({
	layer,
	values: record(values) ? values : {},
	...(typeof path === "string" && path !== "" ? { path } : {}),
	writable: writable === true,
});

/** The two JSON source paths are deterministic from the installation, brain, and CARTO_CONFIG override. */
export function configurationPaths({ coreDir, brainDir, env = process.env } = {}) {
	if (typeof coreDir !== "string" || coreDir === "") throw new TypeError("Configuration source paths need the core directory.");
	if (typeof brainDir !== "string" || brainDir === "") throw new TypeError("Configuration source paths need the brain directory.");
	return freeze({
		install: env?.CARTO_CONFIG ? env.CARTO_CONFIG : join(coreDir, "config.json"),
		project: join(brainDir, "config.json"),
	});
}

/** Only the three documented environment values participate in effective settings. */
export function environmentSettings(env = process.env) {
	return freeze({
		...(env?.CARTO_SERVER ? { server: env.CARTO_SERVER } : {}),
		...(env?.CARTO_MODEL ? { model: env.CARTO_MODEL } : {}),
		...(env?.CARTO_USER !== undefined && env.CARTO_USER !== "" ? { user: env.CARTO_USER } : {}),
	});
}

/** Only --url and --model are configuration overrides; other CLI flags are session/lifecycle choices. */
export function commandLineSettings(flags = {}) {
	return freeze({
		...(flags?.url ? { server: flags.url } : {}),
		...(flags?.model ? { model: flags.model } : {}),
	});
}

const contribution = (entry, value, details = {}, overriddenBy) => freeze({
	layer: entry.layer,
	...(entry.path === undefined ? {} : { path: entry.path }),
	writable: entry.writable === true,
	...(details.revision === undefined ? {} : { revision: details.revision }),
	value: clone(value),
	...(overriddenBy === undefined ? {} : { overriddenBy }),
});

const sourceSummary = (entry, details = {}) => freeze({
	layer: entry.layer,
	...(entry.path === undefined ? {} : { path: entry.path }),
	writable: entry.writable === true,
	...(details.revision === undefined ? {} : { revision: details.revision }),
});

/**
 * Resolve known setting provenance while retaining unknown source fields in `config` for launch compatibility.
 * The `entries` array is intentionally limited to known defaults; arbitrary JSON keys do not become Settings rows.
 */
export function resolveConfigurationSources({ defaults, install = {}, project = {}, env = process.env, flags = {}, paths = {}, sourceDetails = {} } = {}) {
	if (!record(defaults)) throw new TypeError("Configuration resolution needs default settings.");
	const known = Object.keys(defaults);
	const layers = freeze([
		source(CONFIGURATION_SOURCE.defaults, defaults),
		source(CONFIGURATION_SOURCE.install, install, { path: paths.install, writable: sourceDetails.install?.writable === true }),
		source(CONFIGURATION_SOURCE.project, project, { path: paths.project, writable: sourceDetails.project?.writable === true }),
		source(CONFIGURATION_SOURCE.environment, environmentSettings(env)),
		source(CONFIGURATION_SOURCE.commandLine, commandLineSettings(flags)),
	]);
	const config = {
		...clone(defaults),
		shellRead: Array.isArray(defaults.shellRead) ? [...defaults.shellRead] : defaults.shellRead,
		...clone(record(install) ? install : {}),
		...clone(record(project) ? project : {}),
		...environmentSettings(env),
		...commandLineSettings(flags),
	};
	const entries = known.map((key) => {
		const rawContributors = layers.flatMap((entry) => own(entry.values, key) ? [{ entry, value: entry.values[key] }] : []);
		const contributors = freeze(rawContributors.map(({ entry, value }, index) => contribution(
			entry,
			value,
			sourceDetails[entry.layer] ?? {},
			rawContributors[index + 1]?.entry.layer,
		)));
		const effective = rawContributors.at(-1)?.entry;
		return freeze({
			key,
			effectiveValue: clone(config[key]),
			source: sourceSummary(effective, sourceDetails[effective?.layer] ?? {}),
			contributors,
		});
	});
	const layerSummaries = freeze(layers.map((entry) => sourceSummary(entry, sourceDetails[entry.layer] ?? {})));
	const revisions = freeze(Object.fromEntries(["install", "project"].flatMap((scope) => (
		sourceDetails[scope]?.revision === undefined ? [] : [[scope, sourceDetails[scope].revision]]
	))));
	return freeze({
		config,
		entries: freeze(entries),
		layers: layerSummaries,
		revisions,
		// Project is the safe default write scope. Callers selecting install use revisions.install explicitly.
		...(revisions.project === undefined ? {} : { revision: revisions.project }),
	});
}
