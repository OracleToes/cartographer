/**
 * The state block (§5.3, §5.7, §6.1).
 *
 * Injected as the trailing user-role message on every request and never
 * persisted; the Pi store accumulates only markers, which die with the
 * generation's store at collapse. The model sees exactly one current block,
 * identified by its shape — the same delimiters every time — which the
 * system prompt describes once. Nothing in the block is instructive; it is
 * what things are now, not what to do about it.
 *
 * It is also the continuation (§5.7): a run that ends without a tool call ends,
 * and the block arrives as the next turn.
 *
 * The block is plain text, in the order §5.3 lists what it reports:
 *
 *   <carto-state>
 *   [EDIT MODE]
 *   context: ~12,410 / 32,768 tokens · the provider counted 9,841 input, tool work since +2,569
 *   context fill: ~37%
 *   space: system and tools ~5,900 · transcript ~3,800 · tool work ~2,700 · atlas ~1,200 · ledger ~640 · chat ~980
 *   since the rebuild:
 *     A3 · created
 *     C1 · declared to the person
 *   stale:
 *     A5 · the file changed after this note
 *   tree: . (depth 2)
 *     src/  4K
 *       cli.ts  3K  A1
 *   pins:
 *     A1 · you
 *   marks:
 *     C3 · delete · the person
 *   </carto-state>
 *
 * Every item that names a record names it by handle, and a line adds only what
 * the handle does not already say: no line repeats the kind its letter gives.
 * Empty sections say `none` rather than lying by omission, and nothing is
 * omitted. No section asks for anything; the block reports.
 */
import { estimateSerialized } from "./estimate.js";

export const STATE_BLOCK_OPEN = "<carto-state>";
export const STATE_BLOCK_CLOSE = "</carto-state>";
/** The byte-sized user message an `onYield` continuation appends; strips out of every outgoing payload. */
export const STATE_BLOCK_MARKER = "<carto-state/>";

export interface PendingWrite {
  /** The handle kind of the record, used to resolve the handle at render time. */
  kind: "ledger" | "chat" | "atlas";
  /** What happened, as a bare verb phrase: upsert, record, update, delete, pin… */
  action: string;
  /** The durable ID. Never rendered raw; always resolved to a handle here. */
  id: string;
}

/** One entry's pending mark (§4.1): what will happen to it at the next collapse, and who said so. */
export interface MarkLine {
  handle: string;
  action: "archive" | "restore" | "delete";
  author: "user" | "agent";
}

export interface StateBlockInput {
  /**
   * The name the agent calls the person by: the configured name, or the
   * account that launched Carto. Every line that would have said "the person"
   * says this instead, so the block names somebody rather than a role.
   */
  person: string;
  /** The server's advertised window; 0 = unknown, never a made-up number. */
  contextWindow: number;
  /** Fill percentage (1–100) that triggers `[COLLAPSE NEEDED]`; defaults to COLLAPSE_WARNING_PERCENT (75). */
  collapseWarningPercent?: number;
  /** Provider's own count for the last response, if one has arrived. */
  lastReportedInput?: number | undefined;
  /** Output of that response also occupies the context. */
  lastReportedOutput?: number | undefined;
  /** Estimated tokens the system message and tool declarations occupy. */
  systemTokens: number;
  /** Estimated transcript tokens in the payload. */
  transcriptTokens: number;
  /** Estimated tool-work tokens in the payload in total. */
  toolWorkTokens: number;
  /** Estimated tool-work tokens added since the last provider report. */
  toolWorkSince: number;
  /** Estimated sizes of the Brain, by part — now, not at the freeze. */
  sizes: { atlas: number; ledger: number; chat: number; ephemera: number };
  /** The mode the project is in (§6.1). The person sets it; it is reported, never enforced, here. */
  mode: "edit" | "read only";
  /** Brain writes since the projection was rebuilt. Ephemeral: the list starts empty at every collapse. */
  pending: PendingWrite[];
  /**
   * Whatever has drifted, each with its own reason: an Atlas note whose file
   * moved on, a pinned file that is gone, a pinned `read` result gone stale
   * (§5.5). The reason belongs to the entry, so the block does not put one
   * sentence on three different facts.
   */
  stale: Array<{ handle: string; why: string }>;
  /** Handles for the write-resolution of pending entries (the Brain's table). */
  resolveHandle: (kind: PendingWrite["kind"], id: string) => string | undefined;
  /** Every record carrying a pin marker, as handle + who placed it, in template order. */
  pinned: Array<{ handle: string; author: "user" | "agent" }>;
  /** Every entry carrying a mark, with its action and its author (§4.1). */
  marks: MarkLine[];
  /** The project root, so the tree's anchor reads `.` where the agent stands rather than an absolute path. */
  projectRoot?: string;
  tree: { root: string; depth: number; lines: string[] };
}

const thousands = (value: number): string => Math.round(value).toLocaleString("en-US");

/** Who placed a pin or a mark, in the block's own voice: the person by name, or the agent reading it. */
const authorName = (author: "user" | "agent", person: string): string => (author === "user" ? person : "you");

/**
 * What a pending line adds beyond the handle: the write, in words a reader
 * understands without decoding a kind it can already read off the letter.
 */
