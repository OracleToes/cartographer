/**
 * The transcript (MINI.md §8, §10a as re-scoped 2026-11-20): everything the
 * agent does is visible — its Chat words, its reasoning, its plain model
 * text, and its tool calls — alongside the person's own lines and quiet
 * status lines. Chat remains the only channel that addresses the person; the
 * rest renders as foldable cards, dimmer and in their own hues, never
 * mistaken for Chat.
 *
 * The cards are the working's window: while the model streams, a card shows
 * the live tail in a limited-height window (8 lines); when the run settles,
 * the landed assistant entry renders as the same cards, folded by default.
 * A card folds to its header — a click on it (or `ctrl+e` for all of them)
 * toggles it back. An open LANDED card emits every retained row into the
 * page — the one scrolling owner is the page (MINI.md §8); the wheel is the
 * page's everywhere, so scrolling up suspends the tail-follow and the person
 * scrolls the rest themselves. An open LIVE card keeps the bounded tail: a
 * growing stream must stay bounded or the page could not keep up with it.
 * Landed cards default folded; cards from the in-flight partial default open,
 * so streaming is always watchable and settle folds everything automatically.
 *
 * Order is the context's order, not the arrival order of the person's lines:
 * a line shows up where it actually landed in the context (the Brain, and the
 * entries inside it), which is what "live and honest" means for the window.
 * Submitted-but-unplaced lines render after everything, dimmed, labelled
 * queued; they move into place when the run reaches its boundary. State-block
 * markers never appear at all (they are not landed user entries).
 *
 * Nothing here is data — the caller (the workspace) rebuilds the landed list
 * from the session and the Brain at every drain, and pushes the in-flight
 * partial separately with `setLive`. The view only renders, folds, and
 * flashes, and it can render itself as plain text for `/copy`.
 */
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

import { pinBadgeText, statusLine, statusWarnLine, tokens } from "./tokens.js";

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

const PREFIX_WIDTH = 7; // matches the person/agent blocks; gutter column starts here
const LIVE_TAIL = 8; // lines an in-flight card shows; a settled open card emits every retained row
const GUTTER = "│ ";

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

