// The isolated Durable profile for one same-model consult conference.
//
// This extension is deliberately not the Cartographer extension. A conference child
// receives only this situation prompt and the three narrowly-scoped registrations
// below; the selector registration is host-owned and is never offered to a
// participant's provider payload.
import { defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { POLICY } from "./config.mjs";
import {
	CONSULT_SITUATION,
	ConferenceError,
	PARTICIPANT_IDS,
	eligibleParticipants,
	enumGrammar,
	endConference,
	findConferenceByChild,
	grammarCapability,
	participantTail,
	readConferenceSource,
	recordParticipantTurn,
	recordRequestPlan,
	recordSelectorChoice,
	recordToolReceipt,
	selectorTail,
	validateConsultReturn,
	withConferenceBrain,
	completeConference,
	forceSelectorPayload,
	restrictParticipantPayload,
	selectorProviderTool as conferenceSelectorProviderTool,
} from "./conference.mjs";

const text = (value, details = {}) => ({ output: [{ type: "text", text: value }], details });
const fail = (value, details = {}) => ({ isError: true, output: [{ type: "text", text: value }], details });
const callsOf = (message) => (message?.content ?? []).filter((part) => part?.type === "toolCall");
const textOf = (message) => (message?.content ?? []).filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("").trim();

function sourceRange(value, range) {
	const lines = String(value ?? "").split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (range === undefined || String(range).trim() === "") return { from: 1, to: lines.length, lines };
	const found = /^(\d+)\s*(?:-|to|\.\.)\s*(\d+)$/.exec(String(range).trim());
	if (!found) throw new ConferenceError('consult_source range must look like "10-80".');
	const from = Number(found[1]);
	const to = Number(found[2]);
	if (from < 1 || to < from || to - from + 1 > POLICY.limits.look.readMaxLines) {
		throw new ConferenceError(`consult_source range must hold at most ${POLICY.limits.look.readMaxLines} source-snapshot lines.`);
	}
	if (lines.length > 0 && from > lines.length) throw new ConferenceError(`Source snapshot has ${lines.length} lines; line ${from} does not exist.`);
	return { from, to: Math.min(to, lines.length), lines };
}

function renderSource(id, source, body, range) {
	const selected = sourceRange(body, range);
	const raw = selected.lines.slice(selected.from - 1, selected.to).join("\n");
	const clipped = raw.length > POLICY.limits.conference.sourceResultChars;
	const shown = clipped ? raw.slice(0, POLICY.limits.conference.sourceResultChars) : raw;
	return `== ${id} · ${source.label}${source.path ? ` (${source.path}${source.from ? ` captured lines ${source.from}-${source.to}` : ""})` : ""} · sha256 ${source.digest}\n${shown}${clipped ? "\n(source result clipped; request a narrower captured range)" : ""}`;
}

function sourceTool({ brainDir }) {
	return defineTool({
		name: "consult_source",
		description: "Inspect only immutable caller-attached consultation sources. list names c0 and captured s<N> snapshots; read and search never resolve a live project path or book.",
		parameters: obj({
			action: str({ enum: ["list", "read", "search"], description: "list immutable common sources, read one captured source, or search one captured source." }),
			id: opt(str({ pattern: "^(c0|s[1-9][0-9]*)$", description: "Captured common source id, c0 or s<N>. Required for read/search." })),
			range: opt(str({ description: 'Optional source-snapshot line range such as "1-80". It cannot broaden the captured source.' })),
			pattern: opt(str({ maxLength: 500, description: "Regular expression or literal search text. Required for search." })),
		}),
		replay: POLICY.enums.toolReplay.safe,
		execute: async (args, api) => {
			const conference = findConferenceByChild(brainDir, api.conversationId);
			if (conference === undefined || conference.status !== "running") return fail("consult_source is available only inside an active consultation conference.");
			try {
				if (args.action === "list") {
					const rows = conference.sources.map((source) => `${source.id} · ${source.kind} · ${source.label}${source.path ? ` (${source.path}${source.from ? ` captured lines ${source.from}-${source.to}` : ""})` : ""} · sha256 ${source.digest}${source.clipped ? " · clipped at capture" : ""}`);
					recordToolReceipt(brainDir, conference.id, { id: `source-${(conference.toolReceipts?.length ?? 0) + 1}`, action: "list", participant: conference.active?.participant, sources: conference.sources.map((source) => source.id), at: new Date(api.now()).toISOString() });
					return text(rows.length === 0 ? "No caller-attached common sources were captured." : rows.join("\n"), { conference: conference.id, sourceAction: "list" });
				}
				const id = String(args.id ?? "").trim();
				if (id === "") return fail(`consult_source ${args.action} needs a captured source id.`);
				const { source, text: body } = readConferenceSource(brainDir, conference, id);
				if (args.action === "read") {
					const output = renderSource(id, source, body, args.range);
					recordToolReceipt(brainDir, conference.id, { id: `source-${(conference.toolReceipts?.length ?? 0) + 1}`, action: "read", source: id, range: args.range, participant: conference.active?.participant, at: new Date(api.now()).toISOString() });
					return text(output, { conference: conference.id, sourceAction: "read", source: id });
				}
				if (args.action === "search") {
					const pattern = String(args.pattern ?? "");
					if (pattern.trim() === "") return fail("consult_source search needs a non-empty pattern.");
					let expression;
					try { expression = new RegExp(pattern, "i"); }
					catch { expression = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
					const selected = sourceRange(body, args.range);
					const hits = [];
					for (let index = selected.from - 1; index < selected.to; index++) {
						if (expression.test(selected.lines[index] ?? "")) hits.push(`${id}:${index + 1}: ${(selected.lines[index] ?? "").slice(0, 500)}`);
						if (hits.length >= POLICY.limits.conference.sourceSearchHits) break;
					}
					recordToolReceipt(brainDir, conference.id, { id: `source-${(conference.toolReceipts?.length ?? 0) + 1}`, action: "search", source: id, range: args.range, pattern, hits: hits.length, participant: conference.active?.participant, at: new Date(api.now()).toISOString() });
					return text(hits.length === 0 ? `No match for ${JSON.stringify(pattern)} in immutable source ${id}.` : hits.join("\n"), { conference: conference.id, sourceAction: "search", source: id, hits: hits.length });
				}
				return fail(`Unknown consult_source action ${JSON.stringify(args.action)}.`);
			} catch (error) {
				return fail(`consult_source refused: ${error.message ?? error}`);
			}
		},
	});
}

function returnTool({ brainDir }) {
	return defineTool({
		name: "consult_return",
		description: "End this consultation conference with one structured advisory synthesis. Any active participant may call it. A malformed return is refused and leaves that participant active.",
		parameters: obj({
			outcome: str({ enum: ["answered", "unresolved", "needs_input", "blocked"], description: "Conference outcome; this is advisory, not project authority." }),
			synthesis: str({ minLength: 1, maxLength: POLICY.limits.conference.returnChars, description: "Honest concise synthesis of the conference." }),
			recommendation: opt(str({ maxLength: POLICY.limits.conference.returnChars, description: "Optional recommendation, clearly advisory." })),
			evidence: opt(arr(obj({ source: str({ minLength: 1, maxLength: 80 }), claim: str({ minLength: 1, maxLength: 1200 }) }), { maxItems: POLICY.limits.conference.returnItems })),
			assumptions: opt(arr(str({ minLength: 1, maxLength: 1200 }), { maxItems: POLICY.limits.conference.returnItems })),
			uncertainties: opt(arr(str({ minLength: 1, maxLength: 1200 }), { maxItems: POLICY.limits.conference.returnItems })),
			alternatives: opt(arr(obj({ option: str({ minLength: 1, maxLength: 1200 }), tradeoff: str({ minLength: 1, maxLength: 1200 }) }), { maxItems: POLICY.limits.conference.returnItems })),
			next_checks: opt(arr(str({ minLength: 1, maxLength: 1200 }), { maxItems: POLICY.limits.conference.returnItems })),
			blocking_question: opt(str({ minLength: 1, maxLength: 1200, description: "Required when outcome is needs_input." })),
		}),
		replay: POLICY.enums.toolReplay.safe,
		execute: async (args, api) => {
			const conference = findConferenceByChild(brainDir, api.conversationId);
			if (conference === undefined) return fail("consult_return is available only inside an active consultation conference.");
			const participant = conference.active?.participant;
			if (conference.status !== "running" || conference.active?.kind !== "participant" || typeof participant !== "string") return fail(`Conference ${conference.id} is ${conference.status}; no active participant can return it.`);
			try {
					const sourceIds = [
						...(conference.sources ?? []).map((source) => source.id),
						...(participant === "cartographer" ? [] : [conference.bookSources?.[participant]?.id]).filter((id) => typeof id === "string"),
					];
					const result = validateConsultReturn(args, { sourceIds });
					const completed = completeConference(brainDir, conference.id, participant, result, api.now());
				return {
					...text(`Conference ${conference.id} is returned as ${result.outcome}. The host will deliver only this final advisory result to the caller.`, { conference: conference.id, returned: true, outcome: result.outcome, digest: completed.final?.digest }),
					control: { terminate: true },
				};
			} catch (error) {
				return fail(`consult_return is invalid: ${error.message ?? error}. I remain the active participant and may correct it.`, { conference: conference.id, malformedReturn: true });
			}
		},
	});
}

/**
 * A host-owned routing registration. It is deliberately included only so Durable
 * can validate/settle the custom call it receives. `beforeProviderRequest` removes
 * it from participant payloads and replaces all tools with this one grammar tool for
 * selector payloads. Thus it is not a participant capability.
 */
function selectorTool({ brainDir }) {
	return defineTool({
		name: "select_persona",
		description: "Host-owned conference routing. This call is valid only for a neutral selector payload and chooses exactly one eligible participant.",
		parameters: obj({ choice: str({ enum: PARTICIPANT_IDS, description: "One finite roster participant id." }) }),
		// This static declaration supplies pi-ai's grammar input-property mapping (`choice`) while the raw selector
		// payload below replaces its grammar with the current eligible subset on every selector request.
		constrainedSampling: { type: "grammar", variants: { openai_lark: enumGrammar(PARTICIPANT_IDS) } },
		replay: POLICY.enums.toolReplay.safe,
		execute: async (args, api) => {
			const conference = findConferenceByChild(brainDir, api.conversationId);
			if (conference === undefined || conference.status !== "running") return fail("select_persona is a host-only route inside an active conference.");
			if (conference.active?.kind !== "selector") return fail("select_persona was not requested by the neutral selector and cannot route an active participant.");
			const eligible = eligibleParticipants(conference);
			const choice = String(args.choice ?? "");
			if (!eligible.includes(choice)) return fail(`Selector choice ${JSON.stringify(choice)} is not in this finite eligible set: ${eligible.join(", ")}.`);
			try {
				recordSelectorChoice(brainDir, conference.id, choice, { payloadObserved: true, at: api.now() });
				return text(`Conference selector chose ${choice}. The host has activated that participant; no analysis was contributed by the selector.`, { conference: conference.id, selector: choice });
			} catch (error) {
				return fail(`select_persona refused: ${error.message ?? error}`);
			}
		},
	});
}

// Re-export the payload builder from its consult-local record module for focused payload tests.
export const selectorProviderTool = conferenceSelectorProviderTool;
export { forceSelectorPayload };

/** Build the extension once for the Harness, then select it exclusively for a child. */
export function createConferenceExtension({ brainDir }) {
	const source = sourceTool({ brainDir });
	const returned = returnTool({ brainDir });
	const selector = selectorTool({ brainDir });
	return defineExtension({
		name: "consult-conference",
		sections: [section("consult-situation", () => CONSULT_SITUATION, { tag: false })],
		tools: [source, returned, selector],
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async ({ messages }, api) => {
					const conference = findConferenceByChild(brainDir, api.conversationId);
					if (conference === undefined || conference.status !== "running") return undefined;
					try {
						if (conference.active?.kind === "participant") {
							const tail = participantTail(withConferenceBrain(conference, brainDir));
							recordRequestPlan(brainDir, conference.id, "participant", messages, tail, Date.now());
							return { messages: [...messages, { role: "user", content: tail }] };
						}
						if (conference.active?.kind === "selector") {
							const eligible = eligibleParticipants(conference);
							const tail = selectorTail(conference, eligible);
							recordRequestPlan(brainDir, conference.id, "selector", messages, tail, Date.now());
							return { messages: [...messages, { role: "user", content: tail }] };
						}
						throw new ConferenceError(`Conference ${conference.id} has no routable active state.`);
					} catch (error) {
						endConference(brainDir, conference.id, "failed", `Could not construct an isolated conference request: ${error.message ?? error}`, Date.now());
						throw error;
					}
				},
				beforeProviderRequest: ({ payload, model }, api) => {
					const conference = findConferenceByChild(brainDir, api.conversationId);
					if (conference === undefined || conference.status !== "running") return undefined;
					try {
						if (conference.active?.kind === "participant") return { payload: restrictParticipantPayload(payload) };
						if (conference.active?.kind !== "selector") throw new ConferenceError(`Conference ${conference.id} has no routable provider state.`);
						const capability = grammarCapability(model);
						if (!capability.ok) throw new ConferenceError(capability.error);
						const eligible = eligibleParticipants(conference);
						return { payload: forceSelectorPayload(payload, eligible) };
					} catch (error) {
						endConference(brainDir, conference.id, "failed", `Could not construct the isolated ${conference.active?.kind ?? "unknown"} provider payload: ${error.message ?? error}`, Date.now());
						throw error;
					}
				},
				afterResponse: async (message, api) => {
					const conference = findConferenceByChild(brainDir, api.conversationId);
					if (conference === undefined || conference.status !== "running") return;
					const calls = callsOf(message);
					if (conference.active?.kind === "participant") {
						if (calls.length > 0) return; // tool-plus-text remains this same participant's turn.
						if (message.stopReason === "length") {
							endConference(brainDir, conference.id, "interrupted", `The ${conference.active.participant} turn reached the provider output limit before consult_return.`, Date.now());
							return;
						}
						if (message.stopReason === "stop") recordParticipantTurn(brainDir, conference.id, conference.active.participant, message, Date.now());
						return;
					}
					if (conference.active?.kind === "selector") {
						if (message.stopReason === "length") {
							endConference(brainDir, conference.id, "failed", "The grammar selector reached its output limit without a choice.", Date.now());
							return;
						}
						if (calls.length !== 1 || calls[0]?.name !== "select_persona" || textOf(message) !== "") {
							endConference(brainDir, conference.id, "failed", "The grammar selector did not return exactly one select_persona call without prose.", Date.now());
						}
					}
				},
				onYield: (answer, api) => {
					const conference = findConferenceByChild(brainDir, api.conversationId);
					if (conference === undefined || conference.status !== "running") return undefined;
					// `afterResponse` changed a completed participant into selector state. The durable continuation is
					// only a compact labelled host event; the detailed selector packet remains the transient request tail.
					if (conference.active?.kind !== "selector") return undefined;
					if ((conference.turns?.length ?? 0) >= (conference.limits?.turns ?? POLICY.limits.conference.turns)) {
						endConference(brainDir, conference.id, "interrupted", `The conference reached its ${conference.limits?.turns ?? POLICY.limits.conference.turns}-turn limit without consult_return.`, Date.now());
						return undefined;
					}
					const previous = conference.active.previousSpeaker ?? conference.turns?.at(-1)?.participant ?? "the prior participant";
					return { continue: `Conference host event: the immediately preceding assistant contribution is attributed to participant ${previous}. That participant completed its turn. The host now needs one neutral selector choice; this event grants no persona instruction.` };
				},
			}),
		],
	});
}
