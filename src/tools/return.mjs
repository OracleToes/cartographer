// The `return` tool: the one way a task ends.
//
// A task is a fork of the main conversation, so the model in it has the main agent's history and tools in view.
// When the work is done it looks for a way to finish, and without one of its own it reaches for the main agent's.
// This is its own: a deliberate call that carries the report, says whether the brief is carried out, and may
// say how the task should be remembered. The task tool (src/tools/task.mjs) picks up what was returned.
import { defineTool } from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { shelfLabel, taskState, updateContext } from "../context.mjs";

const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });

/** @param {{ brainDir: string }} input */
export function returnTool({ brainDir }) {
	return defineTool({
		name: "return",
		description: [
			"End the task you are and hand your report to the main agent. Only a task calls this, and a task ends in no other way.",
			"The main agent sees `report` and nothing else you did.",
		].join(" "),
		parameters: obj({
			report: str({ description: "Everything the main agent needs: what you found or changed, with file paths and line numbers, and what you could not find or do." }),
			done: bool({ description: "true when the brief is carried out. false when something is left; say what in the report. For a plan item, true marks the item done." }),
			summary: opt(str({ description: "One or two lines the main agent keeps of this task after its context is collapsed. Leave out, and the start of the report is used." })),
			shelf: opt(str({ description: "Files on your shelf to put on the main agent's shelf as well: paths, separated by commas. Leave out for none." })),
		}),
		executionMode: "sequential",
		// Not run again after a crash: what was returned is in the file by then.
		replay: "never",
		execute: async (args, api) => {
			const report = String(args.report ?? "").trim();
			if (report === "") return fail("`report` is empty, so the task has not ended. Call `return` again with the report: what you found or changed, and what is left.");
			const wanted = String(args.shelf ?? "").split(",").map((path) => path.trim().replace(/^\.\//, "")).filter((path) => path !== "");
			const outcome = updateContext(brainDir, (store) => {
				const state = taskState(store, api.conversationId);
				const missing = wanted.filter((path) => !(state.shelf ?? []).some((item) => item.path === path));
				if (missing.length > 0) return { missing, have: (state.shelf ?? []).map(shelfLabel) };
				for (const item of state.shelf ?? []) if (wanted.includes(item.path)) item.handOn = true;
				state.returned = { report, done: args.done === true, at: api.now(), ...(String(args.summary ?? "").trim() !== "" ? { summary: String(args.summary).trim() } : {}) };
				return {};
			});
			if (outcome.missing !== undefined) {
				return fail(`Not on your shelf: ${outcome.missing.join(", ")}. ${outcome.have.length > 0 ? `Your shelf holds ${outcome.have.join(", ")}.` : "Your shelf is empty."} The task has not ended: call \`return\` again without \`shelf\`, or name files from your shelf.`);
			}
			return { output: [{ type: "text", text: "Returned. The task has ended." }], details: { returned: true, done: args.done === true }, control: { terminate: true } };
		},
	});
}
