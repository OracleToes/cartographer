// The `case` tool: one bounded same-model evidence case. Historical cases retain three
// separate read-only focus contexts; C2 cases isolate construction and blind falsification,
// then resume that blind context once for a controlled constructor packet. No phase is an
// agent, vote, or independent corroborator; separation is only controlled visibility and objective.
import { configure, defineTool } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { POLICY } from "../config.mjs";
import { CASE_ID_PATTERN, CASE_PHASES, CASE_FLOW_PHASES, CaseError, beginCasePhase, createCase, finishCasePhase, hasCaseFlow, loadCase, markCaseMessagesDelivered, markCrossExaminationPacketDelivered, phaseOf, readyCase, renderCapsule, renderCase, renderCaseForSynthesis, renderCrossExaminationPacket, stopCase, synthesizeCase } from "../case.mjs";
import { endTaskContext, loadContext, taskState, updateContext } from "../context.mjs";
import { SIBLING_AFTER, SIBLING_BEFORE, TASK_HEADER, describe } from "../prompt.mjs";
import { selectedEvidence } from "./task.mjs";

const fail = (text, details) => ({ isError: true, output: [{ type: "text", text }], ...(details === undefined ? {} : { details }) });
const compact = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const CASE_LOOK_NOTE = "This case phase may use only `read`, `search`, and `list` to inspect project sources. It does not use `book`, `shelf`, or `shell`: the durable case artifact is its only handoff, so no phase creates an ambient evidence channel for another.";

/** The explicit phase contract, placed after the ordinary read-only focus contract. */
function phaseBrief(caseFile, phase, participant = []) {
	const lines = [
		TASK_HEADER,
		"",
		"Case phase",
		`I am the same Cartographer agent in the ${phase.name} phase of case ${caseFile.id}, not a separate agent, a vote, or independent corroboration. This is a bounded read-only evidence context: project file writes, shell-window access, shared-brain edits, and shelf changes are refused. The plan stays with the main context, and this phase cannot start a task, case, wake, or sleep, call chat, ask, or consult, or hand a shelf item onward. The user participates through the durable case queue. I inspect sources, distinguish observation from inference, and end with one \`return\` artifact. Agreement between phase artifacts does not prove a claim.`,
		CASE_LOOK_NOTE,
		"",
		`Objective: ${phase.objective}`,
		"",
		renderCapsule(caseFile),
	];
	if (phase.id === "falsify" || phase.id === "falsify-blind") {
		lines.push("", "Visibility boundary", "The construction artifact, its digest, summary, and citations are deliberately absent. I do not reconstruct or assume them; I seek counterexamples, missing conditions, and alternatives from the capsule and project sources alone.");
	}
	if (phase.id === "witness") {
		const previous = caseFile.phases.filter((entry) => entry.id !== "witness");
		lines.push("", "Earlier artifacts to check, not to trust");
		for (const entry of previous) {
			const artifact = entry.artifact;
			if (artifact === undefined) lines.push(`  ${entry.name}: no returned artifact.`);
			else {
				const artifactText = typeof artifact.rendering === "string" ? artifact.rendering : String(artifact.text ?? "");
				const state = artifact.kind === "failure" ? "no structured return" : artifact.done === true ? "returned done" : artifact.done === false ? "returned not done" : entry.status;
				lines.push(`  ${entry.name} · ${state} · sha256 ${artifact.digest}${artifact.clipped ? " · clipped by the v1 storage bound" : ""}\n${artifactText.split("\n").map((line) => `    ${line}`).join("\n")}`);
			}
		}
	}
	if (participant.length > 0) {
		lines.push("", "Participant input routed to this phase");
		for (const message of participant) lines.push(`  [${message.id}] ${message.text}`);
		lines.push("  These are direction from the user, recorded with this case. They do not enlarge the frozen evidence capsule or grant project-write authority.");
	}
	if (caseFile.version === 2) {
		lines.push("", "Structured return artifact", `I call \`return\` with a short \`report\`, \`done\`, and the required \`artifact\` object. Its fields are candidate, observations, assumptions, citations, falsifiers, proposed_witness, closure_gaps, and uncertainty${phase.id === "falsify-cross-exam" ? ", and cross_examination" : ""}. A direct observation cites a frozen source id or an immutable receipt id from my own read/search/list result; a prior phase artifact is only a claim under review, never primary evidence. I use empty arrays where a category has none, name any closure gap inside artifact.closure_gaps, and return done false when it has one. The durable artifact is the schema-validated object and deterministic rendering, not my free-form report.`);
	} else {
		lines.push("", "Return artifact", "I call `return` with done true only if I completed this phase's stated artifact. My report says what I observed, what I inferred, and what remains uncertain. I do not state a final supported/refuted/unresolved conclusion: that belongs only to the main context after all artifacts return.");
	}
	return lines.join("\n");
}

