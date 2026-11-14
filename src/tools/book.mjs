// The `book` tool: one front door to the agent's own books — ledger, plan, books, context —
// each of which keeps rows the agent adds to, rewords, closes and takes away. The books themselves and
// the verbs live in src/ledger.mjs, src/plan.mjs, src/books.mjs and src/context.mjs;
// what is here is the shared shape of the call (`book` names one, `ops` carries the operations) and the
// per-book run of it, whose wording, details and guards are exactly those of the tools it replaces.
//
// A task may use the context operations (fold, recall, shelve, unshelve, note, collapse) as the old
// `context` tool let it; the other books belong to the main agent, and are refused with the same words
// the old per-tool refusals used.
import { POLICY } from "../config.mjs";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { arr, bool, compile, lit, obj, oneOf, opt, str, union, unknown } from "@earendil-works/pi-schema";
import { describe, REFUSALS, STILL_TASK } from "../prompt.mjs";
import { applyOp, KINDS, LedgerError, loadLedger, open, openCounts, prune, saveLedger, TEXT_MAX as LEDGER_TEXT_MAX } from "../ledger.mjs";
import { applyPlanOp, authorizationLine, ITEM_MAX, loadPlan, MODES, PlanError, savePlan } from "../plan.mjs";
import { applyBookOp, BOOK_KINDS, BOOK_TEXT_MAX, BookError, loadBooks, renderBook, saveBooks } from "../books.mjs";
import { ASSESSMENT_MAX, assessmentPath, saveAssessment } from "../assessment.mjs";
import { noteAssessed } from "../top.mjs";
import { pin } from "../top.mjs";
import { loadContext, loadReport, messageTokens, recordLine, reportsInView, ShelfError, shelfItem, shelfLabel, shelfText, estimate, stepsOf, taskState, updateContext, RECALLED, composedRows, curatedRows, applyCuratedRowOp, applyContextRowAction, ContextRowError, sameShelfItem } from "../context.mjs";

const count = (n) => Math.round(n).toLocaleString("en-US");
const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
const ok = (text, shown) => ({ output: [{ type: "text", text }], details: { shown: [].concat(shown) } });
const sameItem = sameShelfItem;
const CONTEXT_WHEN = Object.values(POLICY.enums.contextVisibility);

/** What a task is told when it reaches for a book of the main agent. */
const TASK_REFUSALS = { ledger: REFUSALS.taskWritesLedger, plan: REFUSALS.taskWritesPlan, books: REFUSALS.taskAssesses };

/** The label an operation carries when it could not be applied ("add g1"). */
const opLabel = (op, second) => `${op?.action ?? "?"} ${op?.id ?? op?.[second] ?? ""}`.trim();

/** The ledger's run: see the `ledger` tool this replaces (src/tools/ledger.mjs in the last release). */
function runLedger({ brainDir, engine }, args, api) {
	const ops = Array.isArray(args.ops) ? args.ops : [];
	if (ops.length === 0) return fail("`ops` is empty: give at least one operation.");
	const { ledger, error } = loadLedger(brainDir);
	if (ledger === undefined) {
		return fail(`The ledger cannot be read: ${error}. It was probably edited by hand. Nothing was changed. Tell the user; they have to repair the file.`);
	}
	// This call ran before and was cut off after saving (a crash, then a restart): do not apply it twice.
	if (ledger.lastCall === api.taskId) {
		return { output: [{ type: "text", text: `These operations were already applied, before a restart.\nOpen: ${openCounts(ledger)}.` }], details: { shown: ["(applied before the restart)"] } };
	}

	const lines = [];
	const shown = [];
	let applied = 0;
	const now = new Date(api.now()).toISOString();
	const goalsBefore = new Set(open(ledger, POLICY.enums.ledgerKind.goal).map((item) => item.id));
	for (const [index, op] of ops.entries()) {
		try {
			const result = applyOp(ledger, op, now);
			lines.push(result.line);
			shown.push(result.shown);
			applied++;
		} catch (problem) {
			if (!(problem instanceof LedgerError)) throw problem;
			lines.push(`Op ${index + 1} (${opLabel(op, "kind")}) not applied: ${problem.message}`);
		}
	}
	if (applied === 0) return fail(lines.join("\n"));
	if (applied < ops.length) lines.push(`${applied} of ${ops.length} applied and saved; send only the ones not applied again.`);
	lines.push(`Open: ${openCounts(ledger)}.`);
	// A goal that closes is a moment to bring the top of the context up to date (src/top.mjs). Done before the
	// ledger is saved: a crash in between then repeats both, and neither is done twice.
	const closed = [...goalsBefore].filter((id) => ledger.items.find((item) => item.id === id)?.status === POLICY.enums.entryStatus.done);
	let pinned = false;
	if (closed.length > 0) {
		pinned = pin(brainDir, { now: api.now(), reason: `goal ${closed.join(", ")} was closed` }).changed;
		if (pinned) lines.push("The copy of your assessment and graph at the top of your context was rewritten to what they are now.");
		// And the moment to collapse the context: the work for that goal is done (src/engine.mjs).
		engine?.want(`goal ${closed.join(", ")} was closed`);
	}
	prune(ledger);
	ledger.lastCall = api.taskId;
	saveLedger(brainDir, ledger);
	return { output: [{ type: "text", text: lines.join("\n") }], details: { shown, ...(pinned ? { pinned: true } : {}) } };
}

