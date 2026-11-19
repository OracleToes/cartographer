// The parts of the full screen, as pi-tui components.
//
// pi-tui lays the screen out, scrolls it, reads the keys and the mouse, and writes only the rows that changed. A
// part here is what pi-tui calls a component: it is asked for its lines at a width, and may be told of a click.
// What the lines say comes from the models (chat.mjs, workspace.mjs, review.mjs, runtime.mjs, list.mjs) and how
// they are coloured from the palette (theme.mjs); a part only fits the two to the screen: the margin, the background of a block, the mark
// of what is selected.
//
// Every row is the margin, the cells between the margins, and the margin again. A row of content has its block's
// background between the margins; a row of chrome (the tabs, the strip, the place to type) has it edge to edge.
import { CURSOR_MARKER, Editor, renderFakeCursor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { POLICY } from "../config.mjs";
import { cut, paint, paintStyled, sgr, width as cells, wrap } from "./text.mjs";
import { LAYOUT, TOKEN } from "./tokens.mjs";

/**
 * Empty cells at the left and right edge of the screen. Wide terminals get a calmer reading column; narrow ones
 * give those cells back to the content instead of making every row feel needlessly cramped.
 */
export const marginOf = (width) => {
	if (width < 36) return LAYOUT.gutter.narrow;
	if (width < 72) return LAYOUT.gutter.compact;
	if (width < 120) return LAYOUT.gutter.regular;
	if (width < 160) return LAYOUT.gutter.wide;
	return LAYOUT.gutter.expanded;
};
/** From how many rows on the screen has an empty row under the tabs, above the strip and under what is typed. */
export const AIRY_ROWS = POLICY.limits.screen.airyRows;


const widthOf = (text) => visibleWidth(text);
const BLOCK_RAILS = {
	[TOKEN.activity.userSurface]: ["▎", TOKEN.activity.user],
	[TOKEN.activity.shellSurface]: ["│", TOKEN.activity.shell],
	[TOKEN.activity.noteSurface]: ["┊", TOKEN.activity.note],
	// Chat has not migrated these three activity blocks yet, so their retained aliases keep its identity rails intact.
	bgUser: ["▎", TOKEN.activity.user],
	bgTool: ["│", TOKEN.activity.shell],
	bgNote: ["┊", TOKEN.activity.note],
};
const EMPTY_RAIL = [" ", ""];
const TAB_BRAND = " Cartographer ";
const VIEW_PREFIX = " views ";
const COMPACT_VIEW_NAMES = {
	"Current shared brain": "Brain",
	"Last step": "Last",
	"This session": "Session",
	"git HEAD": "HEAD",
	"Latest sent": "Latest",
	"Main sent": "Main",
	"Raw payload": "Raw",
	"Next preview": "Preview",
	"Current accounting": "Accounting",
};
const ROOMY_VIEW_NAV = { compact: false, separator: " · ", switchHint: "  [ ] switch" };
const COMPACT_VIEW_NAV = { compact: true, separator: "·", switchHint: " [ ]" };
const tabLabels = (tabs, compact = false) =>
	tabs.map((tab, index) => (compact ? ` ${index + 1} ` : ` ${index + 1} ${tab.name} `));
const labelsWidth = (labels) => labels.reduce((sum, label) => sum + widthOf(label), 0);
const compactViewName = (view) => COMPACT_VIEW_NAMES[view.name] ?? view.name;
const viewLabel = (view, compact) => ` ${compact ? compactViewName(view) : view.name} `;
const viewNavigationWidth = (views, layout) =>
	widthOf(VIEW_PREFIX) +
	widthOf(layout.switchHint) +
	views.reduce(
		(sum, view, index) => sum + widthOf(viewLabel(view, layout.compact)) + (index === 0 ? 0 : widthOf(layout.separator)),
		0,
	);
function viewNavigation(views, inner) {
	if (viewNavigationWidth(views, ROOMY_VIEW_NAV) <= inner) return ROOMY_VIEW_NAV;
	if (viewNavigationWidth(views, COMPACT_VIEW_NAV) <= inner) return COMPACT_VIEW_NAV;
	return undefined;
}
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** The code-unit offset where the grapheme before `at` starts: edits never cut a sign in two. */
const beforeAt = (text, at) => {
	let prev = 0;
	for (const { index } of SEGMENTER.segment(text)) {
		if (index >= at) break;
		prev = index;
	}
	return prev;
};
/** The code-unit offset where the grapheme at `at` ends. */
const afterAt = (text, at) => {
	for (const { index } of SEGMENTER.segment(text)) if (index > at) return index;
	return text.length;
};
/** Rows of at most `columns` cells: broken at a space where one fits, else hard-broken. Ranges are offsets into `text`. */
const rowsOf = (text, columns) => {
	const rows = [];
	let rowStart = 0;
	let cells = 0;
	let breakAt = -1;
	let breakCells = 0;
	for (const { index, segment } of SEGMENTER.segment(text)) {
		if (segment === "\n") {
			rows.push({ start: rowStart, end: index });
			rowStart = index + 1;
			cells = 0;
			breakAt = -1;
			continue;
		}
		const w = widthOf(segment);
		if (cells !== 0 && cells + w > columns) {
			if (breakAt > rowStart) {
				rows.push({ start: rowStart, end: breakAt });
				cells -= breakCells;
				rowStart = breakAt;
			} else {
				rows.push({ start: rowStart, end: index });
				cells = 0;
				rowStart = index;
			}
			breakAt = -1;
		}
		cells += w;
		if (segment === " ") {
			breakAt = index + 1;
			breakCells = cells;
		}
	}
	rows.push({ start: rowStart, end: text.length });
	return rows;
};
/** The code-unit offset in `text` that sits `want` cells into the row starting at `start`. */
const offsetAtCells = (text, start, want) => {
	let at = start;
	let cells = 0;
	for (const { index, segment } of SEGMENTER.segment(text.slice(start))) {
		const w = widthOf(segment);
		if (cells + w > want) break;
		cells += w;
		at = start + index + segment.length;
		if (cells === want) break;
	}
	return at;
};

const edge = (width, bg = "") => paint([], marginOf(width), bg);
/** A row of chrome: its background runs over the margins. */
export const barRow = (spans, width, bg) => `${edge(width, bg)}${paint(spans, width - 2 * marginOf(width), bg)}${edge(width, bg)}`;
/** A row of content: a line of a model, on its block's background or on the mark of what is selected. */
export function contentRow(line, width, chosen = false) {
	const inner = width - 2 * marginOf(width);
	if (line === undefined) return " ".repeat(width);
	if (line.styled !== undefined) return `${edge(width)}${paintStyled(line.styled, line.cells, inner, chosen ? TOKEN.interaction.selected : "")}${edge(width)}`;
	// A block gets one quiet, consistent rail. It groups a multi-line message without making every line compete for
	// attention: your words have a blue edge, tool work a teal one, and private notes a violet one.
	const rail = line.pad ? (BLOCK_RAILS[line.bg] ?? EMPTY_RAIL) : undefined;
	const spans = rail === undefined ? line.spans : [rail, ...line.spans];
	const background = chosen ? TOKEN.interaction.selected : (line.bg ?? "");
	return `${edge(width)}${paint(spans, inner, background)}${edge(width)}`;
}
/** A line that pi-tui will take: never wider than it was asked for, whatever went into it. */
const safe = (line, width) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line);
/**
 * A part's lines, or one line that says what went wrong: a part that throws would take the screen with it. With
 * `exact`, the part answers for the width of its lines itself (it fits each line once, when it paints it).
 */
