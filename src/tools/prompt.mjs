// The `prompt` tool: the agent proposes a change to its own prompt (src/proposals.mjs). The user decides.
import { defineTool } from "@earendil-works/pi-durable";
import { arr, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import { describe, SECTION_MAX, TOOL_MAX } from "../prompt.mjs";
import { ProposalError, propose, targets } from "../proposals.mjs";

const why = () => str({ description: "What misled you or what you observed, in one line. The user decides from it." });
const Op = union([
	obj(
		{ action: lit("edit"), target: str({ description: "A section by its name (plan), or a tool's description as tool. and the tool's name (tool.edit)." }), text: str({ description: `The whole new wording: at most ${SECTION_MAX} characters for a section, ${TOOL_MAX} for most descriptions.` }), why: why() },
		{ description: "Reword a section or a tool's description." },
	),
	obj({ action: lit("add"), name: str({ description: "A short name for the new section, in small letters." }), text: str({ description: `Its wording, at most ${SECTION_MAX} characters.` }), before: opt(str({ description: "The section it stands in front of. Left out: at the end." })), why: why() }, { description: "Add a section." }),
	obj({ action: lit("remove"), target: str({ description: "The section to drop." }), why: why() }, { description: "Drop a section." }),
]);

/** @param {{ brainDir: string }} input */
export function promptTool({ brainDir }) {
	return defineTool({
		name: "prompt",
		description: describe("prompt"),
		parameters: obj({
			ops: arr(Op, { description: "Proposals, recorded in order. Each stands on its own: one that cannot be recorded is reported, and the others are kept." }),
		}),
		executionMode: "sequential",
		replay: "never",
		execute: async (args, api) => {
			const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
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
		},
	});
}
