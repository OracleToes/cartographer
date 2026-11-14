// The `book` tool: one front door to the agent's own books — ledger, plan, prompt, books, context —
// each of which keeps rows the agent adds to, rewords, closes and takes away. The books themselves and
// the verbs live in src/ledger.mjs, src/plan.mjs, src/proposals.mjs, src/books.mjs and src/context.mjs;
// what is here is the shared shape of the call (`book` names one, `ops` carries the operations) and the
// per-book run of it, whose wording, details and guards are exactly those of the tools it replaces.
//
// A task may use the context operations (fold, recall, shelve, unshelve, note, collapse) as the old
// `context` tool let it; the other books belong to the main agent, and are refused with the same words
// the old per-tool refusals used.
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { arr, bool, lit, obj, oneOf, opt, str, union, unknown } from "@earendil-works/pi-schema";
import { describe, REFUSALS, SECTION_MAX, STILL_TASK, TOOL_MAX } from "../prompt.mjs";
import { applyOp, KINDS, LedgerError, loadLedger, open, openCounts, prune, saveLedger, TEXT_MAX as LEDGER_TEXT_MAX } from "../ledger.mjs";
import { applyPlanOp, authorizationLine, ITEM_MAX, loadPlan, PlanError, savePlan } from "../plan.mjs";
import { applyBookOp, BOOK_KINDS, BOOK_TEXT_MAX, BookError, loadBooks, renderBook, saveBooks } from "../books.mjs";
import { ASSESSMENT_MAX, assessmentPath, saveAssessment } from "../assessment.mjs";
import { noteAssessed } from "../top.mjs";
import { pin } from "../top.mjs";
import { ProposalError, propose, targets } from "../proposals.mjs";
import { loadContext, loadReport, messageTokens, recordLine, reportsInView, ShelfError, shelfItem, shelfLabel, shelfText, estimate, stepsOf, taskState, updateContext, RECALLED } from "../context.mjs";

const count = (n) => Math.round(n).toLocaleString("en-US");
const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
const ok = (text, shown) => ({ output: [{ type: "text", text }], details: { shown: [].concat(shown) } });
const sameItem = (a, b) => a.path === b.path;

