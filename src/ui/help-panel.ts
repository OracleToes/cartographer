/**
 * The keyboard-shortcuts panel (§8, Posting's `f1`).
 *
 * Posting answers "what can I press here?" with a scrollable modal that lists
 * every binding in effect, grouped, with the keys in one column and the verb in
 * another. It is the long form of the footer, drawn from the same registry, so
 * it is never a document that has to be kept in step by hand.
 *
 * Ours also carries the two things that are not keystrokes: the commands'
 * palette-only entries, and the slash commands that still exist for typing
 * (`/copy` and friends). A person should never have to read source to find out
 * what the app can do.
 */
import { matchesKey, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";

import type { Command } from "./commands.js";
import { padLine, tokens } from "./tokens.js";

export interface HelpExtra {
  group: string;
  key: string;
  label: string;
}

const HINT_WIDTH = 18;

export class HelpPanel implements Component, Focusable {
  focused = false;
  onClose?: () => void;
  private offset = 0;

  constructor(
    private readonly commands: readonly Command[],
    private readonly extras: () => HelpExtra[],
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "f1") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      this.onClose?.();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) this.offset = Math.max(0, this.offset - 1);
    if (matchesKey(data, "down") || matchesKey(data, "j")) this.offset += 1;
    if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+b")) this.offset = Math.max(0, this.offset - 10);
    if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+f")) this.offset += 10;
  }

  invalidate(): void {
    // Stateless.
  }

  render(width: number): string[] {
    const inner = Math.max(30, Math.min(width, 84));
    const body: string[] = [];
    body.push(padLine(` ${tokens.bold(tokens.text("Keyboard shortcuts"))} ${tokens.faint("· f1 or esc closes")}`, inner));
    body.push(padLine("", inner));

    // Grouped by name, in the order the groups first appear: the registry is
    // written screen by screen, but a person reads the panel group by group.
    const rows: Array<{ group?: string; key: string; label: string; hint?: string }> = [];
    const order: string[] = [];
    for (const command of this.commands) if (!order.includes(command.group)) order.push(command.group);
    for (const group of order) {
      rows.push({ group, key: "", label: "" });
      for (const command of this.commands) {
        if (command.group !== group) continue;
        const key = command.key === undefined ? "" : keyText(command.key);
        rows.push({ key, label: command.label, ...(command.hint === undefined ? {} : { hint: command.hint }) });
      }
    }
    const extraGroup = this.extras();
    if (extraGroup.length > 0) {
      rows.push({ group: "type it", key: "", label: "" });
      for (const extra of extraGroup) rows.push({ key: extra.key, label: extra.label });
    }

    const visible = rows.slice(this.offset);
    for (const row of visible) {
      if (row.group !== undefined) {
        body.push(padLine(`  ${tokens.faint(tokens.bold(row.group.toUpperCase()))}`, inner));
        continue;
      }
      const key = row.key.padEnd(HINT_WIDTH);
      const label = row.hint === undefined ? tokens.text(row.label) : `${tokens.text(row.label)}  ${tokens.faint(`(${row.hint})`)}`;
      const widthLimit = Math.max(8, inner - 4 - HINT_WIDTH);
      const wrapped = wrapTextWithAnsi(label, widthLimit);
      const indent = " ".repeat(HINT_WIDTH);
      wrapped.forEach((line, index) => {
        const lead = index === 0 ? tokens.accent(key) : indent;
        body.push(padLine(`  ${lead}${line}`, inner));
      });
    }
    return body.map((line) => tokens.panel(line));
  }
}

/** A key as it is spelled on a keycap: the modifier glyphs Posting uses, and nothing clever. */
export function keyText(key: string): string {
  return key
    .replace(/^ctrl\+/, "^")
    .replace(/^shift\+tab$/, "⇧⇥")
    .replace(/^alt\+/, "⌥")
    .replace(/^super\+/, "⌘");
}