function guarded(width, make, exact = false) {
	try {
		const lines = make();
		return exact ? lines : lines.map((line) => safe(line, width));
	} catch (error) {
		return [safe(paint([[`! this part of the screen could not be drawn: ${error?.message ?? error}`, "warn"]], width), width)];
	}
}

/** The row of tabs. `ui.tabs` is [{ id, name }], `ui.state.tab` the one that shows. */
export class TabBar {
	constructor(ui) {
		this.ui = ui;
		this.spans = [];
	}
	invalidate() {}
	render(width) {
		return guarded(width, () => {
			const { ui } = this;
			const inner = width - 2 * marginOf(width);
			const full = tabLabels(ui.tabs);
			const compact = tabLabels(ui.tabs, true);
			const fullWidth = labelsWidth(full);
			const brandWidth = widthOf(TAB_BRAND);
			// The product name is useful orientation when there is room. On smaller terminals, preserve the tab names;
			// if those do not fit either, the numbered tabs stay whole rather than being cut halfway through a name.
			const showBrand = brandWidth + 1 + fullWidth <= inner;
			const labels = fullWidth <= inner ? full : compact;
			const spans = [];
			this.spans = [];
			let x = 0;
			if (showBrand) {
				spans.push([TAB_BRAND, "carto bold"]);
				x += brandWidth;
				spans.push([" ", ""]);
				x++;
			}
			for (const [index, tab] of ui.tabs.entries()) {
				const label = labels[index];
				const cells = widthOf(label);
				this.spans.push({ id: tab.id, from: marginOf(width) + x, to: marginOf(width) + x + cells });
				spans.push([label, tab.id === ui.state.tab ? TOKEN.interaction.active : TOKEN.text.secondary]);
				x += cells;
			}
			return [barRow(spans, width, TOKEN.surface.raised)];
		});
	}
	handleMouse(event) {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const tab = this.spans.find((entry) => event.x >= entry.from && event.x < entry.to);
		if (tab !== undefined) this.ui.setTab(tab.id);
		return { handled: true };
	}
}

