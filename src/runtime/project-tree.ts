/**
 * The project tree (§6.3).
 *
 * Anchored at a directory inside the project root, to a depth, rendered for
 * the state block: files, directories, sizes, and which files an Atlas node
 * links to — a map of what the agent understands, not a listing. The agent
 * moves the anchor and the depth; the anchor stays inside the project.
 *
 * Sizes aggregate the scanned subtree (lstat, symlinks are leaves). `.brain` and
 * `.git` are never shown: they are skipped everywhere they would appear, and
 * they may not be an anchor — the agent does not see the Brain or repository
 * internals (§2.3, §7). Gitignored paths are skipped the same way (the
 * project's own `.gitignore` chain — root file, `.git/info/exclude`, nested
 * files below the anchor): no line, no bytes in any aggregate, and ignored
 * directories are pruned, not merely hidden. Depth and an entry budget bound
 * the walk; incomplete aggregates and omitted listings are marked explicitly.
 *
 * The `tree` tool sets anchor and depth in session state for the state block;
 * the state block renders the tree at the tail of every request.
 */
import { lstatSync, opendirSync, realpathSync, statSync } from "node:fs";
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
  /** Files: their own size. Directories: bytes found within the scan bounds. */
  size: number;
  /** Some subtree bytes may not have been counted. */
  incomplete?: boolean;
  /** This directory listing was cut short or could not be read. */
  listingIncomplete?: boolean;
  /** Ancestor retained only to explain the current page; it has no handle. */
  contextOnly?: boolean;
  children?: TreeEntry[];
}

export class AnchorError extends Error {}

/** The internal anchor must stay inside the project root and outside `.brain` and `.git`, as §2.3 and §7 require. */
export function containedAnchor(root: string, anchor: string): string {
  const r = resolve(root);
  const resolved = resolve(isAbsolute(anchor) ? anchor : resolve(r, anchor));
  const rel = relative(r, resolved);
  if (resolved !== r && (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
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

/** Every encountered directory entry counts, including ignored entries. */
export const TREE_ENTRY_BUDGET = 2000;
/** Maximum entries rendered per page unless the person configures another limit. */
export const DEFAULT_TREE_PAGE_SIZE = 100;
export const TREE_MAX_DEPTH = 64;
const TREE_CACHE_MS = 1000;
const cache = new Map<string, { at: number; entry: TreeEntry }>();

function scan(absolute: string, name: string, chain: IgnoreChain, levels: number, budget: { left: number }, followRoot = false): TreeEntry {
  const stat = followRoot ? statSync(absolute) : lstatSync(absolute);
  if (!stat.isDirectory()) return { name, path: absolute, directory: false, size: stat.size };
  // Do not read a directory beyond the displayed depth, even to check if empty.
  if (levels === 0) return { name, path: absolute, directory: true, size: 0, incomplete: true };
  const children: TreeEntry[] = [];
  let total = 0;
  let incomplete = false;
  let listingIncomplete = false;
  try {
    // Loading the ignore file directly is necessary even if the entry budget
    // stops before the directory iterator reaches its name.
    const childChain = deeperIgnoreChain(chain, absolute);
    const dir = opendirSync(absolute);
    try {
      while (true) {
        // One extra read detects truncation without processing another entry.
        const child = dir.readSync();
        if (child === null) break;
        if (budget.left === 0) { listingIncomplete = incomplete = true; break; }
        budget.left--;
        if (child.name === ".brain" || child.name === ".git") continue;
        const childPath = join(absolute, child.name);
        if (isIgnored(childChain, childPath, child.name, child.isDirectory())) continue;
        try {
          const scanned = scan(childPath, child.name, childChain, levels - 1, budget);
          children.push(scanned);
          total += scanned.size;
          if (scanned.incomplete) incomplete = true;
        } catch {
          listingIncomplete = incomplete = true;
        }
      }
    } finally { dir.closeSync(); }
  } catch {
    listingIncomplete = incomplete = true;
  }
  children.sort(entryOrder);
  return { name, path: absolute, directory: true, size: total, children,
    ...(incomplete ? { incomplete: true } : {}),
    ...(listingIncomplete ? { listingIncomplete: true } : {}) };
}

/** Walk only the requested levels and a fixed number of entries. */
export function scanTree(root: string, anchor: string, depth: number = TREE_MAX_DEPTH, entryBudget: number = TREE_ENTRY_BUDGET): TreeEntry {
  let target: string;
  try {
    target = containedAnchor(root, anchor);
    const actual = realpathSync(target);
    containedAnchor(realpathSync(root), actual);
  } catch (error) {
    if (error instanceof AnchorError) throw error;
    throw new AnchorError(`the anchor \`${anchor}\` cannot be read; pick a directory that exists inside the project.`);
  }
  const isRoot = target === resolve(root);
  const stat = isRoot ? statSync(target) : lstatSync(target);
  if (!stat.isDirectory()) {
    throw new AnchorError(`an anchor is a directory, and \`${anchor}\` is a file. Anchor at the directory that holds it, or read the file.`);
  }
  let chain = baseIgnoreChain(resolve(root));
  const anchorRel = relative(resolve(root), target);
  if (anchorRel !== "") {
    let current = resolve(root);
    for (const part of anchorRel.split(sep)) {
      current = join(current, part);
      chain = deeperIgnoreChain(chain, current);
    }
  }
  const levels = Number.isFinite(depth) ? Math.min(TREE_MAX_DEPTH, Math.max(1, Math.trunc(depth))) : 1;
  const budget = Number.isFinite(entryBudget) ? Math.max(0, Math.trunc(entryBudget)) : TREE_ENTRY_BUDGET;
  return scan(target, target.split(sep).pop() ?? ".", chain, levels, { left: budget }, isRoot);
}

/** Reuse the bounded filesystem result briefly; Brain annotations are projected fresh. */
function sharedScan(root: string, anchor: string, depth: number): TreeEntry {
  const key = JSON.stringify([resolve(root), anchor, depth]);
  const found = cache.get(key);
  const now = Date.now();
  if (found !== undefined && now - found.at < TREE_CACHE_MS && now >= found.at) return found.entry;
  const entry = scanTree(root, anchor, depth);
  if (cache.size >= 8) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now, entry });
  return entry;
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

/** A lower bound is not an exact directory size. */
export function formatTreeSize(entry: TreeEntry): string {
  return entry.incomplete ? `>=${entry.size}B` : formatSize(entry.size);
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
      if (!child.contextOnly) {
        const handle = child.directory ? `D${++directories}` : `F${++files}`;
        handles.set(child.path, handle);
      }
      walk(child, level + 1);
    }
  };
  walk(entry, 1);
  return handles;
}

