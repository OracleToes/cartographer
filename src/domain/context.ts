import { byCreatedAt } from "./brain.js";
import { ensureHandles, handleOf, type HandleKind, type HandleTable } from "./handles.js";
import type { AtlasNode, CartoBrain, CarryPin, SourceRef } from "./types.js";

/**
 * The projection carries the map, not the dialogue. Chat text and the person's
 * message reach the model through the transcript and tool results, never here.
 * Sections appear in this fixed order; the projection is rebuilt at collapse
 * and frozen between collapses.
 */
export type ContextSection = "ledger" | "atlas" | "pin" | "wake";

export type ContextReferenceKind = HandleKind;

/**
 * A public, generation-local reference. Its private storage record is kept in
 * the projector only. It is never rendered into agent context.
 */
export interface ContextReference {
  handle: string;
  kind: ContextReferenceKind;
  timestamp: number;
}

export interface ContextBlock {
  /** Internal stable block identity for the UI. It never goes to the agent. */
  id: string;
  section: ContextSection;
  /** Type-prefixed, generation-local handle shown to the person and agent. */
  handle: string;
  text: string;
  reason: string;
  estimatedTokens: number;
  required: boolean;
}

export interface ContextOmission {
  /** Internal identity for the Context UI. It never goes to the agent. */
  id: string;
  /** The safe public label used by the Context UI. */
  label: string;
  reason: "too-large" | "stale" | "not-relevant" | "duplicate";
}

export interface ContextPlan {
  /** Ordered by the live generation's public handle order. */
  references: ContextReference[];
  blocks: ContextBlock[];
  omissions: ContextOmission[];
  estimatedTokens: number;
  budget: number;
}

export interface ContextInput {
  budget: number;
}

/**
 * Make fresh agent context from durable records.
 *
 * The allocator runs at collapse. A new live generation receives a newly
 * allocated set, so a collapse naturally renumbers every handle. The
 * agent renderer receives block text and handles only; private storage IDs stay
 * below this presentation boundary.
 */
export function projectContext(brain: CartoBrain, input: ContextInput): ContextPlan {
  if (!Number.isInteger(input.budget) || input.budget <= 0) {
    throw new RangeError("Context budget must be a positive integer.");
  }

  const plan: ContextPlan = { references: [], blocks: [], omissions: [], estimatedTokens: 0, budget: input.budget };
  const table = ensureHandles(brain.handles, brain);
  const refs = new ReferenceIndex(table);
  plan.references = table.entries.map((entry) => ({ handle: entry.handle, kind: entry.kind, timestamp: entry.timestamp }));
  const ledger = byCreatedAt(brain.ledger);
  const atlas = byCreatedAt(brain.atlas);

  for (const entry of ledger) {
    const handle = refs.handle(entry.id, "ledger")!;
    add(
      plan,
      makeBlock(
        "ledger",
        `ledger:${entry.id}`,
        handle,
        [
          `${handle} Ledger · ${entry.kind} · ${entry.status} · at ${stamp(entry.updatedAt)}`,
          entry.text,
          entry.answer === null ? "" : `Answer: ${entry.answer.text}`,
        ]
          .filter(Boolean)
          .join("\n"),
        "Durable Ledger record",
        true,
      ),
    );
  }

  for (const node of atlas) addAtlas(plan, node, refs);

  for (const pin of byCreatedAt(brain.userPins)) addPin(plan, refs, "user", pin.id, pin.item, pin.reason, pin.source, pin.createdAt, true);
  for (const pin of byCreatedAt(brain.carryPins)) addPin(plan, refs, "carry", pin.id, pin.item, pin.reason, pin.source, pin.createdAt, false);

  addWakes(plan, brain, refs);

  return plan;
}

/** Render agent-safe text. It intentionally does not render ContextBlock.id. */
export function renderContextPlan(plan: ContextPlan): string {
  const groups: Array<{ section: ContextSection; blocks: ContextBlock[] }> = [];
  for (const block of plan.blocks) {
    const last = groups.at(-1);
    if (last !== undefined && last.section === block.section) last.blocks.push(block);
    else groups.push({ section: block.section, blocks: [block] });
  }
  return [
    "# Carto context",
    ...groups.map((group) => `## ${sectionTitle(group.section)}\n${group.blocks.map((block) => block.text).join("\n\n")}`),
  ].join("\n\n");
}

/**
 * Read-only view of the Brain's handle table. Rendering never allocates a
 * handle: a record without one is omitted so private IDs can never leak into
 * agent text as a fallback.
 */
class ReferenceIndex {
  private readonly table: HandleTable | undefined;

  constructor(table: HandleTable | undefined) {
    this.table = table;
  }

  handle(id: string, kind: ContextReferenceKind): string | undefined {
    return handleOf(this.table, kind, id);
  }

