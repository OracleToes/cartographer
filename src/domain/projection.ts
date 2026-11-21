/**
 * The frozen projection (MINI.md §6; docs/intent.md §19).
 *
 * Rebuilt only at collapse; never patched between collapses. It carries
 * structure, handles, and state — never a second copy of the dialogue: a
 * Person message lives in the transcript, and Agent Chat reaches the model
 * as the `chat` tool's result. There is no context budget and no omission
 * list: the person never confirmed one, and a limit the agent cannot
 * measure is worse than no limit (§2.3's logic, applied to the projection).
 *
 * Every durable ID line carries an ISO 8601 UTC timestamp (§6). Edges that
 * name a node which no longer exists render as `(gone)` — the agent tends
 * its graph; the projection never hides a dead reference (§2.1, §2.3).
 */
import { handleOf } from "./handles.js";
import { estimateTokens } from "./estimate.js";
import type { CartoBrain, SourceRef } from "./records.js";

export type ProjectionPartId = "atlas" | "ledger";

export interface ProjectionPart {
  id: ProjectionPartId;
  label: string;
  text: string;
  tokens: number;
}

export interface Projection {
  /** Stable, human-readable snapshot of the Brain at the freeze. */
  text: string;
  parts: ProjectionPart[];
  /** Sum of the parts' estimated tokens; informational, never enforced. */
  total: number;
  /** Sizes by part, for the state block's space accounting (MINI.md §6.1). */
  sizes: Record<ProjectionPartId, number>;
}

const tokens = estimateTokens;

const iso = (ms: number): string => new Date(ms).toISOString();

function sourceLine(source: SourceRef): string {
  const freshness = `[${source.freshness}]`;
  if (source.kind === "file") {
    return `${source.path}:${source.startLine}-${source.endLine} ${freshness}`;
  }
  return `context ${source.contextId} ${freshness}`;
}

function edgeLine(brain: CartoBrain, target: string): string {
  for (const entry of brain.handles.entries) {
    if (entry.id === target && entry.kind === "atlas") return entry.handle;
  }
  return "(gone)";
}

function resolveHandle(brain: CartoBrain, id: string): string {
  const hit = brain.handles.entries.find((entry) => entry.id === id);
  return hit === undefined ? "(gone)" : hit.handle;
}

function makePart(id: ProjectionPartId, label: string, lines: string[]): ProjectionPart {
  const text = lines.join("\n");
  return { id, label, text, tokens: tokens(text) };
}

export function projectContext(brain: CartoBrain): Projection {
  const handles = brain.handles;
  const partOf = (kind: Parameters<typeof handleOf>[1], id: string) =>
    handleOf(handles, kind, id) ?? "?";

  const atlas: string[] = [];
  if (brain.atlas.length > 0) {
    atlas.push("Atlas");
    for (const node of brain.atlas) {
      atlas.push(`${partOf("atlas", node.id)} ${node.title} — ${iso(node.updatedAt)}${node.pinned ? " · [pinned]" : ""}`);
      atlas.push(`  ${node.claim}`);
      for (const ref of node.evidence) atlas.push(`  evidence: ${sourceLine(ref)}`);
      for (const edge of node.edges) {
        atlas.push(`  → ${edge.kind} ${edgeLine(brain, edge.target)}`);
      }
    }
  }

  const ledger: string[] = [];
  if (brain.ledger.length > 0) {
    ledger.push("Ledger");
    for (const entry of brain.ledger) {
      ledger.push(
        `${partOf("ledger", entry.id)} [${entry.kind} · ${entry.status}] ${entry.text} — ${iso(entry.updatedAt)}${entry.pinned ? " · [pinned]" : ""}`,
      );
      if (entry.answer !== null) {
        const evidence = entry.answer.evidenceIds.map((id) => resolveHandle(brain, id)).join(", ");
        ledger.push(`  → answered: ${entry.answer.text}${evidence === "" ? "" : ` (evidence: ${evidence})`}`);
      }
    }
  }

  const parts: ProjectionPart[] = [];
  if (atlas.length > 0) parts.push(makePart("atlas", "Atlas", atlas));
  if (ledger.length > 0) parts.push(makePart("ledger", "Ledger", ledger));

  const text = parts.length === 0 ? "(the Brain is empty)" : parts.map((part) => part.text).join("\n\n");
  const sizes = { atlas: 0, ledger: 0 };
  for (const part of parts) sizes[part.id] = part.tokens;
  return { text, parts, total: parts.reduce((sum, part) => sum + part.tokens, 0), sizes };
}
