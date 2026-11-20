/**
 * `/copy` and `/copy-session` (the person's logs, 2026-11-20).
 *
 * pi-tui's own selection-copy uses OSC 52, which lies on terminals that do
 * not pass it through (macOS Terminal.app, tmux without `set-clipboard on`);
 * there is no reliable in-band acknowledgement, so the copy always goes two
 * ways: an OSC 52 write to the terminal (the clipboard when it works) and a
 * plain file under the temp directory (the fallback that always works). The
 * status line names both.
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CopyResult {
  /** Where the fallback file landed. */
  path: string;
  bytes: number;
}

/** Write `text` to the clipboard (OSC 52) and to a temp file; both, always. */
export async function copyText(text: string, stem: string): Promise<CopyResult> {
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  const path = join(tmpdir(), `carto-${stem}-${Date.now()}.txt`);
  await writeFile(path, text, "utf8");
  return { path, bytes: Buffer.byteLength(text, "utf8") };
}

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
  return { id, kind, role, ...(timestamp === undefined ? {} : { timestamp }), body };
}
