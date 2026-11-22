/**
 * The transcript (§8): everything the agent does, in the order it did it.
 *
 * Posting's screen is one document you read top to bottom, with the working
 * surface in front and everything else quiet around it. The transcript is that
 * document:
 *
 * - A **person's line** is a block with a cyan spine, the word `you`, and the
 *   text in body ink. It is never folded and never truncated.
 * - An **agent Chat record** is the same block in the agent's green. Chat is the
 *   only channel that addresses the person (§2.3), so it is the only thing on
 *   screen at full weight other than the person's own words.
 * - Everything else — reasoning, plain model text, tool calls and their results
 *   — is a **card**: one line when folded, a guttered body when open, in its own
 *   hue and quieter than Chat. A card that is streaming stays open inside a
 *   bounded window; the moment the round lands it folds to its header.
 * - **Status lines** are a faint middot and a sentence: quiet facts about the
 *   session, never the agent's voice.
 *
 * A click folds or unfolds a card, a click on a Chat block toggles its pin,
 * `ctrl+e` folds every card in view, and the wheel belongs to the page — the
 * one scrolling owner (§8) — so scrolling up simply stops following the tail.
 *
 * Order is the context's order, not arrival order: a person's line appears
 * where it actually landed, and a line that is submitted but not yet placed sits
 * at the end, dimmed and labelled, until the run reaches a boundary.
 *
 * Nothing here is data: the workspace rebuilds the landed list from the session
 * and the Brain at every drain and pushes the in-flight partial separately.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

import { canvasLine, statusLine, statusWarnLine, tokens } from "./tokens.js";

type BlockRange = { id: string; start: number; end: number };

type CardBase = {
  /** Stable across rebuilds while it lives: `ctx-<entryId>-<part>` landed, `live-<attempt>-<part>` in flight. */
  id: string;
  /** True while fed from the live partial: defaults its fold open and is replaced when the round lands. */
  live?: boolean;
  /** Live tool status, from the live round's slot; absent when landed. */
  status?: "pending" | "running" | "done";
  /** Landed tool calls whose result came back as an error. */
  failed?: boolean;
};
export type CardEntry =
  | (CardBase & { kind: "reasoning"; text: string })
  | (CardBase & { kind: "output"; text: string })
  | (CardBase & { kind: "tool"; name: string; args: string; /** Retained running output while the call executes; preferred as the card body when present. */ output?: string });

export type TranscriptEntry =
  | { kind: "person"; text: string }
  | { kind: "agent"; text: string; /** The Brain chat record this block is a rendering of; omitted for boot-burst text. */ recordId?: string; /** The pin marker (who placed it), if any. */ pinned?: "user" | "agent" | undefined }
  | { kind: "status"; text: string; tone?: "warn" }
  | CardEntry;

export const isCard = (entry: TranscriptEntry): entry is CardEntry =>
  entry.kind === "reasoning" || entry.kind === "output" || entry.kind === "tool";

/** Spine, gap, then a six-cell label column; the body starts here and every continuation lines up under it. */
const LABEL_WIDTH = 6;
const PREFIX_WIDTH = LABEL_WIDTH + 2;
/** The body's left margin, added to every line after it is built. Text must fit inside it. */
const INSET = 2;
const SPINE = "▌";
const GUTTER = "│ ";
const LIVE_TAIL = 8;

interface CardRange {
  id: string;
  start: number;
  end: number;
}

interface WrapMemo {
  width: number;
  key: string;
  lines: string[];
}

/**
 * What a card is called. A tool card is its tool's name, because that is the
 * name the person uses for it; the others say what kind of thing they are.
 */
