// The vocabulary shared by Cartographer's full-screen shell and components.
//
// A token says what a colour, surface, or emphasis means. Theme generation decides how that meaning is represented
// in truecolor, 256-colour, and no-colour terminals. Feature renderers may retain their former style names while
// Phase 5 moves them one surface at a time; `withCompatibilityAliases` keeps those names tied to this vocabulary.

const frozen = (value) => Object.freeze(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export const TOKEN = frozen({
	surface: frozen({
		canvas: "surface.canvas",
		content: "surface.content",
		raised: "surface.raised",
		input: "surface.input",
		overlay: "surface.overlay",
	}),
	text: frozen({
		primary: "text.primary",
		secondary: "text.secondary",
		muted: "text.muted",
		inverse: "text.inverse",
		link: "text.link",
		heading: "text.heading",
		code: "text.code",
	}),
	border: frozen({
		subtle: "border.subtle",
		strong: "border.strong",
		focus: "border.focus",
	}),
	interaction: frozen({
		focus: "interaction.focus",
		selected: "interaction.selected",
		active: "interaction.active",
		disabled: "interaction.disabled",
		loading: "interaction.loading",
		stale: "interaction.stale",
		chip: "interaction.chip",
	}),
	feedback: frozen({
		success: "feedback.success",
		warning: "feedback.warning",
		danger: "feedback.danger",
		info: "feedback.info",
	}),
	activity: frozen({
		user: "activity.user",
		agent: "activity.agent",
		shell: "activity.shell",
		note: "activity.note",
		userSurface: "activity.user.surface",
		shellSurface: "activity.shell.surface",
		noteSurface: "activity.note.surface",
	}),
	domain: frozen({
		diff: frozen({
			added: "diff.added",
			removed: "diff.removed",
			changed: "diff.changed",
		}),
		context: frozen({
			system: "context.system",
			tools: "context.tools",
			top: "context.top",
			kept: "context.kept",
			user: "context.user",
			cartographer: "context.cartographer",
			agent: "context.agent",
			result: "context.result",
			state: "context.state",
			windows: "context.windows",
		}),
	}),
	emphasis: frozen({
		normal: "emphasis.normal",
		dim: "emphasis.dim",
		strong: "emphasis.strong",
		italic: "emphasis.italic",
		underline: "emphasis.underline",
		inverse: "emphasis.inverse",
	}),
});

/** Shared layout measurements. Components may collapse an inset at narrow widths but do not invent new spacing scales. */
export const LAYOUT = frozen({
	space: frozen({ "1": 1, "2": 2, "3": 3, "4": 4 }),
	gutter: frozen({ narrow: 0, compact: 1, regular: 2, wide: 4, expanded: 6 }),
	pageInset: 2,
	compactInset: 1,
});

/** Join semantic style tokens for text.mjs's span renderer without creating empty words. */
export const tokenStyle = (...tokens) => tokens.flat().filter((token) => typeof token === "string" && token !== "").join(" ");

/**
 * Transitional style names used by established feature views. New shell/components use TOKEN; an alias remains only
 * while a proven renderer consumer still needs it.
 */
export const LEGACY_STYLE_ALIASES = frozen({
	bg: TOKEN.surface.canvas,
	fg: TOKEN.text.primary,
	dim: TOKEN.emphasis.dim,
	bold: TOKEN.emphasis.strong,
	italic: TOKEN.emphasis.italic,
	under: TOKEN.emphasis.underline,
	inverse: TOKEN.emphasis.inverse,
	red: TOKEN.feedback.danger,
	green: TOKEN.feedback.success,
	yellow: TOKEN.feedback.warning,
	blue: TOKEN.feedback.info,
	magenta: TOKEN.activity.note,
	cyan: TOKEN.activity.shell,
	grey: TOKEN.text.muted,
	lred: TOKEN.feedback.danger,
	lgreen: TOKEN.feedback.success,
	lyellow: TOKEN.feedback.warning,
	lblue: TOKEN.feedback.info,
	lmagenta: TOKEN.activity.note,
	lcyan: TOKEN.activity.shell,
	muted: TOKEN.text.secondary,
	faint: TOKEN.text.muted,
	user: TOKEN.activity.user,
	tool: TOKEN.activity.shell,
	note: TOKEN.activity.note,
	carto: TOKEN.activity.agent,
	ok: TOKEN.feedback.success,
	warn: TOKEN.feedback.warning,
	err: TOKEN.feedback.danger,
	link: TOKEN.text.link,
	heading: TOKEN.text.heading,
	code: TOKEN.text.code,
	bgUser: TOKEN.activity.userSurface,
	bgTool: TOKEN.activity.shellSurface,
	bgNote: TOKEN.activity.noteSurface,
	chip: TOKEN.interaction.chip,
});

/** The semantic token behind a former one-word style name; unknown names remain available to pi-tui extensions. */
export const canonicalToken = (name) => (typeof name === "string" ? LEGACY_STYLE_ALIASES[name] ?? name : name);

/**
 * Add legacy names for a semantic value map. A caller may also supply an old key (useful for transitional tests or
 * third-party parts); it becomes the equivalent semantic value before aliases are rebuilt.
 * @template T
 * @param {Record<string, T>} values
 * @returns {Record<string, T>}
 */
export function withCompatibilityAliases(values = {}, { preferLegacy = false } = {}) {
	const source = values !== null && typeof values === "object" ? values : {};
	const canonical = { ...source };
	for (const [legacy, token] of Object.entries(LEGACY_STYLE_ALIASES)) {
		if (!own(canonical, token) && own(source, legacy)) canonical[token] = source[legacy];
	}
	const result = { ...canonical };
	for (const [legacy, token] of Object.entries(LEGACY_STYLE_ALIASES)) {
		if (own(canonical, token) && (!preferLegacy || !own(source, legacy))) result[legacy] = canonical[token];
	}
	return result;
}
