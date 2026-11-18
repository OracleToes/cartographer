// The shared application facade consumed by both terminal adapters. Feature services remain deliberately narrow so
// their domain seams stay reviewable, while this composition point gives capabilities, events, queries, and action
// dispatch one stable home.
import { CORE_DIR } from "../config.mjs";
import { createConfigurationRepository } from "../configuration/repository.mjs";
import { createCapabilityRegistry } from "./capabilities.mjs";
import { ACTION_SPECS, assertActionSpecParity, createActionSpecRegistry } from "./action-specs.mjs";
import { CONTEXT_ACTION, CONTEXT_CAPABILITY_DEFINITIONS, createContextApplication } from "./context.mjs";
import { createApplicationEvents } from "./events.mjs";
import { createJobManager } from "./jobs.mjs";
import { createWorkspaceQueries } from "./queries.mjs";
import { createRuntimeActivityReader, createRuntimeContextReader, createRuntimeModelsReader, createRuntimeStatusReader, createRuntimeViewReader } from "./runtime.mjs";
import { createSettingsReader } from "./settings.mjs";
import { SETTINGS_ACTION, SETTINGS_CAPABILITY_DEFINITIONS, createSettingsApplication } from "./settings-actions.mjs";
import { RUNTIME_ACTION, RUNTIME_CAPABILITY_DEFINITIONS, createRuntimeApplication } from "./runtime-actions.mjs";
import { REQUEST_ACTION, REQUEST_CAPABILITY_DEFINITIONS, createRequestApplication } from "./requests.mjs";
import { REVIEW_ACTION, REVIEW_CAPABILITY_DEFINITIONS, createReviewApplication } from "./review.mjs";
import { TALK_ACTION, TALK_CAPABILITY_DEFINITIONS, createTalkApplication } from "./talk.mjs";
import { WORKSPACE_ACTION, WORKSPACE_CAPABILITY_DEFINITIONS, createWorkspaceApplication } from "./workspace.mjs";
import { uiError, uiFailure } from "./result.mjs";
import { UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";

const ACTION_SCOPES = Object.freeze({
	[CONTEXT_ACTION.pinTop]: ["context", "workspace"],
	[CONTEXT_ACTION.clearKept]: ["context"],
	[REQUEST_ACTION.approve]: ["requests", "workspace"],
	[REQUEST_ACTION.deny]: ["requests", "workspace"],
	[REQUEST_ACTION.answer]: ["requests", "workspace"],
	[REVIEW_ACTION.undo]: ["review", "workspace", "context", "requests"],
	[REVIEW_ACTION.recordWindows]: ["review", "runtime"],
	[RUNTIME_ACTION.sendShell]: ["runtime"],
	[RUNTIME_ACTION.closeShell]: ["runtime"],
	[RUNTIME_ACTION.closeAllShells]: ["runtime"],
	[RUNTIME_ACTION.removeWake]: ["runtime"],
	[RUNTIME_ACTION.routeTaskMessage]: ["runtime"],
	[RUNTIME_ACTION.ensureModel]: ["runtime"],
	[RUNTIME_ACTION.selectModel]: ["runtime"],
	[TALK_ACTION.revise]: ["chat", "context"],
	[TALK_ACTION.forget]: ["chat", "context"],
	[WORKSPACE_ACTION.archive]: ["workspace", "context"],
	[WORKSPACE_ACTION.unarchive]: ["workspace", "context"],
	[WORKSPACE_ACTION.delete]: ["workspace", "context", "requests"],
	[WORKSPACE_ACTION.fold]: ["context"],
	[WORKSPACE_ACTION.recall]: ["context"],
	[WORKSPACE_ACTION.toggleFold]: ["context"],
	[WORKSPACE_ACTION.settle]: ["workspace", "context", "requests"],
	[WORKSPACE_ACTION.focusAtlas]: ["workspace", "context"],
	[WORKSPACE_ACTION.unfocusAtlas]: ["workspace", "context"],
	[WORKSPACE_ACTION.shelve]: ["context"],
	[WORKSPACE_ACTION.unshelve]: ["context"],
	[WORKSPACE_ACTION.add]: ["workspace", "context", "requests"],
	[WORKSPACE_ACTION.addMove]: ["workspace", "requests"],
	[WORKSPACE_ACTION.edit]: ["workspace", "context", "requests"],
	[SETTINGS_ACTION.edit]: ["settings", "configuration"],
	[SETTINGS_ACTION.reset]: ["settings", "configuration"],
});

const metadata = (options, now) => ({
	...(typeof options?.requestId === "string" && options.requestId !== "" ? { requestId: options.requestId } : {}),
	at: new Date(now()).toISOString(),
});

/**
 * @param {{
 *   brainDir: string,
 *   root: string,
 *   config?: object,
 *   configuration?: { coreDir?: string, env?: object, flags?: object, repository?: { read?: Function, update?: Function, paths?: object } },
 *   now?: () => number,
 *   events?: ReturnType<typeof createApplicationEvents>,
 *   jobs?: ReturnType<typeof createJobManager>,
 *   workspace?: Parameters<typeof createWorkspaceApplication>[0],
 *   context?: Parameters<typeof createContextApplication>[0],
 *   requests?: Parameters<typeof createRequestApplication>[0],
 *   review?: Parameters<typeof createReviewApplication>[0],
 *   runtimeActions?: Parameters<typeof createRuntimeApplication>[0],
 *   talk?: Parameters<typeof createTalkApplication>[0],
 *   queries?: Parameters<typeof createWorkspaceQueries>[0],
 *   runtime?: { main?: any, context?: any, engine?: any, windows?: any, wakes?: any, asks?: any, activeTask?: () => unknown, work?: any, model?: () => Promise<{ modelId?: string } | undefined> | { modelId?: string } | undefined, models?: any, preview?: (options?: { signal?: AbortSignal }) => Promise<object | undefined>, runner?: any, gate?: { yolo?: boolean }, initiation?: { on?: boolean }, contextWindow?: number | (() => number), reader?: (options?: { signal?: AbortSignal }) => Promise<object | undefined>, statusReader?: ReturnType<typeof createRuntimeStatusReader>, activityReader?: ReturnType<typeof createRuntimeActivityReader>, modelReader?: ReturnType<typeof createRuntimeModelsReader>, settingsReader?: ReturnType<typeof createSettingsReader>, viewReader?: ReturnType<typeof createRuntimeViewReader> },
 * }} options
 */
export function createApplication({ brainDir, root, config = {}, configuration: configurationOptions = {}, now = () => Date.now(), events = createApplicationEvents({ now }), jobs, workspace: workspaceOptions = {}, context: contextOptions = {}, requests: requestOptions = {}, review: reviewOptions = {}, runtimeActions: runtimeActionOptions = {}, talk: talkOptions = {}, queries: queryOptions = {}, runtime: runtimeOptions = {} }) {
	const eventStream = events;
	const jobManager = jobs ?? createJobManager({ events: eventStream, now });
	const configurationRepository = configurationOptions.repository ?? createConfigurationRepository({
		coreDir: configurationOptions.coreDir ?? CORE_DIR,
		brainDir,
		env: configurationOptions.env ?? process.env,
	});
	const configurationContext = Object.freeze({
		repository: configurationRepository,
		env: configurationOptions.env ?? process.env,
		flags: configurationOptions.flags ?? {},
	});
	const workspace = createWorkspaceApplication({ ...workspaceOptions, brainDir, root, config, now });
	const context = createContextApplication({ ...contextOptions, brainDir, now });
	const requests = createRequestApplication({ ...requestOptions, brainDir, now });
	const review = createReviewApplication({ windows: runtimeOptions.windows, ...reviewOptions, brainDir, root, now });
	const runtimeActionContext = { windows: runtimeOptions.windows, wakes: runtimeOptions.wakes, work: runtimeOptions.work, models: runtimeOptions.models, ...runtimeActionOptions, now };
	const runtimeActions = createRuntimeApplication(runtimeActionContext);
	const talk = createTalkApplication({ ...talkOptions, brainDir, now });
	const runtimeContextReader = runtimeOptions.reader ?? queryOptions.runtimeContextReader ?? createRuntimeContextReader({
		main: runtimeOptions.main,
		context: runtimeOptions.context,
		engine: runtimeOptions.engine,
		brainDir,
		root,
		config,
		runner: runtimeOptions.runner,
		contextWindow: runtimeOptions.contextWindow,
	});
	const runtimeStatusReader = runtimeOptions.statusReader ?? queryOptions.runtimeStatusReader ?? createRuntimeStatusReader({
		main: runtimeOptions.main,
		context: runtimeOptions.context,
		engine: runtimeOptions.engine,
		windows: runtimeOptions.windows,
		wakes: runtimeOptions.wakes,
		model: runtimeOptions.model,
	});
	const runtimeActivityReader = runtimeOptions.activityReader ?? queryOptions.runtimeActivityReader ?? createRuntimeActivityReader({
		asks: runtimeOptions.asks,
		activeTask: runtimeOptions.activeTask,
	});
	const runtimeModelReader = runtimeOptions.modelReader ?? queryOptions.runtimeModelReader ?? createRuntimeModelsReader({ models: runtimeOptions.models });
	const settingsReader = runtimeOptions.settingsReader ?? queryOptions.settingsReader ?? createSettingsReader({
		config,
		runner: runtimeOptions.runner,
		gate: runtimeOptions.gate,
		initiation: runtimeOptions.initiation,
		modelReader: runtimeModelReader,
		...configurationContext,
	});
	const settings = createSettingsApplication({ ...configurationContext, now });
	const runtimeViewReader = runtimeOptions.viewReader ?? queryOptions.runtimeViewReader ?? createRuntimeViewReader({
		engine: runtimeOptions.engine,
		windows: runtimeOptions.windows,
		wakes: runtimeOptions.wakes,
		preview: runtimeOptions.preview,
	});
	const queries = createWorkspaceQueries({ ...queryOptions, brainDir, root, now, runtimeContextReader, runtimeStatusReader, runtimeActivityReader, runtimeModelReader, settingsReader, runtimeViewReader });
	const capabilityRegistry = createCapabilityRegistry([
		...WORKSPACE_CAPABILITY_DEFINITIONS,
		...CONTEXT_CAPABILITY_DEFINITIONS,
		...REQUEST_CAPABILITY_DEFINITIONS,
		...REVIEW_CAPABILITY_DEFINITIONS,
		...RUNTIME_CAPABILITY_DEFINITIONS,
		...TALK_CAPABILITY_DEFINITIONS,
		...SETTINGS_CAPABILITY_DEFINITIONS,
	]);
	const actionSpecs = createActionSpecRegistry(ACTION_SPECS);
	assertActionSpecParity(capabilityRegistry, actionSpecs);
	const capabilityContext = Object.freeze({ windows: runtimeActionContext.windows, wakes: runtimeActionContext.wakes, work: runtimeActionContext.work, models: runtimeActionContext.models });
	// `get` deliberately exposes the same availability snapshot that `list` gives the palette. ActionLauncher uses
	// identity lookup after a palette has closed, so it must not accidentally treat a raw capability definition with
	// an `available` callback as enabled merely because that callback has not been projected yet.
	const capabilityFor = (id, context = {}) => {
		const capability = capabilityRegistry.get(id);
		if (capability === undefined) return undefined;
		const { available, ...publicCapability } = capability;
		return Object.freeze({ ...publicCapability, availability: capabilityRegistry.availability(id, { ...capabilityContext, ...context }) });
	};
	const capabilities = Object.freeze({
		get: capabilityFor,
		availability: (id, context = {}) => capabilityRegistry.availability(id, { ...capabilityContext, ...context }),
		list: (context = {}) => capabilityRegistry.list({ ...capabilityContext, ...context }),
	});
	const owners = new Map([
		...Object.values(WORKSPACE_ACTION).map((id) => [id, workspace]),
		...Object.values(CONTEXT_ACTION).map((id) => [id, context]),
		...Object.values(REQUEST_ACTION).map((id) => [id, requests]),
		...Object.values(REVIEW_ACTION).map((id) => [id, review]),
		...Object.values(RUNTIME_ACTION).map((id) => [id, runtimeActions]),
		...Object.values(TALK_ACTION).map((id) => [id, talk]),
		...Object.values(SETTINGS_ACTION).map((id) => [id, settings]),
	]);

	const execute = async (action, input = {}, options = {}) => {
		const owner = owners.get(action);
		if (owner === undefined) return uiFailure(uiError({
			code: UI_ERROR_CODE.unknownAction,
			kind: UI_ERROR_KIND.validation,
			message: "That application action is not registered.",
			retryable: false,
		}), { meta: metadata(options, now) });
		const result = await owner.execute(action, input, options);
		eventStream.publish(result.ok ? "action.completed" : "action.failed", {
			action,
			ok: result.ok,
			...(result.meta.requestId === undefined ? {} : { requestId: result.meta.requestId }),
		});
		if (result.ok && (action === SETTINGS_ACTION.edit || action === SETTINGS_ACTION.reset) && result.data.changed === true) {
			eventStream.publish("configuration.changed", {
				action,
				key: result.data.key,
				scope: result.data.scope,
				revision: result.data.revision,
			});
		}
		if (result.ok) eventStream.publish("projection.invalidated", { action, scopes: ACTION_SCOPES[action] ?? [] });
		return result;
	};

	return Object.freeze({
		capabilities,
		/** Pure presentation metadata paired by id with every registered capability. */
		actionSpecs,
		events: eventStream,
		jobs: jobManager,
		queries,
		execute,
		/** The add-template seam has no mutation and stays explicit until it becomes regular form metadata. */
		workspace: Object.freeze({ template: workspace.template }),
	});
}
