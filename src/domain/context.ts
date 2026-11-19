import { byCreatedAt, visibleAtlas, visibleChat, visibleLedger } from "./brain.js";
import { deletionHandleId, ensureHandles, handleOf, type HandleKind, type HandleTable } from "./handles.js";
import type { AtlasNode, CartoBrain, CarryPin, SourceRef } from "./types.js";

/**
 * Sections are emitted in this fixed order. The order is part of Carto's model
 * contract, so context does not change shape when a record becomes relevant.
 */
export type ContextSection = "rules" | "ledger" | "chat" | "atlas" | "pin" | "handoff" | "active" | "message";

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
  /** Ordered by the new live generation's public handle order. */
  references: ContextReference[];
  blocks: ContextBlock[];
  omissions: ContextOmission[];
  estimatedTokens: number;
  budget: number;
}

export interface ContextInput {
  budget: number;
  userMessage?: string;
  /** A caller must give a timestamp when it adds a transient current input. */
  at?: number;
  /** Carry pins selected by the active context generation. */
  carryPins?: readonly CarryPin[];
}

export const CARTO_RULES = [
  "Use only Carto records and inspected project files as evidence.",
  "Use the chat tool for deliberate person-facing Chat. Plain model text is not Chat.",
  "Use Ledger for goals, notes, and questions. Use Atlas for source-backed claims.",
  "Use only the short handles in this context. Do not infer private storage IDs.",
  "A deletion or pin removal can be pending until collapse. Respect its state.",
  "Propose a patch before the person approves it. Do not write a project file directly.",
  "Request collapse when this live context no longer helps.",
].join("\n");

/**
 * Make fresh agent context from durable records.
 *
 * The allocator runs for every new projection. A new live session receives a
 * newly allocated set, so a collapse naturally renumbers every handle. The
 * agent renderer receives block text and handles only; private storage IDs stay
 * below this presentation boundary.
 */
export function projectContext(brain: CartoBrain, input: ContextInput): ContextPlan {
  if (!Number.isInteger(input.budget) || input.budget <= 0) {
    throw new RangeError("Context budget must be a positive integer.");
  }
  if (input.userMessage !== undefined && input.userMessage.trim() !== "" && input.at === undefined) {
    throw new RangeError("A current input needs an ISO timestamp source.");
  }

  const plan: ContextPlan = { references: [], blocks: [], omissions: [], estimatedTokens: 0, budget: input.budget };
  const carryPins = mergeCarryPins(input.carryPins ?? brain.carryPins);
  // Handles are durable Brain state. A projection never invents a new number
  // for a record that already has one; it only shows the current table.
  const table = ensureHandles(brain.handles, brain, carryPins);
  const refs = new ReferenceIndex(table);
  plan.references = table.entries.map((entry) => ({ handle: entry.handle, kind: entry.kind, timestamp: entry.timestamp }));
  const ledger = byCreatedAt(visibleLedger(brain));
  const chat = byCreatedAt(visibleChat(brain));
  const atlas = byCreatedAt(visibleAtlas(brain));
  // A deferred removal hides the record from ordinary use at once. Only the
  // short removal mark below stays visible until collapse.
  const userPins = byCreatedAt(brain.userPins).filter(
    (pin) => !brain.deletionMarks.some((mark) => mark.target === "user-pin" && mark.id === pin.id),
  );

  // Allocation order matches fresh context: Ledger, chronological Chat, Atlas,
  // then pins, Handoff, and other active records. A marked record keeps its
  // handle until collapse. `collapse.rotate` purges it and rebuilds the table,
  // so the next live generation starts again at 1.

  add(plan, makeBlock("rules", "rules", "R1", `R1 Carto rules\n${CARTO_RULES}`, "Carto protocol", true));

  // Required durable content order: Ledger, Chat, Atlas, pins, Handoff, then
  // active typed state. Do not relevance-sort these groups.
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

  for (const entry of chat) {
    const handle = refs.handle(entry.id, "chat")!;
    const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : entry.createdAt;
    const changed = updatedAt !== entry.createdAt ? ` · edited ${stamp(updatedAt)}` : "";
    add(
      plan,
      makeBlock(
        "chat",
        `chat:${entry.id}`,
        handle,
        `${handle} ${entry.author === "user" ? "Person Chat" : "Agent Chat"} · at ${stamp(entry.createdAt)}${changed}\n${entry.text}`,
        "Deliberate chronological Chat",
        true,
      ),
    );
  }

  for (const node of atlas) addAtlas(plan, node, refs);

  for (const pin of userPins) addPin(plan, refs, "user", pin.id, pin.item, pin.reason, pin.source, pin.createdAt, true);
  for (const pin of byCreatedAt(carryPins)) addPin(plan, refs, "carry", pin.id, pin.item, pin.reason, pin.source, pin.createdAt, false);

  if (brain.handoff !== null) {
    const handle = refs.handle("handoff", "handoff")!;
    add(
      plan,
      makeBlock(
        "handoff",
        "handoff",
        handle,
        `${handle} Handoff · at ${stamp(brain.handoff.updatedAt)}\n${handoffText(brain, refs)}`,
        "Current handoff",
        true,
      ),
    );
  }

  addActiveState(plan, brain, refs);

  // Pi puts a user input into its own transcript. This optional planner value
  // exists for previews and tests only. It stays after durable structure.
  if (input.userMessage !== undefined && input.userMessage.trim() !== "") {
    add(
      plan,
      makeBlock(
        "message",
        "current-user-message",
        "M1",
        `M1 Current input · at ${stamp(input.at!)}\n${input.userMessage}`,
        "Current input",
        true,
      ),
    );
  }
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

/** Keep each carry pin once when a live generation and the Brain both refer to it. */
export function mergeCarryPins(...groups: ReadonlyArray<readonly CarryPin[]>): CarryPin[] {
  const pins = new Map<string, CarryPin>();
  for (const group of groups) {
    for (const pin of group) pins.set(pin.id, pin);
  }
  return [...pins.values()];
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

  list(ids: readonly string[], kind: ContextReferenceKind): string {
    const handles = ids.map((id) => this.handle(id, kind)).filter((value): value is string => value !== undefined);
    return handles.join(", ") || "none";
  }

  listAny(ids: readonly string[]): string {
    const kinds: readonly ContextReferenceKind[] = ["atlas", "ledger", "chat", "pin", "handoff", "wake", "change", "deletion"];
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
  const links = refs.listAny(node.links);
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
        `Links: ${links}`,
      ].join("\n"),
      "Fresh Atlas claim",
      true,
    ),
  );
}

