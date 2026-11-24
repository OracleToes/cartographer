/**
 * The context (§8): the prompt the model reads, in the order it reads it.
 *
 * This view is not a browser for the Brain and not a debug dump. It is the
 * prefill itself — head, body, tail (§5) — with a fold tree over it:
 *
 * - **head** is fixed and clustered by type: the system prompt, the tool
 *   definitions, then the Brain (atlas, ledger, chat) and the pinned material;
 * - **body** is the live context in the order it occurred: the person's
 *   messages, reasoning, tool calls, and their results, one entry at a time;
 * - **tail** is the state block, which is always current (§5.6).
 *
 * Everything carries its generation-local handle (§5.4), because the handle is
 * how the agent addresses the item and how the person talks about it. The
 * numbers come from the Brain's table for records and from prompt order for
 * everything ephemeral.
 *
 * **Every entry carries a fold, and none starts open.** The prompt is long,
 * and its shape is the first thing to read: a row is one line — its handle, its
 * name, and a one-line summary — until `enter` or a click opens it. A tool
 * call's arguments, a result, the person's own message: all of them fold the
 * same way, so there is one class of row here and not two. A section heading
 * closes or opens everything beneath it, and `toggleAll` does the same for the
 * whole prompt.
 *
 * `tab` swaps between the **human** view and the **real** view for
 * schema-shaped content: the same entry, as a person reads it and as the model
 * receives it.
 *
 * Marks are made here and are not deletions (§4.1): `a` marks the entry under
 * the cursor for archive, `d` marks it for delete, `u` withdraws a mark, `!`
 * arms "now" so the next mark is applied at once instead of waiting for the
 * collapse, and `c` collapses.
 */
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import { estimateSerialized, estimateTokens } from "../domain/estimate.js";
import { handleOf } from "../domain/handles.js";
import type { CartoBrain, ChatRecord, Mark, PinnedEphemeral } from "../domain/records.js";
import { projectContext } from "../domain/projection.js";
import { canvasLine, padLine, surfaceLine, tokens } from "./tokens.js";
import type { PromptHandles } from "./prompt-handles.js";