const kindLabel = (card: CardEntry): string => (card.kind === "reasoning" ? "thinking" : card.kind === "output" ? "text" : card.name.length > 0 ? card.name : "tool");
const kindTint = (card: CardEntry): ((text: string) => string) =>
  card.kind === "reasoning" ? tokens.reasoning : card.kind === "output" ? tokens.output : tokens.tool;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const firstLine = (text: string): string => {
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) return line.trim();
  }
  return "";
};
const memoKey = (text: string): string => `${text.length}:${text.slice(0, 64)}:${text.slice(-64)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function formatObjectArgs(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return "{}";
  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      if (value.includes("\n")) {
        lines.push(`${key}:`);
        for (const line of value.split("\n")) {
          lines.push(`  ${line}`);
        }
      } else {
        lines.push(`${key}: ${value}`);
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (value.every((item) => typeof item === "string" || typeof item === "number")) {
        lines.push(`${key}: [${value.join(", ")}]`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          if (isRecord(item)) {
            const inner = formatObjectArgs(item).split("\n");
            lines.push(`  - ${inner[0]}`);
            for (let i = 1; i < inner.length; i++) {
              lines.push(`    ${inner[i]}`);
            }
          } else {
            lines.push(`  - ${String(item)}`);
          }
        }
      }
    } else if (isRecord(value)) {
      lines.push(`${key}:`);
      const inner = formatObjectArgs(value).split("\n");
      for (const line of inner) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Format tool arguments progressively:
 * If the tool name is unknown or empty, dump raw JSON text as-is.
 * Once the tool name is known, format valid parsed JSON fields into human-readable key-values.
 */
export function formatToolArgs(args: unknown, name?: string): string {
  if (args === undefined || args === null) return "";
  if (!name || name.trim() === "") {
    if (typeof args === "string") return args;
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (isRecord(parsed)) return formatObjectArgs(parsed);
      } catch {
        // Fall back to raw string
      }
    }
    return args;
  }
  if (isRecord(args)) return formatObjectArgs(args);
  return String(args);
}

export class TranscriptView implements Component {
  private items: TranscriptEntry[] = [];
  private queued: Array<{ text: string; mode: string }> = [];
  private liveCards: CardEntry[] = [];
  private expanded = new Map<string, boolean>();
  private wrapMemo = new Map<string, WrapMemo>();
  private ranges: CardRange[] = [];
  private blockRanges: BlockRange[] = [];
  private cacheWidth = -1;
  /** Fired on a click of an agent block that names a Brain record: toggle the pin marker. */
  onTogglePin?: (recordId: string) => void;
  private cacheLines: string[] = [];

  constructor(private readonly options: { project?: string } = {}) {}

  /** Replace the landed list (already in final order) and the queued list (rendered after it). */
  setEntries(entries: TranscriptEntry[], queued: Array<{ text: string; mode: string }> = []): void {
    this.items = [...entries];
    this.queued = [...queued];
    this.pruneState();
    this.cacheWidth = -1;
  }

  /** Replace the in-flight partial's cards (rendered after the landed list, before the queued lines). */
  setLive(cards: CardEntry[]): void {
    this.liveCards = [...cards];
    this.pruneState();
    this.cacheWidth = -1;
  }

  /** The landed list plus the current in-flight tail, for sealing at a collapse. */
  snapshot(): TranscriptEntry[] {
    return [...this.items, ...this.liveCards];
  }

  reset(): void {
    this.items = [];
    this.queued = [];
    this.liveCards = [];
    this.expanded.clear();
    this.wrapMemo.clear();
    this.cacheWidth = -1;
  }

  get length(): number {
    return this.items.length + this.liveCards.length + this.queued.length;
  }

  invalidate(): void {
    this.cacheWidth = -1;
  }

  /** Expand every card, or collapse every card when any is open. */
  toggleAllCards(): void {
    const ids = this.cardIds();
    if (ids.length === 0) return;
    const anyOpen = ids.some((id) => {
      const card = this.cardById(id);
      return card !== undefined && this.isExpanded(card);
    });
    for (const id of ids) this.expanded.set(id, !anyOpen);
    this.cacheWidth = -1;
  }

  private cardIds(): string[] {
    const ids: string[] = [];
    for (const entry of this.items) if (isCard(entry)) ids.push(entry.id);
    for (const card of this.liveCards) ids.push(card.id);
    return ids;
  }

  private cardById(id: string): CardEntry | undefined {
    for (const entry of this.items) if (isCard(entry) && entry.id === id) return entry;
    return this.liveCards.find((card) => card.id === id);
  }

  private isExpanded(card: CardEntry): boolean {
    return this.expanded.get(card.id) ?? card.live === true;
  }

  private pruneState(): void {
    const present = new Set(this.cardIds());
    for (const id of [...this.expanded.keys()]) if (!present.has(id)) this.expanded.delete(id);
    for (const id of [...this.wrapMemo.keys()]) if (!present.has(id)) this.wrapMemo.delete(id);
  }

  /** Plain text of everything currently rendered, for `/copy` — cards in full, never folded. */
  toPlainText(): string {
    const lines: string[] = [];
    for (const entry of this.items) {
      if (entry.kind === "person") lines.push(`you: ${entry.text}`);
      else if (entry.kind === "agent") lines.push(`carto: ${entry.text}`);
      else if (entry.kind === "status") lines.push(`· ${entry.text}`);
      else if (entry.kind === "reasoning") lines.push(`thinking: ${entry.text}`);
      else if (entry.kind === "output") lines.push(`text: ${entry.text}`);
      else lines.push(`tool ${entry.name}`, ...(entry.output ?? entry.args).split("\n").map((line) => `  ${line}`));
    }
    for (const card of this.liveCards) {
      if (card.kind === "reasoning") lines.push(`thinking: ${card.text}`);
      else if (card.kind === "output") lines.push(`text: ${card.text}`);
      else lines.push(`tool ${card.name}`, ...(card.output ?? card.args).split("\n").map((line) => `  ${line}`));
    }
    for (const item of this.queued) lines.push(`you (queued): ${item.text}`);
    return lines.join("\n");
  }

  /**
   * A voice block: a coloured spine, a label in its own hue, the text in body
   * ink, and every continuation line aligned under the text column.
   */
  private block(who: "you" | "carto", text: string, width: number, extra?: string): string[] {
    const tint = who === "you" ? tokens.person : tokens.agent;
    const label = who === "you" ? "you" : "carto";
    const marker = extra !== undefined && extra.length > 0 ? ` ${extra}` : "";
    // The text is wrapped once, at the body's width, and a pin rides on the last
    // line if there is room for it there. Wrapping it twice — narrower for the
    // first line, wider for the rest — would move the column, which is worse.
    const body = Math.max(1, width - INSET - PREFIX_WIDTH);
    const lines = wrapTextWithAnsi(text, body).map((line, index) =>
      index === 0
        ? `${tint(SPINE)} ${tint(tokens.bold(label.padEnd(LABEL_WIDTH)))}${tokens.text(line)}`
        : `${" ".repeat(PREFIX_WIDTH)}${tokens.text(line)}`,
    );
    if (marker.length > 0) {
      const room = Math.max(0, body - visibleWidth(wrapTextWithAnsi(text, body).at(-1) ?? ""));
      if (room >= visibleWidth(marker) + 1) {
        lines[lines.length - 1] = `${lines[lines.length - 1]}${marker}`;
      } else {
        lines.push(`${" ".repeat(PREFIX_WIDTH)}${marker.trimStart()}`);
      }
    }
    return lines;
  }

  private wrapBody(card: CardEntry, width: number): string[] {
    const body = card.kind === "tool" ? card.output ?? card.args : card.text;
    const widthLimit = Math.max(1, width - PREFIX_WIDTH - visibleWidth(GUTTER));
    const key = memoKey(body);
    const cached = this.wrapMemo.get(card.id);
    if (cached !== undefined && cached.width === widthLimit && cached.key === key) return cached.lines;
    const lines: string[] = [];
    for (const logical of body.split("\n")) {
      if (logical.length === 0) {
        lines.push("");
        continue;
      }
      lines.push(...wrapTextWithAnsi(logical, widthLimit));
    }
    this.wrapMemo.set(card.id, { width: widthLimit, key, lines });
    return lines;
  }

  private cardHeader(card: CardEntry, width: number, expanded: boolean): string {
    const tint = kindTint(card);
    const glyph = expanded ? "▾" : "▸";
    const labelText = kindLabel(card);
    const label = tint(tokens.bold(labelText));
    const gap = " ".repeat(Math.max(1, 6 - labelText.length)); // the label column: thinking/text/tool …
    const keyPrefix = `  ${tint(glyph)} ${label}`;

    const marks: string[] = [];
    if (card.failed === true) marks.push(tokens.danger("· failed"));
    else if (card.status === "running") marks.push(tokens.faint("· running"));
    else if (card.status === "pending") marks.push(tokens.faint("· queued"));

    if (expanded) {
      const tail = marks.length > 0 ? ` ${marks.join(" ")}` : "";
      return `${keyPrefix}${tail}`;
    }
    const summary = card.kind === "tool"
      ? (card.args.trim().length > 0 ? oneLine(card.args) : "")
      : firstLine(card.text);
    const room = Math.max(1, width - visibleWidth(keyPrefix) - gap.length - 2);
    const preview = truncateToWidth(summary.length === 0 ? "…" : summary, room, "…");
    const tail = marks.length > 0 ? ` ${marks.join(" ")}` : "";
    return `${keyPrefix}${gap}${tokens.muted(preview)}${tail}`;
  }

  private renderCard(card: CardEntry, width: number): string[] {
    const expanded = this.isExpanded(card);
    const lines = [this.cardHeader(card, width, expanded)];
    if (!expanded) return lines;
    const body = this.wrapBody(card, width);
    const total = body.length;
    const indent = " ".repeat(PREFIX_WIDTH - 2);
    const gutter = tokens.rule(GUTTER);
    const paint = (line: string): string =>
      card.kind === "reasoning" ? tokens.reasoning(line) : card.kind === "output" ? tokens.output(line) : tokens.text(line);
    if (card.live === true && total > LIVE_TAIL) {
      lines.push(`${indent}${gutter}${tokens.faint(`⋯ ${total - LIVE_TAIL} earlier lines`)}`);
      for (const line of body.slice(total - LIVE_TAIL)) lines.push(`${indent}${gutter}${paint(line)}`);
      return lines;
    }
    for (const line of body) lines.push(`${indent}${gutter}${paint(line)}`);
    return lines;
  }

  private rangeAt(y: number): CardRange | undefined {
    return this.ranges.find((range) => y >= range.start && y < range.end);
  }

  /** A click folds or unfolds a card; a click on a Chat block toggles its pin. The wheel is the page's. */
  handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent): import("@earendil-works/pi-tui").TuiMouseEventResult | undefined {
    const cardRange = this.rangeAt(event.y);
    const block = this.blockRanges.find((range) => event.y >= range.start && event.y < range.end);
    if (cardRange === undefined && block === undefined) return undefined;

    if (event.type === "press") return { handled: true };
    if (event.type === "click") {
      if (block !== undefined) {
        this.onTogglePin?.(block.id);
        this.cacheWidth = -1;
        return { handled: true, render: true };
      }
      if (cardRange === undefined) return undefined;
      const card = this.cardById(cardRange.id);
      if (card === undefined) return undefined;
      this.expanded.set(card.id, !this.isExpanded(card));
      this.cacheWidth = -1;
      return { handled: true, render: true };
    }
    return undefined;
  }

  /** The first thing a person sees: what this is, and the three keys that get them around. */
  private emptyState(width: number): string[] {
    const project = this.options.project ?? "this project";
    const rule = tokens.faint("─".repeat(Math.max(1, Math.min(width - 4, 46))));
    return [
      "",
      `  ${tokens.bold(tokens.accent("carto"))} ${tokens.faint("·")} ${tokens.text(project)}`,
      `  ${rule}`,
      "",
      `  ${tokens.muted("Your working attention on this project. The Brain holds what it")}`,
      `  ${tokens.muted("understands; the context is rebuilt from it at every collapse.")}`,
      "",
      `  ${tokens.muted("Type to work. The agent speaks through")} ${tokens.agent("chat")}${tokens.muted("; its reasoning")}`,
      `  ${tokens.muted("and tool calls appear here as cards you can fold open.")}`,
      "",
      `  ${tokens.accent("^p")} ${tokens.faint("palette")}   ${tokens.accent("^o")} ${tokens.faint("jump")}   ${tokens.accent("/help")} ${tokens.faint("commands")}`,
      "",
    ];
  }

  render(width: number): string[] {
    if (this.cacheWidth === width) return this.cacheLines;
    const lines: string[] = [];
    const total = this.items.length + this.liveCards.length + this.queued.length;
    this.ranges = [];
    this.blockRanges = [];
    if (total === 0) {
      this.cacheLines = this.inset(this.emptyState(width), width);
      this.cacheWidth = width;
      return this.cacheLines;
    }
    let first = true;
    const gap = () => {
      if (first) first = false;
      else lines.push("");
    };
    const pushCard = (card: CardEntry) => {
      gap();
      const start = lines.length;
      lines.push(...this.renderCard(card, width));
      this.ranges.push({ id: card.id, start, end: lines.length });
    };
    for (const entry of this.items) {
      if (isCard(entry)) {
        pushCard(entry);
        continue;
      }
      gap();
      if (entry.kind === "person") {
        lines.push(...this.block("you", entry.text, width));
      } else if (entry.kind === "agent") {
        const start = lines.length;
        const pin = entry.pinned === undefined ? "" : tokens.pin(`⊙ ${entry.pinned === "user" ? "you" : "agent"}`);
        lines.push(...this.block("carto", entry.text, width, pin.length > 0 ? pin : undefined));
        if (entry.recordId !== undefined) this.blockRanges.push({ id: entry.recordId, start, end: lines.length });
      } else {
        const text = entry.tone === "warn" ? statusWarnLine(entry.text) : statusLine(entry.text);
        for (const line of wrapTextWithAnsi(`${text}`, width - 3)) lines.push(`  ${line}`);
      }
    }
    for (const card of this.liveCards) pushCard(card);
    for (const item of this.queued) {
      gap();
      const label = item.mode === "after run" ? "sends after the run" : item.mode === "now" ? "sends now" : "steers at the next boundary";
      const head = `${tokens.faint("⏸")} ${tokens.person(tokens.bold("you".padEnd(LABEL_WIDTH)))}`;
      const room = Math.max(1, width - INSET - visibleWidth(head));
      lines.push(`  ${head}${tokens.faint(tokens.italic(truncateToWidth(item.text, room, "…")))}`);
      lines.push(`  ${" ".repeat(PREFIX_WIDTH)}${tokens.faint(`· ${label}`)}`);
    }
    this.cacheWidth = width;
    this.cacheLines = this.inset(lines, width);
    return this.cacheLines;
  }

  /**
   * The body breathes: a left margin on every line, and the page's own colour
   * run to the pane's right edge, so the transcript reads as a surface rather
   * than as glyphs floating on whatever the terminal had.
   */
  private inset(lines: string[], width: number): string[] {
    return lines.map((line) => canvasLine(line.length === 0 ? "" : `  ${line}`, width));
  }
}
