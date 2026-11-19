// Asynchronous, revision-aware persistence for editable configuration sources.
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { configurationPaths, CONFIGURATION_SOURCE } from "./sources.mjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => Array.isArray(value) ? value.map(clone) : record(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
const freeze = (value) => Object.freeze(value);
const missing = (error) => error?.code === "ENOENT";
const aborted = (error) => error?.name === "AbortError" || error?.code === "ABORT_ERR";
const revisionOf = (text) => text === undefined
	? "absent"
	: `sha256:${createHash("sha256").update(text).digest("base64url")}`;
const scopeName = (scope) => scope === CONFIGURATION_SOURCE.install || scope === "install"
	? "install"
	: scope === CONFIGURATION_SOURCE.project || scope === "project"
		? "project"
		: undefined;
const report = (callback, progress) => {
	try { callback?.(progress); } catch { /* Presentation progress cannot interrupt a durable source operation. */ }
};

export class ConfigurationRepositoryError extends Error {
	constructor(code, message, { cause, expectedRevision, actualRevision, scope, path } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ConfigurationRepositoryError";
		this.code = code;
		if (expectedRevision !== undefined) this.expectedRevision = expectedRevision;
		if (actualRevision !== undefined) this.actualRevision = actualRevision;
		if (scope !== undefined) this.scope = scope;
		if (path !== undefined) this.path = path;
	}
}

const sourceError = (code, message, detail) => new ConfigurationRepositoryError(code, message, detail);
const cancelled = (scope, path) => sourceError("cancelled", "Configuration work was cancelled before the saved source changed.", { scope, path });
const checkActive = (signal, scope, path) => {
	if (signal?.aborted === true) throw cancelled(scope, path);
};

/**
 * File-backed source adapter. A revision is a content digest, not a mtime: editors must refresh when either values
 * or formatting changed. Source work accepts an AbortSignal at every reversible boundary. The final rename is the
 * durable commit boundary: once it resolves, an abort stops follow-up waiting but cannot re-label the saved source
 * as cancelled or undo it.
 */
