/**
 * The Context view — the surgery view (§8).
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
import type { ChatRecord, CartoBrain } from "../domain/records.js";
import { projectContext } from "../domain/projection.js";
import { padLine, pinBadgeText, tokens } from "./tokens.js";

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
  /** The frozen projection's exact bytes — the carto-context section the model reads. */
  projectionText?: string | undefined;
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
  onDelete?: (partId: string, itemId: string | number, now: boolean) => void;
  onCollapse?: () => void;
  /** Fired on `p` over a transcript item that names a Brain chat record: toggle the pin marker. */
  onTogglePin?: (partId: string, itemId: string | number) => void;

  private focusedPane: "rail" | "content" = "rail";
  private selectedPartIndex = 0;
  private scrollOffset = 0;
  private selectedToolIndex = 0;
  private selectedMessageIndex = 0;
  private selectedWorkIndex = 0;
  private nowArmed = false;
  private itemExpanded = new Map<string, boolean>();
  private toolExpanded = new Map<string, boolean>();
  private toolRanges: Array<{ name: string; start: number; end: number }> = [];
  private itemRanges: Array<{ id: string | number; start: number; end: number }> = [];
  private showRaw = false;
  private parts: ContextPartItem[] = [];
  private totalTokens = 0;
  private data: ContextViewData | undefined;

  setData(data: ContextViewData): void {
    this.data = data;
    // The frozen projection is the model's own bytes; re-rendering the live
    // Brain here would fabricate a projection mid-generation. When the bytes
    // are unavailable (a crash remainder), the fallback is the same re-render
    // pi itself performs — the view never invents a projection.
    const projectionText = data.projectionText ?? projectContext(data.brain).text;

    const systemPromptText = data.systemPrompt;
    const toolsRawText = JSON.stringify(data.tools, null, 2);
    const transcriptRawText = JSON.stringify(data.transcriptMessages, null, 2);
    const toolWorkRawText = JSON.stringify(data.toolWorkItems, null, 2);
    const stateBlockText = data.stateBlockText;

    const systemTokens = estimateTokens(systemPromptText);
    const projTokens = estimateTokens(projectionText);
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
      if (matchesKey(data, "p")) {
        const selectedPart = this.parts[this.selectedPartIndex];
        if (selectedPart?.id === "transcript" && this.data && !this.showRaw) {
          const msg = this.data.transcriptMessages[this.selectedMessageIndex];
          if (msg !== undefined && this.chatRecordFor(msg.id) !== undefined) this.onTogglePin?.("transcript", msg.id);
        }
        return;
      }
      if (matchesKey(data, "!") || data === "!") {
        this.nowArmed = !this.nowArmed;
        return;
      }
      if (matchesKey(data, "c")) {
        this.onCollapse?.();
        return;
      }
      if (matchesKey(data, "d")) {
        const selectedPart = this.parts[this.selectedPartIndex];
        if (selectedPart?.id === "transcript" && this.data) {
          const msg = this.data.transcriptMessages[this.selectedMessageIndex];
          if (msg) this.onDelete?.("transcript", msg.id, this.nowArmed);
          this.nowArmed = false;
          return;
        }
        if (selectedPart?.id === "tool-work" && this.data) {
          const work = this.data.toolWorkItems[this.selectedWorkIndex];
          if (work) this.onDelete?.("tool-work", work.id, this.nowArmed);
          this.nowArmed = false;
          return;
        }
        if (selectedPart?.id === "tools" && this.data) {
          const tool = this.data.tools[this.selectedToolIndex];
          if (tool) this.onDelete?.("tools", tool.name, this.nowArmed);
          this.nowArmed = false;
          return;
        }
        this.scrollOffset += 10;
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
      if (selectedPart?.id === "transcript" && !this.showRaw && this.data) {
        if (matchesKey(data, "j") || matchesKey(data, "down")) {
          this.selectedMessageIndex = Math.min(this.data.transcriptMessages.length - 1, this.selectedMessageIndex + 1);
          return;
        }
        if (matchesKey(data, "k") || matchesKey(data, "up")) {
          this.selectedMessageIndex = Math.max(0, this.selectedMessageIndex - 1);
          return;
        }
        if (matchesKey(data, "enter") || matchesKey(data, "space")) {
          const msg = this.data.transcriptMessages[this.selectedMessageIndex];
          if (msg) {
            const idKey = String(msg.id);
            const isOpen = this.itemExpanded.get(idKey) ?? true;
            this.itemExpanded.set(idKey, !isOpen);
          }
          return;
        }
      }
      if (selectedPart?.id === "tool-work" && !this.showRaw && this.data) {
        if (matchesKey(data, "j") || matchesKey(data, "down")) {
          this.selectedWorkIndex = Math.min(this.data.toolWorkItems.length - 1, this.selectedWorkIndex + 1);
          return;
        }
        if (matchesKey(data, "k") || matchesKey(data, "up")) {
          this.selectedWorkIndex = Math.max(0, this.selectedWorkIndex - 1);
          return;
        }
        if (matchesKey(data, "enter") || matchesKey(data, "space")) {
          const work = this.data.toolWorkItems[this.selectedWorkIndex];
          if (work) {
            const idKey = String(work.id);
            const isOpen = this.itemExpanded.get(idKey) ?? true;
            this.itemExpanded.set(idKey, !isOpen);
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
      if (matchesKey(data, "pageDown")) {
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

  handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent): import("@earendil-works/pi-tui").TuiMouseEventResult | undefined {
    if (event.type === "wheel" && event.wheelDelta) {
      this.scrollOffset = Math.max(0, this.scrollOffset + (event.wheelDelta > 0 ? 3 : -3));
      return { handled: true, render: true };
    }
    if (event.type === "press") {
      return { handled: true, focus: true };
    }
    if (event.type === "click") {
      const railWidth = Math.min(32, Math.floor(event.width * 0.35));
      if (event.x < railWidth) {
        // Clicked on rail
        const railIdx = event.y - 2;
        if (railIdx >= 0 && railIdx < this.parts.length) {
          this.selectedPartIndex = railIdx;
          this.focusedPane = "rail";
          this.scrollOffset = 0;
          return { handled: true, render: true };
        }
      } else {
        // Clicked on content pane
        this.focusedPane = "content";
        const selectedPart = this.parts[this.selectedPartIndex];
        if (selectedPart?.id === "tools" && !this.showRaw) {
          const contentY = event.y - 2 + this.scrollOffset;
          const hitTool = this.toolRanges.find((r) => contentY >= r.start && contentY < r.end);
          if (hitTool) {
            const current = this.toolExpanded.get(hitTool.name) ?? true;
            this.toolExpanded.set(hitTool.name, !current);
            return { handled: true, render: true };
          }
        }
        return { handled: true, render: true };
      }
    }
    return undefined;
  }

  invalidate(): void {
    // Stateless.
  }

  private renderToolsFormatted(tools: ContextToolItem[], width: number): string[] {
    const lines: string[] = [];
    this.toolRanges = [];
    const title = ` Registered Tools (${tools.length}):`;
    lines.push(tokens.cardBg(padLine(tokens.bold(tokens.muted(title)), width)));
    lines.push(tokens.cardBg(" ".repeat(width)));

    tools.forEach((tool, idx) => {
      const start = lines.length;
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
      const end = lines.length;
      this.toolRanges.push({ name: tool.name, start, end });
    });

    return lines;
  }

  private chatRecordFor(itemId: string | number): ChatRecord | undefined {
    if (!this.data) return undefined;
    return this.data.brain.chat.find((record) => String(record.id) === String(itemId));
  }

  private renderTranscriptFormatted(messages: ContextDialogueMessage[], width: number): string[] {
    const lines: string[] = [];
    this.itemRanges = [];
    const title = ` Dialogue Transcript (${messages.length} messages):`;
    lines.push(tokens.cardBg(padLine(tokens.bold(tokens.muted(title)), width)));
    lines.push(tokens.cardBg(" ".repeat(width)));

    if (messages.length === 0) {
      lines.push(tokens.cardBg(padLine(`   ${tokens.muted("(no conversation messages yet)")}`, width)));
      lines.push(tokens.cardBg(" ".repeat(width)));
      return lines;
    }

    messages.forEach((msg, idx) => {
      const start = lines.length;
      const isSelected = this.focusedPane === "content" && idx === this.selectedMessageIndex;
      const idKey = String(msg.id);
      const isOpen = this.itemExpanded.get(idKey) ?? true;
      const foldGlyph = isOpen ? "▾" : "▸";
      const isUser = msg.role === "user";
      const who = isUser ? tokens.accent("you") : tokens.agent("carto");
      const ts = msg.timestamp ? ` · ${new Date(msg.timestamp).toISOString()}` : "";
      const prefix = isSelected ? tokens.accent(" ▸ ") : "   ";

      const record = this.chatRecordFor(msg.id);
      const pinStr = record !== undefined && record.pinned !== undefined ? ` ${pinBadgeText(record.pinned, "pin")}` : "";
      const headerText = `${prefix}${tokens.bold(who)} ${tokens.muted(`[#${msg.id}${ts}]`)} ${tokens.muted(foldGlyph)}${pinStr}`;
      lines.push(isSelected ? tokens.selectedBg(padLine(headerText, width)) : tokens.cardBg(padLine(headerText, width)));

      if (isOpen) {
        const bodyLines = wrapTextWithAnsi(msg.text, Math.max(1, width - 8));
        for (const bl of bodyLines) {
          lines.push(tokens.cardBg(padLine(`       ${bl}`, width)));
        }
      } else {
        const preview = truncateToWidth(msg.text.replace(/\s+/g, " ").trim(), Math.max(1, width - 12), "…");
        lines.push(tokens.cardBg(padLine(`       ${tokens.muted(preview)}`, width)));
      }
      lines.push(tokens.cardBg(" ".repeat(width)));
      const end = lines.length;
      this.itemRanges.push({ id: msg.id, start, end });
    });
    return lines;
  }

  private renderToolWorkFormatted(items: ContextWorkItem[], width: number): string[] {
    const lines: string[] = [];
    this.itemRanges = [];
    const title = ` Tool Work & Reasoning (${items.length} items):`;
    lines.push(tokens.cardBg(padLine(tokens.bold(tokens.muted(title)), width)));
    lines.push(tokens.cardBg(" ".repeat(width)));

    if (items.length === 0) {
      lines.push(tokens.cardBg(padLine(`   ${tokens.muted("(no tool work or reasoning yet)")}`, width)));
      lines.push(tokens.cardBg(" ".repeat(width)));
      return lines;
    }

    items.forEach((item, idx) => {
      const start = lines.length;
      const isSelected = this.focusedPane === "content" && idx === this.selectedWorkIndex;
      const idKey = String(item.id);
      const isOpen = this.itemExpanded.get(idKey) ?? true;
      const foldGlyph = isOpen ? "▾" : "▸";
      const prefix = isSelected ? tokens.accent(" ▸ ") : "   ";

      if (item.kind === "reasoning") {
        const headerText = `${prefix}${tokens.bold(tokens.reasoning("▎ think"))} ${tokens.muted(`[#${item.id}]`)} ${tokens.muted(foldGlyph)}`;
        lines.push(isSelected ? tokens.selectedBg(padLine(headerText, width)) : tokens.cardBg(padLine(headerText, width)));
        if (isOpen) {
          const textLines = wrapTextWithAnsi(item.text ?? "", Math.max(1, width - 8));
          for (const tl of textLines) {
            lines.push(tokens.cardBg(padLine(`       ${tokens.reasoning(tl)}`, width)));
          }
        } else {
          const preview = truncateToWidth((item.text ?? "").replace(/\s+/g, " ").trim(), Math.max(1, width - 12), "…");
          lines.push(tokens.cardBg(padLine(`       ${tokens.muted(preview)}`, width)));
        }
      } else if (item.kind === "toolCall") {
        const headerText = `${prefix}${tokens.bold(tokens.tool(`▎ call: ${item.name}`))} ${tokens.muted(`[#${item.id}]`)} ${tokens.muted(foldGlyph)}`;
        lines.push(isSelected ? tokens.selectedBg(padLine(headerText, width)) : tokens.cardBg(padLine(headerText, width)));
        if (isOpen) {
          const argLines = (item.args ?? "").split("\n");
          for (const al of argLines) {
            lines.push(tokens.cardBg(padLine(`       ${tokens.muted(al)}`, width)));
          }
        } else {
          const preview = truncateToWidth((item.args ?? "").replace(/\s+/g, " ").trim(), Math.max(1, width - 12), "…");
          lines.push(tokens.cardBg(padLine(`       ${tokens.muted(preview)}`, width)));
        }
      } else if (item.kind === "toolResult") {
        const headerText = `${prefix}${tokens.bold(tokens.muted(`▎ result`))} ${tokens.muted(`[#${item.id}]`)} ${tokens.muted(foldGlyph)}`;
        lines.push(isSelected ? tokens.selectedBg(padLine(headerText, width)) : tokens.cardBg(padLine(headerText, width)));
        if (isOpen) {
          const outLines = wrapTextWithAnsi(item.output ?? "", Math.max(1, width - 8));
          for (const ol of outLines) {
            lines.push(tokens.cardBg(padLine(`       ${tokens.output(ol)}`, width)));
          }
        } else {
          const preview = truncateToWidth((item.output ?? "").replace(/\s+/g, " ").trim(), Math.max(1, width - 12), "…");
          lines.push(tokens.cardBg(padLine(`       ${tokens.muted(preview)}`, width)));
        }
      }
      lines.push(tokens.cardBg(" ".repeat(width)));
      const end = lines.length;
      this.itemRanges.push({ id: item.id, start, end });
    });
    return lines;
  }

  private renderRightPane(part: ContextPartItem, width: number, maxLines: number): string[] {
    const lines: string[] = [];
    const modeBadge = this.showRaw ? tokens.warn("[RAW BYTES]") : tokens.accent("[FORMATTED]");
    const nowBadge = this.nowArmed ? ` ${tokens.danger("[NOW ARMED]")}` : "";
    const focusTag = this.focusedPane === "content" ? tokens.bold(tokens.accent(" [FOCUSED]")) : "";
    const headerText = ` ${tokens.bold(tokens.accent(part.name))} ${tokens.muted(`· ~${part.tokens.toLocaleString("en-US")} tokens`)}  ${modeBadge}${nowBadge}${focusTag}`;
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
    const headerRight = `${tokens.muted("h/l panes · p pin · tab raw · esc chat ")}`;
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