const kindLabel = (card: CardEntry): string => (card.kind === "reasoning" ? "think" : card.kind === "output" ? "text" : "tool");
const kindColor = (card: CardEntry): ((text: string) => string) =>
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
  if (isRecord(args)) {
    return formatObjectArgs(args);
  }
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
    const anyOpen = ids.some((id) => this.isExpanded(this.cardById(id)!));
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
      else if (entry.kind === "reasoning") lines.push(`think: ${entry.text}`);
      else if (entry.kind === "output") lines.push(`text: ${entry.text}`);
      else lines.push(`tool ${entry.name}`, ...(entry.output ?? entry.args).split("\n").map((line) => `  ${line}`));
    }
    for (const card of this.liveCards) {
      if (card.kind === "reasoning") lines.push(`think: ${card.text}`);
      else if (card.kind === "output") lines.push(`text: ${card.text}`);
      else lines.push(`tool ${card.name}`, ...(card.output ?? card.args).split("\n").map((line) => `  ${line}`));
    }
    for (const item of this.queued) lines.push(`you (queued): ${item.text}`);
    return lines.join("\n");
  }

  private block(who: "you" | "carto", text: string, width: number, extra?: string): string[] {
    const pad = " ".repeat(Math.max(0, PREFIX_WIDTH - visibleWidth(who)));
    const prefix = tokens.bold(who === "you" ? tokens.accent(who) : tokens.agent(who)) + pad;
    const body = Math.max(1, width - PREFIX_WIDTH);
    const wrapped = wrapTextWithAnsi(text, body);
    const indent = " ".repeat(PREFIX_WIDTH);
    const marker = extra !== undefined && extra.length > 0 ? ` ${extra}` : "";
    return wrapped.map((line, index) => (index === 0 ? prefix + line + marker : indent + line));
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
    const glyph = expanded ? "▾" : "▸";
    const isTool = card.kind === "tool";
    const labelText = isTool && card.name ? `tool ${card.name}` : kindLabel(card);
    const label = kindColor(card)(tokens.bold(labelText));
    const pad = " ".repeat(Math.max(1, PREFIX_WIDTH - visibleWidth(labelText)));
    const marks: string[] = [];
    if (card.status !== undefined && expanded) marks.push(tokens.muted(`· ${card.status}`));
    if (card.failed === true) marks.push(tokens.danger(tokens.bold("· failed")));
    if (expanded) return `${label}${pad}${glyph}${marks.length > 0 ? ` ${marks.join(" ")}` : ""}`;
    const summary = isTool
      ? (card.args.trim().length > 0 ? `${card.name}(${oneLine(card.args)})` : card.name)
      : firstLine(card.text);
    const preview = truncateToWidth(summary.length === 0 ? "…" : summary, Math.max(1, width - PREFIX_WIDTH - 2), "…");
    if (card.status !== undefined) marks.push(tokens.muted(`· ${card.status}`));
    return `${label}${pad}${glyph}${tokens.muted(" ")}${tokens.muted(preview)}${marks.length > 0 ? ` ${marks.join(" ")}` : ""}`;
  }

  private renderCard(card: CardEntry, width: number): string[] {
    const expanded = this.isExpanded(card);
    const lines = [this.cardHeader(card, width, expanded)];
    if (!expanded) return lines;
    const body = this.wrapBody(card, width);
    const total = body.length;
    const indent = " ".repeat(PREFIX_WIDTH);
    if (card.live === true && total > LIVE_TAIL) {
      lines.push(`${indent}${tokens.muted(GUTTER)}${tokens.muted(`⋯ ${total - LIVE_TAIL} earlier lines — bounded while it streams`)}`);
      for (const line of body.slice(total - LIVE_TAIL)) {
        lines.push(`${indent}${tokens.muted(GUTTER)}${line}`);
      }
      return lines;
    }
    for (const line of body) {
      lines.push(`${indent}${tokens.muted(GUTTER)}${line}`);
    }
    return lines;
  }

  private rangeAt(y: number): CardRange | undefined {
    return this.ranges.find((range) => y >= range.start && y < range.end);
  }

  /** A click folds or unfolds a card; a click on an agent block toggles its record's pin; the wheel is never consumed here — the page owns it (scrolling up suspends the tail-follow; the person scrolls themselves). */
  handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent): import("@earendil-works/pi-tui").TuiMouseEventResult | undefined {
    const cardRange = this.rangeAt(event.y);
    const block = this.blockRanges.find((range) => event.y >= range.start && event.y < range.end);
    if (cardRange === undefined && block === undefined) return undefined;

    if (event.type === "press") {
      return { handled: true };
    }
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

  render(width: number): string[] {
    if (this.cacheWidth === width) return this.cacheLines;
    const lines: string[] = [];
    const total = this.items.length + this.liveCards.length + this.queued.length;
    this.ranges = [];
    this.blockRanges = [];
    if (total === 0) {
      lines.push("");
      lines.push(`  ${tokens.bold(tokens.accent("carto"))} ${tokens.muted("— your pair on this project")}`);
      lines.push(`  ${tokens.muted("Type to work. The agent speaks through chat;")}`);
      lines.push(`  ${tokens.muted("its reasoning and tool calls render as foldable cards.")}`);
      lines.push("");
      lines.push(`  ${tokens.muted("^o jump · ^p palette · ⇧tab send mode · ^x stop · ^e fold cards")}`);
      lines.push(`  ${tokens.muted("/help lists the commands")}`);
      this.cacheLines = lines;
      this.cacheWidth = width;
      return lines;
    }
    let first = true;
    const gap = () => {
      if (first) first = false;
      else lines.push("");
    };
    const pushCard = (card: CardEntry) => {
      gap();
      const start = lines.length;
      const rendered = this.renderCard(card, width);
      lines.push(...rendered);
      this.ranges.push({ id: card.id, start, end: lines.length });
    };
    for (const entry of this.items) {
      if (isCard(entry)) pushCard(entry);
      else {
        gap();
        if (entry.kind === "person") {
          lines.push(...this.block("you", entry.text, width));
        } else if (entry.kind === "agent") {
          const start = lines.length;
          const pinStr = entry.pinned !== undefined && entry.pinned !== null ? pinBadgeText(entry.pinned, "pin") : "";
          lines.push(...this.block("carto", entry.text, width, pinStr.length > 0 ? pinStr : undefined));
          if (entry.recordId !== undefined) this.blockRanges.push({ id: entry.recordId, start, end: lines.length });
        } else {
          lines.push(...wrapTextWithAnsi(entry.tone === "warn" ? statusWarnLine(entry.text) : statusLine(entry.text), width));
        }
      }
    }
    for (const card of this.liveCards) pushCard(card);
    for (const item of this.queued) {
      gap();
      lines.push(...wrapTextWithAnsi(tokens.muted(tokens.italic(`you ⏛ ${item.text} (${item.mode === "after run" ? "after the run" : "queued"} — lands at the boundary)`)), width));
    }
    lines.push("");
    this.cacheWidth = width;
    this.cacheLines = lines;
    return lines;
  }
}
