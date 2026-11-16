// The `consult` tool: one question to the storyteller.
//
// The storyteller is Mythos-nano, a 3B long-reasoning model served by the same local endpoint. llama-swap serves
// one model at a time, so a consult puts it in place of the agent's model: the agent is unloaded while it thinks
// (deliberate on a card that holds one at a time) and reloads with the next request. It was not trained on tool
// calls, so this never looks like one to it: one plain chat completion, no tools, no grammar. It cannot act, read
// the project, or remember anything — its answer is a proposal the agent checks: μῦθος is story, and a story is not
// a record. The answer lands in `consult/<stamp>.md` in the project (visible in the tree, catalogued as a file,
// shelveable) and is shelved for the asking context; over what the shelf renders, the file stands and the state
// block says so.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POLICY } from "../config.mjs";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { loadContext, persistShelfSnapshot, shelfItem, taskState, updateContext } from "../context.mjs";

const CONTEXT_CHARS = POLICY.limits.consult.contextChars;
const SNIPPET_CHARS = POLICY.limits.consult.bodyChars;
// While the storyteller tells its story, what the live view keeps is a bounded tail of the draft; the file keeps it all.
const LIVE_TAIL_BYTES = 8192;
const LIVE_TAIL_LINES = 200;

const pad = (value, width = 2) => String(value).padStart(width, "0");
/** UTC stamp for the file name, e.g. 20261115-143022. */
const stampFor = (at) => {
	const date = new Date(at);
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
};
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
			"The storyteller. One hard sub-problem whose answer a test or a proof can refute — a kernel, an invariant, a proof, a counterexample — handed over whole and once.",
			"In `context` what it may not guess (files with paths and line numbers, constraints, what I tried and what it printed), the question last, and at the end of the question the shape of the answer I want. It knows nothing of the project and keeps nothing once it speaks; everything it needs goes in the call.",
			"Its answer comes back as a file in `consult/` and on my shelf: a story, not a record — I check it against a test or a proof and keep what holds. I reach for it early, when a refutable hard question stands in my way. Strong where an answer can be refuted; of no use where taste rules.",
		].join(" "),
		parameters: obj({
			question: str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "The problem, self-contained, with the shape of the answer wanted at the end (for example: the complete function; the invariant with its proof; the counterexample)." }),
			context: opt(str({ maxLength: CONTEXT_CHARS, description: `Everything it needs and may not guess: file excerpts with their paths and line numbers, constraints, what was tried and what it printed. Inline text; over the first ${count(CONTEXT_CHARS)} characters the rest is not sent, and the result says so.` })),
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
			// The question last: what is newest is what the model answers.
			const content = (context.text.trim().length > 0 ? `${context.text.trim()}\n\n---\n\n` : "") + String(args.question ?? "").trim();
			const startedAt = api.now();
			const url = `${config.server}/chat/completions`;
			// The story streams token by token: the Chat tab shows the tail of the draft as it is written. One retry without stream_options for a server that refuses it; usage is simply not reported then.
			const request = (withUsage) => ({
				method: "POST",
				headers: { "content-type": "application/json", accept: "text/event-stream" },
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content }],
					max_tokens: config.consultMaxTokens,
					temperature: config.consultTemperature,
					stream: true,
					...(withUsage ? { stream_options: { include_usage: true } } : {}),
				}),
				signal: AbortSignal.timeout(Math.max(1, config.consultTimeoutSeconds) * 1000),
			});
			const networkMessage = (error) =>
				error?.name === "TimeoutError" || error?.name === "AbortError"
					? `The storyteller did not answer within ${config.consultTimeoutSeconds} seconds (consultTimeoutSeconds); the server stops generating when the connection drops. Nothing was written. Give it a narrower question, or raise consultTimeoutSeconds.`
					: `The storyteller could not be reached at ${config.server}: ${snippet(error?.message ?? error)}. Nothing was asked of it.`;
			const refusal = (status, raw) => {
				const likely = status >= 400 && status < 500
					? ` The model named "${model}" is probably not what llama-swap serves: set \`consultModel\` to the llama-swap section name (or CARTO_CONSULT_MODEL).`
					: "";
				return fail(`The storyteller refused the call: HTTP ${status}. ${snippet(raw)}${likely}`);
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
					? `The storyteller's story broke before it began: ${snippet(cutOff?.message ?? cutOff)}. Nothing was written.`
					: "The storyteller answered with no text. Nothing was written.");
			}
			if (cutOff !== undefined) finishReason = "cut off";
			const elapsed = Math.max(0, api.now() - startedAt);
			// The answer lands in the project as a file: visible in the tree, catalogued, shelveable.
			const stamp = stampFor(startedAt);
			mkdirSync(join(root, "consult"), { recursive: true });
			let rel;
			for (let n = 1; ; n += 1) {
				rel = `consult/${stamp}${n > 1 ? `-${n}` : ""}.md`;
				try {
					writeFileSync(join(root, rel), [
						`The storyteller (Mythos-nano) — ${new Date(startedAt).toISOString()}`,
						`Model: ${model} (served by the same local endpoint; llama-swap swapped it in, so the agent's own model was not served while this was written)`,
						`Elapsed: ${elapsedOf(elapsed)} · ${completionTokens !== undefined ? `${count(completionTokens)} output tokens` : "output tokens not reported"} · finish: ${finishReason}`,
						...(cutOff !== undefined ? [`The story was cut off mid-answer: ${snippet(cutOff?.message ?? cutOff)}`, ""] : []),
						"",
						"Question:",
						String(args.question ?? "").trim(),
						"",
						"Answer:",
						"",
						answer,
						"",
					].join("\n"), { encoding: "utf8", flag: "wx" });
					break;
				} catch (error) {
					if (error?.code === "EEXIST" && n < 100) continue;
					return fail(`The answer could not be written to ${rel}: ${snippet(error?.message ?? error)}. Nothing was shelved.`);
				}
			}
			// Shelve it for whoever asked. Over the shelf's view budget the placement is kept and the file stands — that is fine by design.
			let shelfMsg;
			let placement;
			try {
				const current = loadContext(brainDir);
				const main = api.conversationId === ROOT_CONVERSATION_ID;
				const mine = main ? (current.shelf ?? []) : (current.tasks?.[api.conversationId]?.shelf ?? []);
				const picked = shelfItem(root, rel, undefined, brainDir, mine);
				persistShelfSnapshot(brainDir, picked.item, picked.backing);
				updateContext(brainDir, (next) => {
					const list = main ? next.shelf : (taskState(next, api.conversationId).shelf ??= []);
					const at = list.findIndex((entry) => entry.id === picked.item.id);
					if (at < 0) list.push(picked.item);
					else list[at] = { ...list[at], ...picked.item };
				});
				placement = picked.item.id;
				shelfMsg = `Shelved as placement ${placement} (${count(picked.tokens)} rendered tokens); over what the shelf renders, the file stands and the state block says so.`;
			} catch (error) {
				shelfMsg = `Not shelved (${snippet(error?.message ?? error)}); the file stands at ${rel}.`;
			}
			const finishNote = cutOff !== undefined
				? ` The story broke mid-answer (${snippet(cutOff?.message ?? cutOff)}): what it wrote stands incomplete in ${rel}.`
				: finishReason === "length"
					? ` It ran out of room (finish: length) — the ending is incomplete; ask again with a narrower question, or raise consultMaxTokens (${config.consultMaxTokens}).`
					: "";
			const clipNote = context.clipped ? ` The context was clipped to the first ${count(CONTEXT_CHARS)} characters (it was ${count(context.from)}); the rest was not sent.` : "";
			const text = `The storyteller took ${elapsedOf(elapsed)} (${completionTokens !== undefined ? `${count(completionTokens)} output tokens` : "tokens not reported"}). The answer is written to ${rel}. ${shelfMsg} A story is not a record: read it with \`read ${rel}\`, check the work against a test or a proof, and apply it yourself.${finishNote}${clipNote}`;
			const details = { consult: true, file: rel, ...(placement === undefined ? {} : { placement }), tokens: completionTokens, finish: finishReason, seconds: Math.round(elapsed / 100) / 10 };
			if (cutOff !== undefined) return { isError: true, output: [{ type: "text", text }], details };
			return { output: [{ type: "text", text }], details };
		},
	});
}
