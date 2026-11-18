// A small, keyboard-first command palette for the persistent screen shell.
//
// The palette owns only query text, matching, and its short-lived selection. It receives already-safe capability
// descriptors and an `activate` callback, so it never queries a projection, reaches into a live manager, or decides
// whether a durable action is permitted.
import { cut, paint, wrap } from "./text.mjs";
import { TOKEN } from "./tokens.mjs";

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isPromise = (value) => value !== null && typeof value === "object" && typeof value.then === "function";
const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const normalized = (value) => text(value).toLocaleLowerCase();
const withoutLast = (value) => {
	let at = 0;
	for (const part of SEGMENTER.segment(value)) at = part.index;
	return value.slice(0, at);
};
const printable = (key) => typeof key === "string" && [...key].length === 1 && !/[\p{C}]/u.test(key);

/**
 * Turn loose capability/shell descriptors into the stable presentation the palette needs. This deliberately accepts
 * application capability objects directly: a disabled capability remains discoverable, with its supplied reason.
 */
export function normalizePaletteItems(items = []) {
	if (!Array.isArray(items)) throw new TypeError("Palette items must be an array.");
	const used = new Set();
	return items.map((item, index) => {
		if (item === null || typeof item !== "object") throw new TypeError("A palette item must be an object.");
		const baseId = text(item.id) || `item:${index + 1}`;
		const id = used.has(baseId) ? `${baseId}:${index + 1}` : baseId;
		used.add(id);
		const availability = item.availability;
		const disabled = item.disabled === true || availability?.enabled === false;
		const disabledReason = text(item.disabledReason ?? availability?.reason) || "This action is unavailable right now.";
		return Object.freeze({
			...item,
			id,
			label: text(item.label) || id,
			category: text(item.category),
			description: text(item.description),
			keywords: text(Array.isArray(item.keywords) ? item.keywords.join(" ") : item.keywords),
			disabled,
			disabledReason,
			order: index,
		});
	});
}

const score = (item, words) => {
	if (words.length === 0) return 0;
	const label = normalized(item.label);
	const id = normalized(item.id);
	const category = normalized(item.category);
	const description = normalized(item.description);
	const keywords = normalized(item.keywords);
	let total = 0;
	for (const word of words) {
		if (label === word) total += 120;
		else if (label.startsWith(word)) total += 90;
		else if (label.includes(word)) total += 70;
		else if (id.startsWith(word)) total += 60;
		else if (id.includes(word)) total += 50;
		else if (keywords.includes(word)) total += 35;
		else if (category.includes(word)) total += 25;
		else if (description.includes(word)) total += 10;
		else return -1;
	}
	return total;
};

/** Match every query word while keeping ties in the registry's supplied order. */
export function filterPaletteItems(items, query = "") {
	const candidates = normalizePaletteItems(items);
	const words = normalized(query).split(" ").filter(Boolean);
	return candidates
		.map((item) => ({ item, score: score(item, words) }))
		.filter((entry) => entry.score >= 0)
		.sort((left, right) => right.score - left.score || left.item.order - right.item.order)
		.map((entry) => entry.item);
}

/**
 * Focus-capturing modal palette. Enter invokes the caller-owned capability/navigation adapter; unavailable entries
 * stay visible but cannot be activated. An asynchronous activation holds the selection until it settles, which
 * makes accidental duplicate actions impossible.
 */
