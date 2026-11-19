// Typed persisted-setting edits. Session policy switches stay outside this module: a saved default never mutates the
// current approval, initiation, or sandbox state.
import { CONFIGURATION_SCHEMA, DEFAULTS } from "../config.mjs";
import { CONFIGURATION_SOURCE, resolveConfigurationSources } from "../configuration/sources.mjs";
import { ConfigurationRepositoryError } from "../configuration/repository.mjs";
import { configurationProvenance, readConfigurationState } from "./settings.mjs";
import { createCapabilityRegistry } from "./capabilities.mjs";
import { UI_ACTION_INTENT, UI_CONFIRMATION, UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";
import { yieldToUi } from "./defer.mjs";
import { uiCancelled, uiError, uiErrorFrom, uiFailure, uiSuccess } from "./result.mjs";

export const SETTINGS_ACTION = Object.freeze({
	edit: "settings.edit",
	reset: "settings.reset",
});

export const SETTINGS_CAPABILITY_DEFINITIONS = Object.freeze([
	{ id: SETTINGS_ACTION.edit, label: "Edit saved setting", category: "settings", intent: UI_ACTION_INTENT.mutate },
	{ id: SETTINGS_ACTION.reset, label: "Reset saved setting override", category: "settings", intent: UI_ACTION_INTENT.mutate },
]);

export const SETTINGS_CAPABILITIES = createCapabilityRegistry(SETTINGS_CAPABILITY_DEFINITIONS);

const text = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const metadata = (options, now) => ({
	...(text(options?.requestId) === undefined ? {} : { requestId: text(options.requestId) }),
	at: new Date(now()).toISOString(),
});
const invalid = (message, field, meta) => uiFailure(uiError({
	code: UI_ERROR_CODE.invalidInput,
	kind: UI_ERROR_KIND.validation,
	message,
	field,
	retryable: false,
}), { meta });
const policy = (message, meta) => uiFailure(uiError({
	code: UI_ERROR_CODE.policyBlocked,
	kind: UI_ERROR_KIND.policy,
	message,
	retryable: false,
}), { meta });
const conflict = (message, meta) => uiFailure(uiError({
	code: UI_ERROR_CODE.conflict,
	kind: UI_ERROR_KIND.conflict,
	message,
	retryable: true,
	suggestedAction: "Refresh Settings and try again.",
}), { meta });
const unavailable = (message, meta) => uiFailure(uiError({
	code: UI_ERROR_CODE.actionRefused,
	kind: UI_ERROR_KIND.unavailable,
	message,
	retryable: true,
}), { meta });

const scopeOf = (value) => value === CONFIGURATION_SOURCE.install || value === "install"
	? CONFIGURATION_SOURCE.install
	: value === undefined || value === CONFIGURATION_SOURCE.project || value === "project"
		? CONFIGURATION_SOURCE.project
		: undefined;
const applyLine = (apply) => ({
	"live-screen": "in the Screen after refresh",
	"next-request": "for the next request",
	reconnect: "after the provider reconnects",
	"next-session": "when Cartographer next starts",
})[apply] ?? "when its owner next reads configuration";
const guardedRequest = (action, key, value, scope) => {
	if (action !== SETTINGS_ACTION.edit) return undefined;
	const risky = key === "shellRead" || key === "yolo" && value === true || key === "bwrap" && value === false;
	if (!risky) return undefined;
	const summary = key === "shellRead"
		? "Adding saved shell-read locations expands where future task commands may read."
		: key === "yolo"
			? "Saving YOLO as the default makes future sessions start with approval off."
			: "Saving direct execution as the default makes future sessions start without the Bubblewrap sandbox.";
	return { actionId: action, target: `${scope}:${key}`, summary, strength: UI_CONFIRMATION.typed };
};
const confirmed = (request, confirmation) => request === undefined || (confirmation?.acknowledged === true && confirmation.actionId === request.actionId && confirmation.target === request.target);
const sourceBy = (state, scope) => state.sources?.[scope];
const sourceValues = (state, scope, replacement) => ({
	install: scope === CONFIGURATION_SOURCE.install ? replacement : state.sources.install.values,
	project: scope === CONFIGURATION_SOURCE.project ? replacement : state.sources.project.values,
});
const repositoryCancelled = (error) => error instanceof ConfigurationRepositoryError && error.code === "cancelled";

const repositoryFailure = (error, meta) => {
	if (repositoryCancelled(error)) return uiCancelled({ meta });
	if (error instanceof ConfigurationRepositoryError) {
		if (error.code === "revision-conflict") return conflict(error.message, meta);
		if (error.code === "source-read-only" || error.code === "invalid-source") return policy(error.message, meta);
		if (error.code === "invalid-json" || error.code === "read-failed") return unavailable("The selected configuration source cannot be read. Fix it or refresh Settings before editing.", meta);
		if (error.code === "write-failed") return uiFailure(uiError({
			code: UI_ERROR_CODE.internal,
			kind: UI_ERROR_KIND.internal,
			message: "Cartographer could not save that configuration change.",
			retryable: true,
		}), { meta });
	}
	return undefined;
};

/**
 * @param {{
 *   repository?: { read?: Function, update?: Function, paths?: object },
 *   schema?: typeof CONFIGURATION_SCHEMA,
 *   defaults?: object,
 *   env?: object,
 *   flags?: object,
 *   jobs?: { start?: Function },
 *   now?: () => number,
 * }} options
 */
export function createSettingsApplication({ repository, schema = CONFIGURATION_SCHEMA, defaults = DEFAULTS, env = process.env, flags = {}, jobs, now = () => Date.now() } = {}) {
	const stateOptions = { repository, schema, defaults, env, flags };
	const perform = async (action, input = {}, options = {}, { defer = true } = {}) => {
		const meta = metadata(options, now);
		const progress = (current, message) => options.reportProgress?.({ current, total: 6, message });
		if (options.signal?.aborted === true) return uiCancelled({ meta });
		if (defer) {
			await yieldToUi();
			if (options.signal?.aborted === true) return uiCancelled({ meta });
		}
		progress(0, "Checking Settings change.");
		if (SETTINGS_CAPABILITIES.get(action) === undefined) return uiFailure(uiError({
			code: UI_ERROR_CODE.unknownAction,
			kind: UI_ERROR_KIND.validation,
			message: "That Settings action is not registered.",
			retryable: false,
		}), { meta });
		if (repository === undefined || typeof repository.update !== "function") return policy("This session does not expose a writable configuration repository.", meta);
		if (!record(input)) return invalid("A Settings action needs an input object.", undefined, meta);
		const key = text(input.key);
		if (key === undefined || !schema.has(key)) return invalid("Choose one known setting before saving.", "key", meta);
		const scope = scopeOf(input.scope);
		if (scope === undefined) return policy("Choose the project or install configuration source. Environment and command-line overrides are read-only.", meta);
		const expectedRevision = text(input.expectedRevision ?? options.expectedRevision);
		if (expectedRevision === undefined) return invalid("Refresh Settings before saving so this edit has the selected source revision.", "expectedRevision", meta);
		let value;
		if (action === SETTINGS_ACTION.edit) {
			if (!Object.hasOwn(input, "value")) return invalid("Enter a value before saving this setting.", "value", meta);
			try {
				value = schema.coerceSetting(key, input.value);
			} catch (error) {
				return invalid(error instanceof Error ? error.message : "That setting value is invalid.", "value", meta);
			}
		}
		const confirmation = guardedRequest(action, key, value, scope);
		if (!confirmed(confirmation, options.confirmation)) return uiFailure(uiError({
			code: UI_ERROR_CODE.confirmationRequired,
			kind: UI_ERROR_KIND.policy,
			message: confirmation.summary,
			retryable: false,
		}), { meta, confirmation });
		let before;
		try {
			progress(1, "Reading saved configuration.");
			before = await readConfigurationState({ ...stateOptions, signal: options.signal, reportProgress: options.reportProgress });
		} catch (error) {
			return repositoryFailure(error, meta) ?? unavailable("Cartographer could not read configuration before saving this change.", meta);
		}
		if (options.signal?.aborted === true || before === undefined) return uiCancelled({ meta });
		const selected = sourceBy(before, scope);
		if (selected === undefined) return unavailable("The selected configuration source is unavailable.", meta);
		if (selected.revision !== expectedRevision) return conflict("The selected configuration changed before this edit could be saved. Refresh Settings and try again.", meta);
		if (selected.writable !== true) return policy(`The ${scope} configuration source is read-only. Choose a writable saved source.`, meta);
		const nextValues = { ...selected.values };
		if (action === SETTINGS_ACTION.edit) nextValues[key] = value;
		else delete nextValues[key];
		try {
			progress(3, "Validating Settings change.");
			const sources = sourceValues(before, scope, nextValues);
			schema.assertSources({
				install: sources.install,
				project: sources.project,
				installPath: before.sources.install.path,
				projectPath: before.sources.project.path,
				env,
			});
			const candidate = resolveConfigurationSources({
				defaults,
				install: sources.install,
				project: sources.project,
				env,
				flags,
				paths: repository.paths,
				sourceDetails: {
					install: { writable: before.sources.install.writable, revision: before.sources.install.revision },
					project: { writable: before.sources.project.writable, revision: before.sources.project.revision },
				},
			});
			schema.validate(candidate.config);
		} catch (error) {
			return invalid(error instanceof Error ? error.message : "That setting value is invalid.", "value", meta);
		}
		const existed = Object.hasOwn(selected.values, key);
		const changed = action === SETTINGS_ACTION.edit || existed;
		let written = selected;
		let committed = false;
		const markCommitted = (effect = {}) => {
			if (committed) return;
			committed = true;
			options.markCommitted?.({
				kind: "configuration.write",
				target: `${scope}:${key}`,
				scope,
				key,
				...effect,
			});
		};
		const committedAfterCancellation = () => {
			const detail = schema.detail(key);
			const line = `Saved ${detail?.label ?? key} in ${scope} configuration; cancellation stopped the follow-up refresh. Refresh Settings to see current provenance.`;
			return uiSuccess({
				action,
				key,
				scope,
				changed: true,
				committed: true,
				refresh: "needed",
				revision: written.revision,
				line,
			}, {
				meta: { ...meta, revision: written.revision },
				notices: [{ level: "warning", message: line }],
			});
		};
		if (changed) {
			try {
				progress(4, `Saving ${scope} configuration.`);
				written = await repository.update({
					scope,
					expectedRevision,
					transform: () => nextValues,
					signal: options.signal,
					reportProgress: (entry) => progress(4, entry?.message ?? `Saving ${scope} configuration.`),
					onCommitted: markCommitted,
				});
				// Test seams and third-party repositories may predate `onCommitted`; a fulfilled update is still a commit.
				markCommitted({ revision: written.revision });
			} catch (error) {
				return repositoryFailure(error, meta) ?? uiFailure(uiErrorFrom(error, {
					code: UI_ERROR_CODE.internal,
					kind: UI_ERROR_KIND.internal,
					message: "Cartographer could not save that configuration change.",
					retryable: true,
				}), { meta });
			}
		}
		// Once the atomic rename has completed, cancellation can only stop waiting. Never report a committed setting
		// as cancelled or undone merely because a caller left while the refreshed projection was being assembled.
		if (committed && options.signal?.aborted === true) return committedAfterCancellation();
		if (!changed && options.signal?.aborted === true) return uiCancelled({ meta });
		let after;
		try {
			progress(5, "Refreshing Settings provenance.");
			after = await readConfigurationState({
				...stateOptions,
				signal: options.signal,
				reportProgress: () => progress(5, "Refreshing Settings provenance."),
			});
		} catch (error) {
			if (committed && (options.signal?.aborted === true || repositoryCancelled(error))) return committedAfterCancellation();
			if (changed) {
				const detail = schema.detail(key);
				const line = `Saved ${detail?.label ?? key} in ${scope} configuration, but Settings could not refresh its provenance yet.`;
				return uiSuccess({ action, key, scope, changed, revision: written.revision, line }, {
					meta: { ...meta, revision: written.revision },
					notices: [{ level: "warning", message: line }],
				});
			}
			return repositoryFailure(error, meta) ?? unavailable("Cartographer could not refresh its Settings snapshot.", meta);
		}
		if (committed && (options.signal?.aborted === true || after === undefined)) return committedAfterCancellation();
		if (after === undefined) return uiCancelled({ meta });
		const row = configurationProvenance(after, { schema }).rows.find((entry) => entry.key === key);
		const shadowed = row?.source.layer !== scope;
		const verb = action === SETTINGS_ACTION.reset ? (changed ? "Reset" : "No saved override existed for") : "Saved";
		const line = shadowed
			? `${verb} ${row?.label ?? key} in ${scope} configuration, but ${row?.source.layer ?? "a higher-precedence source"} currently overrides it.`
			: `${verb} ${row?.label ?? key} in ${scope} configuration; it takes effect ${applyLine(row?.apply)}.`;
		progress(6, "Settings change complete.");
		return uiSuccess({
			action,
			key,
			scope,
			changed,
			...(committed ? { committed: true } : {}),
			revision: written.revision,
			configuration: configurationProvenance(after, { schema }),
			row,
			line,
		}, {
			meta: { ...meta, revision: written.revision },
			notices: [{ level: changed ? "success" : "info", message: line }],
		});
	};
	const execute = async (action, input = {}, options = {}) => {
		if (typeof jobs?.start !== "function") return perform(action, input, options, { defer: true });
		if (options.signal?.aborted === true) return uiCancelled({ meta: metadata(options, now) });
		const scope = scopeOf(input?.scope) ?? CONFIGURATION_SOURCE.project;
		const key = text(input?.key) ?? "setting";
		const job = jobs.start({
			kind: "settings.write",
			target: `${scope}:${key}`,
			meta: { ...metadata(options, now), action },
			run: ({ signal, reportProgress, markCommitted }) => perform(action, input, {
				...options,
				signal,
				reportProgress,
				markCommitted,
			}, { defer: false }),
		});
		let detach;
		if (options.signal !== undefined) {
			const stop = () => job.cancel();
			options.signal.addEventListener("abort", stop, { once: true });
			detach = () => options.signal.removeEventListener("abort", stop);
		}
		try {
			return await job.promise;
		} finally {
			detach?.();
		}
	};
	return Object.freeze({ capabilities: SETTINGS_CAPABILITIES, execute });
}
