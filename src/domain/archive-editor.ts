/** Editing an archived item updates both its displayed text and its restore payload. */
import type { Message, TextContent } from "@earendil-works/pi-ai";
import type { ArchivedItem } from "./archive.js";
import { userText } from "./chat-identity.js";

/** Text to put in the editor. Tool call arguments are structured JSON. */
export function archivedEphemeralText(item: ArchivedItem): string {
  const value = item.ephemeral;
  if (value === undefined) throw new Error("Not an archived ephemeral item.");
  const model = value.model;
  if (value.kind === "personMessage" && Array.isArray(model)) {
    const message = (model as Message[])[0];
    if (message?.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "image") && !userText(message.content).trim()) {
      // The archive's [image] label is not text the person originally sent.
      return userText(message.content);
    }
  }
  if (value.kind === "toolCall" && Array.isArray(model)) {
    const call = (model as Message[])[0];
    if (call?.role !== "assistant" || call.content.length !== 1 || call.content[0]?.type !== "toolCall") throw new Error("The archived tool call has an invalid restore payload.");
    return JSON.stringify(call.content[0].arguments, null, 2) + "\n";
  }
  if (value.kind === "readResult" || value.kind === "toolResult") {
    if (Array.isArray(model)) {
      const result = (model as Message[])[1];
      if (result?.role !== "toolResult") throw new Error("The archived tool result has an invalid restore payload.");
      return result.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n");
    }
  }
  return value.text;
}

/** Replace text without discarding image or other non-text content. */
function textParts<T extends { type: string }>(parts: T[], text: string): T[] {
  let inserted = false;
  const result: T[] = [];
  for (const part of parts) {
    if (part.type !== "text") { result.push(part); continue; }
    if (!inserted) { result.push({ type: "text", text } as unknown as T); inserted = true; }
  }
  if (!inserted) result.unshift({ type: "text", text } as unknown as T);
  return result;
}

export function editArchivedEphemeral(item: ArchivedItem, text: string): ArchivedItem {
  const ephemeral = item.ephemeral;
  if (ephemeral === undefined || item.restorePending) throw new Error("The archived item cannot be edited now.");
  const model = Array.isArray(ephemeral.model) ? structuredClone(ephemeral.model) as Message[] : undefined;
  let displayText = text;
  if (model !== undefined) {
    const first = model[0];
    if (ephemeral.kind === "personMessage") {
      if (model.length !== 1 || first?.role !== "user") throw new Error("Invalid saved person message.");
      first.content = typeof first.content === "string" ? text : textParts(first.content, text);
    } else if (ephemeral.kind === "reasoning" || ephemeral.kind === "plainText" || ephemeral.kind === "toolCall") {
      if (model.length !== 1 || first?.role !== "assistant" || first.content.length !== 1) throw new Error("Invalid saved assistant message.");
      const part = first.content[0];
      if (ephemeral.kind === "reasoning" && part?.type === "thinking") {
        if (part.thinkingSignature || part.redacted) throw new Error("Signed or redacted reasoning cannot be safely edited.");
        part.thinking = text;
      } else if (ephemeral.kind === "plainText" && part?.type === "text") {
        part.text = text;
      } else if (ephemeral.kind === "toolCall" && part?.type === "toolCall") {
        if (part.thoughtSignature) throw new Error("A signed tool call cannot be safely edited.");
        const args: unknown = JSON.parse(text);
        if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object.");
        part.arguments = args as typeof part.arguments;
        displayText = `${part.name} ${JSON.stringify(args)}`;
      } else throw new Error("The saved assistant message does not match the item kind.");
    } else {
      const result = model[1];
      if (model.length !== 2 || first?.role !== "assistant" || first.content.length !== 1 || first.content[0]?.type !== "toolCall" || result?.role !== "toolResult" || first.content[0].id !== result.toolCallId) throw new Error("Invalid saved tool result or call pairing.");
      result.content = textParts(result.content, text);
      displayText = [text, ...(result.content.some((part) => part.type === "image") ? ["[image]"] : [])].filter(Boolean).join("\n");
    }
  }
  return { ...item, ephemeral: { ...ephemeral, text: displayText, ...(model === undefined ? {} : { model }) } };
}
