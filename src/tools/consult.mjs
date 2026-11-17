// `consult`: launch an isolated same-model conference and return its final advisory
// synthesis to the conversation that called it. Until the separately gated C5 cutover,
// the retained legacy storyteller path stays behind its old argument shape; a conference
// request never reaches it, a second configured model, or an unconstrained router.
import { configure, defineTool } from "@earendil-works/pi-durable";
import { arr, obj, opt, str, union } from "@earendil-works/pi-schema";
import { POLICY } from "../config.mjs";
import { clipConsultContext, legacyConsultTool } from "./consult-legacy.mjs";
import {
	ConferenceError,
	attachChildConference,
	conferenceSeed,
	createConferenceCapture,
	endConference,
	findConferenceByCaller,
	grammarCapability,
	loadConference,
	probeGrammarCapability,
	renderConferenceResult,
} from "../conference.mjs";
import { describe } from "../prompt.mjs";

const fileSpec = union([
	str({ minLength: 1, maxLength: 1024, description: "A confined project-relative file path to capture immutably." }),
	obj({
		path: opt(str({ minLength: 1, maxLength: 1024, description: "A confined project-relative file path." })),
		range: opt(str({ maxLength: 64, description: 'Optional captured line range, such as "20-100".' })),
		ref: opt(obj({
			id: str({ minLength: 1, maxLength: 256, description: "Catalog file reference id." }),
			namespace: opt(str({ minLength: 16, maxLength: 256 })),
			kind: opt(str({ enum: ["file"] })),
		})),
	}),
]);

const fail = (value, details = {}) => ({ isError: true, output: [{ type: "text", text: value }], details });
const text = (value, details = {}) => ({ output: [{ type: "text", text: value }], details });
const finalStates = new Set(["returned", "failed", "interrupted", "cancelled", "blocked"]);

function conferenceAgent(model, extension) {
	const tools = Array.isArray(extension?.tools) ? extension.tools : [];
	if (extension?.name !== "consult-conference" || tools.length !== 3) {
		throw new ConferenceError("The isolated consult-conference extension is unavailable or incomplete.");
	}
	const maxTurns = Math.max(8, POLICY.limits.conference.turns * 4 + 4);
	// One request-plan record is written per child generation. Keep the child ceiling below the retained audit cap so
	// normal bounded conferences never lose the C3 handoff proof; trimming remains a defensive corruption/retry bound.
	if (maxTurns > POLICY.limits.conference.requestPlans) throw new ConferenceError("Conference request-plan retention is below the child generation ceiling.");
	return {
		model,
		extensions: [extension],
		// Durable agent changes take registration objects, not their persisted names. Selecting both fields makes
		// the child’s callable/model surface explicit even though the extension selection already confines it.
		tools,
		modelTools: tools,
		// The host-owned participant cap is the product boundary. This is only a
		// Durable safety ceiling for calls/tool rounds inside the continuing child.
		maxTurns,
		compaction: { enabled: false },
	};
}

function settlementDescription(settled) {
	if (settled === undefined || settled === null) return "the conference child settled without a receipt";
	const status = typeof settled.status === "string" ? settled.status : "unknown";
	const reason = typeof settled.reason === "string" ? ` (${settled.reason})` : "";
	const detail = typeof settled.detail === "string" && settled.detail.trim() !== "" ? `: ${settled.detail.trim().slice(0, 500)}` : "";
	return `${status}${reason}${detail}`;
}

