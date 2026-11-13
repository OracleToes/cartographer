// The `ledger` tool: how the main agent writes to its notebook (src/ledger.mjs).
import { defineTool } from "@earendil-works/pi-durable";
import { arr, lit, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import { applyOp, KINDS, LedgerError, loadLedger, open, openCounts, prune, saveLedger } from "../ledger.mjs";
import { pin } from "../top.mjs";

const id = () => str({ description: "The entry (g1, q5, n7)." });

// One object shape per action, told apart by `action`. Each shape lists the fields that action takes and marks
// the ones it cannot work without as required, so a missing `text` or `id` is caught by the schema: a
// grammar-constrained server (llama.cpp) cannot leave it out.
//
// Property order matters. Such a server writes properties in the order declared here and may skip optional
// ones. Keep `action` first, then the required fields, then the optional ones.
const Op = union([
	obj(
		{
			action: lit("add"),
			kind: oneOf(KINDS, {
				description:
					"goal: something the user wants achieved, agreed with them. question: something to ask them. note: anything else worth keeping, such as a decision, a preference or a finding.",
			}),
			text: str({ description: "The entry itself, one line in your words." }),
			done_when: opt(str({ description: "A goal only, and required for one: how you and the user will know it is reached." })),
		},
		{ description: "Write a new entry." },
	),
	obj({ action: lit("done"), id: id(), text: opt(str({ description: "How it ended, one line." })) }, { description: "Close an entry." }),
	obj(
		{
			action: lit("edit"),
			id: id(),
			text: opt(str({ description: "The new wording, one line." })),
			done_when: opt(str({ description: "A goal only: the new done-when line." })),
		},
		{ description: "Reword an entry." },
	),
	obj({ action: lit("remove"), id: id() }, { description: "Delete an entry." }),
]);

const opLabel = (op) => `${op?.action ?? "?"}${op?.id || op?.kind ? ` ${op.id || op.kind}` : ""}`;

/** @param {{ brainDir: string }} input */
export function ledgerTool({ brainDir, engine }) {
	return defineTool({
		name: "ledger",
		description: [
			"Your notebook for this project, kept across sessions: goals, questions for the user, and notes worth keeping.",
			"Your conversation is cut short as it grows; the ledger is what stays. Its open entries are shown to you in the state block of every request, and the user reads and edits it too.",
			"Keep it current as you go; it needs no one's permission.",
		].join(" "),
		parameters: obj({
			ops: arr(Op, { description: "Operations, applied in order. Each stands on its own: one that cannot be applied is reported, and the others are saved." }),
		}),
		executionMode: "sequential",
		// Safe to run again after a crash: the file remembers the last call it applied.
		replay: "safe",
		execute: async (args, api) => {
			const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
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
					lines.push(`Op ${index + 1} (${opLabel(op)}) not applied: ${problem.message}`);
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
		},
	});
}
