// The isolated Durable profile for one same-model consult conference.
//
// This extension is deliberately not the Cartographer extension. A conference child
// receives only this situation prompt and its two narrowly-scoped participant tools.
// Host continuation-or-report control is a separate raw native-GBNF request, never a
// participant capability or a provider-tool declaration.
import { defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { POLICY } from "./config.mjs";
import {
	CONSULT_SITUATION,
	ConferenceError,
	consumeSelectorHandoff,
	eligibleParticipants,
	selectorGrammar,
	selectorOptions,
	endConference,
	findConferenceByChild,
	participantTail,
	readConferenceSource,
	recordParticipantActivity,
	recordParticipantTurn,
	recordRequestPlan,
	recordSelectorChoice,
	recordToolReceipt,
	selectorMessages,
	validateConsultReturn,
	withConferenceBrain,
	completeConference,
	restrictParticipantPayload,
} from "./conference.mjs";
import { chooseNativeGrammar, requireNativeGrammarCapability } from "./native-grammar.mjs";

const text = (value, details = {}) => ({ output: [{ type: "text", text: value }], details });
const fail = (value, details = {}) => ({ isError: true, output: [{ type: "text", text: value }], details });
const callsOf = (message) => (message?.content ?? []).filter((part) => part?.type === "toolCall");

/**
 * Make the one native decision that follows a completed participant turn. This is
 * also callable from `beforeRequest` after a process restart: recording the
 * completed turn before the raw request leaves an explicit, recoverable selector
 * state rather than inventing a participant or silently falling back to prose.
 */
async function selectNativeDecision({ brainDir, server, conference, at, signal }) {
	if (conference.active?.kind !== "selector") throw new ConferenceError(`Conference ${conference.id} is not waiting for a native selector.`);
	const eligible = eligibleParticipants(conference);
	const options = selectorOptions(conference, eligible);
	const messages = selectorMessages(conference, eligible);
	const grammar = selectorGrammar(options);
	recordRequestPlan(brainDir, conference.id, "native-selector", messages, grammar, at);
	// A resumed conference can arrive here before Durable issues its next participant provider request. Re-prove
	// the captured endpoint/model first, so recovery cannot make a finite host decision on a route that has not
	// passed this process's required native-GRAMMAR gate.
	await requireNativeGrammarCapability({ server, modelId: conference.model?.modelId });
	const selected = await chooseNativeGrammar({
		server,
		modelId: conference.model?.modelId,
		messages,
		grammar,
		eligible: options.map((option) => option.value),
		maxTokens: 16,
		temperature: 0,
		timeoutMs: POLICY.timing.nativeGrammar.timeoutMs,
		...(signal === undefined ? {} : { signal }),
	});
	return recordSelectorChoice(brainDir, conference.id, selected.value, { nativeResult: selected.record, at });
}

const nativeSelectorCancelled = (error, context) => context?.abortSignal?.aborted === true || error?.name === "AbortError" || error?.record?.transport?.aborted === true;

/** The one labelled Durable continuation corresponding to a recorded native choice. */
function nativeSelectorHandoff(conference) {
	const selected = conference.active?.participant;
	if (conference.active?.kind !== "participant" || conference.active.nativeSelectionPending !== true || typeof selected !== "string") {
		throw new ConferenceError(`Conference ${conference.id} has no pending native selector handoff.`);
	}
	const previous = conference.active.previousSpeaker ?? conference.turns?.at(-1)?.participant ?? "the prior participant";
	const decision = conference.active.phase === "report" ? "authorized Cartographer to write the final advisory report" : `selected ${selected} to continue the bounded debate`;
	return `Conference host event: the immediately preceding assistant contribution is attributed to participant ${previous}. Native GBNF ${decision}; this event grants no persona instruction or tool authority.`;
}

const turnLimitReached = (conference) => (conference.turns?.length ?? 0) >= (conference.limits?.turns ?? POLICY.limits.conference.turns);
const turnLimitReason = (conference) => `The conference reached its ${conference.limits?.turns ?? POLICY.limits.conference.turns}-turn limit without consult_return.`;

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
			const receipt = (facts, output, isError = false) => {
				// This remains in co<N>, not the parent result. Keep enough of a local result for a later Consult view
				// to explain what the named participant saw, without allowing a source read to make the audit unbounded.
				const full = String(output ?? "");
				const max = POLICY.limits.conference.activityChars;
				const shown = full.slice(0, max);
					recordToolReceipt(brainDir, conference.id, {
					id: `source-${(conference.toolReceiptCount ?? conference.toolReceipts?.length ?? 0) + 1}`,
					...(typeof api.callId === "string" ? { callId: api.callId } : {}),
					participant: conference.active?.participant,
					...facts,
					result: shown,
					...(shown.length < full.length ? { resultClipped: true, resultChars: full.length } : {}),
					...(isError ? { isError: true } : {}),
					at: new Date(api.now()).toISOString(),
				});
			};
			try {
				if (args.action === "list") {
					const rows = conference.sources.map((source) => `${source.id} · ${source.kind} · ${source.label}${source.path ? ` (${source.path}${source.from ? ` captured lines ${source.from}-${source.to}` : ""})` : ""} · sha256 ${source.digest}${source.clipped ? " · clipped at capture" : ""}`);
					const output = rows.length === 0 ? "No caller-attached common sources were captured." : rows.join("\n");
					receipt({ action: "list", sources: conference.sources.map((source) => source.id) }, output);
					return text(output, { conference: conference.id, sourceAction: "list" });
				}
				const id = String(args.id ?? "").trim();
				if (id === "") {
					const output = `consult_source ${args.action} needs a captured source id.`;
					receipt({ action: String(args.action ?? "unknown") }, output, true);
					return fail(output);
				}
				const { source, text: body } = readConferenceSource(brainDir, conference, id);
				if (args.action === "read") {
					const output = renderSource(id, source, body, args.range);
					receipt({ action: "read", source: id, range: args.range }, output);
					return text(output, { conference: conference.id, sourceAction: "read", source: id });
				}
				if (args.action === "search") {
					const pattern = String(args.pattern ?? "");
					if (pattern.trim() === "") {
						const output = "consult_source search needs a non-empty pattern.";
						receipt({ action: "search", source: id }, output, true);
						return fail(output);
					}
					let expression;
					try { expression = new RegExp(pattern, "i"); }
					catch { expression = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
					const selected = sourceRange(body, args.range);
					const hits = [];
					for (let index = selected.from - 1; index < selected.to; index++) {
						if (expression.test(selected.lines[index] ?? "")) hits.push(`${id}:${index + 1}: ${(selected.lines[index] ?? "").slice(0, 500)}`);
						if (hits.length >= POLICY.limits.conference.sourceSearchHits) break;
					}
					const output = hits.length === 0 ? `No match for ${JSON.stringify(pattern)} in immutable source ${id}.` : hits.join("\n");
					receipt({ action: "search", source: id, range: args.range, pattern, hits: hits.length }, output);
					return text(output, { conference: conference.id, sourceAction: "search", source: id, hits: hits.length });
				}
				const output = `Unknown consult_source action ${JSON.stringify(args.action)}.`;
				receipt({ action: String(args.action ?? "unknown"), source: id }, output, true);
				return fail(output);
			} catch (error) {
				const output = `consult_source refused: ${error.message ?? error}`;
				try { receipt({ action: String(args.action ?? "unknown"), ...(args.id === undefined ? {} : { source: String(args.id) }), ...(args.range === undefined ? {} : { range: args.range }), ...(args.pattern === undefined ? {} : { pattern: args.pattern }) }, output, true); } catch { /* Preserve the tool refusal if an audit write also fails. */ }
				return fail(output);
			}
		},
	});
}