async function waitWithConferenceLimit(handle, submission, callContext) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ timeout: true }), POLICY.limits.conference.runtimeMs);
	});
	try {
		const settled = await Promise.race([
			submission.wait(callContext).then((value) => ({ settled: value })),
			timeout,
		]);
		if (settled?.timeout === true) {
			try { await handle.abort(callContext); } catch { /* The child may have just completed; inspect its record below. */ }
			return { timedOut: true };
		}
		return settled;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The caller can be main or an ordinary focus. `api.agent()` captures the actual
 * resolved model of that conversation, so `/model` and a retained focus model are
 * honored without reading config.model.
 */
export function consultTool({ root, brainDir, config, conferenceExtension, fetchImpl }) {
	// C5 is deliberately not in this change. Preserve the already-shipped external storyteller implementation for
	// callers using its old shape while C1–C4 conference acceptance is established. The new field is an unambiguous,
	// additive opt-in: a request with `myPersona` (or captured `files`) enters only the same-model conference path.
	// Conference execution never passes `config` to that legacy implementation or reads its model/settings.
	const legacy = legacyConsultTool({ root, brainDir, config, fetchImpl });
	return defineTool({
		name: "consult",
		description: describe("consult"),
		parameters: obj({
			// Keep the pre-C5 legacy question shape broad. createConferenceCapture() enforces the narrower conference
			// bound only after a caller explicitly opts into it with myPersona/files.
			question: str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "One concrete consultation question and desired deliverable." }),
			context: opt(str({ maxLength: POLICY.limits.conference.contextChars, description: "Optional caller-supplied facts. A conference freezes exact captured bytes as c0." })),
			files: opt(arr(fileSpec, { maxItems: POLICY.limits.conference.files, description: "Conference-only confined project files captured immutably at entry. Using this requires myPersona." })),
			myPersona: opt(str({ maxLength: POLICY.limits.conference.personaChars, description: "Required to opt into the isolated same-model conference; its opening Cartographer perspective is consult-local only." })),
			// Until the one-way C5 cutover, a legacy call without myPersona/files continues to use its existing st<N>
			// storyteller contract. A conference request deliberately refuses thread instead of silently mixing products.
			thread: opt(str({ maxLength: 256, description: "Legacy storyteller follow-up thread. It is not accepted by an isolated conference request." })),
		}),
		prepareArguments(args) {
			if (args === null || typeof args !== "object") return args;
			const conference = args.myPersona !== undefined || args.files !== undefined;
			if (conference || typeof args.context !== "string") return args;
			// Match the retained legacy tool's historical head-clipping before this combined schema validates it.
			return { ...args, context: clipConsultContext(args.context).text };
		},
		executionMode: "sequential",
		// Conference executions locate their durable co<N> record/child before making anything new and are safe to
		// replay. The retained legacy implementation remains otherwise intact until the one-way C5 cutover.
		replay: POLICY.enums.toolReplay.safe,
		// Preserve the legacy streaming-tail contract while the two products coexist; conference results are compact.
		outputLimits: legacy.outputLimits,
		execute: async (args, api, callContext) => {
				const conferenceRequest = args.myPersona !== undefined || args.files !== undefined;
				if (!conferenceRequest) return legacy.execute(args, api, callContext);
				if (args.thread !== undefined) {
					return fail("`consult.thread` belongs to the retained legacy storyteller contract and cannot be mixed with an isolated conference. Start the conference without `thread`; after C5, archived material must be supplied explicitly as context.");
				}
				if (typeof args.myPersona !== "string" || args.myPersona.trim() === "") {
					return fail("An isolated same-model consult conference requires a non-empty `myPersona`. Omit conference-only `files` to use the retained legacy consultation until C5.");
				}
				let conference = findConferenceByCaller(brainDir, { taskId: api.taskId, callId: api.callId });
				// A completed record is replayable as its compact receipt even if the provider has since been removed.
				if (conference !== undefined && finalStates.has(conference.status)) {
					return text(renderConferenceResult(conference), { consult: true, conference: conference.id, status: conference.status, replay: true });
				}
				let model;
				if (conference === undefined) {
					try { model = (await api.agent(callContext)).model; }
					catch (error) { return fail(`consult could not resolve the launching conversation's model: ${error.message ?? error}`); }
					if (model === undefined) return fail("consult cannot start because the launching conversation has no resolved model.");
				} else {
					// Recovery never adopts a later /model switch. The immutable record is the only model authority for
					// its pending child, including the rare crash between capture and child configuration.
					model = conference.model;
				}
				if (typeof model?.provider !== "string" || model.provider === "" || typeof model?.modelId !== "string" || model.modelId === "") {
					const why = "The conference has no valid captured same-model identity for recovery.";
					if (conference !== undefined) {
						const ended = endConference(brainDir, conference.id, "failed", why, api.now());
						return fail(renderConferenceResult(ended), { consult: true, conference: ended.id, status: ended.status });
					}
					return fail(`consult cannot start because ${why.toLowerCase()}`);
				}
				const configured = api.models.getModel(model.provider, model.modelId);
				if (configured === undefined) {
					const why = `The captured conference model ${model.provider}/${model.modelId} is unavailable from this session's provider registry.`;
					if (conference !== undefined) {
						const ended = endConference(brainDir, conference.id, "failed", why, api.now());
						return fail(renderConferenceResult(ended), { consult: true, conference: ended.id, status: ended.status });
					}
					return fail(`consult cannot start because ${why.charAt(0).toLowerCase()}${why.slice(1)}`);
				}
				const declared = grammarCapability(configured);
				if (!declared.ok) {
					if (conference !== undefined) {
						const ended = endConference(brainDir, conference.id, "failed", declared.error, api.now());
						return fail(renderConferenceResult(ended), { consult: true, conference: ended.id, status: ended.status });
					}
					return fail(`consult refused before capture: ${declared.error}`);
				}
				const probed = await probeGrammarCapability(api.models, configured);
				if (!probed.ok) {
					if (conference !== undefined) {
						const ended = endConference(brainDir, conference.id, "failed", probed.error, api.now());
						return fail(renderConferenceResult(ended), { consult: true, conference: ended.id, status: ended.status });
					}
					return fail(`consult refused before capture: ${probed.error}`);
				}

				if (conference === undefined) {
					try {
						conference = createConferenceCapture({
							root,
							brainDir,
							question: args.question,
							context: args.context,
							files: args.files ?? [],
							myPersona: args.myPersona,
							model: { provider: model.provider, modelId: model.modelId },
							caller: { conversationId: api.conversationId, callId: api.callId, taskId: api.taskId },
							at: api.now(),
						});
					} catch (error) {
						return fail(`consult could not capture its immutable entry packet: ${error.message ?? error}`);
					}
				}
			let child = conference.childConversationId;
			try {
					child = await api.commit(async (tx) => {
						if (child !== undefined) return child;
						// A crash can create/seed the independent child before the JSON record receives its id. Recover only a
						// child whose own immutable seed names this co<N>; never attach an unrelated child of the outer tool.
						const owned = await tx.scanConversations({ ownerTaskId: api.taskId }, POLICY.limits.conference.childLookup);
						for (const candidate of owned.items) {
							const entries = await tx.scanEntries({ conversationId: candidate.id, order: "ascending", minEntryId: candidate.parent?.at }, POLICY.limits.conference.childEntryLookup);
							const seed = entries.items.find((entry) => entry.conversationId === candidate.id && entry.kind === "carto.conference-seed" && entry.data?.conference === conference.id && entry.data?.version === conference.version);
							if (seed !== undefined) return candidate.id;
						}
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await configure(tx, created.id, conferenceAgent(model, conferenceExtension));
					await tx.appendEntry(created.id, {
						kind: "carto.conference-seed",
						model: [{ role: "user", content: [{ type: "text", text: conferenceSeed(conference, brainDir) }], timestamp: api.now() }],
						data: { conference: conference.id, version: conference.version },
					});
					return created.id;
				}, callContext);
				conference = attachChildConference(brainDir, conference.id, child, api.now());
				await api.details({ consult: true, conference: conference.id, conversationId: child, model: conference.model, status: conference.status }, callContext);
			} catch (error) {
				try { endConference(brainDir, conference.id, "failed", `Could not create its isolated Durable child: ${error.message ?? error}`, api.now()); } catch { /* Preserve original error. */ }
				return fail(`consult ${conference.id} could not create its isolated conference child: ${error.message ?? error}`, { consult: true, conference: conference.id });
			}

			const handle = await api.conversation(child, callContext);
			if (handle === undefined) {
				endConference(brainDir, conference.id, "failed", "The isolated conference child is unavailable after creation.", api.now());
				const latest = loadConference(brainDir, conference.id).conference ?? conference;
				return fail(renderConferenceResult(latest), { consult: true, conference: conference.id });
			}
			let waited;
			try {
				const submission = await handle.submit({ type: "continue", requestId: `consult:${api.taskId}` }, callContext);
				waited = await waitWithConferenceLimit(handle, submission, callContext);
			} catch (error) {
				const cancelled = callContext?.abortSignal?.aborted === true || error?.name === "AbortError";
				try {
					endConference(
						brainDir,
						conference.id,
						cancelled ? "cancelled" : "failed",
						cancelled ? "The caller stopped the outer consult tool before a final consult_return." : `The isolated conference child failed: ${error.message ?? error}`,
						api.now(),
					);
				} catch { /* Preserve original error. */ }
			}
				let latest = loadConference(brainDir, conference.id).conference ?? conference;
				if (!finalStates.has(latest.status)) {
					const settledState = `${waited?.settled?.status ?? ""} ${waited?.settled?.reason ?? ""}`.toLowerCase();
					const cancelled = callContext?.abortSignal?.aborted === true || /\babort(?:ed)?\b|\babandoned\b|\bcancell?ed\b/.test(settledState);
					const why = cancelled
						? "The caller stopped the outer consult tool before a final consult_return."
						: waited?.timedOut === true
							? `The conference exceeded its ${Math.round(POLICY.limits.conference.runtimeMs / 1000)}-second runtime limit.`
							: `The conference child stopped without consult_return: ${settlementDescription(waited?.settled)}.`;
					latest = endConference(brainDir, conference.id, cancelled ? "cancelled" : waited?.timedOut === true ? "interrupted" : "failed", why, api.now());
				}
			const details = { consult: true, conference: latest.id, conversationId: child, status: latest.status, turns: latest.turns?.length ?? 0, selectors: latest.selectorEvents?.length ?? 0, ...(latest.final?.digest ? { digest: latest.final.digest } : {}) };
			return latest.status === "returned"
				? text(renderConferenceResult(latest), details)
				: fail(renderConferenceResult(latest), details);
		},
	});
}