/** The row of views inside a tab, and the file the editor door opens, when it fits. */
export class ViewBar {
	constructor(ui) {
		this.ui = ui;
		this.spans = [];
	}
	invalidate() {}
	render(width) {
		return guarded(width, () => {
			const { ui } = this;
			const views = ui.views();
			const inner = width - 2 * marginOf(width);
			if (views.length === 0) return [barRow([], width, TOKEN.surface.content)];
			const active = views.find((view) => view.id === ui.view()) ?? views[0];
			const layout = viewNavigation(views, inner);
			const file = ui.fileHint();
			const fileHint = file === undefined ? "" : ` · ${file}`;
			const spans = [[VIEW_PREFIX, "faint"]];
			this.spans = [];
			let x = widthOf(VIEW_PREFIX);
			if (layout !== undefined) {
				for (const [index, view] of views.entries()) {
					if (index > 0) {
						spans.push([layout.separator, "faint"]);
						x += widthOf(layout.separator);
					}
					const label = viewLabel(view, layout.compact);
					const cells = widthOf(label);
					this.spans.push({ id: view.id, from: marginOf(width) + x, to: marginOf(width) + x + cells });
					spans.push([label, view.id === active.id ? "user bold under" : "muted"]);
					x += cells;
				}
				spans.push([layout.switchHint, "faint"]);
				x += widthOf(layout.switchHint);
				// The file goes in only whole; a hint cut in half says where e goes nowhere.
				if (fileHint !== "" && x + widthOf(fileHint) <= inner) spans.push([fileHint, "faint"]);
			} else {
				// At a narrow width, one clear current view beats a ragged, half-visible row of alternatives. The
				// persistent [ ] cue keeps the complete view switcher discoverable without pretending hidden labels fit.
				const room = Math.max(1, inner - x - widthOf(COMPACT_VIEW_NAV.switchHint) - 2);
				const label = ` ${cut(compactViewName(active), room)} `;
				const cells = widthOf(label);
				this.spans.push({ id: active.id, from: marginOf(width) + x, to: marginOf(width) + x + cells });
				spans.push([label, "user bold under"]);
				spans.push([COMPACT_VIEW_NAV.switchHint, "faint"]);
			}
			return [barRow(spans, width, TOKEN.surface.content)];
		});
	}
	handleMouse(event) {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const view = this.spans.find((entry) => event.x >= entry.from && event.x < entry.to);
		if (view !== undefined) this.ui.setView(view.id);
		return { handled: true };
	}
}

/** An empty row. */
export class Air {
	invalidate() {}
	render(width) {
		return [" ".repeat(width)];
	}
}

/**
 * The Chat tab: the lines of the conversation (src/screen/chat.mjs), all of them; the scroll view around this
 * part shows the ones in view.
 */
export class ChatBody {
	constructor(ui) {
		this.ui = ui;
		this.cols = 80;
		this.made = undefined; // the model's lines, and for which state of the model they were made
		this.painted = undefined;
		this.lead = 0; // empty rows above a conversation that is shorter than its window
		this.rows = 0; // the height of the window the lead was made for
	}
	invalidate() {
		this.made = undefined;
		this.painted = undefined;
	}
	/** The model's lines at the width last drawn. */
	lines() {
		const { chat } = this.ui;
		const projection = this.ui.chatProjection();
		if (this.made === undefined || this.made.version !== chat.version || this.made.cols !== this.cols || this.made.projection !== projection) this.made = { version: chat.version, cols: this.cols, projection, lines: chat.lines(this.cols, projection) };
		return this.made.lines;
	}
	/** How many empty rows stand above the conversation as it is now. */
	leadNow() {
		return Math.max(0, this.ui.chatRows() - this.lines().length);
	}
	render(width) {
		return guarded(width, () => {
			const { ui } = this;
			this.cols = Math.max(8, width - 2 * marginOf(width));
			const lines = this.lines();
			const chosen = ui.state.mode === "command" ? ui.state.selected : undefined;
			// A short conversation stands at the bottom of its window, next to where it is continued.
			this.rows = ui.chatRows();
			this.lead = Math.max(0, this.rows - lines.length);
			const key = `${ui.chat.version}|${ui.chatProjection()}|${width}|${chosen ?? ""}|${ui.themeVersion()}|${this.lead}`;
			if (this.painted?.key !== key) {
				// A line is painted once and kept with it: the model keeps the lines of what did not change.
				const how = `${width}|${ui.themeVersion()}`;
				const row = (line) => {
					const marked = chosen !== undefined && ui.stopOf(line) === chosen;
					if (line.paint?.how !== how || line.paint.marked !== marked) line.paint = { how, marked, text: safe(contentRow(line, width, marked), width) };
					return line.paint.text;
				};
				this.painted = { key, rows: [...Array.from({ length: this.lead }, () => " ".repeat(width)), ...lines.map(row)] };
			}
			return this.painted.rows;
		}, true);
	}
	handleMouse(event) {
		// A press that becomes a drag selects text, which is pi-tui's; a click is ours.
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.ui.clickChat(event.y - this.lead);
		return { handled: true };
	}
}