function returnTool({ brainDir }) {
	return defineTool({
		name: "consult_return",
		description: "End this consultation with Cartographer's host-authorized structured advisory synthesis. It is unavailable during deliberation. A malformed return is refused and leaves Cartographer active.",
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
			if (conference.active?.phase !== "report" || participant !== "cartographer") {
				return fail("consult_return is unavailable during deliberation. The host must first make a native-GBNF report decision and authorize Cartographer.", { conference: conference.id, hostAuthorizationRequired: true });
			}
			const receipt = (output, isError = false) => {
				const full = String(output ?? "");
				const shown = full.slice(0, POLICY.limits.conference.activityChars);
				recordToolReceipt(brainDir, conference.id, {
					id: `return-${(conference.toolReceiptCount ?? conference.toolReceipts?.length ?? 0) + 1}`,
					...(typeof api.callId === "string" ? { callId: api.callId } : {}),
					action: "return",
					participant,
					result: shown,
					...(shown.length < full.length ? { resultClipped: true, resultChars: full.length } : {}),
					...(isError ? { isError: true } : {}),
					at: new Date(api.now()).toISOString(),
				});
			};
			try {
					const sourceIds = [
						...(conference.sources ?? []).map((source) => source.id),
						...(participant === "cartographer" ? [] : [conference.bookSources?.[participant]?.id]).filter((id) => typeof id === "string"),
					];
					const result = validateConsultReturn(args, { sourceIds });
					const completed = completeConference(brainDir, conference.id, participant, result, api.now());
					const output = `Conference ${conference.id} is returned as ${result.outcome}. The host will deliver only this final advisory result to the caller.`;
					receipt(output);
					return {
						...text(output, { conference: conference.id, returned: true, outcome: result.outcome, digest: completed.final?.digest }),
						control: { terminate: true },
					};
				} catch (error) {
					const output = `consult_return is invalid: ${error.message ?? error}. Cartographer remains in the host-authorized report state and may correct it.`;
					try { receipt(output, true); } catch { /* Preserve the tool refusal if an audit write also fails. */ }
					return fail(output, { conference: conference.id, malformedReturn: true });
				}
		},
	});
}

