// Read-only Settings & Safety snapshots.
//
// Configuration and the three session-scoped policy switches are owned by composition and the terminal lifecycle.
// This adapter takes one safe, settled copy after the application query has yielded, so a screen never reaches into
// mutable config, runner, approval, initiation, or model-manager state while it renders.

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const positiveInteger = (value) => Number.isInteger(value) && value > 0 ? value : undefined;
const boolean = (value, fallback) => typeof value === "boolean" ? value : fallback;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;

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

/**
 * A composition-owned reader for Settings & Safety. `modelReader` is the same deferred model-route port consumed by
 * Runtime: route discovery and native-grammar readiness remain distinct facts and no reader can manufacture a ready
 * state when the proof did not succeed.
 * @param {{
 *   config?: object,
 *   runner?: { mode?: string, available?: object, off?: boolean },
 *   gate?: { yolo?: boolean },
 *   initiation?: { on?: boolean },
 *   modelReader?: (options?: { signal?: AbortSignal }) => Promise<object | undefined> | object | undefined,
 * }} options
 */
export function createSettingsReader({ config = {}, runner, gate, initiation, modelReader } = {}) {
	return async ({ signal } = {}) => {
		if (signal?.aborted === true) return undefined;
		let routes;
		let routeIssue;
		try {
			routes = typeof modelReader === "function" ? await modelReader({ signal }) : undefined;
		} catch (error) {
			routeIssue = nonEmpty(error?.message ?? error);
		}
		if (signal?.aborted === true) return undefined;
		const configured = configuration(config);
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
