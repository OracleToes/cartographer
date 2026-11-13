// The colours of the full screen: one palette, made for the terminal's own background.
//
// The screen sets kinds of text apart in three ways, and a colour is never chosen by itself:
//
//   how much it matters   three levels of text: plain (what you and the agent say), muted (what Cartographer
//                         reports), faint (notes, hints, what was folded away). The levels are the text colour
//                         moved toward the background, so they hold on any theme.
//   whose it is           one hue for each: you, the agent's tools, its notes, and the three signals (done,
//                         attention, failed). All hues have the same lightness and the same strength, so none is
//                         louder than another by accident. The hue is used at full strength for a mark or an
//                         edge, and faintly as the background of the whole block, so a block reads as one thing.
//   where it is           the areas of the screen (the row of tabs and the strip, the place to type, an opened
//                         item) are the background moved a step toward the text colour; the more a thing is
//                         chrome and the less it is content, the further.
//
// Prominence is strength: the mode's name and the tab that shows are the only filled, saturated shapes.
//
// The hues are made in OKLCH with pi-tui's colour functions, where equal lightness looks equal. The terminal is
// asked for its background and text colours (OSC 11 and 10); when it does not answer, a dark or light default is
// used. With 256 colours the nearest of them is taken, which keeps the steps of lightness and loses the tints;
// with fewer, there are no backgrounds and the terminal's sixteen colours are used (the fallback in text.mjs).
import { colorToRgb, mixColors, oklchColor, rgbColor } from "@earendil-works/pi-tui";

const DEFAULTS = {
	dark: { bg: [22, 23, 28], fg: [208, 211, 218] },
	light: { bg: [250, 249, 246], fg: [42, 44, 52] },
};
/** The hues, in degrees of the OKLCH wheel. Blue is the key; teal and violet sit beside it; the signals are warm. */
export const HUES = { user: 255, tool: 200, note: 305, ok: 150, warn: 80, err: 25 };
/** The parts of a context: eight hues evenly round the wheel, and two greys. */
const CATEGORY_HUES = { catSystem: 70, catTools: 205, catTop: 115, catKept: 295, catYou: 250, catAgent: 160, catState: 340, catWindows: 25 };

/** The nearest of the 256 colours: the grey ramp for greys, the cube for the rest. */
export function to256(r, g, b) {
	const cubeStep = (value) => (value < 48 ? 0 : value < 115 ? 1 : Math.min(5, Math.round((value - 35) / 40)));
	const cubeValue = (step) => (step === 0 ? 0 : 55 + step * 40);
	const [cr, cg, cb] = [cubeStep(r), cubeStep(g), cubeStep(b)];
	const cube = { index: 16 + 36 * cr + 6 * cg + cb, rgb: [cubeValue(cr), cubeValue(cg), cubeValue(cb)] };
	const greyStep = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
	const grey = { index: 232 + greyStep, rgb: [8 + greyStep * 10, 8 + greyStep * 10, 8 + greyStep * 10] };
	const distance = (c) => (c.rgb[0] - r) ** 2 + (c.rgb[1] - g) ** 2 + (c.rgb[2] - b) ** 2;
	return distance(grey) <= distance(cube) ? grey.index : cube.index;
}

/**
 * How many colours to use: "truecolor", "256", or "none" (the terminal's sixteen, and no backgrounds).
 * @param {string} setting  "auto", or one of the three
 */
export function colorMode(setting = "auto", env = process.env) {
	if (setting === "truecolor" || setting === "256" || setting === "none") return setting;
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
	if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) return "truecolor";
	if (/256color|kitty|ghostty|alacritty|wezterm|foot|direct/i.test(env.TERM ?? "")) return "256";
	return "none";
}

/** "dark" or "light", from a background colour. */
export const schemeOf = ([r, g, b]) => ((r * 299 + g * 587 + b * 114) / 1000 < 128 ? "dark" : "light");

/** What the environment says about the background when the terminal does not: COLORFGBG is "fg;bg" in palette numbers. */
export function schemeFromEnv(env = process.env) {
	const bg = Number(String(env.COLORFGBG ?? "").split(";").at(-1));
	if (env.COLORFGBG && Number.isInteger(bg)) return bg === 7 || bg === 15 ? "light" : "dark";
	return undefined;
}

/** An OSC 10 or 11 reply (without its frame) as { target, rgb }; undefined when it is something else. */
export function parseColorReply(text) {
	const found = /^(1[01]);rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(text);
	if (!found) return undefined;
	return { target: found[1] === "11" ? "background" : "foreground", rgb: found.slice(2, 5).map((hex) => Math.round((Number.parseInt(hex, 16) / (16 ** hex.length - 1)) * 255)) };
}

/**
 * The palette.
 * @param {{ mode?: string, background?: number[], foreground?: number[], scheme?: "dark" | "light" }} given
 *   background, foreground: what the terminal reported; scheme: what to assume when it reported no background
 * @returns {{ mode: string, scheme: string, known: boolean, rgb: Record<string, number[]>, styles: Record<string, string> | undefined }}
 *   rgb: every colour by name; styles: the SGR codes for text.mjs, or undefined with mode "none"
 */
