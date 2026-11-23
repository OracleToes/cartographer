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
  backgroundAnsi,
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

/** Foreground and background in one pass; the badge and the selected row both need it. */
const both = (fgHex: string, bgHex: string, extra: Omit<TextStyle, "fg" | "bg"> = {}) => {
  const fg = parseColor(fgHex);
  const bg = parseColor(bgHex);
  return (text: string): string => styleText(text, { fg, bg, ...extra }, mode());
};

const badge = (fgHex: string, bgHex: string) => both(fgHex, bgHex, { bold: true });

/**
 * The canvas. Every frame the app draws is painted edge to edge, because a
 * colour scheme that only inks the glyphs leaves the terminal's own background
 * showing through, and the result reads as the terminal's look with some coloured
 * text on top. The one exception is an overlay: a modal paints its own.
 */
export const page = (text: string): string => tokens.canvas(text);

/**
 * A line of the page: padded to the pane's width and filled with the canvas,
 * edge to edge. A child's own colour resets its background when it ends, so the
 * canvas is re-armed after every reset it leaves behind — otherwise a coloured
 * fragment would punch a hole in the page and the terminal's own background
 * would show through the middle of a row.
 */
export const canvasLine = (line: string, width: number): string => fillLine(line, width, palette.background);

/** A line of the chrome (header, key bar, context bar): the deepest tone, around the panes. */
export const chromeLine = (line: string, width: number): string => fillLine(line, width, palette.chrome);

/** A line of a raised input surface, the prompt's. */
export const surfaceLine = (line: string, width: number): string => fillLine(line, width, palette.surface);

/**
 * The header of an entry (a transcript card, a Context row): a step lighter than
 * the page its body sits on, so the two read as two things — a title and what it
 * titles — and a column of entries can be scanned by its headers.
 */
export const headerLine = (line: string, width: number): string => fillLine(line, width, palette.entryHeader);

/** Any band's line, filled to the width: the sidebar uses it for its own colour. */
export const fillLine = (line: string, width: number, hex: string): string => {
  const bg = backgroundAnsi(parseColor(hex), mode());
  // `ESC[0m` clears the background as well: the editor's cursor ends with one,
  // and without re-arming the rest of its row would fall back to the terminal's colour.
  const padded = padLine(line, width)
    .replaceAll("\u001b[49m", `\u001b[49m${bg}`)
    .replaceAll("\u001b[0m", `\u001b[0m${bg}`)
    .replaceAll("\u001b[m", `\u001b[m${bg}`);
  return `${bg}${padded}\u001b[49m`;
};

/** A horizontal rule in the seam colour: a hairline, never a box. */
export const ruleLine = (width: number): string => tokens.rule("─".repeat(Math.max(0, width)));

/**
 * The sidebar is a band: one flat colour, quieter than the working surface,
 * with a single seam on its right. It was a gradient before, which made the
 * pane read as a rounded decoration and pulled the eye off the rows it exists
 * to carry.
 */
export const band = (text: string): string => tokens.sidebarBg(text);

/** A line of the sidebar: its own colour, out to the pane's edge. */
export const bandLine = (line: string, width: number): string => fillLine(line, width, palette.panel);

export { visibleWidth, truncateToWidth };
/**
 * Fit a line to the width: pad it, and clip it only when it is genuinely too
 * long. `>=` here was a real defect — a body line that filled the column
 * exactly was handed to `truncateToWidth`, which reserves room for its
 * ellipsis and so ate three characters out of the middle of a paragraph that
 * had nothing wrong with it. A line already at the width is left alone.
 */
export function padLine(str: string, width: number): string {
  const w = visibleWidth(str);
  if (w > width) return truncateToWidth(str, width);
  return w === width ? str : str + " ".repeat(width - w);
}

/**
 * The palette. Raw values live here and nowhere else; every component above
 * this file names a role.
 */
const palette = {
  /** The chrome: the margin, the header row, the key bar and the context bar. The deepest tone. */
  chrome: "#06080b",
  /** The working pane: raised out of the chrome. */
  background: "#0d1219",
  /** The header of an entry, over the page its body is drawn on: a step lighter than it, a step short of a card. */
  entryHeader: "#17202c",
  /** Inputs and cards: a step above the working pane. */
  surface: "#131a23",
  /** Raised regions: the sidebar, panels, overlays. */
  panel: "#171f2a",
  /** A header inside a raised region. */
  panelRaised: "#1d2733",
  /** The selected row's tint. */
  selection: "#26344a",
  /** A row under the cursor in an unfocused pane. */
  selectionQuiet: "#1c2738",
  /** Seams, borders, the editor's frame. */
  rule: "#2a3646",
  /** A band's far edge: one column lighter than the surface it separates from. */
  seam: "#344254",

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
  /** Prefill over already occupied context: background keeps the fill visible. */
  prefillOnFill: both(palette.gold, "#354c61"),
  prefillPendingOnFill: both(palette.textDim, "#354c61"),
  /** Pin marker: warm gold. */
  pin: style(palette.gold),

  /** The Brain's books, each with one hue. */
  atlas: style(palette.atlas),
  ledger: style(palette.ledger),
  chat: style(palette.chat),

  /** Seams and frames. */
  rule: style(palette.rule),
  /** The lighter edge between two bands. */
  seam: style(palette.seam),

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
 * The sidebar is a band, not a gradient. Posting paints its pane one flat
 * colour quieter than the working surface, with a single seam between them;
 * a gradient that fades toward the page made the pane read as a rounded-off
 * decoration and took the eye away from the rows it exists to carry.
 */

/** A one-cell accent spine: the selected row's left edge, a card's kind, a quote. */
export const spine = (tint: (text: string) => string): string => tint("▌");

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
