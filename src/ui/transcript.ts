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
 *   — is a **card**, and a card has three states: one line folded, open, and
 *   full. Open is a body with a window on it; full is the whole body and no
 *   window. It is in its own hue and quieter than Chat. A card that is
 *   streaming stays open on the last lines of what is arriving — a card you are
 *   watching is the end of it — and the moment the round lands it folds to its
 *   header.
 * - **Stop-reason lines** are a faint middot and a sentence attached to the
 *   current model work. UI notifications use pi's transient flash instead.
 *
 * **A click on the header folds or opens a card.** When its body is too long
 * for the preview, a click on the body or `⋯ n lines …` rule shows it in full;
 * another body click returns to the preview. A click on a Chat block toggles its
 * pin, `ctrl+e` folds every card in view, and the wheel belongs to the page —
 * the one scrolling owner (§8) — so scrolling up simply stops following the tail.
 *
 * The three states are not decoration: open is a window on a body, so a very
 * long result stays readable inline without pushing the transcript off the
 * screen, and full is the same card with nothing held back.
 *
 * **Every row carries its handle** (§5.4): a person's line its `U`, a card the
 * `X` of the item it renders, a tool row the `R` or `S` of the result it shows —
 * the text a person quotes and a pin holds. The number is the Context view's
 * number, because the two views are one prompt seen two ways.
 *
 * Order is the context's order, not arrival order: a person's line appears
 * where it actually landed, and a line that is submitted but not yet placed sits
 * at the end, dimmed and labelled, until the run reaches a boundary. Chat a
 * collapse brought into the new context is placed by when it was said, so it
 * sits at the head of this generation and the transcript before it stays under
 * it rather than being replaced.
 *
 * Nothing here is data: the workspace rebuilds the landed list from the session
 * and the Brain at every drain and pushes the in-flight partial separately.
 */
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";

import type { Mark, PinnedEphemeral } from "../domain/records.js";
import { canvasLine, statusLine, statusWarnLine, tokens } from "./tokens.js";
import { RecordControls, type RecordAction } from "./record-controls.js";

/**
 * What a selected block is, in the Context view's own terms (`part`, `id`), so
 * a key pressed here is the same act as the key on that view's row: a Chat
 * block is its Brain record, a card is the ephemeral item it renders.
 */
export type BlockTarget = { part: "chat" | "tool-work"; id: string };

/** A block the keys can select: where it was drawn, and what it is. */
type Selectable = { key: string; target: BlockTarget; start: number; end: number };

type CardBase = {
  /** Stable across rebuilds while it lives: `ctx-<entryId>-<part>` landed, `live-<attempt>-<part>` in flight. */
  id: string;
  /** The prompt's ephemeral handle (§5.4): `X3` for one item, or the call's own handle on its result. */
  handle?: string;
  /** True while fed from the live partial: defaults its fold open and is replaced when the round lands. */
  live?: boolean;
  /** Live tool status, from the live round's slot; absent when landed. */
  status?: "pending" | "running" | "done";
  /** Landed tool calls whose result came back as an error. */
  failed?: boolean;
  /** Stable Context identities for the call/part and its result, if any. */
  sourceId?: string;
  resultId?: string;
};
export type CardEntry =
  | (CardBase & { kind: "reasoning"; text: string })
  | (CardBase & { kind: "output"; text: string })
  | (CardBase & { kind: "tool"; name: string; args: string; /** Retained running output while the call executes; preferred as the card body when present. */ output?: string });

export type TranscriptEntry =
  | { kind: "person"; text: string; /** The prompt's `U` handle (§5.4). */ handle?: string; /** The Brain Chat record this line is, once it has one (§2.3). */ recordId?: string; mark?: Mark | undefined }
  | { kind: "agent"; text: string; /** The Brain chat record this block is a rendering of; omitted for boot-burst text. */ recordId?: string; /** The record's handle (§5.4). A Chat record survives a collapse, so its handle is the Brain's own. */ handle?: string; /** A pending Brain action, not historical transcript content. */ mark?: Mark | undefined }
  | { kind: "status"; text: string; tone?: "warn" }
  | CardEntry;

export const isCard = (entry: TranscriptEntry): entry is CardEntry =>
  entry.kind === "reasoning" || entry.kind === "output" || entry.kind === "tool";

