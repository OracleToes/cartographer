// A deliberately small, raw llama.cpp selector capability check. This is not a
// conference and does not use the model provider: the point is to exercise the
// server's native `grammar` request field exactly as a future selector adapter
// would, without mixing it with tools, captured project data, or Durable state.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { POLICY } from "./config.mjs";
import { PARTICIPANT_IDS, enumGrammar } from "./conference.mjs";

export const LLAMA_CPP_SELECTOR_PROBE_VERSION = 1;
export const LLAMA_CPP_SELECTOR_PROBE_KIND = "cartographer.llama-cpp-native-selector-probe";
export const LLAMA_CPP_SELECTOR_PROBE_TIMEOUT_MS = POLICY.timing.consult.nativeGrammarProbeMs;

const forcedId = "cartographer";
const routingIds = Object.freeze(PARTICIPANT_IDS.filter((id) => id !== forcedId));
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
const stamp = (at) => new Date(at).toISOString().replace(/[-:.]/g, "");
const inside = (root, path) => {
	const fromRoot = relative(root, path);
	return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
};

export class ConsultProbeError extends Error {}

/** The request body sent directly to llama.cpp. It intentionally has no `tools` or `tool_choice`. */
export function llamaCppSelectorProbePayload({ modelId, ids, instruction }) {
	if (typeof modelId !== "string" || modelId.trim() === "") throw new ConsultProbeError("A native selector probe needs the current model id.");
	if (typeof instruction !== "string" || instruction.trim() === "") throw new ConsultProbeError("A native selector probe needs one probe instruction.");
	return {
		model: modelId,
		messages: [
			{ role: "system", content: "This is a local llama.cpp native-grammar capability probe. Answer the user exactly; do not call tools." },
			{ role: "user", content: instruction },
		],
		// enumGrammar uses the small `root ::= "one" | "two"` subset shared by Lark and llama.cpp GBNF.
		grammar: enumGrammar(ids),
		temperature: 0,
		max_tokens: 16,
		stream: false,
		// Qwen-family templates commonly honor this. A server that ignores it still has the grammar as the actual
		// output boundary; preserving it in the log makes a template-specific failure diagnosable.
		chat_template_kwargs: { enable_thinking: false },
	};
}

const probeCases = (modelId) => [
	{
		id: "forced-literal",
		kind: "enforcement",
		ids: [forcedId],
		expected: forcedId,
		instruction: 'Return exactly the word "outside-the-allowed-selector-set".',
		payload: llamaCppSelectorProbePayload({
			modelId,
			ids: [forcedId],
			instruction: 'Return exactly the word "outside-the-allowed-selector-set".',
		}),
	},
	{
		id: "finite-route",
		kind: "routing",
		ids: [...routingIds],
		instruction: [
			"A private consultation has just received Cartographer's opening view.",
			"Select the one next perspective that would best inspect a small project whose file relationships are unclear.",
			"Eligible ids: atlas (relationships and boundaries), ledger (claims and evidence), plan (sequencing), assessment (contradictions), context (retained or missing context).",
			"Output only the eligible id.",
		].join("\n"),
		payload: llamaCppSelectorProbePayload({
			modelId,
			ids: routingIds,
			instruction: [
				"A private consultation has just received Cartographer's opening view.",
				"Select the one next perspective that would best inspect a small project whose file relationships are unclear.",
				"Eligible ids: atlas (relationships and boundaries), ledger (claims and evidence), plan (sequencing), assessment (contradictions), context (retained or missing context).",
				"Output only the eligible id.",
			].join("\n"),
		}),
	},
];

function readResult(body, raw, test, response, elapsedMs) {
	const output = messageText(body?.choices?.[0]?.message?.content);
	const finishReason = typeof body?.choices?.[0]?.finish_reason === "string" ? body.choices[0].finish_reason : undefined;
	const allowed = test.ids.includes(output);
	const exact = test.expected === undefined || output === test.expected;
	const passed = response.ok && allowed && exact;
	let reason;
	if (!response.ok) reason = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
	else if (output === undefined) reason = "The response did not contain assistant text; a native selector must return one grammar-constrained identifier.";
	else if (!allowed) reason = `The response ${JSON.stringify(output)} is outside the grammar's eligible ids (${test.ids.join(", ")}).`;
	else if (!exact) reason = `The enforcement probe returned ${JSON.stringify(output)} instead of its only grammar-permitted literal ${JSON.stringify(test.expected)}.`;
	return {
		id: test.id,
		kind: test.kind,
		eligible: [...test.ids],
		...(test.expected === undefined ? {} : { expected: test.expected }),
		request: test.payload,
		response: {
			status: response.status,
			statusText: response.statusText,
			contentType: response.headers.get("content-type") ?? undefined,
			raw,
			...(body === undefined ? {} : { json: body }),
		},
		...(output === undefined ? {} : { output }),
		...(finishReason === undefined ? {} : { finishReason }),
		elapsedMs,
		passed,
		...(reason === undefined ? {} : { reason }),
	};
}

/**
 * Run two no-project native GBNF checks. The forced literal is deliberately asked for an incompatible word: a pass
 * is useful evidence that the server sampled under the grammar rather than merely following the prompt. The finite
 * route then checks a real multi-choice roster. If enforcement fails, routing is skipped rather than spending a
 * second request on a server that has already shown this adapter cannot work.
 */
