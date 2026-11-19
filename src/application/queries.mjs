// Read-only projections for terminal and screen adapters.
//
// The durable books still use their established synchronous readers internally. This facade is the only place a
// presentation adapter asks for them: reads are deferred from render/key stacks, cancellation is explicit, and
// malformed local state becomes a typed unavailable outcome rather than display-text parsing.
import { assessmentPath, loadAssessment } from "../assessment.mjs";
import { createHash } from "node:crypto";
import { activeMoveOverlays, atlasPath, attentionSnapshot, loadAtlas } from "../atlas.mjs";
import { listConferences } from "../conference.mjs";
import { composedRows, contextPath, loadContext, loadReport, shelfText } from "../context.mjs";
import { loadLedger, open as openEntries } from "../ledger.mjs";
import { isAuthorized, itemLine, loadPlan, planPath, waiting } from "../plan.mjs";
import { CONFIGURATION_SCHEMA, ConfigError, POLICY } from "../config.mjs";
import { ConfigurationRepositoryError } from "../configuration/repository.mjs";
import { loadTop, sinceTop } from "../top.mjs";
import { join } from "node:path";
import { describeProjectFiles, isFilesystemAbort, listProjectFiles, readText } from "../infrastructure/filesystem.mjs";
import { createGitReviewReader, isGitAbort } from "../infrastructure/git.mjs";
import { UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";
import { yieldToUi } from "./defer.mjs";
import { uiCancelled, uiError, uiErrorFrom, uiFailure, uiSuccess } from "./result.mjs";

export const WORKSPACE_QUERY = Object.freeze({
	atlas: "workspace.atlas",
	assessment: "workspace.assessment",
	ledger: "workspace.ledger",
	plan: "workspace.plan",
	requests: "workspace.requests",
	status: "workspace.status",
	entry: "workspace.entry",
	context: "workspace.context",
	report: "workspace.report",
	tree: "workspace.tree",
});

export const REVIEW_QUERY = Object.freeze({
	last: "review.last",
	session: "review.session",
	git: "review.git",
});

export const CONSULT_QUERY = Object.freeze({
	list: "consult.list",
	get: "consult.get",
	routing: "consult.routing",
});

export const RUNTIME_QUERY = Object.freeze({
	assessment: "runtime.assessment",
	context: "runtime.context",
	status: "runtime.status",
	activity: "runtime.activity",
	models: "runtime.models",
	shells: "runtime.shells",
	shellOutput: "runtime.shell-output",
	wakes: "runtime.wakes",
	sent: "runtime.sent",
	preview: "runtime.preview",
});

export const SETTINGS_QUERY = Object.freeze({
	status: "settings.status",
});

const nonEmpty = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const positiveInteger = (value) => Number.isInteger(value) && value > 0 ? value : undefined;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** Opaque message identity for the lifecycle-only Consult route; its source text never enters ordinary Work state. */
export const consultMessageFingerprint = (text) => createHash("sha256").update(String(text ?? "")).digest("hex");
/** The terminal needs only a child identity, state, and attributed message keys. Full conference material stays in Consult. */
const consultRoute = (record) => {
	const conference = nonEmpty(record?.id);
	const childConversationId = nonEmpty(record?.childConversationId);
	if (conference === undefined || childConversationId === undefined) return undefined;
	const activity = (Array.isArray(record.activities) ? record.activities : []).flatMap((entry) => {
		const participant = nonEmpty(entry?.participant);
		if (participant === undefined) return [];
		const callIds = (Array.isArray(entry.calls) ? entry.calls : []).map((call) => nonEmpty(call?.id)).filter((id) => id !== undefined);
		const proseHash = typeof entry?.prose === "string" ? consultMessageFingerprint(entry.prose) : undefined;
		return callIds.length === 0 && proseHash === undefined ? [] : [{ participant, ...(callIds.length === 0 ? {} : { callIds }), ...(proseHash === undefined ? {} : { proseHash }) }];
	});
	const turns = (Array.isArray(record.turns) ? record.turns : []).flatMap((turn) => {
		const participant = nonEmpty(turn?.participant);
		if (participant === undefined || typeof turn?.text !== "string") return [];
		return [{ participant, textHash: consultMessageFingerprint(turn.text) }];
	});
	return {
		conference,
		childConversationId,
		...(nonEmpty(record.status) === undefined ? {} : { status: nonEmpty(record.status) }),
		...(nonEmpty(record.active?.participant) === undefined ? {} : { activeParticipant: nonEmpty(record.active.participant) }),
		...(nonEmpty(record.final?.participant) === undefined ? {} : { finalParticipant: nonEmpty(record.final.participant) }),
		...(activity.length === 0 ? {} : { activity }),
		...(turns.length === 0 ? {} : { turns }),
	};
};
const metadata = (options, now) => ({
	...(typeof options?.requestId === "string" && options.requestId !== "" ? { requestId: options.requestId } : {}),
	at: new Date(now()).toISOString(),
});
const unavailable = (name, error, meta) => uiFailure(uiError({
	code: UI_ERROR_CODE.actionRefused,
	kind: UI_ERROR_KIND.unavailable,
	message: `The ${name} cannot be read: ${error ?? "its stored data is unavailable"}`,
	detail: error,
	retryable: true,
}), { meta });
const invalid = (message, field, meta) => uiFailure(uiError({
	code: UI_ERROR_CODE.invalidInput,
	kind: UI_ERROR_KIND.validation,
	message,
	field,
	retryable: false,
}), { meta });
const missing = (message, meta) => uiFailure(uiError({
	code: UI_ERROR_CODE.notFound,
	kind: UI_ERROR_KIND.notFound,
	message,
	retryable: false,
}), { meta });
const cancelledBy = (signal, error) => signal?.aborted === true || isFilesystemAbort(error) || isGitAbort(error);

const configurationValue = (value) => value === undefined || typeof value === "string" || typeof value === "boolean" || Number.isFinite(value)
	? value
	: Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : undefined;
const SOURCE_LAYERS = new Set(["default", "install", "project", "environment", "command-line"]);
const sourceFact = (value, { includeValue = false } = {}) => {
	if (!isRecord(value) || !SOURCE_LAYERS.has(value.layer)) return undefined;
	const result = {
		layer: value.layer,
		...(nonEmpty(value.path) === undefined ? {} : { path: nonEmpty(value.path) }),
		writable: value.writable === true,
		...(nonEmpty(value.revision) === undefined ? {} : { revision: nonEmpty(value.revision) }),
		...(SOURCE_LAYERS.has(value.overriddenBy) ? { overriddenBy: value.overriddenBy } : {}),
	};
	const saved = configurationValue(value.value);
	return includeValue && (saved !== undefined || Object.hasOwn(value, "value")) ? { ...result, value: saved } : result;
};
/** Known configuration rows remain typed even when a custom Settings reader supplies other session facts. */
const settingsProvenance = (configured) => {
	if (!Array.isArray(configured?.rows)) return undefined;
	const rawRows = new Map(configured.rows.filter(isRecord).map((row) => [row.key, row]));
	const rows = CONFIGURATION_SCHEMA.keys.flatMap((key) => {
		const raw = rawRows.get(key);
		const value = configurationValue(raw?.effectiveValue);
		const source = sourceFact(raw?.source);
		if (raw === undefined || source === undefined || value === undefined && !Object.hasOwn(raw, "effectiveValue")) return [];
		const detail = CONFIGURATION_SCHEMA.detail(key);
		return [{
			...detail,
			effectiveValue: value,
			displayValue: nonEmpty(raw.displayValue) ?? (value === undefined ? "not configured" : Array.isArray(value) ? value.join(", ") : String(value)),
			source,
			contributors: (Array.isArray(raw.contributors) ? raw.contributors : []).flatMap((entry) => {
				const fact = sourceFact(entry, { includeValue: true });
				return fact === undefined ? [] : [fact];
			}),
		}];
	});
	const layers = (Array.isArray(configured.layers) ? configured.layers : []).flatMap((entry) => {
		const fact = sourceFact(entry);
		return fact === undefined ? [] : [fact];
	});
	const revisions = isRecord(configured.revisions)
		? Object.fromEntries(["install", "project"].flatMap((scope) => {
			const revision = nonEmpty(configured.revisions[scope]);
			return revision === undefined ? [] : [[scope, revision]];
		}))
		: {};
	return {
		rows,
		layers,
		revisions,
		...(nonEmpty(configured.revision) === undefined ? {} : { revision: nonEmpty(configured.revision) }),
	};
};

/** Keep the Settings projection deliberately narrow even when an integration supplies its own reader. */
const settingsSnapshot = (snapshot) => {
	if (!isRecord(snapshot)) return undefined;
	const source = (value) => isRecord(value) ? value : {};
	const pickNumber = (value, key) => positiveInteger(value?.[key]);
	const pickText = (value, key) => nonEmpty(value?.[key]);
	const pickBoolean = (value, key) => typeof value?.[key] === "boolean" ? value[key] : undefined;
	const configured = source(snapshot.configuration);
	const provenance = settingsProvenance(configured);
	const configuration = {
		provider: {
			...(pickText(configured.provider, "server") === undefined ? {} : { server: pickText(configured.provider, "server") }),
			...(pickText(configured.provider, "configuredModel") === undefined ? {} : { configuredModel: pickText(configured.provider, "configuredModel") }),
			...(pickNumber(configured.provider, "contextWindow") === undefined ? {} : { contextWindow: pickNumber(configured.provider, "contextWindow") }),
			...(pickNumber(configured.provider, "maxTokens") === undefined ? {} : { maxTokens: pickNumber(configured.provider, "maxTokens") }),
		},
		agent: Object.fromEntries(["mainTurns", "taskTurns", "shellWait", "windowTail", "wakeMin"].flatMap((key) => {
			const value = pickNumber(configured.agent, key);
			return value === undefined ? [] : [[key, value]];
		})),
		context: {
			...Object.fromEntries(["chatWindow", "collapseTokens"].flatMap((key) => {
				const value = pickNumber(configured.context, key);
				return value === undefined ? [] : [[key, value]];
			})),
			...(typeof configured.context?.collapseMinutes === "number" && configured.context.collapseMinutes >= 0 ? { collapseMinutes: configured.context.collapseMinutes } : {}),
		},
		appearance: Object.fromEntries(["colors", "theme"].flatMap((key) => {
			const value = pickText(configured.appearance, key);
			return value === undefined ? [] : [[key, value]];
		})),
		...(provenance === undefined ? {} : provenance),
	};
	const policies = source(snapshot.policy);
	const sandbox = source(policies.sandbox);
	const policy = {
		approval: {
			...(pickBoolean(policies.approval, "yolo") === undefined ? {} : { yolo: pickBoolean(policies.approval, "yolo") }),
			...(pickBoolean(policies.approval, "defaultYolo") === undefined ? {} : { defaultYolo: pickBoolean(policies.approval, "defaultYolo") }),
		},
		initiation: {
			...(pickBoolean(policies.initiation, "on") === undefined ? {} : { on: pickBoolean(policies.initiation, "on") }),
			...(pickBoolean(policies.initiation, "defaultOn") === undefined ? {} : { defaultOn: pickBoolean(policies.initiation, "defaultOn") }),
		},
		sandbox: {
			...(pickText(sandbox, "mode") === undefined ? {} : { mode: pickText(sandbox, "mode") }),
			...(pickBoolean(sandbox, "defaultOn") === undefined ? {} : { defaultOn: pickBoolean(sandbox, "defaultOn") }),
			...(pickText(sandbox, "version") === undefined ? {} : { version: pickText(sandbox, "version") }),
			...(pickText(sandbox, "unavailableReason") === undefined ? {} : { unavailableReason: pickText(sandbox, "unavailableReason") }),
		},
	};
	const providerSource = source(snapshot.provider);
	const rawRoutes = source(providerSource.routes);
	const routes = snapshot.provider?.routes === undefined ? undefined : {
		...(pickText(rawRoutes, "currentId") === undefined ? {} : { currentId: pickText(rawRoutes, "currentId") }),
		models: (Array.isArray(rawRoutes.models) ? rawRoutes.models : []).flatMap((entry) => {
			const id = nonEmpty(entry?.id);
			if (id === undefined) return [];
			const contextWindow = positiveInteger(entry.contextWindow);
			return [{ id, ...(contextWindow === undefined ? {} : { contextWindow }) }];
		}),
		...(typeof rawRoutes.ready === "boolean" ? { ready: rawRoutes.ready } : {}),
		...(nonEmpty(rawRoutes.diagnostic?.message) === undefined ? {} : { diagnostic: { ...(nonEmpty(rawRoutes.diagnostic?.kind) === undefined ? {} : { kind: nonEmpty(rawRoutes.diagnostic.kind) }), message: nonEmpty(rawRoutes.diagnostic.message) } }),
		...(nonEmpty(rawRoutes.issue?.message) === undefined ? {} : { issue: { message: nonEmpty(rawRoutes.issue.message) } }),
		...(positiveInteger(rawRoutes.limits?.usableContextWindow) === undefined ? {} : {
			limits: {
				usableContextWindow: positiveInteger(rawRoutes.limits.usableContextWindow),
				...(positiveInteger(rawRoutes.limits.configuredContextWindow) === undefined ? {} : { configuredContextWindow: positiveInteger(rawRoutes.limits.configuredContextWindow) }),
				...(positiveInteger(rawRoutes.limits.serverContextWindow) === undefined ? {} : { serverContextWindow: positiveInteger(rawRoutes.limits.serverContextWindow) }),
			},
		}),
	};
	const routeIssue = nonEmpty(providerSource.routeIssue);
	return {
		configuration,
		policy,
		provider: {
			...(routes === undefined ? {} : { routes }),
			...(routeIssue === undefined ? {} : { routeIssue }),
		},
	};
};

/** Source positions are presentation metadata, read through an abort-aware filesystem port after the facade yielded. */
const jsonLines = async (file, field, values, { signal, filesystem } = {}) => {
	try {
		const source = await filesystem.readText(file, { signal });
		if (signal?.aborted === true) throw new Error("cancelled");
		return Object.fromEntries(values.map((value) => {
			const at = source.indexOf(`"${field}": ${JSON.stringify(value)}`);
			return [value, at < 0 ? undefined : source.slice(0, at).split("\n").length];
		}));
	} catch (error) {
		if (signal?.aborted === true || isFilesystemAbort(error)) throw error;
		return {};
	}
};

const DEFAULT_READERS = Object.freeze({ loadAtlas, loadAssessment, loadLedger, loadPlan, loadContext });
const DEFAULT_FILESYSTEM = Object.freeze({ listProjectFiles, describeProjectFiles, readText });
// Review and Git-tree reads share an actual spawned-process port; legacy checkpoint readers stay with the mutation
// owner and are not wrapped in a Promise merely for the Screen.
const DEFAULT_GIT_READER = createGitReviewReader();
const DEFAULT_REVIEW_READERS = DEFAULT_GIT_READER;
const DEFAULT_CONSULT_READERS = Object.freeze({ listConferences });
const DEFAULT_RUNTIME_READERS = Object.freeze({ loadAssessment, loadTop, loadAtlas, sinceTop });

/**
 * @param {{
 *   brainDir: string,
 *   root?: string,
 *   readers?: typeof DEFAULT_READERS,
 *   reviewReaders?: { lastChange?: (root: string, brainDir: string, options?: { signal?: AbortSignal, reportProgress?: Function }) => Promise<object | undefined> | object | undefined, changeSince?: (root: string, brainDir: string, started: number, options?: { signal?: AbortSignal, reportProgress?: Function }) => Promise<object | undefined> | object | undefined, uncommitted?: (root: string, options?: { signal?: AbortSignal, reportProgress?: Function }) => Promise<object | undefined> | object | undefined },
 *   gitReader?: { projectFiles?: (root: string, options?: { signal?: AbortSignal, reportProgress?: Function }) => Promise<string[] | undefined> },
 *   consultReaders?: typeof DEFAULT_CONSULT_READERS,
 *   runtimeReaders?: typeof DEFAULT_RUNTIME_READERS,
 *   runtimeContextReader?: (options?: { signal?: AbortSignal }) => Promise<{ messages: readonly any[], sizes: object, contextWindow?: number } | undefined>,
 *   runtimeStatusReader?: (options?: { signal?: AbortSignal }) => Promise<{ messages?: readonly any[], contextSize?: number, windows?: any[], wakes?: any[], modelId?: string, nextWakeDue?: number } | undefined>,
 *   runtimeActivityReader?: (options?: { signal?: AbortSignal }) => Promise<{ question?: { since?: number }, taskActive?: boolean } | undefined>,
 *   runtimeModelReader?: (options?: { signal?: AbortSignal }) => Promise<{ currentId?: string, models?: { id?: string, contextWindow?: number }[], ready?: boolean, limits?: object, diagnostic?: { kind?: string, message?: string }, issue?: { message?: string } } | undefined>,
 *   settingsReader?: (options?: { signal?: AbortSignal }) => Promise<{ configuration?: object, policy?: object, provider?: object } | undefined>,
 *   runtimeViewReader?: { sent?: (scope: "main" | "newest", options?: { signal?: AbortSignal }) => any, shells?: (options?: { tail?: number, signal?: AbortSignal }) => { windows?: any[] } | any[], shellOutput?: (options?: { name?: string, tail?: number, signal?: AbortSignal }) => { window?: any, lines?: string[] }, wakes?: (options?: { signal?: AbortSignal }) => { wakes?: any[], lines?: string[] } | any[], preview?: (options?: { signal?: AbortSignal }) => Promise<any> | any },
 *   filesystem?: { listProjectFiles?: (root: string, options?: { signal?: AbortSignal, reportProgress?: Function }) => Promise<{ path: string, bytes?: number }[]>, describeProjectFiles?: (root: string, paths: string[], options?: { signal?: AbortSignal, reportProgress?: Function }) => Promise<{ path: string, bytes?: number }[]>, readText?: (file: string, options?: { signal?: AbortSignal }) => Promise<string> },
 *   now?: () => number,
 * }} options
 */
export function createWorkspaceQueries({ brainDir, root, readers = DEFAULT_READERS, reviewReaders = DEFAULT_REVIEW_READERS, gitReader = DEFAULT_GIT_READER, consultReaders = DEFAULT_CONSULT_READERS, runtimeReaders = DEFAULT_RUNTIME_READERS, runtimeContextReader, runtimeStatusReader, runtimeActivityReader, runtimeModelReader, settingsReader, runtimeViewReader, filesystem = DEFAULT_FILESYSTEM, now = () => Date.now() }) {
	if (nonEmpty(brainDir) === undefined) throw new TypeError("Workspace queries need a brain directory.");
	if (typeof filesystem?.listProjectFiles !== "function" || typeof filesystem?.describeProjectFiles !== "function" || typeof filesystem?.readText !== "function") throw new TypeError("Workspace queries need asynchronous filesystem ports.");
	if (typeof gitReader?.projectFiles !== "function") throw new TypeError("Workspace queries need an asynchronous Git file-list port.");
	const paths = Object.freeze({
		atlas: atlasPath(brainDir),
		ledger: join(brainDir, "carto-ledger.json"),
		plan: planPath(brainDir),
		assessment: assessmentPath(brainDir),
		context: contextPath(brainDir),
	});

	const prepare = async (options) => {
		const meta = metadata(options, now);
		if (options?.signal?.aborted === true) return { meta, result: uiCancelled({ meta }) };
		await yieldToUi();
		if (options?.signal?.aborted === true) return { meta, result: uiCancelled({ meta }) };
		return { meta };
	};
	const read = async (name, key, loader, options = {}, projection = undefined) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		try {
			// Legacy book readers remain deliberately synchronous until they have a real async port. Only the optional
			// projection enrichment below may await a migrated filesystem operation.
			const loaded = loader(brainDir);
			if (loaded?.[key] === undefined) return unavailable(name, loaded?.error, ready.meta);
			const extra = typeof projection === "function" ? await projection(loaded[key], { signal: options.signal }) : {};
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			return uiSuccess({ [key]: loaded[key], file: paths[key], ...extra }, { meta: ready.meta });
		} catch (error) {
			if (cancelledBy(options.signal, error)) return uiCancelled({ meta: ready.meta });
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: `Cartographer could not read the ${name}.`,
				retryable: true,
			}), { meta: ready.meta });
		}
	};

	const atlas = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		try {
			const loadedAtlas = readers.loadAtlas(brainDir);
			if (loadedAtlas.atlas === undefined) return unavailable("graph", loadedAtlas.error, ready.meta);
			const loadedPlan = readers.loadPlan(brainDir);
			const active = activeMoveOverlays(loadedPlan.plan);
			const issues = loadedPlan.plan === undefined ? [{ source: "plan", message: loadedPlan.error ?? "The plan cannot be read." }] : [];
			const lines = await jsonLines(paths.atlas, "name", loadedAtlas.atlas.nodes.map((node) => node.name), { signal: options.signal, filesystem });
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			return uiSuccess({
				atlas: loadedAtlas.atlas,
				attention: attentionSnapshot(root, loadedAtlas.atlas, { active }),
				lines,
				file: paths.atlas,
				issues,
			}, { meta: ready.meta });
		} catch (error) {
			if (cancelledBy(options.signal, error)) return uiCancelled({ meta: ready.meta });
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read the graph.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	/** A lightweight assessment snapshot is separate from Runtime's top/atlas comparison for terminal startup. */
	const assessment = (options = {}) => read("assessment", "assessment", (dir) => ({ assessment: readers.loadAssessment(dir) }), options);
	const tree = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		if (nonEmpty(root) === undefined) return invalid("A project root is needed before listing its files.", "root", ready.meta);
		try {
			const gitPaths = await gitReader.projectFiles(root, { signal: options.signal, reportProgress: options.reportProgress });
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			const files = gitPaths === undefined
				? await filesystem.listProjectFiles(root, { signal: options.signal, reportProgress: options.reportProgress })
				: await filesystem.describeProjectFiles(root, gitPaths, { signal: options.signal, reportProgress: options.reportProgress });
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			// The tree is wholly async: Git supplies ignore-aware paths when available, filesystem supplies current sizes,
			// and Screen composition adds graph marks only from an already-settled Atlas projection.
			return uiSuccess({ root, files, filtersGitIgnored: gitPaths !== undefined }, { meta: ready.meta });
		} catch (error) {
			if (cancelledBy(options.signal, error)) return uiCancelled({ meta: ready.meta });
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not list the project files.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	const ledger = (options = {}) => read("ledger", "ledger", readers.loadLedger, options, async (loaded, { signal } = {}) => ({
		lines: await jsonLines(paths.ledger, "id", loaded.items.map((item) => item.id), { signal, filesystem }),
	}));
	const plan = (options = {}) => read("plan", "plan", readers.loadPlan, options, async (loaded, { signal } = {}) => ({
		lines: await jsonLines(paths.plan, "id", [...loaded.items, ...loaded.moves].map((item) => item.id), { signal, filesystem }),
	}));

	const status = async ({ yolo = false, ...options } = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		try {
			const [loadedPlan, loadedLedger] = [readers.loadPlan(brainDir), readers.loadLedger(brainDir)];
			const data = { requests: 0, waits: false, issues: [] };
			if (loadedPlan.plan === undefined) data.issues.push({ source: "plan", message: loadedPlan.error ?? "The plan cannot be read." });
			else {
				const open = loadedPlan.plan.items.filter((item) => item.status === POLICY.enums.entryStatus.open && item.archived !== true).length;
				const pending = yolo ? [] : waiting(loadedPlan.plan);
				data.plan = {
					total: loadedPlan.plan.items.length,
					open,
					moves: loadedPlan.plan.moves.length,
					awaiting: pending.length,
					ready: isAuthorized(loadedPlan.plan),
				};
				data.requests += pending.length;
				data.waits = pending.length > 0;
			}
			if (loadedLedger.ledger === undefined) data.issues.push({ source: "ledger", message: loadedLedger.error ?? "The ledger cannot be read." });
			else {
				const goals = openEntries(loadedLedger.ledger, POLICY.enums.ledgerKind.goal).length;
				const questions = loadedLedger.ledger.items.filter((item) => item.kind === POLICY.enums.ledgerKind.question && item.status === POLICY.enums.entryStatus.open && item.archived !== true);
				data.ledger = { goals };
				data.requests += questions.length;
			}
			return uiSuccess(data, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read workspace status.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};

	const requests = async ({ yolo = false, ...options } = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		try {
			const [loadedPlan, loadedLedger] = [readers.loadPlan(brainDir), readers.loadLedger(brainDir)];
			const issues = [];
			const items = [];
			if (loadedPlan.plan === undefined) issues.push({ source: "plan", message: loadedPlan.error ?? "The plan cannot be read." });
			else {
				const lines = await jsonLines(paths.plan, "id", [...loadedPlan.plan.items, ...loadedPlan.plan.moves].map((item) => item.id), { signal: options.signal, filesystem });
				if (!yolo) for (const move of waiting(loadedPlan.plan)) items.push({ id: move.id, kind: "approval", text: itemLine(move), file: paths.plan, line: lines[move.id] });
			}
			if (loadedLedger.ledger === undefined) issues.push({ source: "ledger", message: loadedLedger.error ?? "The ledger cannot be read." });
			else {
				const lines = await jsonLines(paths.ledger, "id", loadedLedger.ledger.items.map((item) => item.id), { signal: options.signal, filesystem });
				for (const item of loadedLedger.ledger.items) if (item.kind === POLICY.enums.ledgerKind.question && item.status === POLICY.enums.entryStatus.open && item.archived !== true) items.push({ id: item.id, kind: POLICY.enums.ledgerKind.question, text: `${item.id}  ${item.text}`, file: paths.ledger, line: lines[item.id] });
			}
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			return uiSuccess({ items, issues }, { meta: ready.meta });
		} catch (error) {
			if (cancelledBy(options.signal, error)) return uiCancelled({ meta: ready.meta });
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read requests.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};

	const context = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		try {
			const store = readers.loadContext(brainDir);
			if (store === undefined) return unavailable("shared brain", undefined, ready.meta);
			const issues = [];
			const shelf = (store.shelf ?? []).map((item) => {
				const file = typeof root === "string" && typeof item.path === "string" ? join(root, item.path) : undefined;
				try {
					return { item, text: shelfText(root, item, brainDir), ...(file === undefined ? {} : { file }) };
				} catch (error) {
					issues.push({ source: `shelf:${item.id ?? item.path ?? "item"}`, message: error instanceof Error ? error.message : String(error) });
					return { item, text: "(the shelf snapshot cannot be read)", ...(file === undefined ? {} : { file }) };
				}
			});
			const report = (record) => {
				try {
					return { record, text: loadReport(brainDir, record.id) };
				} catch (error) {
					issues.push({ source: `report:${record.id}`, message: error instanceof Error ? error.message : String(error) });
					return { record, text: undefined };
				}
			};
			const records = composedRows(store);
			return uiSuccess({
				store,
				shelf,
				standing: records.filter((record) => record.archived !== true).map(report),
				archived: records.filter((record) => record.archived === true).map(report),
				file: paths.context,
				issues,
			}, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read the shared brain.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};

	const report = async (id, options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		const target = nonEmpty(id);
		if (target === undefined) return invalid("Choose a report before reading it.", "id", ready.meta);
		const file = join(brainDir, "reports", `${target}.md`);
		try {
			const body = await filesystem.readText(file, { signal: options.signal });
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			return uiSuccess({ id: target, text: body.trimEnd(), file }, { meta: ready.meta });
		} catch (error) {
			if (cancelledBy(options.signal, error)) return uiCancelled({ meta: ready.meta });
			if (error?.code === "ENOENT") return missing(`There is no report ${target}.`, ready.meta);
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: `Cartographer could not read report ${target}.`,
				retryable: true,
			}), { meta: ready.meta });
		}
	};

	const prepareReview = async (options) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready;
		if (nonEmpty(root) === undefined) return { ...ready, result: invalid("A project root is needed before reading review data.", "root", ready.meta) };
		return ready;
	};
	const reviewResult = async (name, key, loader, { meta, signal }) => {
		try {
			const value = await loader({ signal });
			if (signal?.aborted === true) return uiCancelled({ meta });
			return uiSuccess({ root, [key]: value }, { meta });
		} catch (error) {
			if (cancelledBy(signal, error)) return uiCancelled({ meta });
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: `Cartographer could not read ${name}.`,
				retryable: true,
			}), { meta });
		}
	};
	const reviewLast = async (options = {}) => {
		const ready = await prepareReview(options);
		if (ready.result !== undefined) return ready.result;
		return reviewResult("the last checkpoint change", "last", ({ signal }) => reviewReaders.lastChange(root, brainDir, { signal, reportProgress: options.reportProgress }), { meta: ready.meta, signal: options.signal });
	};
	const reviewSession = async ({ started, ...options } = {}) => {
		const ready = await prepareReview(options);
		if (ready.result !== undefined) return ready.result;
		if (!Number.isFinite(started)) return invalid("A session start time is needed before reading session changes.", "started", ready.meta);
		return reviewResult("the session changes", "change", ({ signal }) => reviewReaders.changeSince(root, brainDir, started, { signal, reportProgress: options.reportProgress }), { meta: ready.meta, signal: options.signal });
	};
	const reviewGit = async (options = {}) => {
		const ready = await prepareReview(options);
		if (ready.result !== undefined) return ready.result;
		return reviewResult("the project's Git changes", "own", ({ signal }) => reviewReaders.uncommitted(root, { signal, reportProgress: options.reportProgress }), { meta: ready.meta, signal: options.signal });
	};
	const review = Object.freeze({ last: reviewLast, session: reviewSession, git: reviewGit });

	const consultList = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		try {
			// Full co<N> records remain a Consult-only projection. The screen cache passes these only to its isolated
			// Consult renderer; they never join Conversation, Work, or a request/context projection.
			return uiSuccess({ conferences: consultReaders.listConferences(brainDir) }, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read consultation conferences.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	const consultGet = async (id, options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		const target = nonEmpty(id);
		if (target === undefined) return invalid("Choose a consultation conference before reading it.", "id", ready.meta);
		try {
			const entry = consultReaders.listConferences(brainDir).find((candidate) => candidate.id === target);
			if (entry === undefined) return missing(`No consultation conference ${target} exists.`, ready.meta);
			if (entry.conference === undefined) return unavailable("consultation conference", entry.error ?? `conference ${target} is unreadable`, ready.meta);
			// Like `consult.list`, this full record is for an explicitly selected Consult surface only. Callers must not
			// merge it into a parent conversation/work/context projection.
			return uiSuccess({ id: target, conference: entry.conference }, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read that consultation conference.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	/** A non-Consult lifecycle route deliberately contains no question, source, audit prose, or result material. */
	const consultRouting = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		try {
			const routes = consultReaders.listConferences(brainDir)
				.flatMap((entry) => entry?.conference === undefined ? [] : [consultRoute(entry.conference)])
				.filter((route) => route !== undefined);
			return uiSuccess({ routes }, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read consultation routing.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	const consult = Object.freeze({ list: consultList, get: consultGet, routing: consultRouting });

	const runtimeAssessment = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		try {
			const assessment = runtimeReaders.loadAssessment(brainDir);
			const atlasResult = runtimeReaders.loadAtlas(brainDir);
			const atlas = atlasResult?.atlas;
			const top = runtimeReaders.loadTop(brainDir);
			const changes = atlas === undefined || top === undefined ? undefined : runtimeReaders.sinceTop(brainDir, atlas, assessment.text);
			return uiSuccess({ assessment, atlas, top, changes, atlasError: atlasResult?.error, file: paths.assessment }, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read the runtime assessment.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	/** The active conversation's accounting is volatile session state, supplied by composition rather than read by a view. */
	const runtimeContext = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		if (typeof runtimeContextReader !== "function") return unavailable("active-context accounting", "the running session does not expose context accounting", ready.meta);
		try {
			const projection = await runtimeContextReader({ signal: options.signal });
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			if (projection === undefined || projection === null || typeof projection !== "object" || !Array.isArray(projection.messages) || projection.sizes === null || typeof projection.sizes !== "object") {
				return unavailable("active-context accounting", "the running session did not provide a complete accounting projection", ready.meta);
			}
			return uiSuccess(projection, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read active-context accounting.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	/** A compact runtime status has its own reader so terminal status does not need a live conversation or manager. */
	const runtimeStatus = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		if (typeof runtimeStatusReader !== "function") return unavailable("runtime status", "the running session does not expose a status snapshot", ready.meta);
		try {
			const snapshot = await runtimeStatusReader({ signal: options.signal });
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			if (snapshot === undefined || snapshot === null || typeof snapshot !== "object") return unavailable("runtime status", "the running session did not provide a status snapshot", ready.meta);
			return uiSuccess({
				messages: Array.isArray(snapshot.messages) ? snapshot.messages : [],
				...(Number.isFinite(snapshot.contextSize) ? { contextSize: snapshot.contextSize } : {}),
				windows: Array.isArray(snapshot.windows) ? snapshot.windows : [],
				wakes: Array.isArray(snapshot.wakes) ? snapshot.wakes : [],
				...(typeof snapshot.modelId === "string" && snapshot.modelId !== "" ? { modelId: snapshot.modelId } : {}),
				...(Number.isFinite(snapshot.nextWakeDue) ? { nextWakeDue: snapshot.nextWakeDue } : {}),
			}, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read runtime status.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	/** The screen's status and composer consume this cached activity fact instead of touching asks or task routing while they render. */
	const runtimeActivity = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		if (typeof runtimeActivityReader !== "function") return unavailable("runtime activity", "the running session does not expose its activity snapshot", ready.meta);
		try {
			const snapshot = await runtimeActivityReader({ signal: options.signal });
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			if (snapshot === undefined || snapshot === null || typeof snapshot !== "object") return unavailable("runtime activity", "the running session did not provide an activity snapshot", ready.meta);
			const since = Number.isFinite(snapshot.question?.since) ? snapshot.question.since : undefined;
			return uiSuccess({
				...(snapshot.question === undefined ? {} : { question: { ...(since === undefined ? {} : { since }) } }),
				taskActive: snapshot.taskActive === true,
			}, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read runtime activity.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	/** Model names and advertised windows are a deferred Runtime projection; a transient server check becomes a visible issue over known local routes. */
	const runtimeModels = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		if (typeof runtimeModelReader !== "function") return unavailable("model routes", "the running session does not expose model routes", ready.meta);
		try {
			const snapshot = await runtimeModelReader({ signal: options.signal });
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			if (snapshot === undefined || snapshot === null || typeof snapshot !== "object") return unavailable("model routes", "the running session did not provide model routes", ready.meta);
			const models = (Array.isArray(snapshot.models) ? snapshot.models : []).flatMap((entry) => {
				const id = nonEmpty(entry?.id);
				if (id === undefined) return [];
				const contextWindow = Number.isInteger(entry.contextWindow) && entry.contextWindow > 0 ? entry.contextWindow : undefined;
				return [{ id, ...(contextWindow === undefined ? {} : { contextWindow }) }];
			});
			const currentId = nonEmpty(snapshot.currentId);
			const issue = nonEmpty(snapshot.issue?.message);
			const diagnosticMessage = nonEmpty(snapshot.diagnostic?.message);
			const diagnosticKind = nonEmpty(snapshot.diagnostic?.kind);
			return uiSuccess({
				...(currentId === undefined ? {} : { currentId }),
				models,
				...(typeof snapshot.ready === "boolean" ? { ready: snapshot.ready } : {}),
				...(snapshot.limits !== undefined && typeof snapshot.limits === "object" && snapshot.limits !== null ? { limits: snapshot.limits } : {}),
				...(diagnosticMessage === undefined ? {} : { diagnostic: { ...(diagnosticKind === undefined ? {} : { kind: diagnosticKind }), message: diagnosticMessage } }),
				...(issue === undefined ? {} : { issue: { message: issue } }),
			}, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read model routes.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	/** Settings & Safety is a deferred session/configuration snapshot, not a screen-side read of mutable policy objects. */
	const settingsStatus = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		if (typeof settingsReader !== "function") return unavailable("Settings & Safety status", "the running session does not expose a settings snapshot", ready.meta);
		try {
			const snapshot = await settingsReader({ signal: options.signal });
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			const projected = settingsSnapshot(snapshot);
			if (projected === undefined) return unavailable("Settings & Safety status", "the running session did not provide a settings snapshot", ready.meta);
			return uiSuccess(projected, { meta: ready.meta });
		} catch (error) {
			if (error instanceof ConfigurationRepositoryError && (error.code === "invalid-json" || error.code === "read-failed")) return uiFailure(uiError({
				code: UI_ERROR_CODE.actionRefused,
				kind: UI_ERROR_KIND.unavailable,
				message: "The saved configuration cannot be read. Fix its JSON or file access, then refresh Settings.",
				retryable: true,
			}), { meta: ready.meta });
			if (error instanceof ConfigError) return uiFailure(uiError({
				code: UI_ERROR_CODE.invalidInput,
				kind: UI_ERROR_KIND.validation,
				message: error.message,
				retryable: false,
			}), { meta: ready.meta });
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read Settings & Safety status.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	/** A shell snapshot is always safe to show as an empty collection when this session has no shell manager. */
	const runtimeShells = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		try {
			const snapshot = typeof runtimeViewReader?.shells === "function"
				? await runtimeViewReader.shells({ tail: POLICY.limits.screen.windowsListed, signal: options.signal })
				: undefined;
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			const windows = Array.isArray(snapshot) ? snapshot : Array.isArray(snapshot?.windows) ? snapshot.windows : [];
			return uiSuccess({ windows }, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read the shell windows.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	/** Wake schedules are another mutable runtime manager; the strip consumes this snapshot instead of reading it while it paints. */
	const runtimeWakes = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		try {
			const snapshot = typeof runtimeViewReader?.wakes === "function"
				? await runtimeViewReader.wakes({ signal: options.signal })
				: undefined;
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			const wakes = Array.isArray(snapshot) ? snapshot : Array.isArray(snapshot?.wakes) ? snapshot.wakes : [];
			const lines = Array.isArray(snapshot?.lines) ? snapshot.lines : [];
			return uiSuccess({ wakes, lines }, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read the wake schedule.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	/** The selected shell's kept output is a separate projection, so rendering does not ask a live process manager. */
	const runtimeShellOutput = async ({ name, ...options } = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		try {
			const snapshot = typeof runtimeViewReader?.shellOutput === "function"
				? await runtimeViewReader.shellOutput({ name, tail: POLICY.limits.screen.shellViewLines, signal: options.signal })
				: undefined;
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			return uiSuccess({
				...(snapshot?.window === undefined ? {} : { window: snapshot.window }),
				lines: Array.isArray(snapshot?.lines) ? snapshot.lines : [],
			}, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read that shell window.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	/** Frozen provider-request snapshots can calculate collapse state, so they are acquired outside rendering too. */
	const runtimeSent = async ({ scope = "newest", ...options } = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		if (scope !== "main" && scope !== "newest") return invalid("Choose the main or newest sent request.", "scope", ready.meta);
		try {
			const sent = typeof runtimeViewReader?.sent === "function"
				? await runtimeViewReader.sent(scope, { signal: options.signal })
				: undefined;
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			return uiSuccess({ scope, sent }, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read the sent provider request.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	/** A request preview may do live planning work; it shares the same deferred/cancellable contract as every view. */
	const runtimePreview = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		try {
			const preview = typeof runtimeViewReader?.preview === "function"
				? await runtimeViewReader.preview({ signal: options.signal })
				: undefined;
			if (options.signal?.aborted === true) return uiCancelled({ meta: ready.meta });
			return uiSuccess({ preview }, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could prepare the next-request preview.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	const runtime = Object.freeze({
		assessment: runtimeAssessment,
		context: runtimeContext,
		status: runtimeStatus,
		activity: runtimeActivity,
		models: runtimeModels,
		shells: runtimeShells,
		shellOutput: runtimeShellOutput,
		wakes: runtimeWakes,
		sent: runtimeSent,
		preview: runtimePreview,
	});

	const entry = async (input, options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		if (!isRecord(input)) return invalid("An entry query needs an input object.", undefined, ready.meta);
		const book = nonEmpty(input.book);
		const id = nonEmpty(input.id);
		if (!(["atlas", "ledger", "plan"].includes(book))) return invalid("Choose atlas, ledger, or plan before reading an entry.", "book", ready.meta);
		if (id === undefined) return invalid("Choose an entry before reading it.", "id", ready.meta);
		try {
			if (book === "atlas") {
				const loaded = readers.loadAtlas(brainDir);
				if (loaded.atlas === undefined) return unavailable("graph", loaded.error, ready.meta);
				const item = loaded.atlas.nodes.find((node) => node.id === id || node.name === id);
				return item === undefined ? missing(`There is no atlas node ${id}.`, ready.meta) : uiSuccess({ book, item, file: paths.atlas }, { meta: ready.meta });
			}
			if (book === "ledger") {
				const loaded = readers.loadLedger(brainDir);
				if (loaded.ledger === undefined) return unavailable("ledger", loaded.error, ready.meta);
				const item = loaded.ledger.items.find((candidate) => candidate.id === id);
				return item === undefined ? missing(`There is no ledger entry ${id}.`, ready.meta) : uiSuccess({ book, item, file: paths.ledger }, { meta: ready.meta });
			}
			const loaded = readers.loadPlan(brainDir);
			if (loaded.plan === undefined) return unavailable("plan", loaded.error, ready.meta);
			const envelope = loaded.plan.items.find((candidate) => candidate.id === id);
			const move = envelope === undefined ? loaded.plan.moves.find((candidate) => candidate.id === id) : undefined;
			const item = envelope ?? move;
			return item === undefined
				? missing(`There is no plan entry ${id}.`, ready.meta)
				: uiSuccess({ book, item, ...(move === undefined ? {} : { parent: loaded.plan.items.find((candidate) => candidate.id === move.parent) }), file: paths.plan }, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read that workspace entry.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};

	return Object.freeze({ paths, atlas, assessment, tree, ledger, plan, requests, status, context, report, review, consult, settings: Object.freeze({ status: settingsStatus }), runtime, entry });
}
