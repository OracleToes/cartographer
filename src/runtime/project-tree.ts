/**
 * The project tree (§6.3).
 *
 * Anchored at a directory inside the project root, to a depth, rendered for
 * the state block: files, directories, sizes, and which files an Atlas node
 * links to — a map of what the agent understands, not a listing. The agent
 * moves the anchor and the depth; the anchor stays inside the project.
 *
 * Sizes aggregate the whole subtree (lstat, symlinks are leaves). `.brain` and
 * `.git` are never shown: they are skipped everywhere they would appear, and
 * they may not be an anchor — the agent does not see the Brain or repository
 * internals (§2.3, §7). Gitignored paths are skipped the same way (the
 * project's own `.gitignore` chain — root file, `.git/info/exclude`, nested
 * files below the anchor): no line, no bytes in any aggregate, and ignored
 * directories are pruned, not merely hidden. Rendering is display-bounded by
 * depth; aggregation is not.
 *
 * The `tree` tool sets anchor and depth in session state for the state block;
 * the state block renders the tree at the tail of every request.
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

/** The internal anchor must stay inside the project root and outside `.brain` and `.git`, as §2.3 and §7 require. */
export function containedAnchor(root: string, anchor: string): string {
  const r = resolve(root);
  const resolved = resolve(isAbsolute(anchor) ? anchor : resolve(r, anchor));
  const rel = relative(r, resolved);
  if (resolved !== r && (rel === "" || rel.startsWith("..") || isAbsolute(rel))) {
    throw new AnchorError(`an anchor stays inside the project root; ${anchor} resolves outside it.`);
  }
  if (rel !== "") {
    const parts = rel.split(sep);
    if (parts.includes(".brain") || parts.includes(".git")) {
      throw new AnchorError(
        `the tree does not show ${anchor}: \`.brain\` holds the Brain's own storage and \`.git\` holds the repository, and neither is yours to look at.`,
      );
    }
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
      // The agent does not see the Brain or git repository internals:
      // skip them wholesale — no line, and no bytes in any aggregate.
      if (child.name === ".brain" || child.name === ".git") continue;
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
    throw new AnchorError(`the anchor \`${anchor}\` cannot be read; pick a directory that exists inside the project.`);
  }
  const stat = lstatSync(target);
  if (!stat.isDirectory()) {
    throw new AnchorError(`an anchor is a directory, and \`${anchor}\` is a file. Anchor at the directory that holds it, or read the file.`);
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
 * Absolute paths of the files an Atlas node attaches to, mapped to their
 * handles (several nodes may attach one file). Attachment paths that
 * resolve outside the project root are dropped — the tree cannot show them
 * anyway.
 */
export function atlasAttachedPaths(brain: CartoBrain, root: string): Map<string, string[]> {
  const attached = new Map<string, string[]>();
  const r = resolve(root);
  for (const node of brain.atlas) {
    const handle = handleOf(brain.handles, "atlas", node.id) ?? "?";
    for (const attachment of node.attachments) {
      if (attachment.kind !== "file") continue;
      const absolute = resolve(r, attachment.path);
      const rel = relative(r, absolute);
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      const list = attached.get(absolute) ?? [];
      if (!list.includes(handle)) list.push(handle);
      attached.set(absolute, list);
    }
  }
  return attached;
}

/**
 * Every file and directory the tree shows, by the handle it was given.
 *
 * §5.4: a file's handle comes from the tree and nowhere else, and a file the
 * tree does not show has no handle. So the numbering is the tree's own — one
 * pass, in the order it renders, `F` for a file and `D` for a directory — and
 * this is the one place it happens. The tool that resolves a handle to a path
 * uses the same map, so a handle cannot mean one file in the block and another
 * in a tool.
 */
export type TreeHandles = ReadonlyMap<string, string>;

export function treeHandles(entry: TreeEntry, depth: number): TreeHandles {
  const handles = new Map<string, string>();
  let files = 0;
  let directories = 0;
  const walk = (node: TreeEntry, level: number): void => {
    if (level > depth) return;
    for (const child of node.children ?? []) {
      const handle = child.directory ? `D${++directories}` : `F${++files}`;
      handles.set(child.path, handle);
      walk(child, level + 1);
    }
  };
  walk(entry, 1);
  return handles;
}

/**
 * The size of the subtree under one path, in bytes: what a directory actually
 * costs. The scan already aggregates it, so this is a lookup, not a walk — the
 * Tree view shows the per-directory figure beside a files-only aggregate
 * without walking the disk a second time.
 */
function subtreeSizes(entry: TreeEntry, depth: number): Map<string, number> {
  const sizes = new Map<string, number>();
  const walk = (node: TreeEntry, level: number): void => {
    if (level > depth) return;
    for (const child of node.children ?? []) {
      sizes.set(child.path, child.size);
      walk(child, level + 1);
    }
  };
  walk(entry, 1);
  return sizes;
}

/** Render the entry lines (no header — the caller prints the anchor line itself). Display is bounded by depth. */
export function renderTreeLines(
  entry: TreeEntry,
  depth: number,
  attached: Map<string, string[]>,
  handles: TreeHandles = new Map(),
): string[] {
  const lines: string[] = [];
  const walk = (node: TreeEntry, level: number): void => {
    if (level > depth) return;
    for (const child of node.children ?? []) {
      const indent = "  ".repeat(level);
      const name = child.directory ? `${child.name}/` : child.name;
      const marks = child.directory ? [] : (attached.get(child.path) ?? []);
      const handle = handles.get(child.path);
      lines.push(
        `${indent}${name}  ${formatSize(child.size)}${handle === undefined ? "" : `  ${handle}`}${marks.length > 0 ? `  ${marks.join(" ")}` : ""}`,
      );
      walk(child, level + 1);
    }
  };
  walk(entry, 1);
  return lines;
}

/**
 * The tree a view shows: the scanned entry, its handles, its aggregate sizes,
 * and the Atlas nodes attached to its files. The block renders lines from the
 * same pieces, so a handle in the view is the handle in the block (§5.4) —
 * one numbering, computed once.
 */
export interface TreeProjection {
  /** Where the anchor landed, absolute. */
  anchor: string;
  /** The depth actually rendered, after the same floor the block applies. */
  depth: number;
  entry: TreeEntry;
  handles: TreeHandles;
  /** Subtree bytes by path, for every entry the depth shows. */
  sizes: ReadonlyMap<string, number>;
  /** Atlas handles attached to each file path (§2.1). */
  attached: ReadonlyMap<string, readonly string[]>;
}

export function projectTreeView(root: string, anchor: string, depth: number, brain: CartoBrain): TreeProjection {
  const shown = Number.isFinite(depth) ? Math.max(1, Math.trunc(depth)) : 1;
  const target = containedAnchor(root, anchor);
  const entry = scanTree(root, target);
  return {
    anchor: target,
    depth: shown,
    entry,
    handles: treeHandles(entry, shown),
    sizes: subtreeSizes(entry, shown),
    attached: atlasAttachedPaths(brain, root),
  };
}

/** The `tree` state as the block carries it: anchor (absolute), depth, lines, and the handles it minted. */
export function projectTreeBlock(
  root: string,
  anchor: string,
  depth: number,
  brain: CartoBrain,
): { root: string; depth: number; lines: string[]; handles: TreeHandles } {
  // Depth 1 is the anchor and its immediate contents; there is no rendering
  // below that, so anything under 1 renders as 1 (§6.3). Nothing is refused:
  // a depth below 1 is not an error, it is the same tree.
  const shown = Number.isFinite(depth) ? Math.max(1, Math.trunc(depth)) : 1;
  const target = containedAnchor(root, anchor);
  const entry = scanTree(root, target);
  const handles = treeHandles(entry, shown);
  const lines = renderTreeLines(entry, shown, atlasAttachedPaths(brain, root), handles);
  return { root: target, depth: shown, lines, handles };
}
