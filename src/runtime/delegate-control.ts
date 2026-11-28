/** Dormant immediate-end primitives; the host must control scheduling and return collapse. */
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import { LiveDoc, type Conversation, type ConversationId, type Harness, type Storage, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { CONTEXT_LIMIT_FAILURE, DelegationDoc, finishDelegationEnd, requestContextLimitEnd, requestDelegationEnd, type Delegation } from "./delegation-record.js";
import { DelegateLimitDoc, hasDelegateLimitMarker } from "./delegate-limit.js";
import { requireSoleDelegateCall } from "./delegate-round.js";
import { checkpointDelegateInputs, DelegateInputCheckpointDoc, findUnansweredDelegateInputs, findUnansweredInputs, parseInputCheckpoint } from "./delegate-inputs.js";

/** Verify the actual Pi task and owned child, not just an ID in the document. */
export async function ownedHandoff(tx: Tx, mainId: ConversationId, active: Delegation): Promise<{ ownerId: TaskId; childId: ConversationId | null }> {
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

type EndCause = "person" | "context-limit";

function matchesEnd(active: Delegation | null, id: string, cause: EndCause): active is Extract<Delegation, { phase: "ending" }> {
  return active?.input.id === id && active.phase === "ending" &&
    (cause === "person" ? active.cause === undefined : active.cause === "context-limit" && active.reason === CONTEXT_LIMIT_FAILURE);
}

async function completeEnd(main: Conversation, id: string, cause: EndCause, context: Context): Promise<void> {
  await main.commit(async (tx) => {
    const record = await tx.doc(DelegationDoc, main.id);
    const active = record.active;
    if (active?.input.id !== id) throw new Error("The ending handoff changed; it was preserved.");
    if (active.phase === "returned" && (cause === "person" ? active.result.kind === "person-ended" :
        active.result.kind === "failure" && active.result.explanation === CONTEXT_LIMIT_FAILURE)) return;
    if (!matchesEnd(active, id, cause)) throw new Error("The ending handoff changed; it was preserved.");
    finishDelegationEnd(record, id);
  }, context);
}

/**
 * The Tx API cannot scan submissions. After checkpointing, inspect Pi's
 * storage outside the Session line, then recheck the handoff, checkpoint and
 * each result on that line. Any earlier unanswered main or child input not
 * already in the checkpoint blocks abort; Pi may have discarded its content.
 * A caller must supply the Harness's own storage and seal new admissions
 * throughout this sequence; this is not a global lock.
 */
async function verifyCheckpointedInputs(main: Conversation, storage: Pick<Storage, "scanSubmissions">, id: string, cause: EndCause, context: Context): Promise<void> {
  const before = await main.commit(async (tx) => {
    const active = (await tx.doc(DelegationDoc, main.id)).active;
    if (!matchesEnd(active, id, cause)) throw new Error("The ending handoff changed; it was preserved.");
    const owned = await ownedHandoff(tx, main.id, active);
    const content = JSON.stringify(await tx.doc(DelegateInputCheckpointDoc, main.id));
    parseInputCheckpoint(content, id);
    return { ...owned, content };
  }, context);
  const mainUnanswered = await findUnansweredInputs(storage, main.id, context);
  const childUnanswered = before.childId === null ? [] : await findUnansweredDelegateInputs(storage, before.childId, before.ownerId, context);
  const unanswered = [...mainUnanswered, ...childUnanswered];
  await main.commit(async (tx) => {
    const active = (await tx.doc(DelegationDoc, main.id)).active;
    if (!matchesEnd(active, id, cause)) throw new Error("The ending handoff changed; it was preserved.");
    const owned = await ownedHandoff(tx, main.id, active);
    const content = JSON.stringify(await tx.doc(DelegateInputCheckpointDoc, main.id));
    if (owned.ownerId !== before.ownerId || owned.childId !== before.childId || content !== before.content) {
      throw new Error("The delegate input checkpoint or owner changed during verification; it was preserved.");
    }
    const captured = new Set(parseInputCheckpoint(content, id).inputs.map((input) => input.submissionId));
    for (const submission of unanswered) {
      const current = await tx.submission(submission.id);
      if (!isDeepStrictEqual(current, submission)) {
        throw new Error("A delegate submission changed during verification; it was preserved.");
      }
      if (!captured.has(submission.id)) {
        const label = submission.conversationId === main.id ? "Main" : "Delegate";
        throw new Error(`${label} input ${submission.id} was unanswered before checkpoint; its content may no longer be available. Recovery must resolve it before abort.`);
      }
    }
  }, context);
}

/** Seal main and child admission first; a failed checkpoint or abort leaves the intent recoverable. */
export async function endDelegateNow(harness: Harness, main: Conversation, storage: Pick<Storage, "scanSubmissions">, id: string, reason: string, context: Context): Promise<boolean> {
  if (!await requestImmediateDelegateEnd(main, id, reason, context)) return false;
  return stopEndingDelegate(harness, main, storage, id, "person", context);
}

async function stopEndingDelegate(harness: Harness, main: Conversation, storage: Pick<Storage, "scanSubmissions">, id: string, cause: EndCause, context: Context): Promise<boolean> {
  const ending = await main.commit(async (tx) => {
    const active = (await tx.doc(DelegationDoc, main.id)).active;
    if (!matchesEnd(active, id, cause)) throw new Error("The ending handoff changed; it was preserved.");
    const owned = await ownedHandoff(tx, main.id, active);
    await checkpointDelegateInputs(tx, main.id, id);
    return owned;
  }, context);
  await verifyCheckpointedInputs(main, storage, id, cause, context);
  if (ending.childId !== null) {
    const child = await harness.conversation(ending.childId, context);
    if (child === undefined) throw new Error("The delegate conversation is unavailable; the ending intent was preserved.");
    await child.abort(context); // Do not cross background-task boundaries.
  }
  await completeEnd(main, id, cause, context);
  return true;
}

/**
 * The host must invoke this only for its held-request notification and seal
 * admissions. The transaction checks a later request and a verified marker;
 * it cannot prove that the hook is still holding it or lock outside writers.
 */
export async function requestContextLimitDelegateEnd(main: Conversation, id: string, context: Context): Promise<boolean> {
  return main.commit(async (tx) => {
    const record = await tx.doc(DelegationDoc, main.id);
    const active = record.active;
    if (active?.input.id !== id) throw new Error("No matching active delegation.");
    if (active.phase === "returned" || (active.phase === "ending" && active.cause === undefined)) return false;
    const owned = await ownedHandoff(tx, main.id, active);
    if (owned.childId === null || !await hasDelegateLimitMarker(tx, main.id, owned.childId, owned.ownerId, id)) {
      throw new Error("No verified delegate context boundary; the handoff was preserved.");
    }
    if (active.phase === "ending") {
      if (!matchesEnd(active, id, "context-limit")) throw new Error("Invalid delegation ending intent; it was preserved.");
      return true;
    }
    if (active.phase !== "running") throw new Error("Delegate is not running at the context boundary.");
    const marker = await tx.doc(DelegateLimitDoc, owned.childId);
    const live = await tx.doc(LiveDoc, owned.childId);
    const task = live.run?.taskId === undefined ? undefined : await tx.task(live.run.taskId);
    const checkpoint = task?.state.status === "running" ? task.state.checkpoint : undefined;
    if (task?.kind !== "pi.generation" || task.conversationId !== owned.childId || task.abortRequested ||
        checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint) || checkpoint.phase !== "request" ||
        !Number.isSafeInteger(checkpoint.cutoff) || (checkpoint.cutoff as number) < 1 ||
        (task.id === marker.taskId && checkpoint.cutoff === marker.cutoff)) {
      throw new Error("The delegate has no later held request; the handoff was preserved.");
    }
    requestContextLimitEnd(record, id);
    return true;
  }, context);
}

/** Seal input admission before invoking; a failed checkpoint or scan never aborts. */
export async function endDelegateAtContextLimit(harness: Harness, main: Conversation, storage: Pick<Storage, "scanSubmissions">, id: string, context: Context): Promise<boolean> {
  if (!await requestContextLimitDelegateEnd(main, id, context)) return false;
  return stopEndingDelegate(harness, main, storage, id, "context-limit", context);
}

/**
 * Recovery must run before any caller enables scheduling, with main and child
 * input admission sealed. Checkpoint their inputs before aborting the main run;
 * the checkpoint still needs transfer and replay. The abort cascades to the owned
 * child and withdraws queued child input. The caller must handle main inputs
 * and collapse before allowing new inference.
 */
export async function recoverImmediateDelegateEnd(harness: Harness, main: Conversation, storage: Pick<Storage, "scanSubmissions">, context: Context): Promise<boolean> {
  return recoverEnd(harness, main, storage, "person", context);
}

/** As for person-end recovery, but retain system-failure provenance. */
export async function recoverContextLimitDelegateEnd(harness: Harness, main: Conversation, storage: Pick<Storage, "scanSubmissions">, context: Context): Promise<boolean> {
  return recoverEnd(harness, main, storage, "context-limit", context);
}

async function recoverEnd(harness: Harness, main: Conversation, storage: Pick<Storage, "scanSubmissions">, cause: EndCause, context: Context): Promise<boolean> {
  if ((await harness.inspect(context)).scheduling !== "paused") throw new Error("Delegate-end recovery requires a paused scheduler.");
  const state = await main.commit(async (tx) => {
    const active = (await tx.doc(DelegationDoc, main.id)).active;
    if (active?.phase !== "ending") return null;
    if (cause === "person" && active.cause === "context-limit") return null;
    if (cause === "context-limit" && active.cause === undefined) return null;
    if ((cause === "person" && active.cause !== undefined) ||
        (cause === "context-limit" && (active.cause !== "context-limit" || active.reason !== CONTEXT_LIMIT_FAILURE))) {
      throw new Error("Invalid delegation ending intent; it was preserved.");
    }
    if (cause === "context-limit") {
      const owned = await ownedHandoff(tx, main.id, active);
      if (owned.childId === null || !await hasDelegateLimitMarker(tx, main.id, owned.childId, owned.ownerId, active.input.id)) {
        throw new Error("No verified delegate context boundary; the handoff was preserved.");
      }
    }
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
  await verifyCheckpointedInputs(main, storage, state.id, cause, context);
  if (state.runId !== null) {
    await harness.abortTask(state.runId, context); // Does not enable scheduling.
    await harness.waitForTask(state.runId, context); // Enables it after the mark is durable.
  }
  await completeEnd(main, state.id, cause, context);
  return true;
}
