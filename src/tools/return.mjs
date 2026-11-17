// The `return` tool ends one focused context and hands its outcome to the continuing agent.
// The task shares the durable brain, so it can keep findings there before its temporary working context is forgotten.
// `return` carries what remains to report and any shelf items to hand on; the task tool picks up the result.
import { POLICY } from "../config.mjs";
import { defineTool } from "@earendil-works/pi-durable";
import { arr, bool, obj, opt, str } from "@earendil-works/pi-schema";
import { loadContext, persistShelfSnapshot, sameShelfItem, shelfItem, shelfLabel, ShelfError, taskState, updateContext } from "../context.mjs";
import { CaseError, loadCase, validateCaseArtifact } from "../case.mjs";
import { describe } from "../prompt.mjs";

const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });

// Only a bounded case phase uses this object. It is deliberately closed and mirrors the
// durable v2 artifact fields; src/case.mjs then validates citations against the frozen
// capsule and this phase's immutable source-tool receipts.
const CASE_ARTIFACT = obj({
	candidate: str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.case.artifactTextChars, description: "The narrow candidate account this phase examined." }),
	observations: arr(obj({
		kind: str({ enum: ["direct", "inference"], description: "direct when observed in a frozen source or phase-local receipt; inference otherwise." }),
		text: str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.case.artifactTextChars, description: "One bounded observation or inference." }),
		citations: arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: 64 }), { maxItems: POLICY.limits.case.citations, description: "Citation refs used by this observation. A direct observation needs at least one source or receipt ref." }),
	}), { maxItems: POLICY.limits.case.artifactItems, description: "Structured observations, never a free-form report." }),
	assumptions: arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.case.artifactTextChars }), { maxItems: POLICY.limits.case.artifactItems, description: "Explicit assumptions; use an empty array when there are none." }),
	citations: arr(obj({
		ref: str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: 64, description: "A frozen source id, an immutable receipt id, or a prior artifact claim ref." }),
		kind: str({ enum: ["source", "receipt", "claim"], description: "source for frozen primary or derived sources; receipt for this phase's source-tool receipt; claim for a frozen claim source or prior phase artifact." }),
	}), { maxItems: POLICY.limits.case.citations, description: "The citation registry. It cannot silently turn a claim or phase artifact into primary evidence." }),
	falsifiers: arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.case.artifactTextChars }), { maxItems: POLICY.limits.case.artifactItems, description: "Concrete observations that would falsify the candidate." }),
	proposed_witness: str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.case.artifactTextChars, description: "One proposed next discriminator, or an explicit statement that none is available in this phase." }),
	closure_gaps: arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.case.artifactTextChars }), { maxItems: POLICY.limits.case.artifactItems, description: "Exact unresolved dependencies. When non-empty, return done must be false." }),
	uncertainty: arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.case.artifactTextChars }), { maxItems: POLICY.limits.case.artifactItems, description: "What remains uncertain; use an empty array only when none remains." }),
	cross_examination: opt(arr(obj({
		claim: str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: 64, description: "A material claim id from the recorded constructor packet." }),
		disposition: str({ enum: ["confirmed-flaw", "failed-challenge", "unresolved"], description: "The controlled challenge result; this is a classification, not a vote." }),
		text: str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.case.artifactTextChars, description: "The exact flaw, failed challenge, or unresolved point." }),
		citations: arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: 64 }), { minItems: 1, maxItems: POLICY.limits.case.citations, description: "Artifact citation refs supporting this classification." }),
	}), { maxItems: POLICY.limits.case.crossChallenges, description: "Required only for the controlled cross-examination phase: one classification for every material constructor claim." })),
	witness_assessment: opt(arr(obj({
		claim: str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: 64, description: "An exact target claim id from the main-owned witness docket." }),
		disposition: str({ enum: ["supports", "refutes", "unresolved"], description: "The witness result for that claim; not a vote or a final synthesis." }),
		text: str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.case.witnessTextChars, description: "The exact source/proof result or unresolved point." }),
		citations: arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: 64 }), { minItems: 1, maxItems: POLICY.limits.case.citations, description: "Artifact citation refs supporting this witness result." }),
	}), { maxItems: POLICY.limits.case.witnessClaims, description: "Required only for a C3 witness phase: one assessment for every docket target claim." })),
}, { description: "Required only in a v2 case phase. Stored as structured data and a deterministic readable rendering." });

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
			artifact: opt(CASE_ARTIFACT),
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
			const task = loadContext(brainDir).tasks[api.conversationId];
			const caseId = typeof task?.caseId === "string" ? task.caseId : undefined;
			const phaseId = typeof task?.phase === "string" ? task.phase : undefined;
			let artifact;
			if (caseId !== undefined && phaseId !== undefined) {
				if (wanted.length > 0) return fail("A bounded case phase cannot hand shelf items onward. Put cited observations in its structured `artifact`; the case record is its only durable handoff.");
				if (closureGap !== "") return fail("A v2 case phase records closure gaps in `artifact.closure_gaps`, not the ordinary `closure_gap` field. I return again with the structured artifact and done: false.");
				const loaded = loadCase(brainDir, caseId);
				if (loaded.case === undefined) return fail(`The case artifact cannot be recorded: ${loaded.error}`);
				if (loaded.case.version === 2) {
					if (args.artifact === undefined) return fail(`This v2 case phase must return its schema-validated \`artifact\`; a free-form report is not a durable case artifact. I return again with candidate, observations, assumptions, citations, falsifiers, proposed_witness, closure_gaps, and uncertainty${phaseId === "falsify-cross-exam" ? ", and cross_examination" : ""}${phaseId === "witness" && loaded.case.flow !== undefined ? ", and witness_assessment" : ""}.`);
					try {
						validateCaseArtifact(loaded.case, phaseId, args.artifact, { done: args.done === true });
						artifact = JSON.parse(JSON.stringify(args.artifact));
					} catch (error) {
						if (error instanceof CaseError) return fail(`The v2 case artifact is refused: ${error.message} Correct it and call \`return\` again.`);
						throw error;
					}
				}
			}
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
				state.returned = { report, done: args.done === true, at: api.now(), ...(closureGap !== "" ? { closureGap } : {}), ...(String(args.summary ?? "").trim() !== "" ? { summary: String(args.summary).trim() } : {}), ...(proof !== "" ? { proof } : {}), ...(artifact !== undefined ? { artifact } : {}) };
			});
			const blocked = closureGap === "" ? "" : " The closure gap is recorded for the orchestrating context.";
			return { output: [{ type: "text", text: `Returned. This focus has ended; requested items are queued for handoff to the shared shelf.${blocked}` }], details: { returned: true, done: args.done === true, ...(closureGap !== "" ? { closureGap } : {}), handedOn: handoff.map(shelfLabel) }, control: { ...POLICY.control.terminate } };
		},
	});
}