/** One view of tabs 2 to 5: the lines of a list of items that fold (src/screen/list.mjs). */
export class ListBody {
	constructor(ui, list) {
		this.ui = ui;
		this.list = list;
		this.cols = 80;
		this.painted = undefined;
	}
	invalidate() {
		this.painted = undefined;
	}
	render(width) {
		return guarded(width, () => {
			const { ui, list } = this;
			this.cols = Math.max(8, width - 2 * marginOf(width));
			const chosen = ui.state.mode === "command" ? list.selected()?.key : undefined;
			const key = `${list.version}|${width}|${chosen ?? ""}|${ui.themeVersion()}`;
			if (this.painted?.key !== key) this.painted = { key, rows: list.lines(this.cols).map((line) => safe(contentRow(line, width, chosen !== undefined && line.key === chosen && line.head === true), width)) };
			return this.painted.rows;
		}, true);
	}
	handleMouse(event) {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.ui.clickList(this.list, event.y);
		return { handled: true };
	}
}

/** The strip: what the agent is doing, shared state, and the current key reminder. `ui.status()` gives its rows as spans. */
export class Strip {
	constructor(ui) {
		this.ui = ui;
	}
	invalidate() {}
	render(width) {
		return guarded(width, () => {
			// The strip reads from now to later: immediate activity, quieter shared state, then the key reminder next
			// to the input. Giving those rows descending chrome makes the information order visible without extra rules.
			const grounds = [TOKEN.surface.raised, TOKEN.surface.content, TOKEN.surface.content, TOKEN.surface.input];
			return this.ui.status(width).map((spans, index) => barRow(spans, width, grounds[index] ?? TOKEN.surface.content));
		});
	}
}

/** What the editor's two borders are replaced by, so that they can be told from the lines of text. */
const BORDER = "\x00border";

/**
 * The place to type: pi-tui's editor, with a prompt in front, on the input's background, and without its two
 * rules. In the commands mode it is one line that says so, and nothing can be typed.
 *
 * The editor gives its lines as: a border, the lines of text, a border, and then the list of completions when one
 * is open. Here the first border is left out, unless text is hidden above it, and the second becomes the row under
 * the text: a hint when there are several lines, otherwise empty.
 */
export class Prompt extends Editor {
	constructor(tui, theme, ui) {
		super(tui, theme, { paddingX: 0 });
		this.ui = ui;
		this.offset = { x: 0, y: 0 };
	}
	renderTopBorder(_width, hidden) {
		return `${BORDER}${hidden > 0 ? hidden : ""}`;
	}
	renderBottomBorder(_width, hidden) {
		return `${BORDER}${hidden > 0 ? hidden : ""}`;
	}
	render(width) {
		return guarded(width, () => {
			const { ui } = this;
			const airy = this.tui.terminal.rows >= AIRY_ROWS;
			const blank = barRow([], width, TOKEN.surface.input);
			if (ui.state.mode === "command") return [barRow(ui.commandLine(), width, TOKEN.surface.input), ...(airy ? [blank] : [])];
			const margin = marginOf(width);
			const inner = width - 2 * margin;
			const { text: prompt, style } = ui.prompt();
			const lead = cells(prompt);
			const pad = " ".repeat(lead);
			const bg = sgr(TOKEN.surface.input);
			const left = `${edge(width, TOKEN.surface.input)}${bg}`;
			const right = `\x1b[0m${edge(width, TOKEN.surface.input)}`;
			const rows = [];
			let part = "above"; // above the text, in it, or below it (the completions)
			let first = true;
			this.offset = { x: margin + lead, y: 1 };
			// For a click on a completion: on which row the list starts here, and how many rows the editor counts above it.
			this.listAt = undefined;
			let textRows = 0;
			const empty = this.getText() === "";
			for (const line of super.render(Math.max(4, inner - lead))) {
				if (line.startsWith(BORDER)) {
					const hidden = line.slice(BORDER.length);
					if (part === "above") {
						part = "text";
						if (hidden !== "") {
							rows.push(barRow([[pad, ""], [`↑ ${hidden} more rows`, "faint"]], width, TOKEN.surface.input));
							this.offset.y = 0;
						}
					} else {
						part = "below";
						const count = this.getLines().length;
						if (hidden !== "") rows.push(barRow([[pad, ""], [`↓ ${hidden} more rows`, "faint"]], width, TOKEN.surface.input));
						else if (count > 1) rows.push(barRow([[pad, ""], [`${count} lines · Enter sends them as one message · Alt-Enter adds a line`, "faint"]], width, TOKEN.surface.input));
						else if (airy) rows.push(blank);
					}
					continue;
				}
				if (part === "below") {
					// A row of the list of completions, on a panel of its own, in line with what is typed.
					this.listAt ??= { row: rows.length, editorRow: textRows + 2 };
					const row = truncateToWidth(line, Math.max(1, inner - 2), "");
					rows.push(`${edge(width, TOKEN.surface.content)}${sgr(TOKEN.surface.content)}  ${row}${sgr(TOKEN.surface.content)}${" ".repeat(Math.max(0, inner - 2 - visibleWidth(row)))}\x1b[0m${edge(width, TOKEN.surface.content)}`);
					continue;
				}
				const head = first ? `${sgr(style)}${prompt}\x1b[22;39m` : pad;
				if (first && empty) {
					// Nothing typed: the cursor, and after it what could be typed, faintly.
					const hint = cut(ui.placeholder(), Math.max(0, inner - lead - 2));
					const cursor = `${this.focused ? CURSOR_MARKER : ""}${renderFakeCursor(" ")}`;
					rows.push(`${left}${head}${cursor}${sgr("faint")}${hint}\x1b[22;39m${" ".repeat(Math.max(0, inner - lead - 1 - cells(hint)))}${right}`);
				} else rows.push(`${left}${head}${line}${" ".repeat(Math.max(0, inner - lead - visibleWidth(line)))}${right}`);
				first = false;
				textRows++;
			}
			return rows;
		});
	}
	handleMouse(event) {
		if (this.ui.state.mode === "command") {
			if (event.type === "click" && event.button === "left") this.ui.setMode("type");
			return { handled: true };
		}
		// The editor places the cursor where it is clicked, and takes a click on a completion; it counts rows from
		// its own first border, and columns from its own first.
		if (this.listAt !== undefined && event.y >= this.listAt.row) return super.handleMouse({ ...event, x: Math.max(0, event.x - marginOf(event.width) - 2), y: this.listAt.editorRow + (event.y - this.listAt.row) });
		return super.handleMouse({ ...event, x: event.x - this.offset.x, y: event.y + this.offset.y });
	}
}