export interface ContextToolItem {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ContextDialogueMessage {
  id: string | number;
  /** Generation-scoped sweep identity for a live person message. */
  targetId?: string | undefined;
  /**
   * The context entry this message is, and where it sits in the body. A message
   * id can be a composite (`"7-0"` for a chat call's part), so the order comes
   * from here rather than from parsing the id.
   */
  entry?: number | undefined;
  order?: number | undefined;
  role: string;
  text: string;
  timestamp?: number | undefined;
}

export interface ContextWorkItem {
  /** The item's id, which is also the id a pin on it uses: the sweep names it the same way (§3.1). */
  id: string | number;
  /**
   * The context entry this item belongs to. The body is ordered by entry, then
   * by the item's place within it — never by parsing the id, which is a
   * generation-stamped sweep key and carries no order of its own.
   */
  entry?: number | undefined;
  /** The item's place within its entry: thinking and text in part order, a result after its call. */
  order?: number | undefined;
  kind: string;
  name?: string | undefined;
  args?: string | undefined;
  output?: string | undefined;
  text?: string | undefined;
  /** For a result: the row id of the call it answers, so it can take that call's handle. */
  callId?: string | undefined;
  /** The pin the Brain holds for this item, if it is being kept through a collapse. */
  pinned?: "user" | "agent" | undefined;
  /** The text a result carries to a `read`, which is the kind a restore has to make true again. */
  tool?: string | undefined;
  /** The entity a pin on this item records: the call, its tool, and the path a `read` read. */
  payload?: { callId: string; tool?: string | undefined; path?: string | undefined } | undefined;
}

export interface ContextViewData {
  brain: CartoBrain;
  systemPrompt: string;
  /** The frozen projection's exact bytes — the carto-context section the model reads. */
  projectionText?: string | undefined;
  /** Frozen head identities, including items unpinned since the freeze. */
  headEphemera?: ReadonlyMap<string, PinnedEphemeral> | undefined;
  tools: ContextToolItem[];
  transcriptMessages: ContextDialogueMessage[];
  toolWorkItems: ContextWorkItem[];
  /**
   * The prompt's ephemeral handles (§5.4), numbered by `promptHandles` over the
   * same items the transcript numbers — so `X3` is the same item in both views.
   * Absent in a preview with no numbering of its own; the view then numbers its
   * rows itself, which is right for a frame that stands alone.
   */
  handles?: PromptHandles | undefined;
  stateBlockText: string;
  /**
   * The name the agent calls the person. Used only where this view renders a
   * head of its own (no frozen bytes to show), so the words match the agent's.
   */
  person?: string | undefined;
  /**
   * The handles the tree minted, path to handle (§5.4): a pinned file is named
   * in the head by the handle the tree gave it, and re-deriving the numbering
   * here would let the two disagree.
   */
  treeHandles?: Record<string, string> | undefined;
}

/** What a node can be marked: the part of the product a mark on it would touch. */
export type MarkTarget = {
  part: "atlas" | "ledger" | "chat" | "transcript" | "tool-work" | "tools" | "ephemera" | "files";
  id: string | number;
};

type NodeKind =
  | "system"
  | "tool"
  | "atlas"
  | "ledger"
  | "chat"
  | "files"
  | "person"
  | "reasoning"
  | "output"
  | "call"
  | "result"
  | "ephemera"
  | "state";

export interface PromptNode {
  /** Stable within a redraw: the fold state is keyed on it. */
  id: string;
  /** The generation-local handle (§5.4): what the agent calls this item. */
  handle: string;
  kind: NodeKind;
  /** The name it goes by: a tool's name, a record's title, `you`, `bash`. */
  label: string;
  /** What a folded entry says instead of its body. */
  summary: string;
  /** The body in the human view. */
  body: string;
  /** Schema-shaped content: the same entry as the model receives it. */
  real?: string;
  /** Where a mark on this node lands. Absent for the parts of the prompt the person cannot remove. */
  target?: MarkTarget;
  /** The marked action already recorded on it, if any. */
  marked?: string;
  /** What a pin on this row records, for an item that came from a tool call. */
  payload?: { callId: string; tool?: string | undefined; path?: string | undefined } | undefined;
  /** Who keeps this entry in the head, for an entry the person pinned. */
  pinned?: "user" | "agent" | undefined;
  /** Estimated token cost of this entry as the model receives it. */
  tokens: number;
}

export interface PromptSection {
  title: string;
  subtitle: string;
  nodes: PromptNode[];
}

const KIND_INK: Record<NodeKind, (text: string) => string> = {
  system: tokens.muted,
  tool: tokens.tool,
  atlas: tokens.atlas,
  ledger: tokens.ledger,
  chat: tokens.chat,
  files: tokens.pin,
  person: tokens.person,
  reasoning: tokens.reasoning,
  output: tokens.output,
  call: tokens.tool,
  result: tokens.output,
  ephemera: tokens.pin,
  state: tokens.warn,
};

/** Cells the name column takes, so the summaries line up under each other. */
const NAME_COLUMN = 14;
/** The open body's gutter: five spaces and the rule, then one space. */
const BODY_GUTTER = `     ${tokens.rule("│")} `;
/** Its visible width — what the wrap must leave room for. */
const BODY_INSET = 7;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const formatTokenCost = (count: number): string => `~${count.toLocaleString("en-US")} tok`;

/** One entry of the frozen head, as the bytes the model reads. */
export interface FrozenEntry {
  /** `A3`, `L1`, `C2`, `X1` for a record; the path for a pinned file. */
  key: string;
  kind: "atlas" | "ledger" | "chat" | "ephemera" | "files";
  /** The entry's own lines, exactly as they sit in the head. */
  lines: string[];
}

/**
 * The frozen projection, as entries. The projection is one section of the
 * system message, so the bytes are what the model reads; splitting it back into
 * its entries is a read of those bytes, never a re-render of the Brain. Records
 * are found by their handle; a pinned file by its header line, since every line
 * of a file's text is indented and only its header is not.
 */
export function parseProjection(text: string): FrozenEntry[] {
  const entries: FrozenEntry[] = [];
  let region: FrozenEntry["kind"] | undefined;
  let current: FrozenEntry | undefined;
  const REGIONS: Array<[RegExp, FrozenEntry["kind"]]> = [
    [/^Atlas — what you understand about the project$/, "atlas"],
    [/^Ledger — what you are working on$/, "ledger"],
    [/^Chat — what you and .* have said to each other$/, "chat"],
    [/^Pinned files — read again at this collapse$/, "files"],
    [/^Pinned — what .* kept in front of you$/, "ephemera"],
  ];
  const HEADER: Partial<Record<FrozenEntry["kind"], RegExp>> = {
    atlas: /^(A\d+) /,
    ledger: /^(L\d+) /,
    chat: /^(C\d+) /,
    ephemera: /^(X\d+) /,
  };
  for (const line of text.split("\n")) {
    const heading = REGIONS.find(([pattern]) => pattern.test(line));
    if (heading !== undefined) {
      region = heading[1];
      current = undefined;
      continue;
    }
    if (region === "files") {
      // A file's lines are all indented, so an unindented empty line is the
      // gap between this part and the next.
      if (line === "") {
        region = undefined;
        current = undefined;
        continue;
      }
      if (!line.startsWith("  ")) {
        const named = /^(.*) · pinned by /.exec(line);
        current = { key: named?.[1] ?? line, kind: "files", lines: [line] };
        entries.push(current);
        continue;
      }
    } else if (region !== undefined) {
      const match = HEADER[region]?.exec(line);
      if (match !== null && match !== undefined && match[1] !== undefined) {
        current = { key: match[1], kind: region, lines: [line] };
        entries.push(current);
        continue;
      }
    }
    current?.lines.push(line);
  }
  // The blank line that separates two parts belongs to neither.
  for (const entry of entries) {
    while (entry.lines.length > 1 && entry.lines[entry.lines.length - 1] === "") entry.lines.pop();
  }
  return entries;
}

/** A frozen entry as a person reads it: its header without the handle, its text without the indent. */
function readable(entry: FrozenEntry): { summary: string; body: string } {
  const [first = "", ...rest] = entry.lines;
  const text = rest.map((line) => (line.startsWith("  ") ? line.slice(2) : line));
  const header = entry.kind === "files" ? first : first.replace(/^\S+ /, "");
  if (entry.kind === "files") return { summary: header, body: [header, ...text].join("\n") };
  if (entry.kind === "chat") return { summary: oneLine(text.join(" ")) || header, body: [header, ...text].join("\n") };
  return { summary: oneLine(header), body: [header, ...text].join("\n") };
}

export class ContextView implements Component, Focusable {
  focused = false;
  onBack?: () => void;
  /** Fired on `d`: mark the entry for delete, applied at once when `now` is set (§4.1). */
  onDelete?: (partId: string, itemId: string | number, now: boolean) => void;
  /** Fired on `a`: mark the entry for archive, applied at once when `now` is set (§4.1). */
  onArchive?: (partId: string, itemId: string | number, now: boolean) => void;
  onCollapse?: () => void;
  /** Fired on `u` over an entry that names a Brain record: withdraw the mark on it (§4.1). */
  onWithdrawMark?: (partId: string, itemId: string | number) => void;
  /** Fired on `p`: pins an ephemeral item or unpins a file. A Brain entry has no pin on this layer (§3.2). */
  onTogglePin?: (partId: string, itemId: string | number) => void;
  /**
   * Bring a rendered line range into view. The view lives in a scroll pane, so
   * moving the cursor below the fold would otherwise carry it off screen; the
   * host fills this in with the pane's own `scrollTo`.
   */
  onReveal?: (start: number, end: number) => void;

