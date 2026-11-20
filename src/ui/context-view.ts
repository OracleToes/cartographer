/**
 * The Context view — the surgery view (MINI.md §8; docs/ui-proposal.md §5).
 * Read-only accurate rendering of what the model reads, grouped by part.
 *
 * Left rail: parts with estimated tokens and percentage shares.
 * Right pane: foldable content, exact wire bytes toggleable with human view.
 * Navigable via vim motions (j/k, tab to toggle raw bytes, esc to return to Chat).
 */
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import { estimateTokens } from "../domain/estimate.js";
import type { CartoBrain } from "../domain/records.js";
import { projectContext } from "../domain/projection.js";
import { tokens } from "./tokens.js";

export interface ContextPartItem {
  id: string;
  name: string;
  tokens: number;
  lines: string[];
  rawText: string;
}

export class ContextView implements Component, Focusable {
  focused = false;
  onBack?: () => void;

  private selectedPartIndex = 0;
  private showRaw = false;
  private parts: ContextPartItem[] = [];
  private totalTokens = 0;

  setData(
    brain: CartoBrain,
    systemPrompt: string,
    toolDescriptions: string[],
    transcriptText: string,
    toolWorkText: string,
    stateBlockText: string,
  ): void {
    const projection = projectContext(brain);
    const systemTokens = estimateTokens(systemPrompt);
    const toolsTokens = estimateTokens(toolDescriptions.join("\n"));
    const projTokens = projection.total;
    const transTokens = estimateTokens(transcriptText);
    const workTokens = estimateTokens(toolWorkText);
    const stateTokens = estimateTokens(stateBlockText);

    this.totalTokens = systemTokens + toolsTokens + projTokens + transTokens + workTokens + stateTokens;

    this.parts = [
      {
        id: "system",
        name: "SYSTEM",
        tokens: systemTokens,
        lines: [systemPrompt],
        rawText: systemPrompt,
      },
      {
        id: "tools",
        name: "TOOLS",
        tokens: toolsTokens,
        lines: toolDescriptions,
        rawText: toolDescriptions.join("\n\n"),
      },
      {
        id: "projection",
        name: "PROJECTION",
        tokens: projTokens,
        lines: projection.parts.map((p) => `[${p.label}]\n${p.text}`),
        rawText: projection.text,
      },
      {
        id: "transcript",
        name: "TRANSCRIPT",
        tokens: transTokens,
        lines: transcriptText.split("\n"),
        rawText: transcriptText,
      },
      {
        id: "tool-work",
        name: "TOOL WORK",
        tokens: workTokens,
        lines: toolWorkText.split("\n"),
        rawText: toolWorkText,
      },
      {
        id: "state-block",
        name: "STATE BLOCK",
        tokens: stateTokens,
        lines: stateBlockText.split("\n"),
        rawText: stateBlockText,
      },
    ];

    if (this.selectedPartIndex >= this.parts.length) {
      this.selectedPartIndex = 0;
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onBack?.();
      return;
    }
    if (matchesKey(data, "tab") || data === "r") {
      this.showRaw = !this.showRaw;
      return;
    }
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.selectedPartIndex = Math.min(this.parts.length - 1, this.selectedPartIndex + 1);
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.selectedPartIndex = Math.max(0, this.selectedPartIndex - 1);
      return;
    }
    if (matchesKey(data, "g")) {
      this.selectedPartIndex = 0;
      return;
    }
    if (data === "G") {
      this.selectedPartIndex = Math.max(0, this.parts.length - 1);
      return;
    }
  }

  invalidate(): void {
    // Stateless rendering.
  }

  private renderRightPane(part: ContextPartItem, width: number): string[] {
    const lines: string[] = [];
    const modeBadge = this.showRaw ? tokens.warn("[RAW BYTES]") : tokens.accent("[FORMATTED]");
    const headerText = ` ${tokens.bold(tokens.accent(part.name))} ${tokens.muted(`· ~${part.tokens.toLocaleString("en-US")} tokens`)}  ${modeBadge} ${tokens.muted("(tab to toggle)")}`;
    lines.push(tokens.cardHeaderBg(headerText.padEnd(width)));
    lines.push(tokens.cardBg(" ".repeat(width)));

    const bodyText = this.showRaw ? part.rawText : part.lines.join("\n");
    const rawLines = bodyText.split("\n");

    for (const rawLine of rawLines) {
      if (rawLine.trim().length === 0) {
        lines.push(tokens.cardBg(" ".repeat(width)));
        continue;
      }
      const wrapped = wrapTextWithAnsi(rawLine, Math.max(1, width - 4));
      for (const wl of wrapped) {
        lines.push(tokens.cardBg(`   ${wl}`.padEnd(width)));
      }
    }
    lines.push(tokens.cardBg(" ".repeat(width)));
    return lines;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Header banner
    const headerLeft = ` ${tokens.bold(tokens.accent("CONTEXT"))} ${tokens.muted("· what the model reads")} ${tokens.muted(`· ~${this.totalTokens.toLocaleString("en-US")} total tokens`)}`;
    const headerRight = `${tokens.muted("tab toggle raw · esc chat ")}`;
    const pad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight));
    lines.push(tokens.panel((headerLeft + " ".repeat(pad) + headerRight).padEnd(width)));
    lines.push("");

    if (this.parts.length === 0) {
      lines.push(`  ${tokens.muted("(Context is empty.)")}`);
      return lines;
    }

    const selectedPart = this.parts[this.selectedPartIndex] ?? this.parts[0];
    if (!selectedPart) return lines;

    // Split layout
    if (width >= 72) {
      const railWidth = Math.min(32, Math.floor(width * 0.35));
      const paneWidth = Math.max(30, width - railWidth - 2);

      const railLines: string[] = [];
      railLines.push(tokens.sidebarBg(` ${tokens.bold(tokens.muted("PARTS RAIL"))}`.padEnd(railWidth)));
      railLines.push(tokens.sidebarBg(" ".repeat(railWidth)));

      this.parts.forEach((part, idx) => {
        const isSelected = idx === this.selectedPartIndex;
        const pct = this.totalTokens > 0 ? Math.round((part.tokens / this.totalTokens) * 100) : 0;
        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const nameStr = part.name.padEnd(12);
        const tokStr = `~${part.tokens.toLocaleString("en-US")}`.padStart(7);
        const pctStr = `${pct}%`.padStart(4);

        const row = `${prefix}${isSelected ? tokens.bold(tokens.accent(nameStr)) : tokens.muted(nameStr)} ${tokens.muted(tokStr)} ${tokens.muted(pctStr)}`;
        const paddedRow = isSelected ? tokens.selectedBg(row.padEnd(railWidth)) : tokens.sidebarBg(row.padEnd(railWidth));
        railLines.push(paddedRow);
      });

      const paneLines = this.renderRightPane(selectedPart, paneWidth);
      const rowCount = Math.max(railLines.length, paneLines.length);

      for (let r = 0; r < rowCount; r++) {
        const left = railLines[r] ?? tokens.sidebarBg(" ".repeat(railWidth));
        const right = paneLines[r] ?? " ".repeat(paneWidth);
        lines.push(`${left}  ${right}`);
      }
    } else {
      // Stacked layout
      this.parts.forEach((part, idx) => {
        const isSelected = idx === this.selectedPartIndex;
        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const row = `${prefix}${tokens.bold(part.name)} ~${part.tokens.toLocaleString("en-US")} tok`;
        lines.push(isSelected ? tokens.selectedBg(row.padEnd(width)) : row);
        if (isSelected) {
          lines.push(...this.renderRightPane(part, width));
        }
      });
    }

    return lines;
  }
}
