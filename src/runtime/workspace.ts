/**
 * The project boundary (§6).
 *
 * Every Carto tool that names a path resolves it against the project root, and
 * `.brain` is refused before the package's file tools ever see the path — a
 * scoping boundary, not a trust gate (§6.1). The shell cannot be scoped this
 * way; its cwd is the root and the boundary is what the agentic tools enforce.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
  const candidate = resolve(rootReal, path);
  const rel = relative(rootReal, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new WorkspaceError(
      `that path resolves outside the project root (${candidate}), and everything you touch is inside it. Name a path relative to the root.`,
    );
  }
  refuseBrainPath(rootReal, candidate);
  return candidate;
}
