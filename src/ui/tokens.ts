/**
 * Semantic colour tokens for the workspace (§8).
 *
 * Colours are hex, converted once at first use (after the terminal is up).
 * Roles only: surfaces, text, interaction, feedback. Nothing else in the UI
 * picks a colour directly.
 */
import {
  getTerminalColorMode,
  parseColor,
  styleText,
  truncateToWidth,
  visibleWidth,
  type TerminalColorMode,
  type TextStyle,
} from "@earendil-works/pi-tui";

let cachedMode: TerminalColorMode | undefined;
function mode(): TerminalColorMode {
  if (cachedMode === undefined) cachedMode = getTerminalColorMode();
  return cachedMode;
}

const style = (hex: string, extra: Omit<TextStyle, "fg"> = {}) => {
  const color = parseColor(hex);
  return (text: string): string => styleText(text, { fg: color, ...extra }, mode());
};

const background = (hex: string, extra: Omit<TextStyle, "bg"> = {}) => {
  const color = parseColor(hex);
  return (text: string): string => styleText(text, { bg: color, ...extra }, mode());
};

const badge = (fgHex: string, bgHex: string) => {
  const fg = parseColor(fgHex);
  const bg = parseColor(bgHex);
  return (text: string): string => styleText(` ${text} `, { fg, bg, bold: true }, mode());
};

export { visibleWidth, truncateToWidth };
export function padLine(str: string, width: number): string {
  const w = visibleWidth(str);
  if (w >= width) return truncateToWidth(str, width);
  return str + " ".repeat(width - w);
}

export const tokens = {
  /** Person-facing accent: keys, the `you` prefix. */
  accent: style("#7cc7dc"),
  /** Agent accent: the `carto` prefix. */
  agent: style("#8fd3a0"),
  /** Secondary text: hints, rules, book names. */
  muted: style("#8b939c"),
  /** Warning: stale badges, budget-near marks. */
  warn: style("#e0c56e"),
  /** Danger: destructive keys, over-window marks. */
  danger: style("#e07a6a"),
  /** Reasoning: the agent at work, never addressing the person. */
  reasoning: style("#c9a0f0"),
  /** Non-chat model text: visible, dimmer and greyer than either voice. */
  output: style("#9fb3c8"),
  /** Tool cards: the machinery of the work, its own hue. */
  tool: style("#d08a4e"),
  /** Pin marker / warm amber accent. */
  pin: style("#e5c07b"),

  /** Surface & Panel backgrounds for Posting visual hierarchy. */
  panel: background("#14181d"),
  sidebarBg: background("#12161c"),
  cardBg: background("#181d24"),
  cardHeaderBg: background("#202630"),
  selectedBg: background("#243040"),
  activeRowBg: background("#1d2633"),

  /** Badges / Chips. */
  handleBadge: badge("#ffffff", "#2c3b4d"),
  pinBadge: badge("#1a1500", "#e5c07b"),
  staleBadge: badge("#1a1000", "#e0c56e"),
  kindBadge: badge("#b0c4de", "#222d3d"),
  statusBadge: badge("#8fd3a0", "#183022"),
  closedBadge: badge("#8b939c", "#242a33"),
  chip: (label: string, fgHex: string, bgHex: string) => badge(fgHex, bgHex)(label),

  bold: (text: string) => styleText(text, { bold: true }, mode()),
  italic: (text: string) => styleText(text, { italic: true }, mode()),
} as const;

/** Dim full-line helper for status/flash-style lines. */
/** The pin badge, carrying the author: "u" for the person, "a" for the agent. No badge at all when unpinned. */
export const pinBadgeText = (pinned: "user" | "agent" | undefined, label: string): string =>
  pinned === undefined ? "" : tokens.pinBadge(`${label}·${pinned === "user" ? "u" : "a"}`);

export const statusLine = (text: string): string => tokens.muted(tokens.italic(`· ${text}`));
export const statusWarnLine = (text: string): string => tokens.warn(tokens.italic(`· ${text}`));

/** The token bar's parts: muted, distinguishable — estimate hue per part (ui-proposal.md §7). */
export const partTokens = {
  /** System prompt + tool declarations. */
  system: style("#6e7a86"),
  /** The conversation so far. */
  transcript: style("#4e6a8a"),
  /** Tool results and tool-calling rounds. */
  toolWork: style("#8a6a4e"),
} as const;
