/**
 * The project boundary (MINI.md §7).
 *
 * Every Carto tool path resolves inside the project root. A symlink that
 * resolves outside is rejected, and `.brain` is not readable or writable by
 * the agent — a scoping boundary, not a trust gate. The shell cannot be
 * scoped at the OS level; its cwd is pinned to the root and the boundary
 * above is what the agentic tools enforce.
 */
import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile, rename, chmod } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { resolveInsideRoot } from "./digest.js";

export class WorkspaceError extends Error {}

/** Reject `.brain` at any depth below the root, on the resolved path. */
function assertNotBrain(rootReal: string, real: string): void {
  const rel = relative(rootReal, real);
  if (rel === "") return;
  if (rel.split(sep).includes(".brain")) {
    throw new WorkspaceError("`.brain` is Carto's own storage; no tool touches it.");
  }
}

/** Lexical shape check shared by creation and edit paths. */
function lexicalContainment(rootReal: string, candidate: string): void {
  const rel = relative(rootReal, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new WorkspaceError(`path resolves outside the project root: ${candidate}`);
  }
  if (rel.split(sep).includes(".brain")) {
    throw new WorkspaceError("`.brain` is Carto's own storage; no tool touches it.");
  }
}

/** Resolve an existing path inside the root. Throws WorkspaceError. */
export function resolveProjectPath(root: string, path: string): string {
  const rootReal = realpathSync(root);
  const candidate = resolve(rootReal, path);
  lexicalContainment(rootReal, candidate);
  const real = resolveInsideRoot(root, path);
  if (real === null) throw new WorkspaceError(`path is missing or resolves outside the project root: ${path}`);
  assertNotBrain(rootReal, real);
  return real;
}

export interface BoundedRange {
  /** The path as the agent wrote it. */
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  digest: string;
  excerpt: string;
  truncated: boolean;
}

export const MAX_RANGE_LINES = 400;
export const MAX_EXCERPT_CHARS = 24_000;

/** Read a bounded line range, with the whole file's digest for evidence. */
export async function readBoundedRange(root: string, path: string, startLine: number, endLine: number): Promise<BoundedRange> {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new WorkspaceError(`range must be whole lines with 1 <= start <= end; got ${startLine}-${endLine}`);
  }
  if (endLine - startLine + 1 > MAX_RANGE_LINES) {
    throw new WorkspaceError(`range too wide: ${endLine - startLine + 1} lines; read at most ${MAX_RANGE_LINES} lines at a time`);
  }
  const real = resolveProjectPath(root, path);
  const bytes = await readFile(real);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const lines = bytes.toString("utf8").split("\n");
  const slice = lines.slice(startLine - 1, endLine);
  let excerpt = slice.join("\n");
  let truncated = false;
  if (excerpt.length > MAX_EXCERPT_CHARS) {
    excerpt = `${excerpt.slice(0, MAX_EXCERPT_CHARS)}\n[...truncated]`;
    truncated = true;
  }
  return { path, startLine, endLine, totalLines: lines.length, digest, excerpt, truncated };
}

export interface EditResult {
  /** The path as written. */
  path: string;
  /** "created" when the file did not exist, "edited" when text was replaced. */
  outcome: "created" | "edited";
  bytes: number;
}

export const MAX_EDIT_CHARS = 100_000;

/**
 * One atomic edit: create a missing file (oldText must be empty), or replace
 * a unique occurrence of oldText in an existing file. Atomic via temp+rename.
 */
export async function applyAtomicEdit(root: string, path: string, oldText: string, newText: string): Promise<EditResult> {
  if (newText.length > MAX_EDIT_CHARS) {
    throw new WorkspaceError(`newText too large: ${newText.length} chars; the bound is ${MAX_EDIT_CHARS}`);
  }
  const rootReal = realpathSync(root);
  const candidate = resolve(rootReal, path);
  lexicalContainment(rootReal, candidate);
  let real = candidate;
  let existed = existsSync(candidate);
  if (!existed) {
    const parent = dirname(candidate);
    let parentReal: string;
    try {
      parentReal = realpathSync(parent);
    } catch {
      throw new WorkspaceError(`directory does not exist: ${relative(rootReal, parent)}`);
    }
    if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${sep}`)) {
      throw new WorkspaceError(`path resolves outside the project root: ${path}`);
    }
    assertNotBrain(rootReal, parentReal);
  } else {
    real = resolveProjectPath(root, path);
  }

  if (!existed) {
    if (oldText !== "") throw new WorkspaceError(`${path} does not exist; pass oldText "" to create it`);
    const temp = `${real}.carto-${process.pid}-${Date.now()}.tmp`;
    await writeFile(temp, newText, { mode: 0o644 });
    await rename(temp, real);
    return { path, outcome: "created", bytes: Buffer.byteLength(newText) };
  }

  const original = await readFile(real, "utf8");
  if (oldText === "") {
    throw new WorkspaceError(`${path} exists; pass the exact text to replace as oldText`);
  }
  const first = original.indexOf(oldText);
  if (first === -1) {
    throw new WorkspaceError(`oldText does not appear in ${path}; read the file first and copy the text exactly`);
  }
  if (original.indexOf(oldText, first + 1) !== -1) {
    throw new WorkspaceError(`oldText appears more than once in ${path}; widen it until it is unique`);
  }
  const updated = `${original.slice(0, first)}${newText}${original.slice(first + oldText.length)}`;
  const temp = `${real}.carto-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temp, updated);
  await chmod(temp, 0o644).catch(() => undefined);
  await rename(temp, real);
  return { path, outcome: "edited", bytes: Buffer.byteLength(updated) };
}

export interface ShellResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export const MAX_SHELL_OUTPUT_CHARS = 30_000;
export const MAX_SHELL_TIMEOUT_MS = 600_000;

/**
 * Run a command inside the project (cwd pinned to the root). A non-zero exit
 * is reported, not thrown — it is information, not a tool failure. Timeouts
 * kill the child and are a tool failure. Output is the tail, capped.
 */
export function runShell(root: string, command: string, timeoutMs: number): Promise<ShellResult> {
  const bound = Math.min(Math.max(1_000, timeoutMs), MAX_SHELL_TIMEOUT_MS);
  return new Promise((resolvePromise) => {
    exec(
      command,
      { cwd: realpathSync(root), timeout: bound, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const combined = `${stdout}${stderr.length > 0 ? `\n[stderr]\n${stderr}` : ""}`;
        const output =
          combined.length > MAX_SHELL_OUTPUT_CHARS
            ? `[...earlier output truncated]\n${combined.slice(-MAX_SHELL_OUTPUT_CHARS)}`
            : combined;
        if (error === null) {
          resolvePromise({ exitCode: 0, output, timedOut: false });
          return;
        }
        if (error.killed === true) {
          resolvePromise({ exitCode: null, output: `${output}\n[timed out after ${bound} ms; the command was killed]`, timedOut: true });
          return;
        }
        const code = typeof error.code === "number" ? error.code : null;
        resolvePromise({ exitCode: code, output: `${output}\n[exit ${code ?? "unknown"}]`, timedOut: false });
      },
    );
  });
}