/** The plan's run: see the `plan` tool this replaces (src/tools/plan.mjs in the last release). */
function runPlan({ brainDir, gate }, args, api) {
	const ops = Array.isArray(args.ops) ? args.ops : [];
	if (ops.length === 0) return fail("`ops` is empty: give at least one operation.");
	const { plan, error } = loadPlan(brainDir);
	if (plan === undefined) return fail(`The plan cannot be read: ${error}. It was probably edited by hand. Nothing was changed. Tell the user; they have to repair the file.`);
	if (plan.lastCall === api.taskId) {
		return { output: [{ type: "text", text: `These operations were already applied, before a restart.\n${authorizationLine(plan)}` }], details: { shown: ["(applied before the restart)"] } };
	}

	const lines = [];
	const shown = [];
	let applied = 0;
	let withdrawn = false;
	const now = new Date(api.now()).toISOString();
	for (const [index, op] of ops.entries()) {
		try {
			const result = applyPlanOp(plan, op, now, { yolo: gate?.yolo === true });
			lines.push(result.line);
			shown.push(result.shown);
			withdrawn ||= result.withdrawn === true;
			applied++;
		} catch (problem) {
			if (!(problem instanceof PlanError)) throw problem;
			let message = problem.message;
			if (op?.action === POLICY.enums.actions.add && (typeof op.text !== "string" || op.text.trim() === "")) {
				const expected = { action: POLICY.enums.actions.add, mode: op.mode === POLICY.enums.planMode.look ? "look" : "change", text: "one-line description of what this item covers" };
				message += `\n\nCall received (exact arguments):\n${JSON.stringify(args, null, 2)}\n\nExpected shape for a plan add:\n${JSON.stringify(expected, null, 2)}\nThe item's wording belongs in \`text\`, not \`lines\`. Correct the call; do not repeat it unchanged.`;
			}
			lines.push(`Op ${index + 1} (${opLabel(op, "mode")}) not applied: ${message}`);
		}
	}
	if (applied === 0) return fail(lines.join("\n"));
	if (applied < ops.length) lines.push(`${applied} of ${ops.length} applied and saved; send only the ones not applied again.`);
	if (plan.items.length > 0) lines.push(authorizationLine(plan, { yolo: gate?.yolo === true }));
	if (withdrawn) shown.push("authorization withdrawn: a change item was added or changed");
	plan.lastCall = api.taskId;
	savePlan(brainDir, plan);
	return { output: [{ type: "text", text: lines.join("\n") }], details: { shown } };
}

