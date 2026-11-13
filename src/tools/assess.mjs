// The `assess` tool: the main agent writes its books (src/books.mjs) — short
// entries about the project (assessment) and about how it works (practice),
// with the same verbs as the ledger and the plan. The old whole-text `text`
// argument still works, for a hand-written assessment.md and for callers that
// predate the books; a call with `ops` uses the entry language.
import { defineTool } from "@earendil-works/pi-durable";
import { arr, lit, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import { ASSESSMENT_MAX, assessmentPath, saveAssessment } from "../assessment.mjs";
import { applyBookOp, BOOK_ACTIONS, BOOK_KINDS, BookError, BOOK_TEXT_MAX, loadBooks, renderBook, saveBooks } from "../books.mjs";
import { noteAssessed } from "../top.mjs";

const id = () => str({ description: "The entry (a3, r7)." });
const kind = () => oneOf(BOOK_KINDS, { description: "assessment: what the project is and how it is built. practice: what you learned about the harness or a habit to keep." });

const Op = union([
	obj({ action: lit("add"), kind: kind(), text: str({ description: `One short entry, at most ${BOOK_TEXT_MAX} characters.` }), before: opt(id()) }, { description: "Add an entry, optionally in front of another." }),
	obj({ action: lit("edit"), id: id(), text: str({ description: "The new wording of this one entry." }) }, { description: "Reword one entry (compacting is an edit)." }),
	obj({ action: lit("done"), id: id(), text: opt(str({ description: "How it was settled, one line." })) }, { description: "Settle an entry." }),
	obj({ action: lit("remove"), id: id() }, { description: "Remove an entry." }),
	obj({ action: lit("before"), id: id(), before: opt(str({ description: "The entry to stand in front of. Left out: the end." })) }, { description: "Reorder an entry." }),
]);

/** @param {{ brainDir: string }} input */
export function assessTool({ brainDir }) {
	return defineTool({
		name: "assess",
		description: [
			"Your books: short entries about this project (assessment) and about how you work (practice), kept at the top of your context.",
			`Use the same verbs as the ledger and plan: add, edit, done, remove, before. One \`ops\` call holds several. Compacting is one \`edit\`: never rewrite the whole.`,
			`An old-style call with \`text\` instead replaces the whole assessment once (at most ${ASSESSMENT_MAX} characters); prefer the entries.`,
		].join(" "),
		parameters: obj({
			ops: opt(arr(Op, { description: `Operations on the books, applied in order (${BOOK_ACTIONS.join(", ")}). Each stands on its own: one that cannot be applied is reported, and the others are kept.` })),
			text: opt(str({ description: `Old-style: the whole assessment, at most ${ASSESSMENT_MAX} characters. Use \`ops\` instead.` })),
		}),
		executionMode: "sequential",
		// Writing the same words twice changes nothing.
		replay: "safe",
		execute: async (args, api) => {
			const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
			// The books: entries with ids, one shared language.
			if (Array.isArray(args.ops) && args.ops.length > 0) {
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
			// The old whole-text call, kept for a hand-written assessment.md and older callers.
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
		},
	});
}
