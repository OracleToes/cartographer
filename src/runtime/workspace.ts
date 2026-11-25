/**
 * The project boundary (§6).
 *
 * Every Carto tool that names a path resolves it against the project root, and
 * `.brain` is refused before the package's file tools ever see the path — a
 * scoping boundary, not a trust gate (§6.1). The shell cannot be scoped this
 * way; its cwd is the root and the boundary is what the agentic tools enforce.
 */
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class WorkspaceError extends Error {}

/** `.brain` named by a tool path: scoped out, not a permission the agent lacks. */
export class BrainWallError extends Error {}

/**
 * `.brain` is not the agent's (§6.2). Refusing it here keeps the wall in one
 * place: every file tool passes through it, and the package's tools never see
 * the path.
 */
export function refuseBrainPath(rootReal: string, real: string): void {
  const rel = relative(rootReal, real);
  if (rel === "") return;
  if (rel.split(sep).includes(".brain")) {
    throw new BrainWallError(
      "`.brain` is the Brain's own storage, and no tool reads, lists, or writes it. Work with the project files, and with the records your handles name.",
    );
  }
}

/** Lexically resolve a path inside the root, without requiring it to exist. Throws WorkspaceError. */
export function lexicalProjectPath(root: string, path: string): string {
  const rootReal = realpathSync(root);
  const named = resolve(root, path);
  const fromRoot = relative(resolve(root), named);
  const candidate = fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
    ? resolve(rootReal, fromRoot) : named;
  const rel = relative(rootReal, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new WorkspaceError(
      `that path resolves outside the project root (${candidate}), and everything you touch is inside it. Name a path relative to the root.`,
    );
  }
  refuseBrainPath(rootReal, candidate);
  return candidate;
}


/** Person-owned project settings live outside the agent's Brain projection. */
export type PathScope = "strict" | "relaxed";
export interface ProjectSettings { readOnly: boolean; pathScope: PathScope }

export function readProjectSettings(root: string): ProjectSettings {
  const path = join(root, ".brain", "settings.json");
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { readOnly: false, pathScope: "strict" };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`Invalid project settings at ${path}: not valid JSON.`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid project settings at ${path}.`);
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || (data.readOnly !== undefined && typeof data.readOnly !== "boolean") ||
      (data.pathScope !== undefined && data.pathScope !== "strict" && data.pathScope !== "relaxed")) {
    throw new Error(`Invalid project settings at ${path}: expected version 1, a boolean readOnly, and strict or relaxed pathScope.`);
  }
  return { readOnly: data.readOnly === true, pathScope: data.pathScope === "relaxed" ? "relaxed" : "strict" };
}

/** Merge and atomically replace the settings file before updating live state. */
export function writeProjectSettings(root: string, update: Partial<ProjectSettings>): ProjectSettings {
  const next = { ...readProjectSettings(root), ...update };
  const directory = join(root, ".brain");
  const path = join(directory, "settings.json");
  mkdirSync(directory, { recursive: true });
  const temp = join(directory, `.settings-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
  return next;
}

/** Guard the actual path used by a package tool, including existing symlink targets. */
export function assertFileScope(root: string, path: string, scope: PathScope): void {
  const named = resolve(root, path);
  const rootReal = realpathSync(root);
  const fromRoot = relative(resolve(root), named);
  const absolute = fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
    ? resolve(rootReal, fromRoot) : named;
  refuseBrainPath(resolve(sep), absolute);
  if (scope === "strict") lexicalProjectPath(rootReal, absolute);
  // For a not-yet-existing create target, resolve its closest existing parent.
  let ancestor = absolute;
  while (true) {
    try {
      const actual = resolve(realpathSync(ancestor), relative(ancestor, absolute));
      refuseBrainPath(resolve(sep), actual);
      if (scope === "strict") lexicalProjectPath(rootReal, actual);
      return;
    } catch (error) {
      if (error instanceof BrainWallError || error instanceof WorkspaceError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      try {
        if (lstatSync(ancestor).isSymbolicLink()) throw new WorkspaceError(`Cannot use an unresolved symlink: ${ancestor}`);
      } catch (statError) {
        if (statError instanceof WorkspaceError) throw statError;
        const statCode = (statError as NodeJS.ErrnoException).code;
        if (statCode !== "ENOENT" && statCode !== "ENOTDIR") throw statError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

/** The pin names a project entry; its symlink target may be outside the project. */
export function resolvePinnedFile(root: string, path: string): string {
  const resolved = lexicalProjectPath(root, path);
  assertFileScope(root, resolved, "relaxed");
  return resolved;
}

/** Recognize the image families Pi reads. File contents, not extensions, decide. */
export function isImageFile(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(16);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const head = bytes.subarray(0, length);
    return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
      (length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
      (length >= 6 && (head.toString("ascii", 0, 6) === "GIF87a" || head.toString("ascii", 0, 6) === "GIF89a")) ||
      (length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") ||
      (length >= 2 && head.toString("ascii", 0, 2) === "BM");
  } finally { closeSync(fd); }
}

/** Verify a pin is readable now; it will be checked again when the head is rebuilt. */
export function assertPinnableFile(root: string, path: string): void {
  const resolved = resolvePinnedFile(root, path);
  try {
    if (!statSync(resolved).isFile()) throw new WorkspaceError(`Cannot pin ${path}: it is not a regular file.`);
    // Check readability now as well as again at collapse; the file may change later.
    accessSync(resolved, constants.R_OK);
    if (isImageFile(resolved)) throw new WorkspaceError(`Cannot pin ${path}: image pins are not supported yet.`);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(`Cannot pin ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Resolve a saved read reference using the same aliases and fallback variants as Pi.
 * Guard each candidate before inspecting it, just as the live tool does. */
export function resolveReadReference(root: string, path: string, scope: PathScope): string {
  let normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  else if (normalized.startsWith("file://")) {
    try { normalized = fileURLToPath(normalized); } catch { /* Pi treats malformed URLs as paths. */ }
  }
  const absolute = resolve(root, normalized);
  const variants = [absolute, absolute.replace(/ (AM|PM)\./gi, "\u202F$1."), absolute.normalize("NFD"),
    absolute.replace(/'/g, "\u2019"), absolute.normalize("NFD").replace(/'/g, "\u2019")];
  for (const variant of new Set(variants)) {
    assertFileScope(root, variant, scope);
    if (existsSync(variant)) return variant;
  }
  return absolute;
}
