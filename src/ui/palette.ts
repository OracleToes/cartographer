/**
 * The command palette (§8, Posting's idiom): summoned, never standing.
 *
 * Posting's palette is what makes a keyboard-first app learnable: it lists what
 * the app can do, groups the commands, filters fuzzily as you type, and shows
 * each command's key on the right, so using the palette is also how you learn
 * the keys. Nothing in it is a setting — it is the same actions the keys
 * perform, in one searchable place.
 *
 * One difference from Posting, and it is the point: the selected row is a bar,
 * not a card. Eleven commands should read as a list.
 */
import { fuzzyFilter, Input, matchesKey, type Component, type Focusable, type SelectListTheme } from "@earendil-works/pi-tui";

import { keyText } from "./help-panel.js";
import { padLine, ruleLine, tokens, visibleWidth } from "./tokens.js";

export interface PaletteCommand {
  /** A stable id; the palette never shows it. */
  id: string;
  group: string;
  /** What the command does. For a toggle this is what pressing it does *now*. */
  label: string;
  /** The key that does the same thing, if there is one. */
  key?: string;
  hint?: string;
  run(): void;
}

export const selectTheme: SelectListTheme = {
  selectedPrefix: (text) => tokens.accent(text),
  selectedText: (text) => tokens.bold(tokens.text(text)),
  description: (text) => tokens.muted(text),
  scrollInfo: (text) => tokens.muted(text),
  noMatch: (text) => tokens.muted(text),
};

interface Row {
  command: PaletteCommand;
  heading?: string;
}

const MAX_VISIBLE = 9;

export class Palette implements Component, Focusable {
  focused = false;
  onClose?: () => void;

  private readonly input = new Input({ prompt: "› ", placeholder: "type a command" });
  private filtered: Row[] = [];
  private selected = 0;

  constructor(private readonly commands: PaletteCommand[]) {
    this.filtered = this.rowsFor("");
    this.input.onSubmit = () => this.runSelected();
    this.input.onEscape = () => this.onClose?.();
  }

  /** Group the matches in declaration order, so the list keeps a shape while filtering. */
  private rowsFor(query: string): Row[] {
    const matched =
      query.trim().length === 0
        ? [...this.commands]
        : fuzzyFilter(this.commands, query, (command) => `${command.group} ${command.label} ${command.key ?? ""} ${command.hint ?? ""}`);
    const rows: Row[] = [];
    let lastGroup: string | undefined;
    for (const command of matched) {
      rows.push(command.group === lastGroup ? { command } : { command, heading: command.group });
      lastGroup = command.group;
    }
    return rows;
  }

  private runSelected(): void {
    const row = this.filtered[this.selected];
    this.onClose?.();
    row?.command.run();
  }

  handleInput(data: string): void {
    this.input.focused = this.focused;
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.selected = Math.min(this.filtered.length - 1, this.selected + 1);
      return;
    }
    if (matchesKey(data, "enter")) {
      this.runSelected();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose?.();
      return;
    }
    this.input.handleInput(data);
    this.filtered = this.rowsFor(this.input.getValue());
    this.selected = 0;
  }

  invalidate(): void {
    // Children render fresh each frame.
  }

  render(width: number): string[] {
    const inner = width;
    const lines: string[] = [];
    const paint = (line: string) => tokens.panel(padLine(line, inner));
    lines.push(tokens.panel(padLine("", inner)));
    lines.push(paint(`  ${tokens.bold(tokens.text("Commands"))} ${tokens.faint("· enter runs · esc closes")}`));
    lines.push(paint(`  ${this.input.render(inner - 4).join("")}`));
    lines.push(tokens.panel(ruleLine(inner)));

    if (this.filtered.length === 0) {
      lines.push(paint(`  ${tokens.faint("nothing matches")}`));
    }
    const start = Math.max(0, Math.min(this.selected - MAX_VISIBLE + 1, this.filtered.length - MAX_VISIBLE));
    const visible = this.filtered.slice(start, start + MAX_VISIBLE);
    visible.forEach((row, offset) => {
      const index = start + offset;
      const selected = index === this.selected;
      if (row.heading !== undefined) {
        lines.push(paint(`  ${tokens.faint(tokens.bold(row.heading.toUpperCase()))}`));
      }
      const key = row.command.key === undefined ? "" : keyText(row.command.key);
      const left = `  ${selected ? tokens.accent("▸") : " "} ${row.command.label}`;
      const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(key) - 3);
      const line = `${left}${" ".repeat(gap)}${tokens.faint(key)} `;
      lines.push(selected ? tokens.selectedBg(padLine(line, inner)) : paint(line));
    });
    if (this.filtered.length > MAX_VISIBLE) {
      lines.push(paint(`  ${tokens.faint(`${this.selected + 1} of ${this.filtered.length}`)}`));
    }
    lines.push(tokens.panel(padLine("", inner)));
    return lines;
  }
}
