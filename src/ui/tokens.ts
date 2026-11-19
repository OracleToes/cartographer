import { styleTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * Carto's style vocabulary. The screen never writes an ANSI code itself: it
 * asks for a meaning, and this file decides how that meaning looks.
 *
 * We use the terminal's own palette (the ANSI 16), never a fixed RGB theme, so
 * Carto follows the terminal the person already chose. Every distinction the
 * screen makes is also made by a glyph or a word, so a plain terminal without
 * colour still reads it.
 */
export type Style = (text: string) => string;

const SGR = {
  default: "\x1b[39m",
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  brightBlack: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
} as const;

type Colour = keyof typeof SGR;

function style(colour: Colour, attributes: { bold?: boolean; dim?: boolean } = {}): Style {
  return (text: string) => (text === "" ? "" : styleTextWithAnsi(text, SGR[colour], undefined, attributes));
}

export const token = {
  /** Normal reading text: the terminal's own foreground, with no escape at all. */
  ink: (text: string) => text,
  /** Secondary text: reasons, counts, hints. */
  muted: style("brightBlack"),
  /** Tertiary text: the least important thing on a row. */
  faint: style("brightBlack", { dim: true }),
  /** The one accent: the active tab, a handle, the product name. */
  accent: style("cyan", { bold: true }),
  /** The accent without weight, for a selected row's text. */
  accentPlain: style("cyan"),
  /** A person record. */
  person: style("blue", { bold: true }),
  /** An agent record. */
  agent: style("green", { bold: true }),
  /** Model reasoning. */
  reasoning: style("magenta", { dim: true }),
  /** Tool calls and their names. */
  tool: style("cyan"),
  /** Tool output, which is data, not prose. */
  output: style("brightBlack"),
  /** Something the person should read before it costs them. */
  warning: style("yellow", { bold: true }),
  /** Something failed. */
  danger: style("red", { bold: true }),
  /** Work finished. */
  success: style("green"),
  /** The spinner and the word next to it. */
  busy: style("yellow"),
  /** A horizontal rule. */
  rule: style("brightBlack", { dim: true }),
  /** A section head. */
  section: style("brightBlack"),
  /** A section head that holds the selection. */
  sectionActive: style("brightWhite", { bold: true }),
  /** The bar: what the server keeps. */
  barFilled: style("cyan"),
  /** The bar: what the server is reading now. */
  barChanging: style("yellow", { bold: true }),
  /** The bar: room that is still free. */
  barFree: style("brightBlack", { dim: true }),
  /** The bar before the first server report. */
  barEstimate: style("brightBlack"),
  /** The budget boundary. */
  barCap: style("magenta"),
  /** The bar when the prompt is past the Carto budget. */
  barOverCap: style("yellow"),
  /** The bar when the prompt is past the model's window. */
  barOverWindow: style("red", { bold: true }),
} as const;

/** Apply `style` to each part separately, so a part can be styled on its own. */
export function applied(styleOf: Style, parts: readonly string[]): string[] {
  return parts.map((part) => styleOf(part));
}
