// Stable references for project files and Cartographer-owned catalog metadata.
// Paths are locators, never identities. File bytes are retained by digest under .atlas/catalog/versions so pinned
// references remain exact after an edit or removal. pi-durable 1.5.2's public tool API does not expose DocumentId
// allocation/lookup for app-owned documents, so the file catalog uses its own opaque ID while preserving the
// brain-store namespace and native Durable IDs for Durable-owned conversations and entries.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { BRAIN } from "./project.mjs";
import { confine } from "./tools/look.mjs";

const VERSION = 1;
const ID = /^f-[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const catalogPath = (brainDir) => join(brainDir, "catalog.json");
const forkJournalPath = (brainDir) => join(brainDir, "catalog-fork.pending.json");
const versionPath = (brainDir, id, digest) => join(brainDir, "catalog", "versions", id, digest);
const entityVersionPath = (brainDir, ref) => join(brainDir, "catalog", "entities", sha256(JSON.stringify([ref.kind, ref.id])), `${ref.version}.json`);

/** Complete an interrupted namespace fork before any reference can be resolved. */
function recoverFork(brainDir) {
	const journal = forkJournalPath(brainDir);
	if (!existsSync(journal)) return;
	let pending;
	try { pending = JSON.parse(readFileSync(journal, "utf8")); }
	catch (error) { throw new CatalogError(`${journal} is corrupt; refusing catalog access: ${error.message}`); }
	const catalog = catalogPath(brainDir);
	const context = join(brainDir, "carto-context.json");
	const safeTemp = (name, prefix) => typeof name === "string" && name.startsWith(`${prefix}.`) && name.endsWith(".tmp") && !name.includes("/") && !name.includes("\\");
	if (pending?.version !== 1 || typeof pending.next !== "string" || !safeTemp(pending.catalogTemp, "catalog.json") || (pending.contextTemp !== null && (!safeTemp(pending.contextTemp, "carto-context.json") || typeof pending.contextHash !== "string" || !DIGEST.test(pending.contextHash)))) throw new CatalogError(`${journal} has an invalid transaction record; refusing catalog access`);
	const catalogTemp = join(brainDir, pending.catalogTemp);
	if (existsSync(catalogTemp)) renameSync(catalogTemp, catalog);
	else {
		let current;
		try { current = JSON.parse(readFileSync(catalog, "utf8")); } catch { current = undefined; }
		if (current?.namespace !== pending.next) throw new CatalogError(`${journal} lost its staged catalog; refusing to expose mixed namespace references`);
	}
	if (pending.contextTemp !== null) {
		const contextTemp = join(brainDir, pending.contextTemp);
		if (existsSync(contextTemp)) renameSync(contextTemp, context);
		else {
			let currentHash;
			try { currentHash = sha256(readFileSync(context)); } catch { currentHash = undefined; }
			if (currentHash !== pending.contextHash) throw new CatalogError(`${journal} lost its staged context update; refusing to expose mixed namespace references`);
		}
	}
	unlinkSync(journal);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Deterministic JSON serialization for content versions: object keys sorted at every level, no insignificant
 * whitespace, and the JSON semantics for omitted/non-JSON values. Two values that differ only in key order hash
 * identically, which is what keeps `expectedVersion` stable across re-serializations.
 */
export const canonicalJson = (value) => {
	if (value === null || value === undefined) return "null";
	const type = typeof value;
	if (type === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (type === "boolean" || type === "string") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((item) => item === undefined || typeof item === "function" || typeof item === "symbol" ? "null" : canonicalJson(item)).join(",")}]`;
	}
	if (type === "object") {
		const parts = [];
		for (const key of Object.keys(value).sort()) {
			const item = value[key];
			if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
			parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
		}
		return `{${parts.join(",")}}`;
	}
	return "null";
};

/** The content version of any JSON value: the SHA-256 of its canonical bytes. Files keep bytes-hash versions. */
export const contentVersion = (value) => sha256(canonicalJson(value ?? null));

export class CatalogError extends Error {}

const empty = () => ({ version: VERSION, namespace: randomUUID(), files: [] });

/** Read metadata without ever replacing a corrupt catalog. */
export function loadCatalog(brainDir) {
	recoverFork(brainDir);
	const path = catalogPath(brainDir);
	if (!existsSync(path)) return empty();
	let value;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new CatalogError(`${path} is not valid JSON (${error.message}); nothing was changed`);
	}
	if (value === null || typeof value !== "object" || value.version !== VERSION || typeof value.namespace !== "string" || !Array.isArray(value.files)) {
		throw new CatalogError(`${path} has an unsupported or incomplete catalog format; nothing was changed`);
	}
	const ids = new Set();
	const paths = new Set();
	for (const [index, file] of value.files.entries()) {
		if (file === null || typeof file !== "object" || typeof file.id !== "string" || !ID.test(file.id) || ids.has(file.id)) throw new CatalogError(`${path}: invalid or repeated file identity at record ${index + 1}`);
		if (typeof file.path !== "string" || file.path === "" || (file.deleted !== true && paths.has(file.path))) throw new CatalogError(`${path}: invalid or repeated file path at record ${index + 1}`);
		if (file.version !== undefined && !DIGEST.test(file.version)) throw new CatalogError(`${path}: invalid content version at ${file.id}`);
		ids.add(file.id);
		if (file.deleted !== true) paths.add(file.path);
	}
	return value;
}

/**
 * Load the catalog, creating the empty namespace anchor on first use. References minted against a transient random
 * namespace would be meaningless, so every caller that needs the namespace goes through here; after the first call this
 * is a plain read.
 */
export function ensureCatalog(brainDir) {
	const catalog = loadCatalog(brainDir);
	if (!existsSync(catalogPath(brainDir))) {
		saveCatalog(brainDir, catalog);
		return loadCatalog(brainDir);
	}
	return catalog;
}

/** Atomic replacement of the catalog metadata. */
export function saveCatalog(brainDir, catalog) {
	const path = catalogPath(brainDir);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(catalog, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

/** Explicitly fork a copied brain store: rotate its namespace and rebind Cartographer-owned saved refs. */
export function forkCatalogNamespace(brainDir) {
	const catalog = loadCatalog(brainDir);
	const previous = catalog.namespace;
	const next = randomUUID();
	const contextFile = join(brainDir, "carto-context.json");
	let context;
	if (existsSync(contextFile)) {
		try { context = JSON.parse(readFileSync(contextFile, "utf8")); }
		catch (error) { throw new CatalogError(`${contextFile} is invalid; nothing was changed: ${error.message}`); }
	}
	if (context !== undefined) {
		const rebind = (value) => {
			if (Array.isArray(value)) return value.forEach(rebind);
			if (value === null || typeof value !== "object") return;
			if (value.namespace === previous && typeof value.kind === "string" && typeof value.id === "string") value.namespace = next;
			for (const child of Object.values(value)) rebind(child);
		};
		rebind(context);
	}
	const updatedCatalog = { ...catalog, namespace: next, sourceNamespace: previous };
	mkdirSync(brainDir, { recursive: true });
	const catalogTemp = `${catalogPath(brainDir)}.${process.pid}.${randomUUID()}.tmp`;
	const contextTemp = context === undefined ? null : `${contextFile}.${process.pid}.${randomUUID()}.tmp`;
	const journal = forkJournalPath(brainDir);
	const journalTemp = `${journal}.${process.pid}.${randomUUID()}.tmp`;
	const contextText = context === undefined ? undefined : `${JSON.stringify(context, null, "\t")}\n`;
	try {
		writeFileSync(catalogTemp, `${JSON.stringify(updatedCatalog, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
		if (contextTemp !== null) writeFileSync(contextTemp, contextText, { mode: 0o600, flag: "wx" });
		writeFileSync(journalTemp, `${JSON.stringify({ version: 1, previous, next, catalogTemp: catalogTemp.slice(brainDir.length + 1), contextTemp: contextTemp?.slice(brainDir.length + 1) ?? null, ...(contextTemp !== null ? { contextHash: sha256(Buffer.from(contextText)) } : {}) })}\n`, { mode: 0o600, flag: "wx" });
		renameSync(journalTemp, journal);
		recoverFork(brainDir);
	} catch (error) {
		if (!existsSync(journal)) {
			for (const path of [catalogTemp, contextTemp, journalTemp]) if (path !== null) try { unlinkSync(path); } catch { /* absent */ }
		}
		if (error instanceof CatalogError) throw error;
		throw new CatalogError(`Could not complete the namespace fork: ${error.message}; staged recovery will run on the next catalog access when a journal exists`);
	}
	return { previous, namespace: next, rebound: true };
}

function confinedFile(root, given, { mustExist = true } = {}) {
	let path;
	try {
		path = confine(root, given);
	} catch (error) {
		throw new CatalogError(error.message);
	}
	if (path.rel === "." || path.rel.split(sep).includes(BRAIN) || path.rel.split(sep).includes(".git")) throw new CatalogError("brain and git internals are not project-file targets");
	const absolute = resolve(path.abs);
	if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new CatalogError("file path escapes the project root");
	if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) throw new CatalogError("symbolic links are not catalog file targets; use the confined target they point to");
	if (mustExist && !existsSync(absolute)) throw new CatalogError(`${path.rel} does not exist`);
	return { ...path, absolute };
}

function storeVersion(brainDir, id, bytes) {
	const digest = sha256(bytes);
	const path = versionPath(brainDir, id, digest);
	if (existsSync(path)) {
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new CatalogError(`Immutable version storage for ${id} is not a regular file`);
		if (sha256(readFileSync(path)) !== digest) throw new CatalogError(`Immutable version storage for ${id} failed its digest check`);
	} else {
		mkdirSync(dirname(path), { recursive: true });
		const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	}
	return digest;
}

function fileAt(catalog, path) {
	return catalog.files.find((file) => file.path === path && file.deleted !== true);
}

function nextId() {
	return `f-${randomUUID()}`;
}

function refFor(catalog, file, version = file.version) {
	return { namespace: catalog.namespace, kind: "file", id: file.id, ...(version ? { version } : {}) };
}

/**
 * Observe or create an identity for an explicit project-file operation. Edits at a live path preserve identity;
 * copies, unobserved moves, and delete/recreate get new IDs. Explicit rebind is the only move-preservation path.
 */
export function observeFile(root, brainDir, given, { create = false } = {}) {
	const path = confinedFile(root, given, { mustExist: !create });
	let catalog = loadCatalog(brainDir);
	const records = [...catalog.files];
	const previous = fileAt(catalog, path.rel);
	let bytes;
	let stat;
	if (existsSync(path.absolute)) {
		stat = statSync(path.absolute);
		if (!stat.isFile()) throw new CatalogError(`${path.rel} is not a regular file`);
		bytes = readFileSync(path.absolute);
	}
	if (previous !== undefined && stat !== undefined) {
		// A file still present at the same path is an edit even when an editor replaced its inode atomically.
		// If absence is observed first, the tombstone ensures a later recreation gets a new identity.
		const digest = storeVersion(brainDir, previous.id, bytes);
		if (previous.version === digest && previous.dev === stat.dev && previous.ino === stat.ino && previous.size === stat.size) {
			// Nothing changed: do not rewrite the catalog. Reads never amplify into writes.
			return { ref: refFor(catalog, previous), record: previous, bytes, path: path.rel };
		}
		const updated = { ...previous, version: digest, dev: stat.dev, ino: stat.ino, size: stat.size, updatedAt: Date.now() };
		catalog.files = records.map((file) => file.id === previous.id ? updated : file);
		saveCatalog(brainDir, catalog);
		return { ref: refFor(catalog, updated), record: updated, bytes, path: path.rel };
	}
	if (previous !== undefined) {
		const at = records.findIndex((file) => file.id === previous.id);
		records[at] = { ...previous, deleted: true, deletedAt: Date.now() };
	}
	// A new path is a new identity. A move preserves identity only through the explicit rebind operation;
	// matching inodes is not enough to decide whether a move was observed or a copied file was substituted.
	const id = nextId();
	const digest = bytes === undefined ? undefined : storeVersion(brainDir, id, bytes);
	const record = {
		id,
		path: path.rel,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...(digest ? { version: digest } : {}),
		...(stat ? { dev: stat.dev, ino: stat.ino, size: stat.size } : {}),
		...(bytes === undefined ? { deleted: true } : {}),
	};
	records.push(record);
	catalog = { ...catalog, files: records };
	saveCatalog(brainDir, catalog);
	return { ref: refFor(catalog, record), record, bytes, path: path.rel };
}

/** Explicitly rebind an identity to another confined path after an observed move or user confirmation. */
export function rebindFile(root, brainDir, ref, given, expectedVersion) {
	if (!validateReference(ref) || ref.kind !== "file") throw new CatalogError("A valid file reference is required for rebind");
	let catalog = loadCatalog(brainDir);
	if (ref.namespace !== catalog.namespace) throw new CatalogError("The reference belongs to another brain-store namespace");
	const at = catalog.files.findIndex((file) => file.id === ref.id && file.deleted !== true);
	if (at < 0) throw new CatalogError("The file identity is deleted or unknown");
	const file = catalog.files[at];
	if (ref.version !== undefined && ref.version !== expectedVersion) throw new CatalogError(`Stale file reference: requested ${ref.version}, expected ${expectedVersion}`);
	if (expectedVersion !== file.version) throw new CatalogError(`Stale rebind precondition: expected ${expectedVersion ?? "none"}, current ${file.version}`);
	const path = confinedFile(root, given);
	if (catalog.files.some((other, index) => index !== at && other.deleted !== true && other.path === path.rel)) throw new CatalogError(`${path.rel} is already bound to another file identity`);
	const stat = statSync(path.absolute);
	if (!stat.isFile()) throw new CatalogError(`${path.rel} is not a regular file`);
	const bytes = readFileSync(path.absolute);
	const digest = storeVersion(brainDir, file.id, bytes);
	const updated = { ...file, path: path.rel, previousPaths: [...new Set([...(file.previousPaths ?? []), file.path])], version: digest, dev: stat.dev, ino: stat.ino, size: stat.size, updatedAt: Date.now() };
	catalog.files[at] = updated;
	saveCatalog(brainDir, catalog);
	return { ref: refFor(catalog, updated), record: updated };
}

/** Validate and resolve a typed file reference. Exact historical versions are read from immutable backing storage. */
export function resolveFile(root, brainDir, ref) {
	if (!validateReference(ref) || ref.kind !== "file" || (ref.version !== undefined && !DIGEST.test(ref.version))) return { status: "invalid_reference", ref };
	let catalog;
	try { catalog = loadCatalog(brainDir); }
	catch (error) { return { status: "inaccessible", ref, error: error.message }; }
	if (ref.namespace !== catalog.namespace) return { status: "inaccessible", ref, error: "The reference belongs to a different brain-store namespace." };
	let record = catalog.files.find((file) => file.id === ref.id);
	if (record === undefined) return { status: "deleted", ref, error: "No catalog record exists for this file identity." };
	if (ref.version === undefined && record.deleted !== true) {
		// No write on read: staleness is detected here by re-hashing the current bytes below, without re-observing the
		// path. The catalog is only refreshed by explicit operations (an edit, a rebind, an observe).
	}
	const requested = ref.version ?? record.version;
	if (requested === undefined) return { status: "deleted", ref, error: "The file has no recorded content version." };
	let bytes;
	try {
		const savedPath = versionPath(brainDir, record.id, requested);
		const info = lstatSync(savedPath);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error("not a regular file");
		bytes = readFileSync(savedPath);
		if (sha256(bytes) !== requested) throw new Error("digest mismatch");
	} catch { return { status: record.deleted === true ? "deleted" : "stale", ref, requestedVersion: requested, error: "The exact saved file version is unavailable or corrupt." }; }
	if (record.deleted === true) return { status: "deleted", ref, requestedVersion: requested, resolvedVersion: requested, bytes, record };
	let path;
	try { path = confinedFile(root, record.path); }
	catch (error) {
		// Report the deletion without tombstoning it: recording it would be a write on a read path. The next explicit
		// operation observes the absence for real.
		if (!existsSync(resolve(root, record.path))) {
			return { status: "deleted", ref, requestedVersion: requested, resolvedVersion: requested, bytes, record };
		}
		return { status: "inaccessible", ref, error: error.message };
	}
	const currentBytes = readFileSync(path.absolute);
	const currentDigest = sha256(currentBytes);
	if (requested !== currentDigest) return { status: "stale", ref, requestedVersion: requested, resolvedVersion: requested, currentVersion: currentDigest, bytes, record };
	return { status: "live", ref: { ...ref, version: requested }, requestedVersion: requested, resolvedVersion: requested, currentVersion: requested, bytes: currentBytes, record };
}

/** Convert an explicit path into a stable typed file reference. */
export function fileReference(root, brainDir, given, options) {
	return observeFile(root, brainDir, given, options).ref;
}

/** Stable reference for an existing native-ID domain entity. */
export function nativeReference(brainDir, kind, id, version) {
	if (typeof kind !== "string" || kind === "" || typeof id !== "string" || id === "") throw new CatalogError("A kind and native ID are required");
	let catalog = loadCatalog(brainDir);
	if (!existsSync(catalogPath(brainDir))) {
		saveCatalog(brainDir, catalog);
		catalog = loadCatalog(brainDir);
	}
	return { namespace: catalog.namespace, kind, id, ...(version ? { version } : {}) };
}

/** Validate the common reference envelope before target-specific resolution. */
export function validateReference(ref) {
	return ref !== null && typeof ref === "object"
		&& typeof ref.namespace === "string" && ref.namespace.length >= 16
		&& typeof ref.kind === "string" && /^[a-z][A-Za-z0-9_-]{0,63}$/.test(ref.kind)
		&& typeof ref.id === "string" && ref.id.length > 0 && ref.id.length <= 256
		&& (ref.version === undefined || (typeof ref.version === "string" && ref.version.length <= 128));
}

/** Retain an immutable version of a non-file entity under its typed reference. Call only at an explicit pin (e.g. a schema shelf add) or a migration — never on a read path. */
export function retainReferenceVersion(brainDir, ref, value) {
	if (!validateReference(ref) || !DIGEST.test(ref.version ?? "")) throw new CatalogError("A version-pinned reference is required");
	const catalog = loadCatalog(brainDir);
	if (catalog.namespace !== ref.namespace) throw new CatalogError("The reference belongs to another brain-store namespace");
	const bytes = Buffer.from(canonicalJson(value ?? null));
	if (sha256(bytes) !== ref.version) throw new CatalogError("The supplied content does not match the reference version");
	const path = entityVersionPath(brainDir, ref);
	if (existsSync(path)) {
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new CatalogError("Immutable entity-version storage is not a regular file");
		let saved;
		try { saved = JSON.parse(readFileSync(path, "utf8")); } catch { throw new CatalogError("Immutable entity-version storage is corrupt"); }
		if (sha256(Buffer.from(canonicalJson(saved ?? null))) !== ref.version) throw new CatalogError("Immutable entity-version storage failed its digest check");
	} else {
		mkdirSync(dirname(path), { recursive: true });
		const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
		try { renameSync(temp, path); }
		catch (error) { try { unlinkSync(temp); } catch {} if (!existsSync(path)) throw error; }
	}
	return path;
}

/** Resolve an exact retained non-file entity version, or return undefined when unavailable. */
export function readReferenceVersion(brainDir, ref) {
	if (!validateReference(ref) || !DIGEST.test(ref.version ?? "")) return undefined;
	const catalog = loadCatalog(brainDir);
	if (catalog.namespace !== ref.namespace) return undefined;
	const path = entityVersionPath(brainDir, ref);
	try {
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isFile()) return undefined;
		const value = JSON.parse(readFileSync(path, "utf8"));
		return sha256(Buffer.from(canonicalJson(value ?? null))) === ref.version ? value : undefined;
	} catch { return undefined; }
}

/**
 * Read-only counterpart of observing a file: the current identity for a stored relative path, or undefined when the
 * catalog knows no live identity for it. Never creates files, versions, or catalog entries — safe for render paths.
 */
export function fileIdentityForPath(brainDir, relPath) {
	let catalog;
	try { catalog = loadCatalog(brainDir); } catch { return undefined; }
	const record = fileAt(catalog, relPath);
	return record === undefined ? undefined : refFor(catalog, record);
}
