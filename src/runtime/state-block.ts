/**
 * The state block — the last thing the model reads on every request.
 *
 * §12, §12a, §12b, §20 and §21 of `docs/intent.md` are the authority. The
 * block is not a message: it is rendered fresh per request, injected at the
 * tail, and the transcript keeps only byte-sized markers that die with the
 * generation. It is purely informative — nothing on it tells the agent to do
 * anything. Continuing the turn happens because the agent follows its system
 * prompt with accurate information; the block is that information.
 *
 * Every item names its record by the Brain's generation-local handle, the
 * same handles the projection and the tools use (§34). Estimated numbers are
 * marked ▤; the last reported number is the provider's own and is not.
 */

/** The byte-sized marker `onYield` continues the run with, when a reply carries no tool call. */
export const STATE_BLOCK_MARKER = "<carto-state/>";
const STATE_BLOCK_OPEN = "<carto-state>";
const STATE_BLOCK_CLOSE = "</carto-state>";

export interface TextualMessage {
  role: string;
  content: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (typeof part === "string") text += part;
    else if (part !== null && typeof part === "object" && "text" in part) {
      const candidate = (part as { text?: unknown }).text;
      if (typeof candidate === "string") text += candidate;
    }
  }
  return text;
}

/** True for any message whose entire content is a state-block marker or a full block. */
export function isStateBlockText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === STATE_BLOCK_MARKER) return true;
  return trimmed.startsWith(STATE_BLOCK_OPEN) && trimmed.endsWith(STATE_BLOCK_CLOSE);
}

/** Pi roles whose message a person did not deliberately author. */
const STATE_BLOCK_ROLES = new Set(["user", "developer", "system"]);

/**
 * Remove every state-block message from the history — the byte-sized markers
 * the store legitimately holds, and any full block that slipped in. The model
 * sees exactly one current block per request: the one appended by
 * {@link appendStateBlock}.
 */
export function stripStateBlocks<M extends TextualMessage>(messages: readonly M[]): M[] {
  return messages.filter((message) => !STATE_BLOCK_ROLES.has(message.role) || !isStateBlockText(textOf(message.content)));
}

/** Append the fresh block as the trailing user-role message. */
export function appendStateBlock<M extends TextualMessage>(messages: readonly M[], block: string): Array<M | { role: "user"; content: string; timestamp: number }> {
  return [...messages, { role: "user", content: block, timestamp: Date.now() }];
}

export interface PendingWrite {
  /** The record's generation-local handle, or undefined when the handle cannot be known. */
  handle: string | undefined;
  /** The record's handle kind. */
  kind: "chat" | "ledger" | "atlas" | "pin" | "wake";
  /** True when this write deleted the record. */
  deleted: boolean;
}

/**
 * The frozen projection's per-part sums. `chat` is always 0 by design: §11
 * keeps Chat out of the projection, so the Chat part costs zero frozen tokens;
 * its cost shows up as transcript and tool-work tokens instead.
 */
export interface SpaceParts {
  ledger: number;
  atlas: number;
  chat: number;
  pins: number;
  wakes: number;
}

