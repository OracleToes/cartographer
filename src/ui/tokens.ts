/**
 * The workspace's colours (§8).
 *
 * Posting's model, adopted wholesale: a theme is a named set of role colours —
 * background, surface, panel, text, and a handful of semantic accents — and the
 * parts of the UI take their colour from a role, never from a hex of their own.
 * Every hue below exists because something in the product is that kind of
 * thing: a person, the agent's voice, its reasoning, a tool, a pin, each book
 * of the Brain, and the three quantities in the context bar.
 *
 * Nothing here is decoration. The page is a cool near-black canvas; a raised
 * surface is a step lighter; a selection is a step lighter still. Text is one
 * warm-grey ramp, so a saturated colour always means something.
 *
 * Colours are hex, converted once at first use (after the terminal is up).
 */
import {
  getTerminalColorMode,
  mixColors,
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

/** Foreground and background in one pass; the badge and the selected row both need it. */
const both = (fgHex: string, bgHex: string, extra: Omit<TextStyle, "fg" | "bg"> = {}) => {
  const fg = parseColor(fgHex);
  const bg = parseColor(bgHex);
  return (text: string): string => styleText(text, { fg, bg, ...extra }, mode());
};

const badge = (fgHex: string, bgHex: string) => both(fgHex, bgHex, { bold: true });

/** A colour blended by `amount` (0 = first, 1 = second). The sidebar's gradient is this. */
const blend = (fromHex: string, toHex: string, amount: number) =>
  mixColors(parseColor(fromHex), parseColor(toHex), Math.max(0, Math.min(1, amount)));

const blendBg = (fromHex: string, toHex: string, amount: number) => {
  const color = blend(fromHex, toHex, amount);
  return (text: string): string => styleText(text, { bg: color }, mode());
};

export { visibleWidth, truncateToWidth };
export function padLine(str: string, width: number): string {
  const w = visibleWidth(str);
  if (w >= width) return truncateToWidth(str, width);
  return str + " ".repeat(width - w);
}

/** A horizontal rule in the theme's faintest ink; `─` reads as a seam, not a border. */
export const ruleLine = (width: number): string => tokens.faint("─".repeat(Math.max(0, width)));

/**
 * The palette. Raw values live here and nowhere else; every component above
 * this file names a role.
 */
const palette = {
  /** The page. */
  background: "#0a0d12",
  /** Inputs and the transcript's own surface: a step above the page. */
  surface: "#0f141b",
  /** Raised regions: the sidebar, panels, overlays. */
  panel: "#131a23",
  /** A header inside a raised region. */
  panelRaised: "#19222d",
  /** The selected row's tint. */
  selection: "#1f2b3a",
  /** A row under the cursor in an unfocused pane. */
  selectionQuiet: "#182231",
  /** Seams, borders, the editor's frame. */
  rule: "#26323f",

  /** Body text. */
  text: "#d7dee8",
  /** Secondary text: labels, hints, counts. */
  textDim: "#8c99aa",
  /** Tertiary: rules, placeholders, the unfocused rail. */
  textFaint: "#5a6776",

  /** The person. */
  you: "#7dd3fc",
  /** The agent's deliberate voice — Chat, and nothing else. */
  agent: "#86e1a8",
  /** Reasoning: the agent at work, never addressing the person. */
  reasoning: "#b2a4f6",
  /** Non-chat model text: visible, quieter than either voice. */
  output: "#9aa8ba",
  /** The machinery: calls and their results. */
  tool: "#e9a06a",

  /** A pin, and the warning tone: the same warm gold, because both mean "look here". */
  gold: "#f2c14e",
  /** Errors, refusals, a failed call. */
  red: "#f07070",
  /** Focus, keys, and the primary accent. */
  focus: "#7aa2f7",

  /** Each book of the Brain has one hue, used wherever that book appears. */
  atlas: "#79a6f2",
  ledger: "#f0b429",
  chat: "#86e1a8",
} as const;

export const tokens = {
  /** Person-facing accent: keys, the `you` prefix, a focused border. */
  accent: style(palette.focus),
  /** The person's own voice, in the transcript and in Chat. */
  person: style(palette.you),
  /** Agent accent: the `carto` prefix and Chat records. */
  agent: style(palette.agent),
  /** Body ink. */
  text: style(palette.text),
  /** Secondary text: hints, rules, book names. */
  muted: style(palette.textDim),
  /** Tertiary ink: seams, the unfocused rail, placeholders. */
  faint: style(palette.textFaint),
  /** Warning: stale marks, an armed action, an over-window figure. */
  warn: style(palette.gold),
  /** Danger: a refusal, a failed call, a destructive key. */
  danger: style(palette.red),
  /** Reasoning: the agent at work, never addressing the person. */
  reasoning: style(palette.reasoning),
  /** Non-chat model text: visible, dimmer and greyer than either voice. */
  output: style(palette.output),
  /** Tool cards: the machinery of the work, its own hue. */
  tool: style(palette.tool),
  /** Pin marker: warm gold. */
  pin: style(palette.gold),

  /** The Brain's books, each with one hue. */
  atlas: style(palette.atlas),
  ledger: style(palette.ledger),
  chat: style(palette.chat),

  /** Seams and frames. */
  rule: style(palette.rule),

  /** Surfaces, by role. */
  canvas: background(palette.background),
  surface: background(palette.surface),
  panel: background(palette.panel),
  panelRaised: background(palette.panelRaised),
  selectedBg: background(palette.selection),
  activeRowBg: background(palette.selectionQuiet),
  /** The sidebar keeps its old name: it is a panel with a gradient (see `sidebarRow`). */
  sidebarBg: background(palette.panel),
  /** Cards sit on the transcript's surface, one step above it. */
  cardBg: background(palette.surface),
  cardHeaderBg: background(palette.panel),

  /** Badges: a tinted chip, never a solid block of colour. */
  handleBadge: both(palette.text, palette.selection, { bold: true }),
  pinBadge: badge("#1a1503", palette.gold),
  staleBadge: badge("#1a1303", palette.gold),
  kindBadge: both(palette.atlas, palette.panelRaised, { bold: true }),
  statusBadge: badge("#06210f", palette.agent),
  closedBadge: both(palette.textDim, palette.panelRaised),
  chip: (label: string, fgHex: string, bgHex: string) => badge(fgHex, bgHex)(label),

  bold: (text: string) => styleText(text, { bold: true }, mode()),
  italic: (text: string) => styleText(text, { italic: true }, mode()),
  dim: (text: string) => styleText(text, { dim: true }, mode()),
  underline: (text: string) => styleText(text, { underline: true }, mode()),
} as const;

/** A book's hue by name, so a view can colour a handle without a branch at every call site. */
export const kindTint = {
  atlas: tokens.atlas,
  ledger: tokens.ledger,
  chat: tokens.chat,
} as const;

/**
 * The sidebar's gradient: Posting's most recognisable surface. Row `index` of
 * `total` blends from the panel colour toward the page, so the index fades as
 * it runs down and the working area reads as the thing in front.
 */
export function sidebarRow(index: number, total: number): (text: string) => string {
  const t = total <= 1 ? 0 : Math.min(1, index / (total - 1));
  return blendBg(palette.panel, palette.background, t * 0.85);
}

/** A one-cell accent spine: the selected row's left edge, a card's kind, a quote. */
export const spine = (tint: (text: string) => string): string => tint("▌");

/** The pin badge, carrying the author: "u" for the person, "a" for the agent. No badge at all when unpinned. */
export const pinBadgeText = (pinned: "user" | "agent" | undefined, label: string): string =>
  pinned === undefined ? "" : tokens.pinBadge(`${label}·${pinned === "user" ? "u" : "a"}`);

export const statusLine = (text: string): string => tokens.faint(tokens.italic(text));
export const statusWarnLine = (text: string): string => tokens.warn(tokens.italic(text));

/** The context bar's parts: one hue each, so a bar reads as a division of the context. */
export const partTokens = {
  /** System prompt + tool declarations: the stable prefix. */
  system: style(palette.textFaint),
  /** The conversation so far. */
  transcript: style(palette.you),
  /** Tool results and tool-calling rounds. */
  toolWork: style(palette.tool),
} as const;

/** Raw palette read, for the bar's blended cells and for anything drawing a track. */
export const rawPalette = palette;
