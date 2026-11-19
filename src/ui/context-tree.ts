import { distribute, findNode, flatten, type ContextTree, type TreeNode } from "../domain/prompt-tree.js";
import type { ProjectView } from "../runtime/project.js";
import { projectContext, renderContextPlan } from "../domain/context.js";
import { mergeCarryPins } from "../domain/context.js";
import { row } from "./chrome.js";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { token } from "./tokens.js";
import { short, wrap } from "./text.js";

/**
 * The Context tab: what the model is sent, foldable.
 *
 * The tab used to be a flat list of projection blocks. That was wrong in two
 * ways the person named:
 *
 * - It was a *projection*, not the prompt. The instructions block, the
 *   transcript, and the tool schemas were all sent and none of them appeared.
 * - Every row was flat, so there was no compact way to read it and no way to
 *   open one part without replacing the whole screen.
 *
 * So the tab is now a tree of the payload `beforeProviderRequest` captured, in
 * the provider's own order. `←` and `→` fold and unfold, which is the compact
 * view and the detailed view of the same thing. Enter no longer opens a page.
 *
 * Until the first request there is no payload, and the tree says so before it
 * shows the projection it expects to be sent: the projection is marked
 * `unconfirmed` and never presented as what was sent.
 */

/** Which nodes are open. Closed by default is the compact view. */
export type Folds = ReadonlySet<string>;

/** A row the tree draws, and what it belongs to. */
export interface TreeRow {
  text: string;
  /** The node this row is part of, for selection and folding. */
  id: string;
  /** The row can be folded or unfolded. */
  foldable: boolean;
  /** The row is a label row rather than content. */
  head: boolean;
  /** 0 for a root, 1 for a child. */
  depth: number;
  selectable: boolean;
}

/** True when the node named `id` is open. A closed node shows only itself. */
export function isOpen(folds: Folds, id: string): boolean {
  return folds.has(id);
}

/**
 * The tree as rows.
 *
 * A closed node is one row. An open node is its own row, then its children, then
 * — if the person asked for the real view — its raw JSON indented under it. The
 * two views are the same node, so a fold survives switching between them.
 */