  private data: ContextViewData | undefined;
  private sections: PromptSection[] = [];
  /** The flattened order the cursor walks: section boundaries included. */
  private rows: Array<{ section: number } | { node: PromptNode; section: number }> = [];
  private cursor = 0;
  private nowArmed = false;
  /** The first archive press is a confirmation, not a deferred archive mark. */
  private archiveConfirmation: string | undefined;
  private showReal = false;
  private folded = new Map<string, boolean>();
  private hits: Array<{ start: number; end: number; index: number }> = [];

  setData(data: ContextViewData): void {
    const oldRows = this.rows;
    const oldCursor = this.cursor;
    const previous = oldRows[oldCursor];
    this.data = data;
    this.sections = this.build(data);
    this.rows = [];
    this.sections.forEach((section, index) => {
      this.rows.push({ section: index });
      for (const node of section.nodes) this.rows.push({ node, section: index });
    });
    // The cursor stays on the entry it was on, by id, across a refresh. The app
    // refreshes this view on a timer while a run is going; resetting to the top
    // each time is what made the cursor look like it jumped while scrolling.
    // If it disappears, prefer the previous surviving entry, then the next
    // one. Deleting the last entry therefore moves up instead of to the top.
    const findOld = (row: (typeof oldRows)[number] | undefined): number =>
      row !== undefined && "node" in row
        ? this.rows.findIndex((candidate) => "node" in candidate && candidate.node.id === row.node.id)
        : -1;
    let held = findOld(previous);
    if (held < 0 && previous !== undefined && "node" in previous) {
      for (let at = oldCursor - 1; at >= 0 && held < 0; at -= 1) held = findOld(oldRows[at]);
      for (let at = oldCursor + 1; at < oldRows.length && held < 0; at += 1) held = findOld(oldRows[at]);
    }
    this.cursor = held >= 0 ? held : this.firstEntry();
  }

  /** Estimated size of everything the model reads, for the header. */
  private totalTokens(): number {
    if (this.data === undefined) return 0;
    return (
      estimateTokens(this.data.systemPrompt) +
      estimateSerialized(this.data.tools) +
      estimateTokens(this.headText(this.data)) +
      estimateSerialized(this.data.transcriptMessages) +
      estimateSerialized(this.data.toolWorkItems) +
      estimateTokens(this.data.stateBlockText)
    );
  }

  /**
   * The bytes of the head's projection section: the frozen file when there is
   * one. When the file is missing the section renders the Brain itself, the same
   * way, so this does too.
   */
  private headText(data: ContextViewData): string {
    return data.projectionText ?? projectContext(data.brain, new Map(), data.person).text;
  }

  private build(data: ContextViewData): PromptSection[] {
    const handles = data.brain.handles;
    const frozenText = this.headText(data);
    const frozen = parseProjection(frozenText);
    const frozenKeys = new Set(frozen.map((entry) => entry.key));
    const person = data.person ?? "you";

    // ── head ────────────────────────────────────────────────────────────────
    // The head, in §5.1's order: the system prompt, the tool definitions, then
    // the frozen projection. The tools are declared to the provider alongside
    // the system message; the rest is the message itself.
    const head: PromptNode[] = [];

    // The system prompt, then the tool definitions (§5.1): the instructions are the first section of the system message.
    head.push({
      id: "system",
      handle: "H",
      kind: "system",
      label: "system prompt",
      summary: oneLine(data.systemPrompt),
      body: data.systemPrompt,
      real: data.systemPrompt,
      tokens: estimateTokens(data.systemPrompt),
    });
    data.tools.forEach((tool, index) => {
      head.push({
        id: `tool-${tool.name}`,
        handle: `Y${index + 1}`,
        kind: "tool",
        label: tool.name,
        summary: tool.description,
        body: `${tool.description}\n\n${JSON.stringify(tool.parameters, null, 2)}`,
        real: JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }, null, 2),
        target: { part: "tools", id: tool.name },
        tokens: estimateSerialized(tool),
      });
    });

