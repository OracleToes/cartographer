/**
 * The Context view — the surgery view (MINI.md §8; docs/ui-proposal.md §5).
 * Read-only accurate rendering of what the model reads, grouped by part
 * in the real order it appears in the context window:
 *
 * 1. SYSTEM (Rules & instructions: CARTO_INSTRUCTIONS)
 * 2. PROJECTION (The frozen projection snapshot: carto-context)
 * 3. TOOLS (Tool declarations with descriptions & JSON parameter schemas)
 * 4. TRANSCRIPT (Dialogue messages in chronological order)
 * 5. TOOL WORK (Reasoning, tool invocations, and tool results)
 * 6. STATE BLOCK (The trailing <carto-state> block at the request tail)
 *
 * Two-pane keyboard-first navigation:
 * - h/l or left/right: switch focus between parts rail and content pane
 * - j/k in rail: select part in context-window order
 * - j/k in content pane: scroll content / navigate items
 * - enter/space: toggle tool card folds
 * - tab / r: toggle formatted cards vs raw wire bytes
 * - esc: from content pane focuses rail; from rail returns to Chat
 */
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import { estimateSerialized, estimateTokens } from "../domain/estimate.js";
import type { CartoBrain } from "../domain/records.js";
import { projectContext } from "../domain/projection.js";
import { padLine, tokens } from "./tokens.js";

export interface ContextToolItem {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ContextDialogueMessage {
  id: string | number;
  role: string;
  text: string;
  timestamp?: number | undefined;
}

export interface ContextWorkItem {
  id: string | number;
  kind: string;
  name?: string | undefined;
  args?: string | undefined;
  output?: string | undefined;
  text?: string | undefined;
}

export interface ContextViewData {
  brain: CartoBrain;
  systemPrompt: string;
  tools: ContextToolItem[];
  transcriptMessages: ContextDialogueMessage[];
  toolWorkItems: ContextWorkItem[];
  stateBlockText: string;
}

export interface ContextPartItem {
  id: "system" | "projection" | "tools" | "transcript" | "tool-work" | "state-block";
  name: string;
  tokens: number;
  rawText: string;
}

export class ContextView implements Component, Focusable {
  focused = false;
  onBack?: () => void;

  private focusedPane: "rail" | "content" = "rail";
  private selectedPartIndex = 0;
  private scrollOffset = 0;
  private selectedToolIndex = 0;
  private toolExpanded = new Map<string, boolean>();
  private showRaw = false;
  private parts: ContextPartItem[] = [];
  private totalTokens = 0;
  private data: ContextViewData | undefined;

  setData(data: ContextViewData): void {
    this.data = data;
    const projection = projectContext(data.brain);

    const systemPromptText = data.systemPrompt;
    const projectionText = projection.text;
    const toolsRawText = JSON.stringify(data.tools, null, 2);
    const transcriptRawText = JSON.stringify(data.transcriptMessages, null, 2);
    const toolWorkRawText = JSON.stringify(data.toolWorkItems, null, 2);
    const stateBlockText = data.stateBlockText;

    const systemTokens = estimateTokens(systemPromptText);
    const projTokens = projection.total;
    const toolsTokens = estimateSerialized(data.tools);
    const transTokens = estimateSerialized(data.transcriptMessages);
    const workTokens = estimateSerialized(data.toolWorkItems);
    const stateTokens = estimateTokens(stateBlockText);

    this.totalTokens = systemTokens + projTokens + toolsTokens + transTokens + workTokens + stateTokens;

    // Real order in the context window:
    this.parts = [
      {
        id: "system",
        name: "SYSTEM",
        tokens: systemTokens,
        rawText: systemPromptText,
      },
      {
        id: "projection",
        name: "PROJECTION",
        tokens: projTokens,
        rawText: projectionText,
      },
      {
        id: "tools",
        name: "TOOLS",
        tokens: toolsTokens,
        rawText: toolsRawText,
      },
      {
        id: "transcript",
        name: "TRANSCRIPT",
        tokens: transTokens,
        rawText: transcriptRawText,
      },
      {
        id: "tool-work",
        name: "TOOL WORK",
        tokens: workTokens,
        rawText: toolWorkRawText,
      },
      {
        id: "state-block",
        name: "STATE BLOCK",
        tokens: stateTokens,
        rawText: stateBlockText,
      },
    ];

    if (this.selectedPartIndex >= this.parts.length) {
      this.selectedPartIndex = 0;
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "tab") || data === "r") {
      this.showRaw = !this.showRaw;
      return;
    }

