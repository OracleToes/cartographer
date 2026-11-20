/**
 * The command palette (Posting's idiom, MINI.md §8: no permanent palette —
 * it is summoned, never standing). A summoned overlay: type to filter,
 * arrows to choose, enter to run, esc to leave. Everything not on a key
 * lives here.
 */
import {
  Box,
  Input,
  matchesKey,
  SelectList,
  Text,
  type Component,
  type Focusable,
  type SelectListTheme,
} from "@earendil-works/pi-tui";

import { tokens } from "./tokens.js";

export interface PaletteCommand {
  value: string;
  label: string;
  hint?: string;
  run(): void;
}

export const selectTheme: SelectListTheme = {
  selectedPrefix: (text) => tokens.accent(text),
  selectedText: (text) => tokens.bold(tokens.accent(text)),
  description: (text) => tokens.muted(text),
  scrollInfo: (text) => tokens.muted(text),
  noMatch: (text) => tokens.muted(text),
};

export class Palette implements Component, Focusable {
  focused = false;
  onClose?: () => void;

  private readonly input = new Input({ prompt: "› ", placeholder: "command" });
  private readonly list: SelectList;
  private readonly commands: Map<string, PaletteCommand>;
  private readonly box = new Box(1, 1, (line) => tokens.panel(line));

  constructor(commands: PaletteCommand[]) {
    this.commands = new Map(commands.map((command) => [command.value, command]));
    const items = commands.map((command) => ({
      value: command.value,
      label: command.label,
      ...(command.hint === undefined ? {} : { description: command.hint }),
    }));
    this.list = new SelectList(items, Math.min(Math.max(items.length, 1), 8), selectTheme);
    this.list.onSelect = (item) => this.run(item.value);
    this.list.onCancel = () => this.close();
    this.box.addChild(new Text(tokens.muted(" commands"), 0, 0));
    this.box.addChild(this.input);
    this.box.addChild(this.list);
    this.input.onSubmit = () => {
      const selected = this.list.getSelectedItem();
      if (selected !== null) this.run(selected.value);
    };
    this.input.onEscape = () => this.close();
  }

  private close(): void {
    this.onClose?.();
  }

  private run(value: string): void {
    const command = this.commands.get(value);
    this.close();
    command?.run();
  }

  handleInput(data: string): void {
    this.input.focused = this.focused;
    const routesToList =
      matchesKey(data, "up") ||
      matchesKey(data, "down") ||
      matchesKey(data, "pageUp") ||
      matchesKey(data, "pageDown") ||
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c");
    if (routesToList) {
      this.list.handleInput(data);
      return;
    }
    this.input.handleInput(data);
    this.list.setFilter(this.input.getValue());
  }

  invalidate(): void {
    // Children render fresh each frame.
  }

  render(width: number): string[] {
    return this.box.render(width);
  }
}
