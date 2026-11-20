/**
 * The project tree (MINI.md §6.1, §10a).
 *
 * Anchored at a directory inside the project root, to a depth, rendered for
 * the state block: files, directories, sizes, and which files an Atlas node
 * links to — a map of what the agent understands, not a listing. The agent
 * moves the anchor and the depth; the anchor stays inside the project.
 *
 * Sizes aggregate the whole subtree (lstat, symlinks are leaves). `.brain` is
 * never shown: it is skipped everywhere it would appear, and it may not be an
 * anchor — the agent does not see the Brain (MINI.md §2.3, §7). Gitignored
 * paths are skipped the same way (the project's own `.gitignore` chain —
 * root file, `.git/info/exclude`, nested files below the anchor): no line,
 * no bytes in any aggregate, and ignored directories are pruned, not merely
 * hidden. Rendering is display-bounded by depth; aggregation is not.
 *
 * The `tree` tool sets anchor and depth and returns the rendered text; the
 * state block renders the same shape at the tail of every request.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { handleOf } from "../domain/handles.js";
import type { CartoBrain } from "../domain/records.js";
import { baseIgnoreChain, deeperIgnoreChain, isIgnored, type IgnoreChain } from "./gitignore.js";

export interface TreeEntry {
  /** Base name as it appears on disk. */
  name: string;
  /** Absolute path of this entry. */
  path: string;
  directory: boolean;
  /** Files: their own size. Directories: the aggregated size of the whole subtree. */
  size: number;
  children?: TreeEntry[];
}

export class AnchorError extends Error {}

/** The internal anchor must stay inside the project root and outside `.brain`, as MINI.md §2.3 and §7 require — the agent does not see the Brain. */
export function containedAnchor(root: string, anchor: string): string {
  const r = resolve(root);
  const resolved = resolve(isAbsolute(anchor) ? anchor : resolve(r, anchor));
  const rel = relative(r, resolved);
  if (resolved !== r && (rel === "" || rel.startsWith("..") || isAbsolute(rel))) {
    throw new AnchorError(`anchor escapes the project root: ${anchor}`);
  }
  if (rel !== "" && rel.split(sep).includes(".brain")) {
    throw new AnchorError(`\`.brain\` is not visible to the tree: ${anchor}`);
  }
  return resolved;
}

const entryOrder = (a: TreeEntry, b: TreeEntry): number =>
  Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, "en", { sensitivity: "base" });

function scan(absolute: string, name: string, chain: IgnoreChain): TreeEntry {
  const stat = lstatSync(absolute);
  if (!stat.isDirectory()) {
    return { name, path: absolute, directory: false, size: stat.size };
  }
  let children: TreeEntry[] = [];
  let total = 0;
  try {
    const entries = readdirSync(absolute, { withFileTypes: true });
    // A `.gitignore` inside this directory governs its contents (git
    // semantics); it was already listed, so no extra syscall is made.
    const childChain = deeperIgnoreChain(chain, absolute, entries.map((entry) => entry.name));
    for (const child of entries) {
      // The agent does not see the Brain (MINI.md §2.3): skip it wholesale —
      // no line, and no bytes in any aggregate.
      if (child.name === ".brain") continue;
      const childPath = `${absolute}${sep}${child.name}`;
      // Gitignored paths contribute nothing — not a line, not a byte — and
      // ignored directories are pruned here, so their subtrees are never
      // walked. Symlinks are leaves (lstat verdict, like the scan itself).
      if (isIgnored(childChain, childPath, child.name, child.isDirectory())) continue;
      try {
        const scanned = scan(childPath, child.name, childChain);
        children.push(scanned);
        total += scanned.size;
      } catch {
        // An unreadable entry contributes nothing rather than failing the map.
      }
    }
  } catch {
    // An unreadable directory renders as an empty directory rather than failing the map.
  }
  children = children.sort(entryOrder);
  return { name, path: absolute, directory: true, size: total, children };
}

/** Walk the anchor fully so directory sizes are honest aggregates. */
export function scanTree(root: string, anchor: string): TreeEntry {
  let target: string;
  try {
    target = containedAnchor(root, anchor);
    realpathSync(target);
  } catch (error) {
    if (error instanceof AnchorError) throw error;
    throw new AnchorError(`cannot read the anchor: ${anchor}`);
  }
  const stat = lstatSync(target);
  if (!stat.isDirectory()) {
    throw new AnchorError(`anchor is not a directory: ${anchor}`);
  }
  // The chain starts at the project root, not the anchor: a `.gitignore`
  // above the anchor still governs the anchor's contents.
  let chain = baseIgnoreChain(resolve(root));
  const anchorRel = relative(resolve(root), target);
  if (anchorRel !== "") {
    let current = resolve(root);
    for (const part of anchorRel.split(sep)) {
      current = join(current, part);
      chain = deeperIgnoreChain(chain, current);
    }
  }
  return scan(target, target.split(sep).pop() ?? ".", chain);
}

/** Human-readable size: bytes, then K/M/G (integer, e.g. `3K`). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  let value = bytes / 1024;
  let unit = "K";
  if (value >= 1024) { value /= 1024; unit = "M"; }
  if (value >= 1024) { value /= 1024; unit = "G"; }
  return `${Math.round(value)}${unit}`;
}

/**
 * Absolute paths of the files an Atlas node links to, mapped to their
 * handles (several nodes may link one file). Evidence paths that resolve
 * outside the project root are dropped — the tree cannot show them anyway.
 */
export function atlasLinkedPaths(brain: CartoBrain, root: string): Map<string, string[]> {
  const linked = new Map<string, string[]>();
  const r = resolve(root);
  for (const node of brain.atlas) {
    const handle = handleOf(brain.handles, "atlas", node.id) ?? "?";
    for (const ref of node.evidence) {
      if (ref.kind !== "file") continue;
      const absolute = resolve(r, ref.path);
      const rel = relative(r, absolute);
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      const list = linked.get(absolute) ?? [];
      if (!list.includes(handle)) list.push(handle);
      linked.set(absolute, list);
    }
  }
  return linked;
}

/** Render the entry lines (no header — the caller prints the anchor line itself). Display is bounded by depth. */
export function renderTreeLines(entry: TreeEntry, depth: number, linked: Map<string, string[]>): string[] {
  const lines: string[] = [];
  const walk = (node: TreeEntry, level: number): void => {
    if (level > depth) return;
    for (const child of node.children ?? []) {
      const indent = "  ".repeat(level);
      const name = child.directory ? `${child.name}/` : child.name;
      const marks = child.directory ? [] : (linked.get(child.path) ?? []);
      lines.push(`${indent}${name}  ${formatSize(child.size)}${marks.length > 0 ? `  ${marks.join(" ")}` : ""}`);
      walk(child, level + 1);
    }
  };
  walk(entry, 1);
  return lines;
}

/** The `tree` state as the block carries it: anchor (absolute), depth, lines. */
export function projectTreeBlock(
  root: string,
  anchor: string,
  depth: number,
  brain: CartoBrain,
): { root: string; depth: number; lines: string[] } {
  if (!Number.isInteger(depth) || depth < 0) throw new AnchorError(`depth must be a whole number >= 0, got ${depth}`);
  const target = containedAnchor(root, anchor);
  const entry = scanTree(root, target);
  const lines = renderTreeLines(entry, depth, atlasLinkedPaths(brain, root));
  return { root: target, depth, lines };
}