/**
 * A sheet laid over the screen: a title, text that scrolls, and how to close it. For what is worth reading and not
 * worth keeping, such as the list of keys.
 */
export class Sheet {
	/** @param {{ title: string, text: string, rows: () => number, close: () => void, keyOf: (data: string) => string | undefined }} given  rows: how many rows the screen has */
	constructor(given) {
		this.given = given;
		this.top = 0;
		this.capturesViewportInput = true;
	}
	invalidate() {}
	body(width) {
		const inner = Math.max(10, width - 6);
		const lines = [];
		for (const line of this.given.text.split("\n")) {
			// A line that is not indented is a heading. A line of two columns, a key and what it does, keeps its
			// second column when it runs over.
			const style = line !== "" && !line.startsWith(" ") ? "heading" : "";
			const columns = /^(\s+\S.*?\s{2,})(\S.*)$/.exec(line);
			if (columns !== null && columns[1].length < inner - 16) {
				const rest = wrap(columns[2], inner - columns[1].length);
				lines.push([[columns[1], "user"], [rest[0], ""]]);
				for (const more of rest.slice(1)) lines.push([[" ".repeat(columns[1].length), ""], [more, ""]]);
			} else for (const piece of wrap(line, inner)) lines.push([[piece, style]]);
		}
		return lines;
	}
	render(width) {
		return guarded(width, () => {
			const lines = this.body(width);
			// The sheet leaves the strip and the place to type in view below it.
			const room = Math.max(3, this.given.rows() - 11);
			this.page = room;
			this.most = Math.max(0, lines.length - room);
			this.top = Math.max(0, Math.min(this.top, this.most));
			const row = (spans) => paint([["   ", ""], ...spans], width, TOKEN.surface.content);
			const more = lines.length > room ? `   ${this.top + 1}–${Math.min(lines.length, this.top + room)} of ${lines.length} · j k scroll` : "";
			return [row([]), row([[this.given.title, "user bold"], [`${more}   Esc closes`, "faint"]]), row([]), ...lines.slice(this.top, this.top + room).map(row), row([])];
		});
	}
	handleInput(data) {
		const key = this.given.keyOf(data);
		const by = { j: 1, down: 1, k: -1, up: -1, " ": this.page - 1, pageDown: this.page - 1, "ctrl+d": Math.ceil(this.page / 2), "ctrl+f": this.page - 1, pageUp: -(this.page - 1), "ctrl+u": -Math.ceil(this.page / 2), "ctrl+b": -(this.page - 1), g: -1e9, home: -1e9, G: 1e9, end: 1e9 }[key];
		if (by !== undefined) this.top = Math.max(0, Math.min(this.most ?? 0, this.top + by));
		else this.given.close();
	}
	handleMouse(event) {
		if (event.type === "wheel") {
			this.top = Math.max(0, Math.min(this.most ?? 0, this.top + (event.wheelDelta ?? 0)));
			return { handled: true };
		}
		return { handled: true };
	}
}

/**
 * The shared form a field of a book or of the graph is edited in: the field's label, how much of it is used — live,
 * `n / limit` — and the most it may hold. Nothing past the limit goes in, typed or pasted. `Enter` saves a one-line
 * field; a field that holds a long text lets `Enter` end a line and `Ctrl-Enter` save. `Tab` moves through the fields
 * of the row and the drafts ride along until `Esc`. The screen is one more client of the same operations the
 * agent uses: `save(drafts)` flashes what was saved or the refusal, and says whether it was saved. A save may
 * settle asynchronously; the box keeps its drafts and makes its pending state plain until the result arrives.
 *
 * `required`, `disabled`, `help`, and a synchronous field `validate(value, drafts)` are optional shared field
 * metadata. They improve local correction only; the application action remains the authority for every durable rule.
 */
