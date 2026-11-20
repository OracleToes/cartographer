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

export interface ReadRange {
  /** The path as the agent wrote it. */
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  digest: string;
  excerpt: string;
}

/**
 * Read a file, or a line range of it, with the whole file's digest for
 * evidence. Omit both range arguments to read the whole file; pass both to
 * read a range. One without the other is an error, never a guess.
 */
export async function readRange(root: string, path: string, startLine?: number, endLine?: number): Promise<ReadRange> {
  if ((startLine === undefined) !== (endLine === undefined)) {
    throw new WorkspaceError("pass both startLine and endLine, or neither to read the whole file");
  }
  if (startLine !== undefined && endLine !== undefined) {
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new WorkspaceError(`range must be whole lines with 1 <= start <= end; got ${startLine}-${endLine}`);
    }
  }
  const real = resolveProjectPath(root, path);
  const bytes = await readFile(real);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const lines = bytes.toString("utf8").split("\n");
  const from = startLine ?? 1;
  const to = endLine ?? lines.length;
  const slice = lines.slice(from - 1, to);
  const excerpt = slice.join("\n");
  return { path, startLine: from, endLine: to, totalLines: lines.length, digest, excerpt };
}

export interface EditResult {
  /** The path as written. */
  path: string;
  /** "created" when the file did not exist, "edited" when text was replaced. */
  outcome: "created" | "edited";
  bytes: number;
}

/**
 * One atomic edit: create a missing file (oldText must be empty), or replace
 * a unique occurrence of oldText in an existing file. Atomic via temp+rename.
 */
export async function applyAtomicEdit(root: string, path: string, oldText: string, newText: string): Promise<EditResult> {
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

