import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";

import type { ChangeProposal } from "../domain/types.js";
import { digestProjectFile, normalizePatchPath, resolveProjectWritePath, WorkspaceError } from "./workspace.js";

interface PatchFile {
  oldPath: string | null;
  newPath: string | null;
}

export class PatchError extends Error {}

/**
 * Validate and apply one person-approved, text-only unified diff.
 * The fixed git invocation is not a general shell tool.
 */
export async function applyApprovedPatch(projectRoot: string, change: ChangeProposal): Promise<string[]> {
  const files = parseUnifiedPatch(change.patch);
  await validatePatchTargets(projectRoot, files);
  await verifyBase(projectRoot, change, files);
  await runGitApply(projectRoot, change.patch, ["--check"]);
  await runGitApply(projectRoot, change.patch, []);
  return [...new Set(files.flatMap((file) => [file.oldPath, file.newPath]).filter((path): path is string => path !== null))];
}

/** True when an approved patch was already applied before a restart. */
export async function isApprovedPatchApplied(projectRoot: string, change: ChangeProposal): Promise<boolean> {
  const files = parseUnifiedPatch(change.patch);
  await validatePatchTargets(projectRoot, files, true);
  try {
    await runGitApply(projectRoot, change.patch, ["--check", "--reverse"]);
    return true;
  } catch (error) {
    if (error instanceof PatchError) return false;
    throw error;
  }
}

export function parseUnifiedPatch(patch: string): PatchFile[] {
  if (patch.length === 0 || patch.length > 1_000_000 || patch.includes("\0")) {
    throw new PatchError("An approved patch must be non-empty text up to 1 MB.");
  }
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  rejectUnsupportedPatchFeatures(lines);

  const files: Array<PatchFile & { diffPath: string }> = [];
  let current: (PatchFile & { diffPath: string }) | undefined;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current !== undefined) files.push(finishPatchFile(current));
      current = parseDiffHeader(line);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("--- ")) {
      if (current.oldPath !== undefined) throw new PatchError("A patch file has more than one old path header.");
      current.oldPath = parseHeaderPath(line.slice(4), "a/");
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (current.newPath !== undefined) throw new PatchError("A patch file has more than one new path header.");
      current.newPath = parseHeaderPath(line.slice(4), "b/");
    }
  }
  if (current !== undefined) files.push(finishPatchFile(current));
  if (files.length === 0) throw new PatchError("Mini accepts unified diffs with diff --git headers only.");
  return files;
}

async function validatePatchTargets(projectRoot: string, files: readonly PatchFile[], allowExistingNew = false): Promise<void> {
  for (const file of files) {
    for (const path of [file.oldPath, file.newPath]) {
      if (path !== null) await resolveProjectWritePath(projectRoot, path);
    }
    if (!allowExistingNew && file.oldPath === null && file.newPath !== null && (await exists(projectRoot, file.newPath))) {
      throw new PatchError(`A new patch file already exists: ${file.newPath}.`);
    }
  }
}

async function verifyBase(projectRoot: string, change: ChangeProposal, files: readonly PatchFile[]): Promise<void> {
  const existingPaths = new Set(files.flatMap((file) => (file.oldPath === null ? [] : [file.oldPath])));
  const baseByPath = new Map<string, string>();
  for (const base of change.base) {
    let path: string;
    try {
      path = normalizePatchPath(base.path);
      await resolveProjectWritePath(projectRoot, path);
    } catch (error) {
      throw asPatchError(error);
    }
    if (baseByPath.has(path)) throw new PatchError(`The patch base lists ${path} more than once.`);
    baseByPath.set(path, base.digest);
  }

  for (const path of existingPaths) {
    const expected = baseByPath.get(path);
    if (expected === undefined) throw new PatchError(`The patch needs a base digest for ${path}.`);
    let current;
    try {
      current = await digestProjectFile(projectRoot, path);
    } catch (error) {
      throw new PatchError(`Mini cannot verify the patch base for ${path}: ${messageOf(error)}`);
    }
    if (current.digest !== expected) throw new PatchError(`The patch base changed for ${path}. Review the change again.`);
  }

  for (const path of baseByPath.keys()) {
    if (!existingPaths.has(path)) throw new PatchError(`The patch base has an unused file: ${path}.`);
  }
}

function parseDiffHeader(line: string): PatchFile & { diffPath: string } {
  const parts = line.split(" ");
  if (parts.length !== 4 || !parts[2]?.startsWith("a/") || !parts[3]?.startsWith("b/")) {
    throw new PatchError("Mini does not accept quoted, renamed, or malformed diff paths.");
  }
  const oldPath = parseHeaderPath(parts[2], "a/");
  const newPath = parseHeaderPath(parts[3], "b/");
  if (oldPath === null || newPath === null || oldPath !== newPath) {
    throw new PatchError("Mini does not accept renamed diff paths.");
  }
  return { diffPath: oldPath, oldPath: undefined as never, newPath: undefined as never };
}

function finishPatchFile(file: PatchFile & { diffPath: string }): PatchFile & { diffPath: string } {
  if (file.oldPath === undefined || file.newPath === undefined) {
    throw new PatchError(`The patch for ${file.diffPath} needs both --- and +++ headers.`);
  }
  if (file.oldPath !== null && file.oldPath !== file.diffPath) {
    throw new PatchError(`The old header does not match ${file.diffPath}.`);
  }
  if (file.newPath !== null && file.newPath !== file.diffPath) {
    throw new PatchError(`The new header does not match ${file.diffPath}.`);
  }
  if (file.oldPath === null && file.newPath === null) throw new PatchError("A patch cannot delete and create /dev/null.");
  return file;
}

function parseHeaderPath(value: string, prefix: "a/" | "b/"): string | null {
  if (value === "/dev/null") return null;
  if (!value.startsWith(prefix) || /[\t\s]/.test(value)) {
    throw new PatchError("Mini does not accept quoted or spaced patch paths.");
  }
  try {
    return normalizePatchPath(value.slice(prefix.length));
  } catch (error) {
    throw asPatchError(error);
  }
}

function rejectUnsupportedPatchFeatures(lines: readonly string[]): void {
  for (const line of lines) {
    if (
      line === "GIT binary patch" ||
      line.startsWith("Binary files ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("copy from ") ||
      line.startsWith("copy to ") ||
      /(?:^| )120000(?:$| )/.test(line)
    ) {
      throw new PatchError("Mini accepts regular text-file patches only.");
    }
  }
}

async function exists(projectRoot: string, path: string): Promise<boolean> {
  const destination = await resolveProjectWritePath(projectRoot, path);
  try {
    await lstat(destination.path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function runGitApply(projectRoot: string, patch: string, extra: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["apply", "--no-index", "--whitespace=error-all", ...extra], {
      cwd: projectRoot,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      reject(new PatchError(`Mini could not start its fixed patch applicator: ${messageOf(error)}`));
    });
    child.stdin.once("error", (error) => {
      reject(new PatchError(`Mini could not write to its fixed patch applicator: ${messageOf(error)}`));
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new PatchError(`Mini could not apply the approved patch: ${stderr.trim() || `git exited ${code ?? "without a code"}`}`));
    });
    child.stdin.end(patch);
  });
}

function asPatchError(error: unknown): PatchError {
  return error instanceof PatchError ? error : new PatchError(messageOf(error));
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function messageOf(error: unknown): string {
  if (error instanceof WorkspaceError || error instanceof Error) return error.message;
  return String(error);
}
