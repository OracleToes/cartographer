import { visibleWidth } from "@earendil-works/pi-tui";

// Text on a grid of terminal cells: how wide a string is, how it wraps, and lines made of styled spans.
//
// A line is a list of spans, each [text, style]. A style is a name from STYLES below, or several joined by a
// space. Lines are fitted to the screen's width here, so that no line the screen writes can wrap by itself.

/**
 * The SGR codes of each style name. A style says what a piece of text is, not which colour it has: `user`, `tool`,
 * `warn`, `muted`, `bgTool`. What stands here is the fallback, the terminal's own sixteen colours and no
 * backgrounds, for a terminal whose colours are not known or when colours are switched off. The full screen
 * replaces the entries with a palette made for the terminal's background (src/screen/theme.mjs, `applyTheme`).
 */
const FALLBACK = {
	// Attributes.
	dim: "2",
	bold: "1",
	italic: "3",
	under: "4",
	inverse: "7",
	// The terminal's own colours, by name.
	red: "31",
	green: "32",
	yellow: "33",
	blue: "34",
	magenta: "35",
	cyan: "36",
	grey: "90",
	lred: "91",
	lgreen: "92",
	lyellow: "93",
	lblue: "94",
	lmagenta: "95",
	lcyan: "96",
	// Text by how much it matters: plain text has no style, then muted, then faint.
	muted: "2",
	faint: "2",
	// Text by whose it is, or what it says.
	user: "36",
	tool: "36",
	note: "2",
	carto: "",
	ok: "32",
	warn: "33",
	err: "31",
	link: "36;4",
	heading: "1",
	code: "36",
	// What is selected, the tab that shows, and the mode's name: in the fallback, inverse.
	bgSel: "7",
	bgTab: "7",
	chip: "7",
	// The parts of a context (src/screen/views.mjs).
	catSystem: "33",
	catTools: "36",
	catTop: "32",
	catKept: "35",
	catYou: "91",
	catCarto: "90",
	catAgent: "94",
	catResult: "",
	catState: "92",
	catWindows: "96",
};
export const STYLES = { ...FALLBACK };

/** Replace the colours: `styles` maps style names to SGR codes. undefined goes back to the fallback. */
export function applyTheme(styles) {
	for (const key of Object.keys(STYLES)) delete STYLES[key];
	Object.assign(STYLES, FALLBACK, styles ?? {});
}

/** A string without what a terminal would act on: escape sequences and control characters; a tab becomes spaces. */
export const clean = (text) =>
	String(text ?? "")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/**
 * The width of a string in cells, as pi-tui counts it: the screen refuses a line that is wider than it was told,
 * so the two must count alike. Wide characters take two cells, a combining mark none, and a person with a skin
 * tone is one sign of two cells.
 */
export const width = (text) => visibleWidth(text);

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The start of a string that fits into `max` cells. A sign of several code points is kept whole or left out. */
export function fit(text, max) {
	if (text.length <= max && /^[\x20-\x7e]*$/.test(text)) return text;
	let cells = 0;
	let out = "";
	for (const { segment } of graphemes.segment(text)) {
		const w = visibleWidth(segment);
		if (cells + w > max) break;
		cells += w;
		out += segment;
	}
	return out;
}

/** A string cut to `max` cells, with an ellipsis when something was cut. */
export const cut = (text, max) => (width(text) <= max ? text : max <= 1 ? fit(text, max) : `${fit(text, max - 1)}…`);

/**
 * Wrap text into rows of at most `max` cells, breaking at spaces where it can. Line breaks in the text are kept.
 * @returns {string[]}
 */
export function wrap(text, max) {
	const rows = [];
	const limit = Math.max(4, max);
	for (const paragraph of clean(text).split("\n")) {
		if (width(paragraph) <= limit) {
			rows.push(paragraph);
			continue;
		}
		// The paragraph's own indent is kept on the rows that follow.
		const indent = /^\s*/.exec(paragraph)[0].slice(0, Math.floor(limit / 3));
		let row = "";
		let rowWidth = 0;
		for (const word of paragraph.split(/(?<=\s)/)) {
			let piece = word;
			let w = width(piece);
			if (rowWidth + width(piece.trimEnd()) > limit && row.trim() !== "") {
				rows.push(row.trimEnd());
				row = indent;
				rowWidth = width(indent);
			}
			// A word longer than a row is cut into rows.
			while (rowWidth + w > limit && width(piece.trimEnd()) > limit - rowWidth) {
				const head = fit(piece, limit - rowWidth);
				// (A sign wider than the row that is left goes on the next row.)
				if (head === "") {
					if (row.trim() === "") break;
					rows.push(row.trimEnd());
					row = indent;
					rowWidth = width(indent);
					continue;
				}
				rows.push(row + head);
				piece = piece.slice(head.length);
				w = width(piece);
				row = indent;
				rowWidth = width(indent);
			}
			row += piece;
			rowWidth += w;
		}
		if (row.trim() !== "" || rows.length === 0) rows.push(row.trimEnd());
	}
	return rows;
}

