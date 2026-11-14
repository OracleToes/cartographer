// The one language the agent's entry books speak, written once.
//
// The ledger (src/ledger.mjs) and the books (src/books.mjs) are the same machine wearing different
// clothes: a list of short entries with ids (g1, a3), kinds, an open/closed life, the verbs add, done,
// edit, remove — and, where order matters, before. Their file formats, their ids and every line the
// agent or the user sees stay exactly as they were; only the machinery is shared. A book describes
// itself with a `spec`, and `applyEntryOp` carries an operation out. Where the two differ — a goal's
// done-when line, the books' reordering — the spec says so with a small hook, rather than the engine
// growing a case for each.
//
// What a spec holds:
//   Error          the book's own error class, so a caller can tell its failures from real ones
//   kinds          the entry kinds, in the order they are named in messages
//   prefix         kind → the letter its ids begin with (goal → g, assessment → a)
//   textMax        the most characters one entry may hold
//   addTextLabel   what the add's `text` is called in its errors (the ledger says what a text is for)
//   textRequired   the error for a missing or empty text
//   textTooLong    the error for a text over `textMax`
//   itemsMax       how many entries the book holds at most
//   limitCount     how many entries the limit counts (the ledger counts its open, unarchived ones)
//   limitText      what is said when that count has reached `itemsMax`
//   findId         the id an operation names, as this book spells it
//   findIds        the ids named when an operation names none (the ledger: the open ones)
//   findText       what is said when no entry carries that id; `where` says which field misspelled it
//   show           one line for an entry, as the agent and the user see it, after the verb's sign
//   closedWord     "closed" (ledger) or "settled" (books)
//   alreadyText    what is said when `done` reaches an entry that is done already
//   outcome        for `done`: the entry's outcome from `op.text`, or undefined to leave it out
//   markClosed     whether `done` stamps the time it happened (the ledger keeps it, the books do not)
//   doneFollow     for `done`: what else the agent is told (the ledger: what a closed goal asks of it)
//   addFields      for `add`: the fields beyond id, kind and text (the ledger: a goal's doneWhen)
//   addBefore      whether `add` may position the entry with `before`
//   editFields     for `edit`: the fields beyond `text` (the ledger: a goal's new done-when line)
//   editTextRequired  whether `edit` must have `text` (the books) or may change other fields instead
//   reorder        whether `before` is an action of its own
//   unknownAction  the error for an action the book does not know

/** Whitespace run flat, ends trimmed: an entry is one line of thought. */
export const flat = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * Apply one operation to `store` (an object holding `items` and `next`, changed in place), as its book
 * describes itself with `spec`.
 * @returns {{ line: string, shown: string }} what the agent is told and what the user is shown
 */
export function applyEntryOp(store, op, spec, now) {
	const { Error: BookError } = spec;
	const checked = (value, what) => {
		if (typeof value !== "string" || value.trim() === "") throw new BookError(spec.textRequired(what));
		const text = flat(value);
		if (text.length > spec.textMax) throw new BookError(spec.textTooLong(what, text.length));
		return text;
	};
	const find = (id, where = "id") => {
		const wanted = spec.findId(id);
		const item = store.items.find((entry) => entry.id === wanted);
		if (item === undefined) throw new BookError(spec.findText(wanted, spec.findIds(store), where));
		return item;
	};
	switch (op?.action) {
		case "add": {
			if (!spec.kinds.includes(op.kind)) throw new BookError(`\`kind\` is ${JSON.stringify(op.kind)}; it is one of ${spec.kinds.join(", ")}.`);
			const text = checked(op.text, spec.addTextLabel);
			if (spec.limitCount(store) >= spec.itemsMax) throw new BookError(spec.limitText());
			const item = { id: `${spec.prefix[op.kind]}${store.next}`, kind: op.kind, text };
			for (const [field, value] of Object.entries(spec.addFields?.(op, op.kind, checked) ?? {})) item[field] = value;
			Object.assign(item, { status: "open", added: now });
			store.next++;
			let at = store.items.length;
			if (spec.addBefore && op.before !== undefined && op.before !== "") at = store.items.indexOf(find(op.before, "before"));
			store.items.splice(at, 0, item);
			return { line: `${item.id} added.`, shown: `+ ${spec.show(item)}` };
		}
		case "done": {
			const item = find(op.id);
			if (item.status === "done") return { line: spec.alreadyText(item.id), shown: `✓ ${spec.show(item)}` };
			item.status = "done";
			if (spec.markClosed) item.closed = now;
			const outcome = spec.outcome?.(op, checked);
			if (outcome !== undefined) item.outcome = outcome;
			return { line: `${item.id} ${spec.closedWord}.${spec.doneFollow?.(item) ?? ""}`, shown: `✓ ${spec.show(item)}` };
		}
		case "edit": {
			const item = find(op.id);
			const hasText = op.text !== undefined && flat(op.text) !== "";
			const extra = spec.editFields?.(item, op, hasText, checked) ?? {};
			if (spec.editTextRequired || hasText) item.text = checked(op.text, "`text`");
			for (const [field, value] of Object.entries(extra)) item[field] = value;
			return { line: `${item.id} reworded.`, shown: `~ ${spec.show(item)}` };
		}
		case "remove": {
			const item = find(op.id);
			store.items.splice(store.items.indexOf(item), 1);
			return { line: `${item.id} removed.`, shown: `- ${spec.show(item)}` };
		}
		case "before": {
			if (!spec.reorder) throw new BookError(spec.unknownAction(op));
			const item = find(op.id);
			store.items.splice(store.items.indexOf(item), 1);
			if (op.before === undefined || op.before === "") {
				store.items.push(item);
			} else {
				const other = find(op.before);
				if (other === item) throw new BookError("An entry cannot stand in front of itself.");
				store.items.splice(store.items.indexOf(other), 0, item);
			}
			return { line: `${item.id} moved.`, shown: `↕ ${spec.show(item)}` };
		}
		default:
			throw new BookError(spec.unknownAction(op));
	}
}
