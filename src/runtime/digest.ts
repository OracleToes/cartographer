/**
 * File digests for the rebuild-time freshness check. Hashes bytes; never
 * reads outside the project root.
 */
import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

export async function sha256File(path: string): Promise<string | null> {
  try {
    const stream = createReadStream(path);
    const hash = createHash("sha256");
    return await new Promise((resolvePromise, reject) => {
      stream.on("data", (chunk) => hash.update(chunk as Buffer));
      stream.on("error", reject);
      stream.on("end", () => resolvePromise(hash.digest("hex")));
    });
  } catch {
    return null;
  }
}

/** Resolve a claim path inside the root; reject anything outside it. */
export function resolveInsideRoot(root: string, path: string): string | null {
  // Evidence paths are written by the agent and may be relative to the root
  // or absolute. Containment is the safety boundary, not a permission ask.
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
