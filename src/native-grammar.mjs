// Cartographer's native constrained-output boundary. llama.cpp's `grammar` field is
// a platform requirement for host-owned control decisions: no tools, no prompt-only
// substitute, and no silent downgrade when an endpoint cannot enforce the grammar.
import { POLICY } from "./config.mjs";

export const NATIVE_GRAMMAR_TIMEOUT_MS = POLICY.timing.nativeGrammar.timeoutMs;
const CAPABILITY_LITERAL = "cartographer";
const CAPABILITY_CONTRARY_INSTRUCTION = 'Return exactly the word "outside-the-allowed-native-grammar-set".';
const capabilityCache = new Map();

export class NativeGrammarError extends Error {
	constructor(message, { record } = {}) {
		super(message);
		this.name = "NativeGrammarError";
		if (record !== undefined) this.record = record;
	}
}

const cleanEndpoint = (value) => String(value ?? "").replace(/\/+$/, "");
const safeJson = (text) => {
	try { return JSON.parse(text); }
	catch { return undefined; }
};
const messageText = (content) => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = content.flatMap((part) => typeof part?.text === "string" ? [part.text] : []).join("");
	return text === "" ? undefined : text;
};
const fail = (record, reason) => ({ ok: false, reason, record });

/** Build the small literal-only GBNF subset Cartographer uses for finite host choices. */
export function nativeLiteralGrammar(literals) {
	if (!Array.isArray(literals) || literals.length === 0 || literals.some((literal) => typeof literal !== "string" || literal === "")) {
		throw new NativeGrammarError("A native grammar needs one or more non-empty string literals.");
	}
	if (new Set(literals).size !== literals.length) throw new NativeGrammarError("A native grammar cannot contain the same literal more than once.");
	return `root ::= ${literals.map((literal) => JSON.stringify(literal)).join(" | ")}`;
}

/** A direct llama.cpp completion body. It intentionally never mixes native grammar with tools/tool_choice. */
export function nativeGrammarPayload({ modelId, messages, grammar, maxTokens = 16, temperature = 0, thinking = false }) {
	if (typeof modelId !== "string" || modelId.trim() === "") throw new NativeGrammarError("A native grammar request needs a model id.");
	if (!Array.isArray(messages) || messages.length === 0) throw new NativeGrammarError("A native grammar request needs one or more messages.");
	if (typeof grammar !== "string" || grammar.trim() === "") throw new NativeGrammarError("A native grammar request needs a non-empty GBNF grammar.");
	if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new NativeGrammarError("A native grammar request needs a positive whole max-token limit.");
	if (typeof temperature !== "number" || !Number.isFinite(temperature)) throw new NativeGrammarError("A native grammar request needs a finite temperature.");
	return {
		model: modelId,
		messages,
		grammar,
		temperature,
		max_tokens: maxTokens,
		stream: false,
		chat_template_kwargs: { enable_thinking: thinking === true },
	};
}

/**
 * Make one raw no-tools native-grammar request and retain the unaltered HTTP material.
 * It deliberately returns transport/status/body failures as data so diagnostics can
 * retain evidence; `chooseNativeGrammar` turns those failures into a hard error.
 */