export class Form {
	static VISIBLE = 6;
	/**
	 * @param {{ title: string, fields: { id: string, label: string, limit: number, multiline?: boolean, value?: string, required?: boolean, disabled?: boolean, help?: string, validate?: (value: string, drafts: Map<string, string>) => string | { message?: string } | boolean | undefined }[],
	 *   keyOf: (data: string) => string | undefined, save: (drafts: Map<string, string>) => boolean | Promise<boolean>, close: () => void, flash: (text: string) => void, redraw?: () => void, validate?: (drafts: Map<string, string>) => string | { field?: string, message?: string } | boolean | undefined }} given
	 *   `save` flashes the outcome itself and says whether the drafts were kept; a false means the box stays open.
	 */
	constructor(given) {
		if (given === null || typeof given !== "object" || !Array.isArray(given.fields) || given.fields.length === 0) throw new TypeError("A form needs one or more fields.");
		this.given = given;
		this.capturesViewportInput = true;
		this.index = given.fields.findIndex((field) => field.disabled !== true);
		if (this.index < 0) this.index = 0;
		this.drafts = given.fields.map((field) => field.value ?? "");
		this.cursors = given.fields.map((_, at) => given.fields[at].value?.length ?? 0);
		this.scrolls = given.fields.map(() => 0);
		this.errors = new Map();
		this.inner = 60;
		this.saving = false;
	}
	get field() {
		return this.given.fields[this.index];
	}
	get text() {
		return this.drafts[this.index];
	}
	set text(value) {
		this.drafts[this.index] = value;
		this.errors.delete(this.field.id);
	}
	get error() {
		return this.errors.get(this.field.id);
	}
	editable() {
		return this.given.fields.flatMap((field, index) => field.disabled === true ? [] : [index]);
	}
	moveField(by) {
		const editable = this.editable();
		if (editable.length < 2) return false;
		const at = editable.indexOf(this.index);
		this.index = editable[(at < 0 ? 0 : at + by + editable.length) % editable.length];
		this.follow();
		return true;
	}
	draftMap() {
		return new Map(this.given.fields.map((field, at) => [field.id, this.drafts[at]]));
	}
	/** Validate local field affordances without duplicating the application's durable validation. */
	validateDrafts() {
		const drafts = this.draftMap();
		const errors = new Map();
		const errorFor = (field, outcome, fallback) => {
			if (outcome === undefined || outcome === true) return;
			if (outcome !== null && typeof outcome === "object" && typeof outcome.then === "function") throw new TypeError("Form validation must settle synchronously.");
			const message = typeof outcome === "string" ? outcome.trim() : typeof outcome?.message === "string" ? outcome.message.trim() : outcome === false ? fallback : "";
			if (message !== "") errors.set(field.id, message);
		};
		for (const [at, field] of this.given.fields.entries()) {
			if (field.disabled === true) continue;
			const value = this.drafts[at];
			if (field.required === true && String(value).trim() === "") errorFor(field, false, `${field.label} is required.`);
			else if (typeof field.validate === "function") {
				try { errorFor(field, field.validate(value, drafts), `${field.label} is invalid.`); }
				catch (error) { errorFor(field, `Could not validate ${field.label}: ${error?.message ?? error}`, ""); }
			}
		}
		if (errors.size === 0 && typeof this.given.validate === "function") {
			try {
				const outcome = this.given.validate(drafts);
				const field = typeof outcome?.field === "string" ? this.given.fields.find((entry) => entry.id === outcome.field) ?? this.field : this.field;
				errorFor(field, outcome, "This form is not ready to save.");
			} catch (error) {
				errorFor(this.field, `Could not validate this form: ${error?.message ?? error}`, "");
			}
		}
		this.errors = errors;
		if (errors.size === 0) return drafts;
		const first = this.given.fields.findIndex((field) => errors.has(field.id));
		if (first >= 0) {
			this.index = first;
			this.follow();
		}
		this.given.flash(errors.get(this.field.id) ?? "Correct the marked field before saving.");
		this.given.redraw?.();
		return undefined;
	}
	get cursor() {
		return this.cursors[this.index];
	}
	set cursor(value) {
		this.cursors[this.index] = value;
	}
	invalidate() {}
	/** What is pasted is text; what a terminal acts on is taken out. A line that ends a person's sentence stays a space on a one-line field. */
	insert(raw) {
		const field = this.field;
		let text = String(raw)
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
			.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
			.replace(/\x1b[^[\]]/g, "")
			.replace(/\t/g, "    ")
			.replace(/\r\n|\r/g, "\n");
		text = field.multiline ? text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "") : text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/ {2,}/g, " ");
		const room = field.limit - this.text.length;
		if (room <= 0) return void this.given.flash(`${field.limit} characters is the limit of this field`);
		const take = text.slice(0, room);
		if (take.length < text.length) this.given.flash(`only ${room} more character${room === 1 ? "" : "s"} fit${room === 1 ? "s" : ""} in this field; the rest was left out`);
		this.text = this.text.slice(0, this.cursor) + take + this.text.slice(this.cursor);
		this.cursor += take.length;
		this.follow();
	}
	backspace() {
		if (this.cursor === 0) return;
		const at = beforeAt(this.text, this.cursor);
		this.text = this.text.slice(0, at) + this.text.slice(this.cursor);
		this.cursor = at;
		this.follow();
	}
	eraseForward() {
		if (this.cursor >= this.text.length) return;
		const at = afterAt(this.text, this.cursor);
		this.text = this.text.slice(0, this.cursor) + this.text.slice(at);
		this.follow();
	}
	moveTo(at) {
		this.cursor = Math.max(0, Math.min(this.text.length, at));
		this.follow();
	}
	cursorRow(rows) {
		for (let i = 0; i < rows.length; i++) if (this.cursor <= rows[i].end) return i;
		return rows.length - 1;
	}
	follow() {
		if (!this.field.multiline) return;
		const rows = rowsOf(this.text, this.inner - 2);
		const at = this.cursorRow(rows);
		if (at < this.scrolls[this.index]) this.scrolls[this.index] = at;
		else if (at >= this.scrolls[this.index] + Form.VISIBLE) this.scrolls[this.index] = at - Form.VISIBLE + 1;
	}
	moveByLine(delta) {
		if (!this.field.multiline) return;
		const rows = rowsOf(this.text, this.inner - 2);
		const at = this.cursorRow(rows);
		const target = rows[at + delta];
		if (target === undefined) return void this.moveTo(delta < 0 ? 0 : this.text.length);
		const cells = widthOf(this.text.slice(rows[at].start, this.cursor));
		this.moveTo(offsetAtCells(this.text, target.start, cells));
	}
	save() {
		if (this.saving) return void this.given.flash("this save is still finishing");
		const drafts = this.validateDrafts();
		if (drafts === undefined) return;
		let saved;
		try {
			saved = this.given.save(drafts);
		} catch (error) {
			this.given.flash(`could not save: ${error?.message ?? error}`);
			return;
		}
		if (saved === null || typeof saved !== "object" || typeof saved.then !== "function") {
			if (saved) this.given.close();
			return;
		}
		this.saving = true;
		this.given.redraw?.();
		void Promise.resolve(saved)
			.then((didSave) => {
				if (didSave) this.given.close();
			})
			.catch((error) => this.given.flash(`could not save: ${error?.message ?? error}`))
			.finally(() => {
				this.saving = false;
				this.given.redraw?.();
			});
	}
	handleInput(data) {
		const key = this.given.keyOf(data);
		if (this.saving) return void this.given.flash(key === "escape" ? "the save is still finishing" : "saving…");
		// A read that is several lines and holds no escape sequence is pasted text, line ends and all.
		if (typeof data === "string" && data.length > 1 && !data.includes("\x1b") && /[\r\n]/.test(data)) return void this.insert(data);
		const bracketed = /^\x1b\[200~([\s\S]*?)\x1b\[201~$/.exec(String(data));
		if (bracketed) return void this.insert(bracketed[1]);
		if (key === "escape") return void this.given.close();
		if (key === "tab" || key === "shift+tab") {
			if (!this.moveField(key === "tab" ? 1 : -1)) this.given.flash("there is no other editable field");
			return;
		}
		const field = this.field;
		if (field.disabled === true) return void this.given.flash(`${field.label} is unavailable`);
		if (key === "enter") {
			if (field.multiline) return void this.insert("\n");
			return void this.save();
		}
		if (key === "ctrl+enter") return void this.save();
		if (key === "backspace") return void this.backspace();
		if (key === "delete") return void this.eraseForward();
		if (key === "left") return void this.moveTo(beforeAt(this.text, this.cursor));
		if (key === "right") return void this.moveTo(afterAt(this.text, this.cursor));
		if (key === "home") return void this.moveTo(0);
		if (key === "end") return void this.moveTo(this.text.length);
		if (key === "up") return void this.moveByLine(-1);
		if (key === "down") return void this.moveByLine(1);
		// The rest is a modified key the box has no use for; or it is what was typed.
		const SPECIAL = new Set(["escape", "enter", "tab", "backspace", "delete", "insert", "home", "end", "pageUp", "pageDown", "up", "down", "left", "right", "space", ...Array.from({ length: 12 }, (_, at) => `f${at + 1}`)]);
		if (typeof key === "string" && key !== "" && !SPECIAL.has(key) && !key.includes("+")) return void this.insert(key);
	}
	handleMouse(event) {
		if (event.type === "wheel" && this.field.multiline) {
			const rows = rowsOf(this.text, this.inner - 2);
			const most = Math.max(0, rows.length - Form.VISIBLE);
			this.scrolls[this.index] = Math.max(0, Math.min(most, this.scrolls[this.index] + (event.wheelDelta ?? 0)));
		}
		return { handled: true };
	}
	/** The row the editor's own cursor stands on: one inverse cell over the sign under it, or over a blank one at the end. */
	rowSpans(slice, cursor) {
		const bar = ["▎", TOKEN.activity.user];
		if (cursor < 0) return [bar, [` ${slice}`, TOKEN.text.primary]];
		const before = slice.slice(0, cursor);
		const end = cursor < slice.length ? afterAt(slice, cursor) : cursor;
		const cursorChar = cursor < slice.length ? slice.slice(cursor, end) : " ";
		const after = cursor < slice.length ? slice.slice(end) : "";
		return [bar, [` ${before}`, TOKEN.text.primary], [cursorChar, TOKEN.emphasis.inverse], [after, TOKEN.text.primary]];
	}
	footer() {
		if (this.saving) return "Saving… · the draft stays here until Cartographer replies";
		const field = this.field;
		if (field.disabled === true) return "This field is unavailable · Esc cancel";
		const parts = [field.multiline ? "Enter newline · Ctrl-Enter save" : "Enter save"];
		const editable = this.editable();
		if (editable.length > 1) {
			const at = editable.indexOf(this.index);
			parts.push(`Tab ${this.given.fields[editable[(at + 1) % editable.length]].label}`);
		}
		parts.push("Esc cancel");
		return parts.join("  ·  ");
	}
	render(width) {
		return guarded(width, () => {
			const field = this.field;
			this.inner = Math.max(10, width - 6);
			const used = this.text.length;
			const counter = `${used} / ${field.limit}`;
			const atCap = used >= field.limit;
			const fields = this.given.fields;
			const error = this.error;
			const state = field.disabled === true ? " · unavailable" : field.required === true ? " · required" : "";
			const label = `${field.label}${field.required === true ? " *" : ""}`;
			const labelStyle = field.disabled === true ? TOKEN.interaction.disabled : `${TOKEN.activity.user} ${TOKEN.emphasis.strong}`;
			const left = [[` ${label}`, labelStyle], [` · ${field.id}${state}${fields.length > 1 ? ` · ${this.index + 1} of ${fields.length}` : ""}`, TOKEN.text.muted]];
			const leftWidth = left.reduce((sum, [text]) => sum + widthOf(text), 0);
			const counterWidth = widthOf(counter);
			const room = Math.max(1, this.inner - leftWidth - counterWidth);
			const row = (spans) => paint([["   ", ""], ...spans], width, TOKEN.surface.overlay);
			const lines = [paint([], width, TOKEN.surface.overlay), row([...left, [" ".repeat(room), ""], [counter, atCap ? TOKEN.feedback.warning : TOKEN.text.muted]]), paint([], width, TOKEN.surface.overlay)];
			if (!field.multiline) {
				// A one-line field: the text rides with the cursor, so it is never cut away from it.
				const inner = this.inner - 2;
				let start = 0;
				while (start < this.cursor && widthOf(this.text.slice(start, this.cursor)) > inner - 1) start = afterAt(this.text, start);
				let cells = 0;
				let end = start;
				for (const { index, segment } of SEGMENTER.segment(this.text.slice(start))) {
					const w = widthOf(segment);
					if (cells + w > inner) break;
					cells += w;
					end = start + index + segment.length;
				}
				lines.push(row(this.rowSpans(this.text.slice(start, end), field.disabled === true ? -1 : this.cursor - start)));
			} else {
				const rows = rowsOf(this.text, this.inner - 2);
				const at = this.cursorRow(rows);
				const scroll = Math.min(this.scrolls[this.index], Math.max(0, rows.length - Form.VISIBLE));
				this.scrolls[this.index] = scroll;
				for (let i = scroll; i < scroll + Form.VISIBLE; i++) {
					const range = rows[i];
					if (range === undefined) lines.push(row([["▎", TOKEN.activity.user], ["", TOKEN.text.primary]]));
					else lines.push(row(this.rowSpans(this.text.slice(range.start, range.end), i === at ? this.cursor - range.start : -1)));
				}
			}
			if (error !== undefined) lines.push(row([[` ! ${error}`, TOKEN.feedback.danger]]));
			else if (typeof field.help === "string" && field.help.trim() !== "") lines.push(row([[` ${field.help.trim()}`, TOKEN.text.muted]]));
			lines.push(paint([], width, TOKEN.surface.overlay));
			lines.push(row([[this.footer(), this.saving ? TOKEN.interaction.loading : TOKEN.text.muted]]));
			lines.push(paint([], width, TOKEN.surface.overlay));
			return lines;
		});
	}
}

/** What is left on the terminal when carto leaves: the conversation as it stood, without the screen around it. */
export class Farewell {
	constructor(ui) {
		this.ui = ui;
	}
	invalidate() {}
	render(width) {
		return guarded(width, () => this.ui.chat.lines(Math.max(8, width - 2 * marginOf(width)), "talk").map((line) => contentRow(line, width)));
	}
}
