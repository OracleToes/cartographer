// Asynchronous, revision-aware persistence for editable configuration sources.
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { configurationPaths, CONFIGURATION_SOURCE } from "./sources.mjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => Array.isArray(value) ? value.map(clone) : record(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
const freeze = (value) => Object.freeze(value);
const missing = (error) => error?.code === "ENOENT";
const revisionOf = (text) => text === undefined
	? "absent"
	: `sha256:${createHash("sha256").update(text).digest("base64url")}`;
const scopeName = (scope) => scope === CONFIGURATION_SOURCE.install || scope === "install"
	? "install"
	: scope === CONFIGURATION_SOURCE.project || scope === "project"
		? "project"
		: undefined;

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

/**
 * File-backed source adapter. A revision is a content digest, not a mtime: editors must refresh when either values
 * or formatting changed. The source is re-read immediately before its temporary file is atomically renamed.
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

	const readText = async (path, scope) => {
		try {
			return await io.readFile(path, "utf8");
		} catch (error) {
			if (missing(error)) return undefined;
			throw sourceError("read-failed", `Could not read ${scope} configuration at ${path}: ${error.message}`, { cause: error, scope, path });
		}
	};
	const sourceRead = async (path, scope) => {
		const text = await readText(path, scope);
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
	const writable = async (path) => {
		try {
			await io.access(path, 2);
			return true;
		} catch (error) {
			if (!missing(error)) return false;
		}
		let folder = dirname(path);
		while (true) {
			try {
				await io.access(folder, 2);
				return true;
			} catch (error) {
				if (!missing(error)) return false;
				const parent = dirname(folder);
				if (parent === folder) return false;
				folder = parent;
			}
		}
	};
	const atomicWrite = async (path, text, scope) => {
		const folder = dirname(path);
		let temporary;
		try {
			await io.mkdir(folder, { recursive: true });
			temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
			await io.writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
			await io.rename(temporary, path);
		} catch (error) {
			if (temporary !== undefined) {
				try { await io.unlink(temporary); } catch { /* a failed cleanup must not replace the write failure */ }
			}
			throw sourceError("write-failed", `Could not save ${scope} configuration at ${path}: ${error.message}`, { cause: error, scope, path });
		}
	};
	const read = async (scope) => {
		const name = scopeName(scope);
		if (!name) throw sourceError("invalid-source", `Configuration source ${JSON.stringify(scope)} is not readable as a saved configuration source.`, { scope });
		const source = await sourceRead(paths[name], name);
		return freeze({
			scope: name,
			path: source.path,
			values: freeze(clone(source.values)),
			revision: source.revision,
			writable: await writable(source.path),
		});
	};
	const update = async ({ scope, expectedRevision, transform } = {}) => {
		const name = scopeName(scope);
		if (!name) throw sourceError("invalid-source", `Configuration source ${JSON.stringify(scope)} is not writable. Choose install or project.`, { scope });
		if (typeof transform !== "function") throw new TypeError("Configuration writes need a transform function.");
		const before = await sourceRead(paths[name], name);
		if (expectedRevision !== undefined && expectedRevision !== before.revision) {
			throw sourceError("revision-conflict", `The ${name} configuration changed before this edit could be saved. Refresh Settings and try again.`, {
				expectedRevision,
				actualRevision: before.revision,
				scope: name,
				path: paths[name],
			});
		}
		if (!(await writable(paths[name]))) {
			throw sourceError("source-read-only", `The ${name} configuration at ${paths[name]} is not writable.`, { scope: name, path: paths[name] });
		}
		const next = transform(clone(before.values));
		if (!record(next)) throw sourceError("invalid-write", `The ${name} configuration update did not produce one JSON object.`, { scope: name, path: paths[name] });
		let serialized;
		try {
			serialized = `${JSON.stringify(next, null, "\t")}\n`;
		} catch (error) {
			throw sourceError("invalid-write", `The ${name} configuration update could not be saved as JSON: ${error.message}`, { cause: error, scope: name, path: paths[name] });
		}
		// Transforming an editor snapshot can take time; detect an ordinary out-of-band change before the rename.
		const observed = await readText(paths[name], name);
		const actualRevision = revisionOf(observed);
		if (actualRevision !== before.revision) {
			throw sourceError("revision-conflict", `The ${name} configuration changed before this edit could be saved. Refresh Settings and try again.`, {
				expectedRevision: before.revision,
				actualRevision,
				scope: name,
				path: paths[name],
			});
		}
		await atomicWrite(paths[name], serialized, name);
		return freeze({
			scope: name,
			path: paths[name],
			values: freeze(clone(next)),
			revision: revisionOf(serialized),
			writable: await writable(paths[name]),
		});
	};
	return freeze({ paths: freeze({ ...paths }), read, update });
}