/** A line of one span. */
export const plainLine = (text, style = "") => [[text, style]];

/** The text of a line, without styles. */
export const lineText = (line) => line.map(([text]) => text).join("");

/** The escape sequence that switches a style on; "" for no style. */
export const sgr = (style) => {
	const codes = String(style ?? "")
		.split(" ")
		.map((name) => STYLES[name])
		.filter((code) => code !== undefined && code !== "");
	return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
};

/**
 * A line as the terminal is sent it: fitted to `cols` cells, styled, and padded with spaces to the full width so
 * that it paints over whatever stood there. `extra` is a style laid under the whole line, padding included: the
 * background of the block the line belongs to, or the mark of a selection.
 */
export function paint(line, cols, extra = "") {
	let cells = 0;
	let out = "";
	for (const [raw, style] of line) {
		if (cells >= cols) break;
		const text = fit(clean(raw).replace(/\n/g, " "), cols - cells);
		if (text === "") continue;
		cells += width(text);
		// The line's own style comes first, so that a span's colour wins over it and its background stays.
		const code = sgr(`${extra} ${style ?? ""}`.trim());
		out += code === "" ? text : `${code}${text}\x1b[0m`;
	}
	if (cells < cols) {
		const pad = " ".repeat(cols - cells);
		const code = sgr(extra);
		out += code === "" ? pad : `${code}${pad}\x1b[0m`;
	}
	return out;
}

/**
 * The same for a line that is styled already (rendered Markdown): text with escape sequences in it, `cells` wide.
 * Such a line switches its own styles off one by one and never everything at once, so `extra` holds under it.
 */
export function paintStyled(styled, cells, cols, extra = "") {
	const code = sgr(extra);
	const pad = " ".repeat(Math.max(0, cols - cells));
	return `${code}${styled}${pad}\x1b[0m`;
}

/** A bar of `cells` cells, `part` of it filled (0 to 1). */
export const bar = (part, cells = 8) => {
	const filled = Math.max(0, Math.min(cells, Math.round((Number.isFinite(part) ? part : 0) * cells)));
	return `${"▮".repeat(filled)}${"▯".repeat(cells - filled)}`;
};

/** 12345 → "12.3k", 950 → "950". */
export const short = (n) => {
	if (!Number.isFinite(n)) return "?";
	if (n < 1000) return String(Math.round(n));
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
};

/** 75 s → "1m 15s". */
export const span = (ms) => {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};

/**
 * Whether the end of a text is the same thing over and over: one character about 80 times, or a phrase of up to
 * 40 characters eight times, and at least 80 characters of it. A local model that has lost its way writes like
 * this until it is stopped. Rules, indents and the like are made of one character and are no fault; nor is a short
 * run such as a row of zeros in a table.
 * @returns {undefined | { unit: string, times: number }}
 */
export function repeats(text, { chars = 80, phrases = 8, phraseMax = 40 } = {}) {
	const tail = String(text ?? "").slice(-(phraseMax * phrases + 8));
	if (tail.length < chars) return undefined;
	// One character.
	const last = tail.at(-1);
	let run = 0;
	for (let i = tail.length - 1; i >= 0 && tail[i] === last; i--) run++;
	if (run >= chars && !/[\s\-=_*#~.│─]/.test(last)) return { unit: last, times: run };
	// A phrase: the shortest unit that the tail ends with often enough in a row.
	for (let size = 2; size <= phraseMax; size++) {
		const needed = Math.max(phrases, Math.ceil(chars / size));
		if (tail.length < size * needed) break;
		const unit = tail.slice(-size);
		if (unit.trim().length < 2 || new Set(unit).size === 1 || /^[\s\-=_*#~.│─|]+$/.test(unit)) continue;
		let times = 1;
		while (times < needed && tail.slice(-(times + 1) * size, -times * size) === unit) times++;
		if (times >= needed) return { unit, times };
	}
	return undefined;
}