export class CommandPalette {
	/**
	 * @param {{
	 *   items: object[] | (() => object[]),
	 *   keyOf: (data: string) => string | undefined,
	 *   close: () => void,
	 *   activate: (item: object) => boolean | Promise<boolean>,
	 *   flash: (text: string) => void,
	 *   redraw?: () => void,
	 *   title?: string,
	 * }} given
	 */
	constructor(given) {
		if (given === null || typeof given !== "object") throw new TypeError("A command palette needs its options.");
		if (typeof given.keyOf !== "function") throw new TypeError("A command palette needs a key reader.");
		if (typeof given.close !== "function") throw new TypeError("A command palette needs a close callback.");
		if (typeof given.activate !== "function") throw new TypeError("A command palette needs an activation callback.");
		if (typeof given.flash !== "function") throw new TypeError("A command palette needs a feedback callback.");
		this.given = given;
		this.capturesViewportInput = true;
		this.query = "";
		this.index = 0;
		this.pending = false;
	}
	invalidate() {}
	items() {
		const supplied = typeof this.given.items === "function" ? this.given.items() : this.given.items;
		return filterPaletteItems(supplied ?? [], this.query);
	}
	selected() {
		const items = this.items();
		this.index = Math.max(0, Math.min(items.length - 1, this.index));
		return items[this.index];
	}
	setQuery(value) {
		this.query = String(value ?? "");
		this.index = 0;
	}
	insert(value) {
		const next = String(value ?? "").replace(/[\p{C}]/gu, "");
		if (next !== "") this.setQuery(`${this.query}${next}`);
	}
	move(by) {
		const items = this.items();
		if (items.length === 0) return;
		this.index = Math.max(0, Math.min(items.length - 1, this.index + by));
	}
	activate() {
		if (this.pending) return void this.given.flash("that action is still finishing");
		const item = this.selected();
		if (item === undefined) return void this.given.flash("no action matches that search");
		if (item.disabled) return void this.given.flash(item.disabledReason);
		let result;
		try {
			result = this.given.activate(item);
		} catch (error) {
			this.given.flash(`could not open that action: ${error?.message ?? error}`);
			return;
		}
		if (!isPromise(result)) {
			if (result) this.given.close();
			return;
		}
		this.pending = true;
		this.given.redraw?.();
		void Promise.resolve(result)
			.then((opened) => {
				if (opened) this.given.close();
			})
			.catch((error) => this.given.flash(`could not open that action: ${error?.message ?? error}`))
			.finally(() => {
				this.pending = false;
				this.given.redraw?.();
			});
	}
	handleInput(data) {
		const key = this.given.keyOf(data);
		if (this.pending) return void this.given.flash(key === "escape" ? "that action is still finishing" : "opening…");
		if (key === "escape") return void this.given.close();
		if (key === "enter") return void this.activate();
		if (key === "backspace" || key === "delete") return void this.setQuery(withoutLast(this.query));
		// The palette's query is a focused text field: printable j/k belong to search rather than stealing Vim-like
		// collection navigation from the person who is filtering capabilities.
		if (key === "up" || key === "ctrl+p") return void this.move(-1);
		if (key === "down" || key === "ctrl+n") return void this.move(1);
		if (key === "home") {
			this.index = 0;
			return;
		}
		if (key === "end") {
			this.index = Math.max(0, this.items().length - 1);
			return;
		}
		if (key === "pageUp") return void this.move(-6);
		if (key === "pageDown") return void this.move(6);
		if (printable(key)) this.insert(key);
	}
	handleMouse() {
		return { handled: true };
	}
	footer() {
		return this.pending ? "Opening… the palette stays here until Cartographer replies" : "↑ ↓ move · Enter open · type to filter · Esc close";
	}
	render(width) {
		const inner = Math.max(10, width - 6);
		const row = (spans, selected = false) => paint([["   ", ""], ...spans], width, selected ? TOKEN.interaction.selected : TOKEN.surface.overlay);
		const items = this.items();
		this.index = Math.max(0, Math.min(items.length - 1, this.index));
		const selected = items[this.index];
		const title = this.given.title ?? "Command palette";
		const rows = [
			paint([], width, TOKEN.surface.overlay),
			row([[` ${title}`, `${TOKEN.text.primary} ${TOKEN.emphasis.strong}`], [" · Ctrl-K", TOKEN.text.muted]]),
			row([[` › ${this.query || "Search actions and navigation"}`, this.query === "" ? TOKEN.text.muted : TOKEN.text.primary]]),
			paint([], width, TOKEN.surface.overlay),
		];
		if (items.length === 0) rows.push(row([[" No actions match that search.", TOKEN.text.muted]]));
		else {
			const start = Math.max(0, Math.min(items.length - 8, this.index - 4));
			const visible = items.slice(start, start + 8);
			for (const [offset, item] of visible.entries()) {
				const index = start + offset;
				const prefix = index === this.index ? "› " : "  ";
				const label = cut(item.label, Math.max(8, inner - 18));
				const suffix = item.disabled ? " unavailable" : item.category === "" ? "" : ` ${item.category}`;
				rows.push(row([[prefix, item.disabled ? TOKEN.text.muted : TOKEN.text.primary], [label, item.disabled ? TOKEN.text.muted : TOKEN.text.primary], [suffix, item.disabled ? TOKEN.feedback.warning : TOKEN.text.muted]], index === this.index));
			}
			if (visible.length < items.length) rows.push(row([[` … ${items.length - visible.length} more; refine the search`, TOKEN.text.muted]]));
			const detail = selected?.disabled ? selected.disabledReason : selected?.description;
			if (detail !== undefined && detail !== "") {
				rows.push(paint([], width, TOKEN.surface.overlay));
				for (const line of wrap(detail, inner - 2).slice(0, 2)) rows.push(row([[` ${line}`, selected?.disabled ? TOKEN.feedback.warning : TOKEN.text.secondary]]));
			}
		}
		rows.push(paint([], width, TOKEN.surface.overlay));
		rows.push(row([[this.footer(), this.pending ? TOKEN.interaction.loading : TOKEN.text.muted]]));
		rows.push(paint([], width, TOKEN.surface.overlay));
		return rows;
	}
}