export async function runLlamaCppSelectorProbe({ server, modelId, fetchImpl = globalThis.fetch, timeoutMs = LLAMA_CPP_SELECTOR_PROBE_TIMEOUT_MS, now = () => Date.now() }) {
	const endpoint = cleanEndpoint(server);
	if (endpoint === "") throw new ConsultProbeError("A native selector probe needs the configured model-server URL.");
	if (typeof fetchImpl !== "function") throw new ConsultProbeError("A native selector probe needs a fetch implementation.");
	const startedAt = now();
	const cases = [];
	for (const test of probeCases(modelId)) {
		if (test.id === "finite-route" && cases[0]?.passed !== true) {
			cases.push({
				id: test.id,
				kind: test.kind,
				eligible: [...test.ids],
				request: test.payload,
				skipped: true,
				reason: "Skipped because the forced-literal grammar-enforcement probe did not pass.",
			});
			continue;
		}
		const began = now();
		try {
			const response = await fetchImpl(`${endpoint}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify(test.payload),
				signal: AbortSignal.timeout(timeoutMs),
			});
			const raw = await response.text();
			cases.push(readResult(safeJson(raw), raw, test, response, Math.max(0, now() - began)));
		} catch (error) {
			cases.push({
				id: test.id,
				kind: test.kind,
				eligible: [...test.ids],
				...(test.expected === undefined ? {} : { expected: test.expected }),
				request: test.payload,
				elapsedMs: Math.max(0, now() - began),
				passed: false,
				reason: `Request failed: ${error?.name ? `${error.name}: ` : ""}${error?.message ?? String(error)}`,
			});
		}
	}
	const finishedAt = now();
	return {
		version: LLAMA_CPP_SELECTOR_PROBE_VERSION,
		kind: LLAMA_CPP_SELECTOR_PROBE_KIND,
		startedAt: new Date(startedAt).toISOString(),
		finishedAt: new Date(finishedAt).toISOString(),
		elapsedMs: Math.max(0, finishedAt - startedAt),
		endpoint,
		model: modelId,
		timeoutMs,
		passed: cases.every((test) => test.passed === true),
		cases,
	};
}

/** Default logs stay in ignored brain export; an explicit project-relative path can be committed for diagnosis. */
export function selectorProbeLogPath({ root, brainDir, path, at = Date.now() }) {
	if (typeof root !== "string" || root === "") throw new ConsultProbeError("A selector-probe log needs the project root.");
	if (path === undefined || path === "") {
		if (typeof brainDir !== "string" || brainDir === "") throw new ConsultProbeError("The default selector-probe log needs the brain folder.");
		return join(brainDir, "export", `llama-cpp-selector-probe-${stamp(at)}.json`);
	}
	if (typeof path !== "string") throw new ConsultProbeError("The selector-probe log path must be a project-relative filename.");
	if (!path.toLowerCase().endsWith(".json")) throw new ConsultProbeError("The selector-probe log path must end in .json.");
	if (isAbsolute(path)) throw new ConsultProbeError("The selector-probe log path must be relative to the project, not absolute.");
	const target = resolve(root, path);
	if (!inside(root, target)) throw new ConsultProbeError("The selector-probe log path must stay inside the project.");
	if (existsSync(target)) throw new ConsultProbeError(`The selector-probe log path ${JSON.stringify(path)} already exists; choose a new JSON filename so the diagnostic never overwrites project material.`);
	return target;
}

/** Save an inspectable, self-contained raw request/response record atomically. */
export function writeSelectorProbeLog(path, record) {
	if (typeof path !== "string" || path === "") throw new ConsultProbeError("Cannot write a selector-probe log without a path.");
	const temporary = `${path}.${process.pid}.tmp`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(temporary, `${JSON.stringify(record, null, "\t")}\n`);
	renameSync(temporary, path);
	return path;
}

/** A concise terminal summary; the full raw request/response evidence remains in the JSON log. */
export function renderLlamaCppSelectorProbe(record) {
	const lines = [
		"Native llama.cpp selector probe",
		`Endpoint: ${record.endpoint} · model: ${record.model}.`,
		"No project files, conference capture, tools, or Durable conversation were sent.",
	];
	for (const test of record.cases ?? []) {
		const status = test.skipped ? "SKIPPED" : test.passed ? "PASS" : "FAIL";
		const facts = [
			`${test.id}: ${status}`,
			test.response?.status === undefined ? undefined : `HTTP ${test.response.status}`,
			test.output === undefined ? undefined : `output ${JSON.stringify(test.output)}`,
			test.elapsedMs === undefined ? undefined : `${test.elapsedMs} ms`,
		].filter((fact) => fact !== undefined);
		lines.push(`  ${facts.join(" · ")}`);
		if (test.reason !== undefined) lines.push(`    ${test.reason}`);
	}
	lines.push(record.passed ? "Result: PASS — this endpoint returned only native-grammar-permitted selector ids for both probes." : "Result: FAIL — inspect the JSON log before treating this endpoint as a native grammar selector.");
	return lines.join("\n");
}
