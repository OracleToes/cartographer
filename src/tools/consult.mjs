// The `consult` tool: one question to the storyteller — and, while the agent is not done, the next.
//
// The storyteller is Mythos-nano, a 3B long-reasoning model served by the same local endpoint. llama-swap serves
// one model at a time, so a consult puts it in place of the agent's model: the agent is unloaded while it thinks
// (deliberate on a card that holds one at a time) and reloads with the next request. It was not trained on tool
// calls, so this never looks like one to it: plain chat completions, no tools, no grammar. It cannot act, read
// the project, or remember anything on its own — μῦθος is story, and a story is not a record.
//
// The whole exchange is kept as one story file per story under .brain/storyteller/<id>.md. The agent never sees
// the path, only the `thread` marker the receipt prints (st-…); the file is provenance and backing. Follow-ups
// are calls carrying `thread`: the tool rebuilds the conversation — the original question, every answer since —
// and asks again; the round is appended to the same story. It goes as long as the agent keeps asking, and stops
// when it doesn't. The exchange is shelved for the asking context as a `story` reference, so the storyteller's
// own story stands in view like any shelved thing; over what the shelf renders, the story stands in the brain
// and the state block says so.
import { POLICY } from "../config.mjs";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { loadContext, persistShelfSnapshot, shelfReferenceItem, taskState, updateContext } from "../context.mjs";
import { STORY_ID, appendRound, createStory, parseStory, readStory, renderStory } from "../story.mjs";

const CONTEXT_CHARS = POLICY.limits.consult.contextChars;
const SNIPPET_CHARS = POLICY.limits.consult.bodyChars;
// While the storyteller tells its story, what the live view keeps is a bounded tail of the draft; the file keeps it all.
const LIVE_TAIL_BYTES = 8192;
const LIVE_TAIL_LINES = 200;

const pad = (value, width = 2) => String(value).padStart(width, "0");
const count = (n) => Math.round(n).toLocaleString("en-US");
const elapsedOf = (ms) => `${Math.floor(ms / 60000)} m ${pad(Math.floor((ms % 60000) / 1000))} s`;
const snippet = (text, max = SNIPPET_CHARS) => {
	const clean = String(text ?? "").replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};
/** What the call may send at most: the head of the context, like every other clipped text here. */
export const clipConsultContext = (text) => {
	const raw = String(text ?? "");
	if (raw.length <= CONTEXT_CHARS) return { text: raw, clipped: false, from: raw.length };
	return { text: raw.slice(0, CONTEXT_CHARS), clipped: true, from: raw.length };
};

/**
 * @param {{ root: string, brainDir: string, config: ReturnType<typeof import("../config.mjs").loadConfig>, fetchImpl?: typeof fetch }} input
 *   fetchImpl: test seam; defaults to the global fetch.
 */