export function makeTheme({ mode = "none", background, foreground, scheme } = {}) {
	const known = background !== undefined;
	const kind = known ? schemeOf(background) : (scheme ?? "dark");
	const dark = kind === "dark";
	const bgRgb = background ?? DEFAULTS[kind].bg;
	// A text colour reported for the other kind of background is not used with a background that was only assumed.
	const fgRgb = foreground !== undefined && (known || schemeOf(foreground) !== kind) ? foreground : DEFAULTS[kind].fg;
	const bg = rgbColor(...bgRgb);
	const fg = rgbColor(...fgRgb);
	const out = (color) => {
		const { r, g, b } = colorToRgb(color);
		return [Math.round(r), Math.round(g), Math.round(b)];
	};
	// Mixed as light is mixed, in sRGB: between a near-white and a hue, the way round the colour wheel would pass
	// through hues that belong to neither.
	const toward = (from, to, amount) => out(mixColors(from, to, amount, "srgb"));
	// One lightness and one strength for every hue: light on dark, dark on light.
	const accent = (hue, strength = 1) => oklchColor(dark ? 0.8 : 0.5, (dark ? 0.115 : 0.135) * strength, hue);
	const hue = Object.fromEntries(Object.entries(HUES).map(([name, degrees]) => [name, accent(degrees)]));

	const fgs = {
		// How much it matters.
		muted: toward(fg, bg, 0.32),
		faint: toward(fg, bg, 0.54),
		// Whose it is.
		user: out(hue.user),
		tool: out(hue.tool),
		note: toward(hue.note, bg, 0.3),
		carto: toward(fg, hue.user, 0.45),
		ok: out(hue.ok),
		warn: out(hue.warn),
		err: out(hue.err),
		link: out(hue.user),
		heading: out(hue.user),
		code: out(hue.tool),
		// The terminal's colour names, for what still uses them, in the palette's own lightness and strength.
		red: out(hue.err),
		green: out(hue.ok),
		yellow: out(hue.warn),
		blue: out(hue.user),
		magenta: out(hue.note),
		cyan: out(hue.tool),
		grey: toward(fg, bg, 0.54),
		...Object.fromEntries(Object.entries(CATEGORY_HUES).map(([name, degrees]) => [name, out(accent(degrees, 1.1))])),
		catCarto: toward(fg, bg, 0.6),
		catResult: toward(fg, bg, 0.18),
	};
	// A theme whose text is not far from its background has less room for blocks between the two: the steps shrink
	// with it, so that text on a block stays as readable as the theme lets it be anywhere.
	const luma = ([r, g, b]) => (r * 299 + g * 587 + b * 114) / 1000;
	const room = Math.max(0.45, Math.min(1, Math.abs(luma(fgRgb) - luma(bgRgb)) / 185));
	const bgs = {
		// Whose block it is: the hue, faintly.
		bgUser: toward(bg, hue.user, (dark ? 0.17 : 0.13) * room),
		bgTool: toward(bg, hue.tool, (dark ? 0.095 : 0.08) * room),
		bgNote: toward(bg, hue.note, 0.045 * room),
		// Where it is: the background, a step toward the text.
		bgPanel: toward(bg, fg, 0.06),
		bgInput: toward(bg, fg, 0.045),
		bgBar: toward(bg, fg, 0.105),
		// What is selected, and the tab that shows.
		bgSel: toward(bg, hue.user, (dark ? 0.34 : 0.26) * room),
		bgTab: toward(bg, hue.user, (dark ? 0.5 : 0.4) * room),
	};
	const rgb = { bg: bgRgb, fg: fgRgb, ...fgs, ...bgs, chip: out(hue.warn) };
	if (mode !== "truecolor" && mode !== "256") return { mode: "none", scheme: kind, known, rgb, styles: undefined };
	const code = (layer, [r, g, b]) => (mode === "truecolor" ? `${layer};2;${r};${g};${b}` : `${layer};5;${to256(r, g, b)}`);
	const styles = {};
	for (const [name, value] of Object.entries(fgs)) styles[name] = code(38, value);
	for (const [name, value] of Object.entries(bgs)) styles[name] = code(48, value);
	styles.link = `${styles.link};4`;
	styles.heading = `${styles.heading};1`;
	styles.bgTab = `${styles.bgTab};1`;
	// The mode's name: the one filled, saturated shape, with the background's colour as its text.
	styles.chip = `${code(48, out(hue.warn))};${code(38, bgRgb)};1`;
	return { mode, scheme: kind, known, rgb, styles };
}

/** The theme functions pi-tui's Markdown wants, made of the palette's codes. Each switches off only what it switched on. */
export function markdownTheme(styles) {
	const wrap = (on, off) => (on === undefined || on === "" ? (text) => text : (text) => `\x1b[${on}m${text}\x1b[${off}m`);
	const color = (name) => wrap(styles?.[name]?.split(";").filter((_, index, all) => !(all.at(-1) === "1" || all.at(-1) === "4") || index < all.length - 1).join(";") ?? { tool: "36", user: "36", faint: "2", muted: "2", code: "36", heading: "", link: "36" }[name], styles === undefined && (name === "faint" || name === "muted") ? "22" : "39");
	const bold = wrap("1", "22");
	return {
		heading: (text) => bold(color("heading")(text)),
		link: wrap("4", "24"),
		linkUrl: color("faint"),
		code: color("code"),
		codeBlock: color("code"),
		codeBlockBorder: color("faint"),
		quote: wrap("3", "23"),
		quoteBorder: color("faint"),
		hr: color("faint"),
		listBullet: color("user"),
		bold,
		italic: wrap("3", "23"),
		strikethrough: wrap("9", "29"),
		underline: wrap("4", "24"),
	};
}
