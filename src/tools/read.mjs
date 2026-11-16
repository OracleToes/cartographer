// Top-level `read`: transient, single-file inspection of project text files.
//
// Returns exact UTF-8 lines with no line numbers (so what is seen matches `file edit`), stamped with the catalog
// file ID and SHA-256 digest (`· file f1 @<64 hex>`). Ephemeral in context: `dressReads` keeps the newest successful
// read at `<read-tail>` and folds earlier reads to one line; keeping several files in view together belongs to `shelf`.
import { defineTool } from "@earendil-works/pi-durable";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";
import { POLICY } from "../config.mjs";
import { charsPerTokenNow } from "../calibrate.mjs";
import { ensureCatalog, fileReference, resolveFile, validateReference } from "../catalog.mjs";
import { describe } from "../prompt.mjs";

const count = (n) => Math.round(n).toLocaleString("en-US");
const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
const textResult = (text, details = {}) => ({ output: [{ type: "text", text }], details });
const isCatalogFileId = (id) => /^f(\d+|-[0-9a-f]{8}-)/i.test(String(id ?? ""));

export const noFileRecord = (id) =>
	`There is no file record for ID ${JSON.stringify(String(id ?? ""))}. Pass project-relative \`path\`, or use a file ID from \`book\` file create ("File id: f1") or \`read\` ("· file f1 @<64 hex>").`;

/** Render the requested line slice with exact file bytes (no line numbers) and the catalog identity header. */
export function renderReadSelection(bytes, path, range, id, version) {
	let text;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw new Error("file is not valid UTF-8 text"); }
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	let from = 1;
	let to = Math.min(lines.length, POLICY.limits.look.readDefaultLines);
	if (range !== undefined && String(range).trim() !== "") {
		const match = /^(\d+)\s*(?:-|to|\.\.)\s*(\d+)$/.exec(String(range).trim());
		if (!match) throw new Error('range must look like "10-80"');
		from = Number(match[1]);
		to = Number(match[2]);
		if (from < 1 || to < from || to - from + 1 > POLICY.limits.look.readMaxLines) {
			throw new Error(`range must be ${POLICY.limits.look.readMaxLines} lines or fewer, starting at line 1 or later`);
		}
		if (from > lines.length && lines.length > 0) throw new Error(`file has ${lines.length} lines; line ${from} does not exist`);
		to = Math.min(to, lines.length);
	}
	const clip = POLICY.limits.look.lineChars;
	const ceiling = POLICY.limits.look.readTokenCeiling;
	let ceilingHit = false;
	let taken = 0;
	const body = [];
	for (const line of lines.slice(Math.max(0, from - 1), to)) {
		const shown = line.length > clip ? `${line.slice(0, clip)} …[line cut: ${line.length} characters]` : line;
		const cost = Math.ceil(shown.length / charsPerTokenNow()) + 1;
		if (body.length > 0 && taken + cost > ceiling) {
			ceilingHit = true;
			break;
		}
		taken += cost;
		body.push(shown);
	}
	const last = from + body.length - 1;
	const more = last < lines.length
		? `\n${ceilingHit ? `(stopped at the ~${ceiling}-token read ceiling; ` : "("}${lines.length - last} more lines; ask for range ${last + 1}-${Math.min(lines.length, last + POLICY.limits.look.readDefaultLines)})`
		: "";
	return `== ${path} (lines ${from}-${Math.max(from - 1, last)} of ${lines.length}) · file ${id}${version === undefined ? "" : ` @${version}`}\n${body.join("\n")}${more}`;
}

