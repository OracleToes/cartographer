// A list of things that fold: what tabs 2 to 5 of the full screen are made of.
//
// A tab is a few lines at its top that are only read (a summary, the bar of the context), then items. An item is
// one line, and it may hold more: a body of text that shows when the item is opened, or, for a folder, the items
// below it. One item is selected; the keys move the selection, open and fold, and act on what is selected (open
// it in the editor, copy it). Nothing here knows what the items are: src/screen/views.mjs builds them, and is
// asked again whenever what is open changes, because for a folder that decides which items there are. Nor does
// it scroll: it gives all its rows, and the screen shows the ones in view (src/screen/parts.mjs).
//
// An item:
//   key       what it is, the same from one build to the next, so that the selection and what is open stay
//   head      its line: spans, [[text, style], …]
//   body      text shown below the head when the item is open; a function is called when it is needed
//   bodyStyle (line) => style, for a body whose lines differ (a patch)
//   folder    true: opening it makes the builder add the items below it; it has no body
//   depth     how far it is indented
//   target    { file, line? }: what `e` opens in the editor
//   copy      what `y` copies; a function is called when it is needed. Default: the head and the body
//   plain     true: a line that is only read, never selected (a heading)
import { cut, lineText, width, wrap } from "./text.mjs";

/** The most rows one opened body shows before it says how many more there are; opening everything lifts this. */
const BODY_ROWS = 400;

export function createList() {
	/** What is open: in "some" mode the keys in `opened`; in "all" mode everything but the keys in `closed`. */
	let mode = "some";
	const opened = new Set();
	const closed = new Set();
	let items = [];
	let header = [];
	let selected;
	let built = { cols: 0, lines: [], version: -1 };
	let version = 0;
	const touch = () => {
		version++;
	};
	const isOpen = (key) => (mode === "all" ? !closed.has(key) : opened.has(key));
	const choosable = () => items.filter((item) => item.plain !== true);
	const bodyOf = (item) => String((typeof item.body === "function" ? item.body() : item.body) ?? "");

	const api = {
		isOpen,
		get version() {
			return version;
		},
		/** New content. What was selected stays selected when it is still there. */
		set(next) {
			items = next.items ?? [];
			header = next.header ?? [];
			const list = choosable();
			if (selected === undefined || !list.some((item) => item.key === selected)) selected = list[0]?.key;
			touch();
		},
		selected: () => items.find((item) => item.key === selected),
		select(key) {
			if (items.some((item) => item.key === key && item.plain !== true)) selected = key;
			touch();
		},
		/** Move the selection by so many items. */
		move(by) {
			const list = choosable();
			if (list.length === 0) return false;
			const at = list.findIndex((item) => item.key === selected);
			selected = list[Math.max(0, Math.min(list.length - 1, (at === -1 ? 0 : at) + by))].key;
			touch();
			return true;
		},
		first() {
			selected = choosable()[0]?.key;
			touch();
		},
		last() {
			selected = choosable().at(-1)?.key;
			touch();
		},
		/** Open or fold one item; `to` forces one of the two. Returns whether the item can be opened at all. */
		toggle(key = selected, to = undefined) {
			const item = items.find((entry) => entry.key === key);
			if (item === undefined || (item.body === undefined && item.folder !== true)) return false;
			const want = to ?? !isOpen(key);
			if (mode === "all") {
				if (want) closed.delete(key);
				else closed.add(key);
			} else if (want) opened.add(key);
			else opened.delete(key);
			touch();
			return true;
		},
		openAll() {
			mode = "all";
			closed.clear();
			touch();
		},
		foldAll() {
			mode = "some";
			opened.clear();
			touch();
		},
		allOpen: () => mode === "all" && closed.size === 0,
		/**
		 * The tab as rows of `cols` cells: { spans, key?, head? }. `key` says which item a row belongs to, and
		 * `head` that it is the item's own line.
		 */
		lines(cols) {
			if (built.version === version && built.cols === cols) return built.lines;
			const out = [];
			for (const line of header) out.push({ spans: line });
			for (const item of items) {
				const indent = "  ".repeat(item.depth ?? 0);
				if (item.plain === true) {
					out.push({ spans: [[indent, ""], ...item.head] });
					continue;
				}
				const can = item.body !== undefined || item.folder === true;
				const open = can && isOpen(item.key);
				const mark = can ? (open ? "▾ " : "▸ ") : "  ";
				// The head is one row: what does not fit is in the body, or one unfold away.
				const room = Math.max(4, cols - width(indent) - 2);
				let used = 0;
				const head = [];
				for (const [text, style] of item.head) {
					if (used >= room) break;
					const piece = cut(String(text).replace(/[\n\t]+/g, " "), room - used);
					used += width(piece);
					head.push([piece, style]);
				}
				out.push({ spans: [[indent, ""], [mark, open ? "user" : "faint"], ...head], key: item.key, head: true });
				if (!open || item.folder === true) continue;
				const pad = `${indent}    `;
				const rows = [];
				for (const line of bodyOf(item).replace(/\n+$/, "").split("\n")) for (const piece of wrap(line, Math.max(8, cols - width(pad)))) rows.push([piece, item.bodyStyle?.(line) ?? ""]);
				const limit = mode === "all" ? Number.POSITIVE_INFINITY : BODY_ROWS;
				// What an item holds stands on a panel, so that it reads as inside the item.
				for (const [piece, style] of rows.slice(0, limit)) out.push({ spans: [[pad, ""], [piece, style]], key: item.key, bg: "bgPanel" });
				if (rows.length > limit) out.push({ spans: [[pad, ""], [`… ${rows.length - limit} more rows: + unfolds everything in full`, "faint"]], key: item.key, bg: "bgPanel" });
			}
			built = { cols, lines: out, version };
			return out;
		},
		/** The row on which the selected item's own line stands, counted from 0; -1 when nothing is selected. */
		selectedRow(cols) {
			return api.lines(cols).findIndex((line) => line.key === selected && line.head);
		},
		/** The item a row belongs to. */
		keyAtRow(cols, row) {
			return api.lines(cols)[row]?.key;
		},
		/** How many rows stand above the first item: the tab's top lines. */
		headerRows: () => header.length,
		/**
		 * Select what is in view, when the selection is not: the first item with a row between `top` and
		 * `top + rows`. The tab was scrolled away from its selection, and the keys act on what is seen.
		 */
		selectVisible(cols, top, rows) {
			const lines = api.lines(cols);
			const at = lines.findIndex((line) => line.key === selected && line.head);
			if (at >= top && at < top + rows) return false;
			const here = lines.slice(top, top + rows).find((line) => line.key !== undefined && items.some((item) => item.key === line.key && item.plain !== true));
			if (here === undefined || here.key === selected) return false;
			selected = here.key;
			touch();
			return true;
		},
		/** Everything the tab shows now, as text. */
		text(cols = 200) {
			return api.lines(cols).map((line) => lineText(line.spans).trimEnd()).join("\n");
		},
		/** What `y` copies for the selected item. */
		copyOf(item = api.selected()) {
			if (item === undefined) return "";
			if (item.copy !== undefined) return String(typeof item.copy === "function" ? item.copy() : item.copy);
			const body = item.body === undefined ? "" : bodyOf(item);
			return `${lineText(item.head)}${body === "" ? "" : `\n\n${body}`}`;
		},
	};
	return api;
}
