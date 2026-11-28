/**
 * Dormant building block for a focused, task-owned Pi conversation. This does
 * not submit an instruction or expose a delegation tool. The caller must own
 * the handoff lifecycle and keep orchestration disabled until its controls and
 * recovery are implemented.
 */
import { configure, type ConversationId, type Extension, type ModelRef, type TaskId, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { DelegationDoc, startDelegation } from "./delegation-record.js";

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
  if (active === null || active.input.id !== delegationId ||
      (active.phase === "returned" && active.result.kind !== "delegate")) {
    throw new Error("Delegation is not available for this owner.");
  }
  if (active.phase === "running" || active.phase === "returned") {
    if (children.length !== 1 || children[0]?.id !== active.conversationId || children[0].owner?.conversationId !== mainId) {
      throw new Error("Delegate conversation ownership conflicts with the handoff; data was preserved.");
    }
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
  startDelegation(record, delegationId, child.id);
  return child.id;
}