/** Retain dialogue and only the work that actually survived a collapse. */
export function retainAfterCollapse(entries: readonly TranscriptEntry[], pins: readonly PinnedEphemeral[]): TranscriptEntry[] {
  const held = new Map(pins.filter((item) => item.pinned !== undefined).map((item) => [item.id, item]));
  const seenChat = new Set<string>();
  const retained: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "person") {
      // U handles belong to the old generation, not to historical dialogue.
      retained.push({ kind: "person", text: entry.text });
    } else if (entry.kind === "agent") {
      if (entry.recordId !== undefined && seenChat.has(entry.recordId)) continue;
      if (entry.recordId !== undefined) seenChat.add(entry.recordId);
      retained.push(entry);
    } else if (isCard(entry)) {
      const part = entry.sourceId === undefined ? undefined : held.get(entry.sourceId);
      const result = entry.resultId === undefined ? undefined : held.get(entry.resultId);
      if (part === undefined && result === undefined) continue;
      // A tool row combines a call and a result. If only one was pinned, do
      // not leak the swept half back into the transcript or its copied text.
      if (entry.kind === "tool") {
        const { handle: _handle, output: _output, failed: _failed, ...card } = entry;
        retained.push({ ...card, id: `retained-${entry.sourceId ?? entry.resultId}`, args: part === undefined ? "" : entry.args, ...(result === undefined ? {} : { output: result.text, ...(entry.failed === undefined ? {} : { failed: entry.failed }) }) });
      } else if (part !== undefined) {
        const { handle: _handle, ...card } = entry;
        retained.push({ ...card, id: `retained-${entry.sourceId}`, text: part.text });
      }
    }
  }
  return retained;
}

/** Deliver UI status through pi's flash, suppressing rapid identical repeats. */
export function createStatusNotifier(flash: (message: string, durationMs: number) => void, now: () => number = Date.now): (message: string) => void {
  let last: { message: string; at: number } | undefined;
  const duration = 3_000;
  return (message) => {
    const at = now();
    if (last?.message === message && at - last.at >= 0 && at - last.at < duration) return;
    last = { message, at };
    flash(message, duration);
  };
}

/** Spine, gap, then a six-cell label column; the body starts here and every continuation lines up under it. */
const LABEL_WIDTH = 6;
const PREFIX_WIDTH = LABEL_WIDTH + 2;
/** The body's left margin, added to every line after it is built. Text must fit inside it. */
const INSET = 2;
const SPINE = "▌";
const GUTTER = "│ ";
/** How many lines of a streaming card are on screen while it is arriving. */
const LIVE_TAIL = 8;
/**
 * How much of an open card is on screen before it asks to be opened fully. A
 * card that is open is read, not skimmed, so the window is generous; past it
 * the card is a window on a body, and `full` is the page.
 */
const OPEN_WINDOW = 24;

/** Where a card drew, and which of its rows is the header and which the hidden-lines rule. */
interface CardRange {
  id: string;
  start: number;
  end: number;
  /** The header row: a click here folds or opens the card. */
  header: number;
  /** The `⋯ n earlier lines` row, when the window is hiding some: a click here shows them. */
  more?: number;
}

/**
 * How much of a card is on screen. A fold is one line; openness is not a
 * boolean, because a long result needs a page and a short one does not, and
 * neither needs to throw the transcript's order away.
 */
type CardView = "folded" | "open" | "full";

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

export class TranscriptView implements Component, Focusable {
  /** Set by the TUI when focus moves here: the block cursor takes the keys while it does. */
  focused = false;
  private items: TranscriptEntry[] = [];
  private queued: Array<{ text: string; mode: string }> = [];
  private liveCards: CardEntry[] = [];
  private views = new Map<string, CardView>();
  private wrapMemo = new Map<string, WrapMemo>();
  private ranges: CardRange[] = [];
  private selectables: Selectable[] = [];
  private cacheWidth = -1;
  private cacheLines: string[] = [];
  private lastWidth = 80;
  private selecting = false;
  private cursorKey: string | undefined;
  private cursorIndex = 0;
  /** The first archive press on an ephemeral card is a confirmation, as in the Context view. */
  private archiveConfirmation: string | undefined;
  /** The same four marks every other view has; one class holds `!`'s arming. */
  readonly controls = new RecordControls();

  /** `p` on the selected card (same signature as the Context view's); a Chat block has no pin. */
  onTogglePin?: (part: BlockTarget["part"], id: string) => void;
  onArchive?: (part: BlockTarget["part"], id: string, now: boolean) => void;
  onDelete?: (part: BlockTarget["part"], id: string, now: boolean) => void;
  onWithdrawMark?: (part: BlockTarget["part"], id: string) => void;
  /** Leave block selection (the host hands focus back to the prompt). */
  onLeave?: () => void;
  /** Keep the selected block on screen: the host scrolls its pane to these lines. */
  onReveal?: (start: number, end: number) => void;