/** The books' run: see the `assess` tool this replaces (src/tools/assess.mjs in the last release). */
function runBooks({ brainDir }, args, api) {
	// The old whole-text call, kept for a hand-written assessment.md and older callers.
	if (!Array.isArray(args.ops) || args.ops.length === 0) {
		const text = typeof args.text === "string" ? args.text.trim() : "";
		if (text === "") return fail("`text` is empty and `ops` holds nothing. Write an entry with `ops`, or the whole assessment with `text`.");
		if (text.length > ASSESSMENT_MAX) return fail(`The assessment is ${text.length} characters; the limit is ${ASSESSMENT_MAX}. Keep what you would need first with an empty context; details belong in nodes of the atlas.`);
		saveAssessment(brainDir, text);
		noteAssessed(brainDir, text);
		return {
			output: [
				{
					type: "text",
					text: `Assessment saved (${text.length} characters) to ${assessmentPath(brainDir)}. The copy at the top of your context is replaced when a goal closes or a fresh context starts; until then this call is the text that counts.`,
				},
			],
			details: { shown: [`assessment written, ${text.length} characters`] },
		};
	}
	const book = loadBooks(brainDir);
	const lines = [];
	const shown = [];
	let applied = 0;
	for (const [index, op] of args.ops.entries()) {
		try {
			const result = applyBookOp(book, op, api.now());
			lines.push(result.line);
			shown.push(result.shown);
			applied++;
		} catch (problem) {
			if (!(problem instanceof BookError)) throw problem;
			lines.push(`Op ${index + 1} (${op?.action ?? "?"}) not applied: ${problem.message}`);
		}
	}
	if (applied === 0) return fail(lines.join("\n"));
	saveBooks(brainDir, book);
	// Keep assessment.md in step with the assessment entries, so the copy at the top of the
	// context, /assessment and the user's own edits still read the same text.
	const assessment = renderBook(book, POLICY.enums.bookKind.assessment);
	if (book.items.some((item) => item.kind === POLICY.enums.bookKind.assessment)) {
		saveAssessment(brainDir, assessment);
		noteAssessed(brainDir, assessment);
	}
	const practice = renderBook(book, POLICY.enums.bookKind.practice);
	return {
		output: [{ type: "text", text: `${lines.join("\n")}${practice === "" ? "" : `\n\nYour practice now reads:\n${practice}`}` }],
		details: { shown },
	};
}