    if (this.focusedPane === "rail") {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.onBack?.();
        return;
      }
      if (matchesKey(data, "l") || matchesKey(data, "right") || matchesKey(data, "enter")) {
        this.focusedPane = "content";
        this.scrollOffset = 0;
        return;
      }
      if (matchesKey(data, "j") || matchesKey(data, "down")) {
        this.selectedPartIndex = Math.min(this.parts.length - 1, this.selectedPartIndex + 1);
        this.scrollOffset = 0;
        return;
      }
      if (matchesKey(data, "k") || matchesKey(data, "up")) {
        this.selectedPartIndex = Math.max(0, this.selectedPartIndex - 1);
        this.scrollOffset = 0;
        return;
      }
      if (matchesKey(data, "g")) {
        this.selectedPartIndex = 0;
        this.scrollOffset = 0;
        return;
      }
      if (data === "G") {
        this.selectedPartIndex = Math.max(0, this.parts.length - 1);
        this.scrollOffset = 0;
        return;
      }
    } else {
      // Content pane focused
      if (matchesKey(data, "h") || matchesKey(data, "left") || matchesKey(data, "escape")) {
        this.focusedPane = "rail";
        return;
      }
      const selectedPart = this.parts[this.selectedPartIndex];
      if (selectedPart?.id === "tools" && !this.showRaw && this.data) {
        if (matchesKey(data, "j") || matchesKey(data, "down")) {
          this.selectedToolIndex = Math.min(this.data.tools.length - 1, this.selectedToolIndex + 1);
          return;
        }
        if (matchesKey(data, "k") || matchesKey(data, "up")) {
          this.selectedToolIndex = Math.max(0, this.selectedToolIndex - 1);
          return;
        }
        if (matchesKey(data, "enter") || matchesKey(data, "space")) {
          const tool = this.data.tools[this.selectedToolIndex];
          if (tool) {
            const isOpen = this.toolExpanded.get(tool.name) ?? true;
            this.toolExpanded.set(tool.name, !isOpen);
          }
          return;
        }
      }
      // Line scrolling
      if (matchesKey(data, "j") || matchesKey(data, "down")) {
        this.scrollOffset += 1;
        return;
      }
      if (matchesKey(data, "k") || matchesKey(data, "up")) {
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        return;
      }
      if (matchesKey(data, "d") || matchesKey(data, "pageDown")) {
        this.scrollOffset += 10;
        return;
      }
      if (matchesKey(data, "u") || matchesKey(data, "pageUp")) {
        this.scrollOffset = Math.max(0, this.scrollOffset - 10);
        return;
      }
      if (matchesKey(data, "g")) {
        this.scrollOffset = 0;
        return;
      }
      if (data === "G") {
        this.scrollOffset = 9999;
        return;
      }
    }
  }

  invalidate(): void {
    // Stateless.
  }

  private renderToolsFormatted(tools: ContextToolItem[], width: number): string[] {
    const lines: string[] = [];
    const title = ` Registered Tools (${tools.length}):`;
    lines.push(tokens.cardBg(padLine(tokens.bold(tokens.muted(title)), width)));
    lines.push(tokens.cardBg(" ".repeat(width)));

    tools.forEach((tool, idx) => {
      const isSelected = this.focusedPane === "content" && idx === this.selectedToolIndex;
      const isOpen = this.toolExpanded.get(tool.name) ?? true;
      const foldGlyph = isOpen ? "▾" : "▸";
      const prefix = isSelected ? tokens.accent(" ▸ ") : "   ";

      const headerText = `${prefix}${tokens.bold(tokens.accent(`${foldGlyph} ${tool.name}`))}`;
      lines.push(isSelected ? tokens.selectedBg(padLine(headerText, width)) : tokens.cardBg(padLine(headerText, width)));

      if (isOpen) {
        const descWrapped = wrapTextWithAnsi(tool.description, Math.max(1, width - 8));
        for (const dl of descWrapped) {
          lines.push(tokens.cardBg(padLine(`       ${tokens.muted(dl)}`, width)));
        }
        lines.push(tokens.cardBg(padLine(`       ${tokens.bold(tokens.tool("parameters schema:"))}`, width)));
        const schemaLines = JSON.stringify(tool.parameters, null, 2).split("\n");
        for (const sl of schemaLines) {
          lines.push(tokens.cardBg(padLine(`         ${tokens.output(sl)}`, width)));
        }
      }
      lines.push(tokens.cardBg(" ".repeat(width)));
    });

    return lines;
  }

  private renderTranscriptFormatted(messages: ContextDialogueMessage[], width: number): string[] {
    const lines: string[] = [];
    const title = ` Dialogue Transcript (${messages.length} messages):`;
    lines.push(tokens.cardBg(padLine(tokens.bold(tokens.muted(title)), width)));
    lines.push(tokens.cardBg(" ".repeat(width)));

    if (messages.length === 0) {
      lines.push(tokens.cardBg(padLine(`   ${tokens.muted("(no conversation messages yet)")}`, width)));
      lines.push(tokens.cardBg(" ".repeat(width)));
      return lines;
    }

    for (const msg of messages) {
      const isUser = msg.role === "user";
      const who = isUser ? tokens.accent("you") : tokens.agent("carto");
      const ts = msg.timestamp ? ` · ${new Date(msg.timestamp).toISOString()}` : "";
      lines.push(tokens.cardBg(padLine(`   ${tokens.bold(who)} ${tokens.muted(`[#${msg.id}${ts}]`)}`, width)));
      const bodyLines = wrapTextWithAnsi(msg.text, Math.max(1, width - 6));
      for (const bl of bodyLines) {
        lines.push(tokens.cardBg(padLine(`     ${bl}`, width)));
      }
      lines.push(tokens.cardBg(" ".repeat(width)));
    }
    return lines;
  }

  private renderToolWorkFormatted(items: ContextWorkItem[], width: number): string[] {
    const lines: string[] = [];
    const title = ` Tool Work & Reasoning (${items.length} items):`;
    lines.push(tokens.cardBg(padLine(tokens.bold(tokens.muted(title)), width)));
    lines.push(tokens.cardBg(" ".repeat(width)));

    if (items.length === 0) {
      lines.push(tokens.cardBg(padLine(`   ${tokens.muted("(no tool work or reasoning yet)")}`, width)));
      lines.push(tokens.cardBg(" ".repeat(width)));
      return lines;
    }

    for (const item of items) {
      if (item.kind === "reasoning") {
        lines.push(tokens.cardBg(padLine(`   ${tokens.bold(tokens.reasoning("▎ think"))} ${tokens.muted(`[#${item.id}]`)}`, width)));
        const textLines = wrapTextWithAnsi(item.text ?? "", Math.max(1, width - 6));
        for (const tl of textLines) {
          lines.push(tokens.cardBg(padLine(`     ${tokens.reasoning(tl)}`, width)));
        }
      } else if (item.kind === "toolCall") {
        lines.push(tokens.cardBg(padLine(`   ${tokens.bold(tokens.tool(`▎ call: ${item.name}`))} ${tokens.muted(`[#${item.id}]`)}`, width)));
        const argLines = (item.args ?? "").split("\n");
        for (const al of argLines) {
          lines.push(tokens.cardBg(padLine(`     ${tokens.muted(al)}`, width)));
        }
      } else if (item.kind === "toolResult") {
        lines.push(tokens.cardBg(padLine(`   ${tokens.bold(tokens.muted(`▎ result`))} ${tokens.muted(`[#${item.id}]`)}`, width)));
        const outLines = wrapTextWithAnsi(item.output ?? "", Math.max(1, width - 6));
        for (const ol of outLines) {
          lines.push(tokens.cardBg(padLine(`     ${tokens.output(ol)}`, width)));
        }
      }
      lines.push(tokens.cardBg(" ".repeat(width)));
    }
    return lines;
  }

  private renderRightPane(part: ContextPartItem, width: number, maxLines: number): string[] {
    const lines: string[] = [];
    const modeBadge = this.showRaw ? tokens.warn("[RAW BYTES]") : tokens.accent("[FORMATTED]");
    const focusTag = this.focusedPane === "content" ? tokens.bold(tokens.accent(" [FOCUSED]")) : "";
    const headerText = ` ${tokens.bold(tokens.accent(part.name))} ${tokens.muted(`· ~${part.tokens.toLocaleString("en-US")} tokens`)}  ${modeBadge}${focusTag}`;
    lines.push(tokens.cardHeaderBg(padLine(headerText, width)));
    lines.push(tokens.cardBg(" ".repeat(width)));

    let contentLines: string[] = [];

    if (!this.showRaw && this.data) {
      if (part.id === "tools") {
        contentLines = this.renderToolsFormatted(this.data.tools, width);
      } else if (part.id === "transcript") {
        contentLines = this.renderTranscriptFormatted(this.data.transcriptMessages, width);
      } else if (part.id === "tool-work") {
        contentLines = this.renderToolWorkFormatted(this.data.toolWorkItems, width);
      }
    }

    if (contentLines.length === 0) {
      const rawLines = part.rawText.split("\n");
      for (const rawLine of rawLines) {
        if (rawLine.trim().length === 0) {
          contentLines.push(tokens.cardBg(" ".repeat(width)));
          continue;
        }
        const wrapped = wrapTextWithAnsi(rawLine, Math.max(1, width - 4));
        for (const wl of wrapped) {
          contentLines.push(tokens.cardBg(padLine(`   ${wl}`, width)));
        }
      }
      contentLines.push(tokens.cardBg(" ".repeat(width)));
    }

    // Viewport scrolling
    if (this.scrollOffset > Math.max(0, contentLines.length - maxLines)) {
      this.scrollOffset = Math.max(0, contentLines.length - maxLines);
    }
    const visibleChunk = contentLines.slice(this.scrollOffset, this.scrollOffset + maxLines);
    lines.push(...visibleChunk);

    if (contentLines.length > maxLines) {
      const remaining = contentLines.length - (this.scrollOffset + visibleChunk.length);
      const scrollIndicator = ` ⋯ ${this.scrollOffset > 0 ? `▲ ${this.scrollOffset} above ` : ""}${remaining > 0 ? `▼ ${remaining} more lines ` : ""}· j/k or d/u to scroll`;
      lines.push(tokens.cardBg(padLine(tokens.muted(scrollIndicator), width)));
    }

    return lines;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Header banner
    const headerLeft = ` ${tokens.bold(tokens.accent("CONTEXT"))} ${tokens.muted("· what the model reads")} ${tokens.muted(`· ~${this.totalTokens.toLocaleString("en-US")} total tokens`)}`;
    const headerRight = `${tokens.muted("h/l switch panes · tab raw · esc chat ")}`;
    const pad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight));
    lines.push(tokens.panel(padLine(headerLeft + " ".repeat(pad) + headerRight, width)));
    lines.push(padLine("", width));

    if (this.parts.length === 0) {
      lines.push(`  ${tokens.muted("(Context is empty.)")}`);
      return lines;
    }

    const selectedPart = this.parts[this.selectedPartIndex] ?? this.parts[0];
    if (!selectedPart) return lines;

    // Split layout (rail on left, content pane on right)
    if (width >= 72) {
      const railWidth = Math.min(32, Math.floor(width * 0.35));
      const paneWidth = Math.max(30, width - railWidth - 2);
      const maxRows = 28;

      const railLines: string[] = [];
      const railHeader = this.focusedPane === "rail"
        ? ` ${tokens.bold(tokens.accent("PARTS RAIL (IN ORDER)"))}`
        : ` ${tokens.bold(tokens.muted("PARTS RAIL (IN ORDER)"))}`;
      railLines.push(tokens.sidebarBg(padLine(railHeader, railWidth)));
      railLines.push(tokens.sidebarBg(" ".repeat(railWidth)));

      this.parts.forEach((part, idx) => {
        const isSelected = idx === this.selectedPartIndex;
        const pct = this.totalTokens > 0 ? Math.round((part.tokens / this.totalTokens) * 100) : 0;
        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const nameStr = part.name.padEnd(12);
        const tokStr = `~${part.tokens.toLocaleString("en-US")}`.padStart(7);
        const pctStr = `${pct}%`.padStart(4);

        const row = `${prefix}${isSelected ? tokens.bold(tokens.accent(nameStr)) : tokens.muted(nameStr)} ${tokens.muted(tokStr)} ${tokens.muted(pctStr)}`;
        const paddedRow = isSelected
          ? (this.focusedPane === "rail" ? tokens.selectedBg(padLine(row, railWidth)) : tokens.activeRowBg(padLine(row, railWidth)))
          : tokens.sidebarBg(padLine(row, railWidth));
        railLines.push(paddedRow);
      });

      const paneLines = this.renderRightPane(selectedPart, paneWidth, maxRows);
      const rowCount = Math.max(railLines.length, paneLines.length);

      for (let r = 0; r < rowCount; r++) {
        const left = railLines[r] ?? tokens.sidebarBg(" ".repeat(railWidth));
        const right = paneLines[r] ?? tokens.cardBg(" ".repeat(paneWidth));
        lines.push(`${left}  ${right}`);
      }
    } else {
      // Stacked layout
      this.parts.forEach((part, idx) => {
        const isSelected = idx === this.selectedPartIndex;
        const prefix = isSelected ? tokens.accent("▸ ") : "  ";
        const row = `${prefix}${tokens.bold(part.name)} ~${part.tokens.toLocaleString("en-US")} tok`;
        lines.push(isSelected ? tokens.selectedBg(padLine(row, width)) : row);
        if (isSelected) {
          lines.push(...this.renderRightPane(part, width, 20));
        }
      });
    }

    return lines;
  }
}
