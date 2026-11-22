/**
 * Path containment inside the project root. The workspace boundary is what
 * the agentic tools enforce (§6.2); it is not a permission gate.
 */
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Resolve a path inside the root; reject anything outside it. */
export function resolveInsideRoot(root: string, path: string): string | null {
  const candidate = resolve(root, path);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  const rootReal = realpathSync(root);
  if (real !== rootReal && !real.startsWith(`${rootReal}${sep}`)) return null;
  return real;
}
