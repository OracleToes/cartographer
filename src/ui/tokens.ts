/**
 * Semantic colour tokens for the workspace (MINI.md §8; Posting's token
 * vocabulary; the semantic-token display on `main` was right about the shape).
 *
 * Colours are hex, converted once at first use (after the terminal is up).
 * Roles only: surfaces, text, interaction, feedback. Nothing else in the UI
 * picks a colour directly.
 */
import {
  getTerminalColorMode,
  parseColor,
  styleText,
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
  /** Overlay/panel background. */
  panel: background("#14181d"),
  bold: (text: string) => styleText(text, { bold: true }, mode()),
  italic: (text: string) => styleText(text, { italic: true }, mode()),
} as const;

/** Dim full-line helper for status/flash-style lines. */
export const statusLine = (text: string): string => tokens.muted(tokens.italic(`· ${text}`));

/** The token bar's parts: muted, distinguishable — estimate hue per part (ui-proposal.md §7). */
export const partTokens = {
  /** System prompt + tool declarations. */
  system: style("#6e7a86"),
  /** The conversation so far. */
  transcript: style("#4e6a8a"),
  /** Tool results and tool-calling rounds. */
  toolWork: style("#8a6a4e"),
} as const;