/** What a task is told when it reaches for a book of the main agent. */
const TASK_REFUSALS = { ledger: REFUSALS.taskWritesLedger, plan: REFUSALS.taskWritesPlan, prompt: REFUSALS.taskProposes, books: REFUSALS.taskAssesses };

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
	const goalsBefore = new Set(open(ledger, "goal").map((item) => item.id));
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
	const closed = [...goalsBefore].filter((id) => ledger.items.find((item) => item.id === id)?.status === "done");
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
			if (op?.action === "add" && (typeof op.text !== "string" || op.text.trim() === "")) {
				const expected = { action: "add", mode: op.mode === "look" ? "look" : "change", text: "one-line description of what this item covers" };
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

/** The prompt proposals' run: see the `prompt` tool this replaces (src/tools/prompt.mjs in the last release). */
function runPrompt({ brainDir }, args, api) {
	const ops = Array.isArray(args.ops) ? args.ops : [];
	if (ops.length === 0) {
		const known = targets();
		return fail(`\`ops\` is empty: give at least one proposal. Sections: ${known.sections.join(", ")}. Tool descriptions: ${known.tools.join(", ")}.`);
	}
	const lines = [];
	const shown = [];
	let recorded = 0;
	for (const [index, op] of ops.entries()) {
		try {
			const result = propose(brainDir, op, api.now());
			lines.push(result.line);
			shown.push(result.shown);
			recorded++;
		} catch (problem) {
			if (!(problem instanceof ProposalError)) throw problem;
			lines.push(`Op ${index + 1} (${op?.action ?? "?"}) not recorded: ${problem.message}`);
		}
	}
	if (recorded === 0) return fail(lines.join("\n"));
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
	const assessment = renderBook(book, "assessment");
	if (book.items.some((item) => item.kind === "assessment")) {
		saveAssessment(brainDir, assessment);
		noteAssessed(brainDir, assessment);
	}
	const practice = renderBook(book, "practice");
	return {
		output: [{ type: "text", text: `${lines.join("\n")}${practice === "" ? "" : `\n\nYour practice now reads:\n${practice}`}` }],
		details: { shown },
	};
}

/** The context operations' run: see the `context` tool this replaces (src/tools/context.mjs in the last release). */
function runContext({ root, brainDir, config, engine }, args, api) {
	const main = api.conversationId === ROOT_CONVERSATION_ID;
	const ops = Array.isArray(args.ops) ? args.ops : [];
	const store = loadContext(brainDir);
	const messages = engine.messagesOf(api.conversationId) ?? [];
	const lines = [];
	const shown = [];
	try {
		for (const op of ops) {
			const action = op?.action;
			if (action === "recall") {
				const id = String(op.id ?? "").trim();
				if (id === "") return fail(`recall needs \`id\`: the report to bring back.${store.records.length > 0 ? ` Kept: ${store.records.slice(-12).map((record) => record.id).join(", ")}.` : " No report is kept yet."}`);
				const report = loadReport(brainDir, id);
				if (report === undefined) return fail(`There is no report ${id}.${store.records.length > 0 ? ` Kept: ${store.records.slice(-12).map((record) => record.id).join(", ")}.` : " No report is kept yet."}`);
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

			if (action === "shelve") {
				const { item, tokens } = shelfItem(root, op.path, op.lines);
				const mine = main ? store.shelf : (store.tasks[api.conversationId]?.shelf ?? []);
				const others = mine.filter((entry) => !sameItem(entry, item));
				const total = others.reduce((sum, entry) => sum + estimate(shelfText(root, entry)), 0) + tokens;
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

			if (action === "unshelve") {
				const given = String(op.path ?? "").trim();
				if (given === "") return fail("unshelve needs `path`: the file to take off the shelf, or all.");
				const mine = main ? store.shelf : (store.tasks[api.conversationId]?.shelf ?? []);
				const gone = given === "all" ? mine : mine.filter((entry) => entry.path === given || entry.path === given.replace(/^\.\//, ""));
				if (gone.length === 0) return fail(`${given} is not on your shelf.${mine.length > 0 ? ` On it: ${mine.map(shelfLabel).join(", ")}.` : " The shelf is empty."}`);
				updateContext(brainDir, (next) => {
					if (main) next.shelf = next.shelf.filter((entry) => !gone.some((other) => sameItem(other, entry)));
					else taskState(next, api.conversationId).shelf = mine.filter((entry) => !gone.some((other) => sameItem(other, entry)));
				});
				shown.push(`unshelved ${gone.map(shelfLabel).join(", ")}`);
				lines.push(`Taken off your shelf: ${gone.map(shelfLabel).join(", ")}.${main ? " A copy that stands in your context stays there until the next collapse." : ""}`);
				continue;
			}

			if (action === "fold") {
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
						`Dropped from view: ${ids.join(", ")}, about ${count(freed)} tokens. In ${ids.length === 1 ? "its" : "their"} place stands the record line. The server reads what follows again, about ${count(again)} tokens. ${ids.length === 1 ? `Its record: ${recordLine(store.records.find((record) => record.id === ids[0]) ?? { id: ids[0], at: Date.now(), mode: "look", brief: "?", outcome: "?" })}` : "recall brings one back."}`,
					);
					continue;
				}
				const steps = stepsOf(messages);
				const mine = store.tasks[api.conversationId] ?? {};
				const hidden = mine.cut?.steps ?? 0;
				const inView = (steps?.results ?? []).filter((result) => result.index >= steps.start + hidden && mine.dropped?.[result.id] === undefined);
				const unknown = ids.filter((id) => !inView.some((result) => result.id === id));
				if (unknown.length > 0) {
					const large = inView.filter((result) => result.tokens >= 300);
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

			if (action === "note") {
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

			if (action === "collapse") {
				const why = String(op.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
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
			return fail("`action` is one of recall, shelve, unshelve, fold, note, collapse.");
		}
	} catch (problem) {
		if (!(problem instanceof ShelfError)) throw problem;
		return fail(problem.message);
	}
	return { output: [{ type: "text", text: lines.join("\n") }], details: { shown } };
}

// The root stays flat for llama.cpp's Qwen tool-call path. The selected book narrows the operation
// schema with JSON Schema conditionals; each tagged operation then requires exactly the fields it uses.
const line = (description, maxLength) => str({ minLength: 1, pattern: "\\S", ...(maxLength === undefined ? {} : { maxLength }), description });
const entryId = (description = "The entry (g1, q5, n7).") => line(description);

// The book description gives one compact example per branch. Do not send the many field/operation descriptions
// again inside the schema: they add hundreds of repeated tokens, while the conditional constraints remain intact.
const compactSchema = (value) => {
	if (Array.isArray(value)) return value.map(compactSchema);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description").map(([key, child]) => [key, compactSchema(child)]));
};

const LEDGER_OP = union([
	obj(
		{ action: lit("add"), kind: oneOf(KINDS, { description: "goal, question or note." }), text: line("The entry itself, one line in your words.", LEDGER_TEXT_MAX), done_when: opt(line("For a goal: how you and the user will know it is reached.", LEDGER_TEXT_MAX)) },
		{ allOf: [
			{ if: { properties: { kind: lit("goal") }, required: ["kind"] }, then: { required: ["done_when"] } },
			{ if: { properties: { kind: oneOf(["question", "note"]) }, required: ["kind"] }, then: { not: { required: ["done_when"] } } },
		], description: "Add a ledger entry; goals need a done-when line." },
	),
	obj({ action: lit("done"), id: entryId(), text: opt(line("How it ended, one line.", LEDGER_TEXT_MAX)) }, { description: "Close a ledger entry." }),
	obj(
		{ action: lit("edit"), id: entryId(), text: opt(line("The new wording, one line.", LEDGER_TEXT_MAX)), done_when: opt(line("For a goal: its new done-when line.", LEDGER_TEXT_MAX)) },
		{ anyOf: [{ required: ["text"] }, { required: ["done_when"] }], description: "Edit an entry; change its wording or a goal's done-when line." },
	),
	obj({ action: lit("remove"), id: entryId() }, { description: "Remove a ledger entry." }),
]);

const PLAN_OP = union([
	obj(
		{ action: lit("add"), mode: oneOf(["look", "change"], { description: "look: the task only reads. change: it writes files, which needs the user's authorization." }), text: line("Required: one line saying what this item covers.", ITEM_MAX), network: opt(bool({ description: "For a change item: true lets its commands reach the network." })), standing: opt(bool({ description: "For a change item: true makes this a duty that stays open." })), before: opt(entryId("Put the new item in front of this one (p3). Default: at the end.")) },
		{ allOf: [{ if: { properties: { mode: lit("look") }, required: ["mode"] }, then: { not: { anyOf: [{ required: ["network"] }, { required: ["standing"] }] } } }], description: "Add a plan item; look items cannot have change-only flags." },
	),
	obj({ action: lit("done"), id: entryId("The item (p1, p4)."), text: opt(line("What came of it, one line.", ITEM_MAX)) }, { description: "Mark a plan item finished." }),
	obj(
		{ action: lit("edit"), id: entryId("The item (p1, p4)."), text: opt(line("The new wording, one line.", ITEM_MAX)), mode: opt(oneOf(["look", "change"], { description: "look or change." })), network: opt(bool({ description: "For a change item: true lets its commands reach the network." })), standing: opt(bool({ description: "For a change item: true makes this a duty that stays open." })) },
		{ allOf: [{ if: { properties: { mode: lit("look") }, required: ["mode"] }, then: { not: { anyOf: [{ required: ["network"] }, { required: ["standing"] }] } } }], anyOf: [{ required: ["text"] }, { required: ["mode"] }, { required: ["network"] }, { required: ["standing"] }], description: "Edit a plan item; look items cannot have change-only flags." },
	),
	obj({ action: lit("remove"), id: entryId("The item (p1, p4).") }, { description: "Remove a plan item." }),
	obj({ action: lit("clear") }, { description: "Clear the plan." }),
]);

const BOOKS_OP = union([
	obj({ action: lit("add"), kind: oneOf(BOOK_KINDS, { description: "assessment or practice." }), text: line("One short entry, in your words.", BOOK_TEXT_MAX), before: opt(entryId("Put the new entry in front of this one.")) }, { description: "Add an assessment or practice entry." }),
	obj({ action: lit("edit"), id: entryId("The entry (a3, r7)."), text: line("The new wording of this one entry.", BOOK_TEXT_MAX) }, { description: "Reword one entry." }),
	obj({ action: lit("done"), id: entryId("The entry (a3, r7)."), text: opt(line("How it was settled, one line.", 300)) }, { description: "Settle an entry." }),
	obj({ action: lit("remove"), id: entryId("The entry (a3, r7).") }, { description: "Remove an entry." }),
	obj({ action: lit("before"), id: entryId("The entry (a3, r7)."), before: opt(entryId("The entry to stand in front of.")) }, { description: "Reorder an entry." }),
]);

const PROMPT_OP = union([
	obj({ action: lit("edit"), target: line("A section name, or a tool description such as tool.edit."), text: line("The whole new wording.", Math.max(SECTION_MAX, TOOL_MAX)), why: line("What misled you or what you observed, in one line.", 300) }, { description: "Reword a section or a tool description." }),
	obj({ action: lit("add"), name: str({ minLength: 2, maxLength: 24, pattern: "^[a-z][a-z0-9-]+$", description: "A short name for the new section, in small letters." }), text: line("The new section's wording.", SECTION_MAX), before: opt(line("The section it stands in front of.")), why: line("What misled you or what you observed, in one line.", 300) }, { description: "Add a section." }),
	obj({ action: lit("remove"), target: line("The section to drop."), why: line("What misled you or what you observed, in one line.", 300) }, { description: "Drop a section." }),
]);

const CONTEXT_OP = union([
	obj({ action: lit("recall"), id: entryId("The report to bring back (t12).") }, { description: "Recall a kept report." }),
	obj({ action: lit("shelve"), path: line("A file inside the project."), lines: opt(line('A line range such as "10-80"; omit for the whole file.')), hand_on: opt(bool({ description: "In a task, put this file on the main agent's shelf when you return." })) }, { description: "Keep a file in view." }),
	obj({ action: lit("unshelve"), path: line('The file to take off the shelf, or "all".') }, { description: "Take a file off the shelf." }),
	obj({ action: lit("fold"), id: entryId("A report id (t12) or task step ids (s3, s5), separated by commas.") }, { description: "Fold a finished report or step." }),
	obj({ action: lit("note"), text: line("What the task must keep, with file paths and line numbers.") }, { description: "Keep a finding in task context." }),
	obj({ action: lit("collapse"), text: opt(line("Why to collapse, in a few words.")) }, { description: "Collapse context now." }),
]);

const branchFor = (book, operations) => ({
	if: { properties: { book: lit(book) }, required: ["book"] },
	then: { properties: { ops: arr(operations, { minItems: 1 }) }, required: ["ops"], not: { required: ["text"] } },
});
// The legacy whole-assessment form keeps its length check in `runBooks`: rejecting a very long value in the
// schema makes the validator echo the entire argument back into the conversation instead of the concise limit error.
const BOOK_CONDITIONS = [
	branchFor("ledger", LEDGER_OP),
	branchFor("plan", PLAN_OP),
	branchFor("prompt", PROMPT_OP),
	branchFor("context", CONTEXT_OP),
	{
		if: { properties: { book: lit("books") }, required: ["book"] },
		then: {
			properties: { ops: arr(BOOKS_OP, { minItems: 1 }), text: line("The whole assessment, for the legacy write form.") },
			anyOf: [{ required: ["ops"] }, { required: ["text"] }],
			not: { required: ["ops", "text"] },
		},
	},
];

/**
 * @param {{ root: string, brainDir: string, config: object, engine: object, gate?: { yolo: boolean } }} input
 */
export function bookTool({ root, brainDir, config, engine, gate }) {
	return defineTool({
		name: "book",
		description: describe("book"),
		parameters: compactSchema(obj(
			{
				book: oneOf(["ledger", "plan", "prompt", "books", "context"], {
					description: "Which book to write to: ledger (goals, questions, notes), plan (the work for the open goals), prompt (a proposed change to your own prompt), books (entries about the project and your practice), context (fold, recall, shelve, note).",
				}),
				ops: opt(arr(unknown(), { description: "Operations for the selected book." })),
				text: opt(line("The whole assessment, for the legacy write form.")),
			},
			{ allOf: BOOK_CONDITIONS },
		)),
		executionMode: "sequential",
		// Safe to run again after a crash: the ledger and the plan remember the last call they applied,
		// and the rest of the books change nothing when the same words are written twice.
		replay: "safe",
		execute: async (args, api) => {
			const book = args.book;
			if (book !== "context" && api.conversationId !== ROOT_CONVERSATION_ID) {
				return fail(`Tool call blocked: ${TASK_REFUSALS[book] ?? TASK_REFUSALS.ledger} ${STILL_TASK}`);
			}
			const runner = { ledger: runLedger, plan: runPlan, prompt: runPrompt, books: runBooks, context: runContext }[book];
			if (runner === undefined) return fail(`\`book\` is one of ledger, plan, prompt, books, context.`);
			const result = runner({ root, brainDir, config, engine, gate }, args, api);
			result.details = { book, ...result.details };
			return result;
		},
	});
}
