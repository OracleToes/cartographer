/**
 * The state block (MINI.md §6.1, §6.2, §6.3; docs/intent.md §12, §12a, §12b, §21, §34).
 *
 * Injected as the trailing user-role message on every request and never
 * persisted; the Pi store accumulates only markers, which die with the
 * generation's store at collapse. The model sees exactly one current block,
 * identified by its shape — the same delimiters every time — which the
 * system prompt describes once. Nothing in the block is instructive; it is
 * what things are now, not what to do about it.
 *
 * The block is plain text:
 *
 *   <carto-state>
 *   context: 12,410 / 32,768 tokens (last reported 9,841 + tool work since +2,569)
 *   space: system+tools ~5,900 · transcript ~3,800 · tool work ~2,700 · atlas ~1,200 · ledger ~640 · chat ~980 · pins ~120 · wakes ~40
 *   pending:
 *     A3 · atlas upsert
 *     C7 · chat record
 *   stale:
 *     A5 (evidence changed)
 *     P2 (source changed)
 *   wakes: W1 [time] 1780000000000 (armed) — check the build
 *   tree: /abs/path (depth 2)
 *     ./
 *     MINI.md  22K  A1
 *   </carto-state>
 *
 * Every item that names a record names it by handle. Empty sections say
 * `none` rather than lying by omission, and nothing is omitted.
 */
import type { WakeEntry } from "./records.js";
import { estimateSerialized, estimateTokens } from "./estimate.js";

export const STATE_BLOCK_OPEN = "<carto-state>";
export const STATE_BLOCK_CLOSE = "</carto-state>";
/** The byte-sized user message an `onYield` continuation appends; strips out of every outgoing payload. */
export const STATE_BLOCK_MARKER = "<carto-state/>";

export interface PendingWrite {
  /** The handle kind of the record, used to resolve the handle at render time. */
  kind: "ledger" | "chat" | "atlas" | "pin" | "wake";
  /** What happened, as a bare verb phrase: upsert, record, update, delete, pin, arm, cancel… */
  action: string;
  /** The durable ID. Never rendered raw; always resolved to a handle here. */
  id: string;
}

export interface StateBlockInput {
  /** The server's advertised window or the person's pin; 0 = unknown, never a made-up number. */
  contextWindow: number;
  /** Provider's own count for the last response, if one has arrived. */
  lastReportedInput?: number | undefined;
  /** Estimated tokens the system message and tool declarations occupy. */
  systemTokens: number;
  /** Estimated transcript tokens in the payload. */
  transcriptTokens: number;
  /** Estimated tool-work tokens in the payload in total. */
  toolWorkTokens: number;
  /** Estimated tool-work tokens added since the last provider report. */
  toolWorkSince: number;
  /** Estimated sizes of the Brain, by part — now, not at the freeze. */
  sizes: { atlas: number; ledger: number; chat: number; pins: number; wakes: number };
  /** Pending Brain writes since the projection was rebuilt. Ephemeral (§34). */
  pending: PendingWrite[];
  /** Handles whose evidence no longer verifies, as labelled (e.g. "A5 (evidence changed)"). */
  stale: string[];
  wakes: WakeEntry[];
  /** Handles for the write-resolution of pending entries (the Brain's table). */
  resolveHandle: (kind: PendingWrite["kind"], id: string) => string | undefined;
  tree: { root: string; depth: number; lines: string[] };
}

const thousands = (value: number): string => Math.round(value).toLocaleString("en-US");

