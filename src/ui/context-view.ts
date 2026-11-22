/**
 * The prompt (§8): what the model reads, in the order it reads it.
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
 * **A leaf is never folded.** A tool call's arguments, a result, a line of
 * system prompt: each is a leaf, and it renders whole. Only things that contain
 * things — a tool's schema, a Brain entry with links and attachments, the state
 * block's sections — fold. A collapsed entry keeps a one-line summary, so the
 * prompt is scannable without being a list of headings.
 *
 * `tab` swaps between the **human** view and the **real** view for
 * schema-shaped content: the same entry, as a person reads it and as the model
 * receives it.
 *
 * Marks are made here and are not deletions (§4.1): `d` marks the entry under
 * the cursor, `!` arms "now" so the next mark is applied by a rebuild instead of
 * waiting for the collapse, `c` collapses.
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
import type { CartoBrain } from "../domain/records.js";
import { projectContext } from "../domain/projection.js";
import { canvasLine, padLine, tokens } from "./tokens.js";

export interface ContextToolItem {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ContextDialogueMessage {
  id: string | number;
  role: string;
  text: string;
  timestamp?: number | undefined;
}

export interface ContextWorkItem {
  id: string | number;
  kind: string;
  name?: string | undefined;
  args?: string | undefined;
  output?: string | undefined;
  text?: string | undefined;
}

export interface ContextViewData {
  brain: CartoBrain;
  systemPrompt: string;
  /** The frozen projection's exact bytes — the carto-context section the model reads. */
  projectionText?: string | undefined;
  tools: ContextToolItem[];
  transcriptMessages: ContextDialogueMessage[];
  toolWorkItems: ContextWorkItem[];
  stateBlockText: string;
}

/** What a node can be marked: the part of the product a mark on it would touch. */
export type MarkTarget = { part: "transcript" | "tool-work" | "tools"; id: string | number };

type NodeKind =
  | "system"
  | "tool"
  | "atlas"
  | "ledger"
  | "chat"
  | "person"
  | "reasoning"
  | "call"
  | "result"
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
  /** Never folded, whatever the kind says: a leaf. */
  leaf?: boolean;
  /** Whether it starts open. Model-shaped bodies start folded, prose starts open. */
  open?: boolean;
  /** Where a mark on this node lands. Absent for the parts of the prompt the person cannot remove. */
  target?: MarkTarget;
  /** The marked action already recorded on it, if any. */
  marked?: string;
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
  person: tokens.person,
  reasoning: tokens.reasoning,
  call: tokens.tool,
  result: tokens.output,
  state: tokens.warn,
};

/** Cells the name column takes, so the summaries line up under each other. */
const NAME_COLUMN = 14;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The frozen projection, as entries. The projection is one section of the
 * system message, so the bytes are what the model reads; splitting it back into
 * its entries is a read of those bytes, never a re-render of the Brain.
 */
function projectionEntries(text: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split("\n")) {
    const match = /^([ALC]\d+)\b/.exec(line);
    if (match !== null && match[1] !== undefined) {
      current = [line];
      entries.set(match[1], current);
    } else if (current !== undefined) {
      current.push(line);
    }
  }
  return entries;
}

export class ContextView implements Component, Focusable {
  focused = false;
  onBack?: () => void;
  onDelete?: (partId: string, itemId: string | number, now: boolean) => void;
  onCollapse?: () => void;
  /** Fired on `p` over an entry that names a Brain chat record: toggle the pin marker. */
  onTogglePin?: (partId: string, itemId: string | number) => void;

  private data: ContextViewData | undefined;
  private sections: PromptSection[] = [];
  /** The flattened order the cursor walks: section boundaries included. */
  private rows: Array<{ section: number } | { node: PromptNode; section: number }> = [];
  private cursor = 0;
  private nowArmed = false;
  private showReal = false;
  private folded = new Map<string, boolean>();
  private hits: Array<{ start: number; end: number; index: number }> = [];

  setData(data: ContextViewData): void {
    this.data = data;
    this.sections = this.build(data);
    this.rows = [];
    this.sections.forEach((section, index) => {
      this.rows.push({ section: index });
      for (const node of section.nodes) this.rows.push({ node, section: index });
    });
    // The cursor starts on an entry, never on a section heading: a heading is a
    // label for what follows, not something a mark or a fold can land on.
    const firstNode = this.rows.findIndex((row) => "node" in row);
    this.cursor = firstNode === -1 ? 0 : firstNode;
  }

  /** Estimated size of everything the model reads, for the header. */
  private totalTokens(): number {
    if (this.data === undefined) return 0;
    return (
      estimateTokens(this.data.systemPrompt) +
      estimateSerialized(this.data.tools) +
      estimateTokens(this.data.projectionText ?? "") +
      estimateSerialized(this.data.transcriptMessages) +
      estimateSerialized(this.data.toolWorkItems) +
      estimateTokens(this.data.stateBlockText)
    );
  }