/**
 * The bytes found in the subtree under one path. The scan already aggregates it, so this is a lookup, not a walk — the
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
  attached: ReadonlyMap<string, readonly string[]>,
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
        `${indent}${name}  ${formatTreeSize(child)}${child.contextOnly ? "  (context)" : ""}${handle === undefined ? "" : `  ${handle}`}${marks.length > 0 ? `  ${marks.join(" ")}` : ""}`,
      );
      walk(child, level + 1);
    }
    if (node.listingIncomplete) lines.push(`${"  ".repeat(level)}(entries omitted or unreadable)`);
  };
  walk(entry, 1);
  return lines;
}

/** A page is a contiguous slice of the scan's depth-first rendering order. */
export interface TreePageOptions {
  limit?: number;
  offset?: number;
}

function pageTree(entry: TreeEntry, depth: number, options: TreePageOptions): {
  entry: TreeEntry; offset: number; end: number; total: number; limit: number; scanIncomplete: boolean;
} {
  const entries: TreeEntry[] = [];
  let scanIncomplete = false;
  const collect = (node: TreeEntry, level: number): void => {
    if (node.listingIncomplete) scanIncomplete = true;
    if (level > depth) return;
    for (const child of node.children ?? []) {
      entries.push(child);
      collect(child, level + 1);
    }
  };
  collect(entry, 1);
  const requestedLimit = options.limit ?? DEFAULT_TREE_PAGE_SIZE;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(TREE_ENTRY_BUDGET, Math.trunc(requestedLimit))) : DEFAULT_TREE_PAGE_SIZE;
  const requestedOffset = options.offset ?? 0;
  const offset = Number.isFinite(requestedOffset) ? Math.min(entries.length, Math.max(0, Math.trunc(requestedOffset))) : 0;
  const end = Math.min(entries.length, offset + limit);
  if (offset === 0 && end === entries.length) return { entry, offset, end, total: entries.length, limit, scanIncomplete };
  const selected = new Set(entries.slice(offset, end).map((node) => node.path));
  const prune = (node: TreeEntry): TreeEntry | undefined => {
    const children = (node.children ?? []).flatMap((child) => {
      const kept = prune(child);
      return kept === undefined ? [] : [kept];
    });
    if (node !== entry && !selected.has(node.path) && children.length === 0) return undefined;
    return { ...node, ...(node !== entry && !selected.has(node.path) ? { contextOnly: true } : {}),
      ...(node.children === undefined ? {} : { children }) };
  };
  return { entry: prune(entry)!, offset, end, total: entries.length, limit, scanIncomplete };
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
  /** Entries before and after this page refer only to the bounded scan. */
  page: { offset: number; end: number; total: number; limit: number; scanIncomplete: boolean };
  handles: TreeHandles;
  /** Subtree bytes by path, for every entry the depth shows. */
  sizes: ReadonlyMap<string, number>;
  /** Atlas handles attached to each file path (§2.1). */
  attached: ReadonlyMap<string, readonly string[]>;
}

export function projectTreeView(root: string, anchor: string, depth: number, brain: CartoBrain, options: TreePageOptions = {}): TreeProjection {
  const shown = Number.isFinite(depth) ? Math.min(TREE_MAX_DEPTH, Math.max(1, Math.trunc(depth))) : 1;
  const target = containedAnchor(root, anchor);
  const scanned = sharedScan(root, target, shown);
  const { entry, ...page } = pageTree(scanned, shown, options);
  return {
    anchor: target,
    depth: shown,
    entry,
    page,
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
  options: TreePageOptions = {},
): { root: string; depth: number; lines: string[]; handles: TreeHandles; page: TreeProjection["page"] } {
  // Depth 1 is the anchor and its immediate contents; there is no rendering
  // below that, so anything under 1 renders as 1 (§6.3). Nothing is refused:
  // a depth below 1 is not an error, it is the same tree.
  const projection = projectTreeView(root, anchor, depth, brain, options);
  const { entry, handles } = projection;
  const lines = renderTreeLines(entry, projection.depth, projection.attached, handles);
  const { page } = projection;
  if (page.offset > 0 || page.end < page.total) {
    const next = page.end < page.total ? `; next: tree offset ${page.end}` : "";
    const shown = page.end === page.offset ? `empty at offset ${page.offset}` : `${page.offset + 1}-${page.end}`;
    lines.push(`  (page ${shown} of ${page.total} scanned entries; ${page.offset} before, ${page.total - page.end} after${next})`);
  }
  if (page.scanIncomplete) lines.push("  (scan incomplete: more entries may exist beyond the scan budget or be unreadable; re-anchor to explore)");
  if (entry.incomplete) lines.push("  (>= sizes are partial; depth, entry limit, or unreadable entries)");
  return { root: projection.anchor, depth: projection.depth, lines, handles, page };
}
