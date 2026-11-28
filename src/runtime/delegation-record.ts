/**
 * Dormant sequential handoff record. Pi commits this document with the other
 * changes in the main conversation's generation store. It is not a scheduler:
 * no model, child conversation, report delivery or collapse is driven here.
 * A future caller must reconcile the record before that store is collapsed.
 */
import { defineDoc } from "@earendil-works/pi-durable";

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
  | { phase: "returned"; input: DelegationInput; conversationId: number | null; result: DelegationReturn };
export type DelegationRecord = { active: Delegation | null };

export const DelegationDoc = defineDoc<DelegationRecord>({
  kind: "carto.delegation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ active: null }),
  checkpointWhen: () => true,
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

export function returnDelegation(record: DelegationRecord, id: string, result: DelegationReturn): void {
  const active = record.active;
  if (active === null || active.input.id !== id || active.phase === "returned") throw new Error("Delegation cannot return.");
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