const pendingWord = (write: PendingWrite, person: string): string => {
  switch (`${write.kind} ${write.action}`) {
    case "atlas create":
    case "atlas upsert":
      return "written";
    case "atlas update":
      return "updated";
    case "ledger create":
    case "ledger upsert":
      return "written";
    case "ledger update":
      return "updated";
    case "chat record":
      return `said to ${person}`;
    case "unmark":
      return "mark withdrawn";
    default:
      return write.action.startsWith("mark ") ? `marked for ${write.action.slice(5)}` : write.action;
  }
};

/** The project root as the agent thinks of it: `.` at the root, else the path inside it. */
const treeLabel = (root: string, projectRoot: string | undefined): string => {
  if (projectRoot === undefined) return root;
  const inside = root.startsWith(projectRoot);
  if (!inside) return root;
  const rest = root.slice(projectRoot.length).replace(/^[/\\]/, "");
  return rest === "" ? "." : rest;
};

/** The estimate that the block, the percentage and the collapse warning share. */
export function estimatedContextTokens(input: StateBlockInput): number {
  return input.lastReportedInput === undefined
    ? input.systemTokens + input.transcriptTokens + input.toolWorkTokens
    : input.lastReportedInput + (input.lastReportedOutput ?? 0) + input.toolWorkSince;
}

/** Estimated percentage of a known window; undefined while the window is unknown. */
export function contextFillPercent(input: StateBlockInput): number | undefined {
  return input.contextWindow > 0 ? estimatedContextTokens(input) / input.contextWindow * 100 : undefined;
}

/** The default fill at which the block asks the agent to collapse. */
export const COLLAPSE_WARNING_PERCENT = 75;

export function renderStateBlock(input: StateBlockInput): string {
  const reported = input.lastReportedInput;
  const output = input.lastReportedOutput ?? 0;
  const estimated = estimatedContextTokens(input);
  const percentage = contextFillPercent(input);
  const warningPercent = input.collapseWarningPercent ?? COLLAPSE_WARNING_PERCENT;
  // The provider's own count is the only number here that is not an estimate,
  // and a window nobody advertised is unknown rather than a made-up figure.
  const fullness =
    input.contextWindow <= 0
      ? reported === undefined
        ? `context: ~${thousands(input.systemTokens + input.transcriptTokens + input.toolWorkTokens)} tokens · the window is unknown until the server advertises one`
        : `context: ~${thousands(estimated)} tokens · the provider counted ${thousands(reported)} input${output > 0 ? `, ${thousands(output)} output` : ""}, tool work since +${thousands(input.toolWorkSince)} · the window is unknown`
      : reported === undefined
        ? `context: ~${thousands(estimated)} / ${thousands(input.contextWindow)} tokens · no provider count yet`
        : `context: ~${thousands(estimated)} / ${thousands(input.contextWindow)} tokens · the provider counted ${thousands(reported)} input${output > 0 ? `, ${thousands(output)} output` : ""}, tool work since +${thousands(input.toolWorkSince)}`;
  const percentageLine = percentage === undefined ? [] : [`context fill: ~${Math.floor(percentage)}%${percentage >= warningPercent ? " · [COLLAPSE NEEDED] Write down what you need to continue, mark obsolete records, then collapse." : ""}`];
  const space =
    `space: system and tools ~${thousands(input.systemTokens)} · transcript ~${thousands(input.transcriptTokens)} · ` +
    `tool work ~${thousands(input.toolWorkTokens)} · atlas ~${thousands(input.sizes.atlas)} · ledger ~${thousands(input.sizes.ledger)} · ` +
    `chat ~${thousands(input.sizes.chat)}` +
    // Only when something is pinned: a cost of zero is not worth a clause, and
    // the line is already the longest in the block.
    (input.sizes.ephemera === 0 ? "" : ` · pinned ~${thousands(input.sizes.ephemera)}`);
  // One line per write since the rebuild, named by handle. The line says what
  // the write was; the letter already says which book holds it.
  const pending: string =
    input.pending.length === 0
      ? "since the rebuild: nothing written"
      : ["since the rebuild:", ...input.pending.map((write) => `  ${input.resolveHandle(write.kind, write.id) ?? write.kind} · ${pendingWord(write, input.person)}`)].join("\n");
  // Staleness is a fact about the note, not about the file: the file moved on
  // after the note was written.
  const stale: string =
    input.stale.length === 0
      ? "stale: nothing"
      : ["stale:", ...input.stale.map((item) => `  ${item.handle} · ${item.why}`)].join("\n");
  const pinned: string =
    input.pinned.length === 0
      ? "pins: none"
      : ["pins:", ...input.pinned.map((item) => `  P ${item.handle} · placed by ${authorName(item.author, input.person)}`)].join("\n");
  const marks: string =
    input.marks.length === 0
      ? "marks: none"
      : ["marks:", ...input.marks.map((mark) => `  ${mark.handle} · ${mark.action} at the next collapse · marked by ${authorName(mark.author, input.person)}`)].join("\n");
  // `T1` names the tree itself (§5.4): the block carries a handle for the
  // thing the block renders, so the agent can point at what it is looking at.
  const treeLines = [`T1 tree: ${treeLabel(input.tree.root, input.projectRoot)} (depth ${input.tree.depth})`, ...input.tree.lines.map((line) => `  ${line}`)];
  const mode = input.mode === "read only" ? "[READ ONLY MODE]" : "[EDIT MODE]";
  return [STATE_BLOCK_OPEN, mode, fullness, ...percentageLine, space, pending, stale, ...treeLines, pinned, marks, STATE_BLOCK_CLOSE].join("\n");
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
      systemTokens += estimateSerialized(message);
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
