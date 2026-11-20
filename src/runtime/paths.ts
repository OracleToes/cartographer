/**
 * Where things live (MINI.md §2.2). The Brain is the only durable storage,
 * and it lives under `.brain/` inside the project. The agent holds no path
 * into it — the runtime computes these, and no tool takes a `.brain` path.
 *
 * Carto keeps exactly one global file outside the project:
 * `~/.carto/config.json`. `CARTO_HOME` overrides the directory (tests,
 * scripts, side-by-side installs); nothing else is configurable globally.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function resolveProjectRoot(path?: string): string {
  return resolve(path ?? process.cwd());
}

export function brainDatabasePath(root: string): string {
  const path = resolve(root, ".brain/brain.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function cartoHome(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.CARTO_HOME;
  return override !== undefined && override.trim() !== "" ? override : join(homedir(), ".carto");
}

export function cartoConfigPath(home: string = cartoHome()): string {
  return join(home, "config.json");
}