export interface StateBlockInput {
  /** Estimated tokens of the conversation after the system prompt (person and assistant text). */
  transcriptTokens: number;
  /** Estimated tokens of tool work after the system prompt (tool calls and their results). */
  toolWorkTokens: number;
  /** Estimated tokens of the system prompt including the frozen projection; 0 when unknown. */
  systemTokens: number;
  /** Estimated tokens of the previous request's full prompt, for the delta; absent on the first request. */
  previousPromptTokens?: number | undefined;
  /** The provider's own count for the previous request, when reported. */
  lastReportedInput?: number | undefined;
  /** The model's context window, in tokens. */
  contextWindow: number;
  /** Space taken by each frozen projection part, at collapse. */
  parts: SpaceParts;
  /** Pending Brain writes since the projection was rebuilt, in write order. */
  pending: readonly PendingWrite[];
  /** Handles of records with stale evidence, as of the last refresh. */
  stale: readonly string[];
  /** Armed or ready wakes, as of now. */
  wakes: readonly { handle: string; kind: "time" | "path"; condition: string; status: "armed" | "ready" }[];
  /** The tree lines, already rendered and bounded. */
  tree: { root: string; depth: number; lines: string[] } | undefined;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

const pendingLine = (entry: PendingWrite): string =>
  `pending ${entry.handle ?? "?"} ${entry.kind}${entry.deleted ? " · deleted" : ""}`;

/** At most this many pending lines render; the overflow is counted, not dropped silently. */
export const MAX_PENDING_LINES = 20;

/**
 * Render the block. Pure: everything it needs arrives in {@link StateBlockInput}.
 */
export function renderStateBlock(input: StateBlockInput): string {
  const afterSystemTokens = input.transcriptTokens + input.toolWorkTokens;
  const currentTokens = input.systemTokens + afterSystemTokens;
  const delta =
    input.previousPromptTokens === undefined ? 0 : Math.max(0, currentTokens - input.previousPromptTokens);
  const fullness = input.lastReportedInput === undefined ? currentTokens : input.lastReportedInput + delta;
  const percent = Math.min(100, Math.round((fullness / input.contextWindow) * 100));

  // The stable remainder of the system prompt: what is not the frozen projection.
  const projectionTokens = input.parts.ledger + input.parts.atlas + input.parts.chat + input.parts.pins + input.parts.wakes;
  const stableTokens = Math.max(0, input.systemTokens - projectionTokens);

  const lines: string[] = [STATE_BLOCK_OPEN];
  lines.push(
    input.lastReportedInput === undefined || delta > 0
      ? `context ▤${formatTokens(fullness)}/${formatTokens(input.contextWindow)} (${percent}%)${
          input.lastReportedInput === undefined
            ? ""
            : ` · last reported ${input.lastReportedInput.toLocaleString("en-US")} (+▤${formatTokens(delta)} since)`
        }`
      : // No token has been added since the provider's count; fullness is the provider's own number.
        `context ${formatTokens(fullness)}/${formatTokens(input.contextWindow)} (${percent}%) · last reported ${input.lastReportedInput.toLocaleString("en-US")}`,
  );
  lines.push(
    `space ledger ▤${formatTokens(input.parts.ledger)} · atlas ▤${formatTokens(input.parts.atlas)} · chat ▤${formatTokens(input.parts.chat)} · pins ▤${formatTokens(input.parts.pins)} · wakes ▤${formatTokens(input.parts.wakes)} · tool work ▤${formatTokens(input.toolWorkTokens)} · transcript ▤${formatTokens(input.transcriptTokens)} · stable ▤${formatTokens(stableTokens)}`,
  );
  if (input.pending.length === 0) {
    lines.push("pending none");
  } else if (input.pending.length <= MAX_PENDING_LINES) {
    for (const entry of input.pending) lines.push(pendingLine(entry));
  } else {
    for (const entry of input.pending.slice(0, MAX_PENDING_LINES)) lines.push(pendingLine(entry));
    lines.push(`pending +${input.pending.length - MAX_PENDING_LINES} more`);
  }
  lines.push(`stale ${input.stale.length === 0 ? "none" : input.stale.join(" · ")}`);
  lines.push(
    `wakes ${
      input.wakes.length === 0
        ? "none"
        : input.wakes.map((wake) => `${wake.handle} ${wake.kind} ${wakeDescription(wake)}${wake.status === "ready" ? " · ready" : ""}`).join(" · ")
    }`,
  );
  if (input.tree !== undefined) {
    lines.push(`tree ${input.tree.root} · depth ${input.tree.depth}`);
    for (const line of input.tree.lines) lines.push(line);
  }
  lines.push(STATE_BLOCK_CLOSE);
  return lines.join("\n");
}

function wakeDescription(wake: { kind: "time" | "path"; condition: string }): string {
  if (wake.kind === "path") return wake.condition;
  const instant = parseWakeInstant(wake.condition);
  return instant ?? wake.condition;
}

function parseWakeInstant(condition: string): string | undefined {
  const trimmed = condition.trim();
  if (/^\d{10,16}$/.test(trimmed)) {
    const value = Number(trimmed);
    const millis = trimmed.length <= 10 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