/** Find an orphaned phase fork of this same outer case call after a restart. */
async function phaseConversation(api, callContext, caseId, phaseId) {
	return api.commit(async (tx) => {
		const owned = await tx.scanConversations({ ownerTaskId: api.taskId }, POLICY.limits.case.phaseLookup);
		for (const conversation of owned.items) {
			const entries = await tx.scanEntries({ conversationId: conversation.id, order: "ascending", minEntryId: conversation.parent?.at }, POLICY.limits.taskHistory.contextEntries);
			const found = entries.items.find((entry) => entry.conversationId === conversation.id && (entry.kind === "carto.case-phase" || entry.kind === "carto.case-cross-exam") && entry.data?.caseId === caseId && entry.data?.phase === phaseId);
			if (found !== undefined) return conversation.id;
		}
		return undefined;
	}, callContext);
}

/** Fork one separate focus from the case call. The parent conversation stays outside its provider projection. */
async function forkPhase(api, callContext, caseFile, phase, participant) {
	return api.commit(async (tx) => {
		const recent = await tx.scanEntries({ conversationId: api.conversationId }, POLICY.limits.taskHistory.recentEntries);
		let calls;
		const at = recent.items.find((entry) =>
			(entry.model ?? []).some((message) => {
				if (message.role !== "assistant") return false;
				const found = message.content.filter((part) => part.type === "toolCall");
				if (!found.some((part) => part.id === api.callId)) return false;
				calls = found;
				return true;
			}),
		);
		if (at === undefined) throw new Error("case: the entry of this call was not found");
		const fork = await tx.forkConversation(api.conversationId, at.id, { ownership: { kind: "task", taskId: api.taskId } });
		// A C2 cross-examination deliberately continues the blind falsifier's same context, so Durable's ceiling
		// covers both bounded passes while the harness resets and enforces each pass's own phase budget.
		await configure(tx, fork.id, { maxTurns: (phase.id === "falsify-blind" ? POLICY.limits.case.phaseTurns * 2 : POLICY.limits.case.phaseTurns) + 2 });
		let briefGiven = false;
		for (const call of calls) {
			const mine = call.id === api.callId;
			const text = mine
				? phaseBrief(caseFile, phase, participant)
				: briefGiven
					? SIBLING_AFTER
					: SIBLING_BEFORE;
			if (mine) briefGiven = true;
			await tx.appendEntry(fork.id, {
				kind: mine ? "carto.case-phase" : "carto.sibling",
				model: [{ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: false, timestamp: api.now() }],
				...(mine ? { data: { mode: POLICY.enums.planMode.look, turns: POLICY.limits.case.phaseTurns, caseId: caseFile.id, phase: phase.id } } : {}),
			});
		}
		return fork.id;
	}, callContext);
}

/** Append the constructor packet only after the blind artifact has reached the durable case file. The entry has its
 * own Durable identity, and the case-file delivery receipt is written afterwards so a restart can find it rather than
 * replaying the blind pass or creating a second packet. */