  /** Resolve a handle that may name any kind, for edge targets. */
  listAny(ids: readonly string[]): string {
    const kinds: readonly ContextReferenceKind[] = ["atlas", "ledger", "pin", "wake", "chat"];
    const handles = ids
      .map((id) => kinds.map((kind) => this.handle(id, kind)).find((value): value is string => value !== undefined))
      .filter((value): value is string => value !== undefined);
    return handles.join(", ") || "none";
  }
}

function add(plan: ContextPlan, block: ContextBlock): void {
  if (block.required || plan.estimatedTokens + block.estimatedTokens <= plan.budget) {
    plan.blocks.push(block);
    plan.estimatedTokens += block.estimatedTokens;
    return;
  }
  plan.omissions.push({ id: block.id, label: block.handle, reason: "too-large" });
}

function addPin(
  plan: ContextPlan,
  refs: ReferenceIndex,
  type: "user" | "carry",
  id: string,
  item: string,
  reason: string,
  source: SourceRef,
  createdAt: number,
  required: boolean,
): void {
  const handle = refs.handle(id, "pin")!;
  if (source.freshness === "stale") {
    plan.omissions.push({ id: `${type}-pin:${id}`, label: handle, reason: "stale" });
    add(
      plan,
      makeBlock(
        "pin",
        `${type}-pin:${id}:stale`,
        handle,
        `${handle} ${type === "user" ? "User pin" : "Carry pin"} · stale · at ${stamp(createdAt)}\nStale pin: ${reason}. Inspect ${sourceLabel(source)} again.`,
        "Stale pin warning",
        true,
      ),
    );
    return;
  }
  add(
    plan,
    makeBlock(
      "pin",
      `${type}-pin:${id}`,
      handle,
      [
        `${handle} ${type === "user" ? "User pin" : "Carry pin"} · at ${stamp(createdAt)}`,
        `Reason: ${reason}`,
        `Source: ${sourceLabel(source)}`,
        pinItemText(item, source),
      ].join("\n"),
      required ? "User pin" : "Carry pin",
      true,
    ),
  );
}

function addAtlas(plan: ContextPlan, node: AtlasNode, refs: ReferenceIndex): void {
  const handle = refs.handle(node.id, "atlas")!;
  const stale = node.evidence.some((source) => source.freshness === "stale");
  if (stale) {
    plan.omissions.push({ id: `atlas:${node.id}`, label: handle, reason: "stale" });
    add(
      plan,
      makeBlock(
        "atlas",
        `atlas:${node.id}:stale`,
        handle,
        `${handle} Atlas · stale · at ${stamp(node.updatedAt)}\nInspect its evidence again before you use this claim.`,
        "Stale Atlas warning",
        true,
      ),
    );
    return;
  }
  const edges = node.edges.map((edge) => `${edge.kind} ${refs.handle(edge.target, "atlas") ?? "(missing)"}`);
  add(
    plan,
    makeBlock(
      "atlas",
      `atlas:${node.id}`,
      handle,
      [
        `${handle} Atlas · at ${stamp(node.updatedAt)}`,
        `Title: ${node.title}`,
        `Claim: ${node.claim}`,
        `Evidence: ${node.evidence.map(sourceLabel).join(", ") || "none"}`,
        edges.length === 0 ? "" : `Edges: ${edges.join("; ")}`,
      ]
        .filter(Boolean)
        .join("\n"),
      "Fresh Atlas claim",
      true,
    ),
  );
}

function addWakes(plan: ContextPlan, brain: CartoBrain, refs: ReferenceIndex): void {
  for (const wake of brain.wakes) {
    if (wake.status !== "armed" && wake.status !== "ready") continue;
    const handle = refs.handle(wake.id, "wake")!;
    add(
      plan,
      makeBlock(
        "wake",
        `wake:${wake.id}`,
        handle,
        `${handle} Wake · ${wake.status} · at ${stamp(wake.createdAt)}\n${wake.reason}\nCondition: ${wake.condition}`,
        "Active wake",
        true,
      ),
    );
  }
}

function makeBlock(section: ContextSection, id: string, handle: string, text: string, reason: string, required: boolean): ContextBlock {
  return { id, section, handle, text, reason, required, estimatedTokens: estimateTokens(text) };
}

function sourceLabel(source: SourceRef): string {
  if (source.kind === "context") return "selected live context";
  return `${source.path}:${source.startLine}-${source.endLine}`;
}

function pinItemText(item: string, source: SourceRef): string {
  if (source.kind !== "context" || source.excerpt === item) return item;
  return `${item}\nSelected context:\n${source.excerpt}`;
}

function sectionTitle(section: ContextSection): string {
  switch (section) {
    case "ledger":
      return "Ledger";
    case "atlas":
      return "Atlas";
    case "pin":
      return "Pins";
    case "wake":
      return "Wakes";
  }
}

function stamp(value: number): string {
  return new Date(value).toISOString();
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
