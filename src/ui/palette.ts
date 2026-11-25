/**
 * The command palette (§8, Posting's idiom): summoned, never standing.
 *
 * Uses pi-tui's `Input` + `fuzzyFilter` for search and `SelectList` for cursor
 * navigation, paging, scrolling info, and mouse clicks/wheel. Group names and
 * keybindings ride in each item's inline description so every command stays
 * discoverable in one searchable list.
 */
import {
  fuzzyFilter,
  Input,
  matchesKey,
  SelectList,
  type Component,
  type Focusable,
  type SelectItem,
  type SelectListTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { keyText } from "./help-panel.js";
import { padLine, ruleLine, tokens } from "./tokens.js";

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

const MAX_VISIBLE = 9;
/** Header rows rendered above the SelectList: top padding, title, input, rule. */
const HEADER_ROWS = 4;

export class Palette implements Component, Focusable {
  focused = false;
  onClose?: () => void;

  private readonly input = new Input({ prompt: "› ", placeholder: "type a command" });
  private readonly byId: Map<string, PaletteCommand>;
  private list: SelectList;

  constructor(private readonly commands: PaletteCommand[]) {
    this.byId = new Map(commands.map((command) => [command.id, command]));
    this.list = this.buildList("");
    this.input.onSubmit = () => this.runSelected();
    this.input.onEscape = () => this.onClose?.();
  }

  private buildList(query: string): SelectList {
    const matched =
      query.trim().length === 0
        ? [...this.commands]
        : fuzzyFilter(this.commands, query, (command) => `${command.group} ${command.label} ${command.key ?? ""} ${command.hint ?? ""}`);
    const items: SelectItem[] = matched.map((command) => ({
      value: command.id,
      label: command.label,
      description: command.key === undefined ? command.group : `${command.group} · ${keyText(command.key)}`,
    }));
    const list = new SelectList(items, MAX_VISIBLE, selectTheme, {
      minPrimaryColumnWidth: 20,
      maxPrimaryColumnWidth: 34,
    });
    list.onSelect = (item) => {
      this.onClose?.();
      this.byId.get(item.value)?.run();
    };
    list.onCancel = () => this.onClose?.();
    return list;
  }

  private runSelected(): void {
    const item = this.list.getSelectedItem();
    this.onClose?.();
    if (item !== null) this.byId.get(item.value)?.run();
  }

  handleInput(data: string): void {
    this.input.focused = this.focused;
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.list.handleInput("\x1b[A");
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.list.handleInput("\x1b[B");
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      this.list.handleInput(data);
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
    this.list = this.buildList(this.input.getValue());
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y < HEADER_ROWS) return undefined;
    return this.list.handleMouse({ ...event, y: event.y - HEADER_ROWS });
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const inner = width;
    const lines: string[] = [];
    const paint = (line: string) => tokens.panel(padLine(line, inner));
    lines.push(tokens.panel(padLine("", inner)));
    lines.push(paint(`  ${tokens.bold(tokens.text("Commands"))} ${tokens.faint("· enter runs · esc closes")}`));
    lines.push(paint(`  ${this.input.render(Math.max(1, inner - 4)).join("")}`));
    lines.push(tokens.panel(ruleLine(inner)));

    const listWidth = Math.max(1, inner - 2);
    for (const row of this.list.render(listWidth)) {
      lines.push(paint(` ${row}`));
    }
    lines.push(tokens.panel(padLine("", inner)));
    return lines;
  }
}


/** A destructive action requires an explicit typed word, not a selected default. */
export class WipeConfirmation implements Component, Focusable {
  focused = false;
  onClose?: () => void;
  onConfirm?: () => void;
  private readonly input = new Input({ prompt: "> ", placeholder: "type WIPE to confirm" });
  private invalid = false;

  constructor(private readonly project: string) {
    this.input.onEscape = () => this.onClose?.();
    this.input.onSubmit = (value) => {
      if (value === "WIPE") this.onConfirm?.();
      else this.invalid = true;
    };
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) { this.onClose?.(); return; }
    this.input.focused = this.focused;
    this.input.handleInput(data);
  }
  invalidate(): void { this.input.invalidate(); }
  render(width: number): string[] {
    this.input.focused = this.focused;
    const paint = (line: string) => tokens.panel(padLine(`  ${line}`, width));
    return [
      paint(tokens.danger("Permanently wipe this project's Carto session?")),
      paint(`Project: ${this.project}`),
      paint("Deletes all .brain data: Brain, archive, history and project settings."),
      paint("Project files and global config stay. A fresh session opens."),
      paint("Close other Carto instances for this project first."),
      paint("Cannot be undone. Type WIPE and press enter; esc cancels."),
      paint(this.input.render(Math.max(1, width - 4)).join("")),
      ...(this.invalid ? [paint(tokens.danger("Type WIPE exactly, or press esc to cancel."))] : []),
    ];
  }
}
