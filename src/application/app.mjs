// The shared application facade consumed by both terminal adapters. Feature services remain deliberately narrow so
// their domain seams stay reviewable, while this composition point gives capabilities, events, queries, and action
// dispatch one stable home.
import { createCapabilityRegistry } from "./capabilities.mjs";
import { CONTEXT_ACTION, CONTEXT_CAPABILITY_DEFINITIONS, createContextApplication } from "./context.mjs";
import { createApplicationEvents } from "./events.mjs";
import { createJobManager } from "./jobs.mjs";
import { createWorkspaceQueries } from "./queries.mjs";
import { createRuntimeContextReader, createRuntimeViewReader } from "./runtime.mjs";
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
 *   now?: () => number,
 *   events?: ReturnType<typeof createApplicationEvents>,
 *   jobs?: ReturnType<typeof createJobManager>,
 *   workspace?: Parameters<typeof createWorkspaceApplication>[0],
 *   context?: Parameters<typeof createContextApplication>[0],
 *   requests?: Parameters<typeof createRequestApplication>[0],
 *   review?: Parameters<typeof createReviewApplication>[0],
 *   talk?: Parameters<typeof createTalkApplication>[0],
 *   queries?: Parameters<typeof createWorkspaceQueries>[0],
 *   runtime?: { main?: any, context?: any, engine?: any, windows?: any, wakes?: any, preview?: (options?: { signal?: AbortSignal }) => Promise<object | undefined>, runner?: any, contextWindow?: number | (() => number), reader?: (options?: { signal?: AbortSignal }) => Promise<object | undefined>, viewReader?: ReturnType<typeof createRuntimeViewReader> },
 * }} options
 */
export function createApplication({ brainDir, root, config = {}, now = () => Date.now(), events = createApplicationEvents({ now }), jobs, workspace: workspaceOptions = {}, context: contextOptions = {}, requests: requestOptions = {}, review: reviewOptions = {}, talk: talkOptions = {}, queries: queryOptions = {}, runtime: runtimeOptions = {} }) {
	const eventStream = events;
	const jobManager = jobs ?? createJobManager({ events: eventStream, now });
	const workspace = createWorkspaceApplication({ ...workspaceOptions, brainDir, root, config, now });
	const context = createContextApplication({ ...contextOptions, brainDir, now });
	const requests = createRequestApplication({ ...requestOptions, brainDir, now });
	const review = createReviewApplication({ ...reviewOptions, brainDir, root, now });
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
	const runtimeViewReader = runtimeOptions.viewReader ?? queryOptions.runtimeViewReader ?? createRuntimeViewReader({
		engine: runtimeOptions.engine,
		windows: runtimeOptions.windows,
		wakes: runtimeOptions.wakes,
		preview: runtimeOptions.preview,
	});
	const queries = createWorkspaceQueries({ ...queryOptions, brainDir, root, now, runtimeContextReader, runtimeViewReader });
	const capabilities = createCapabilityRegistry([
		...WORKSPACE_CAPABILITY_DEFINITIONS,
		...CONTEXT_CAPABILITY_DEFINITIONS,
		...REQUEST_CAPABILITY_DEFINITIONS,
		...REVIEW_CAPABILITY_DEFINITIONS,
		...TALK_CAPABILITY_DEFINITIONS,
	]);
	const owners = new Map([
		...Object.values(WORKSPACE_ACTION).map((id) => [id, workspace]),
		...Object.values(CONTEXT_ACTION).map((id) => [id, context]),
		...Object.values(REQUEST_ACTION).map((id) => [id, requests]),
		...Object.values(REVIEW_ACTION).map((id) => [id, review]),
		...Object.values(TALK_ACTION).map((id) => [id, talk]),
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
		if (result.ok) eventStream.publish("projection.invalidated", { action, scopes: ACTION_SCOPES[action] ?? [] });
		return result;
	};

	return Object.freeze({
		capabilities,
		events: eventStream,
		jobs: jobManager,
		queries,
		execute,
		/** The add-template seam has no mutation and stays explicit until it becomes regular form metadata. */
		workspace: Object.freeze({ template: workspace.template }),
	});
}
