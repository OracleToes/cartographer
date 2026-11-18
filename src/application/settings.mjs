// Read-only Settings & Safety snapshots.
//
// Configuration files, session-scoped policy switches, and provider readiness deliberately remain distinct facts.
// The Settings reader owns the asynchronous source snapshot; a screen never reaches into files, mutable config,
// runner, approval, initiation, or model-manager state while it renders.
import { CONFIGURATION_SCHEMA, DEFAULTS } from "../config.mjs";
import { CONFIGURATION_SOURCE, resolveConfigurationSources } from "../configuration/sources.mjs";

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const positiveInteger = (value) => Number.isInteger(value) && value > 0 ? value : undefined;
const boolean = (value, fallback) => typeof value === "boolean" ? value : fallback;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const clone = (value) => Array.isArray(value) ? value.map(clone) : record(value) === undefined ? value : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
const freeze = (value) => Object.freeze(value);

const configuration = (config = {}) => ({
	provider: {
		...(nonEmpty(config.server) === undefined ? {} : { server: nonEmpty(config.server) }),
		...(nonEmpty(config.model) === undefined ? {} : { configuredModel: nonEmpty(config.model) }),
		...(positiveInteger(config.contextWindow) === undefined ? {} : { contextWindow: positiveInteger(config.contextWindow) }),
		...(positiveInteger(config.maxTokens) === undefined ? {} : { maxTokens: positiveInteger(config.maxTokens) }),
	},
	agent: {
		...(positiveInteger(config.mainTurns) === undefined ? {} : { mainTurns: positiveInteger(config.mainTurns) }),
		...(positiveInteger(config.taskTurns) === undefined ? {} : { taskTurns: positiveInteger(config.taskTurns) }),
		...(positiveInteger(config.shellWait) === undefined ? {} : { shellWait: positiveInteger(config.shellWait) }),
		...(positiveInteger(config.windowTail) === undefined ? {} : { windowTail: positiveInteger(config.windowTail) }),
		...(positiveInteger(config.wakeMin) === undefined ? {} : { wakeMin: positiveInteger(config.wakeMin) }),
	},
	context: {
		...(positiveInteger(config.chatWindow) === undefined ? {} : { chatWindow: positiveInteger(config.chatWindow) }),
		...(positiveInteger(config.collapseTokens) === undefined ? {} : { collapseTokens: positiveInteger(config.collapseTokens) }),
		...(typeof config.collapseMinutes === "number" && config.collapseMinutes >= 0 ? { collapseMinutes: config.collapseMinutes } : {}),
	},
	appearance: {
		...(nonEmpty(config.colors) === undefined ? {} : { colors: nonEmpty(config.colors) }),
		...(nonEmpty(config.theme) === undefined ? {} : { theme: nonEmpty(config.theme) }),
	},
});

const sandbox = (runner, defaultOn) => {
	const mode = runner?.mode === "sandbox" || runner?.mode === "direct" || runner?.mode === "none" ? runner.mode : "unavailable";
	const available = record(runner?.available);
	return {
		mode,
		defaultOn,
		...(available?.ok === true && nonEmpty(available.version) !== undefined ? { version: nonEmpty(available.version) } : {}),
		...(available?.ok === false && nonEmpty(available.why) !== undefined ? { unavailableReason: nonEmpty(available.why) } : {}),
	};
};

const modelRoutes = (value) => {
	const source = record(value);
	if (source === undefined) return undefined;
	const models = Array.isArray(source.models) ? source.models.flatMap((entry) => {
		const id = nonEmpty(entry?.id);
		if (id === undefined) return [];
		const contextWindow = positiveInteger(entry.contextWindow);
		return [{ id, ...(contextWindow === undefined ? {} : { contextWindow }) }];
	}) : [];
	const currentId = nonEmpty(source.currentId);
	const issue = nonEmpty(source.issue?.message);
	const diagnostic = nonEmpty(source.diagnostic?.message);
	const diagnosticKind = nonEmpty(source.diagnostic?.kind);
	const limits = record(source.limits);
	const usableContextWindow = positiveInteger(limits?.usableContextWindow);
	const configuredContextWindow = positiveInteger(limits?.configuredContextWindow);
	const serverContextWindow = positiveInteger(limits?.serverContextWindow);
	return {
		...(currentId === undefined ? {} : { currentId }),
		models,
		...(typeof source.ready === "boolean" ? { ready: source.ready } : {}),
		...(diagnostic === undefined ? {} : { diagnostic: { ...(diagnosticKind === undefined ? {} : { kind: diagnosticKind }), message: diagnostic } }),
		...(issue === undefined ? {} : { issue: { message: issue } }),
		...(usableContextWindow === undefined ? {} : {
			limits: {
				usableContextWindow,
				...(configuredContextWindow === undefined ? {} : { configuredContextWindow }),
				...(serverContextWindow === undefined ? {} : { serverContextWindow }),
			},
		}),
	};
};

