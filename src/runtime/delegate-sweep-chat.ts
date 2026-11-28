/** Dormant identity-aware Chat handling for prepared delegate return sweeps. */
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { personChatBindings, userText, type ChatBodyEntry } from "../domain/chat-identity.js";
import type { ChatRecord } from "../domain/records.js";
import { prepareReturnSweepParts, type ReturnSweepPart } from "./collapse.js";
import type { ReturnSweepView } from "./delegate-sweep-view.js";

export type ReturnSweepChatDuplicate = { entryId: number; itemId: string; recordId: string; part: ReturnSweepPart };

/**
 * Prepare a return sweep without removing a child contribution by text match.
 * Only a main person message with a unique, explicit Chat identity, matching
 * record text, and no non-text content is redundant. Legacy or conflicting
 * identities remain archive items. A Carto edit can establish an identity on
 * a legacy entry only while it is the latest visible edit of that entry. A
 * main agent chat call is redundant only if its call ID and text match one
 * agent Chat record and the call carries no extra arguments or metadata. Child
 * calls, signed or otherwise richer calls, and their results remain separate.
 * Candidate duplicates retain their full part for subsequent mark handling.
 *
 * This is not an archive commit or permission to delete the source. The host
 * must seal all writers, include checkpointed inputs, check pins and deletion
 * marks, and coordinate a durable return collapse.
 */
export function prepareReturnSweepArchive(
  views: readonly ReturnSweepView[], generation: string, records: readonly ChatRecord[], headIds: ReadonlySet<string>,
): { parts: ReturnSweepPart[]; chatDuplicates: ReturnSweepChatDuplicate[] } {
  const parts = prepareReturnSweepParts(views, generation);
  const mains = views.filter(({ conversation }) => conversation.id === ROOT_CONVERSATION_ID);
  if (mains.length !== 1) throw new Error("Return sweep needs exactly one main conversation; the source was preserved.");
  const main = mains[0]!.view;

  // Pi's view places the head marker first, not necessarily chronologically.
  // Track the latest visible edit by its actual entry ID, never view order.
  const latestEdits = new Map<number, string | null>();
  for (const entry of [...main.entries].sort((a, b) => a.id - b.id)) {
    for (const edit of entry.edits ?? []) {
      const data = entry.data;
      const validData = data !== null && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
      const recordId = validData?.recordId;
      const identified = entry.kind === "carto.edit-chat" && edit.action === "replace" &&
        validData?.entry === String(edit.target) && validData.item === `${generation}:${edit.target}:x0` &&
        typeof recordId === "string" && recordId.length > 0;
      latestEdits.set(edit.target, identified ? recordId as string : null);
    }
  }

  const eligible: ChatBodyEntry[] = [];
  const uses = new Map<string, number>();
  for (const [index, entry] of main.entries.entries()) {
    const messages = main.contributions[index];
    const message = messages?.[0];
    if (messages?.length !== 1 || message?.role !== "user") continue;
    const data = entry.data !== null && typeof entry.data === "object" && !Array.isArray(entry.data)
      ? entry.data as Record<string, unknown> : undefined;
    const raw = entry.kind === "carto.user" ? data?.chatRecordId : undefined;
    const edited = latestEdits.get(entry.id);
    for (const id of new Set([raw, edited].filter((value): value is string => typeof value === "string" && value.length > 0))) {
      uses.set(id, (uses.get(id) ?? 0) + 1);
    }
    if (raw !== undefined && (typeof raw !== "string" || raw.length === 0)) continue;
    if (typeof raw === "string" && typeof edited === "string" && raw !== edited) continue;
    const recordId = typeof raw === "string" ? raw : edited;
    if (typeof recordId !== "string") continue; // Never infer a legacy identity from matching text.
    eligible.push({ id: entry.id, data: { chatRecordId: recordId }, model: messages });
  }
  const bindings = personChatBindings(eligible, records, headIds);
  const recordsById = new Map<string, ChatRecord[]>();
  for (const record of records) recordsById.set(record.id, [...(recordsById.get(record.id) ?? []), record]);
  const entries = new Map(eligible.map((entry) => [entry.id!, entry]));
  const chatDuplicates: ReturnSweepChatDuplicate[] = [];
  const kept = parts.filter((part) => {
    const value = part.item.ephemeral;
    if (part.conversationId !== ROOT_CONVERSATION_ID || value === undefined) return true;
    if (value.kind === "toolCall" && Array.isArray(value.model) && value.model.length === 1) {
      const message = value.model[0] as { role?: unknown; content?: unknown } | undefined;
      const content = message?.content;
      const call: unknown = message?.role === "assistant" && Array.isArray(content) && content.length === 1 ? content[0] : undefined;
      if (call !== null && typeof call === "object" && !Array.isArray(call)) {
        const object = call as Record<string, unknown>;
        const args = object.arguments;
        if (object.type === "toolCall" && object.name === "chat" && typeof object.id === "string" && object.id.length > 0 &&
            Object.keys(object).every((key) => ["type", "id", "name", "arguments"].includes(key)) &&
            args !== null && typeof args === "object" && !Array.isArray(args) &&
            Object.keys(args).length === 1 && typeof (args as { text?: unknown }).text === "string") {
          const recordId = `chat:${object.id}`;
          const matches = recordsById.get(recordId);
          if (matches?.length === 1 && matches[0]?.author === "agent" && matches[0].text === (args as { text: string }).text) {
            chatDuplicates.push({ entryId: part.entryId, itemId: part.item.id, recordId, part });
            return false;
          }
        }
      }
      return true;
    }
    if (value.kind !== "personMessage") return true;
    const recordId = bindings.get(part.entryId);
    const matches = recordId === undefined ? undefined : recordsById.get(recordId);
    const message = (entries.get(part.entryId)?.model as Array<{ role?: string; content?: unknown }> | undefined)?.[0];
    const content = message?.content;
    if (recordId === undefined || uses.get(recordId) !== 1 || matches?.length !== 1 || matches[0]?.author !== "user" ||
        message?.role !== "user" || (typeof content !== "string" && (!Array.isArray(content) ||
          content.some((piece: unknown) => piece === null || typeof piece !== "object" || (piece as { type?: unknown }).type !== "text"))) ||
        userText(content) !== matches[0].text || value.text !== matches[0].text) return true;
    chatDuplicates.push({ entryId: part.entryId, itemId: part.item.id, recordId, part });
    return false;
  });
  return { parts: kept, chatDuplicates };
}