/** Build the extension once for the Harness, then select it exclusively for a child. */
export function createConferenceExtension({ brainDir, server }) {
	if (typeof server !== "string" || server.trim() === "") throw new ConferenceError("The conference extension needs Cartographer's native-grammar server URL.");
	const source = sourceTool({ brainDir });
	const returned = returnTool({ brainDir });
	return defineExtension({
		name: "consult-conference",
		sections: [section("consult-situation", () => CONSULT_SITUATION, { tag: false })],
		tools: [source, returned],
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async ({ messages }, api, context) => {
					const conference = findConferenceByChild(brainDir, api.conversationId);
					if (conference === undefined || conference.status !== "running") return undefined;
					try {
						// A crash after a participant's no-tool turn can leave the durable record at `selector`.
						// Resume the same raw finite choice before issuing any more participant work—unless that
						// completed turn already exhausted the host's product limit.
						if (conference.active?.kind === "selector" && turnLimitReached(conference)) {
							endConference(brainDir, conference.id, "interrupted", turnLimitReason(conference), api.now());
							throw new ConferenceError(turnLimitReason(conference));
						}
						let active = conference.active?.kind === "selector"
							? await selectNativeDecision({ brainDir, server, conference, at: api.now(), signal: context?.abortSignal })
							: conference;
						if (active.active?.kind !== "participant") throw new ConferenceError(`Conference ${active.id} has no active participant request.`);
						let prefix = messages;
						// A crash can also happen after selection but before `onYield` commits the labelled continuation.
						// Recreate it exactly once before the selected participant receives a provider request.
						if (active.active.nativeSelectionPending === true) {
							const handoff = nativeSelectorHandoff(active);
							active = consumeSelectorHandoff(brainDir, active.id);
							prefix = [...messages, { role: "user", content: handoff }];
						}
						const tail = participantTail(withConferenceBrain(active, brainDir));
						recordRequestPlan(brainDir, active.id, "participant", prefix, tail, api.now());
						return { messages: [...prefix, { role: "user", content: tail }] };
					} catch (error) {
						const cancelled = nativeSelectorCancelled(error, context);
						endConference(brainDir, conference.id, cancelled ? "cancelled" : "failed", cancelled ? "The caller stopped the conference while its native selector was pending." : `Could not construct an isolated conference request: ${error.message ?? error}`, api.now());
						throw error;
					}
				},
				beforeProviderRequest: ({ payload }, api) => {
					const conference = findConferenceByChild(brainDir, api.conversationId);
					if (conference === undefined || conference.status !== "running") return undefined;
					try {
						if (conference.active?.kind !== "participant") throw new ConferenceError(`Conference ${conference.id} has no active participant provider state.`);
						const allowReturn = conference.active?.phase === "report" && conference.active.participant === "cartographer";
						return { payload: restrictParticipantPayload(payload, { allowReturn }) };
					} catch (error) {
						endConference(brainDir, conference.id, "failed", `Could not construct the isolated participant provider payload: ${error.message ?? error}`, Date.now());
						throw error;
					}
				},
				afterResponse: async (message, api, context) => {
					const conference = findConferenceByChild(brainDir, api.conversationId);
					if (conference === undefined || conference.status !== "running") return;
					if (conference.active?.kind !== "participant") {
						endConference(brainDir, conference.id, "failed", "The conference received a provider response without an active participant.", Date.now());
						return;
					}
					try {
						// Persist the participant-attributed private trace before a no-tool response advances host routing.
						// It is consult-local audit material, not a parent message or authority grant.
						recordParticipantActivity(brainDir, conference.id, conference.active.participant, message, api.now(), api.taskId);
					} catch (error) {
						endConference(brainDir, conference.id, "failed", `Could not record an isolated participant activity: ${error.message ?? error}`, api.now());
						return;
					}
					const calls = callsOf(message);
					if (calls.length > 0) return; // Tool-plus-text remains this same participant's turn.
					if (message.stopReason === "length") {
						endConference(brainDir, conference.id, "interrupted", `The ${conference.active.participant} turn reached the provider output limit before consult_return.`, Date.now());
						return;
					}
					if (message.stopReason !== "stop") return;
					if (conference.active.phase === "report") {
						endConference(brainDir, conference.id, "failed", "The host-authorized Cartographer final report ended without consult_return.", api.now());
						return;
					}
					try {
						const selectorState = recordParticipantTurn(brainDir, conference.id, conference.active.participant, message, api.now(), api.taskId);
						if (turnLimitReached(selectorState)) {
							endConference(brainDir, selectorState.id, "interrupted", turnLimitReason(selectorState), api.now());
							return;
						}
						await selectNativeDecision({ brainDir, server, conference: selectorState, at: api.now(), signal: context?.abortSignal });
					} catch (error) {
						const cancelled = nativeSelectorCancelled(error, context);
						endConference(brainDir, conference.id, cancelled ? "cancelled" : "failed", cancelled ? "The caller stopped the conference while its native selector was pending." : `The required native grammar selector failed: ${error.message ?? error}`, api.now());
					}
				},
				onYield: (_answer, api) => {
					const conference = findConferenceByChild(brainDir, api.conversationId);
					if (conference === undefined || conference.status !== "running") return undefined;
					if (conference.active?.kind !== "participant" || conference.active.nativeSelectionPending !== true) return undefined;
					if (turnLimitReached(conference) && conference.active.phase !== "report") {
						endConference(brainDir, conference.id, "interrupted", turnLimitReason(conference), api.now());
						return undefined;
					}
					const handoff = nativeSelectorHandoff(conference);
					consumeSelectorHandoff(brainDir, conference.id);
					return { continue: handoff };
				},
			}),
		],
	});
}