export async function requestNativeGrammar({
	server,
	modelId,
	messages,
	grammar,
	maxTokens = 16,
	temperature = 0,
	thinking = false,
	timeoutMs = NATIVE_GRAMMAR_TIMEOUT_MS,
	fetchImpl = globalThis.fetch,
	signal,
	now = () => Date.now(),
}) {
	const endpoint = cleanEndpoint(server);
	if (endpoint === "") throw new NativeGrammarError("A native grammar request needs the configured model-server URL.");
	if (typeof fetchImpl !== "function") throw new NativeGrammarError("A native grammar request needs a fetch implementation.");
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new NativeGrammarError("A native grammar request needs a positive whole timeout.");
	const request = nativeGrammarPayload({ modelId, messages, grammar, maxTokens, temperature, thinking });
	const began = now();
	const timeout = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
	try {
		const response = await fetchImpl(`${endpoint}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer local" },
			body: JSON.stringify(request),
			signal: requestSignal,
		});
		const raw = await response.text();
		const json = safeJson(raw);
		const output = messageText(json?.choices?.[0]?.message?.content);
		const finishReason = typeof json?.choices?.[0]?.finish_reason === "string" ? json.choices[0].finish_reason : undefined;
		return {
			endpoint,
			request,
			response: {
				status: response.status,
				statusText: response.statusText,
				contentType: response.headers.get("content-type") ?? undefined,
				raw,
				...(json === undefined ? {} : { json }),
			},
			...(output === undefined ? {} : { output }),
			...(finishReason === undefined ? {} : { finishReason }),
			elapsedMs: Math.max(0, now() - began),
		};
	} catch (error) {
		return {
			endpoint,
			request,
			transport: {
				name: typeof error?.name === "string" ? error.name : undefined,
				message: String(error?.message ?? error),
				...(signal?.aborted === true ? { aborted: true } : {}),
			},
			elapsedMs: Math.max(0, now() - began),
		};
	}
}

/** Validate one raw result against a host-built finite set; never coerce, trim, or infer an answer. */
export function validateNativeGrammarResult(record, { eligible, expected } = {}) {
	if (!Array.isArray(eligible) || eligible.length === 0 || eligible.some((value) => typeof value !== "string" || value === "")) {
		throw new NativeGrammarError("Native grammar validation needs one or more eligible string values.");
	}
	if (expected !== undefined && !eligible.includes(expected)) throw new NativeGrammarError("A native grammar expected value must be one of its eligible values.");
	if (record?.transport !== undefined) {
		const name = record.transport.name ? `${record.transport.name}: ` : "";
		return fail(record, `Request failed: ${name}${record.transport.message}`);
	}
	const status = record?.response?.status;
	if (!Number.isInteger(status)) return fail(record, "The native grammar request produced no HTTP status.");
	if (status < 200 || status >= 300) {
		const statusText = record.response.statusText ? ` ${record.response.statusText}` : "";
		return fail(record, `HTTP ${status}${statusText}`);
	}
	const output = record.output;
	if (output === undefined) return fail(record, "The response did not contain assistant text; a native decision must return exactly one grammar-constrained value.");
	if (!eligible.includes(output)) return fail(record, `The response ${JSON.stringify(output)} is outside the grammar's eligible values (${eligible.join(", ")}).`);
	if (expected !== undefined && output !== expected) return fail(record, `The response ${JSON.stringify(output)} is not the expected grammar-permitted value ${JSON.stringify(expected)}.`);
	return { ok: true, value: output, record };
}

/** Make one required finite choice. Any malformed, ignored, or failed grammar response stops the caller. */
export async function chooseNativeGrammar({ eligible, expected, ...input }) {
	const record = await requestNativeGrammar(input);
	const checked = validateNativeGrammarResult(record, { eligible, expected });
	if (!checked.ok) throw new NativeGrammarError(`Native grammar decision refused: ${checked.reason}`, { record });
	return { value: checked.value, record };
}

/**
 * Prove that this exact endpoint/model combination samples under native grammar,
 * rather than merely following a compatible prompt. Positive results cache only in
 * this Cartographer process; failures stay retryable so an endpoint can recover.
 */
export async function probeNativeGrammarCapability({
	server,
	modelId,
	timeoutMs = NATIVE_GRAMMAR_TIMEOUT_MS,
	fetchImpl,
	now,
	cache = true,
}) {
	const endpoint = cleanEndpoint(server);
	if (endpoint === "") return { ok: false, error: "No model-server URL is configured for the native grammar requirement." };
	if (typeof modelId !== "string" || modelId.trim() === "") return { ok: false, error: "No model id is configured for the native grammar requirement." };
	const key = `${endpoint}\u0000${modelId}`;
	const known = cache ? capabilityCache.get(key) : undefined;
	if (known !== undefined) return known;
	const run = (async () => {
		try {
			const record = await requestNativeGrammar({
				server: endpoint,
				modelId,
				messages: [
					{ role: "system", content: "This is a Cartographer native-grammar capability probe. Answer the user exactly; do not call tools." },
					{ role: "user", content: CAPABILITY_CONTRARY_INSTRUCTION },
				],
				grammar: nativeLiteralGrammar([CAPABILITY_LITERAL]),
				maxTokens: 16,
				temperature: 0,
				thinking: false,
				timeoutMs,
				...(fetchImpl === undefined ? {} : { fetchImpl }),
				...(now === undefined ? {} : { now }),
			});
			const checked = validateNativeGrammarResult(record, { eligible: [CAPABILITY_LITERAL], expected: CAPABILITY_LITERAL });
			return checked.ok
				? { ok: true, record }
				: { ok: false, error: `The endpoint did not enforce Cartographer's native grammar probe: ${checked.reason}`, record };
		} catch (error) {
			return { ok: false, error: `The native grammar capability probe could not run: ${error?.message ?? error}` };
		}
	})();
	if (cache) capabilityCache.set(key, run);
	const settled = await run;
	if (!settled.ok && cache) capabilityCache.delete(key);
	return settled;
}

/** Fail a launch, model switch, or host-owned control flow instead of accepting an unconstrained substitute. */
export async function requireNativeGrammarCapability(input) {
	const result = await probeNativeGrammarCapability(input);
	if (!result.ok) throw new NativeGrammarError(`Cartographer requires llama.cpp native GBNF grammar enforcement. ${result.error}`, { record: result.record });
	return result;
}
