/** Dormant immediate-end primitives; the host must control scheduling and return collapse. */
import type { Context } from "@earendil-works/chord/context";
import { LiveDoc, type Conversation, type ConversationId, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { DelegationDoc, finishDelegationEnd, requestDelegationEnd, type Delegation } from "./delegation-record.js";
import { requireSoleDelegateCall } from "./delegate-round.js";
import { checkpointDelegateInputs } from "./delegate-inputs.js";

/** Verify the actual Pi task and owned child, not just an ID in the document. */
async function ownedHandoff(tx: Tx, mainId: ConversationId, active: Delegation): Promise<{ ownerId: TaskId; childId: ConversationId | null }> {
  const match = /^delegate:([1-9][0-9]*)$/.exec(active.input.id);
  const number = match === null ? NaN : Number(match[1]);
  if (!Number.isSafeInteger(number)) throw new Error("The delegation owner identity is invalid; it was preserved.");
  const owner = await tx.task(number as TaskId);
  const call = owner?.input;
  if (owner?.kind !== "pi.tool" || owner.conversationId !== mainId || call === null || typeof call !== "object" || Array.isArray(call) || typeof call.callId !== "string") {
    throw new Error("The delegation owner is unavailable; it was preserved.");
  }
  await requireSoleDelegateCall(tx, mainId, owner.id, call.callId, "delegate");
  const children = (await tx.scanConversations({ ownerTaskId: owner.id }, 2)).items;
  const childId = active.phase === "prepared" ? null : active.conversationId;
  if (childId === null) {
    if (children.length !== 0) throw new Error("Unexpected delegate child; the handoff was preserved.");
    return { ownerId: owner.id, childId: null };
  }
  const child = children[0];
  if (children.length !== 1 || child?.id !== childId || child.owner?.conversationId !== mainId || child.owner.taskId !== owner.id) {
    throw new Error("Delegate ownership conflicts with the handoff; it was preserved.");
  }
  return { ownerId: owner.id, childId: child.id };
}

/** First persist the person's intent. A racing already-committed return wins. */
export async function requestImmediateDelegateEnd(main: Conversation, id: string, reason: string, context: Context): Promise<boolean> {
  return main.commit(async (tx) => {
    const record = await tx.doc(DelegationDoc, main.id);
    const active = record.active;
    if (active === null || active.input.id !== id) throw new Error("No matching active delegation.");
    if (active.phase === "returned") return false;
    await ownedHandoff(tx, main.id, active);
    requestDelegationEnd(record, id, reason);
    return true;
  }, context);
}

async function completeEnd(main: Conversation, id: string, context: Context): Promise<void> {
  await main.commit(async (tx) => {
    const record = await tx.doc(DelegationDoc, main.id);
    const active = record.active;
    if (active?.input.id !== id) throw new Error("The ending handoff changed; it was preserved.");
    if (active.phase === "returned" && active.result.kind === "person-ended") return;
    finishDelegationEnd(record, id);
  }, context);
}

/** Seal main and child admission first; a failed checkpoint or abort leaves the intent recoverable. */
export async function endDelegateNow(harness: Harness, main: Conversation, id: string, reason: string, context: Context): Promise<boolean> {
  if (!await requestImmediateDelegateEnd(main, id, reason, context)) return false;
  const ending = await main.commit(async (tx) => {
    const active = (await tx.doc(DelegationDoc, main.id)).active;
    if (active?.input.id !== id || active.phase !== "ending") throw new Error("The ending handoff changed; it was preserved.");
    const owned = await ownedHandoff(tx, main.id, active);
    await checkpointDelegateInputs(tx, main.id, id);
    return owned;
  }, context);
  if (ending.childId !== null) {
    const child = await harness.conversation(ending.childId, context);
    if (child === undefined) throw new Error("The delegate conversation is unavailable; the ending intent was preserved.");
    await child.abort(context); // Do not cross background-task boundaries.
  }
  await completeEnd(main, id, context);
  return true;
}

/**
 * Recovery must run before any caller enables scheduling, with main and child
 * input admission sealed. Checkpoint their inputs before aborting the main run;
 * the checkpoint still needs transfer and replay. The abort cascades to the owned
 * child and withdraws queued child input. The caller must handle main inputs
 * and collapse before allowing new inference.
 */
export async function recoverImmediateDelegateEnd(harness: Harness, main: Conversation, context: Context): Promise<boolean> {
  if ((await harness.inspect(context)).scheduling !== "paused") throw new Error("Delegate-end recovery requires a paused scheduler.");
  const state = await main.commit(async (tx) => {
    const active = (await tx.doc(DelegationDoc, main.id)).active;
    if (active?.phase !== "ending") return null;
    const owner = await ownedHandoff(tx, main.id, active);
    const ownerTask = await tx.task(owner.ownerId);
    if (ownerTask === undefined) throw new Error("The delegate owner is missing; the ending intent was preserved.");
    const live = await tx.doc(LiveDoc, main.id);
    const runId = live.run?.taskId;
    if (runId === undefined) {
      if (ownerTask.state.status !== "terminal") throw new Error("The owning main run is missing; the ending intent was preserved.");
      await checkpointDelegateInputs(tx, main.id, active.input.id);
      return { id: active.input.id, runId: null };
    }
    let task = ownerTask;
    const seen = new Set<number>();
    while (task.id !== runId) {
      if (seen.has(task.id) || task.owner === undefined) throw new Error("The delegate is not owned by the active main run; the ending intent was preserved.");
      seen.add(task.id);
      const parent = await tx.task(task.owner);
      if (parent === undefined || parent.conversationId !== main.id) throw new Error("The delegate ownership chain is incomplete; the ending intent was preserved.");
      task = parent;
    }
    await checkpointDelegateInputs(tx, main.id, active.input.id);
    return { id: active.input.id, runId };
  }, context);
  if (state === null) return false;
  if (state.runId !== null) {
    await harness.abortTask(state.runId, context); // Does not enable scheduling.
    await harness.waitForTask(state.runId, context); // Enables it after the mark is durable.
  }
  await completeEnd(main, state.id, context);
  return true;
}
