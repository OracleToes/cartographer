import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export function cartoHome(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.CARTO_HOME ?? join(homedir(), ".carto"));
}

export function cartoConfigPath(home = cartoHome()): string {
  return join(home, "config.json");
}

export function projectRoot(path = process.cwd()): string {
  return resolve(path);
}

export function brainDirectory(root: string): string {
  return join(root, ".brain");
}

export function brainDatabasePath(root: string): string {
  return join(brainDirectory(root), "brain.sqlite");
}

export function contextDirectory(root: string): string {
  return join(brainDirectory(root), "context");
}

export function contextDatabasePath(root: string, generation: string): string {
  if (!isContextGenerationName(generation)) {
    throw new Error("A Carto context generation has an unsafe file name.");
  }
  return join(contextDirectory(root), `${generation}.sqlite`);
}

/** The frozen projection for a generation, written once at creation. */
export function projectionPath(root: string, generation: string): string {
  if (!isContextGenerationName(generation)) {
    throw new Error("A Carto context generation has an unsafe file name.");
  }
  return join(contextDirectory(root), `${generation}.projection.md`);
}

/** The frozen projection's per-part token sums, for the state block. */
export function projectionMetaPath(root: string, generation: string): string {
  if (!isContextGenerationName(generation)) {
    throw new Error("A Carto context generation has an unsafe file name.");
  }
  return join(contextDirectory(root), `${generation}.projection.json`);
}

export function isContextGenerationName(generation: string): boolean {
  return /^[A-Za-z0-9-]{1,128}$/.test(generation);
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
}
