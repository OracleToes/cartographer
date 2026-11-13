// The parts of the full screen, as pi-tui components.
//
// pi-tui lays the screen out, scrolls it, reads the keys and the mouse, and writes only the rows that changed. A
// part here is what pi-tui calls a component: it is asked for its lines at a width, and may be told of a click.
// What the lines say comes from the models (chat.mjs, list.mjs, views.mjs) and how they are coloured from the
// palette (theme.mjs); a part only fits the two to the screen: the margin, the background of a block, the mark
// of what is selected.
//
// Every row is the margin, the cells between the margins, and the margin again. A row of content has its block's
// background between the margins; a row of chrome (the tabs, the strip, the place to type) has it edge to edge.
import { CURSOR_MARKER, Editor, renderFakeCursor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cut, paint, paintStyled, sgr, width as cells, wrap } from "./text.mjs";

/** Empty cells at the left and right edge of the screen; none on a screen too narrow to spare them. */
export const marginOf = (width) => (width >= 30 ? 2 : 0);
/** From how many rows on the screen has an empty row under the tabs, above the strip and under what is typed. */
export const AIRY_ROWS = 16;

const edge = (width, bg = "") => paint([], marginOf(width), bg);
/** A row of chrome: its background runs over the margins. */
export const barRow = (spans, width, bg) => `${edge(width, bg)}${paint(spans, width - 2 * marginOf(width), bg)}${edge(width, bg)}`;
/** A row of content: a line of a model, on its block's background or on the mark of what is selected. */
export function contentRow(line, width, chosen = false) {
	const inner = width - 2 * marginOf(width);
	if (line === undefined) return " ".repeat(width);
	if (line.styled !== undefined) return `${edge(width)}${paintStyled(line.styled, line.cells, inner, chosen ? "bgSel" : "")}${edge(width)}`;
	// A block's text stands a cell in from its edge; what you said has that edge drawn, in your colour.
	const lead = line.pad ? [[line.bg === "bgUser" ? "▎" : " ", "user"]] : [];
	return `${edge(width)}${paint([...lead, ...line.spans], inner, chosen ? "bgSel" : (line.bg ?? ""))}${edge(width)}`;
}
/** A line that pi-tui will take: never wider than it was asked for, whatever went into it. */
const safe = (line, width) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line);
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
			const spans = [];
			this.spans = [];
			let x = 0;
			for (const [index, tab] of ui.tabs.entries()) {
				const label = ` ${index + 1} ${tab.name} `;
				this.spans.push({ id: tab.id, from: marginOf(width) + x, to: marginOf(width) + x + label.length });
				spans.push([label, tab.id === ui.state.tab ? "bgTab" : "muted"]);
				x += label.length;
			}
			const hint = ui.hint();
			const room = inner - x - 1;
			if (room > 8) spans.push([" ".repeat(Math.max(0, room - cells(cut(hint, room)) + 1)), ""], [cut(hint, room), "faint"]);
			return [barRow(spans, width, "bgBar")];
		});
	}
	handleMouse(event) {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const tab = this.spans.find((entry) => event.x >= entry.from && event.x < entry.to);
		if (tab !== undefined) this.ui.setTab(tab.id);
		return { handled: true };
	}
}

/** The row of views inside a tab, and the file that `e` opens. */
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
			const spans = [[" ", ""]];
			this.spans = [];
			let x = 1;
			for (const view of views) {
				const label = ` ${view.name} `;
				this.spans.push({ id: view.id, from: marginOf(width) + x, to: marginOf(width) + x + label.length });
				spans.push([label, view.id === ui.view() ? "user bold under" : "muted"]);
				x += label.length;
			}
			const file = ui.fileHint();
			spans.push(["   [ ] change view", "faint"], [file !== undefined ? ` · e opens ${file}` : "", "faint"]);
			return [barRow(spans, width, "bgPanel")];
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
		if (this.made === undefined || this.made.version !== chat.version || this.made.cols !== this.cols) this.made = { version: chat.version, cols: this.cols, lines: chat.lines(this.cols) };
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
			const key = `${ui.chat.version}|${width}|${chosen ?? ""}|${ui.themeVersion()}|${this.lead}`;
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

/** The strip: what the agent is doing, and how things stand. `ui.status()` gives its two rows as spans. */
export class Strip {
	constructor(ui) {
		this.ui = ui;
	}
	invalidate() {}
	render(width) {
		return guarded(width, () => this.ui.status().map((spans) => barRow(spans, width, "bgBar")));
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
			const blank = barRow([], width, "bgInput");
			if (ui.state.mode === "command") return [barRow(ui.commandLine(), width, "bgInput"), ...(airy ? [blank] : [])];
			const margin = marginOf(width);
			const inner = width - 2 * margin;
			const { text: prompt, style } = ui.prompt();
			const lead = cells(prompt);
			const pad = " ".repeat(lead);
			const bg = sgr("bgInput");
			const left = `${edge(width, "bgInput")}${bg}`;
			const right = `\x1b[0m${edge(width, "bgInput")}`;
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
							rows.push(barRow([[pad, ""], [`↑ ${hidden} more rows`, "faint"]], width, "bgInput"));
							this.offset.y = 0;
						}
					} else {
						part = "below";
						const count = this.getLines().length;
						if (hidden !== "") rows.push(barRow([[pad, ""], [`↓ ${hidden} more rows`, "faint"]], width, "bgInput"));
						else if (count > 1) rows.push(barRow([[pad, ""], [`${count} lines · Enter sends them as one message · Alt-Enter adds a line`, "faint"]], width, "bgInput"));
						else if (airy) rows.push(blank);
					}
					continue;
				}
				if (part === "below") {
					// A row of the list of completions, on a panel of its own, in line with what is typed.
					this.listAt ??= { row: rows.length, editorRow: textRows + 2 };
					const row = truncateToWidth(line, Math.max(1, inner - 2), "");
					rows.push(`${edge(width, "bgPanel")}${sgr("bgPanel")}  ${row}${sgr("bgPanel")}${" ".repeat(Math.max(0, inner - 2 - visibleWidth(row)))}\x1b[0m${edge(width, "bgPanel")}`);
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
			const row = (spans) => paint([["   ", ""], ...spans], width, "bgPanel");
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

/** What is left on the terminal when carto leaves: the conversation as it stood, without the screen around it. */
export class Farewell {
	constructor(ui) {
		this.ui = ui;
	}
	invalidate() {}
	render(width) {
		return guarded(width, () => this.ui.chat.lines(Math.max(8, width - 2 * marginOf(width))).map((line) => contentRow(line, width)));
	}
}
