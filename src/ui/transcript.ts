/**
 * The transcript (MINI.md §10a): the only words that reach the person are the
 * agent's `chat` tool calls — plain model text never appears here — alongside
 * the person's own lines and quiet status lines for run/collapse events.
 *
 * Order is the context's order, not the arrival order of the person's lines:
 * a line shows up where it actually landed in the context (the Brain, and the
 * entries inside it), which is what "live and honest" means for the window.
 * Submitted-but-unplaced lines render after everything, dimmed, labelled
 * queued; they move into place when the run reaches its boundary. State-block
 * markers never appear at all (they are not landed user entries).
 *
 * Nothing here is data — the caller (the workspace) rebuilds the list from
 * the session and the Brain at every drain. The view only renders and
 * flashes, and it can render itself as plain text for `/copy`.
 */
import {
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

import { statusLine, tokens } from "./tokens.js";

export type TranscriptEntry =
  | { kind: "person"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "status"; text: string };

const PREFIX_WIDTH = 7; // "you" / "carto" padded, hanging indent for wrapped lines

export class TranscriptView implements Component {
  private items: TranscriptEntry[] = [];
  private queued: Array<{ text: string; mode: string }> = [];
  private cacheWidth = -1;
  private cacheLines: string[] = [];

  /** Replace the landed list (already in final order) and the queued list (rendered after it). */
  setEntries(entries: TranscriptEntry[], queued: Array<{ text: string; mode: string }> = []): void {
    this.items = [...entries];
    this.queued = [...queued];
    this.cacheWidth = -1;
  }

  /** The landed list as-is, for sealing at a collapse. */
  snapshot(): TranscriptEntry[] {
    return [...this.items];
  }

  reset(): void {
    this.items = [];
    this.queued = [];
    this.cacheWidth = -1;
  }

  get length(): number {
    return this.items.length + this.queued.length;
  }

  invalidate(): void {
    this.cacheWidth = -1;
  }

  /** Plain text of everything currently rendered, for `/copy`. */
  toPlainText(): string {
    const lines: string[] = [];
    for (const entry of this.items) {
      if (entry.kind === "person") lines.push(`you: ${entry.text}`);
      else if (entry.kind === "agent") lines.push(`carto: ${entry.text}`);
      else if (entry.kind === "status") lines.push(`· ${entry.text}`);
    }
    for (const item of this.queued) lines.push(`you (queued): ${item.text}`);
    return lines.join("\n");
  }

  private block(who: "you" | "carto", text: string, width: number): string[] {
    const pad = " ".repeat(Math.max(0, PREFIX_WIDTH - visibleWidth(who)));
    const prefix = tokens.bold(who === "you" ? tokens.accent(who) : tokens.agent(who)) + pad;
    const body = Math.max(1, width - PREFIX_WIDTH);
    const wrapped = wrapTextWithAnsi(text, body);
    const indent = " ".repeat(PREFIX_WIDTH);
    return wrapped.map((line, index) => (index === 0 ? prefix + line : indent + line));
  }

  render(width: number): string[] {
    if (this.cacheWidth === width) return this.cacheLines;
    const lines: string[] = [];
    const total = this.items.length + this.queued.length;
    if (total === 0) {
      lines.push("");
      lines.push(`  ${tokens.bold(tokens.accent("carto"))} ${tokens.muted("— your pair on this project")}`);
      lines.push("");
      lines.push(`  ${tokens.muted("Type to work. The agent's words reach you through chat only.")}`);
      lines.push(`  ${tokens.muted("^o jump · ^p palette · ⇧tab send mode · ^x stop · /help commands")}`);
      lines.push("");
      this.cacheLines = lines;
      this.cacheWidth = width;
      return lines;
    }
    let first = true;
    const gap = () => {
      if (first) first = false;
      else lines.push("");
    };
    for (const entry of this.items) {
      gap();
      if (entry.kind === "person") {
        lines.push(...this.block("you", entry.text, width));
      } else if (entry.kind === "agent") {
        lines.push(...this.block("carto", entry.text, width));
      } else {
        lines.push(...wrapTextWithAnsi(statusLine(entry.text), width));
      }
    }
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
