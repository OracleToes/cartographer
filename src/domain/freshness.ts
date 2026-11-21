/**
 * Digest drift, checked at a rebuild (MINI.md §28; docs/intent.md §28).
 *
 * An Atlas claim whose evidence file changed since it was checked is marked
 * stale. It gently informs the agent to update its Brain; it blocks nothing
 * and deletes nothing. Between collapses nothing is re-checked — the
 * projection is frozen, and the stale line names what was stale at rebuild.
 *
 * Only file-backed evidence is checked here. `context` sources verify by
 * hand and keep whatever freshness they carry.
 */
import type { BrainWrite } from "./brain.js";
import type { CartoBrain } from "./records.js";

/**
 * @param digestFor Returns the file's current digest, or `null` when the
 *   path escapes the project root, is missing, or cannot be read.
 */
export function freshnessMarks(
  brain: CartoBrain,
  digestFor: (path: string) => string | null,
): BrainWrite {
  const marks: Array<{ record: "atlas"; id: string; index: number | null; freshness: "fresh" | "stale" }> = [];
  const verify = (stored: string, current: string | null): "fresh" | "stale" =>
    current !== null && current === stored ? "fresh" : "stale";

  for (const node of brain.atlas) {
    node.evidence.forEach((ref, index) => {
      if (ref.kind !== "file") return;
      marks.push({ record: "atlas", id: node.id, index, freshness: verify(ref.digest, digestFor(ref.path)) });
    });
  }
  return { kind: "evidence.refresh", marks };
}