  constructor(private readonly options: { project?: string } = {}) {
    this.controls.onMark = (key, action, now) => this.markBlock(key, action, now);
    this.controls.onWithdraw = (key) => {
      const target = this.selectables.find((block) => block.key === key)?.target;
      if (this.archiveConfirmation === key) this.archiveConfirmation = undefined;
      else if (target !== undefined) this.onWithdrawMark?.(target.part, target.id);
      this.cacheWidth = -1;
    };
  }

  /** True while a block is selected and the keys are the block's. */
  isSelecting(): boolean {
    return this.selecting;
  }

  /** Select the last block, the one nearest the prompt. False when there is nothing to select. */
  startSelecting(): boolean {
    this.render(this.lastWidth);
    const last = this.selectables.at(-1);
    if (last === undefined) return false;
    this.selecting = true;
    this.cursorKey = last.key;
    this.cursorIndex = this.selectables.length - 1;
    this.cacheWidth = -1;
    this.reveal();
    return true;
  }

  stopSelecting(): void {
    this.selecting = false;
    this.cursorKey = undefined;
    this.archiveConfirmation = undefined;
    if (this.controls.nowArmed) this.controls.toggleApplyNow();
    this.cacheWidth = -1;
  }

  /** The id the keys act on: the selected block's key. */
  selectedKey(): string | undefined {
    return this.selecting ? this.cursorKey : undefined;
  }

  private selectedBlock(): Selectable | undefined {
    return this.selectables.find((block) => block.key === this.cursorKey);
  }

  private moveCursor(to: number): void {
    if (this.selectables.length === 0) return;
    const index = Math.max(0, Math.min(this.selectables.length - 1, to));
    this.cursorIndex = index;
    this.cursorKey = this.selectables[index]?.key;
    this.archiveConfirmation = undefined;
    this.cacheWidth = -1;
    this.render(this.lastWidth);
    this.reveal();
  }

  private reveal(): void {
    const block = this.selectedBlock();
    if (block !== undefined) this.onReveal?.(block.start, block.end);
  }

  /** Which kind of thing is selected: only a card (an ephemeral item) can be pinned. */
  selectedPart(): BlockTarget["part"] | undefined {
    return this.selecting ? this.selectedBlock()?.target.part : undefined;
  }

  /** Pin or unpin the selected card, the act `p` performs; the palette calls this. */
  pinSelected(): void {
    const target = this.selectedBlock()?.target;
    if (target?.part === "tool-work") this.onTogglePin?.(target.part, target.id);
  }

  /** Mark the selected block, the act `a` and `d` perform; the palette calls this. */
  markSelected(action: RecordAction): void {
    this.controls.mark(this.cursorKey, action);
  }

  withdrawSelected(): void {
    this.controls.withdraw(this.cursorKey);
  }

  toggleApplyNow(): boolean {
    const armed = this.controls.toggleApplyNow();
    this.cacheWidth = -1;
    return armed;
  }

  /**
   * A mark waits for the collapse unless `!` armed it. An ephemeral card
   * archives at once but asks first, like the Context view's rows: the first
   * `a` is a confirmation (the block turns red), the second archives.
   */
  private markBlock(key: string, action: RecordAction, now: boolean): void {
    const target = this.selectables.find((block) => block.key === key)?.target;
    if (target === undefined) return;
    const ephemeral = target.part === "tool-work";
    if (ephemeral && action === "archive" && !now && this.archiveConfirmation !== key) {
      this.archiveConfirmation = key;
      this.cacheWidth = -1;
      return;
    }
    this.archiveConfirmation = undefined;
    if (action === "archive") this.onArchive?.(target.part, target.id, ephemeral || now);
    else this.onDelete?.(target.part, target.id, now);
    this.cacheWidth = -1;
  }

