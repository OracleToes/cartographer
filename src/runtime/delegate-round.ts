/** Use Pi's stored tool task and assistant entry, not a separately tracked round. */
import { AssistantEntry, type ConversationId, type EntryId, type TaskId, type Tx } from "@earendil-works/pi-durable";

export async function requireSoleDelegateCall(
  tx: Tx, conversationId: ConversationId, taskId: TaskId, callId: string, name: string,
): Promise<void> {
  const task = await tx.task(taskId);
  const input = task?.input;
  if (task?.kind !== "pi.tool" || task.conversationId !== conversationId || input === null || typeof input !== "object" || Array.isArray(input) ||
      input.kind !== "model" || typeof input.assistant !== "number" || input.callId !== callId) {
    throw new Error(`${name} requires its own model-issued tool task.`);
  }
  const entry = await tx.entry(AssistantEntry, input.assistant as EntryId);
  const message = entry?.model?.[0];
  const calls = message?.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [];
  if (entry?.conversationId !== conversationId || calls.length !== 1 || calls[0]?.id !== callId || calls[0].name !== name) {
    throw new Error(`${name} must be the only tool call in its round.`);
  }
}