    // A row for what the head holds that the Brain no longer does, or holds
    // differently: the head is frozen, so the model still reads it. Nothing here
    // is listed for what the head does NOT hold: this view is the context as it
    // is, so a record or a pin that is waiting for the next collapse has no row in
    // the head. It shows where it really is (a pinned item's body row, the tail).
    const GONE = "gone from the Brain since the freeze · the head holds it until the next collapse";

    const mark = (m: Mark | undefined): { marked: string } | Record<string, never> =>
      m === undefined ? {} : { marked: `${m.action} on collapse · ${m.author === "user" ? person : "agent"}` };

    type Located = { id: string; mark?: Mark | undefined; label?: string; pinned?: "user" | "agent" | undefined } | undefined;
    const locate = (kind: "atlas" | "ledger" | "chat" | "ephemera", handle: string): Located => {
      if (kind === "ephemera") {
        const frozen = data.headEphemera?.get(handle);
        if (frozen !== undefined) {
          const held = data.brain.ephemera.find((candidate) => candidate.id === frozen.id);
          return { id: frozen.id, label: frozen.kind, pinned: held?.pinned };
        }
      }
      const id = handles.entries.find((entry) => entry.kind === kind && entry.handle === handle)?.id;
      if (id === undefined) return undefined;
      if (kind === "atlas") return data.brain.atlas.find((node) => node.id === id) === undefined ? undefined : { id, mark: data.brain.atlas.find((node) => node.id === id)?.mark };
      if (kind === "ledger") return data.brain.ledger.find((entry) => entry.id === id) === undefined ? undefined : { id, mark: data.brain.ledger.find((entry) => entry.id === id)?.mark };
      if (kind === "chat") return data.brain.chat.find((record) => record.id === id) === undefined ? undefined : { id, mark: data.brain.chat.find((record) => record.id === id)?.mark };
      const item = data.brain.ephemera.find((candidate) => candidate.id === id);
      return item === undefined ? undefined : { id, label: item.kind, pinned: item.pinned };
    };