  /**
   * Block selection. The marks and `p` come through the command registry like
   * every view's; what is left here is moving the cursor and leaving, on the
   * same keys the Context view uses.
   */
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
      this.onLeave?.();
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "up")) this.moveCursor(this.cursorIndex - 1);
    else if (matchesKey(data, "j") || matchesKey(data, "down")) this.moveCursor(this.cursorIndex + 1);
    else if (matchesKey(data, "g")) this.moveCursor(0);
    else if (data === "G") this.moveCursor(this.selectables.length - 1);
  }

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
    this.views.clear();
    this.wrapMemo.clear();
    this.cacheWidth = -1;
  }

  get length(): number {
    return this.items.length + this.liveCards.length + this.queued.length;
  }

  invalidate(): void {
    this.cacheWidth = -1;
  }

  /**
   * Every card deepens one step, or every card folds when any of them is more
   * than folded. One key for "show me the working", pressed again to put it
   * back.
   */
  toggleAllCards(): void {
    const ids = this.cardIds();
    if (ids.length === 0) return;
    const anyOpen = ids.some((id) => {
      const card = this.cardById(id);
      return card !== undefined && this.viewOf(card) !== "folded";
    });
    for (const id of ids) this.views.set(id, anyOpen ? "folded" : "open");
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

  /**
   * The state a card is in. A card in flight opens by itself — you are watching
   * it arrive — and a card that has landed starts folded, because the transcript
   * is read for what it said, not for every argument it passed.
   */
  private viewOf(card: CardEntry): CardView {
    return this.views.get(card.id) ?? (card.live === true ? "open" : "folded");
  }

  private pruneState(): void {
    const present = new Set(this.cardIds());
    for (const id of [...this.views.keys()]) if (!present.has(id)) this.views.delete(id);
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
  private block(who: "you" | "carto", text: string, width: number, handle?: string, extra?: string): string[] {
    const tint = who === "you" ? tokens.person : tokens.agent;
    const label = who === "you" ? "you" : "carto";
    const marker = [
      handle === undefined || handle.length === 0 ? "" : tokens.faint(handle),
      extra === undefined || extra.length === 0 ? "" : tokens.pin(extra),
    ]
      .filter((part) => part.length > 0)
      .map((part) => ` ${part}`)
      .join("");
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

  private cardHeader(card: CardEntry, width: number, view: CardView): string {
    const tint = kindTint(card);
    // A caret opens or folds the card; the full glyph marks its deeper body.
    const glyph = view === "folded" ? "▸" : view === "open" ? "▾" : "⇣";
    const labelText = kindLabel(card);
    const label = tint(tokens.bold(labelText));
    const gap = " ".repeat(Math.max(1, 6 - labelText.length)); // the label column: thinking/text/tool …
    // The handle rides the header like every other row in the prompt (§5.4):
    // three cells of faint type, so the column lines up down the transcript.
    const handle = card.handle === undefined ? "" : `${tokens.faint(card.handle.padEnd(3))} `;
    const keyPrefix = `  ${handle}${tint(glyph)} ${label}`;

    const marks: string[] = [];
    if (card.failed === true) marks.push(tokens.danger("· failed"));
    else if (card.status === "running") marks.push(tokens.faint("· running"));
    else if (card.status === "pending") marks.push(tokens.faint("· queued"));

    if (view !== "folded") {
      const tail = marks.length > 0 ? ` ${marks.join(" ")}` : "";
      const depth = view === "full" ? ` ${tokens.faint("· full")}` : "";
      return `${keyPrefix}${depth}${tail}`;
    }
    const summary = card.kind === "tool"
      ? (card.args.trim().length > 0 ? oneLine(card.args) : "")
      : firstLine(card.text);
    const room = Math.max(1, width - visibleWidth(keyPrefix) - gap.length - 2);
    const preview = truncateToWidth(summary.length === 0 ? "…" : summary, room, "…");
    const tail = marks.length > 0 ? ` ${marks.join(" ")}` : "";
    return `${keyPrefix}${gap}${tokens.muted(preview)}${tail}`;
  }

  /**
   * One card, and where each of its rows landed. A card in flight keeps a
   * window on the end of what is arriving; the rule that counts the hidden
   * lines is the control that shows them, so the count is never a dead end.
   */
  private renderCard(card: CardEntry, width: number, start: number): { lines: string[]; range: CardRange } {
    const view = this.viewOf(card);
    const lines = [this.cardHeader(card, width, view)];
    const range: CardRange = { id: card.id, start, end: start, header: start };
    if (view === "folded") {
      range.end = start + 1;
      return { lines, range };
    }
    const body = this.wrapBody(card, width);
    const total = body.length;
    const indent = " ".repeat(PREFIX_WIDTH - 2);
    const gutter = tokens.rule(GUTTER);
    const paint = (line: string): string =>
      card.kind === "reasoning" ? tokens.reasoning(line) : card.kind === "output" ? tokens.output(line) : tokens.text(line);
    // A card in flight keeps a window on the end of what is arriving — that is
    // where the words are. A card that has landed is read from its start, and
    // past the open window it keeps a head and asks to be opened fully. Either
    // way the rule that counts the hidden lines is the control that shows them,
    // and `full` is the page with no window on it at all.
    const shown = card.live === true ? LIVE_TAIL : OPEN_WINDOW;
    const windowed = view !== "full" && total > shown;
    if (windowed) {
      const hidden = total - shown;
      range.more = lines.length + start;
      lines.push(
        `${indent}${gutter}${tokens.faint(`⋯ ${hidden} line${hidden === 1 ? "" : "s"} ${card.live === true ? "earlier" : "more"} · click to show`)}`,
      );
      const kept = card.live === true ? body.slice(total - shown) : body.slice(0, shown);
      for (const line of kept) lines.push(`${indent}${gutter}${paint(line)}`);
    } else {
      for (const line of body) lines.push(`${indent}${gutter}${paint(line)}`);
    }
    range.end = start + lines.length;
    return { lines, range };
  }

  private rangeAt(y: number): CardRange | undefined {
    return this.ranges.find((range) => y >= range.start && y < range.end);
  }

  /**
   * The header folds or opens a card. The body (including the hidden-lines
   * rule) toggles a long card between preview and full. A click never pins or
   * marks: those are keys, on a selected block. The wheel stays the page's.
   */
  handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent): import("@earendil-works/pi-tui").TuiMouseEventResult | undefined {
    const cardRange = this.rangeAt(event.y);
    if (cardRange === undefined) return undefined;

    if (event.type === "press") return { handled: true };
    if (event.type === "click") {
      const card = this.cardById(cardRange.id);
      if (card === undefined) return undefined;
      const view = this.viewOf(card);
      if (event.y === cardRange.header) {
        this.views.set(card.id, view === "folded" ? "open" : "folded");
      } else if (view === "full") {
        this.views.set(card.id, "open");
      } else if (cardRange.more !== undefined) {
        this.views.set(card.id, "full");
      } else {
        // A short preview already shows everything: there is no full view to
        // expand to, and a body tap must not collapse it.
        return { handled: true };
      }
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
    this.lastWidth = width;
    const lines: string[] = [];
    const total = this.items.length + this.liveCards.length + this.queued.length;
    this.ranges = [];
    this.selectables = [];
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
      const drawn = this.renderCard(card, width, start);
      lines.push(...drawn.lines);
      this.ranges.push(drawn.range);
      // A card in flight is not an item anything holds yet; a landed one is the
      // ephemeral item its source id names (the result's, for a tool row).
      const id = card.live === true ? undefined : (card.resultId ?? card.sourceId);
      if (id !== undefined) this.selectables.push({ key: `card:${card.id}`, target: { part: "tool-work", id }, start, end: lines.length });
    };
    for (const entry of this.items) {
      if (isCard(entry)) {
        pushCard(entry);
        continue;
      }
      gap();
      if (entry.kind === "person" || entry.kind === "agent") {
        const start = lines.length;
        lines.push(...this.block(entry.kind === "person" ? "you" : "carto", entry.text, width, entry.handle));
        if (entry.mark !== undefined) {
          const mark = `◆ ${entry.mark.action} on collapse · ${entry.mark.author === "user" ? "you" : "agent"}`;
          for (const line of wrapTextWithAnsi(mark, Math.max(1, width - INSET - PREFIX_WIDTH))) {
            lines.push(`${" ".repeat(PREFIX_WIDTH)}${tokens.warn(line)}`);
          }
        }
        if (entry.recordId !== undefined) {
          this.selectables.push({ key: `chat:${entry.recordId}`, target: { part: "chat", id: entry.recordId }, start, end: lines.length });
        }
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
    this.cacheLines = this.inset(lines, width, this.cursorLines());
    return this.cacheLines;
  }

  /**
   * The lines of the selected block, so the page can mark them. A block that has
   * gone from the list (deleted, archived) leaves the cursor on its neighbour.
   */
  private cursorLines(): { start: number; end: number } | undefined {
    if (!this.selecting) return undefined;
    let at = this.selectables.findIndex((block) => block.key === this.cursorKey);
    if (at === -1) at = Math.min(this.cursorIndex, this.selectables.length - 1);
    const block = this.selectables[at];
    if (block === undefined) return undefined;
    this.cursorKey = block.key;
    this.cursorIndex = at;
    return block;
  }

  /**
   * The body breathes: a left margin on every line, and the page's own colour
   * run to the pane's right edge, so the transcript reads as a surface rather
   * than as glyphs floating on whatever the terminal had.
   */
  private inset(lines: string[], width: number, selected?: { start: number; end: number }): string[] {
    const armed = selected !== undefined && this.archiveConfirmation === this.cursorKey;
    return lines.map((line, index) => {
      if (line.length === 0) return canvasLine("", width);
      // The cursor is a bar in the margin, red when the next key archives.
      const inside = selected !== undefined && index >= selected.start && index < selected.end;
      const margin = inside ? `${armed ? tokens.danger("▌") : tokens.accent("▌")} ` : "  ";
      return canvasLine(`${margin}${line}`, width);
    });
  }
}