/** Shared file-read executor used by top-level `read` and unadvertised `book` transcript replay. */
export function runFileRead({ root, brainDir }, args) {
	let ref = args?.ref;
	const pinnedVersion = typeof args?.version === "string" && args.version.trim() !== "" ? args.version.trim() : undefined;
	try {
		if (ref !== undefined) {
			const namespace = ref.namespace ?? ensureCatalog(brainDir).namespace;
			ref = { ...ref, namespace, kind: ref.kind ?? "file", ...(pinnedVersion !== undefined && ref.version === undefined ? { version: pinnedVersion } : {}) };
		} else if (typeof args?.id === "string" && args.id.trim() !== "") {
			ref = { namespace: ensureCatalog(brainDir).namespace, kind: "file", id: args.id.trim(), ...(pinnedVersion !== undefined ? { version: pinnedVersion } : {}) };
		} else {
			if (typeof args?.path !== "string" || args.path.trim() === "") return fail("read needs `path` or catalog file `id`.");
			const observed = fileReference(root, brainDir, args.path);
			ref = { namespace: observed.namespace, kind: "file", id: observed.id, ...(pinnedVersion !== undefined ? { version: pinnedVersion } : {}) };
		}
	} catch (error) {
		return fail(`Could not resolve the file reference: ${error.message}.`);
	}
	if (!validateReference(ref) || ref.kind !== "file") return fail("Invalid file reference; expected `path` or catalog file `id`.");
	let result = resolveFile(root, brainDir, ref);
	if (result.status !== "live" && result.error === "No catalog record exists for this file identity." && ref.version === undefined && !isCatalogFileId(ref.id)) {
		try {
			const observed = fileReference(root, brainDir, ref.id);
			ref = { namespace: observed.namespace, kind: "file", id: observed.id };
			result = resolveFile(root, brainDir, ref);
		} catch { /* keep missing-record error */ }
	}
	const readablePinned = ["stale", "deleted"].includes(result.status) && result.bytes !== undefined && ref.version !== undefined;
	const record = result.record;
	if (result.status !== "live" && !readablePinned) {
		return fail(
			result.error === "No catalog record exists for this file identity."
				? noFileRecord(ref.id)
				: `File resolution status: ${result.status}. ${result.error ?? `Requested ${result.requestedVersion ?? "current"}; current is ${result.currentVersion ?? "unavailable"}.`}`,
		);
	}
	if (result.bytes.byteLength > POLICY.limits.look.fileBytes) {
		return fail(`The file is ${count(result.bytes.byteLength)} bytes, over the ${count(POLICY.limits.look.fileBytes)}-byte read limit. Pin a smaller line range with \`shelf\` (action="add", range="1-200").`);
	}
	if (result.bytes.subarray(0, POLICY.limits.look.binaryProbeChars).includes(0)) return fail("This file appears to be binary and cannot be returned as text.");
	let selected;
	try { selected = renderReadSelection(result.bytes, record.path, args?.range, ref.id, result.resolvedVersion ?? result.currentVersion); }
	catch (error) { return fail(`Cannot read the requested selection: ${error.message}.`); }
	return textResult(`${selected}${readablePinned ? "\n(a pinned historical version; the current content differs)" : ""}`, {
		ref: result.ref ?? ref,
		status: result.status,
		version: result.resolvedVersion ?? result.currentVersion,
	});
}

/**
 * @param {{ root: string, brainDir: string }} input
 */
export function readTool({ root, brainDir }) {
	const validationSchema = obj({
		path: opt(str({ minLength: 1, pattern: "\\S", description: "Project-relative file path to inspect." })),
		id: opt(str({ minLength: 1, maxLength: 256, description: "Catalog file ID (such as f1 from a create/read header), or a project-relative path." })),
		range: opt(str({ description: `Optional line range such as "1-120" (default 1-${POLICY.limits.look.readDefaultLines}, at most ${POLICY.limits.look.readMaxLines} lines and ~${count(POLICY.limits.look.readTokenCeiling)} tokens).` })),
		version: opt(str({ description: "Optional 64-hex SHA-256 content digest to inspect a pinned historical version; omit for the live file." })),
	});
	const validate = compile(validationSchema, { coerce: true });
	const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
	return defineTool({
		name: "read",
		description: describe("read"),
		parameters: validationSchema,
		prepareArguments(args) {
			const parsed = validate.parse(args);
			if (!parsed.ok) {
				const path = (pointer) => pointer === "" ? "root" : pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")).join(".");
				const errors = [...parsed.errors].map((error) => `  - ${path(error.path)}: ${error.message}`).join("\n");
				throw new Error(`Validation failed for tool "read":\n${errors}`);
			}
			const value = parsed.value;
			const hasPath = nonEmpty(value.path);
			const hasId = nonEmpty(value.id);
			if (!hasPath && !hasId) {
				throw new Error('Validation failed for tool "read": read needs `path` or `id`. read takes: path or id (from a create/read header `· file f1`), optional range ("10-80") and optional version.');
			}
			// Never mutate frozen harness arguments; carry a fresh object.
			const out = {};
			if (hasPath) out.path = value.path.trim();
			if (hasId) out.id = value.id.trim();
			if (nonEmpty(value.range)) out.range = value.range.trim();
			if (nonEmpty(value.version)) out.version = value.version.trim();
			return out;
		},
		replay: POLICY.enums.toolReplay.safe,
		execute: async (args) => runFileRead({ root, brainDir }, args),
	});
}
