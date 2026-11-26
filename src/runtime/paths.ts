/**
 * Where things live (§2). The Brain is the only durable storage,
 * and it lives under `.brain/` inside the project. The agent holds no path
 * into it — the runtime computes these, and no tool takes a `.brain` path.
 *
 * Carto keeps exactly one global file outside the project:
 * `~/.carto/config.json`. `CARTO_HOME` overrides the directory (tests,
 * scripts, side-by-side installs); nothing else is configurable globally.
 */
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveProjectRoot(path?: string): string {
  return resolve(path ?? process.cwd());
}

/** Prepare Carto's project storage before any session files are created. */
export function ensureBrainDirectory(root: string): string {
  const directory = resolve(root, ".brain");
  mkdirSync(directory, { recursive: true });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Cannot initialize ${directory}: .brain must be a real directory, not a symlink or file.`);
  }
  const ignore = join(directory, ".gitignore");
  const rule = "# Carto session data\n*\n";
  try {
    // Exclusive creation does not overwrite an existing file or follow a link.
    writeFileSync(ignore, rule, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = lstatSync(ignore);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`Cannot initialize ${ignore}: it must be a regular file, not a symlink or directory.`);
    }
    // Preserve existing rules while making the last effective rule ignore all
    // contents, including this file. Reopening does not append duplicates.
    const text = readFileSync(ignore, "utf8");
    const rules = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
    if (rules.at(-1) !== "*") appendFileSync(ignore, `${text.endsWith("\n") || text === "" ? "" : "\n"}${rule}`, "utf8");
  }
  return directory;
}

export function brainDatabasePath(root: string): string {
  return join(ensureBrainDirectory(root), "brain.sqlite");
}

export function cartoHome(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.CARTO_HOME;
  return override !== undefined && override.trim() !== "" ? override : join(homedir(), ".carto");
}

export function cartoConfigPath(home: string = cartoHome()): string {
  return join(home, "config.json");
}

/** Private TUI handoff: the CLI wipes only after all session stores close. */
export const WIPE_REQUESTED = 42;

/** Remove this project's storage, never the project or a symlink target. */
export async function wipeProjectBrain(root: string): Promise<void> {
  const path = resolve(root, ".brain");
  let stat;
  try { stat = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Cannot wipe ${path}: .brain must be a real directory, not a symlink or file.`);
  }
  await rm(path, { recursive: true, force: false });
}
