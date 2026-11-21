/**
 * Attachment-drift checks (MINI.md §28; docs/intent.md §28).
 *
 * An Atlas node attached to a file is stale when the file is missing, or when
 * its mtime is newer than the node was written. It gently informs the agent
 * to update its Brain; it blocks nothing and deletes nothing. Non-file
 * attachments carry no signal and are never checked — the Brain is tended by
 * the agent, not by the runtime.
 *
 * The mark is checked live (the state block names what is stale now) and
 * stored at collapse, so the frozen projection carries the collapse-time
 * truth.
 */
import type { CartoBrain } from "./records.js";

/**
 * @param mtimeFor Returns the file's mtime in ms, or `null` when the path is
 *   missing or cannot be resolved inside the project root.
 */
export function staleAtlasNodeIds(brain: CartoBrain, mtimeFor: (path: string) => number | null): string[] {
  const stale: string[] = [];
  for (const node of brain.atlas) {
    for (const attachment of node.attachments) {
      if (attachment.kind !== "file") continue;
      const mtime = mtimeFor(attachment.path);
      if (mtime === null || mtime > node.updatedAt) {
        stale.push(node.id);
        break;
      }
    }
  }
  return stale;
}
