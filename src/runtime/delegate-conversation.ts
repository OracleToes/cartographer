/**
 * Dormant building block for a focused, task-owned Pi conversation. This does
 * not submit an instruction or expose a delegation tool. The caller must own
 * the handoff lifecycle and keep orchestration disabled until its controls and
 * recovery are implemented.
 */
import { configure, defineDoc, type ConversationHandle, type ConversationId, type Extension, type ModelRef, type SubmissionId, type TaskId, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { DelegationDoc, startDelegation } from "./delegation-record.js";

/** The same Pi request identity is used for admission, retry and recovery scans. */
export const delegateInputRequestId = (ownerId: TaskId): string => `carto.delegate-input:${ownerId}`;

/** Durable link checked by the child request barrier; not a substitute for task ownership. */
export const DelegateChildIdentityDoc = defineDoc<{ mainId: number | null; ownerId: number | null; handoffId: string | null }>({
  kind: "carto.delegate-child-identity", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ mainId: null, ownerId: null, handoffId: null }), checkpointWhen: () => true,
});

async function identifyChild(tx: Tx, child: ConversationId, main: ConversationId, owner: TaskId, handoff: string): Promise<void> {
  const identity = await tx.doc(DelegateChildIdentityDoc, child);
  if (identity.mainId === null && identity.ownerId === null && identity.handoffId === null && Object.keys(identity).length === 3) {
    identity.mainId = main;
    identity.ownerId = owner;
    identity.handoffId = handoff;
  } else if (Object.keys(identity).length !== 3 || identity.mainId !== main || identity.ownerId !== owner || identity.handoffId !== handoff) {
    throw new Error("Delegate child identity conflicts with its owner; it was preserved.");
  }
}

/** Call in the owning task's commit; no model or filesystem work runs here. */
export async function ensureDelegateConversation(
  tx: Tx,
  mainId: ConversationId,
  ownerId: TaskId,
  delegationId: string,
  agent: { model: ModelRef; cwd: string; instructions: string; extensions?: readonly Extension[]; tools?: readonly ToolRegistration[] },
): Promise<ConversationId> {
  if (!agent.model.provider.trim() || !agent.model.modelId.trim() || !agent.cwd.trim() || !agent.instructions.trim()) {
    throw new Error("A delegate requires an explicit model, working directory and instructions.");
  }
  // Table reads must precede createConversation: Pi rejects reads after writes.
  const owner = await tx.task(ownerId);
  const children = (await tx.scanConversations({ ownerTaskId: ownerId }, 2)).items;
  if (owner === undefined || owner.conversationId !== mainId) throw new Error("Delegate owner does not belong to the main conversation.");
  const record = await tx.doc(DelegationDoc, mainId);
  const active = record.active;
  if (active === null || active.input.id !== delegationId || active.phase === "ending" ||
      (active.phase === "returned" && active.result.kind !== "delegate")) {
    throw new Error("Delegation is not available for this owner.");
  }
  if (active.phase === "running" || active.phase === "returned") {
    if (children.length !== 1 || children[0]?.id !== active.conversationId || children[0].owner?.conversationId !== mainId) {
      throw new Error("Delegate conversation ownership conflicts with the handoff; data was preserved.");
    }
    await identifyChild(tx, children[0].id, mainId, ownerId, delegationId);
    return children[0].id;
  }
  if (children.length !== 0) throw new Error("Unexpected delegate conversations for the owner; data was preserved.");
  const child = await tx.createConversation({ ownership: { kind: "task", taskId: ownerId } });
  // Task-owned conversations inherit the owner's agent by default. Explicitly
  // replace inherited selections and prompt; a delegate must not inherit main's
  // tools, extensions, context, or automatic compaction. The caller selects
  // every extension and tool explicitly.
  await configure(tx, child.id, {
    model: agent.model,
    cwd: agent.cwd,
    instructions: agent.instructions,
    extensions: agent.extensions ?? [],
    tools: agent.tools ?? [],
    modelTools: agent.tools ?? [],
    compaction: { enabled: false },
  });
  await identifyChild(tx, child.id, mainId, ownerId, delegationId);
  startDelegation(record, delegationId, child.id);
  return child.id;
}

/** Admit the first child input only while its own handoff is still running. */
export async function admitDelegateInput(
  tx: Tx,
  mainId: ConversationId,
  ownerId: TaskId,
  delegationId: string,
  child: ConversationHandle,
): Promise<SubmissionId | null> {
  const conversation = await tx.conversation(child.id);
  const record = await tx.doc(DelegationDoc, mainId);
  const active = record.active;
  if (active === null || active.input.id !== delegationId || active.phase === "prepared" ||
      active.conversationId !== child.id || conversation?.owner?.conversationId !== mainId ||
      conversation.owner.taskId !== ownerId) {
    throw new Error("Delegate input does not match its owned handoff; no input was admitted.");
  }
  if (active.phase === "returned" || active.phase === "ending") return null;
  return child.submit(tx, {
    type: "input", content: JSON.stringify(active.input), requestId: delegateInputRequestId(ownerId),
  });
}