export function consultTool({ root, brainDir, config, fetchImpl }) {
	const doFetch = fetchImpl ?? globalThis.fetch;
	return defineTool({
		name: "consult",
		// The harness sends describe("consult") (src/prompt.mjs TOOLS) to the model; this stands in when that is absent, in the same voice.
		description: [
			"The storyteller. One hard sub-problem whose answer a test or a proof can refute — a kernel, an invariant, a proof, a counterexample — handed over whole.",
			"In `context` what it may not guess (files with paths and line numbers, constraints, what I tried and what it printed), the question last, and at the end of the question the shape of the answer I want. It knows nothing of the project and keeps nothing once it speaks; everything it needs goes in the call.",
			"Its answer comes back on my shelf under a `thread` with the whole exchange so far: a story, not a record — I check it against a test or a proof and keep what holds. I can ask on with the same `thread` and a follow-up — the storyteller sees the original question and everything said since — for as long as the work needs. I reach for it early, when a refutable hard question stands in my way. Strong where an answer can be refuted; of no use where taste rules.",
		].join(" "),
		parameters: obj({
			question: str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "The problem, self-contained, with the shape of the answer wanted at the end (for example: the complete function; the invariant with its proof; the counterexample)." }),
			context: opt(str({ maxLength: CONTEXT_CHARS, description: `Everything it needs and may not guess: file excerpts with their paths and line numbers, constraints, what was tried and what it printed. Inline text; over the first ${count(CONTEXT_CHARS)} characters the rest is not sent, and the result says so.` })),
			thread: opt(str({ pattern: "^st-\\d{8}-\\d{6}-[a-z0-9]{4}$", description: "The `thread` from an earlier consult receipt, to ask the next round of the same story. The storyteller sees the original question and every answer since. Omit to begin a new story." })),
		}),
		prepareArguments(args) {
			// Clipped here, before validation sees it, so an oversized context keeps the head instead of being refused whole.
			if (args !== null && typeof args === "object" && typeof args.context === "string") {
				const clipped = clipConsultContext(args.context);
				if (clipped.clipped) return { ...args, context: clipped.text };
			}
			return args;
		},
		executionMode: "sequential",
		// Not run a second time after a crash: the ask is unique and expensive, and the task reads the file again anyway.
		replay: POLICY.enums.toolReplay.never,
		// While it writes, the harness keeps a bounded tail of the storyteller's draft for the live view; the file gets all of it.
		outputLimits: { maxBytes: LIVE_TAIL_BYTES, maxLines: LIVE_TAIL_LINES, retain: "tail" },
		execute: async (args, api) => {
			const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
			const model = typeof config.consultModel === "string" ? config.consultModel.trim() : "";
			if (model === "") {
				return fail("`consult` is switched off: `consultModel` is empty in the settings. Nothing was asked. Set it to the name llama-swap serves the storyteller under (or remove it to use the default).");
			}
			const context = clipConsultContext(args.context);
			const question = String(args.question ?? "").trim();
			// The thread: an earlier story to continue. The conversation is rebuilt from the story itself, so round 1 is not re-sent by the agent.
			const threadArg = typeof args.thread === "string" ? args.thread.trim() : "";
			/** What the story keeps when the storyteller could not be reached or would not answer. */
			let story = undefined;
			if (threadArg !== "") {
				if (!STORY_ID.test(threadArg)) return fail(`\`thread\` is \`${snippet(threadArg, 80)}\` — not a thread the storyteller minted. Pass the \`thread\` from an earlier consult receipt, or omit it to begin a new story.`);
				const raw = readStory(brainDir, threadArg);
				if (raw === undefined) return fail(`No story stands under thread ${threadArg}; it may have been cleaned from the brain. Begin a new story and carry the crux in it.`);
				try {
					story = { id: threadArg, ...parseStory(raw) };
					if (story.rounds.length === 0) return fail(`The story under thread ${threadArg} holds no round. Begin a new one with the crux.`);
				} catch (error) {
					return fail(`The story under thread ${threadArg} cannot be read as a story: ${snippet(error?.message ?? error)}. Begin a new one with the crux.`);
				}
			}
			const userFor = (ctx, q) => (String(ctx ?? "").trim().length > 0 ? `${String(ctx).trim()}\n\n---\n\n` : "") + String(q ?? "").trim();
			/** What the storyteller sees: every round so far, then this one — the question last, what is newest is what the model answers. */
			const messages = [];
			if (story) for (const round of story.rounds) {
				messages.push({ role: "user", content: userFor(round.context, round.question) });
				messages.push({ role: "assistant", content: round.answer });
			}
			const content = userFor(context.text, question);
			messages.push({ role: "user", content });
			const keptNote = story !== undefined ? ` The story keeps its ${story.rounds.length} ${story.rounds.length === 1 ? "round" : "rounds"}.` : "";
			const startedAt = api.now();
			const url = `${config.server}/chat/completions`;
			// The story streams token by token: the Chat tab shows the tail of the draft as it is written. One retry without stream_options for a server that refuses it; usage is simply not reported then.
			const request = (withUsage) => ({
				method: "POST",
				headers: { "content-type": "application/json", accept: "text/event-stream" },
				body: JSON.stringify({
					model,
					messages,
					max_tokens: config.consultMaxTokens,
					temperature: config.consultTemperature,
					stream: true,
					...(withUsage ? { stream_options: { include_usage: true } } : {}),
				}),
				signal: AbortSignal.timeout(Math.max(1, config.consultTimeoutSeconds) * 1000),
			});
			const networkMessage = (error) =>
				error?.name === "TimeoutError" || error?.name === "AbortError"
					? `The storyteller did not answer within ${config.consultTimeoutSeconds} seconds (consultTimeoutSeconds); the server stops generating when the connection drops. Nothing was written.${keptNote} Give it a narrower question, or raise consultTimeoutSeconds.`
					: `The storyteller could not be reached at ${config.server}: ${snippet(error?.message ?? error)}. Nothing was asked of it.${keptNote}`;
			const refusal = (status, raw) => {
				const body = snippet(raw);
				// The server refusing an over-long conversation: the storyteller can hold no more — said plainly, not as a model-name problem.
				const overflow = status >= 400 && /context( size| length| window)?|n_ctx|too many tokens|prompt[^\n]{0,40}too long|exceed/i.test(String(raw ?? "")) && /context|n_ctx|tokens/i.test(String(raw ?? ""));
				if (overflow) {
					return fail(story !== undefined
						? `The story has outgrown what the storyteller can hold — the server refused round ${story.rounds.length + 1} (HTTP ${status}). The story keeps its ${story.rounds.length} ${story.rounds.length === 1 ? "round" : "rounds"}: let it rest, or begin a new one with the crux.`
						: `The context and the question outgrew what the storyteller can hold (HTTP ${status}: ${body}). Nothing was written. Send less — the crux, and what it may not guess — or give the storyteller a larger -c.`);
				}
				const likely = status >= 400 && status < 500
					? ` The model named "${model}" is probably not what llama-swap serves: set \`consultModel\` to the llama-swap section name (or CARTO_CONSULT_MODEL).`
					: "";
				return fail(`The storyteller refused the call: HTTP ${status}. ${body}${likely}${keptNote}`);
			};
			let response;
			try {
				response = await doFetch(url, request(true));
			} catch (error) {
				return fail(networkMessage(error));
			}
			if (!response.ok && response.status === 400) {
				const head = await response.text().catch(() => "");
				if (/stream_options/i.test(head)) {
					try {
						response = await doFetch(url, request(false));
					} catch (error) {
						return fail(networkMessage(error));
					}
					if (!response.ok) return refusal(response.status, await response.text().catch(() => ""));
				} else {
					return refusal(400, head);
				}
			}
			if (!response.ok) return refusal(response.status, await response.text().catch(() => ""));
			// Read the SSE frames; the whole answer lands in the file all the same — nothing is truncated on disk.
			let answer = "";
			let finishReason = "unknown";
			let completionTokens;
			let cutOff;
			const rawChunks = [];
			try {
				const reader = response.body?.getReader();
				if (reader === undefined) throw new Error("the response carries no stream");
				const decoder = new TextDecoder();
				let pending = "";
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					const piece = decoder.decode(value, { stream: true });
					rawChunks.push(piece);
					pending += piece;
					let at;
					while ((at = pending.indexOf("\n")) !== -1) {
						const line = pending.slice(0, at).trim();
						pending = pending.slice(at + 1);
						if (line === "" || line.startsWith(":") || !line.startsWith("data:")) continue;
						const data = line.slice(5).trim();
						if (data === "[DONE]") continue;
						let chunk;
						try {
							chunk = JSON.parse(data);
						} catch {
							continue;
						}
						const text = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content;
						if (typeof text === "string" && text !== "") {
							answer += text;
							api.output?.(text);
						}
						const finish = chunk?.choices?.[0]?.finish_reason;
						if (typeof finish === "string" && finish !== "") finishReason = finish;
						const tokens = chunk?.usage?.completion_tokens;
						if (typeof tokens === "number" && Number.isFinite(tokens)) completionTokens = tokens;
					}
				}
			} catch (error) {
				cutOff = error;
			}
			// A server that ignored stream and answered with one plain JSON body: read the story out of it all the same.
			if (answer === "" && rawChunks.length > 0) {
				try {
					const body = JSON.parse(rawChunks.join(""));
					const text = body?.choices?.[0]?.message?.content;
					if (typeof text === "string" && text.trim() !== "") {
						answer = text.trim();
						const finish = body?.choices?.[0]?.finish_reason;
						if (typeof finish === "string" && finish !== "") finishReason = finish;
						const tokens = body?.usage?.completion_tokens;
						if (typeof tokens === "number" && Number.isFinite(tokens)) completionTokens = tokens;
					}
				} catch { /* nothing to salvage */ }
			}
			answer = answer.trim();
			if (answer === "") {
				return fail(cutOff !== undefined
					? `The storyteller's story broke before it began: ${snippet(cutOff?.message ?? cutOff)}. Nothing was written.${keptNote}`
					: `The storyteller answered with no text. Nothing was written.${keptNote}`);
			}
			if (cutOff !== undefined) finishReason = "cut off";
			const elapsed = Math.max(0, api.now() - startedAt);
			// The answer joins the story: a new story under a fresh thread, or one more round of an existing one. The agent never sees the path, only the thread.
			const at = new Date(startedAt).toISOString();
			const tokensText = completionTokens !== undefined ? `${count(completionTokens)} output tokens` : "output tokens not reported";
			const round = {
				at,
				meta: [`Elapsed: ${elapsedOf(elapsed)} · ${tokensText} · finish: ${finishReason}`],
				...(cutOff !== undefined ? { cutOff: snippet(cutOff?.message ?? cutOff) } : {}),
				context: context.text.trim(),
				question,
				answer,
			};
			let threadId;
			let storyRounds;
			try {
				if (story) {
					const number = appendRound(brainDir, story.id, round);
					threadId = story.id;
					storyRounds = [...story.rounds, round];
					void number;
				} else {
					const created = createStory(brainDir, { model, at: startedAt, round });
					threadId = created.id;
					storyRounds = [round];
				}
			} catch (error) {
				return fail(`The story could not be kept: ${snippet(error?.message ?? error)}. Nothing was shelved.${story ? keptNote : ""}`);
			}
			const roundNumber = storyRounds.length;
			// Shelve the story itself for whoever asked — the exchange, with no thread to a path. Over the shelf's view budget the placement is kept and the story stands in the brain — that is fine by design.
			let shelfMsg;
			let placement;
			let shelfTokens;
			try {
				const current = loadContext(brainDir);
				const main = api.conversationId === ROOT_CONVERSATION_ID;
				const mine = main ? (current.shelf ?? []) : (current.tasks?.[api.conversationId]?.shelf ?? []);
				const picked = shelfReferenceItem({ kind: "story", id: threadId }, renderStory(storyRounds), brainDir, mine);
				persistShelfSnapshot(brainDir, picked.item, picked.backing);
				updateContext(brainDir, (next) => {
					const list = main ? next.shelf : (taskState(next, api.conversationId).shelf ??= []);
					const at = list.findIndex((entry) => entry.id === picked.item.id);
					if (at < 0) list.push(picked.item);
					else list[at] = { ...list[at], ...picked.item };
				});
				placement = picked.item.id;
				shelfTokens = picked.tokens;
				shelfMsg = `shelved as placement ${placement} (${count(picked.tokens)} rendered tokens); over what the shelf renders, the story stands in the brain and the state block says so`;
			} catch (error) {
				shelfMsg = `not shelved (${snippet(error?.message ?? error)}); the story stands under thread ${threadId} all the same`;
			}
			const finishNote = cutOff !== undefined
				? ` The round broke off mid-answer (${snippet(cutOff?.message ?? cutOff)}): what the storyteller wrote stands incomplete, and the round stands in the story as it broke.`
				: finishReason === "length"
					? ` It ran out of room (finish: length) — the ending is incomplete; ask again with a narrower question, or raise consultMaxTokens (${config.consultMaxTokens}).`
					: "";
			const clipNote = context.clipped ? ` The context was clipped to the first ${count(CONTEXT_CHARS)} characters (it was ${count(context.from)}); the rest was not sent.` : "";
			const told = `The storyteller took ${elapsedOf(elapsed)} (${tokensText})`;
			const text = roundNumber === 1
				? `${told}. The story stands under thread ${threadId}; ${shelfMsg}. A story is not a record: check the work against a test or a proof, and apply it yourself. I can ask on with \`thread: "${threadId}"\` — the storyteller sees the original question and its answer — for as long as the work needs.${finishNote}${clipNote}`
				: `Round ${roundNumber}. ${told}. The story (${roundNumber} rounds) stands under thread ${threadId}; ${shelfMsg}. A story is not a record: check it against a test or a proof. Ask on with \`thread: "${threadId}"\` while a refutable doubt remains — the storyteller sees the whole exchange — or let it rest.${finishNote}${clipNote}`;
			const details = { consult: true, thread: threadId, rounds: roundNumber, ...(placement === undefined ? {} : { placement }), tokens: completionTokens, finish: finishReason, seconds: Math.round(elapsed / 100) / 10 };
			if (cutOff !== undefined) return { isError: true, output: [{ type: "text", text }], details };
			return { output: [{ type: "text", text }], details };
		},
	});
}
