// `consult`: launch an isolated same-model conference and return its final advisory
// synthesis to the conversation that called it. This is the sole consultation surface:
// there is no external-model request, thread revival, storyteller store, or routing fallback.
import { configure, defineTool } from "@earendil-works/pi-durable";
import { arr, obj, opt, str, union } from "@earendil-works/pi-schema";
import { POLICY } from "../config.mjs";
import {
	ConferenceError,
	attachChildConference,
	conferenceSeed,
	createConferenceCapture,
	endConference,
	findConferenceByCaller,
	loadConference,
	renderConferenceResult,
} from "../conference.mjs";
import { describe } from "../prompt.mjs";
import { requireNativeGrammarCapability } from "../native-grammar.mjs";

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
	if (extension?.name !== "consult-conference" || tools.length !== 2) {
		throw new ConferenceError("The isolated consult-conference extension is unavailable or incomplete.");
	}
	const desiredMaxTurns = Math.max(8, POLICY.limits.conference.turns * 4 + 4);
	// Every child generation records a participant plan. At most one raw selector plan follows each completed
	// participant turn, and the host ends those turns at `conference.turns`; reserve that many audit slots so the
	// normal bounded child cannot evict its own participant/selector handoff evidence.
	const maxTurns = Math.min(desiredMaxTurns, POLICY.limits.conference.requestPlans - POLICY.limits.conference.turns);
	if (maxTurns < 8) throw new ConferenceError("Conference request-plan retention is below the minimum child and native-selector audit budget.");
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
export function consultTool({ root, brainDir, conferenceExtension }) {
	return defineTool({
		name: "consult",
		description: describe("consult"),
		parameters: obj({
			question: str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.conference.questionChars, pattern: "\\S", description: "One bounded consultation question and desired advisory deliverable." }),
			context: opt(str({ maxLength: POLICY.limits.conference.contextChars, description: "Optional caller-supplied facts. Exact captured bytes become immutable source c0." })),
			files: opt(arr(fileSpec, { maxItems: POLICY.limits.conference.files, description: "Optional confined project files captured immutably at entry." })),
			myPersona: str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: POLICY.limits.conference.personaChars, pattern: "\\S", description: "Required consult-local opening perspective for Cartographer; it grants no authority and never becomes a parent prompt." }),
			// Kept solely to issue a direct C5 migration refusal instead of silently accepting/replaying a legacy thread.
			thread: opt(str({ maxLength: 256, description: "Removed C5 legacy field. Any supplied value is refused; begin a new conference with explicit current context." })),
		}),
		executionMode: "sequential",
		// Conference executions locate their durable co<N> record/child before making anything new and are safe to replay.
		replay: POLICY.enums.toolReplay.safe,
		execute: async (args, api, callContext) => {
				if (args.thread !== undefined) {
					return fail("`consult.thread` was removed by the C5 cutover. Legacy transcripts are static archives only and cannot be resumed; begin a new conference with explicit current context.");
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
				try {
					// Startup and /model already prove the required native path, but a retained caller may carry a
					// different resolved model. Recheck this exact endpoint/model pair before capturing anything.
					await requireNativeGrammarCapability({ server: configured.baseUrl, modelId: configured.id ?? model.modelId });
				} catch (error) {
					const why = `The captured conference model cannot satisfy Cartographer's required native grammar boundary: ${error.message ?? error}`;
					if (conference !== undefined) {
						const ended = endConference(brainDir, conference.id, "failed", why, api.now());
						return fail(renderConferenceResult(ended), { consult: true, conference: ended.id, status: ended.status });
					}
					return fail(`consult refused before capture: ${why}`);
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