async function appendCrossPacket(brainDir, caseFile, api, callContext) {
	if (!hasCaseFlow(caseFile) || caseFile.flow.state !== "falsify-cross-exam") throw new CaseError(`Case ${caseFile.id} is not awaiting controlled cross-examination.`);
	const blind = phaseOf(caseFile, "falsify-blind");
	const conversationId = blind.conversationId;
	if (typeof conversationId !== "string" || conversationId === "") throw new CaseError(`Case ${caseFile.id}'s blind falsification has no reusable focus context.`);
	const packet = caseFile.flow.crossPacket;
	if (packet?.delivery !== undefined) return packet.delivery;
	const text = renderCrossExaminationPacket(caseFile);
	const packetDigest = packet?.textDigest;
	if (typeof packetDigest !== "string") throw new CaseError(`Case ${caseFile.id}'s controlled cross-examination packet is missing.`);
	const delivered = await api.commit(async (tx) => {
		// Case JSON deliberately stores a printable durable id. Resolve it back to Durable's branded runtime id before
		// calling Tx.appendEntry; passing the printable string would select its typed-entry overload.
		const owned = await tx.scanConversations({ ownerTaskId: api.taskId }, POLICY.limits.case.phaseLookup);
		const target = owned.items.find((entry) => String(entry.id) === conversationId);
		if (target === undefined) throw new CaseError(`Case ${caseFile.id}'s blind falsifier context cannot be found for controlled cross-examination.`);
		const entries = await tx.scanEntries({ conversationId: target.id, order: "descending" }, POLICY.limits.taskHistory.contextEntries);
		const existing = entries.items.find((entry) => String(entry.conversationId) === conversationId && entry.kind === "carto.case-cross-exam" && entry.data?.caseId === caseFile.id && entry.data?.packetDigest === packetDigest);
		if (existing !== undefined) return { entryId: String(existing.id), at: finiteTimestamp(existing.model?.[0]?.timestamp, api.now()) };
		const entry = await tx.appendEntry(target.id, {
			kind: "carto.case-cross-exam",
			model: [{ role: "user", content: text, timestamp: api.now() }],
			data: { mode: POLICY.enums.planMode.look, turns: POLICY.limits.case.phaseTurns, caseId: caseFile.id, phase: "falsify-cross-exam", packetDigest },
		});
		return { entryId: String(entry.id), at: api.now() };
	}, callContext);
	return markCrossExaminationPacketDelivered(brainDir, caseFile.id, { conversationId, entryId: delivered.entryId, packetDigest, at: delivered.at });
}

const finiteTimestamp = (value, fallback) => Number.isFinite(value) ? value : fallback;

const phaseFailure = (phase, settled) => {
	const detail = settled?.detail ? ` (${String(settled.detail).slice(0, POLICY.limits.case.failureChars)})` : "";
	const reason = settled?.reason ?? settled?.status ?? "ended without a return";
	return `The ${phase.name} phase ended without calling return: ${reason}${detail}. Its artifact is unavailable; this is not evidence either way.`;
};

/**
 * @param {{ root: string, brainDir: string, config: object, active: { id?: string, said: any[], heard: any[], kind?: string, caseId?: string, phase?: string, deliver?: (entries: any[]) => void } }} input
 */