function addActiveState(plan: ContextPlan, brain: CartoBrain, refs: ReferenceIndex): void {
  for (const wake of brain.wakes) {
    if (wake.status !== "armed" && wake.status !== "ready") continue;
    const handle = refs.handle(wake.id, "wake")!;
    add(
      plan,
      makeBlock(
        "active",
        `wake:${wake.id}`,
        handle,
        `${handle} Wake · ${wake.status} · at ${stamp(wake.createdAt)}\n${wake.reason}\nCondition: ${wake.condition}`,
        "Active wake",
        true,
      ),
    );
  }
  for (const change of brain.changes) {
    if (change.status !== "proposed" && change.status !== "approved") continue;
    const handle = refs.handle(change.id, "change")!;
    add(
      plan,
      makeBlock(
        "active",
        `change:${change.id}`,
        handle,
        `${handle} Change · ${change.status} · at ${stamp(change.createdAt)}\n${change.rationale}`,
        "Active change",
        true,
      ),
    );
  }
  for (const mark of brain.deletionMarks) {
    const handle = refs.handle(deletionHandleId(mark), "deletion")!;
    add(
      plan,
      makeBlock(
        "active",
        `deletion:${mark.target}:${mark.id}`,
        handle,
        `${handle} Deferred removal · at ${stamp(mark.markedAt)}\nTarget: ${deletionTargetLabel(mark.target, mark.id, refs)}. It is removed at collapse.`,
        "Deferred removal",
        true,
      ),
    );
  }
}

function makeBlock(section: ContextSection, id: string, handle: string, text: string, reason: string, required: boolean): ContextBlock {
  return { id, section, handle, text, reason, required, estimatedTokens: estimateTokens(text) };
}

function handoffText(brain: CartoBrain, refs: ReferenceIndex): string {
  const handoff = brain.handoff;
  if (handoff === null) return "";
  return [
    `Intent: ${handoff.intent}`,
    `Next action: ${handoff.nextAction}`,
    `Open Ledger: ${refs.list(handoff.activeLedgerIds, "ledger")}`,
    `Open questions: ${refs.list(handoff.openQuestionIds, "ledger")}`,
    `Atlas: ${refs.list(handoff.relevantAtlasIds, "atlas")}`,
    handoff.note === "" ? "" : `Note: ${handoff.note}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function deletionReferenceKey(target: string, id: string): string {
  return `deletion:${target}:${id}`;
}

function deletionTargetLabel(target: string, id: string, refs: ReferenceIndex): string {
  switch (target) {
    case "chat":
      return labelRecord("a Chat record", "chat", id, refs);
    case "ledger":
      return labelRecord("a Ledger record", "ledger", id, refs);
    case "atlas":
      return labelRecord("an Atlas record", "atlas", id, refs);
    case "user-pin":
      return labelRecord("a user pin", "pin", id, refs);
    case "carry-pin":
      return labelRecord("a carry pin", "pin", id, refs);
    default:
      return "a Carto record";
  }
}

function labelRecord(fallback: string, kind: ContextReferenceKind, id: string, refs: ReferenceIndex): string {
  const handle = refs.handle(id, kind);
  return handle === undefined ? fallback : handle;
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
    case "rules":
      return "Rules";
    case "ledger":
      return "Ledger";
    case "chat":
      return "Chat";
    case "atlas":
      return "Atlas";
    case "pin":
      return "Pins";
    case "handoff":
      return "Handoff";
    case "active":
      return "Active records";
    case "message":
      return "Current input";
  }
}

function stamp(value: number): string {
  return new Date(value).toISOString();
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
