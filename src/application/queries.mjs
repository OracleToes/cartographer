// Read-only projections for terminal and screen adapters.
//
// The durable books still use their established synchronous readers internally. This facade is the only place a
// presentation adapter asks for them: reads are deferred from render/key stacks, cancellation is explicit, and
// malformed local state becomes a typed unavailable outcome rather than display-text parsing.
import { assessmentPath } from "../assessment.mjs";
import { activeMoveOverlays, atlasPath, attentionSnapshot, fileMarks, loadAtlas } from "../atlas.mjs";
import { composedRows, contextPath, loadContext, loadReport, shelfText } from "../context.mjs";
import { loadLedger, open as openEntries } from "../ledger.mjs";
import { isAuthorized, itemLine, loadPlan, planPath, waiting } from "../plan.mjs";
import { POLICY } from "../config.mjs";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectFiles } from "../tools/look.mjs";
import { UI_ERROR_CODE, UI_ERROR_KIND } from "./contracts.mjs";
import { uiCancelled, uiError, uiErrorFrom, uiFailure, uiSuccess } from "./result.mjs";

export const WORKSPACE_QUERY = Object.freeze({
	atlas: "workspace.atlas",
	ledger: "workspace.ledger",
	plan: "workspace.plan",
	requests: "workspace.requests",
	status: "workspace.status",
	entry: "workspace.entry",
	context: "workspace.context",
	tree: "workspace.tree",
});

const nonEmpty = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
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

/** Source positions are presentation metadata, read only after this facade has yielded out of the UI stack. */
const jsonLines = (file, field, values) => {
	try {
		const text = readFileSync(file, "utf8");
		return Object.fromEntries(values.map((value) => {
			const at = text.indexOf(`"${field}": ${JSON.stringify(value)}`);
			return [value, at < 0 ? undefined : text.slice(0, at).split("\n").length];
		}));
	} catch {
		return {};
	}
};

/** Leave the caller's current key/render stack before one of the legacy readers touches disk. */
const afterCurrentTurn = () => new Promise((resolve) => queueMicrotask(resolve));

const DEFAULT_READERS = Object.freeze({ loadAtlas, loadLedger, loadPlan, loadContext });

/**
 * @param {{
 *   brainDir: string,
 *   root?: string,
 *   readers?: typeof DEFAULT_READERS,
 *   now?: () => number,
 * }} options
 */
export function createWorkspaceQueries({ brainDir, root, readers = DEFAULT_READERS, now = () => Date.now() }) {
	if (nonEmpty(brainDir) === undefined) throw new TypeError("Workspace queries need a brain directory.");
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
		await afterCurrentTurn();
		if (options?.signal?.aborted === true) return { meta, result: uiCancelled({ meta }) };
		return { meta };
	};
	const read = async (name, key, loader, options = {}, projection = undefined) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		try {
			const loaded = loader(brainDir);
			if (loaded?.[key] === undefined) return unavailable(name, loaded?.error, ready.meta);
			return uiSuccess({ [key]: loaded[key], file: paths[key], ...(typeof projection === "function" ? projection(loaded[key]) : {}) }, { meta: ready.meta });
		} catch (error) {
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
			return uiSuccess({
				atlas: loadedAtlas.atlas,
				attention: attentionSnapshot(root, loadedAtlas.atlas, { active }),
				lines: jsonLines(paths.atlas, "name", loadedAtlas.atlas.nodes.map((node) => node.name)),
				file: paths.atlas,
				issues,
			}, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not read the graph.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	const tree = async (options = {}) => {
		const ready = await prepare(options);
		if (ready.result !== undefined) return ready.result;
		if (nonEmpty(root) === undefined) return invalid("A project root is needed before listing its files.", "root", ready.meta);
		try {
			const loadedAtlas = readers.loadAtlas(brainDir);
			const issues = loadedAtlas.atlas === undefined ? [{ source: "atlas", message: loadedAtlas.error ?? "The graph cannot be read." }] : [];
			const files = projectFiles(root).map((path) => {
				try { return { path, bytes: statSync(join(root, path)).size }; }
				catch { return { path }; }
			});
			return uiSuccess({
				files,
				marks: loadedAtlas.atlas === undefined ? {} : Object.fromEntries(fileMarks(loadedAtlas.atlas)),
				issues,
			}, { meta: ready.meta });
		} catch (error) {
			return uiFailure(uiErrorFrom(error, {
				code: UI_ERROR_CODE.internal,
				kind: UI_ERROR_KIND.internal,
				message: "Cartographer could not list the project files.",
				retryable: true,
			}), { meta: ready.meta });
		}
	};
	const ledger = (options = {}) => read("ledger", "ledger", readers.loadLedger, options, (loaded) => ({
		lines: jsonLines(paths.ledger, "id", loaded.items.map((item) => item.id)),
	}));
	const plan = (options = {}) => read("plan", "plan", readers.loadPlan, options, (loaded) => ({
		lines: jsonLines(paths.plan, "id", [...loaded.items, ...loaded.moves].map((item) => item.id)),
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
				const lines = jsonLines(paths.plan, "id", [...loadedPlan.plan.items, ...loadedPlan.plan.moves].map((item) => item.id));
				if (!yolo) for (const move of waiting(loadedPlan.plan)) items.push({ id: move.id, kind: "approval", text: itemLine(move), file: paths.plan, line: lines[move.id] });
			}
			if (loadedLedger.ledger === undefined) issues.push({ source: "ledger", message: loadedLedger.error ?? "The ledger cannot be read." });
			else {
				const lines = jsonLines(paths.ledger, "id", loadedLedger.ledger.items.map((item) => item.id));
				for (const item of loadedLedger.ledger.items) if (item.kind === POLICY.enums.ledgerKind.question && item.status === POLICY.enums.entryStatus.open && item.archived !== true) items.push({ id: item.id, kind: POLICY.enums.ledgerKind.question, text: `${item.id}  ${item.text}`, file: paths.ledger, line: lines[item.id] });
			}
			return uiSuccess({ items, issues }, { meta: ready.meta });
		} catch (error) {
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
				try {
					return { item, text: shelfText(root, item, brainDir) };
				} catch (error) {
					issues.push({ source: `shelf:${item.id ?? item.path ?? "item"}`, message: error instanceof Error ? error.message : String(error) });
					return { item, text: "(the shelf snapshot cannot be read)" };
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

	return Object.freeze({ paths, atlas, tree, ledger, plan, requests, status, context, entry });
}
