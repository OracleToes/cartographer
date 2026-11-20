import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { handleOf } from "../domain/handles.js";
import type { CartoBrain } from "../domain/types.js";

/**
 * The bounded project tree, for the state block.
 *
 * §26 gives the tree's anchor and depth to a dedicated tool, and until it
 * exists (slice three) the state block shows the root at a fixed depth. The
 * exclusions are not judgment about the project: `.brain` is denied to the
 * agent by design, and `.git` and `node_modules` are the noise every tree
 * render skips by default. What the renderer never does is follow a symlink
 * or leave the root.
 */

/** Names never rendered, anywhere in the walk. */
const SKIP = new Set([".brain", ".git", "node_modules"]);

export interface ProjectTreeOptions {
  /** Levels below the root to render. 1 shows the root's direct children. */
  depth: number;
  /** Posix relative path → Atlas handles that claim it. */
  marks?: ReadonlyMap<string, readonly string[]>;
  /** Hard cap on rendered lines; the overflow is reported in the last line. */
  maxLines?: number;
}

export interface ProjectTree {
  lines: string[];
  /** Total entries seen, before the cap cut the render. */
  seen: number;
}

export async function renderProjectTree(root: string, options: ProjectTreeOptions): Promise<ProjectTree> {
  const depth = Math.max(0, Math.trunc(options.depth));
  const maxLines = options.maxLines ?? 60;
  const marks = options.marks ?? new Map<string, readonly string[]>();
  const lines: string[] = [];
  let seen = 0;
  let capped = false;

  const walk = async (directory: string, level: number): Promise<void> => {
    if (capped || level >= depth) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return; // Unreadable directory: say nothing rather than guess.
    }
    const visible = entries.filter((entry) => !SKIP.has(entry.name) && !entry.name.startsWith(".git"));
    visible.sort((first, second) => {
      if (first.isDirectory() !== second.isDirectory()) return first.isDirectory() ? -1 : 1;
      return first.name.localeCompare(second.name, undefined, { sensitivity: "base" });
    });
    for (const entry of visible) {
      if (lines.length >= maxLines) {
        capped = true;
        return;
      }
      seen += 1;
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      const isDirectory = entry.isDirectory();
      const mark = marks.get(relativePath);
      const suffix = mark !== undefined && mark.length > 0 ? ` · ${mark.join(" ")}` : "";
      lines.push(`${"  ".repeat(level + 1)}${entry.name}${isDirectory ? "/" : ""}${suffix}`);
      if (isDirectory) {
        // Dirent.isDirectory() does not follow symlinks, and a symlink to a
        // directory reports itself as a link, not a directory.
        await walk(absolute, level + 1);
      }
    }
  };

  await walk(root, 0);
  if (capped) lines.push(`  … ${Math.max(0, seen - lines.length)} more`);
  return { lines, seen };
}

/** Path → handles for every file-sourced Atlas evidence pointer. */
export function atlasPathMarks(brain: CartoBrain): Map<string, string[]> {
  const marks = new Map<string, string[]>();
  for (const node of brain.atlas) {
    const handle = handleOf(brain.handles, "atlas", node.id);
    if (handle === undefined) continue;
    for (const source of node.evidence) {
      if (source.kind !== "file") continue;
      const key = source.path.split(sep).join("/");
      const list = marks.get(key) ?? [];
      if (!list.includes(handle)) list.push(handle);
      marks.set(key, list);
    }
  }
  return marks;
}