export function treeRows(tree: ContextTree, folds: Folds, real: Folds, selected: number, columns: number): TreeRow[] {
  const rows: TreeRow[] = [];
  // Shares exist only when the provider reported a total. They are proportional
  // cuts of a real number, so the total is exact and each share is not.
  const shares = tree.total === undefined ? undefined : distribute(tree.roots, tree.total);
  let index = 0;
  const walk = (node: TreeNode, depth: number): void => {
    const foldable = node.children.length > 0;
    // A leaf is not "closed": it has nothing to fold, and its content is the only
    // thing it exists to show. Only a node with children can be folded shut.
    const open = !foldable || isOpen(folds, node.id);
    const here = index++;
    const marker = foldable ? (open ? "▾" : "▸") : "·";
    const indent = "  ".repeat(depth);
    const share = shares?.get(node.id);
    // A share is always an estimate even when the total is exact, so it carries
    // the estimate glyph. Showing a proportional cut as though it were measured
    // is the kind of precision that misleads.
    const cost = share === undefined ? "" : token.faint(` ▤${short(share)}`);
    const counts = foldable ? token.faint(` (${node.children.length})`) : "";
    const stale = node.stale === true ? token.warning(" · changed since") : "";
    rows.push({
      text: row(
        `${here === selected ? token.accent("▌") : " "} ${indent}${token.accent(marker)} ${node.label}`,
        `${stale}${cost}${counts}`,
        columns,
        1,
      ),
      id: node.id,
      foldable,
      head: true,
      depth,
      selectable: true,
    });
    if (!open) return;
    if (isOpen(real, node.id)) {
      for (const line of node.raw.split("\n")) {
        for (const wrapped of wrap(line, Math.max(8, columns - 4 - depth * 2))) {
          rows.push({
            text: ` ${"  ".repeat(depth + 1)}${token.output(wrapped)}`,
            id: node.id,
            foldable: false,
            head: false,
            depth: depth + 1,
            selectable: false,
          });
        }
      }
      return;
    }
    for (const line of node.lines) {
      for (const wrapped of wrap(line, Math.max(8, columns - 4 - depth * 2))) {
        rows.push({
          text: ` ${"  ".repeat(depth + 1)}${wrapped}`,
          id: node.id,
          foldable: false,
          head: false,
          depth: depth + 1,
          selectable: false,
        });
      }
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of tree.roots) walk(root, 0);
  return rows;
}

/** The selectable node ids of some rows, in the order they appear. */
export function selectableOf(rows: readonly TreeRow[]): string[] {
  const ids: string[] = [];
  for (const entry of rows) if (entry.selectable && !ids.includes(entry.id)) ids.push(entry.id);
  return ids;
}

/**
 * The tree before the first request: the projection, marked unconfirmed.
 *
 * The person chose this over an empty tab. It is labelled so nobody mistakes it
 * for what was sent: the difference is the whole point of the tab.
 */
export function unconfirmedRows(view: ProjectView, folds: Folds, selected: number, columns: number): TreeRow[] {
  const plan = projectContext(view.brain, {
    budget: view.context.budget,
    carryPins: mergeCarryPins(view.liveCarryPins, view.brain.carryPins),
  });
  const text = renderContextPlan(plan);
  const rows: TreeRow[] = [
    {
      text: row(`${token.warning("Nothing sent yet")}`, token.faint("this is what will be sent"), columns),
      id: "unconfirmed",
      foldable: false,
      head: true,
      depth: 0,
      selectable: false,
    },
    {
      text: row(`  ${token.muted("The projection below is Carto's own plan. It is not the prompt.")}`, "", columns),
      id: "unconfirmed-note",
      foldable: false,
      head: true,
      depth: 0,
      selectable: false,
    },
  ];
  const groups = groupBlocks(plan);
  groups.forEach((group, index) => {
    const id = `plan-${index}`;
    const open = folds.has(id);
    const label = `${group.title} · ${group.blocks.length}`;
    rows.push({
      text: row(`${index === selected ? token.accent("▌") : " "} ${token.accent(open ? "▾" : "▸")} ${label}`, token.faint(`${short(group.tokens)}tok`), columns, 1),
      id,
      foldable: true,
      head: true,
      depth: 0,
      selectable: true,
    });
    if (!open) return;
    for (const block of group.blocks) {
      for (const line of wrap(block, Math.max(8, columns - 6))) {
        rows.push({ text: `    ${line}`, id: `${id}-text`, foldable: false, head: false, depth: 1, selectable: false });
      }
    }
  });
  return rows;
}

function groupBlocks(plan: ReturnType<typeof projectContext>): Array<{ title: string; blocks: string[]; tokens: number }> {
  const groups: Array<{ title: string; blocks: string[]; tokens: number }> = [];
  for (const block of plan.blocks) {
    const last = groups.at(-1);
    const title = sectionTitle(block.section);
    if (last !== undefined && last.title === title) {
      last.blocks.push(block.text);
      last.tokens += block.estimatedTokens;
    } else {
      groups.push({ title, blocks: [block.text], tokens: block.estimatedTokens });
    }
  }
  return groups;
}

function sectionTitle(section: string): string {
  const names: Record<string, string> = {
    rules: "Rules",
    ledger: "Ledger",
    chat: "Chat",
    atlas: "Atlas",
    pin: "Pins",
    handoff: "Handoff",
    active: "Active state",
    message: "Current input",
  };
  return names[section] ?? section;
}

/** The deepest node a row belongs to, for the footer's description. */
export function nodeAt(tree: ContextTree, id: string): TreeNode | undefined {
  return findNode(tree.roots, id);
}

/** A node's label, cut, for a message that names it. */
export function nameOf(tree: ContextTree, id: string): string {
  const node = nodeAt(tree, id);
  return node === undefined ? "" : truncateToWidth(node.label, 40, "…");
}

/** Kept here so the footer and the tab agree on what `v` does. */
export const VIEW_HINT = "v human/real";
export const FOLD_HINT = "← → fold";
