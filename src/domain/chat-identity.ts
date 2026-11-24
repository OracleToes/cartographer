import type { ChatRecord } from "./records.js";

/** Text from either form of a Pi user message. Non-text attachments remain in Pi. */
export function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part: unknown) => {
    if (part === null || typeof part !== "object") return [];
    const value = part as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("");
}

export interface ChatBodyEntry {
  id?: number | undefined;
  data?: unknown;
  model?: unknown;
}

/** Bind live person entries to records. New inputs carry identity on the entry;
 * legacy entries can only be paired when the text has a single live candidate
 * and a single available record. Repeated text cannot prove an ordering. */
export function personChatBindings(entries: readonly ChatBodyEntry[], records: readonly ChatRecord[], headIds: ReadonlySet<string>): Map<number, string> {
  const result = new Map<number, string>();
  const used = new Set<string>(headIds);
  const legacy = new Map<string, number[]>();
  for (const entry of entries) {
    if (entry.id === undefined || !Array.isArray(entry.model)) continue;
    const message = entry.model[0] as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== "user") continue;
    const data = entry.data as { chatRecordId?: unknown } | undefined;
    if (typeof data?.chatRecordId === "string") {
      used.add(data.chatRecordId);
      if (records.some((record) => record.id === data.chatRecordId && record.author === "user")) result.set(entry.id, data.chatRecordId);
      continue;
    }
    const text = userText(message.content);
    if (text.trim()) legacy.set(text, [...(legacy.get(text) ?? []), entry.id]);
  }
  for (const [text, ids] of legacy) {
    const matches = records.filter((record) => record.author === "user" && record.text === text && !used.has(record.id));
    if (matches.length !== 1 || ids.length !== 1) continue;
    ids.forEach((id, index) => { const record = matches[index]; if (record !== undefined) result.set(id, record.id); });
  }
  return result;
}