export function caseTool({ root, brainDir, config, active }) {
	const clearPhase = () => {
		active.id = undefined;
		active.phase = undefined;
		active.said = [];
		active.heard = [];
		delete active.deliver;
	};
	const clearCase = () => {
		clearPhase();
		active.kind = undefined;
		active.caseId = undefined;
	};

	/** Start or resume one phase, and turn its returned report into an immutable case artifact. */
	const runPhase = async (caseId, phaseId, api, callContext) => {
		let loaded = loadCase(brainDir, caseId);
		if (loaded.case === undefined) throw new CaseError(loaded.error);
		let caseFile = loaded.case;
		let phase = phaseOf(caseFile, phaseId);
		let child = phase.conversationId;
		let initial = [];
		if (phase.status === "queued") {
			// Messages queued while one phase ended are part of this phase's initial capsule; anything arriving after
			// this point goes through the next tool result, the same timing contract as a task message. The controlled
			// cross-examination is the sole exception: it deliberately resumes the sealed blind falsifier context.
			initial = caseFile.messages.filter((message) => message.route === "queued" && message.delivery === undefined);
			if (hasCaseFlow(caseFile) && phase.id === "falsify-cross-exam") {
				const deliveredTo = caseFile.flow.crossPacket?.delivery?.conversationId;
				if (typeof deliveredTo !== "string" || deliveredTo === "") throw new CaseError(`Case ${caseId}'s controlled cross-examination packet has not reached the blind falsifier context.`);
				child = await phaseConversation(api, callContext, caseId, phase.id);
				if (child === undefined) throw new CaseError(`Case ${caseId}'s durable cross-examination packet context cannot be reopened.`);
			} else child = (await phaseConversation(api, callContext, caseId, phase.id)) ?? (await forkPhase(api, callContext, caseFile, phase, initial));
			const begun = beginCasePhase(brainDir, caseId, phase.id, { conversationId: child, at: api.now() });
			const initialIds = new Set(initial.map((message) => message.id));
			const present = begun.messages.filter((message) => initialIds.has(message.id));
			if (present.length > 0) markCaseMessagesDelivered(brainDir, caseId, present.map((message) => message.id), phase.id, { at: api.now(), via: "initial capsule" });
			// A user may have written while the fork was made. It is active now, but was not in the static brief.
			initial = begun.messages.filter((message) => !initialIds.has(message.id));
			loaded = loadCase(brainDir, caseId);
			if (loaded.case === undefined) throw new CaseError(loaded.error);
			caseFile = loaded.case;
			phase = phaseOf(caseFile, phaseId);
		} else if (phase.status !== "active") {
			return phase;
		} else {
			initial = caseFile.messages.filter((message) => message.phase === phase.id && message.delivery === undefined);
		}
		if (child === undefined) child = phase.conversationId;
		if (hasCaseFlow(caseFile) && phase.id === "falsify-cross-exam" && typeof child === "string") child = (await phaseConversation(api, callContext, caseId, phase.id)) ?? child;
		if (child === undefined) throw new CaseError(`Case ${caseId}'s ${phase.name} phase has no focus context.`);

		// State used by the ordinary read-only task guard and state block. No move token is present, so both direct
		// project changes and writable commands remain refused by the existing authority boundary.
		updateContext(brainDir, (store) => {
			Object.assign(taskState(store, child), {
				purpose: `examine case ${caseId}: ${phase.name}`,
				mode: POLICY.enums.planMode.look,
				turns: POLICY.limits.case.phaseTurns,
				caseId,
				phase: phase.id,
			});
		});
		active.kind = "case";
		active.caseId = caseId;
		active.phase = phase.id;
		active.id = child;
		active.said = initial.map((message) => ({ text: message.text, at: message.at, caseMessageId: message.id }));
		active.heard = [];
		active.deliver = (entries) => {
			const ids = entries.map((entry) => entry.caseMessageId).filter((entry) => typeof entry === "string");
			markCaseMessagesDelivered(brainDir, caseId, ids, phase.id, { at: Date.now(), via: "next result" });
		};
		let settled;
		let interrupted;
		let timedOut = false;
		try {
			await api.details({ case: caseId, phase: phase.id, phaseName: phase.name, conversationId: child, mode: POLICY.enums.planMode.look, turns: POLICY.limits.case.phaseTurns }, callContext);
			const handle = await api.conversation(child, callContext);
			let deadline;
			try {
				const submission = await handle.submit({ type: "continue", requestId: `case:${api.taskId}:${caseId}:${phase.id}` }, callContext);
				deadline = setTimeout(() => {
					timedOut = true;
					try { stopCase(brainDir, caseId, { at: Date.now(), why: `${phase.name} exceeded its ${Math.round(POLICY.limits.case.phaseRuntimeMs / 1000)} second runtime limit` }); } catch { /* A concurrent user stop wins. */ }
					void handle.abort(callContext).catch(() => {});
				}, POLICY.limits.case.phaseRuntimeMs);
				settled = await submission.wait(callContext);
			} finally {
				if (deadline !== undefined) clearTimeout(deadline);
			}
		} catch (error) {
			interrupted = error;
		} finally {
			// Keep the case itself active while it advances between phases, but stop routing to this now-finished focus.
			active.id = undefined;
			active.phase = undefined;
			delete active.deliver;
		}
		const task = loadContext(brainDir).tasks[child];
		const returned = task?.returned;
		try {
			const current = loadCase(brainDir, caseId);
			if (current.case === undefined) throw new CaseError(current.error);
			if (phaseOf(current.case, phase.id).status === "active") {
				const stopped = current.case.status === "stopped";
				const failure = timedOut
					? `The ${phase.name} phase exceeded its ${Math.round(POLICY.limits.case.phaseRuntimeMs / 1000)} second runtime limit and was stopped before it returned an artifact.`
					: interrupted === undefined ? phaseFailure(phase, settled) : `The ${phase.name} phase was interrupted before it returned an artifact: ${String(interrupted?.message ?? interrupted).slice(0, POLICY.limits.case.failureChars)}.`;
				finishCasePhase(brainDir, caseId, phase.id, stopped
					? { stopped: true, failure }
					: returned === undefined ? { failure } : { returned: true, report: returned.report, done: returned.done, summary: returned.summary, artifact: returned.artifact }, { at: api.now() });
			}
		} finally {
			// A phase cannot alter the shared brain or shelf, so ending its local context only removes isolated state.
			endTaskContext(root, brainDir, config, child);
			active.said = [];
			active.heard = [];
		}
		if (interrupted !== undefined && !timedOut) throw interrupted;
		const finished = loadCase(brainDir, caseId);
		if (finished.case === undefined) throw new CaseError(finished.error);
		return phaseOf(finished.case, phase.id);
	};

	const runCase = async (id, api, callContext) => {
		active.kind = "case";
		active.caseId = id;
		active.id = undefined;
		active.phase = undefined;
		active.said = [];
		active.heard = [];
		try {
			let first = loadCase(brainDir, id);
			if (first.case === undefined) throw new CaseError(first.error);
			if (hasCaseFlow(first.case)) {
				// C2 stops at the durable main-owned witness boundary. The constructor and blind pass may run, then the
				// packet is appended only after the sealed blind artifact before the same falsifier context continues.
				for (;;) {
					const loaded = loadCase(brainDir, id);
					if (loaded.case === undefined) throw new CaseError(loaded.error);
					if (loaded.case.status !== "running") break;
					const state = loaded.case.flow.state;
					if (state === "awaiting-witness-specification" || state === "witness" || state === "ready-for-synthesis") break;
					const wanted = CASE_FLOW_PHASES.find((entry) => entry.id === state);
					if (wanted === undefined) throw new CaseError(`Case ${id} has unsupported flow state ${state}.`);
					if (state === "falsify-cross-exam") await appendCrossPacket(brainDir, loaded.case, api, callContext);
					const refreshed = loadCase(brainDir, id);
					if (refreshed.case === undefined) throw new CaseError(refreshed.error);
					const phase = phaseOf(refreshed.case, wanted.id);
					if (["complete", "ended", "stopped"].includes(phase.status)) throw new CaseError(`Case ${id}'s ${phase.name} is terminal but its flow remains ${state}.`);
					await runPhase(id, phase.id, api, callContext);
				}
			} else {
				for (const wanted of CASE_PHASES) {
					const loaded = loadCase(brainDir, id);
					if (loaded.case === undefined) throw new CaseError(loaded.error);
					if (loaded.case.status !== "running") break;
					const phase = phaseOf(loaded.case, wanted.id);
					if (phase.status === "complete" || phase.status === "ended" || phase.status === "stopped") continue;
					await runPhase(id, phase.id, api, callContext);
				}
				const loaded = loadCase(brainDir, id);
				if (loaded.case === undefined) throw new CaseError(loaded.error);
				if (loaded.case.status === "running" && loaded.case.phases.every((phase) => phase.status !== "queued" && phase.status !== "active")) readyCase(brainDir, id, { at: api.now() });
			}
			let loaded = loadCase(brainDir, id);
			if (loaded.case === undefined) throw new CaseError(loaded.error);
			return loaded.case;
		} finally {
			clearCase();
		}
	};

	return defineTool({
		name: "case",
		description: describe("case"),
		parameters: obj({
			action: str({ enum: ["start", "resume", "synthesize"], description: "start a bounded evidence case, resume a durable running case, or record the main context's synthesis." }),
			question: opt(str({ maxLength: POLICY.limits.case.questionChars, description: "On start: one narrow refutable question. The same frozen capsule feeds every phase." })),
			claim: opt(str({ maxLength: POLICY.limits.case.questionChars, description: "On start: the exact claim to test. Omit only when the question itself is the claim." })),
			context: opt(str({ maxLength: POLICY.limits.case.contextChars, description: "On start: compact facts, constraints, and source locations that the phases may not guess. It is frozen with the case." })),
			criteria: opt(arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.case.ledgerTextChars }), { minItems: 1, maxItems: POLICY.limits.case.criteria, description: "On start: concrete resolution criteria. Omit only to use the policy-owned evidence-bound default." })),
			constraints: opt(arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.case.ledgerTextChars }), { maxItems: POLICY.limits.case.constraints, description: "On start: constraints that narrow interpretation without granting authority." })),
			non_goals: opt(arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.case.ledgerTextChars }), { maxItems: POLICY.limits.case.constraints, description: "On start: explicit non-goals for the frozen capsule." })),
			shelf: opt(arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S" }), { maxItems: POLICY.limits.case.evidenceItems, description: "On start: selected main-shelf placement IDs to freeze into the evidence capsule as primary sources. Omit for none." })),
			id: opt(str({ pattern: `^${CASE_ID_PATTERN}$`, description: "On resume or synthesize: the durable case id, such as c1." })),
			outcome: opt(str({ enum: ["supported", "refuted", "unresolved"], description: "On synthesize: the main context's evidence-weighted conclusion." })),
			report: opt(str({ maxLength: POLICY.limits.case.synthesisChars, description: "On synthesize: why the phase artifacts and concrete witness support that conclusion; agreement is not a vote." })),
			residual: opt(str({ maxLength: POLICY.limits.case.residualChars, description: "On synthesize: what remains uncertain or untested." })),
		}),
		executionMode: "sequential",
		// A start/replay finds its durable case and phase contexts again; synthesis itself is idempotent only by an
		// explicit existing result, so it refuses a second conclusion rather than rewriting provenance.
		replay: POLICY.enums.toolReplay.safe,
		execute: async (args, api, callContext) => {
			try {
				if (args.action === "synthesize") {
					const id = String(args.id ?? "").trim();
					if (id === "") return fail("`synthesize` needs the case `id`.");
					const result = synthesizeCase(brainDir, id, { outcome: args.outcome, report: args.report, residual: args.residual, at: api.now() });
					return { output: [{ type: "text", text: `Case ${id} is recorded as ${result.synthesis.outcome}. Its durable synthesis now stands in cases/${id}.json. This is my evidence-weighted conclusion, not a phase vote.${result.synthesis.residual ? ` Residual uncertainty: ${result.synthesis.residual}` : ""}` }], details: { case: id, status: result.status, outcome: result.synthesis.outcome } };
				}
				let id;
				if (args.action === "start") {
					const question = compact(args.question);
					if (question === "") return fail("`start` needs one narrow `question` whose answer can be supported, refuted, or left unresolved.");
					const handed = selectedEvidence(root, brainDir, args.shelf);
					if (handed.refusal !== undefined) return fail(handed.refusal);
					const remembered = await api.memo("case", callContext);
					if (typeof remembered === "string") id = remembered;
					else {
						const created = createCase(brainDir, { question, claim: args.claim, context: args.context, criteria: args.criteria, constraints: args.constraints, nonGoals: args.non_goals, evidence: handed.evidence, at: api.now() });
						id = await api.memo("case", created.id, callContext);
					}
				} else if (args.action === "resume") {
					id = String(args.id ?? "").trim();
					if (id === "") return fail("`resume` needs the case `id`.");
				} else return fail("`action` is start, resume, or synthesize.");
				const before = loadCase(brainDir, id);
				if (before.case === undefined) return fail(before.error);
				if (before.case.status === "ready") return { output: [{ type: "text", text: renderCaseForSynthesis(before.case) }], details: { case: id, status: before.case.status } };
				if (before.case.status === "synthesized" || before.case.status === "stopped") return { output: [{ type: "text", text: renderCase(before.case) }], details: { case: id, status: before.case.status, ...(before.case.synthesis?.outcome ? { outcome: before.case.synthesis.outcome } : {}) } };
				const completed = await runCase(id, api, callContext);
				const text = completed.status === "ready"
					? renderCaseForSynthesis(completed)
					: renderCase(completed);
				return { output: [{ type: "text", text }], details: { case: id, status: completed.status, phases: completed.phases.map((phase) => ({ id: phase.id, status: phase.status, conversationId: phase.conversationId })) } };
			} catch (error) {
				if (error instanceof CaseError) return fail(error.message);
				throw error;
			}
		},
	});
}
