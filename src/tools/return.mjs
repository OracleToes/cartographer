// The `return` tool ends one focused context and hands its outcome to the continuing agent.
// The task shares the durable brain, so it can keep findings there before its temporary working context is forgotten.
// `return` carries what remains to report and any shelf items to hand on; the task tool picks up the result.
import { POLICY } from "../config.mjs";
import { defineTool } from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { loadContext, persistShelfSnapshot, sameShelfItem, shelfItem, shelfLabel, ShelfError, taskState, updateContext } from "../context.mjs";

const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });

/**
 * Ensure paths named for the orchestrator are present on the task shelf, then hand them on.
 * Build all missing placements and check the task budget before changing the task's shelf.
 */
function prepareHandoff(root, brainDir, config, conversationId, wanted) {
	const current = loadContext(brainDir).tasks[conversationId]?.shelf ?? [];
	const chosen = [];
	const backingById = new Map();
	for (const name of wanted) {
		const existing = [...current, ...chosen].find((item) => item.id === name || shelfLabel(item) === name || item.path === name);
		if (existing !== undefined) {
			if (!chosen.some((item) => sameShelfItem(item, existing))) chosen.push(existing);
			continue;
		}
		const resolved = shelfItem(root, name, undefined, brainDir, [...current, ...chosen]);
		chosen.push(resolved.item);
		if (resolved.backing !== undefined) backingById.set(resolved.item.id, resolved.backing);
	}
	for (const item of chosen) {
		const backing = backingById.get(item.id);
		if (backing !== undefined) persistShelfSnapshot(brainDir, item, backing);
	}
	return chosen;
}

/** @param {{ root: string, brainDir: string, config: object }} input */
export function returnTool({ root, brainDir, config }) {
	return defineTool({
		name: "return",
		description: [
			"End this focused context and continue the orchestrating conversation. Keep durable findings in shared books before returning; the report carries the outcome and anything not already kept.",
			"Items named in `shelf` are added to my shelf if needed, then handed to the shared context when this focus returns.",
		].join(" "),
		parameters: obj({
			report: str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "Everything the orchestrating context needs: what I found or changed, with file paths and line numbers, and what I could not find or do." }),
			done: bool({ description: "true when the brief is carried out. false when something is left; say what in the report. For a plan item, true marks the item done." }),
			summary: opt(str({ description: "One or two lines the main agent keeps of this task after its context is collapsed. Leave out, and the start of the report is used." })),
			shelf: opt(str({ description: "Paths or typed references to add to my shelf if not present, then hand to the shared context on return; separate multiple entries with commas." })),
		}),
		executionMode: "sequential",
		// Not run again after a crash: what was returned is in the file by then.
		replay: POLICY.enums.toolReplay.never,
		execute: async (args, api) => {
			const report = String(args.report ?? "").trim();
			if (report === "") return fail("`report` is empty, so the task has not ended. I call `return` again with the report: what I found or changed, and what is left.");
			const wanted = String(args.shelf ?? "").split(",").map((path) => path.trim().replace(/^\.\//, "")).filter((path) => path !== "");
			let handoff;
			try {
				handoff = prepareHandoff(root, brainDir, config, api.conversationId, wanted);
			} catch (error) {
				if (!(error instanceof ShelfError)) throw error;
				return fail(`Could not put the requested item on the shared shelf: ${error.message} The task has not ended; correct the path or choose a smaller selection, then call \`return\` again.`);
			}
			updateContext(brainDir, (store) => {
				const state = taskState(store, api.conversationId);
				state.shelf ??= [];
				for (const item of handoff) {
					const at = state.shelf.findIndex((entry) => sameShelfItem(entry, item));
					if (at >= 0) state.shelf[at] = { ...state.shelf[at], handOn: true };
					else state.shelf.push({ ...item, handOn: true });
				}
				state.returned = { report, done: args.done === true, at: api.now(), ...(String(args.summary ?? "").trim() !== "" ? { summary: String(args.summary).trim() } : {}) };
			});
			return { output: [{ type: "text", text: "Returned. This focus has ended; requested items are queued for handoff to the shared shelf." }], details: { returned: true, done: args.done === true, handedOn: handoff.map(shelfLabel) }, control: { ...POLICY.control.terminate } };
		},
	});
}