    const deletes = new Set(data.brain.ephemeralDeletes ?? []);
    const frozenRecord = (entry: FrozenEntry & { kind: "atlas" | "ledger" | "chat" | "ephemera" }): PromptNode => {
      const at = locate(entry.kind, entry.key);
      const { summary, body } = readable(entry);
      const real = entry.lines.join("\n");
      const unpinned = entry.kind === "ephemera" && at !== undefined && at.pinned === undefined;
      return {
        id: `${entry.kind}-${at?.id ?? entry.key}`,
        handle: entry.key,
        kind: entry.kind,
        label: entry.kind === "ephemera" ? at?.label ?? /^\S+ \[([^\]]*)\]/.exec(entry.lines[0] ?? "")?.[1] ?? "pinned" : entry.kind,
        summary,
        body,
        real,
        tokens: estimateTokens(real),
        ...(at === undefined ? { marked: GONE } : { target: { part: entry.kind, id: at.id } }),
        ...(at === undefined ? {} : mark(at.mark)),
        ...(unpinned ? { marked: "unpinned since the freeze · leaves the head at the next collapse" } : {}),
        ...(entry.kind === "ephemera" && at !== undefined && deletes.has(at.id) ? { marked: "delete on collapse · you" } : {}),
        ...(entry.kind === "ephemera" && at?.pinned !== undefined ? { pinned: at.pinned } : {}),
      };
    };
    const of = (kind: FrozenEntry["kind"]) => frozen.filter((entry) => entry.kind === kind) as Array<FrozenEntry & { kind: "atlas" | "ledger" | "chat" | "ephemera" }>;
    for (const entry of of("atlas")) head.push(frozenRecord(entry));
    for (const entry of of("ledger")) head.push(frozenRecord(entry));
    // A Chat record is in the context once (§2.3). One in the frozen head is
    // listed here. The person's words said since the freeze are the live body
    // rows below, which act on the record; the agent's own are in the body as
    // their `chat` call. Neither is in the head until the next collapse, so
    // neither is listed here.
    const liveSaid = data.transcriptMessages.filter((message) => message.role === "user");
    const recordOfLine = new Map<number, ChatRecord>();
    for (const entry of of("chat")) head.push(frozenRecord(entry));
    for (const chat of data.brain.chat) {
      const handle = handleOf(handles, "chat", chat.id);
      if (chat.author !== "user" || (handle !== undefined && frozenKeys.has(handle))) continue;
      // The live line it was recorded as, matched in the order said.
      const line = liveSaid.findIndex((message, at) => message.text === chat.text && !recordOfLine.has(at));
      if (line !== -1) recordOfLine.set(line, chat);
    }
    // Pinned files come before pinned ephemera in the head (§5.1). The head
    // holds the file as the collapse read it: those lines are the row, in both
    // views. A file pinned since then is not in the head and has no row here;
    // the tail says a pin is waiting.
    const pinnedFiles = new Map(data.brain.files.map((file) => [file.path === "" ? "." : file.path, file]));
    const treeHandle = (path: string) => data.treeHandles?.[path === "." ? "" : path] ?? data.treeHandles?.[path] ?? "F?";
    const shownFiles = new Set<string>();
    for (const entry of frozen.filter((candidate) => candidate.kind === "files")) {
      shownFiles.add(entry.key);
      const file = pinnedFiles.get(entry.key);
      const { summary, body } = readable(entry);
      const real = entry.lines.join("\n");
      head.push({
        id: `file-${file?.path ?? entry.key}`,
        handle: treeHandle(entry.key),
        kind: "files",
        label: "file",
        summary,
        body,
        real,
        tokens: estimateTokens(real),
        // A file the head holds is a row you can act on whether or not it is still
        // pinned: `p` unpins it, and on the row that says it is leaving, `p` pins it
        // again, so the head keeps it.
        target: { part: "files" as const, id: file?.path ?? entry.key },
        ...(file === undefined
          ? { marked: "unpinned since the freeze · leaves the head at the next collapse" }
          : { pinned: file.pinned }),
      } satisfies PromptNode);
    }
    // Pinned ephemera come after Chat in the head (§5.1), each under its own
    // handle, because they are what the person kept in front of the agent.
    for (const entry of of("ephemera")) head.push(frozenRecord(entry));

    // ── body ────────────────────────────────────────────────────────────────
    // The body is never sorted by kind: the person's messages, the reasoning, the
    // calls and their results sit in the order the model receives them. The app
    // hands two lists; their ids are the context entry numbers, so the merge is
    // by that number and nothing else.
    // Ordered by entry number, then by place within the entry (§5: the body is
    // the order the model receives). A caller that does not supply the fields
    // gets its list's own order, which is already the order it was built in.
    const candidates: Array<{ key: number; order: number; node: PromptNode }> = [];
    let workCount = 0;
    let resultCount = 0;
    for (const item of data.toolWorkItems) {
      if (item.kind === "toolResult") resultCount += 1;
      else workCount += 1;
      const key = item.entry ?? Number.MAX_SAFE_INTEGER;
      const suffix = item.order ?? candidates.length;
      if (item.kind === "reasoning") {
        candidates.push({
          key,
          order: suffix,
          node: {
            id: String(item.id),
            handle: `X${workCount}`,
            kind: "reasoning",
            label: "thinking",
            summary: oneLine(item.text ?? ""),
            body: item.text ?? "",
            tokens: estimateTokens(item.text ?? ""),
            target: { part: "tool-work", id: String(item.id) },
            pinned: item.pinned,
          },
        });
      } else if (item.kind === "output") {
        // The model's own plain text: part of what it receives next round.
        candidates.push({
          key,
          order: suffix,
          node: {
            id: String(item.id),
            handle: `X${workCount}`,
            kind: "output",
            label: "text",
            summary: oneLine(item.text ?? ""),
            body: item.text ?? "",
            tokens: estimateTokens(item.text ?? ""),
            target: { part: "tool-work", id: String(item.id) },
            pinned: item.pinned,
          },
        });
      } else if (item.kind === "toolCall") {
        const callText = item.args ? `${item.name ?? ""}\n${item.args}` : (item.name ?? "");
        candidates.push({
          key,
          order: suffix,
          node: {
            id: String(item.id),
            handle: `X${workCount}`,
            kind: "call",
            label: item.name ?? "call",
            summary: oneLine(item.args ?? ""),
            body: item.args ?? "",
            tokens: estimateTokens(callText),
            target: { part: "tool-work", id: String(item.id) },
            pinned: item.pinned,
          },
        });
      } else {
        candidates.push({
          key,
          order: suffix,
          node: {
            id: String(item.id),
            // A result is its own item with its own handle (§5.4, §5.5): `R`,
            // or `S` when the shell produced it.
            handle: data.handles?.result(String(item.id)) ?? `R${resultCount}`,
            kind: "result",
            label: "result",
            summary: oneLine(item.output ?? ""),
            body: item.output ?? "",
            tokens: estimateTokens(item.output ?? ""),
            target: { part: "tool-work", id: String(item.id) },
            pinned: item.pinned,
            payload: item.payload,
          },
        });
      }
    }
    let personCount = 0;
    for (const message of data.transcriptMessages) {
      if (message.role !== "user") continue;
      personCount += 1;
      // A mark placed on the live line lands on the record it was.
      const chatRecord = recordOfLine.get(personCount - 1);
      const chatMark = chatRecord?.mark;
      candidates.push({
        key: message.entry ?? Number.MAX_SAFE_INTEGER,
        // A person's message precedes the work its entry produced.
        order: message.order ?? -1,
        node: {
          id: `msg-${String(message.id)}`,
          handle: `U${personCount}`,
          kind: "person",
          label: "you",
          summary: oneLine(message.text),
          body: message.text,
          tokens: estimateTokens(message.text),
          target: chatRecord === undefined ? { part: "transcript", id: message.targetId ?? message.id } : { part: "chat", id: chatRecord.id },
          ...(chatMark === undefined ? {} : { marked: `${chatMark.action} on collapse · ${chatMark.author === "user" ? (data.person ?? "you") : "agent"}` }),
        },
      });
    }
    const body = candidates.sort((left, right) => left.key - right.key || left.order - right.order).map((entry) => entry.node);
    // A pin placed since the freeze is not in the head, so it has no row there.
    // The item it pins is a body row right now, so that row carries the pin and
    // says it waits for the collapse, the way a row marked for delete says so.
    const pendingPins: PromptNode[] = [];
    for (const node of body) {
      if (node.pinned === undefined || node.target?.part !== "tool-work") continue;
      const item = data.brain.ephemera.find((candidate) => candidate.id === String(node.target?.id));
      const handle = item === undefined ? undefined : handleOf(handles, "ephemera", item.id);
      if (handle !== undefined && frozenKeys.has(handle)) continue;
      node.marked = `pin on collapse · ${node.pinned === "user" ? person : "agent"}`;
      pendingPins.push(node);
    }
    const deletions = new Set(data.brain.ephemeralDeletes ?? []);
    for (const node of body) {
      if (node.target !== undefined && deletions.has(String(node.target.id))) node.marked = "delete on collapse · you";
    }
    // The numbering is the transcript's, when the app supplied it: `X3` names
    // one item, and the two views are two renderings of one prompt (§5.4).
    if (data.handles !== undefined) {
      for (const node of body) {
        const rowId = node.id.replace(/^(work|msg)-/, "");
        const handle = node.kind === "person" ? data.handles.person(rowId) : data.handles.ephemeral(rowId);
        if (handle !== undefined) node.handle = handle;
      }
    }

    // ── tail ────────────────────────────────────────────────────────────────
    // The state block lists every pin, so a pin placed since the freeze is in the
    // context right now in exactly one place: its `pins:` line. A file pinned
    // since the freeze has no other row, so the tail carries the highlight for it
    // (and for the items above), and says whose pins are waiting.
    const waiting = [
      ...data.brain.files.filter((file) => !shownFiles.has(file.path === "" ? "." : file.path)).map((file) => treeHandle(file.path === "" ? "." : file.path)),
      ...pendingPins.map((node) => node.handle),
    ];
    const tail: PromptNode[] = [
      {
        id: "state-block",
        handle: "B",
        kind: "state",
        label: "state block",
        summary: oneLine(data.stateBlockText),
        body: data.stateBlockText,
        real: data.stateBlockText,
        tokens: estimateTokens(data.stateBlockText),
        ...(waiting.length === 0 ? {} : { marked: `pin on collapse · ${waiting.join(", ")}` }),
      },
    ];

    return [
      { title: "head", subtitle: "fixed · clustered by type · one order", nodes: head },
      { title: "body", subtitle: "the live context, in the order it occurred", nodes: body },
      { title: "tail", subtitle: "the state block · always current", nodes: tail },
    ];
  }

  /**
   * The whole context on one screen: every entry closed to its one-line summary,
   * or every entry open if any of them was closed. This is the counterpart to
   * the per-row fold, for when the person wants the shape of the prompt back
   * rather than a page of prose.
   */
  toggleAll(): void {
    const nodes = this.sections.flatMap((section) => section.nodes);
    if (nodes.length === 0) return;
    const anyOpen = nodes.some((node) => this.isOpen(node));
    for (const node of nodes) this.folded.set(node.id, !anyOpen);
  }

  /** Pin or unpin the row under the cursor, the same act `p` performs. The palette calls this. */
  pinSelected(): void {
    const target = this.selectedNode()?.target;
    if (target === undefined || target.part === "tools") return;
    this.onTogglePin?.(target.part, target.id);
  }

  /**
   * Mark the entry under the cursor for archive or for delete (§4.1). The same
   * act the `a` and `d` keys perform, so the palette cannot drift from the key.
   * A mark waits for the collapse unless `!` armed it, and arming is spent by
   * the mark it armed.
   */
  markSelected(action: "archive" | "delete"): void {
    const target = this.selectedNode()?.target;
    if (target === undefined) return;
    const now = this.nowArmed;
    this.nowArmed = false;
    const ephemeral = target.part === "transcript" || target.part === "tool-work" || target.part === "ephemera";
    const key = `${target.part}:${String(target.id)}`;
    if (ephemeral && action === "archive" && !now && this.archiveConfirmation !== key) {
      this.archiveConfirmation = key;
      return;
    }
    this.archiveConfirmation = undefined;
    if (action === "archive") this.onArchive?.(target.part, target.id, ephemeral || now);
    else this.onDelete?.(target.part, target.id, now);
  }

  /** Withdraw the mark on the entry under the cursor (§4.1). The palette calls this. */
  withdrawSelected(): void {
    const target = this.selectedNode()?.target;
    if (target === undefined) return;
    if (this.archiveConfirmation === `${target.part}:${String(target.id)}`) {
      this.archiveConfirmation = undefined;
      return;
    }
    this.onWithdrawMark?.(target.part, target.id);
  }

  /** Arm or disarm apply-now, and say which it is now: the next mark is spent either way. */
  toggleApplyNow(): boolean {
    this.nowArmed = !this.nowArmed;
    return this.nowArmed;
  }

  /** One drawn row, by the part it belongs to and its id: what a pin or a mark acts on. */
  nodeFor(part: MarkTarget["part"], id: string | number): PromptNode | undefined {
    return this.sections
      .flatMap((section) => section.nodes)
      .find((node) => node.target?.part === part && String(node.target.id) === String(id));
  }

  /** The next entry in a direction, skipping headings and wrapping at the edge. */
  private step(direction: 1 | -1): number {
    for (let at = this.cursor + direction; at >= 0 && at < this.rows.length; at += direction) {
      const row = this.rows[at];
      if (row !== undefined && "node" in row) return at;
    }
    return direction === 1 ? this.firstEntry() : this.lastEntry();
  }

  /**
   * Scroll the cursor's row into view after a move. The line offsets come from
   * the last render, which is the only place they exist; a view that has not
   * rendered yet has nothing to reveal, and the next one will.
   */
  private revealCursor(): void {
    const range = this.hits.find((hit) => hit.index === this.cursor);
    if (range === undefined) return;
    this.onReveal?.(range.start, range.end);
  }

  private firstEntry(): number {
    const at = this.rows.findIndex((row) => "node" in row);
    return at === -1 ? 0 : at;
  }

  private lastEntry(): number {
    for (let at = this.rows.length - 1; at >= 0; at -= 1) {
      const row = this.rows[at];
      if (row !== undefined && "node" in row) return at;
    }
    return 0;
  }

  private selectedNode(): PromptNode | undefined {
    const row = this.rows[this.cursor];
    return row !== undefined && "node" in row ? row.node : undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "tab") || matchesKey(data, "r")) {
      this.showReal = !this.showReal;
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onBack?.();
      return;
    }
    // The cursor only ever lands on an entry. A section heading is a label for
    // what follows, is drawn without a cursor, and has nothing a mark or a fold
    // can act on — so walking onto one made the cursor vanish mid-scroll.
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.cursor = this.step(1);
      this.revealCursor();
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.cursor = this.step(-1);
      this.revealCursor();
      return;
    }
    if (matchesKey(data, "g")) {
      this.cursor = this.firstEntry();
      this.revealCursor();
      return;
    }
    if (data === "G") {
      this.cursor = this.lastEntry();
      this.revealCursor();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      this.toggleAt(this.cursor);
      return;
    }

    if (matchesKey(data, "!")) {
      this.toggleApplyNow();
      return;
    }
    if (matchesKey(data, "c")) {
      this.onCollapse?.();
      return;
    }
    if (matchesKey(data, "p")) {
      this.pinSelected();
      return;
    }
    if (matchesKey(data, "d")) {
      this.markSelected("delete");
      return;
    }
    if (matchesKey(data, "a")) {
      this.markSelected("archive");
      return;
    }
    if (matchesKey(data, "u")) {
      this.withdrawSelected();
      return;
    }
  }

  handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent): import("@earendil-works/pi-tui").TuiMouseEventResult | undefined {
    if (event.type === "wheel") return undefined; // the scroll view owns the wheel
    if (event.type === "press") return { handled: true, focus: true };
    if (event.type !== "click") return undefined;
    const hit = this.hits.find((range) => event.y >= range.start && event.y < range.end);
    if (hit === undefined) return undefined;
    this.cursor = hit.index;
    // A click anywhere in an entry folds it, not only on the line it hit.
    this.toggleAt(hit.index);
    return { handled: true, render: true, focus: true };
  }

  invalidate(): void {
    // Stateless.
  }

  render(width: number): string[] {
    const lines: string[] = [];
    this.hits = [];
    const inner = Math.max(16, width - 2);
    const ink = (text: string): string => ` ${text}`;

    const left = `${tokens.bold(tokens.accent("CONTEXT"))} ${tokens.faint("· what the model reads")} ${tokens.faint(`· ~${this.totalTokens().toLocaleString("en-US")} tokens`)}`;
    const mode = this.showReal ? tokens.warn("as the model receives it") : tokens.muted("as a person reads it");
    // "Now" is a rebuild in place, not a collapse (§4.1), and the line says so:
    // a key that turns out to be the most expensive operation there is would be
    // worse than no key at all.
    const armed = this.nowArmed ? ` ${tokens.danger("· next mark applies now, rebuilding in place")}` : "";
    const right = `${mode}${armed}`;
    const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
    lines.push(tokens.panel(padLine(` ${left}${" ".repeat(gap)}${right}`, width)));
    lines.push(canvasLine("", width));

    if (this.data === undefined) {
      lines.push(ink(tokens.muted("The context has not been read yet.")));
      return lines;
    }

    let rowIndex = 0;
    this.sections.forEach((section, sectionIndex) => {
      lines.push(canvasLine("", width));
      const heading = `${tokens.faint(section.title.toUpperCase())} ${tokens.faint(`· ${section.subtitle}`)}`;
      lines.push(canvasLine(ink(heading), width));
      rowIndex += 1; // the section heading row
      for (const node of section.nodes) {
        const index = rowIndex;
        rowIndex += 1;
        const start = lines.length;
        lines.push(...this.renderNode(node, width, index === this.cursor));
        this.hits.push({ start, end: lines.length, index });
      }
    });

    return lines;
  }

  /**
   * Are this entry's contents on screen? Nothing starts open, so this is the
   * fold and only the fold. This is what a click and `enter` act on, for one
   * entry or for everything under a section heading.
   */
  private isOpen(node: PromptNode): boolean {
    return this.folded.get(node.id) === true;
  }

  /**
   * `enter` or a click, on whatever the cursor or the pointer landed on: an
   * entry folds or unfolds; a section heading opens or closes every entry under
   * it, which is how a long head becomes one line again.
   */
  private toggleAt(cursor: number): void {
    const row = this.rows[cursor];
    if (row === undefined) return;
    if ("node" in row) {
      this.folded.set(row.node.id, !this.isOpen(row.node));
      return;
    }
    const section = this.sections[row.section];
    if (section === undefined || section.nodes.length === 0) return;
    // The map holds "open", so closing everything is `false`: a heading with
    // anything open under it closes the lot; a heading fully closed opens it.
    const anyOpen = section.nodes.some((node) => this.isOpen(node));
    for (const node of section.nodes) this.folded.set(node.id, !anyOpen);
  }

  /** One entry: handle, name; then its body when it is open. */
  private renderNode(node: PromptNode, width: number, selected: boolean): string[] {
    // The pin badge names who placed it; a view with no person of its own says
    // "you", which is what a stand-alone frame means.
    const who = this.data?.person ?? "you";
    const open = this.isOpen(node);
    const confirmed = node.target !== undefined && this.archiveConfirmation === `${node.target.part}:${String(node.target.id)}`;
    const ink = confirmed ? tokens.danger : KIND_INK[node.kind];
    const cursor = selected ? (confirmed ? tokens.danger("▌") : tokens.accent("▌")) : " ";
    const glyph = open ? "▾" : "▸";
    const handle = ink(node.handle.padEnd(3));
    // One name column. The handle's prefix already says what kind of thing the
    // entry is, so the column holds its name: `read`, `bash`, a record's title.
    const name = selected ? tokens.bold(ink(node.label)) : ink(node.label);
    const mark = node.marked === undefined ? "" : ` ${tokens.warn(`◆ ${node.marked}`)}`;
    // A pin is an entry of its own and names itself by what it marks (§5.4),
    // so the row carries `P <handle>` and who placed it.
    const pinned =
      node.pinned === undefined
        ? ""
        : ` ${tokens.pin(`P ${node.handle.trim()} ${node.pinned === "user" ? who : "agent"}`)} `;
    const clippedName = truncateToWidth(name, NAME_COLUMN, "…");
    const paddedName = `${clippedName}${" ".repeat(Math.max(1, NAME_COLUMN - visibleWidth(clippedName)))}`;
    // Put the pending action before the name and preview so it survives narrow panes.
    const head = `${cursor} ${tokens.muted(glyph)} ${handle}${mark}${mark === "" ? "" : " "}${paddedName}${pinned}`;
    const costText = formatTokenCost(node.tokens);
    const cost = confirmed ? tokens.danger(costText) : tokens.muted(costText);
    const costWidth = visibleWidth(costText);
    const headWidth = visibleWidth(head);
    const lines: string[] = [];

    if (!open) {
      // Right-align each entry's token cost so costs can be scanned down a column,
      // leaving room for the preview (and keeping pending marks intact on narrow panes).
      const roomWithCost = width - headWidth - costWidth - 3;
      if (roomWithCost >= 8) {
        const preview = truncateToWidth(node.summary.length > 0 ? node.summary : "(empty)", roomWithCost, "…");
        const styledPreview = confirmed ? tokens.danger(preview) : tokens.faint(preview);
        const gap = Math.max(2, width - headWidth - visibleWidth(preview) - costWidth - 1);
        lines.push(surfaceLine(`${head}${styledPreview}${" ".repeat(gap)}${cost}`, width));
        return lines;
      }
      if (headWidth + costWidth + 2 <= width) {
        const gap = width - headWidth - costWidth - 1;
        lines.push(surfaceLine(`${head}${" ".repeat(gap)}${cost}`, width));
        return lines;
      }
      const room = Math.max(8, width - headWidth - 2);
      const preview = truncateToWidth(node.summary.length > 0 ? node.summary : "(empty)", room, "…");
      lines.push(surfaceLine(`${head}${confirmed ? tokens.danger(preview) : tokens.faint(preview)}`, width));
      return lines;
    }

    const openGap = width - headWidth - costWidth - 1;
    lines.push(surfaceLine(openGap >= 1 ? `${head}${" ".repeat(openGap)}${cost}` : head, width));
    lines.push(...this.renderBody(node, width, ink));
    return lines;
  }

  /**
   * The body of an entry that is on screen: a paragraph, never a preview and
   * never clipped. It wraps to the column, and `BODY_INSET` is the exact
   * visible width of the `│` gutter plus its space, so a wrapped line lands
   * inside the pane instead of one column past it where `padLine` would clip it.
   */
  private renderBody(node: PromptNode, width: number, ink: (text: string) => string): string[] {
    const body = this.showReal && node.real !== undefined ? node.real : node.body;
    if (body.trim().length === 0) return [];
    const lines: string[] = [];
    const bodyWidth = Math.max(8, width - BODY_INSET);
    for (const logical of body.split("\n")) {
      if (logical.trim().length === 0) {
        lines.push(canvasLine("", width));
        continue;
      }
      for (const line of wrapTextWithAnsi(logical, bodyWidth)) {
        lines.push(canvasLine(`${BODY_GUTTER}${ink(line)}`, width));
      }
    }
    return lines;
  }
}
