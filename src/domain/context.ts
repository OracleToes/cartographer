import { visibleAtlas, visibleLedger } from "./brain.js";
import type { AtlasNode, MiniBrain, SourceRef } from "./types.js";

export interface ContextBlock {
  id: string;
  section: "rules" | "message" | "handoff" | "user-pin" | "carry-pin" | "ledger" | "atlas" | "runtime";
  text: string;
  reason: string;
  estimatedTokens: number;
  required: boolean;
}

export interface ContextOmission {
  id: string;
  reason: "too-large" | "stale" | "not-relevant" | "duplicate";
}

export interface ContextPlan {
  blocks: ContextBlock[];
  omissions: ContextOmission[];
  estimatedTokens: number;
  budget: number;
}

export interface ContextInput {
  budget: number;
  userMessage?: string;
}

export const MINI_RULES = [
  "Use evidence that Mini gives you. Inspect a file before you make a file claim.",
  "Write a person-facing message only with the chat tool.",
  "Use Ledger for goals, notes, and questions. Use Atlas for source-backed claims.",
  "Use a carry pin only when an item must enter the next context generation.",
  "Propose a patch. Do not write a project file before the person approves it.",
  "Request a collapse when the live context is too large.",
].join("\n");

export function projectContext(brain: MiniBrain, input: ContextInput): ContextPlan {
  if (!Number.isInteger(input.budget) || input.budget <= 0) {
    throw new RangeError("Context budget must be a positive integer.");
  }

  const plan: ContextPlan = { blocks: [], omissions: [], estimatedTokens: 0, budget: input.budget };
  add(plan, makeBlock("rules", "mini-rules", MINI_RULES, "Mini rules", true));

  if (input.userMessage !== undefined && input.userMessage.trim() !== "") {
    add(plan, makeBlock("message", "current-user-message", input.userMessage, "Current user message", true));
  }

  if (brain.handoff !== null) {
    add(plan, makeBlock("handoff", "handoff", handoffText(brain), "Current handoff", false));
  }

  for (const pin of brain.userPins) {
    addPin(plan, "user-pin", pin.id, pin.item, pin.reason, pin.source, true);
  }

  for (const pin of brain.carryPins) {
    addPin(plan, "carry-pin", pin.id, pin.item, pin.reason, pin.source, false);
  }

  const terms = searchTerms(input.userMessage ?? "");
  for (const entry of visibleLedger(brain).filter((entry) => entry.status === "open")) {
    const relevant = terms.length === 0 || matchesTerms(entry.text, terms);
    if (!relevant) {
      plan.omissions.push({ id: `ledger:${entry.id}`, reason: "not-relevant" });
      continue;
    }
    add(plan, makeBlock("ledger", `ledger:${entry.id}`, `${entry.kind}: ${entry.text}`, "Open Ledger record", false));
  }

  for (const node of visibleAtlas(brain)) {
    addAtlas(plan, node, terms);
  }

  const runtime = runtimeText(brain);
  if (runtime !== "") add(plan, makeBlock("runtime", "runtime", runtime, "Current wakes and changes", false));

  return plan;
}

export function renderContextPlan(plan: ContextPlan): string {
  return plan.blocks.map((block) => `## ${block.section}\n${block.text}`).join("\n\n");
}

function add(plan: ContextPlan, block: ContextBlock): void {
  if (block.required || plan.estimatedTokens + block.estimatedTokens <= plan.budget) {
    plan.blocks.push(block);
    plan.estimatedTokens += block.estimatedTokens;
    return;
  }
  plan.omissions.push({ id: block.id, reason: "too-large" });
}

function addPin(
  plan: ContextPlan,
  section: "user-pin" | "carry-pin",
  id: string,
  item: string,
  reason: string,
  source: SourceRef,
  required: boolean,
): void {
  if (source.freshness === "stale") {
    plan.omissions.push({ id: `${section}:${id}`, reason: "stale" });
    add(plan, makeBlock(section, `${section}:${id}:stale`, `Stale pin: ${reason}. Inspect ${sourceLabel(source)} again.`, "Stale pin warning", false));
    return;
  }
  const text = `Reason: ${reason}\nSource: ${sourceLabel(source)}\n${item}`;
  add(plan, makeBlock(section, `${section}:${id}`, text, `${section} selected by ${required ? "person" : "agent"}`, required));
}

function addAtlas(plan: ContextPlan, node: AtlasNode, terms: string[]): void {
  const stale = node.evidence.some((source) => source.freshness === "stale");
  if (stale) {
    plan.omissions.push({ id: `atlas:${node.id}`, reason: "stale" });
    return;
  }
  const text = `${node.title}: ${node.claim}\nEvidence: ${node.evidence.map(sourceLabel).join(", ")}`;
  if (terms.length > 0 && !matchesTerms(text, terms)) {
    plan.omissions.push({ id: `atlas:${node.id}`, reason: "not-relevant" });
    return;
  }
  add(plan, makeBlock("atlas", `atlas:${node.id}`, text, "Fresh Atlas claim", false));
}

function makeBlock(
  section: ContextBlock["section"],
  id: string,
  text: string,
  reason: string,
  required: boolean,
): ContextBlock {
  return { id, section, text, reason, required, estimatedTokens: estimateTokens(text) };
}

function handoffText(brain: MiniBrain): string {
  const handoff = brain.handoff;
  if (handoff === null) return "";
  return [
    `Intent: ${handoff.intent}`,
    `Next action: ${handoff.nextAction}`,
    `Open Ledger: ${handoff.activeLedgerIds.join(", ") || "none"}`,
    `Open questions: ${handoff.openQuestionIds.join(", ") || "none"}`,
    `Atlas: ${handoff.relevantAtlasIds.join(", ") || "none"}`,
    handoff.note === "" ? "" : `Note: ${handoff.note}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function runtimeText(brain: MiniBrain): string {
  const lines: string[] = [];
  for (const wake of brain.wakes) {
    if (wake.status === "armed" || wake.status === "ready") lines.push(`Wake ${wake.id}: ${wake.status}; ${wake.reason}`);
  }
  for (const change of brain.changes) {
    if (change.status === "proposed" || change.status === "approved") lines.push(`Change ${change.id}: ${change.status}; ${change.rationale}`);
  }
  if (brain.deletionMarks.length > 0) lines.push(`${brain.deletionMarks.length} record(s) marked for deletion at the next collapse.`);
  return lines.join("\n");
}

function sourceLabel(source: SourceRef): string {
  if (source.kind === "context") return `context ${source.contextId}`;
  return `${source.path}:${source.startLine}-${source.endLine}`;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function searchTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_/-]{3,}/g) ?? [])];
}

function matchesTerms(value: string, terms: string[]): boolean {
  const lower = value.toLowerCase();
  return terms.some((term) => lower.includes(term));
}
