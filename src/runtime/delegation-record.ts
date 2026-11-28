/**
 * Dormant sequential handoff record. Pi commits this document with the other
 * changes in the main conversation's generation store. It is not a scheduler:
 * no model, child conversation, report delivery or collapse is driven here.
 * Returned handoffs cross a collapse via the Brain's temporary transfer record.
 * Unfinished or ambiguous handoffs remain in their source store.
 */
import { defineDoc } from "@earendil-works/pi-durable";
import type { DelegateSourceSeal } from "./delegate-source-seal.js";

export type DelegateRole = "capture" | "implementation" | "verification";
export type DelegationInput = {
  id: string;
  role: DelegateRole;
  instruction: string;
  doneWhen: string;
};
export type DelegateReport = {
  status: "done" | "partial" | "blocked" | "unverified";
  findings: string;
  changes: string;
  checks: string;
  uncertainty: string;
  remaining: string;
  mainMessage: string;
};
export type DelegationReturn =
  | { kind: "delegate"; report: DelegateReport }
  | { kind: "person-ended"; reason: string }
  | { kind: "failure"; explanation: string };
export type Delegation =
  | { phase: "prepared"; input: DelegationInput }
  | { phase: "running"; input: DelegationInput; conversationId: number }
  | { phase: "ending"; input: DelegationInput; conversationId: number | null; reason: string }
  | { phase: "returned"; input: DelegationInput; conversationId: number | null; result: DelegationReturn };
export type DelegationRecord = { active: Delegation | null };

/** Exact source revisions, retained until placement in the destination succeeds. */
export type StoredCheckpoint = { documentId: number; revision: number; content: string };
export type DelegationTransfer = StoredCheckpoint & {
  source: string;
  destination: string;
  /** Dormant change detector; it does not authorize multi-conversation deletion. */
  sourceSeal?: DelegateSourceSeal;
  inputCheckpoint?: StoredCheckpoint & { barrier: StoredCheckpoint };
};

/** Fail closed on unexpected shape; preserve the original bytes for comparison. */
export function parseReturnedDelegation(content: string): DelegationRecord {
  const value: unknown = JSON.parse(content);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid delegation record.");
  const active = (value as DelegationRecord).active;
  if (active === null || typeof active !== "object" || active.phase !== "returned") {
    throw new Error("Collapse cannot transfer an unfinished delegation record.");
  }
  const check: DelegationRecord = { active: null };
  if (active.input === null || typeof active.input !== "object") throw new Error("Invalid delegation input.");
  prepareDelegation(check, active.input);
  if (active.conversationId !== null) startDelegation(check, active.input.id, active.conversationId);
  if (active.result === null || typeof active.result !== "object") throw new Error("Invalid delegation return.");
  returnDelegation(check, active.input.id, active.result);
  return value as DelegationRecord;
}

export const DelegationDoc = defineDoc<DelegationRecord>({
  kind: "carto.delegation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ active: null }),
  checkpointWhen: () => true,
});

/** This source/admission marker is conversation-local and is not transferred by collapse. */
export const DelegateMainBarrierDoc = defineDoc<{ sourceId: string | null; admittedId: string | null; submissionId: number | null }>({
  kind: "carto.delegate-main-barrier", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ sourceId: null, admittedId: null, submissionId: null }), checkpointWhen: () => true,
});

function nonempty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must not be blank.`);
}

/** Invoke these transitions inside a Pi commit; never start external work in it. */
export function prepareDelegation(record: DelegationRecord, input: DelegationInput): void {
  if (record.active !== null) throw new Error("A delegation is already recorded.");
  nonempty(input.id, "Delegation ID");
  nonempty(input.instruction, "Instruction");
  nonempty(input.doneWhen, "Done-when");
  if (!["capture", "implementation", "verification"].includes(input.role)) throw new Error("Invalid delegation role.");
  record.active = { phase: "prepared", input: { ...input } };
}

export function startDelegation(record: DelegationRecord, id: string, conversationId: number): void {
  const active = record.active;
  if (active === null || active.input.id !== id || active.phase !== "prepared") throw new Error("Delegation is not prepared.");
  if (!Number.isSafeInteger(conversationId) || conversationId < 1) throw new Error("Invalid delegate conversation ID.");
  record.active = { phase: "running", input: active.input, conversationId };
}

/** An ending intent blocks late reports and survives interruption before abort completes. */
export function requestDelegationEnd(record: DelegationRecord, id: string, reason: string): void {
  if (typeof reason !== "string") throw new Error("The person's reason must be text.");
  const active = record.active;
  if (active === null || active.input.id !== id || active.phase === "returned") throw new Error("Delegation is not active.");
  if (active.phase === "ending") {
    if (active.reason !== reason) throw new Error("The delegation is already ending with a different reason.");
    return;
  }
  record.active = { phase: "ending", input: active.input, conversationId: active.phase === "running" ? active.conversationId : null, reason };
}

/** Call only after the delegate's ordinary work has stopped. */
export function finishDelegationEnd(record: DelegationRecord, id: string): void {
  const active = record.active;
  if (active === null || active.input.id !== id || active.phase !== "ending") throw new Error("Delegation is not ending.");
  record.active = { phase: "returned", input: active.input, conversationId: active.conversationId, result: { kind: "person-ended", reason: active.reason } };
}

export function returnDelegation(record: DelegationRecord, id: string, result: DelegationReturn): void {
  const active = record.active;
  if (active === null || active.input.id !== id || active.phase === "returned" || active.phase === "ending") throw new Error("Delegation cannot return.");
  if (result.kind === "delegate") {
    if (active.phase !== "running") throw new Error("A delegate report requires a running delegation.");
    if (!["done", "partial", "blocked", "unverified"].includes(result.report.status)) throw new Error("Invalid delegate report status.");
    for (const [name, value] of Object.entries(result.report)) nonempty(value, `Report ${name}`);
    for (const name of ["findings", "changes", "checks", "uncertainty", "remaining", "mainMessage"] as const) nonempty(result.report[name], `Report ${name}`);
  } else if (result.kind === "person-ended") {
    if (typeof result.reason !== "string") throw new Error("The person's reason must be text.");
  } else if (result.kind === "failure") {
    nonempty(result.explanation, "Failure explanation");
  } else {
    throw new Error("Invalid delegation return.");
  }
  record.active = {
    phase: "returned",
    input: active.input,
    conversationId: active.phase === "running" ? active.conversationId : null,
    result: structuredClone(result),
  };
}