/** The context operations' run: see the `context` tool this replaces (src/tools/context.mjs in the last release). */
function runContext({ root, brainDir, config, engine }, args, api) {
	const main = api.conversationId === ROOT_CONVERSATION_ID;
	const ops = Array.isArray(args.ops) ? args.ops : [];
	let store = loadContext(brainDir);
	const messages = engine.messagesOf(api.conversationId) ?? [];
	const lines = [];
	const shown = [];
	try {
		for (const op of ops) {
			const action = op?.action;
			if ([POLICY.enums.actions.add, POLICY.enums.actions.done, POLICY.enums.actions.edit, POLICY.enums.actions.remove, POLICY.enums.actions.before].includes(action)) {
				if (!main) return fail("Curated context rows belong to the shared project brain; only the main agent can change them.");
				const result = applyCuratedRowOp(brainDir, op, api.now());
				store = loadContext(brainDir);
				shown.push(result.shown);
				lines.push(`${result.line}${op.when === POLICY.enums.contextVisibility.nextBoundary ? " This is saved now and enters context at the next boundary." : " It is saved and in context now."}`);
				continue;
			}
			if ([POLICY.enums.actions.archive, POLICY.enums.actions.unarchive, POLICY.enums.actions.delete].includes(action)) {
				if (!main) return fail("Context row operations belong to the shared project brain; only the main agent can apply them.");
				const id = String(op.id ?? "").trim();
				if (id === "") return fail(`${action} needs \`id\`: the context row to change.`);
				const result = applyContextRowAction(brainDir, id, action, op.when);
				store = loadContext(brainDir);
				shown.push(`${action} ${id}`);
				lines.push(`${result}${op.when === POLICY.enums.contextVisibility.nextBoundary ? " The saved change takes effect in context at the next boundary." : " It takes effect in context now."}`);
				continue;
			}
			if (action === POLICY.enums.actions.recall) {
				const id = String(op.id ?? "").trim();
				if (id === "") return fail(`recall needs \`id\`: the report to bring back.${composedRows(store).length > 0 ? ` Kept: ${composedRows(store).slice(-POLICY.limits.bookTool.keptBookEntries).map((record) => record.id).join(", ")}.` : " No report is kept yet."}`);
				const report = loadReport(brainDir, id);
				if (report === undefined) return fail(`There is no report ${id}.${composedRows(store).length > 0 ? ` Kept: ${composedRows(store).slice(-POLICY.limits.bookTool.keptBookEntries).map((record) => record.id).join(", ")}.` : " No report is kept yet."}`);
				if (reportsInView(messages).has(id) && !store.dropped.includes(id)) return fail(`Report ${id} is still in your context, further up: nothing was added.`);
				// A report the main agent dropped comes back by this, too.
				if (main && store.dropped.includes(id)) {
					updateContext(brainDir, (next) => {
						next.dropped = next.dropped.filter((entry) => entry !== id);
					});
					shown.push(`recalled ${id} · back in its place`);
					lines.push(`Report ${id} stands in its place again, further up.`);
					continue;
				}
				shown.push(`recalled ${id} · about ${count(estimate(report))} tokens`);
				lines.push(`${report}\n\n${RECALLED}`);
				continue;
			}

			if (action === POLICY.enums.actions.shelve) {
				const { item, tokens } = shelfItem(root, op.path, op.lines, brainDir);
				const mine = main ? store.shelf : (store.tasks[api.conversationId]?.shelf ?? []);
				const others = mine.filter((entry) => !sameItem(entry, item));
				const total = others.reduce((sum, entry) => sum + estimate(shelfText(root, entry, brainDir)), 0) + tokens;
				if (total > config.shelfTokens) {
					return fail(
						`${shelfLabel(item)} is about ${count(tokens)} tokens, and the shelf would then hold ${count(total)} of at most ${count(config.shelfTokens)}. Shelve a range of lines instead, or take something off first${others.length > 0 ? `: ${others.map(shelfLabel).join(", ")}` : ""}.`,
					);
				}
				const handOn = !main && op.hand_on === true;
				updateContext(brainDir, (next) => {
					const list = main ? next.shelf : (taskState(next, api.conversationId).shelf ??= []);
					const at = list.findIndex((entry) => sameItem(entry, item));
					const entry = { ...item, ...(handOn ? { handOn: true } : {}) };
					if (at >= 0) list[at] = entry;
					else list.push(entry);
				});
				const size = `about ${count(tokens)} tokens; the shelf then holds ${count(total)} of ${count(config.shelfTokens)}`;
				shown.push(`shelved ${shelfLabel(item)} · about ${count(tokens)} tokens${handOn ? " · handed on to the main agent at the end" : ""}`);
				lines.push(
					main
						? `${shelfLabel(item)} is marked for your shelf (${size}). Nothing changed in your context now. From the next collapse on it stands at the start, and every task begins with it read.`
						: `${shelfLabel(item)} is on your shelf (${size}). It stays in view when your steps are collapsed.${handOn ? " When you return, it goes onto the main agent's shelf as well." : ""}`,
				);
				continue;
			}

			if (action === POLICY.enums.actions.unshelve) {
				const given = String(op.path ?? "").trim();
				if (given === "") return fail("unshelve needs `path`: the file to take off the shelf, or all.");
				const mine = main ? store.shelf : (store.tasks[api.conversationId]?.shelf ?? []);
				const gone = given === "all" ? mine : mine.filter((entry) => shelfLabel(entry) === given || entry.path === given || entry.path === given.replace(/^\.\//, ""));
				if (gone.length === 0) return fail(`${given} is not on your shelf.${mine.length > 0 ? ` On it: ${mine.map(shelfLabel).join(", ")}.` : " The shelf is empty."}`);
				updateContext(brainDir, (next) => {
					if (main) next.shelf = next.shelf.filter((entry) => !gone.some((other) => sameItem(other, entry)));
					else taskState(next, api.conversationId).shelf = mine.filter((entry) => !gone.some((other) => sameItem(other, entry)));
				});
				shown.push(`unshelved ${gone.map(shelfLabel).join(", ")}`);
				lines.push(`Taken off your shelf: ${gone.map(shelfLabel).join(", ")}.${main ? " A copy that stands in your context stays there until the next collapse." : ""}`);
				continue;
			}

			if (action === POLICY.enums.actions.fold) {
				const ids = String(op.id ?? "")
					.split(/[\s,]+/)
					.filter((id) => id !== "");
				if (ids.length === 0) return fail(`fold needs \`id\`: ${main ? "the report to drop from view, like t12" : "the step to drop, like s3; large results end with a mark that names theirs"}.`);
				if (main) {
					const inView = reportsInView(messages);
					const unknown = ids.filter((id) => !inView.has(id) || store.dropped.includes(id));
					if (unknown.length > 0) {
						const open = [...inView.keys()].filter((id) => !store.dropped.includes(id));
						return fail(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in your context in full, so there is nothing to drop.${open.length > 0 ? ` In full: ${open.join(", ")}.` : " No report is."}`);
					}
					updateContext(brainDir, (next) => {
						next.dropped = [...new Set([...next.dropped, ...ids])];
					});
					const freed = ids.reduce((sum, id) => sum + inView.get(id).tokens, 0);
					const first = Math.min(...ids.map((id) => inView.get(id).index));
					const again = messages.slice(first + 1).reduce((sum, message) => sum + messageTokens(message), 0);
					shown.push(`dropped ${ids.join(", ")} · about ${count(freed)} tokens freed`);
					lines.push(
						`Dropped from view: ${ids.join(", ")}, about ${count(freed)} tokens. In ${ids.length === 1 ? "its" : "their"} place stands the record line. The server reads what follows again, about ${count(again)} tokens. ${ids.length === 1 ? `Its record: ${recordLine(composedRows(store).find((record) => record.id === ids[0]) ?? { id: ids[0], at: Date.now(), mode: POLICY.enums.planMode.look, brief: "?", outcome: "?" })}` : "recall brings one back."}`,
					);
					continue;
				}
				const steps = stepsOf(messages);
				const mine = store.tasks[api.conversationId] ?? {};
				const hidden = mine.cut?.steps ?? 0;
				const inView = (steps?.results ?? []).filter((result) => result.index >= steps.start + hidden && mine.dropped?.[result.id] === undefined);
				const unknown = ids.filter((id) => !inView.some((result) => result.id === id));
				if (unknown.length > 0) {
					const large = inView.filter((result) => result.tokens >= POLICY.limits.context.largeResultTokens);
					return fail(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a result in your view.${large.length > 0 ? ` Your larger results: ${large.map((result) => `${result.id} (${engine.callWords(result.call)}, about ${count(result.tokens)} tokens)`).join("; ")}.` : " You have no large result in view."}`);
				}
				const picked = inView.filter((result) => ids.includes(result.id));
				updateContext(brainDir, (next) => {
					const task = taskState(next, api.conversationId);
					task.dropped ??= {};
					for (const id of ids) task.dropped[id] = "You dropped this result.";
				});
				const freed = picked.reduce((sum, result) => sum + result.tokens, 0);
				const again = messages.slice(Math.min(...picked.map((result) => result.index)) + 1).reduce((sum, message) => sum + messageTokens(message), 0);
				shown.push(`dropped ${ids.join(", ")} · about ${count(freed)} tokens freed`);
				lines.push(`Dropped: ${ids.join(", ")}, about ${count(freed)} tokens. The server reads what follows again, about ${count(again)} tokens.`);
				continue;
			}

			if (action === POLICY.enums.actions.note) {
				if (main) return fail(REFUSALS.mainNotes);
				const text = String(op.text ?? "").trim();
				if (text === "") return fail("note needs `text`: what to keep, with file paths and line numbers.");
				updateContext(brainDir, (next) => {
					(taskState(next, api.conversationId).notes ??= []).push(text);
				});
				shown.push(`noted · ${count(text.length)} characters`);
				lines.push("Noted. It stays when your steps are collapsed.");
				continue;
			}

			if (action === POLICY.enums.actions.collapse) {
				const why = String(op.text ?? "").replace(/\s+/g, " ").trim().slice(0, POLICY.limits.bookTool.refusalChars);
				if (main) {
					engine.want(why === "" ? "you asked for it" : `you asked for it: ${why}`, { asked: true, byAgent: true });
					shown.push("collapse asked for");
					lines.push("Your context is collapsed when the calls of this reply are done. Your next request begins with what was kept.");
					continue;
				}
				if (stepsOf(messages) === undefined) return fail("Your steps cannot be found, so nothing was collapsed.");
				updateContext(brainDir, (next) => {
					Object.assign(taskState(next, api.conversationId), { pending: "now", reason: why === "" ? "You asked for it" : `You asked for it (${why})` });
				});
				shown.push("collapse of its steps asked for");
				lines.push("Your steps so far are collapsed before your next reply. You keep the brief, your notes, your shelf and one line for each call.");
				continue;
			}
			return fail("`action` is one of add, edit, done, remove, before, archive, unarchive, delete, recall, shelve, unshelve, fold, note, collapse.");
		}
	} catch (problem) {
		if (!(problem instanceof ShelfError) && !(problem instanceof ContextRowError)) throw problem;
		return fail(problem.message);
	}
	return { output: [{ type: "text", text: lines.join("\n") }], details: { shown } };
}

// The root stays flat for llama.cpp's Qwen tool-call path. The full internal schema uses conditionals so the
// selected book narrows every action to exactly its valid fields; the model-facing schema is deliberately small.
const line = (description, maxLength) => str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", ...(maxLength === undefined ? {} : { maxLength }), description });
const entryId = (description = "The entry (g1, q5, n7).") => line(description);

const LEDGER_OP = union([
	obj(
		{ action: lit(POLICY.enums.actions.add), kind: oneOf(KINDS, { description: "goal, question or note." }), text: line("The entry itself, one line in your words.", LEDGER_TEXT_MAX), done_when: opt(line("For a goal: how you and the user will know it is reached.", LEDGER_TEXT_MAX)) },
		{ allOf: [
			{ if: { properties: { kind: lit(POLICY.enums.ledgerKind.goal) }, required: ["kind"] }, then: { required: ["done_when"] } },
			{ if: { properties: { kind: oneOf(POLICY.enums.ledgerNonGoalKinds) }, required: ["kind"] }, then: { not: { required: ["done_when"] } } },
		], description: "Add a ledger entry; goals need a done-when line." },
	),
	obj({ action: lit(POLICY.enums.actions.done), id: entryId(), text: opt(line("How it ended, one line.", LEDGER_TEXT_MAX)) }, { description: "Close a ledger entry." }),
	obj(
		{ action: lit(POLICY.enums.actions.edit), id: entryId(), text: opt(line("The new wording, one line.", LEDGER_TEXT_MAX)), done_when: opt(line("For a goal: its new done-when line.", LEDGER_TEXT_MAX)) },
		{ anyOf: [{ required: ["text"] }, { required: ["done_when"] }], description: "Edit an entry; change its wording or a goal's done-when line." },
	),
	obj({ action: lit(POLICY.enums.actions.remove), id: entryId() }, { description: "Remove a ledger entry." }),
]);

const PLAN_OP = union([
	obj(
		{ action: lit(POLICY.enums.actions.add), mode: oneOf(MODES, { description: "look: the task only reads. change: it writes files, which needs the user's authorization." }), text: line("Required: one line saying what this item covers.", ITEM_MAX), network: opt(bool({ description: "For a change item: true lets its commands reach the network." })), standing: opt(bool({ description: "For a change item: true makes this a duty that stays open." })), before: opt(entryId("Put the new item in front of this one (p3). Default: at the end.")) },
		{ allOf: [{ if: { properties: { mode: lit(POLICY.enums.planMode.look) }, required: ["mode"] }, then: { not: { anyOf: [{ required: ["network"] }, { required: ["standing"] }] } } }], description: "Add a plan item; look items cannot have change-only flags." },
	),
	obj({ action: lit(POLICY.enums.actions.done), id: entryId("The item (p1, p4)."), text: opt(line("What came of it, one line.", ITEM_MAX)) }, { description: "Mark a plan item finished." }),
	obj(
		{ action: lit(POLICY.enums.actions.edit), id: entryId("The item (p1, p4)."), text: opt(line("The new wording, one line.", ITEM_MAX)), mode: opt(oneOf(MODES, { description: "look or change." })), network: opt(bool({ description: "For a change item: true lets its commands reach the network." })), standing: opt(bool({ description: "For a change item: true makes this a duty that stays open." })) },
		{ allOf: [{ if: { properties: { mode: lit(POLICY.enums.planMode.look) }, required: ["mode"] }, then: { not: { anyOf: [{ required: ["network"] }, { required: ["standing"] }] } } }], anyOf: [{ required: ["text"] }, { required: ["mode"] }, { required: ["network"] }, { required: ["standing"] }], description: "Edit a plan item; look items cannot have change-only flags." },
	),
	obj({ action: lit(POLICY.enums.actions.remove), id: entryId("The item (p1, p4).") }, { description: "Remove a plan item." }),
	obj({ action: lit(POLICY.enums.actions.clear) }, { description: "Clear the plan." }),
]);

const BOOKS_OP = union([
	obj({ action: lit(POLICY.enums.actions.add), kind: oneOf(BOOK_KINDS, { description: "assessment or practice." }), text: line("One short entry, in your words.", BOOK_TEXT_MAX), before: opt(entryId("Put the new entry in front of this one.")) }, { description: "Add an assessment or practice entry." }),
	obj({ action: lit(POLICY.enums.actions.edit), id: entryId("The entry (a3, r7)."), text: line("The new wording of this one entry.", BOOK_TEXT_MAX) }, { description: "Reword one entry." }),
	obj({ action: lit(POLICY.enums.actions.done), id: entryId("The entry (a3, r7)."), text: opt(line("How it was settled, one line.", POLICY.limits.books.outcomeChars)) }, { description: "Settle an entry." }),
	obj({ action: lit(POLICY.enums.actions.remove), id: entryId("The entry (a3, r7).") }, { description: "Remove an entry." }),
	obj({ action: lit(POLICY.enums.actions.before), id: entryId("The entry (a3, r7)."), before: opt(entryId("The entry to stand in front of.")) }, { description: "Reorder an entry." }),
]);

const CONTEXT_OP = union([
	obj({ action: lit(POLICY.enums.actions.add), text: line("A self-contained context row to keep." , POLICY.limits.context.curatedRowChars), before: opt(entryId("Put the row in front of this curated row.")), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Add a curated context row; now makes it visible after this call, next-boundary at the next collapse." }),
	obj({ action: lit(POLICY.enums.actions.edit), id: entryId("The curated row (c1)."), text: line("The complete replacement text for this row.", POLICY.limits.context.curatedRowChars), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Edit a curated context row." }),
	obj({ action: lit(POLICY.enums.actions.done), id: entryId("The curated row (c1)."), text: opt(line("How it was settled.", POLICY.limits.context.curatedRowChars)), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Mark a curated row done." }),
	obj({ action: lit(POLICY.enums.actions.remove), id: entryId("The curated row (c1)."), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Remove a curated context row." }),
	obj({ action: lit(POLICY.enums.actions.before), id: entryId("The curated row to move (c1)."), before: opt(entryId("The curated row to stand in front of.")), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Reorder curated context rows." }),
	obj({ action: lit(POLICY.enums.actions.archive), id: entryId("The context row (c1 or t12)."), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Archive a context row without deleting its content." }),
	obj({ action: lit(POLICY.enums.actions.unarchive), id: entryId("The archived context row (c1 or t12)."), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Restore an archived context row." }),
	obj({ action: lit(POLICY.enums.actions.delete), id: entryId("The context row to delete (c1 or t12)."), when: opt(oneOf(CONTEXT_WHEN)) }, { description: "Delete a context row and its content." }),
	obj({ action: lit(POLICY.enums.actions.recall), id: entryId("The report to bring back (t12).") }, { description: "Recall a kept report." }),
	obj({ action: lit(POLICY.enums.actions.shelve), path: line("A project file/range or typed reference such as report:t12."), lines: opt(line('For files, a line range such as "10-80"; omit for the whole file.')), hand_on: opt(bool({ description: "In a task, put this file or reference on the main agent's shelf when you return." })) }, { description: "Keep a file or typed reference in view." }),
	obj({ action: lit(POLICY.enums.actions.unshelve), path: line('The file/reference to take off the shelf, or "all".') }, { description: "Take a file off the shelf." }),
	obj({ action: lit(POLICY.enums.actions.fold), id: entryId("A report id (t12) or task step ids (s3, s5), separated by commas.") }, { description: "Fold a finished report or step." }),
	obj({ action: lit(POLICY.enums.actions.note), text: line("What the task must keep, with file paths and line numbers.") }, { description: "Keep a finding in task context." }),
	obj({ action: lit(POLICY.enums.actions.collapse), text: opt(line("Why to collapse, in a few words.")) }, { description: "Collapse context now." }),
]);

const branchFor = (book, operations) => ({
	if: { properties: { book: lit(book) }, required: ["book"] },
	then: { properties: { ops: arr(operations, { minItems: POLICY.validation.nonEmptyArrayMinItems }) }, required: ["ops"], not: { required: ["text"] } },
});
// The legacy whole-assessment form keeps its length check in `runBooks`: rejecting a very long value in the
// schema makes the validator echo the entire argument back into the conversation instead of the concise limit error.
const BOOK_CONDITIONS = [
	branchFor(POLICY.enums.bookName.ledger, LEDGER_OP),
	branchFor(POLICY.enums.bookName.plan, PLAN_OP),
	branchFor(POLICY.enums.bookName.context, CONTEXT_OP),
	{
		if: { properties: { book: lit(POLICY.enums.bookName.books) }, required: ["book"] },
		then: {
			properties: { ops: arr(BOOKS_OP, { minItems: POLICY.validation.nonEmptyArrayMinItems }), text: line("The whole assessment, for the legacy write form.") },
			anyOf: [{ required: ["ops"] }, { required: ["text"] }],
			not: { required: ["ops", "text"] },
		},
	},
];

/**
 * @param {{ root: string, brainDir: string, config: object, engine: object, gate?: { yolo: boolean } }} input
 */
export function bookTool({ root, brainDir, config, engine, gate }) {
	const validationSchema = obj(
		{
			book: oneOf(POLICY.enums.bookNames, {
				description: "Which book to write to: ledger (goals, questions, notes), plan (the work for the open goals), books (entries about the project and your practice), context (curated rows, reports, shelf, collapse).",
			}),
			ops: opt(arr(unknown(), { description: "Operations for the selected book." })),
			text: opt(line("The whole assessment, for the legacy write form.")),
		},
		{ allOf: BOOK_CONDITIONS },
	);
	const validate = compile(validationSchema, { coerce: true });
	const parameters = obj(
		{
			book: oneOf(POLICY.enums.bookNames),
			ops: opt(arr(obj({
				action: oneOf(POLICY.enums.bookToolActions),
				kind: opt(oneOf([...KINDS, ...BOOK_KINDS])),
				text: opt(str()),
				done_when: opt(str()),
				id: opt(str()),
				mode: opt(oneOf(MODES)),
				network: opt(bool()),
				standing: opt(bool()),
				before: opt(str()),
				path: opt(str()),
				lines: opt(str()),
				hand_on: opt(bool()),
				when: opt(oneOf(CONTEXT_WHEN)),
			}, { open: true }), { minItems: POLICY.validation.nonEmptyArrayMinItems })),
			text: opt(str()),
		},
		{ allOf: [{ if: { properties: { book: lit(POLICY.enums.bookName.books) }, required: ["book"] }, else: { not: { required: ["text"] } } }] },
	);
	return defineTool({
		name: "book",
		description: describe("book"),
		parameters,
		prepareArguments(args) {
			const result = validate.parse(args);
			if (result.ok) return result.value;
			const path = (pointer) => pointer === "" ? "root" : pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")).join(".");
			const issues = [...result.errors];
			const planAdds = args?.book === POLICY.enums.bookName.plan && Array.isArray(args.ops) ? args.ops.filter((op) => op?.action === POLICY.enums.actions.add) : [];
			const hasRootPlanText = args?.book === POLICY.enums.bookName.plan && Object.hasOwn(args, "text");
			if (hasRootPlanText) {
				// The conditional schema also reports this as an opaque `not` failure; replace it with the actionable cause.
				for (let index = issues.length - 1; index >= 0; index--) {
					if (issues[index].path === "" && issues[index].keyword === "not") issues.splice(index, 1);
				}
				issues.push({ path: "/text", message: "root text is only for the legacy whole-assessment form with book=books; plan wording belongs inside each add operation" });
			}
			const errors = issues.map((error) => `  - ${path(error.path)}: ${error.message}`).join("\n");
			const hints = planAdds.some((op) => op.mode === undefined || op.text === undefined)
				? '\nPlan add shape: {"action":"add","mode":"look or change","text":"one-line plan item"}. Put both `mode` and `text` in every add operation.'
				: "";
			// Do not echo the arguments: malformed text can be very large and the agent already has its original call.
			throw new Error(`Validation failed for tool "book":\n${errors}${hints}`);
		},

		executionMode: "sequential",
		// Safe to run again after a crash: the ledger and the plan remember the last call they applied,
		// and the rest of the books change nothing when the same words are written twice.
		replay: POLICY.enums.toolReplay.safe,
		execute: async (args, api) => {
			const book = args.book;
			if (book !== POLICY.enums.bookName.context && api.conversationId !== ROOT_CONVERSATION_ID) {
				return fail(`Tool call blocked: ${TASK_REFUSALS[book] ?? TASK_REFUSALS.ledger} ${STILL_TASK}`);
			}
			const runner = { ledger: runLedger, plan: runPlan, books: runBooks, context: runContext }[book];
			if (runner === undefined) return fail(`\`book\` is one of ledger, plan, books, context.`);
			const result = runner({ root, brainDir, config, engine, gate }, args, api);
			result.details = { book, ...result.details };
			return result;
		},
	});
}
