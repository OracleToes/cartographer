/**
 * The prompt's ephemeral handles (§5.4), numbered once for both views.
 *
 * Brain records are handled by the Brain's own table (`A`, `L`, `C`). Everything
 * else in the prompt is ephemeral — reasoning, the agent's plain text, tool
 * calls, their results, the person's messages — and has no record to hold a
 * handle, so its number comes from its position in the prompt. `X` is one
 * ephemeral item, `U` is a person's message, and `R` is a tool call's result,
 * with `S` for the shell, because a bash result is quoted far more than it is
 * cited. Every one of them counts in prompt order, so a handle means the same
 * thing in the transcript and in the Context view, which show one prompt two
 * ways.
 *
 * A result is its own item and its own handle: it arrives in the prefill as a
 * message of its own (§5.2), and pinning it pins the result rather than the call
 * that asked for it (§5.5).
 */

/** One item the prompt holds, in prompt order. */
import { userText } from "../domain/chat-identity.js";
import type { PinnedEphemeral } from "../domain/records.js";
import { STATE_BLOCK_MARKER } from "../domain/state-block.js";
import { ephemeralItemId } from "../runtime/collapse.js";

export interface PromptItem {
  kind: "person" | "call" | "result" | "reasoning" | "text";
  /** The view's own row id, which is what a handle is looked up by. */
  key: string;
  /** Stable sweep identity and content, when this is a landed item. */
  item?: PinnedEphemeral | undefined;
  /** For a result: the tool that produced it. `bash` takes `S`; everything else `R`. */
  tool?: string | undefined;
}

export interface PromptContextEntry {
  id?: number | undefined;
  model?: unknown;
  partKeys?: readonly string[] | undefined;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

/** Landed items in prompt order, with the same identities the collapse sweep uses. */
export function promptItemsOf(entries: readonly PromptContextEntry[], generation: string): PromptItem[] {
  const calls = new Map<string, { name: string; path?: string | undefined }>();
  for (const entry of entries) {
    const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
    if (!object(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!object(part) || part.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string") continue;
      const path = object(part.arguments) && typeof part.arguments.path === "string" ? part.arguments.path : undefined;
      calls.set(part.id, { name: part.name, path });
    }
  }
  const items: PromptItem[] = [];
  for (const entry of entries) {
    const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
    if (!object(message)) continue;
    const id = entry.id ?? 0;
    const createdAt = typeof message.timestamp === "number" ? message.timestamp : 0;
    const make = (key: string, kind: PinnedEphemeral["kind"], text: string, entity?: PinnedEphemeral["entity"]): PinnedEphemeral => ({
      id: ephemeralItemId(generation, id, key), kind, text, createdAt, pinned: "agent", ...(entity === undefined ? {} : { entity }),
    });
    if (message.role === "user") {
      const text = userText(message.content);
      if (!text.trim() || text.trim() === STATE_BLOCK_MARKER) continue;
      items.push({ kind: "person", key: String(id), item: make("x0", "personMessage", text) });
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      message.content.forEach((part: unknown, index: number) => {
        if (!object(part)) return;
        const stable = entry.partKeys?.[index];
        const key = `${id}-${index}`;
        if (part.type === "thinking" && typeof part.thinking === "string") {
          items.push({ kind: "reasoning", key, ...(stable === undefined ? {} : { item: make(stable, "reasoning", part.thinking) }) });
        } else if (part.type === "text" && typeof part.text === "string") {
          items.push({ kind: "text", key, ...(stable === undefined ? {} : { item: make(stable, "plainText", part.text) }) });
        } else if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
          const text = `${part.name} ${JSON.stringify(part.arguments ?? {})}`;
          items.push({ kind: "call", key, ...(stable === undefined ? {} : { item: make(stable, "toolCall", text, { callId: part.id, tool: part.name }) }) });
        }
      });
    } else if (message.role === "toolResult") {
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      const call = callId === undefined ? undefined : calls.get(callId);
      const text = Array.isArray(message.content) ? message.content.flatMap((part: unknown) => object(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : typeof message.content === "string" ? message.content : "";
      const entity = callId === undefined ? undefined : { callId, tool: call?.name, path: call?.path };
      const containsImage = Array.isArray(message.content) && message.content.some((part: unknown) => object(part) && part.type === "image");
      const item = make("r", call?.name === "read" ? "readResult" : "toolResult", containsImage ? [text, "[image]"].filter(Boolean).join("\n") : text, entity);
      items.push({ kind: "result", key: String(id), tool: call?.name, item: containsImage ? { ...item, containsImage: true } : item });
    }
  }
  return items;
}

export interface PromptHandles {
  /** `X1`, `X2`… for one ephemeral item, by its row id. */
  ephemeral: (key: string) => string | undefined;
  /** `U1`, `U2`… for one of the person's messages, by its row id. */
  person: (key: string) => string | undefined;
  /** `R1` for a tool result, `S1` for a shell result, by the result's row id. */
  result: (key: string) => string | undefined;
  /**
   * `P A3` for a pin, by the handle of the entry it marks (§5.4).
   *
   * A pin is named by what it marks, not by a number of its own: it is the same
   * pin whether it is read in the block, in the head, or over an archived item,
   * and `P A3` says which entry without a second table to look it up in.
   */
  pin: (entryHandle: string) => string;
}

/**
 * A pin's handle: the pin's letter and the handle of the entry it marks (§5.4).
 * One function, because the block, the transcript and the Context view all show
 * the same pin and must show the same name for it.
 */
export function pinHandle(entryHandle: string): string {
  return `P ${entryHandle}`;
}

/** A completed transcript tool row names its result; an unfinished call names itself. */
export function toolRowHandle(handles: PromptHandles, callKey: string, resultKey?: string): string | undefined {
  return (resultKey === undefined ? undefined : handles.result(resultKey)) ?? handles.ephemeral(callKey);
}

export function promptHandles(items: readonly PromptItem[], headEphemera = 0): PromptHandles {
  const ephemeral = new Map<string, string>();
  const person = new Map<string, string>();
  const results = new Map<string, string>();
  let nextEphemeral = headEphemera;
  let nextPerson = 0;
  let nextResult = 0;
  let nextShell = 0;
  for (const item of items) {
    if (item.kind === "person") {
      nextPerson += 1;
      person.set(item.key, `U${nextPerson}`);
      if (item.item !== undefined) person.set(item.item.id, `U${nextPerson}`);
      continue;
    }
    if (item.kind === "result") {
      const shell = item.tool === "bash";
      if (shell) nextShell += 1;
      else nextResult += 1;
      const handle = `${shell ? "S" : "R"}${shell ? nextShell : nextResult}`;
      results.set(item.key, handle);
      if (item.item !== undefined) results.set(item.item.id, handle);
      continue;
    }
    nextEphemeral += 1;
    ephemeral.set(item.key, `X${nextEphemeral}`);
    if (item.item !== undefined) ephemeral.set(item.item.id, `X${nextEphemeral}`);
  }
  return {
    ephemeral: (key) => ephemeral.get(key),
    person: (key) => person.get(key),
    result: (key) => results.get(key),
    pin: pinHandle,
  };
}
