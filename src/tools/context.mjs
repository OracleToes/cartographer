// The `context` tool: what the agent can do about its own context (src/context.mjs).
//
// Most of the work is automatic. This is for the cases where the agent knows better:
// a report it needs again, a file worth keeping in view, a large result it is done
// with. The main agent and a task both have it. For a task it reaches the task's
// own steps only: what stands before its brief is the main agent's.
//
// Each answer says what the action costs, where it costs something: the model server
// keeps what it has read and reads again from the first place that changed.
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { loadContext, loadReport, messageTokens, recordLine, reportsInView, ShelfError, shelfItem, shelfLabel, shelfText, estimate, stepsOf, taskState, updateContext, RECALLED } from "../context.mjs";
import { REFUSALS } from "../prompt.mjs";

const count = (n) => Math.round(n).toLocaleString("en-US");
const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
const ok = (text, shown) => ({ output: [{ type: "text", text }], details: { shown: [].concat(shown) } });
const sameItem = (a, b) => a.path === b.path;

/** @param {{ root: string, brainDir: string, config: { shelfTokens: number }, engine: ReturnType<typeof import("../engine.mjs").createEngine> }} input */
export function contextTool({ root, brainDir, config, engine }) {
	// One flat object (see src/tools/wake.mjs for why), so nothing but `action` can be marked required.
	const Parameters = obj({
		action: oneOf(["recall", "shelve", "unshelve", "fold", "drop", "note", "collapse"], {
			description:
				"recall: bring a kept report back, with `id`. shelve: keep a file in view, with `path` and maybe `lines`. unshelve: take it off, with `path`. fold: shrink a report you have done the bookkeeping for to its one-line record, with `id` (drop is the old name for the same thing). note: (task) write down what must stay when your steps are collapsed, with `text`. collapse: collapse your context now.",
		}),
		id: opt(str({ description: "For recall: the report (t12). For fold/drop: what to fold, one id or several with commas: a report (t12) for the main agent, a step (s3, s5) for a task." })),
		path: opt(str({ description: "For shelve and unshelve: a file, as a path inside the project. For unshelve also: all." })),
		lines: opt(str({ description: 'For shelve: a range of lines like "10-80". Leave out for the whole file.' })),
		hand_on: opt(bool({ description: "For shelve, in a task: true puts the file on the main agent's shelf as well when the task ends." })),
		text: opt(str({ description: "For note: the finding, with file paths and line numbers. For collapse: why, in a few words." })),
	});
	return defineTool({
		name: "context",
		description: [
			"Manage your own context. Cartographer collapses it by itself when it must; this is for what you know better.",
			'recall: {"action":"recall","id":"t12"} returns report t12 in full again. It is in view until the next collapse.',
			'shelve: {"action":"shelve","path":"src/roll.py","lines":"1-80"} marks a file for your shelf. Nothing changes now; from the next collapse on it stands at the start of your context, and every task you start begins with it read. Shelve what you keep sending tasks to read.',
				"fold: shrinks a report you have finished the bookkeeping for to its one-line record (recallable by id). The state block lists what is in view in full with its size. The server then reads everything after that place again, so fold what is large and far from the end only when you will work on for a while.",
			"collapse: do it now, when you are done with a stretch of work and what matters is written down.",
		].join(" "),
		parameters: Parameters,
		executionMode: "sequential",
		// Not run a second time after a crash: what it changed is in the file by then.
		replay: "never",
		execute: async (args, api) => {
			const main = api.conversationId === ROOT_CONVERSATION_ID;
			const action = args.action;
			const store = loadContext(brainDir);
			const messages = engine.messagesOf(api.conversationId) ?? [];
			try {
				if (action === "recall") {
					const id = String(args.id ?? "").trim();
					if (id === "") return fail(`recall needs \`id\`: the report to bring back.${store.records.length > 0 ? ` Kept: ${store.records.slice(-12).map((record) => record.id).join(", ")}.` : " No report is kept yet."}`);
					const report = loadReport(brainDir, id);
					if (report === undefined) return fail(`There is no report ${id}.${store.records.length > 0 ? ` Kept: ${store.records.slice(-12).map((record) => record.id).join(", ")}.` : " No report is kept yet."}`);
					if (reportsInView(messages).has(id) && !store.dropped.includes(id)) return fail(`Report ${id} is still in your context, further up: nothing was added.`);
					// A report the main agent dropped comes back by this, too.
					if (main && store.dropped.includes(id)) {
						updateContext(brainDir, (next) => {
							next.dropped = next.dropped.filter((entry) => entry !== id);
						});
						return ok(`Report ${id} stands in its place again, further up.`, `recalled ${id} · back in its place`);
					}
					return ok(`${report}\n\n${RECALLED}`, `recalled ${id} · about ${count(estimate(report))} tokens`);
				}

				if (action === "shelve") {
					const { item, tokens } = shelfItem(root, args.path, args.lines);
					const mine = main ? store.shelf : (store.tasks[api.conversationId]?.shelf ?? []);
					const others = mine.filter((entry) => !sameItem(entry, item));
					const total = others.reduce((sum, entry) => sum + estimate(shelfText(root, entry)), 0) + tokens;
					if (total > config.shelfTokens) {
						return fail(
							`${shelfLabel(item)} is about ${count(tokens)} tokens, and the shelf would then hold ${count(total)} of at most ${count(config.shelfTokens)}. Shelve a range of lines instead, or take something off first${others.length > 0 ? `: ${others.map(shelfLabel).join(", ")}` : ""}.`,
						);
					}
					const handOn = !main && args.hand_on === true;
					updateContext(brainDir, (next) => {
						const list = main ? next.shelf : (taskState(next, api.conversationId).shelf ??= []);
						const at = list.findIndex((entry) => sameItem(entry, item));
						const entry = { ...item, ...(handOn ? { handOn: true } : {}) };
						if (at >= 0) list[at] = entry;
						else list.push(entry);
					});
					const size = `about ${count(tokens)} tokens; the shelf then holds ${count(total)} of ${count(config.shelfTokens)}`;
					return ok(
						main
							? `${shelfLabel(item)} is marked for your shelf (${size}). Nothing changed in your context now. From the next collapse on it stands at the start, and every task begins with it read.`
							: `${shelfLabel(item)} is on your shelf (${size}). It stays in view when your steps are collapsed.${handOn ? " When you return, it goes onto the main agent's shelf as well." : ""}`,
						`shelved ${shelfLabel(item)} · about ${count(tokens)} tokens${handOn ? " · handed on to the main agent at the end" : ""}`,
					);
				}

				if (action === "unshelve") {
					const given = String(args.path ?? "").trim();
					if (given === "") return fail("unshelve needs `path`: the file to take off the shelf, or all.");
					const mine = main ? store.shelf : (store.tasks[api.conversationId]?.shelf ?? []);
					const gone = given === "all" ? mine : mine.filter((entry) => entry.path === given || entry.path === given.replace(/^\.\//, ""));
					if (gone.length === 0) return fail(`${given} is not on your shelf.${mine.length > 0 ? ` On it: ${mine.map(shelfLabel).join(", ")}.` : " The shelf is empty."}`);
					updateContext(brainDir, (next) => {
						if (main) next.shelf = next.shelf.filter((entry) => !gone.some((other) => sameItem(other, entry)));
						else taskState(next, api.conversationId).shelf = mine.filter((entry) => !gone.some((other) => sameItem(other, entry)));
					});
					return ok(`Taken off your shelf: ${gone.map(shelfLabel).join(", ")}.${main ? " A copy that stands in your context stays there until the next collapse." : ""}`, `unshelved ${gone.map(shelfLabel).join(", ")}`);
				}

				// `fold` is the canonical name; `drop` is kept as an alias so an older habit still works.
				if (action === "fold" || action === "drop") {
					const ids = String(args.id ?? "")
						.split(/[\s,]+/)
						.filter((id) => id !== "");
					if (ids.length === 0) return fail(`drop needs \`id\`: ${main ? "the report to drop from view, like t12" : "the step to drop, like s3; large results end with a mark that names theirs"}.`);
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
						return ok(
							`Dropped from view: ${ids.join(", ")}, about ${count(freed)} tokens. In ${ids.length === 1 ? "its" : "their"} place stands the record line. The server reads what follows again, about ${count(again)} tokens. ${ids.length === 1 ? `Its record: ${recordLine(store.records.find((record) => record.id === ids[0]) ?? { id: ids[0], at: Date.now(), mode: "look", brief: "?", outcome: "?" })}` : "recall brings one back."}`,
							`dropped ${ids.join(", ")} · about ${count(freed)} tokens freed`,
						);
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
					return ok(`Dropped: ${ids.join(", ")}, about ${count(freed)} tokens. The server reads what follows again, about ${count(again)} tokens.`, `dropped ${ids.join(", ")} · about ${count(freed)} tokens freed`);
				}

				if (action === "note") {
					if (main) return fail(REFUSALS.mainNotes);
					const text = String(args.text ?? "").trim();
					if (text === "") return fail("note needs `text`: what to keep, with file paths and line numbers.");
					updateContext(brainDir, (next) => {
						(taskState(next, api.conversationId).notes ??= []).push(text);
					});
					return ok("Noted. It stays when your steps are collapsed.", `noted · ${count(text.length)} characters`);
				}

				if (action === "collapse") {
					const why = String(args.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
					if (main) {
						engine.want(why === "" ? "you asked for it" : `you asked for it: ${why}`, { asked: true, byAgent: true });
						return ok("Your context is collapsed when the calls of this reply are done. Your next request begins with what was kept.", "collapse asked for");
					}
					if (stepsOf(messages) === undefined) return fail("Your steps cannot be found, so nothing was collapsed.");
					updateContext(brainDir, (next) => {
						Object.assign(taskState(next, api.conversationId), { pending: "now", reason: why === "" ? "You asked for it" : `You asked for it (${why})` });
					});
					return ok("Your steps so far are collapsed before your next reply. You keep the brief, your notes, your shelf and one line for each call.", "collapse of its steps asked for");
				}
				return fail("`action` is one of recall, shelve, unshelve, fold, drop, note, collapse.");
			} catch (problem) {
				if (!(problem instanceof ShelfError)) throw problem;
				return fail(problem.message);
			}
		},
	});
}

/**
 * What a task hands on to the main agent's shelf when it ends, and the cleaning up after it.
 * @returns {{ added: string[], refused: string[] }}
 */
export function endTaskContext(root, brainDir, config, conversationId) {
	return updateContext(brainDir, (store) => {
		const task = store.tasks[conversationId];
		delete store.tasks[conversationId];
		const added = [];
		const refused = [];
		for (const { handOn, ...item } of (task?.shelf ?? []).filter((entry) => entry.handOn === true)) {
			const others = store.shelf.filter((entry) => entry.path !== item.path);
			const total = [...others, item].reduce((sum, entry) => sum + estimate(shelfText(root, entry)), 0);
			if (total > config.shelfTokens) {
				refused.push(shelfLabel(item));
				continue;
			}
			store.shelf = [...others, item];
			added.push(shelfLabel(item));
		}
		return { added, refused };
	});
}
