// The `return` tool ends one focused context and hands its outcome to the continuing agent.
// The task shares the durable brain, so it can keep findings there before its temporary working context is forgotten.
// `return` carries what remains to report and any shelf items to hand on; the task tool picks up the result.
import { POLICY } from "../config.mjs";
import { defineTool } from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { loadContext, persistShelfSnapshot, sameShelfItem, shelfItem, shelfLabel, ShelfError, taskState, updateContext } from "../context.mjs";
import { describe } from "../prompt.mjs";

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
		description: describe("return"),
		parameters: obj({
			report: str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "Everything the orchestrating context needs: what I found or changed, with file paths and line numbers, and what I could not find or do." }),
			done: bool({ description: "true only when the brief's declared result is carried out and witnessed. false when something is left; say what in the report. For a declared move, true only reports a completion claim; the orchestrator reviews the evidence and accepts it separately." }),
			closure_gap: opt(str({ maxLength: POLICY.limits.plan.proofChars, description: "When the declared result or proof cannot be reached within this focus's targets, capabilities, or available evidence: the smallest exact dependency. It requires done: false." })),
			summary: opt(str({ description: "One or two lines the main agent keeps of this task after its context is collapsed. Leave out, and the start of the report is used." })),
			proof: opt(str({ description: "For a declared change move, the observed evidence required by its contract: the named check and result, or other concrete proof. A done claim without it is blocked for review." })),
			shelf: opt(str({ description: "Paths or typed references to add to my shelf if not present, then hand to the shared context on return; separate multiple entries with commas." })),
		}),
		executionMode: "sequential",
		// Not run again after a crash: what was returned is in the file by then.
		replay: POLICY.enums.toolReplay.never,
		execute: async (args, api) => {
			const report = String(args.report ?? "").trim();
			if (report === "") return fail("`report` is empty, so the task has not ended. I call `return` again with the report: what I found or changed, and what is left.");
			const closureGap = String(args.closure_gap ?? "").replace(/\s+/g, " ").trim();
			if (closureGap !== "" && args.done === true) return fail("`closure_gap` says this focus cannot close its declared result, so `done` must be false. I return again with done: false and the exact gap.");
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
				const proof = String(args.proof ?? "").trim();
				state.returned = { report, done: args.done === true, at: api.now(), ...(closureGap !== "" ? { closureGap } : {}), ...(String(args.summary ?? "").trim() !== "" ? { summary: String(args.summary).trim() } : {}), ...(proof !== "" ? { proof } : {}) };
			});
			const blocked = closureGap === "" ? "" : " The closure gap is recorded for the orchestrating context.";
			return { output: [{ type: "text", text: `Returned. This focus has ended; requested items are queued for handoff to the shared shelf.${blocked}` }], details: { returned: true, done: args.done === true, ...(closureGap !== "" ? { closureGap } : {}), handedOn: handoff.map(shelfLabel) }, control: { ...POLICY.control.terminate } };
		},
	});
}
