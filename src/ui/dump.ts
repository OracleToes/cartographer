/**
 * The /copy-session context flattening (the person's diagnostic logs).
 * One persisted entry → plain text, including the frozen projection verbatim.
 */

/** Plain-text dump of one context entry as far as the session shows it. */
export interface ContextDumpEntry {
  id: number;
  kind: string;
  role: string;
  timestamp?: number;
  body: string;
}

function partText(part: unknown): string {
  if (part === null || typeof part !== "object") return String(part);
  const value = part as Record<string, unknown>;
  if (value.type === "text" && typeof value.text === "string") return value.text;
  if (value.type === "thinking" && typeof value.thinking === "string") return `[thinking] ${value.thinking}`;
  if (value.type === "toolCall") {
    const name = typeof value.name === "string" ? value.name : "tool";
    return `→ ${name}(${JSON.stringify(value.arguments ?? {})})`;
  }
  if (value.type === "image") return "[image]";
  return JSON.stringify(value);
}

/** Flatten one persisted entry to plain text; `undefined` when there is nothing person/agent-visible. */
export function flattenEntry(entry: { kind?: string; id?: number; model?: unknown }): ContextDumpEntry | undefined {
  if (!Array.isArray(entry.model) || entry.model.length === 0) return undefined;
  const message = entry.model[0] as Record<string, unknown>;
  const role = typeof message.role === "string" ? message.role : "?";
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
  const kind = typeof entry.kind === "string" ? entry.kind : "?";
  const id = typeof entry.id === "number" ? entry.id : -1;
  const content = message.content;
  let body: string;
  if (role === "system") {
    // The frozen projection: dump it verbatim — it is the bytes the model sees.
    const sections = message.sections;
    body = sections !== null && typeof sections === "object"
      ? Object.entries(sections as Record<string, unknown>).map(([name, text]) => `[${name}]\n${String(text)}`).join("\n\n")
      : String(content ?? "");
  } else if (typeof content === "string") {
    body = content;
  } else if (Array.isArray(content)) {
    body = content.map(partText).join("\n");
  } else {
    body = JSON.stringify(content);
  }
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  if (role === "assistant" && stopReason !== undefined) body = `stopped: ${stopReason}\n${body}`;
  return { id, kind, role, ...(timestamp === undefined ? {} : { timestamp }), body };
}
