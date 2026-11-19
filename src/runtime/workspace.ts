import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { brainDirectory, isInsideRoot } from "./paths.js";

export const MAX_INSPECT_BYTES = 1_000_000;
export const MAX_INSPECT_LINES = 500;

export interface InspectRequest {
  path: string;
  startLine: number;
  endLine: number;
}

export interface InspectedFile {
  path: string;
  startLine: number;
  endLine: number;
  digest: string;
  excerpt: string;
}

export interface ProjectFile {
  root: string;
  path: string;
  relativePath: string;
}

export class WorkspaceError extends Error {}

export async function inspectProjectFile(projectRoot: string, request: InspectRequest): Promise<InspectedFile> {
  if (!Number.isInteger(request.startLine) || request.startLine < 1) {
    throw new WorkspaceError("The first line must be a positive integer.");
  }
  if (!Number.isInteger(request.endLine) || request.endLine < request.startLine) {
    throw new WorkspaceError("The last line must be at or after the first line.");
  }
  if (request.endLine - request.startLine + 1 > MAX_INSPECT_LINES) {
    throw new WorkspaceError(`Mini reads at most ${MAX_INSPECT_LINES} lines at one time.`);
  }

  const file = await resolveProjectFile(projectRoot, request.path);
  const bytes = await readBoundedFile(file.path);
  if (bytes.includes(0)) throw new WorkspaceError("Mini does not inspect binary files in version one.");
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/);
  if (request.startLine > lines.length) throw new WorkspaceError("The first line is outside the file.");

  return {
    path: file.relativePath,
    startLine: request.startLine,
    endLine: Math.min(request.endLine, lines.length),
    digest: digest(bytes),
    excerpt: lines.slice(request.startLine - 1, request.endLine).join("\n"),
  };
}

/** Hash a project file without adding its contents to model context. */
export async function digestProjectFile(projectRoot: string, path: string): Promise<{ path: string; digest: string }> {
  const file = await resolveProjectFile(projectRoot, path);
  return { path: file.relativePath, digest: await digestFile(file.path) };
}

export async function resolveProjectFile(projectRoot: string, path: string): Promise<ProjectFile> {
  const resolved = await resolveProjectWatchPath(projectRoot, path);
  const info = await stat(resolved.path);
  if (!info.isFile()) throw new WorkspaceError("Mini can use files only.");
  return resolved;
}

/** Resolve an existing file or directory that Mini may watch. */
export async function resolveProjectWatchPath(projectRoot: string, path: string): Promise<ProjectFile> {
  const root = await realProjectRoot(projectRoot);
  const requested = resolve(root, path);
  assertLexicalProjectPath(root, requested);
  const resolved = await realpath(requested);
  assertResolvedProjectPath(root, resolved);
  return { root, path: resolved, relativePath: displayPath(root, resolved) };
}

/** Resolve a patch destination. A missing final component is permitted. */
export async function resolveProjectWritePath(projectRoot: string, path: string): Promise<ProjectFile> {
  const root = await realProjectRoot(projectRoot);
  const relativePath = normalizePatchPath(path);
  const requested = resolve(root, relativePath);
  assertLexicalProjectPath(root, requested);

  const existing = await existingPath(requested);
  if (existing !== undefined) {
    const link = await lstat(requested);
    const resolved = await realpath(requested);
    assertResolvedProjectPath(root, resolved);
    if (link.isSymbolicLink()) throw new WorkspaceError("Mini does not apply a patch through a symbolic link.");
    return { root, path: requested, relativePath };
  }

  const parent = await nearestExistingParent(requested);
  const resolvedParent = await realpath(parent);
  assertResolvedProjectPath(root, resolvedParent);
  return { root, path: requested, relativePath };
}

export function normalizePatchPath(path: string): string {
  if (path === "" || path.includes("\0") || path.includes("\\")) {
    throw new WorkspaceError("A patch path must be a non-empty relative POSIX path.");
  }
  if (isAbsolute(path) || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new WorkspaceError("A patch path must stay inside the project root.");
  }
  if (path === ".brain" || path.startsWith(".brain/")) {
    throw new WorkspaceError("Mini does not patch .brain.");
  }
  return path;
}

async function realProjectRoot(projectRoot: string): Promise<string> {
  try {
    return await realpath(projectRoot);
  } catch (error) {
    throw new WorkspaceError(`Mini cannot resolve the project root: ${messageOf(error)}`);
  }
}

function assertLexicalProjectPath(root: string, candidate: string): void {
  if (!isInsideRoot(root, candidate)) throw new WorkspaceError("The path is outside the project root.");
  if (isInsideRoot(brainDirectory(root), candidate)) throw new WorkspaceError("Mini does not inspect or patch .brain.");
}

function assertResolvedProjectPath(root: string, candidate: string): void {
  if (!isInsideRoot(root, candidate)) throw new WorkspaceError("A symbolic link resolves outside the project root.");
  if (isInsideRoot(brainDirectory(root), candidate)) throw new WorkspaceError("Mini does not inspect or patch .brain.");
}

async function readBoundedFile(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (info.size > MAX_INSPECT_BYTES) throw new WorkspaceError(`Mini reads files up to ${MAX_INSPECT_BYTES} bytes.`);
  return readFile(path);
}

async function existingPath(path: string): Promise<boolean | undefined> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function nearestExistingParent(path: string): Promise<string> {
  let parent = dirname(path);
  for (;;) {
    if ((await existingPath(parent)) !== undefined) return parent;
    const next = dirname(parent);
    if (next === parent) throw new WorkspaceError("No project parent exists for the patch path.");
    parent = next;
  }
}

function displayPath(root: string, candidate: string): string {
  const result = relative(root, candidate);
  if (result === "") return ".";
  if (result.startsWith(`..${sep}`) || result === "..") {
    throw new WorkspaceError("The resolved path is outside the project root.");
  }
  return result.split(sep).join("/");
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
