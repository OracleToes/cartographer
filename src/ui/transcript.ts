/**
 * The transcript (MINI.md §10a): the only words that reach the person are the
 * agent's `chat` tool calls — plain model text never appears here — alongside
 * the person's own lines and quiet status lines for run/collapse events.
 * State-block markers never appear (the caller filters them upstream).
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
  private entries: TranscriptEntry[] = [];
  private cacheWidth = -1;
  private cacheLines: string[] = [];

  add(entry: TranscriptEntry): void {
    this.entries.push(entry);
    this.cacheWidth = -1;
  }

  reset(): void {
    this.entries = [];
    this.cacheWidth = -1;
  }

  get length(): number {
    return this.entries.length;
  }

  invalidate(): void {
    this.cacheWidth = -1;
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
    if (this.entries.length === 0) {
      lines.push("");
      lines.push(`  ${tokens.bold(tokens.accent("carto"))} ${tokens.muted("— your pair on this project")}`);
      lines.push("");
      lines.push(`  ${tokens.muted("Type to work. The agent's words reach you through chat only.")}`);
      lines.push(`  ${tokens.muted("^o jump · ^p palette · ⇧tab send mode · ^x stop")}`);
      lines.push("");
      this.cacheLines = lines;
      this.cacheWidth = width;
      return lines;
    }
    for (const [index, entry] of this.entries.entries()) {
      if (index > 0) lines.push("");
      if (entry.kind === "person") {
        lines.push(...this.block("you", entry.text, width));
      } else if (entry.kind === "agent") {
        lines.push(...this.block("carto", entry.text, width));
      } else {
        lines.push(...wrapTextWithAnsi(statusLine(entry.text), width));
      }
    }
    lines.push("");
    this.cacheWidth = width;
    this.cacheLines = lines;
    return lines;
  }
}