export function renderStateBlock(input: StateBlockInput): string {
  const reported = input.lastReportedInput;
  const fullness =
    input.contextWindow <= 0
      ? reported === undefined
        ? `context: ~${thousands(input.systemTokens + input.transcriptTokens + input.toolWorkTokens)} tokens (window unknown)`
        : `context: ~${thousands(reported + input.toolWorkSince)} tokens (last reported ${thousands(reported)} + tool work since +${thousands(input.toolWorkSince)}; window unknown)`
      : reported === undefined
        ? `context: ~${thousands(input.systemTokens + input.transcriptTokens + input.toolWorkTokens)} / ${thousands(input.contextWindow)} tokens (not yet reported by the provider)`
        : `context: ~${thousands(reported + input.toolWorkSince)} / ${thousands(input.contextWindow)} tokens (last reported ${thousands(reported)} + tool work since +${thousands(input.toolWorkSince)})`;
  const space =
    `space: system+tools ~${thousands(input.systemTokens)} · transcript ~${thousands(input.transcriptTokens)} · ` +
    `tool work ~${thousands(input.toolWorkTokens)} · atlas ~${thousands(input.sizes.atlas)} · ledger ~${thousands(input.sizes.ledger)} · ` +
    `chat ~${thousands(input.sizes.chat)} · pins ~${thousands(input.sizes.pins)} · wakes ~${thousands(input.sizes.wakes)}`;
  const pending =
    input.pending.length === 0
      ? "pending: none"
      : ["pending:", ...input.pending.map((write) => `  ${input.resolveHandle(write.kind, write.id) ?? write.kind} · ${write.kind} ${write.action}`)].join("\n");
  const stale =
    input.stale.length === 0 ? "stale: none" : ["stale:", ...input.stale.map((item) => `  ${item}`)].join("\n");
  const wakeLines =
    input.wakes.length === 0
      ? "wakes: none"
      : `wakes: ${input.wakes
          .map((wake) => {
            const handle = input.resolveHandle("wake", wake.id) ?? "wake";
            return `${handle} [${wake.kind}] ${wake.condition} (${wake.status}) — ${wake.reason}`;
          })
          .join(" · ")}`;
  const treeLines = [`tree: ${input.tree.root} (depth ${input.tree.depth})`, ...input.tree.lines.map((line) => `  ${line}`)];
  return [STATE_BLOCK_OPEN, fullness, space, pending, stale, wakeLines, ...treeLines, STATE_BLOCK_CLOSE].join("\n");
}

export { estimateSerialized };

export interface MessageLike {
  readonly role: string;
  readonly content?: unknown;
  readonly sections?: Record<string, string | null>;
  readonly toolsAdded?: readonly unknown[];
  readonly timestamp?: number;
}

/**
 * Split the payload into the three estimates the block reports. The system
 * message is read as the flattened prompt the model sees: content, named
 * sections, and tool declarations. An assistant message carrying a tool
 * call counts as tool work, as does every tool-result message; everything
 * else is transcript. Whole-message attribution keeps the parts additive.
 */
export function splitContextMessages(messages: readonly MessageLike[]): {
  systemTokens: number;
  transcriptTokens: number;
  toolWorkTokens: number;
} {
  let systemTokens = 0;
  let transcriptTokens = 0;
  let toolWorkTokens = 0;
  for (const message of messages) {
    if (message.role === "system") {
      const parts: string[] = [];
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      if (content.length > 0) parts.push(content);
      for (const value of Object.values(message.sections ?? {})) {
        if (typeof value === "string" && value.length > 0) parts.push(value);
      }
      if (Array.isArray(message.toolsAdded) && message.toolsAdded.length > 0) {
        parts.push(JSON.stringify(message.toolsAdded));
      }
      systemTokens += estimateTokens(parts.join("\n\n"));
      continue;
    }
    const toolWork =
      message.role === "toolResult" ||
      message.role === "tool" ||
      (message.role === "assistant" &&
        Array.isArray(message.content) &&
        (message.content as readonly unknown[]).some(
          (block) => block !== null && typeof block === "object" && (block as { type?: unknown }).type === "toolCall",
        ));
    if (toolWork) toolWorkTokens += estimateSerialized(message);
    else transcriptTokens += estimateSerialized(message);
  }
  return { systemTokens, transcriptTokens, toolWorkTokens };
}

export function isMarkerMessage(message: MessageLike): boolean {
  if (message.role !== "user") return false;
  if (typeof message.content === "string") return message.content.trim() === STATE_BLOCK_MARKER;
  if (Array.isArray(message.content)) {
    const text = (message.content as ReadonlyArray<{ type?: unknown; text?: unknown }>)
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    return text.trim() === STATE_BLOCK_MARKER;
  }
  return false;
}

/** Drop every marker user message from a payload. The block itself is appended after this. */
export function stripStateBlocks<T extends MessageLike>(messages: readonly T[]): T[] {
  return messages.filter((message) => !isMarkerMessage(message));
}

/** Strip markers, then append the block as the trailing user message. */
export function appendStateBlock(messages: readonly MessageLike[], block: string, now: number): MessageLike[] {
  return [...stripStateBlocks(messages), { role: "user", content: block, timestamp: now }];
}

/** Resolve a handle for the stale list, prefixed by what changed. */
export function staleHandle(label: string, handle: string | undefined, what: string): string {
  return `${handle ?? label} (${what})`;
}
