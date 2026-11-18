// The configuration schema shared by startup, the Settings projection, and persisted-setting actions.
//
// This module deliberately has no dependency on Cartographer's runtime composition. `src/config.mjs` supplies the
// frozen defaults, policy bounds, and ConfigError constructor; the same schema can therefore validate a prospective
// source edit without reading a mutable session object.

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => Array.isArray(value) ? value.map(clone) : record(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
const freeze = (value) => Object.freeze(value);

export const CONFIGURATION_SCOPE = freeze({
	install: "install",
	project: "project",
});

const SETTING_DETAILS = freeze({
	server: { label: "Provider endpoint", apply: "reconnect", risk: "normal", validation: { kind: "text" } },
	model: { label: "Configured model", apply: "reconnect", risk: "normal", validation: { kind: "text" } },
	user: { label: "Your name", apply: "next-session", risk: "normal", validation: { kind: "text" } },
	contextWindow: { label: "Context window", apply: "next-request", risk: "normal", validation: { kind: "integer" } },
	maxTokens: { label: "Reply ceiling", apply: "next-request", risk: "normal", validation: { kind: "integer" } },
	mainTurns: { label: "Main-agent turn ceiling", apply: "next-session", risk: "normal", validation: { kind: "integer" } },
	taskTurns: { label: "Task turn ceiling", apply: "next-session", risk: "normal", validation: { kind: "integer" } },
	shellWait: { label: "Shell quiet wait", apply: "next-session", risk: "normal", validation: { kind: "integer" } },
	windowTail: { label: "Shell output in state", apply: "next-request", risk: "normal", validation: { kind: "integer" } },
	wakeMin: { label: "Minimum wake interval", apply: "next-session", risk: "normal", validation: { kind: "integer" } },
	wakesMax: { label: "Wake limit", apply: "next-session", risk: "normal", validation: { kind: "integer" } },
	shellRead: { label: "Additional shell read locations", apply: "next-session", risk: "guarded", validation: { kind: "path-list" } },
	treeDepth: { label: "Project tree depth", apply: "next-session", risk: "normal", validation: { kind: "integer" } },
	screen: { label: "Start in full Screen", apply: "next-session", risk: "normal", validation: { kind: "boolean" } },
	colors: { label: "Colours", apply: "live-screen", risk: "normal", validation: { kind: "choice" } },
	theme: { label: "Theme", apply: "live-screen", risk: "normal", validation: { kind: "choice" } },
	initiate: { label: "Initiate by default", apply: "next-session", risk: "normal", validation: { kind: "boolean" } },
	yolo: { label: "Approval default", apply: "next-session", risk: "guarded", validation: { kind: "boolean" } },
	bwrap: { label: "Sandbox default", apply: "next-session", risk: "guarded", validation: { kind: "boolean" } },
	repeatCut: { label: "Cut repeated output", apply: "next-request", risk: "normal", validation: { kind: "boolean" } },
	prefill: { label: "Show provider prefill", apply: "next-request", risk: "normal", validation: { kind: "boolean" } },
	prefillTokens: { label: "Prefill display threshold", apply: "next-request", risk: "normal", validation: { kind: "integer" } },
	askMinutes: { label: "Question timeout", apply: "next-session", risk: "normal", validation: { kind: "number" } },
	thinking: { label: "Show thinking by default", apply: "next-session", risk: "normal", validation: { kind: "boolean" } },
	handoffQuestion: { label: "Ask before automatic handoff", apply: "next-session", risk: "normal", validation: { kind: "boolean" } },
	chatWindow: { label: "Kept-talk window", apply: "next-request", risk: "normal", validation: { kind: "integer" } },
	collapseTokens: { label: "Collapse token threshold", apply: "next-request", risk: "normal", validation: { kind: "integer" } },
	collapseMinutes: { label: "Away collapse delay", apply: "next-request", risk: "normal", validation: { kind: "number" } },
	collapseFull: { label: "Working-context collapse threshold", apply: "next-request", risk: "normal", validation: { kind: "integer" } },
	readAhead: { label: "Read collapsed context ahead", apply: "next-request", risk: "normal", validation: { kind: "boolean" } },
});

const validationFor = (key, policy) => {
	if (["contextWindow", "maxTokens", "mainTurns", "shellWait", "wakeMin", "wakesMax"].includes(key)) return { kind: "integer", min: policy.validation.positiveIntegerMin };
	if (key === "taskTurns") return { kind: "integer", min: policy.validation.positiveIntegerMin, max: policy.limits.plan.moveTurns.max };
	if (key === "windowTail") return { kind: "integer", min: policy.validation.positiveIntegerMin, max: policy.validation.windowTailMax };
	if (key === "treeDepth") return { kind: "integer", min: policy.validation.positiveIntegerMin, max: policy.limits.tree.maxDepth };
	if (["chatWindow", "collapseTokens"].includes(key)) return { kind: "integer", min: policy.validation.minimumTokenSetting, ...(key === "chatWindow" ? { max: "contextWindow / 2" } : {}) };
	if (key === "prefillTokens") return { kind: "integer", min: policy.validation.prefillTokensMin };
	if (key === "collapseFull") return { kind: "integer", min: policy.validation.collapsePercent.min, max: policy.validation.collapsePercent.max };
	if (["askMinutes", "collapseMinutes"].includes(key)) return { kind: "number", min: policy.validation.nonNegativeMin };
	if (key === "user") return { kind: "text", maxLength: policy.validation.userChars, singleLine: true };
	if (key === "shellRead") return { kind: "path-list", path: "absolute-or-home" };
	if (key === "colors") return { kind: "choice", choices: [...policy.enums.colors] };
	if (key === "theme") return { kind: "choice", choices: [...policy.enums.themes] };
	return { ...SETTING_DETAILS[key].validation };
};

const RETIRED_CONSULT_SETTINGS = freeze(["consultModel", "consultMaxTokens", "consultTemperature", "consultTimeoutSeconds"]);
const RETIRED_GRAMMAR_SETTINGS = freeze(["consultGrammar"]);

/**
 * Build Cartographer's pure configuration contract. `ErrorType` is injected so startup keeps its established
 * ConfigError surface while repository actions can convert the same validation fact into UiError.
 */
export function createConfigurationSchema({ defaults, policy, ErrorType = Error } = {}) {
	if (!record(defaults)) throw new TypeError("A configuration schema needs default settings.");
	if (!record(policy)) throw new TypeError("A configuration schema needs policy bounds.");
	const keys = freeze(Object.keys(defaults));
	const known = new Set(keys);
	for (const key of keys) if (SETTING_DETAILS[key] === undefined) throw new TypeError(`Configuration setting ${key} needs presentation metadata.`);
	const fail = (message) => { throw new ErrorType(message); };
	const details = freeze(Object.fromEntries(keys.map((key) => [key, freeze({
		key,
		...SETTING_DETAILS[key],
		persistence: CONFIGURATION_SCOPE.project,
		validation: freeze(validationFor(key, policy)),
	})])));

	const defaultCopy = () => ({ ...clone(defaults), shellRead: Array.isArray(defaults.shellRead) ? [...defaults.shellRead] : [] });
	const present = (value) => record(value) ? value : {};

	const assertSources = ({ install = {}, project = {}, installPath = "install config", projectPath = "project config", env = {} } = {}) => {
		const core = present(install);
		const local = present(project);
		const retiredAt = [
			...RETIRED_CONSULT_SETTINGS.filter((key) => own(core, key)).map((key) => `${installPath}:${key}`),
			...RETIRED_CONSULT_SETTINGS.filter((key) => own(local, key)).map((key) => `${projectPath}:${key}`),
		];
		if (retiredAt.length > 0) fail(`Removed external-consult setting(s): ${retiredAt.join(", ")}. C5 uses the caller's resolved model only; remove these settings instead of expecting a fallback model.`);
		const retiredGrammarAt = [
			...RETIRED_GRAMMAR_SETTINGS.filter((key) => own(core, key)).map((key) => `${installPath}:${key}`),
			...RETIRED_GRAMMAR_SETTINGS.filter((key) => own(local, key)).map((key) => `${projectPath}:${key}`),
		];
		if (retiredGrammarAt.length > 0) fail(`Removed native-grammar compatibility setting(s): ${retiredGrammarAt.join(", ")}. Native llama.cpp GBNF enforcement is required for Cartographer; remove these settings instead of selecting an adapter.`);
		if (env?.CARTO_CONSULT_MODEL !== undefined) fail("CARTO_CONSULT_MODEL was removed by the C5 consult cutover. A conference uses the caller's resolved model only; unset this environment variable instead of setting it empty.");
	};

	const validate = (candidate = {}, { requireProvider = false, missingProviderMessage } = {}) => {
		if (!record(candidate)) fail("config: settings must be one object");
		const config = { ...defaultCopy(), ...clone(candidate) };
		config.shellRead = Array.isArray(config.shellRead) ? [...config.shellRead] : config.shellRead;
		if (requireProvider && (typeof config.server !== "string" || typeof config.model !== "string")) {
			fail(typeof missingProviderMessage === "function" ? missingProviderMessage() : "No model server is configured.");
		}
		if (config.server !== undefined && typeof config.server !== "string") fail("config: server must be one URL, as a string");
		if (config.model !== undefined && typeof config.model !== "string") fail("config: model must be one name, as a string");
		if (typeof config.server === "string") config.server = config.server.replace(/\/+$/, "");
		if (config.user !== undefined) {
			if (typeof config.user !== "string") fail("config: user must be one name, as a string");
			const user = config.user.trim();
			if (user === "" || /[\r\n]/.test(config.user)) fail("config: user must be one name on one line");
			if (user.length > policy.validation.userChars) fail(`config: user must be ${policy.validation.userChars} characters or fewer`);
			config.user = user;
		}
		for (const key of ["contextWindow", "maxTokens", "mainTurns", "taskTurns", "shellWait", "treeDepth", "windowTail", "wakeMin", "wakesMax"]) {
			if (!Number.isInteger(config[key]) || config[key] < policy.validation.positiveIntegerMin) fail(`config: ${key} must be a whole number, ${policy.validation.positiveIntegerMin} or more`);
		}
		if (config.taskTurns > policy.limits.plan.moveTurns.max) fail(`config: taskTurns must be ${policy.limits.plan.moveTurns.max} or fewer: one focus is one small execution move`);
		for (const key of ["chatWindow", "collapseTokens"]) {
			if (!Number.isInteger(config[key]) || config[key] < policy.validation.minimumTokenSetting) fail(`config: ${key} must be a whole number of tokens, ${policy.validation.minimumTokenSetting} or more`);
		}
		if (config.chatWindow > config.contextWindow / policy.validation.chatWindowDivisor) fail("config: chatWindow must not be more than half of contextWindow");
		if (typeof config.collapseMinutes !== "number" || !(config.collapseMinutes >= policy.validation.nonNegativeMin)) fail(`config: collapseMinutes must be a number of minutes, ${policy.validation.nonNegativeMin} or more`);
		if (!Number.isInteger(config.collapseFull) || config.collapseFull < policy.validation.collapsePercent.min || config.collapseFull > policy.validation.collapsePercent.max) fail(`config: collapseFull must be a whole number from ${policy.validation.collapsePercent.min} to ${policy.validation.collapsePercent.max} (percent)`);
		for (const key of ["screen", "repeatCut", "prefill", "yolo", "bwrap", "initiate", "handoffQuestion"]) if (typeof config[key] !== "boolean") fail(`config: ${key} must be true or false`);
		if (!policy.enums.colors.includes(config.colors)) fail(`config: colors must be ${policy.enums.colors.slice(0, -1).map((color) => JSON.stringify(color)).join(", ")} or ${JSON.stringify(policy.enums.colors.at(-1))}`);
		if (!policy.enums.themes.includes(config.theme)) fail(`config: theme must be ${policy.enums.themes.slice(0, -1).map((theme) => JSON.stringify(theme)).join(", ")} or ${JSON.stringify(policy.enums.themes.at(-1))}`);
		if (!Number.isInteger(config.prefillTokens) || config.prefillTokens < policy.validation.prefillTokensMin) fail(`config: prefillTokens must be a whole number of tokens, ${policy.validation.prefillTokensMin} or more`);
		if (typeof config.askMinutes !== "number" || !(config.askMinutes >= policy.validation.nonNegativeMin)) fail(`config: askMinutes must be a number of minutes, ${policy.validation.nonNegativeMin} or more`);
		if (typeof config.readAhead !== "boolean") fail("config: readAhead must be true or false");
		if (config.windowTail > policy.validation.windowTailMax) fail(`config: windowTail must be a whole number from ${policy.validation.positiveIntegerMin} to ${policy.validation.windowTailMax}`);
		if (config.treeDepth > policy.limits.tree.maxDepth) fail(`config: treeDepth must be a whole number from ${policy.validation.positiveIntegerMin} to ${policy.limits.tree.maxDepth}`);
		if (typeof config.thinking !== "boolean") fail("config: thinking must be true or false");
		if (!Array.isArray(config.shellRead) || config.shellRead.some((path) => typeof path !== "string" || !/^(\/|~\/)/.test(path))) {
			fail('config: shellRead must be a list of folders, each a full path or starting with ~/');
		}
		return config;
	};

	/**
	 * Form controls naturally return strings. Coercion is deliberately opt-in and is never used while reading JSON
	 * at startup: a malformed persisted file still fails under the historic strict configuration contract.
	 */
	const coerceSetting = (key, value) => {
		if (!known.has(key)) fail(`config: ${JSON.stringify(key)} is not a known setting`);
		if (value === undefined) fail(`config: ${key} needs a value; reset removes a saved override`);
		const kind = details[key].validation.kind;
		if (kind === "boolean") {
			if (typeof value === "boolean") return value;
			if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
			fail(`config: ${key} must be true or false`);
		}
		if (kind === "integer") {
			if (Number.isInteger(value)) return value;
			if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return Number(value.trim());
			fail(`config: ${key} must be a whole number`);
		}
		if (kind === "number") {
			if (typeof value === "number" && Number.isFinite(value)) return value;
			if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value.trim()))) return Number(value.trim());
			fail(`config: ${key} must be a number`);
		}
		if (kind === "path-list") {
			if (Array.isArray(value)) return clone(value);
			if (typeof value === "string") {
				const trimmed = value.trim();
				if (trimmed.startsWith("[")) {
					try {
						const parsed = JSON.parse(trimmed);
						if (Array.isArray(parsed)) return parsed;
					} catch { /* the canonical newline-list fallback reports the schema error below */ }
				}
				return value.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry !== "");
			}
			fail(`config: ${key} must be a list`);
		}
		if (typeof value !== "string") fail(`config: ${key} must be text`);
		return key === "user" ? value.trim() : value;
	};

	return freeze({
		keys,
		has: (key) => typeof key === "string" && known.has(key),
		detail: (key) => details[key],
		details: () => keys.map((key) => details[key]),
		defaultCopy,
		assertSources,
		validate,
		coerceSetting,
		// Compatibility name for early Settings consumers. Full cross-setting validation happens after source merge.
		normalizeSetting: coerceSetting,
	});
}
