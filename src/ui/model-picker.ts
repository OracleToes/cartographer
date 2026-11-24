/**
 * The model picker overlay (same Posting idiom as `palette.ts`).
 *
 * Indexes every model exposed by the configured provider(s) (e.g. llama-swap's
 * `/v1/models`), lets the person fuzzy-filter and pick one, and supports
 * on-demand refresh (`ctrl+r`) without blocking the TUI while the provider is
 * queried.
 */
import {
  fuzzyFilter,
  Input,
  matchesKey,
  SelectList,
  truncateToWidth,
  type Component,
  type Focusable,
  type SelectItem,
  type SelectListTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import type { IndexedModel } from "../runtime/model-catalog.js";
import { selectTheme } from "./palette.js";
import { padLine, ruleLine, tokens } from "./tokens.js";

export interface ModelPickerOptions {
  models: readonly IndexedModel[];
  activeLabel: string;
  running?: boolean;
  loading?: boolean;
  error?: string;
  initialQuery?: string;
}

const MAX_VISIBLE = 10;
/** Header rows rendered above the SelectList: top padding, title, status, input, rule. */
const HEADER_ROWS = 5;

const pickerTheme: SelectListTheme = selectTheme;

export class ModelPicker implements Component, Focusable {
  focused = false;
  onSelect?: (model: IndexedModel) => void;
  onRefresh?: () => void;
  onClose?: () => void;

  private readonly input = new Input({ prompt: "› ", placeholder: "filter models" });
  private models: readonly IndexedModel[];
  private activeLabel: string;
  private running: boolean;
  private loading: boolean;
  private error: string | undefined;
  private byKey = new Map<string, IndexedModel>();
  private list: SelectList;

  constructor(options: ModelPickerOptions) {
    this.models = options.models;
    this.activeLabel = options.activeLabel;
    this.running = options.running === true;
    this.loading = options.loading === true;
    this.error = options.error;
    if (options.initialQuery !== undefined && options.initialQuery.length > 0) {
      this.input.setValue(options.initialQuery);
    }
    this.indexByKey();
    this.list = this.buildList(this.input.getValue(), true);
    this.input.onSubmit = () => this.selectCurrent();
    this.input.onEscape = () => this.onClose?.();
  }

  /** Replace the indexed models (for example after an async provider refresh), preserving any typed filter. */
  setModels(
    models: readonly IndexedModel[],
    update: { activeLabel?: string; loading?: boolean; error?: string; running?: boolean } = {},
  ): void {
    this.models = models;
    if (update.activeLabel !== undefined) this.activeLabel = update.activeLabel;
    if (update.loading !== undefined) this.loading = update.loading;
    this.error = update.error;
    if (update.running !== undefined) this.running = update.running;
    const selectedValue = this.list.getSelectedItem()?.value;
    this.indexByKey();
    this.list = this.buildList(this.input.getValue(), selectedValue === undefined, selectedValue);
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
  }

  private indexByKey(): void {
    this.byKey = new Map(this.models.map((model) => [`${model.provider}/${model.modelId}`, model]));
  }

  private buildList(query: string, focusActive: boolean, preserveValue?: string): SelectList {
    const matched =
      query.trim().length === 0
        ? [...this.models]
        : fuzzyFilter([...this.models], query, (model) => `${model.provider}/${model.modelId} ${model.modelId}`);
    const items: SelectItem[] = matched.map((model) => {
      const key = `${model.provider}/${model.modelId}`;
      const windowText = model.contextWindow > 0 ? model.contextWindow.toLocaleString("en-US") : "window unknown";
      const parts = [model.active ? "active" : undefined, model.provider, windowText].filter(
        (part): part is string => part !== undefined,
      );
      return {
        value: key,
        label: `${model.active ? "● " : "  "}${model.modelId}`,
        description: parts.join(" · "),
      };
    });
    const list = new SelectList(items, MAX_VISIBLE, pickerTheme, {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 44,
    });
    if (preserveValue !== undefined) {
      const preserved = items.findIndex((item) => item.value === preserveValue);
      if (preserved >= 0) list.setSelectedIndex(preserved);
    } else if (focusActive && query.trim().length === 0) {
      const activeIndex = matched.findIndex((model) => model.active);
      if (activeIndex >= 0) list.setSelectedIndex(activeIndex);
    }
    list.onSelect = (item) => {
      const picked = this.byKey.get(item.value);
      this.onClose?.();
      if (picked !== undefined) this.onSelect?.(picked);
    };
    list.onCancel = () => this.onClose?.();
    return list;
  }

  private selectCurrent(): void {
    const item = this.list.getSelectedItem();
    const picked = item === null ? undefined : this.byKey.get(item.value);
    this.onClose?.();
    if (picked !== undefined) this.onSelect?.(picked);
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
    if (matchesKey(data, "ctrl+r")) {
      this.onRefresh?.();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.selectCurrent();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose?.();
      return;
    }
    this.input.handleInput(data);
    this.list = this.buildList(this.input.getValue(), false);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y < HEADER_ROWS) return undefined;
    return this.list.handleMouse({ ...event, y: event.y - HEADER_ROWS });
  }

  invalidate(): void {
    this.list.invalidate();
  }

  private statusLine(maxWidth: number): string {
    if (this.loading) {
      return truncateToWidth(tokens.muted(`indexing models from provider… (${this.models.length} cached)`), maxWidth, "…");
    }
    if (this.error !== undefined) {
      return truncateToWidth(tokens.warn(`refresh failed: ${this.error}`), maxWidth, "…");
    }
    const count = `${this.models.length} model${this.models.length === 1 ? "" : "s"}`;
    const suffix = this.running ? " · swaps at the next step" : "";
    return truncateToWidth(tokens.muted(`active: ${this.activeLabel} · ${count}${suffix}`), maxWidth, "…");
  }

  render(width: number): string[] {
    const inner = width;
    const lines: string[] = [];
    const paint = (line: string) => tokens.panel(padLine(line, inner));
    lines.push(tokens.panel(padLine("", inner)));
    lines.push(paint(`  ${tokens.bold(tokens.text("Model"))} ${tokens.faint("· enter switches · ^r refreshes · esc closes")}`));
    lines.push(paint(`  ${this.statusLine(Math.max(1, inner - 4))}`));
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
