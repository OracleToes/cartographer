// A deliberately small, raw llama.cpp selector capability check. This is not a
// conference and does not use the model provider: the point is to exercise the
// same required native-grammar boundary Cartographer uses for host decisions,
// without project data, tools, captured state, or Durable conversation history.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PARTICIPANT_IDS } from "./conference.mjs";
import {
	NATIVE_GRAMMAR_TIMEOUT_MS,
	nativeGrammarPayload,
	nativeLiteralGrammar,
	requestNativeGrammar,
	validateNativeGrammarResult,
} from "./native-grammar.mjs";

export const LLAMA_CPP_SELECTOR_PROBE_VERSION = 1;
export const LLAMA_CPP_SELECTOR_PROBE_KIND = "cartographer.llama-cpp-native-selector-probe";
export const LLAMA_CPP_SELECTOR_PROBE_TIMEOUT_MS = NATIVE_GRAMMAR_TIMEOUT_MS;

const forcedId = "cartographer";
const routingIds = Object.freeze(PARTICIPANT_IDS.filter((id) => id !== forcedId));
const stamp = (at) => new Date(at).toISOString().replace(/[-:.]/g, "");
const inside = (root, path) => {
	const fromRoot = relative(root, path);
	return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
};

export class ConsultProbeError extends Error {}

/** The exact no-tools direct llama.cpp body used by this diagnostic. */
export function llamaCppSelectorProbePayload({ modelId, ids, instruction }) {
	if (typeof instruction !== "string" || instruction.trim() === "") throw new ConsultProbeError("A native selector probe needs one probe instruction.");
	try {
		return nativeGrammarPayload({
			modelId,
			messages: [
				{ role: "system", content: "This is a local llama.cpp native-grammar capability probe. Answer the user exactly; do not call tools." },
				{ role: "user", content: instruction },
			],
			grammar: nativeLiteralGrammar(ids),
			temperature: 0,
			maxTokens: 16,
			thinking: false,
		});
	} catch (error) {
		throw new ConsultProbeError(error?.message ?? String(error));
	}
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

function readResult(result, test) {
	const checked = validateNativeGrammarResult(result, { eligible: test.ids, expected: test.expected });
	return {
		id: test.id,
		kind: test.kind,
		eligible: [...test.ids],
		...(test.expected === undefined ? {} : { expected: test.expected }),
		request: result.request,
		...(result.response === undefined ? {} : { response: result.response }),
		...(result.transport === undefined ? {} : { transport: result.transport }),
		...(result.output === undefined ? {} : { output: result.output }),
		...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
		elapsedMs: result.elapsedMs,
		passed: checked.ok,
		...(checked.ok ? {} : { reason: checked.reason }),
	};
}

/**
 * Run two no-project native GBNF checks. The forced literal is deliberately asked for an incompatible word: a pass
 * is useful evidence that the server sampled under the grammar rather than merely following the prompt. The finite
 * route then checks a real multi-choice roster. If enforcement fails, routing is skipped rather than spending a
 * second request after a server has already shown that it cannot enforce the required grammar.
 */
export async function runLlamaCppSelectorProbe({ server, modelId, fetchImpl = globalThis.fetch, timeoutMs = LLAMA_CPP_SELECTOR_PROBE_TIMEOUT_MS, now = () => Date.now() }) {
	const startedAt = now();
	const cases = [];
	let endpoint;
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
		const result = await requestNativeGrammar({
			server,
			modelId,
			messages: test.payload.messages,
			grammar: test.payload.grammar,
			maxTokens: test.payload.max_tokens,
			temperature: test.payload.temperature,
			thinking: test.payload.chat_template_kwargs?.enable_thinking === true,
			timeoutMs,
			fetchImpl,
			now,
		});
		endpoint ??= result.endpoint;
		cases.push(readResult(result, test));
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