  private build(data: ContextViewData): PromptSection[] {
    const handles = data.brain.handles;
    const projection = projectionEntries(data.projectionText ?? projectContext(data.brain).text);

    // ── head ────────────────────────────────────────────────────────────────
    const head: PromptNode[] = [
      {
        id: "system",
        handle: "H",
        kind: "system",
        label: "system prompt",
        summary: oneLine(data.systemPrompt),
        body: data.systemPrompt,
        real: data.systemPrompt,
        open: false,
        leaf: false,
      },
    ];

    data.tools.forEach((tool, index) => {
      head.push({
        id: `tool-${tool.name}`,
        handle: `Y${index + 1}`,
        kind: "tool",
        label: tool.name,
        summary: tool.description,
        body: `${tool.description}\n\n${JSON.stringify(tool.parameters, null, 2)}`,
        real: JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }, null, 2),
        open: false,
        target: { part: "tools", id: tool.name },
      });
    });

    const record = (kind: "atlas" | "ledger" | "chat", id: string, handle: string | undefined, body: string): PromptNode => {
      const bytes = handle === undefined ? undefined : projection.get(handle);
      // The two views of one entry: what the person can read, and the bytes the
      // model receives. A record written since the freeze is in the Brain but not
      // yet in the projection; the real view says so rather than showing bytes
      // that are not there.
      const frozen = bytes === undefined || bytes.length === 0 ? undefined : bytes;
      return {
        id: `${kind}-${id}`,
        handle: handle ?? "?",
        kind,
        // The handle's letter already says which book this is; the name column
        // says it again in words so a row can be read without decoding letters.
        label: kind,
        summary: oneLine(body),
        body,
        real: frozen === undefined
          ? "(not in the frozen projection yet — this entry reaches the head at the next collapse)"
          : frozen.join("\n"),
        open: false,
      };
    };

    for (const node of data.brain.atlas) {
      head.push(record("atlas", node.id, handleOf(handles, "atlas", node.id), node.title));
    }
    for (const entry of data.brain.ledger) {
      head.push(record("ledger", entry.id, handleOf(handles, "ledger", entry.id), entry.text));
    }
    for (const chat of data.brain.chat) {
      head.push(record("chat", chat.id, handleOf(handles, "chat", chat.id), oneLine(chat.text)));
    }

    // ── body ────────────────────────────────────────────────────────────────
    // The body is never sorted by kind: the person's messages, the reasoning, the
    // calls and their results sit in the order the model receives them. The app
    // hands two lists; their ids are the context entry numbers, so the merge is
    // by that number and nothing else.
    const candidates: Array<{ key: number; order: number; node: PromptNode }> = [];
    let workCount = 0;
    for (const item of data.toolWorkItems) {
      workCount += 1;
      const key = Number.parseInt(String(item.id), 10) || 0;
      const suffix = Number.parseInt(String(item.id).split("-")[1] ?? "0", 10) || 0;
      if (item.kind === "reasoning") {
        candidates.push({
          key,
          order: suffix,
          node: {
            id: `work-${String(item.id)}`,
            handle: `X${workCount}`,
            kind: "reasoning",
            label: "thinking",
            summary: oneLine(item.text ?? ""),
            body: item.text ?? "",
            leaf: true,
          },
        });
      } else if (item.kind === "toolCall") {
        candidates.push({
          key,
          order: suffix,
          node: {
            id: `work-${String(item.id)}`,
            handle: `X${workCount}`,
            kind: "call",
            label: item.name ?? "call",
            summary: oneLine(item.args ?? ""),
            body: item.args ?? "",
            leaf: true,
          },
        });
      } else {
        candidates.push({
          key,
          order: suffix,
          node: {
            id: `work-${String(item.id)}`,
            handle: `X${workCount}`,
            kind: "result",
            label: "result",
            summary: oneLine(item.output ?? ""),
            body: item.output ?? "",
            leaf: true,
          },
        });
      }
    }
    let personCount = 0;
    for (const message of data.transcriptMessages) {
      if (message.role !== "user") continue;
      personCount += 1;
      candidates.push({
        key: Number.parseInt(String(message.id), 10) || 0,
        // A person's message precedes the work its entry produced.
        order: -1,
        node: {
          id: `msg-${String(message.id)}`,
          handle: `U${personCount}`,
          kind: "person",
          label: "you",
          summary: oneLine(message.text),
          body: message.text,
          leaf: true,
          target: { part: "transcript", id: message.id },
        },
      });
    }
    const body = candidates.sort((left, right) => left.key - right.key || left.order - right.order).map((entry) => entry.node);

    // ── tail ────────────────────────────────────────────────────────────────
    const tail: PromptNode[] = [
      {
        id: "state-block",
        handle: "B",
        kind: "state",
        label: "state block",
        summary: "what is true right now: mode, fullness, writes, staleness, tree, pins, marks",
        body: data.stateBlockText,
        real: data.stateBlockText,
        open: false,
        leaf: false,
      },
    ];

    return [
      { title: "head", subtitle: "fixed · clustered by type · one order", nodes: head },
      { title: "body", subtitle: "the live context, in the order it occurred", nodes: body },
      { title: "tail", subtitle: "the state block · always current", nodes: tail },
    ];
  }

  /** Fold state: open unless the person closed it. A leaf is never folded. */
  private isOpen(node: PromptNode): boolean {
    if (node.leaf === true) return true;
    return this.folded.get(node.id) ?? node.open === true;
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
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.cursor = Math.min(this.rows.length - 1, this.cursor + 1);
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (matchesKey(data, "g")) {
      this.cursor = 0;
      return;
    }
    if (data === "G") {
      this.cursor = Math.max(0, this.rows.length - 1);
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const node = this.selectedNode();
      if (node !== undefined && node.leaf !== true) this.folded.set(node.id, !this.isOpen(node));
      return;
    }
    if (data === "!") {
      this.nowArmed = !this.nowArmed;
      return;
    }
    if (matchesKey(data, "c")) {
      this.onCollapse?.();
      return;
    }
    if (matchesKey(data, "p")) {
      const node = this.selectedNode();
      if (node !== undefined && node.target?.part === "transcript") this.onTogglePin?.("transcript", node.target.id);
      return;
    }
    if (matchesKey(data, "d")) {
      const node = this.selectedNode();
      if (node !== undefined && node.target !== undefined) {
        this.onDelete?.(node.target.part, node.target.id, this.nowArmed);
        this.nowArmed = false;
      }
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
    const node = this.selectedNode();
    if (node !== undefined && node.leaf !== true) this.folded.set(node.id, !this.isOpen(node));
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

    const left = `${tokens.bold(tokens.accent("PROMPT"))} ${tokens.faint("· what the model reads")} ${tokens.faint(`· ~${this.totalTokens().toLocaleString("en-US")} tokens`)}`;
    const mode = this.showReal ? tokens.warn("as the model receives it") : tokens.muted("as a person reads it");
    const armed = this.nowArmed ? ` ${tokens.danger("· next mark applies now")}` : "";
    const right = `${mode}${armed}`;
    const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
    lines.push(tokens.panel(padLine(` ${left}${" ".repeat(gap)}${right}`, width)));
    lines.push(canvasLine("", width));

    if (this.data === undefined) {
      lines.push(ink(tokens.muted("Nothing in the prompt yet.")));
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

  /** One entry: handle, kind, name; then its body when it is open. */
  private renderNode(node: PromptNode, width: number, selected: boolean): string[] {
    const open = this.isOpen(node);
    const ink = KIND_INK[node.kind];
    const cursor = selected ? tokens.accent("▌") : " ";
    const glyph = node.leaf === true ? " " : open ? "▾" : "▸";
    const handle = ink(node.handle.padEnd(3));
    // One name column. The handle's prefix already says what kind of thing the
    // entry is, so the column holds its name: `read`, `bash`, a record's title.
    const name = selected ? tokens.bold(ink(node.label)) : ink(node.label);
    const mark = node.marked === undefined ? "" : ` ${tokens.warn(`◆ ${node.marked}`)}`;
    const clippedName = truncateToWidth(name, NAME_COLUMN, "…");
    const paddedName = `${clippedName}${" ".repeat(Math.max(1, NAME_COLUMN - visibleWidth(clippedName)))}`;
    const head = `${cursor} ${tokens.muted(glyph)} ${handle}${paddedName}${mark}`;
    const lines: string[] = [];

    if (node.leaf === true || !open) {
      const room = Math.max(8, width - visibleWidth(head) - 2);
      const preview = truncateToWidth(node.summary.length > 0 ? node.summary : "…", room, "…");
      lines.push(canvasLine(`${head}${tokens.faint(preview)}`, width));
      return lines;
    }

    lines.push(canvasLine(head, width));
    const body = this.showReal && node.real !== undefined ? node.real : node.body;
    const bodyWidth = Math.max(8, width - 6);
    for (const logical of body.split("\n")) {
      if (logical.length === 0) {
        lines.push(canvasLine("", width));
        continue;
      }
      for (const line of wrapTextWithAnsi(logical, bodyWidth)) {
        lines.push(canvasLine(`     ${tokens.rule("│")} ${ink(line)}`, width));
      }
    }
    return lines;
  }
}
