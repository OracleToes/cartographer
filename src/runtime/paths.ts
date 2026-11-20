/**
 * Where things live (MINI.md §2.2): the Brain is the only durable storage,
 * and it lives under `.brain/` inside the project. The agent holds no path
 * into it — the runtime computes these, and no tool takes a `.brain` path.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function resolveProjectRoot(path?: string): string {
  return resolve(path ?? process.cwd());
}

export function brainDatabasePath(root: string): string {
  const path = resolve(root, ".brain/brain.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