const displayValue = (value) => {
	if (value === undefined) return "not configured";
	if (typeof value === "boolean") return value ? "on" : "off";
	if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
	return String(value);
};

/**
 * Read both editable JSON sources without making environment or command-line overrides writable. This is shared by
 * Settings query and Settings action owners so their source, revision, and cross-setting validation facts cannot
 * drift apart.
 */
export async function readConfigurationState({ repository, schema = CONFIGURATION_SCHEMA, defaults = DEFAULTS, env = process.env, flags = {}, signal } = {}) {
	if (repository === undefined || typeof repository.read !== "function") throw new TypeError("A configuration state reader needs an asynchronous configuration repository.");
	if (signal?.aborted === true) return undefined;
	const [install, project] = await Promise.all([repository.read(CONFIGURATION_SOURCE.install), repository.read(CONFIGURATION_SOURCE.project)]);
	if (signal?.aborted === true) return undefined;
	schema.assertSources({
		install: install.values,
		project: project.values,
		installPath: install.path,
		projectPath: project.path,
		env,
	});
	const resolved = resolveConfigurationSources({
		defaults,
		install: install.values,
		project: project.values,
		env,
		flags,
		paths: repository.paths,
		sourceDetails: {
			install: { writable: install.writable, revision: install.revision },
			project: { writable: project.writable, revision: project.revision },
		},
	});
	const config = schema.validate(resolved.config);
	return freeze({
		config: freeze({ ...clone(config), shellRead: Array.isArray(config.shellRead) ? [...config.shellRead] : config.shellRead }),
		sources: freeze({ install, project }),
		resolved,
	});
}

/** Convert a settled asynchronous source state to the typed all-settings Settings projection. */
export function configurationProvenance(state, { schema = CONFIGURATION_SCHEMA } = {}) {
	if (state === undefined || !record(state) || !record(state.resolved) || !record(state.config)) throw new TypeError("Configuration provenance needs a settled configuration state.");
	const entries = new Map((Array.isArray(state.resolved.entries) ? state.resolved.entries : []).map((entry) => [entry.key, entry]));
	const rows = freeze(schema.keys.map((key) => {
		const entry = entries.get(key);
		const detail = schema.detail(key);
		if (entry === undefined || detail === undefined) throw new TypeError(`Configuration provenance is missing ${key}.`);
		return freeze({
			...detail,
			effectiveValue: clone(state.config[key]),
			displayValue: displayValue(state.config[key]),
			source: entry.source,
			contributors: entry.contributors,
		});
	}));
	return freeze({
		rows,
		layers: state.resolved.layers,
		revisions: state.resolved.revisions,
		...(state.resolved.revision === undefined ? {} : { revision: state.resolved.revision }),
	});
}

/**
 * A composition-owned reader for Settings & Safety. `modelReader` is the same deferred model-route port consumed by
 * Runtime: route discovery and native-grammar readiness remain distinct facts and no reader can manufacture a ready
 * state when the proof did not succeed. The optional repository adds source/revision rows without changing legacy
 * embedders that provide only a settled launch `config`.
 * @param {{
 *   config?: object,
 *   runner?: { mode?: string, available?: object, off?: boolean },
 *   gate?: { yolo?: boolean },
 *   initiation?: { on?: boolean },
 *   modelReader?: (options?: { signal?: AbortSignal }) => Promise<object | undefined> | object | undefined,
 *   repository?: { read?: (scope: string) => Promise<object>, paths?: object },
 *   schema?: typeof CONFIGURATION_SCHEMA,
 *   defaults?: object,
 *   env?: object,
 *   flags?: object,
 * }} options
 */
export function createSettingsReader({ config = {}, runner, gate, initiation, modelReader, repository, schema = CONFIGURATION_SCHEMA, defaults = DEFAULTS, env = process.env, flags = {} } = {}) {
	return async ({ signal } = {}) => {
		if (signal?.aborted === true) return undefined;
		const state = repository === undefined ? undefined : await readConfigurationState({ repository, schema, defaults, env, flags, signal });
		if (signal?.aborted === true || state === undefined && repository !== undefined) return undefined;
		let routes;
		let routeIssue;
		try {
			routes = typeof modelReader === "function" ? await modelReader({ signal }) : undefined;
		} catch (error) {
			routeIssue = nonEmpty(error?.message ?? error);
		}
		if (signal?.aborted === true) return undefined;
		const configured = {
			...configuration(config),
			...(state === undefined ? {} : configurationProvenance(state, { schema })),
		};
		const currentRoutes = modelRoutes(routes);
		return {
			configuration: configured,
			policy: {
				approval: { yolo: gate?.yolo === true, defaultYolo: boolean(config.yolo, false) },
				initiation: { on: initiation?.on !== false, defaultOn: boolean(config.initiate, true) },
				sandbox: sandbox(runner, boolean(config.bwrap, true)),
			},
			provider: {
				...(currentRoutes === undefined ? {} : { routes: currentRoutes }),
				...(routeIssue === undefined ? {} : { routeIssue }),
			},
		};
	};
}