export function createConfigurationRepository({ coreDir, brainDir, env = process.env, paths = configurationPaths({ coreDir, brainDir, env }), fs = {} } = {}) {
	if (!paths?.install || !paths?.project) throw new TypeError("Configuration repository needs install and project paths.");
	const io = {
		readFile: fs.readFile ?? readFile,
		writeFile: fs.writeFile ?? writeFile,
		rename: fs.rename ?? rename,
		mkdir: fs.mkdir ?? mkdir,
		unlink: fs.unlink ?? unlink,
		access: fs.access ?? access,
	};

	const readText = async (path, scope, { signal } = {}) => {
		checkActive(signal, scope, path);
		try {
			const value = await io.readFile(path, signal === undefined ? "utf8" : { encoding: "utf8", signal });
			checkActive(signal, scope, path);
			return value;
		} catch (error) {
			if (error instanceof ConfigurationRepositoryError) throw error;
			if (aborted(error)) throw cancelled(scope, path);
			if (missing(error)) return undefined;
			throw sourceError("read-failed", `Could not read ${scope} configuration at ${path}: ${error.message}`, { cause: error, scope, path });
		}
	};
	const sourceRead = async (path, scope, { signal } = {}) => {
		const text = await readText(path, scope, { signal });
		checkActive(signal, scope, path);
		if (text === undefined) return { path, scope, text, values: {}, revision: revisionOf(text) };
		try {
			const values = JSON.parse(text);
			if (!record(values)) throw new TypeError("the file must contain one JSON object");
			return { path, scope, text, values, revision: revisionOf(text) };
		} catch (error) {
			throw sourceError("invalid-json", `Could not parse ${scope} configuration at ${path}: ${error.message}`, { cause: error, scope, path });
		}
	};
	// A missing .brain directory can be created during an atomic project write. Look upward to the first existing
	// parent rather than calling a missing file read-only just because its immediate folder is not there yet.
	const writable = async (path, scope, { signal } = {}) => {
		checkActive(signal, scope, path);
		try {
			await io.access(path, 2);
			checkActive(signal, scope, path);
			return true;
		} catch (error) {
			if (error instanceof ConfigurationRepositoryError) throw error;
			if (signal?.aborted === true) throw cancelled(scope, path);
			if (!missing(error)) return false;
		}
		let folder = dirname(path);
		while (true) {
			checkActive(signal, scope, path);
			try {
				await io.access(folder, 2);
				checkActive(signal, scope, path);
				return true;
			} catch (error) {
				if (error instanceof ConfigurationRepositoryError) throw error;
				if (signal?.aborted === true) throw cancelled(scope, path);
				if (!missing(error)) return false;
				const parent = dirname(folder);
				if (parent === folder) return false;
				folder = parent;
			}
		}
	};
	const atomicWrite = async (path, text, scope, { signal, reportProgress, onCommitted } = {}) => {
		const folder = dirname(path);
		let temporary;
		let committed = false;
		try {
			checkActive(signal, scope, path);
			report(reportProgress, { message: `Preparing ${scope} configuration storage.` });
			await io.mkdir(folder, { recursive: true });
			checkActive(signal, scope, path);
			temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
			report(reportProgress, { message: `Writing temporary ${scope} configuration.` });
			await io.writeFile(temporary, text, signal === undefined
				? { encoding: "utf8", mode: 0o600 }
				: { encoding: "utf8", mode: 0o600, signal });
			checkActive(signal, scope, path);
			report(reportProgress, { message: `Saving ${scope} configuration.` });
			await io.rename(temporary, path);
			committed = true;
			temporary = undefined;
			// This callback is deliberately immediately after rename. A job uses it to distinguish an abort that can
			// still prevent a commit from one that can only stop a provenance refresh.
			try { onCommitted?.({ scope, path, revision: revisionOf(text) }); } catch { /* ownership observation is not persistence */ }
			report(reportProgress, { message: `Saved ${scope} configuration.` });
			return true;
		} catch (error) {
			if (!committed && temporary !== undefined) {
				try { await io.unlink(temporary); } catch { /* a failed cleanup must not replace the write failure */ }
			}
			if (error instanceof ConfigurationRepositoryError) throw error;
			if (aborted(error)) throw cancelled(scope, path);
			throw sourceError("write-failed", `Could not save ${scope} configuration at ${path}: ${error.message}`, { cause: error, scope, path });
		}
	};
	const read = async (scope, { signal, reportProgress } = {}) => {
		const name = scopeName(scope);
		if (!name) throw sourceError("invalid-source", `Configuration source ${JSON.stringify(scope)} is not readable as a saved configuration source.`, { scope });
		report(reportProgress, { message: `Reading ${name} configuration.` });
		const source = await sourceRead(paths[name], name, { signal });
		checkActive(signal, name, source.path);
		report(reportProgress, { message: `Checking ${name} configuration permissions.` });
		const isWritable = await writable(source.path, name, { signal });
		checkActive(signal, name, source.path);
		return freeze({
			scope: name,
			path: source.path,
			values: freeze(clone(source.values)),
			revision: source.revision,
			writable: isWritable,
		});
	};
	const update = async ({ scope, expectedRevision, transform, signal, reportProgress, onCommitted } = {}) => {
		const name = scopeName(scope);
		if (!name) throw sourceError("invalid-source", `Configuration source ${JSON.stringify(scope)} is not writable. Choose install or project.`, { scope });
		if (typeof transform !== "function") throw new TypeError("Configuration writes need a transform function.");
		report(reportProgress, { message: `Reading ${name} configuration before saving.` });
		const before = await sourceRead(paths[name], name, { signal });
		checkActive(signal, name, paths[name]);
		if (expectedRevision !== undefined && expectedRevision !== before.revision) {
			throw sourceError("revision-conflict", `The ${name} configuration changed before this edit could be saved. Refresh Settings and try again.`, {
				expectedRevision,
				actualRevision: before.revision,
				scope: name,
				path: paths[name],
			});
		}
		report(reportProgress, { message: `Checking ${name} configuration permissions.` });
		if (!(await writable(paths[name], name, { signal }))) {
			throw sourceError("source-read-only", `The ${name} configuration at ${paths[name]} is not writable.`, { scope: name, path: paths[name] });
		}
		checkActive(signal, name, paths[name]);
		const next = transform(clone(before.values));
		checkActive(signal, name, paths[name]);
		if (!record(next)) throw sourceError("invalid-write", `The ${name} configuration update did not produce one JSON object.`, { scope: name, path: paths[name] });
		let serialized;
		try {
			serialized = `${JSON.stringify(next, null, "\t")}\n`;
		} catch (error) {
			throw sourceError("invalid-write", `The ${name} configuration update could not be saved as JSON: ${error.message}`, { cause: error, scope: name, path: paths[name] });
		}
		checkActive(signal, name, paths[name]);
		// Transforming an editor snapshot can take time; detect an ordinary out-of-band change before the rename.
		report(reportProgress, { message: `Checking ${name} configuration revision.` });
		const observed = await readText(paths[name], name, { signal });
		const actualRevision = revisionOf(observed);
		if (actualRevision !== before.revision) {
			throw sourceError("revision-conflict", `The ${name} configuration changed before this edit could be saved. Refresh Settings and try again.`, {
				expectedRevision: before.revision,
				actualRevision,
				scope: name,
				path: paths[name],
			});
		}
		await atomicWrite(paths[name], serialized, name, { signal, reportProgress, onCommitted });
		// No abort check follows the rename. It committed the source, so a caller that left can only stop waiting.
		return freeze({
			scope: name,
			path: paths[name],
			values: freeze(clone(next)),
			revision: revisionOf(serialized),
			writable: true,
		});
	};
	return freeze({ paths: freeze({ ...paths }), read, update });
}
