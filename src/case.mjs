// A bounded same-model evidence case. A case is one agent working through controlled
// visibility and objectives, never a panel of independent agents or a vote. Version 1
// records remain readable; new records use a frozen, structured version 2 capsule.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POLICY } from "./config.mjs";
import { stamp } from "./time.mjs";

export const CASE_VERSION = 2;
export const CASE_ID_PATTERN = "c\\d+";
export const CASE_ID = new RegExp(`^${CASE_ID_PATTERN}$`);
// Version-one records and C1's already-written v2 records retain this original three-phase layout.
// New v2 records carry `flow.version: 2`, which separates blind/cross examination and records the later main-owned witness docket.
export const CASE_PHASES = Object.freeze([
	{ id: "construct", name: "construction", objective: "Construct the narrowest account the frozen evidence supports. State assumptions, observations and the exact claim separately; do not call it confirmed." },
	{ id: "falsify", name: "blind falsification", objective: "Search the frozen evidence and project for a counterexample, missing condition, or alternate explanation. The construction artifact is intentionally not visible here." },
	{ id: "witness", name: "concrete witness", objective: "Make one concrete check against the project or frozen evidence. Distinguish what was observed from what it implies; it may support neither earlier artifact." },
]);
export const CASE_FLOW_VERSION = 2;
export const CASE_FLOW_PHASES = Object.freeze([
	{ id: "construct", name: "construction", objective: "Construct the narrowest account the frozen evidence supports. State assumptions, observations and the exact claim separately; do not call it confirmed." },
	{ id: "falsify-blind", name: "blind falsification", objective: "Search the frozen evidence and project for a counterexample, missing condition, or alternate explanation. The construction artifact, its digest, summary, and citations are intentionally not visible in this blind pass." },
	{ id: "falsify-cross-exam", name: "controlled cross-examination", objective: "After the blind pass is sealed, examine the recorded constructor packet in this same context. Classify every material constructor claim as a confirmed flaw, failed challenge, or exact unresolved point with citations; this is not a rhetorical debate." },
	{ id: "witness", name: "concrete witness", objective: "Make one concrete check against the project or frozen evidence only after the main context supplies a witness specification. Distinguish what was observed from what it implies; it may support neither earlier artifact." },
]);

const CASE_STATUSES = new Set(["running", "ready", "synthesized", "needs-user-input", "stopped"]);
const FLOW_STATES = new Set(["construct", "falsify-blind", "falsify-cross-exam", "awaiting-witness-specification", "witness", "ready-for-synthesis"]);
const PHASE_STATUSES = new Set(["queued", "active", "complete", "ended", "stopped"]);
const MESSAGE_ROUTES = new Set(["active", "queued"]);
const SOURCE_ROLES = new Set(["primary", "derived", "claim"]);
const FRESHNESS = new Set(["current", "changed", "stale", "unknown", "captured"]);
const LEDGER_KINDS = new Set(["observation", "claim", "source-gap", "receipt"]);
const ARTIFACT_CITATION_KINDS = new Set(["source", "receipt", "claim"]);
const OBSERVATION_KINDS = new Set(["direct", "inference"]);
const CROSS_DISPOSITIONS = new Set(["confirmed-flaw", "failed-challenge", "unresolved"]);
const WITNESS_DISPOSITIONS = new Set(["supports", "refutes", "unresolved"]);
const WITNESS_KINDS = new Set(["specification", "main-observation", "closure-gap"]);
const WITNESS_METHODS = new Set(["read", "search", "list", "source", "trace", "proof"]);
const WITNESS_INPUT_KINDS = new Set(["source", "receipt", "tool-call"]);
const REPORT_OUTCOMES = new Set(["supported", "refuted", "unresolved", "needs_user_input"]);
const RECEIPT_TOOLS = new Set(["read", "search", "list"]);
const HEX = /^[a-f0-9]{64}$/;
const SOURCE_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const RECEIPT_ID = /^r[1-9]\d*$/;
const LEDGER_ID = /^l[1-9]\d*$/;

const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const copy = (value) => JSON.parse(JSON.stringify(value));
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value) => Number.isFinite(value);
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const jsonChars = (value, name) => {
	let encoded;
	try {
		encoded = JSON.stringify(value);
	} catch {
		throw new CaseError(`${name} is not JSON data.`);
	}
	if (typeof encoded !== "string") throw new CaseError(`${name} is not JSON data.`);
	return encoded.length;
};
const jsonCopy = (value, name, maxChars) => {
	const chars = jsonChars(value, name);
	need(chars <= maxChars, `${name} exceeds the ${maxChars.toLocaleString("en-US")} character bound.`);
	return JSON.parse(JSON.stringify(value));
};

/** Kept only for v1 reports. V2 data is never display-clipped. */
const clip = (value, max) => {
	const source = String(value ?? "").trim();
	return source.length <= max ? { text: source, clipped: false, chars: source.length } : { text: `${source.slice(0, Math.max(0, max - 1)).trimEnd()}…`, clipped: true, chars: source.length };
};

export class CaseError extends Error {}

export const casesDir = (brainDir) => join(brainDir, "cases");
export const casePath = (brainDir, id) => {
	if (!CASE_ID.test(String(id ?? ""))) throw new CaseError(`${String(id ?? "")} is not a case id.`);
	return join(casesDir(brainDir), `${id}.json`);
};

const atomicWrite = (path, value) => {
	const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	renameSync(temp, path);
};

const nextCaseId = (dir) => {
	let highest = 0;
	try {
		for (const file of readdirSync(dir)) {
			const match = /^c(\d+)\.json$/.exec(file);
			if (match !== null) highest = Math.max(highest, Number(match[1]));
		}
	} catch {
		// The directory does not exist yet.
	}
	return `c${highest + 1}`;
};

const phaseTemplate = (definitions = CASE_PHASES) => definitions.map(({ id, name, objective }) => ({ id, name, objective, status: "queued" }));
export const hasCaseFlow = (caseFile) => caseFile?.version === CASE_VERSION && caseFile?.flow?.version === CASE_FLOW_VERSION;
const usesCaseFlow = hasCaseFlow;
const phaseDefinitions = (caseFile) => usesCaseFlow(caseFile) ? CASE_FLOW_PHASES : CASE_PHASES;
const isCrossExamination = (phase) => phase?.id === "falsify-cross-exam";
const messageLimit = () => POLICY.limits.case.messages;
const messageChars = () => POLICY.limits.case.messageChars;
const caseLimits = () => POLICY.limits.case;

function need(condition, message) {
	if (!condition) throw new CaseError(message);
}

function boundedStrings(value, name, { maxItems, maxChars, allowEmpty = true } = {}) {
	need(Array.isArray(value), `${name} must be an array.`);
	need(value.length <= maxItems, `${name} has more than ${maxItems} entries.`);
	const out = [];
	for (const entry of value) {
		need(typeof entry === "string", `${name} contains a non-string entry.`);
		const clean = compact(entry);
		need(clean !== "", `${name} contains an empty entry.`);
		need(clean.length <= maxChars, `${name} contains an entry over ${maxChars.toLocaleString("en-US")} characters.`);
		need(!out.includes(clean), `${name} contains the same entry twice.`);
		out.push(clean);
	}
	need(allowEmpty || out.length > 0, `${name} needs at least one entry.`);
	return out;
}

function phaseTemplateCheck(caseFile, definitions = phaseDefinitions(caseFile)) {
	need(Array.isArray(caseFile.phases) && caseFile.phases.length === definitions.length, "it has no complete phase list");
	for (const expected of definitions) {
		const phase = caseFile.phases.find((entry) => entry?.id === expected.id);
		need(phase !== undefined && PHASE_STATUSES.has(phase.status), `phase ${expected.id} is invalid`);
		need(phase.name === undefined || phase.name === expected.name, `phase ${expected.id} has a non-canonical name`);
		need(phase.objective === undefined || phase.objective === expected.objective, `phase ${expected.id} has a non-canonical objective`);
		phase.name ??= expected.name;
		phase.objective ??= expected.objective;
	}
}

function messageCheck(caseFile) {
	if (!Array.isArray(caseFile.messages)) caseFile.messages = [];
	if (!Number.isInteger(caseFile.nextMessage) || caseFile.nextMessage < 1) {
		const highest = Math.max(0, ...caseFile.messages.map((entry) => Number(/^u(\d+)$/.exec(String(entry?.id ?? ""))?.[1]) || 0));
		caseFile.nextMessage = highest + 1;
	}
	for (const message of caseFile.messages) {
		need(plain(message) && /^u\d+$/.test(String(message.id ?? "")) && typeof message.text === "string" && finite(message.at) && MESSAGE_ROUTES.has(message.route), "one participant message is invalid");
	}
}

function baseCheck(caseFile) {
	need(plain(caseFile), "it is not one case object");
	need(CASE_ID.test(caseFile.id), "its id is invalid");
	need(typeof caseFile.question === "string" && caseFile.question.trim() !== "", "it has no question");
	need(CASE_STATUSES.has(caseFile.status), `its status ${JSON.stringify(caseFile.status)} is invalid`);
	need(plain(caseFile.capsule), "it has no evidence capsule");
	messageCheck(caseFile);
}

/** v1 stays exactly a free-form historical format; do not migrate or rewrite it on read. */
function normalizeV1(caseFile) {
	baseCheck(caseFile);
	need(caseFile.status !== "needs-user-input", "only a flow-enabled v2 case may carry needs-user-input status");
	phaseTemplateCheck(caseFile, CASE_PHASES);
	return caseFile;
}

function sourceLabel(source) {
	return source.label ?? source.capture?.origin?.label ?? source.id;
}

function sourceLocator(source) {
	const locator = source.capture?.locator;
	if (plain(locator) && typeof locator.path === "string") {
		const range = Number.isInteger(locator.from) ? `:${locator.from}${Number.isInteger(locator.to) ? `-${locator.to}` : ""}` : "";
		return `${locator.path}${range}`;
	}
	if (plain(locator) && plain(locator.ref)) return `${locator.ref.type ?? "reference"}:${locator.ref.id ?? "unknown"}`;
	if (typeof locator === "string") return locator;
	return "captured source";
}

function normalizedCapture(raw, at, name) {
	need(plain(raw), `${name} needs capture metadata.`);
	const status = String(raw.status ?? "captured");
	need(status === "captured" || status === "unavailable", `${name} capture status is invalid.`);
	const origin = jsonCopy(raw.origin, `${name} capture origin`, caseLimits().sourceMetadataChars);
	need(plain(origin) && typeof origin.kind === "string" && compact(origin.kind) !== "", `${name} capture origin is invalid.`);
	origin.kind = compact(origin.kind);
	need(raw.locator !== undefined, `${name} needs a source locator.`);
	let locator = jsonCopy(raw.locator, `${name} source locator`, caseLimits().sourceMetadataChars);
	need(typeof locator === "string" || plain(locator), `${name} source locator is invalid.`);
	if (typeof locator === "string") {
		locator = compact(locator);
		need(locator !== "", `${name} source locator is invalid.`);
	} else need(Object.keys(locator).length > 0, `${name} source locator is invalid.`);
	const capturedAt = raw.at ?? raw.capturedAt ?? at;
	need(finite(capturedAt), `${name} capture time is invalid.`);
	const freshness = String(raw.freshness ?? raw.freshnessAtCapture ?? "unknown");
	need(FRESHNESS.has(freshness), `${name} freshness at capture is invalid.`);
	const result = { status, origin, locator, at: capturedAt, freshness };
	if (status === "captured") {
		need(typeof raw.digest === "string" && HEX.test(raw.digest), `${name} capture digest is invalid.`);
		result.digest = raw.digest;
	}
	return result;
}

function normalizeSource(raw, index, at, known = []) {
	need(plain(raw), `Frozen source ${index + 1} is not an object.`);
	const id = compact(raw.id ?? `s${index + 1}`);
	need(SOURCE_ID.test(id), `Frozen source ${index + 1} has an invalid id.`);
	const role = String(raw.role ?? "primary");
	need(SOURCE_ROLES.has(role), `Frozen source ${id} has invalid role ${JSON.stringify(role)}.`);
	const label = compact(raw.label ?? id);
	need(label !== "" && label.length <= caseLimits().citationChars, `Frozen source ${id} has an invalid label.`);
	const capture = normalizedCapture(raw.capture, at, `Frozen source ${id}`);
	need(raw.content === undefined || raw.snapshot === undefined || raw.content === raw.snapshot, `Frozen source ${id} has conflicting content and snapshot fields.`);
	const content = raw.content ?? raw.snapshot;
	if (capture.status === "captured") {
		need(typeof content === "string", `Frozen source ${id} is captured but has no frozen content.`);
		need(content.length <= caseLimits().sourceTextChars, `Frozen source ${id} exceeds the ${caseLimits().sourceTextChars.toLocaleString("en-US")} character source bound.`);
		need(digest(content) === capture.digest, `Frozen source ${id}'s digest does not match its frozen content.`);
	} else need(content === undefined, `Unavailable frozen source ${id} cannot carry content.`);
	const originKind = String(capture.origin.kind);
	if (role !== "claim") need(!["phase-artifact", "case-artifact", "claim"].includes(originKind), `Frozen source ${id} is marked ${role} but its origin is ${originKind}; use role claim.`);
	if (role === "primary") need(raw.derivedFrom === undefined, `Primary frozen source ${id} cannot name derived sources.`);
	const claim = compact(raw.claim ?? label);
	if (role === "claim") need(claim !== "" && claim.length <= caseLimits().ledgerTextChars, `Claim source ${id} needs bounded claim text or label.`);
	const result = { id, role, label, capture, ...(capture.status === "captured" ? { content } : {}), ...(role === "claim" ? { claim } : {}) };
	if (role === "derived") {
		const derivedFrom = boundedStrings(raw.derivedFrom, `Derived source ${id}.derivedFrom`, { maxItems: caseLimits().capsuleSources, maxChars: 64, allowEmpty: false });
		result.derivedFrom = derivedFrom;
	}
	need(!known.some((entry) => entry.id === id), `Frozen source id ${id} is repeated.`);
	return result;
}

function validateSources(sources, at) {
	need(Array.isArray(sources), "The frozen source list is invalid.");
	need(sources.length <= caseLimits().capsuleSources, `The frozen source list exceeds ${caseLimits().capsuleSources} entries.`);
	const normalized = [];
	for (const [index, source] of sources.entries()) normalized.push(normalizeSource(source, index, at, normalized));
	const totalChars = normalized.reduce((sum, source) => sum + String(source.content ?? "").length, 0);
	need(totalChars <= caseLimits().evidenceChars, `The frozen source contents exceed the ${caseLimits().evidenceChars.toLocaleString("en-US")} character capsule bound.`);
	const byId = new Map(normalized.map((source) => [source.id, source]));
	for (const source of normalized) {
		if (source.role !== "derived") continue;
		for (const parent of source.derivedFrom) {
			const found = byId.get(parent);
			need(found !== undefined, `Derived source ${source.id} names unknown source ${parent}.`);
			need(parent !== source.id, `Derived source ${source.id} cannot derive from itself.`);
			need(found.role !== "claim", `Derived source ${source.id} cannot treat claim source ${parent} as primary evidence.`);
		}
	}
	const visiting = new Set();
	const checked = new Set();
	const visit = (source) => {
		if (checked.has(source.id) || source.role !== "derived") return;
		need(!visiting.has(source.id), `Derived source ${source.id} is part of a circular provenance chain.`);
		visiting.add(source.id);
		for (const parent of source.derivedFrom) visit(byId.get(parent));
		visiting.delete(source.id);
		checked.add(source.id);
	};
	for (const source of normalized) visit(source);
	return normalized;
}

function normalizeInitialLedger(raw, sources, at) {
	if (raw === undefined) {
		return sources.map((source, index) => ({
			id: `l${index + 1}`,
			kind: source.role === "claim" ? "claim" : source.capture.status === "unavailable" ? "source-gap" : "observation",
			text: source.role === "claim" ? source.claim : source.capture.status === "unavailable" ? `Frozen source ${source.id} was unavailable at capture.` : `Frozen ${source.role} source ${source.id} was captured.`,
			citations: [source.id],
			at,
		}));
	}
	need(Array.isArray(raw), "The initial evidence ledger must be an array.");
	return raw.map((entry, index) => normalizeLedgerEntry(entry, { index, sources, at, initial: true }));
}

function normalizeLedgerEntry(raw, { index = 0, sources = [], phases = CASE_PHASES, at = Date.now(), initial = false } = {}) {
	need(plain(raw), "An evidence ledger entry is invalid.");
	const id = compact(raw.id ?? `l${index + 1}`);
	const kind = String(raw.kind);
	need(LEDGER_KINDS.has(kind), `Evidence ledger entry ${id} has invalid kind ${JSON.stringify(kind)}.`);
	need((kind === "receipt" ? RECEIPT_ID : LEDGER_ID).test(id), `Evidence ledger entry ${index + 1} has an invalid id.`);
	need(kind !== "receipt" || !initial, "A frozen capsule ledger cannot contain a phase-local receipt.");
	const recordedAt = raw.at ?? raw.capturedAt ?? at;
	need(finite(recordedAt), `Evidence ledger entry ${id} has an invalid time.`);
	if (kind === "receipt") {
		need(typeof raw.phase === "string" && phases.some((phase) => phase.id === raw.phase), `Receipt ${id} has an invalid phase.`);
		const tool = compact(raw.tool);
		need(RECEIPT_TOOLS.has(tool), `Receipt ${id} has an unsupported source tool.`);
		const input = jsonCopy(raw.input, `Receipt ${id} input`, caseLimits().sourceMetadataChars);
		need(plain(input), `Receipt ${id} input is invalid.`);
		need(typeof raw.inputDigest === "string" && HEX.test(raw.inputDigest) && digest(input) === raw.inputDigest, `Receipt ${id} has an invalid input digest.`);
		need(typeof raw.output === "string" && raw.output.length <= caseLimits().receiptChars, `Receipt ${id} has invalid output.`);
		need(typeof raw.outputDigest === "string" && HEX.test(raw.outputDigest) && digest(raw.output) === raw.outputDigest, `Receipt ${id} has an invalid output digest.`);
		need(typeof raw.digest === "string" && HEX.test(raw.digest), `Receipt ${id} has an invalid digest.`);
		const canonical = { phase: raw.phase, tool, input, inputDigest: raw.inputDigest, output: raw.output, outputDigest: raw.outputDigest, at: recordedAt };
		need(digest(canonical) === raw.digest, `Receipt ${id}'s digest does not match its immutable data.`);
		return { id, kind, ...canonical, digest: raw.digest };
	}
	const entryText = compact(raw.text);
	need(entryText !== "" && entryText.length <= caseLimits().ledgerTextChars, `Evidence ledger entry ${id} has invalid text.`);
	const citations = boundedStrings(raw.citations ?? [], `Evidence ledger entry ${id}.citations`, { maxItems: caseLimits().citations, maxChars: 64 });
	const citedSources = citations.map((citation) => {
		const source = sources.find((entry) => entry.id === citation);
		need(source !== undefined, `Evidence ledger entry ${id} cites unknown frozen source ${citation}.`);
		return source;
	});
	if (kind === "observation") {
		need(citedSources.length > 0, `Evidence ledger observation ${id} needs a frozen source citation.`);
		for (const source of citedSources) {
			need(source.role !== "claim", `Evidence ledger observation ${id} cannot promote claim source ${source.id}.`);
			need(source.capture.status === "captured", `Evidence ledger observation ${id} cannot use unavailable source ${source.id}.`);
		}
	}
	return { id, kind, text: entryText, citations, at: recordedAt };
}

function nextLedgerNumber(ledger) {
	return Math.max(0, ...ledger.map((entry) => Number(/^[lr](\d+)$/.exec(entry.id)?.[1]) || 0)) + 1;
}

function receiptOutputChars(ledger) {
	return ledger.reduce((total, entry) => total + (entry.kind === "receipt" ? entry.output.length : 0), 0);
}

function artifactData(caseFile, raw, phase) {
	need(plain(raw), "A case phase must return a structured artifact object.");
	const cross = isCrossExamination(phase);
	const witness = usesCaseFlow(caseFile) && phase?.id === "witness";
	const required = ["candidate", "observations", "assumptions", "citations", "falsifiers", "proposed_witness", "closure_gaps", "uncertainty", ...(cross ? ["cross_examination"] : []), ...(witness ? ["witness_assessment"] : [])];
	for (const name of required) need(Object.hasOwn(raw, name), `The structured artifact is missing required field ${name}.`);
	for (const name of Object.keys(raw)) need(required.includes(name), `The structured artifact has unsupported field ${name}.`);
	const candidate = compact(raw.candidate);
	need(candidate !== "" && candidate.length <= caseLimits().artifactTextChars, "The structured artifact candidate is missing or oversized.");
	const assumptions = boundedStrings(raw.assumptions, "artifact assumptions", { maxItems: caseLimits().artifactItems, maxChars: caseLimits().artifactTextChars });
	const falsifiers = boundedStrings(raw.falsifiers, "artifact falsifiers", { maxItems: caseLimits().artifactItems, maxChars: caseLimits().artifactTextChars });
	const closureGaps = boundedStrings(raw.closure_gaps, "artifact closure_gaps", { maxItems: caseLimits().artifactItems, maxChars: caseLimits().artifactTextChars });
	const uncertainty = boundedStrings(raw.uncertainty, "artifact uncertainty", { maxItems: caseLimits().artifactItems, maxChars: caseLimits().artifactTextChars });
	const proposedWitness = compact(raw.proposed_witness);
	need(proposedWitness !== "" && proposedWitness.length <= caseLimits().artifactTextChars, "The structured artifact proposed_witness is missing or oversized.");
	need(Array.isArray(raw.citations) && raw.citations.length <= caseLimits().citations, "The structured artifact citations are invalid.");
	const citations = raw.citations.map((citation, index) => {
		need(plain(citation), `Artifact citation ${index + 1} is invalid.`);
		const ref = compact(citation.ref);
		const kind = String(citation.kind);
		need(ref !== "" && ref.length <= 64, `Artifact citation ${index + 1} has invalid ref.`);
		need(ARTIFACT_CITATION_KINDS.has(kind), `Artifact citation ${index + 1} has invalid kind.`);
		return { ref, kind };
	});
	need(new Set(citations.map((citation) => citation.ref)).size === citations.length, "The structured artifact cites one ref more than once.");
	need(Array.isArray(raw.observations) && raw.observations.length <= caseLimits().artifactItems, "The structured artifact observations are invalid.");
	const observations = raw.observations.map((observation, index) => {
		need(plain(observation), `Artifact observation ${index + 1} is invalid.`);
		const expected = ["kind", "text", "citations"];
		for (const name of expected) need(Object.hasOwn(observation, name), `Artifact observation ${index + 1} is missing ${name}.`);
		for (const name of Object.keys(observation)) need(expected.includes(name), `Artifact observation ${index + 1} has unsupported field ${name}.`);
		const kind = String(observation.kind);
		need(OBSERVATION_KINDS.has(kind), `Artifact observation ${index + 1} has invalid kind.`);
		const observed = compact(observation.text);
		need(observed !== "" && observed.length <= caseLimits().artifactTextChars, `Artifact observation ${index + 1} has invalid text.`);
		const refs = boundedStrings(observation.citations, `Artifact observation ${index + 1}.citations`, { maxItems: caseLimits().citations, maxChars: 64, allowEmpty: kind !== "direct" });
		return { kind, text: observed, citations: refs };
	});
	if (cross) need(Array.isArray(raw.cross_examination), "The cross-examination challenges are invalid.");
	const crossExamination = cross
		? raw.cross_examination.map((challenge, index) => {
			need(plain(challenge), `Cross-examination challenge ${index + 1} is invalid.`);
			const expected = ["claim", "disposition", "text", "citations"];
			for (const name of expected) need(Object.hasOwn(challenge, name), `Cross-examination challenge ${index + 1} is missing ${name}.`);
			for (const name of Object.keys(challenge)) need(expected.includes(name), `Cross-examination challenge ${index + 1} has unsupported field ${name}.`);
			const claim = compact(challenge.claim);
			need(claim !== "" && claim.length <= 64, `Cross-examination challenge ${index + 1} has invalid claim id.`);
			const disposition = String(challenge.disposition);
			need(CROSS_DISPOSITIONS.has(disposition), `Cross-examination challenge ${index + 1} has invalid disposition.`);
			const text = compact(challenge.text);
			need(text !== "" && text.length <= caseLimits().artifactTextChars, `Cross-examination challenge ${index + 1} has invalid text.`);
			const refs = boundedStrings(challenge.citations, `Cross-examination challenge ${index + 1}.citations`, { maxItems: caseLimits().citations, maxChars: 64, allowEmpty: false });
			return { claim, disposition, text, citations: refs };
		})
		: undefined;
	if (crossExamination !== undefined) need(crossExamination.length <= caseLimits().crossChallenges, `The cross-examination has more than ${caseLimits().crossChallenges} challenges.`);
	const witnessAssessment = witness ? normalizeWitnessAssessment(caseFile, raw.witness_assessment) : undefined;
	const data = { candidate, observations, assumptions, citations, falsifiers, proposedWitness, closureGaps, uncertainty, ...(crossExamination === undefined ? {} : { crossExamination }), ...(witnessAssessment === undefined ? {} : { witnessAssessment }) };
	need(JSON.stringify(data).length <= caseLimits().artifactChars, `The structured artifact exceeds the ${caseLimits().artifactChars.toLocaleString("en-US")} character storage bound.`);
	return data;
}

function artifactRendering(data) {
	const list = (heading, entries) => [heading, ...(entries.length === 0 ? ["  (none)"] : entries.map((entry) => `  ${entry}`))];
	const lines = ["Structured case artifact", "", "Candidate", `  ${data.candidate}`, "", "Observations"];
	if (data.observations.length === 0) lines.push("  (none)");
	else for (const observation of data.observations) lines.push(`  [${observation.kind}] ${observation.text}${observation.citations.length === 0 ? "" : ` · cites ${observation.citations.join(", ")}`}`);
	lines.push("", ...list("Assumptions", data.assumptions), "", "Citations");
	if (data.citations.length === 0) lines.push("  (none)");
	else for (const citation of data.citations) lines.push(`  ${citation.ref} · ${citation.kind}`);
	lines.push("", ...list("Falsifiers", data.falsifiers), "", "Proposed witness", `  ${data.proposedWitness}`, "", ...list("Closure gaps", data.closureGaps), "", ...list("Uncertainty", data.uncertainty));
	if (data.crossExamination !== undefined) {
		lines.push("", "Controlled cross-examination");
		if (data.crossExamination.length === 0) lines.push("  (no material constructor claim was available to challenge)");
		else for (const challenge of data.crossExamination) lines.push(`  ${challenge.claim} · ${challenge.disposition} · ${challenge.text} · cites ${challenge.citations.join(", ")}`);
	}
	if (data.witnessAssessment !== undefined) {
		lines.push("", "Witness assessment");
		if (data.witnessAssessment.length === 0) lines.push("  (the witness docket named no material claim)");
		else for (const assessment of data.witnessAssessment) lines.push(`  ${assessment.claim} · ${assessment.disposition} · ${assessment.text} · cites ${assessment.citations.join(", ")}`);
	}
	return lines.join("\n");
}

function validateArtifactCitations(caseFile, phase, data) {
	const citations = new Map(data.citations.map((citation) => [citation.ref, citation]));
	for (const citation of data.citations) {
		if (citation.kind === "source") {
			const source = caseFile.capsule.sources.find((entry) => entry.id === citation.ref);
			need(source !== undefined, `Artifact citation ${citation.ref} is not a frozen source.`);
			need(source.role !== "claim", `Claim source ${citation.ref} cannot be cited as direct source evidence; cite it as a claim under review.`);
			need(source.capture.status === "captured", `Unavailable source ${citation.ref} cannot support an observation.`);
		} else if (citation.kind === "receipt") {
			const receipt = caseFile.ledger.find((entry) => entry.id === citation.ref && entry.kind === "receipt");
			need(receipt !== undefined, `Artifact citation ${citation.ref} is not an immutable phase-local receipt.`);
			const carried = usesCaseFlow(caseFile) && phase.id === "witness" && receiptIdsCitedBeforePhase(caseFile, phase).has(receipt.id);
			need(receipt.phase === phase.id || carried, `Artifact receipt ${citation.ref} belongs to ${receipt.phase}, not this ${phase.id} phase or its sealed witness inputs.`);
		} else {
			const claimSource = caseFile.capsule.sources.find((entry) => entry.id === citation.ref && entry.role === "claim");
			const phaseMatch = /^phase:([a-z][a-z0-9-]*)$/.exec(citation.ref)?.[1];
			if (claimSource !== undefined) continue;
			need(phaseMatch !== undefined, `Claim citation ${citation.ref} is neither a frozen claim source nor a prior phase artifact.`);
			const prior = caseFile.phases.find((entry) => entry.id === phaseMatch);
			need(prior?.status === "complete", `Claim citation ${citation.ref} has no completed prior artifact.`);
			need(prior.id !== phase.id, `A phase cannot cite its own artifact as a prior claim.`);
			const definitions = phaseDefinitions(caseFile);
			need(definitions.findIndex((entry) => entry.id === prior.id) < definitions.findIndex((entry) => entry.id === phase.id), `Claim citation ${citation.ref} is not a prior phase artifact.`);
			need(!((phase.id === "falsify" || phase.id === "falsify-blind") && prior.id === "construct"), "Blind falsification cannot cite the hidden construction artifact.");
		}
	}
	for (const observation of data.observations) {
		for (const ref of observation.citations) {
			const citation = citations.get(ref);
			need(citation !== undefined, `Observation cites ${ref}, but that ref is absent from artifact citations.`);
			if (observation.kind === "direct") need(citation.kind === "source" || citation.kind === "receipt", `Direct observation ${JSON.stringify(observation.text)} must cite a frozen source or immutable phase-local receipt, not ${citation.kind}.`);
		}
	}
	if (isCrossExamination(phase)) {
		need(usesCaseFlow(caseFile), "Controlled cross-examination belongs only to the explicit case flow.");
		const expected = materialConstructorClaims(caseFile);
		const challenges = data.crossExamination ?? [];
		need(challenges.length === expected.length, "The controlled cross-examination must classify every material constructor claim exactly once.");
		need(new Set(challenges.map((challenge) => challenge.claim)).size === challenges.length, "The controlled cross-examination repeats a material constructor claim.");
		const expectedIds = new Set(expected.map((claim) => claim.id));
		for (const challenge of challenges) {
			need(expectedIds.has(challenge.claim), `Cross-examination challenge ${challenge.claim} is not a recorded material constructor claim.`);
			for (const ref of challenge.citations) {
				const citation = citations.get(ref);
				need(citation !== undefined, `Cross-examination challenge ${challenge.claim} cites ${ref}, but that ref is absent from artifact citations.`);
				if (challenge.disposition !== "unresolved") need(citation.kind === "source" || citation.kind === "receipt", `Cross-examination challenge ${challenge.claim} needs direct cited evidence for ${challenge.disposition}.`);
			}
		}
		if (challenges.some((challenge) => challenge.disposition === "unresolved")) need(data.closureGaps.length > 0, "An unresolved controlled cross-examination classification needs an exact closure gap.");
		if (expected.length > 0) need(citations.get("phase:construct")?.kind === "claim", "A controlled cross-examination must cite the recorded constructor artifact as a claim under review.");
	}
	if (usesCaseFlow(caseFile) && phase.id === "witness") {
		const docket = caseFile.flow.witness;
		need(docket?.kind === "specification", "A witness artifact needs a recorded main-owned witness specification.");
		for (const citation of data.citations) {
			if (citation.kind === "source") need(witnessAllowsSource(docket, citation.ref), `Witness artifact source ${citation.ref} is outside the main-owned witness docket.`);
			if (citation.kind === "receipt") {
				const receipt = caseFile.ledger.find((entry) => entry.id === citation.ref && entry.kind === "receipt");
				need(receipt !== undefined && (receipt.phase === phase.id ? witnessAllowsToolReceipt(docket, receipt) : witnessAllowsCarriedReceipt(docket, receipt.id)), `Witness artifact receipt ${citation.ref} is outside the main-owned witness docket.`);
			}
		}
		const assessments = data.witnessAssessment ?? [];
		for (const assessment of assessments) {
			for (const ref of assessment.citations) {
				const citation = citations.get(ref);
				need(citation !== undefined, `Witness assessment ${assessment.claim} cites ${ref}, but that ref is absent from artifact citations.`);
				if (assessment.disposition !== "unresolved") need(citation.kind === "source" || citation.kind === "receipt", `Witness assessment ${assessment.claim} needs direct cited evidence for ${assessment.disposition}.`);
			}
		}
		if (assessments.some((assessment) => assessment.disposition === "unresolved")) need(data.closureGaps.length > 0, "An unresolved witness assessment needs an exact closure gap.");
		if (docket.targetClaims.length > 0) need(citations.get("phase:construct")?.kind === "claim", "A witness assessment must cite the constructor artifact as a claim under review.");
	}
}

function freezeArtifact(caseFile, phase, raw, { done, at } = {}) {
	need(typeof done === "boolean", "A structured case artifact needs the return done boolean.");
	need(finite(at), "A structured case artifact needs a finite capture time.");
	const data = artifactData(caseFile, raw, phase);
	validateArtifactCitations(caseFile, phase, data);
	need(!(done && data.closureGaps.length > 0), "A structured artifact with closure_gaps must return done: false.");
	const rendering = artifactRendering(data);
	need(rendering.length <= caseLimits().artifactChars, `The structured artifact rendering exceeds the ${caseLimits().artifactChars.toLocaleString("en-US")} character storage bound.`);
	const canonical = { phase: phase.id, done, data, rendering };
	return { version: CASE_VERSION, kind: "structured", ...canonical, chars: rendering.length, digest: digest(canonical), at };
}

function failureArtifact(phase, reason, at) {
	need(finite(at), "A phase failure artifact needs a finite capture time.");
	const failure = clip(compact(reason) || `The ${phase.name} phase ended without a structured artifact.`, caseLimits().failureChars).text;
	const rendering = `No structured artifact was returned.\n\nFailure\n  ${failure}`;
	const canonical = { phase: phase.id, failure, rendering };
	return { version: CASE_VERSION, kind: "failure", ...canonical, chars: rendering.length, digest: digest(canonical), at };
}

function checkStoredArtifact(caseFile, phase) {
	const artifact = phase.artifact;
	if (artifact === undefined) return;
	need(plain(artifact) && artifact.version === CASE_VERSION, `Phase ${phase.id} has an invalid v2 artifact.`);
	need(typeof artifact.kind === "string" && ["structured", "failure"].includes(artifact.kind), `Phase ${phase.id} has an invalid artifact kind.`);
	need(typeof artifact.rendering === "string" && artifact.rendering.length <= caseLimits().artifactChars && Number.isInteger(artifact.chars) && artifact.chars === artifact.rendering.length, `Phase ${phase.id} has invalid readable artifact rendering.`);
	need(typeof artifact.digest === "string" && HEX.test(artifact.digest) && finite(artifact.at), `Phase ${phase.id} has invalid artifact digest or capture time.`);
	if (artifact.kind === "failure") {
		need(typeof artifact.failure === "string" && artifact.failure !== "" && artifact.failure.length <= caseLimits().failureChars, `Phase ${phase.id} failure artifact is invalid.`);
		need(artifact.rendering === `No structured artifact was returned.\n\nFailure\n  ${artifact.failure}`, `Phase ${phase.id} failure artifact rendering is non-canonical.`);
		need(artifact.digest === digest({ phase: phase.id, failure: artifact.failure, rendering: artifact.rendering }), `Phase ${phase.id} failure artifact digest does not match.`);
		return;
	}
	need(typeof artifact.done === "boolean" && plain(artifact.data), `Phase ${phase.id} structured artifact is invalid.`);
	const data = artifactData(caseFile, {
		candidate: artifact.data.candidate,
		observations: artifact.data.observations,
		assumptions: artifact.data.assumptions,
		citations: artifact.data.citations,
		falsifiers: artifact.data.falsifiers,
		proposed_witness: artifact.data.proposedWitness,
		closure_gaps: artifact.data.closureGaps,
		uncertainty: artifact.data.uncertainty,
		...(isCrossExamination(phase) ? { cross_examination: artifact.data.crossExamination } : {}),
		...(usesCaseFlow(caseFile) && phase.id === "witness" ? { witness_assessment: artifact.data.witnessAssessment } : {}),
	}, phase);
	need(sameJson(data, artifact.data), `Phase ${phase.id} structured artifact data is non-canonical.`);
	validateArtifactCitations(caseFile, phase, data);
	need(!(artifact.done && data.closureGaps.length > 0), `Phase ${phase.id} marks closure gaps complete.`);
	need(artifact.rendering === artifactRendering(data), `Phase ${phase.id} readable artifact rendering does not match its structured data.`);
	need(artifact.digest === digest({ phase: phase.id, done: artifact.done, data, rendering: artifact.rendering }), `Phase ${phase.id} artifact digest does not match.`);
}

/** Material constructor claims are deliberately narrow: the candidate and any explicitly inferential observations,
 * never a direct source observation promoted merely because another pass repeats it. */
function materialConstructorClaims(caseFile) {
	const construct = caseFile.phases?.find((phase) => phase.id === "construct");
	if (construct?.artifact?.kind !== "structured") return [];
	const claims = [{ id: "construct:candidate", text: construct.artifact.data.candidate }];
	for (const [index, observation] of construct.artifact.data.observations.entries()) {
		if (observation.kind === "inference") claims.push({ id: `construct:inference:${index + 1}`, text: observation.text });
	}
	return claims;
}

const materialClaimIds = (caseFile) => materialConstructorClaims(caseFile).map((claim) => claim.id);

function receiptIdsCitedBeforePhase(caseFile, phase) {
	const definitions = phaseDefinitions(caseFile);
	const before = definitions.findIndex((entry) => entry.id === phase.id);
	const ids = new Set();
	for (const definition of definitions.slice(0, Math.max(0, before))) {
		const prior = phaseOf(caseFile, definition.id);
		if (prior?.artifact?.kind !== "structured") continue;
		for (const citation of prior.artifact.data.citations ?? []) if (citation.kind === "receipt") ids.add(citation.ref);
	}
	return ids;
}

function normalizeClaimAssessments(raw, expectedClaims, label = "Witness assessment") {
	need(Array.isArray(raw), `${label} is invalid.`);
	need(raw.length === expectedClaims.length, `${label} must classify every target claim exactly once.`);
	need(raw.length <= caseLimits().witnessClaims, `${label} exceeds its ${caseLimits().witnessClaims} claim bound.`);
	const expected = new Set(expectedClaims);
	const entries = raw.map((entry, index) => {
		need(plain(entry), `${label} ${index + 1} is invalid.`);
		const fields = ["claim", "disposition", "text", "citations"];
		for (const field of fields) need(Object.hasOwn(entry, field), `${label} ${index + 1} is missing ${field}.`);
		for (const field of Object.keys(entry)) need(fields.includes(field), `${label} ${index + 1} has unsupported field ${field}.`);
		const claim = compact(entry.claim);
		need(expected.has(claim), `${label} ${claim || index + 1} is not an exact target claim.`);
		const disposition = String(entry.disposition);
		need(WITNESS_DISPOSITIONS.has(disposition), `${label} ${claim} has an invalid disposition.`);
		const text = compact(entry.text);
		need(text !== "" && text.length <= caseLimits().witnessTextChars, `${label} ${claim} has invalid text.`);
		const citations = boundedStrings(entry.citations, `${label} ${claim}.citations`, { maxItems: caseLimits().citations, maxChars: 64, allowEmpty: false });
		return { claim, disposition, text, citations };
	});
	need(new Set(entries.map((entry) => entry.claim)).size === entries.length, `${label} repeats a target claim.`);
	return entries;
}

function normalizeWitnessAssessment(caseFile, raw) {
	const docket = caseFile.flow?.witness;
	need(docket?.kind === "specification", "A witness artifact needs a recorded main-owned witness specification.");
	return normalizeClaimAssessments(raw, docket.targetClaims);
}

/** The exact user-visible packet the harness appends to the same falsifier context after blind storage. */
export function renderCrossExaminationPacket(caseFile) {
	need(usesCaseFlow(caseFile), "A controlled cross-examination packet belongs only to the explicit case flow.");
	const construct = phaseOf(caseFile, "construct");
	const blind = phaseOf(caseFile, "falsify-blind");
	need(construct.artifact !== undefined && blind.artifact !== undefined, "The controlled cross-examination needs recorded constructor and blind artifacts.");
	const claims = materialConstructorClaims(caseFile);
	const artifact = construct.artifact;
	const lines = [
		"Controlled cross-examination packet",
		"",
		"Blind pass durable seal",
		`  falsify-blind · sha256 ${blind.artifact.digest}`,
		"  The blind artifact was durably stored before this packet was appended. Continue in this same falsifier context; do not turn this into a constructor rebuttal loop.",
		"",
		"Recorded constructor packet",
		`  construct · ${artifact.kind === "structured" ? (artifact.done ? "returned done" : "returned not done") : "no structured return"} · sha256 ${artifact.digest}`,
		...artifact.rendering.split("\n").map((line) => `    ${line}`),
		"",
		"Material constructor claims to classify exactly once",
		...(claims.length === 0 ? ["  (none: the constructor returned no structured material claim)"] : claims.map((claim) => `  ${claim.id} · see the recorded constructor packet above`)),
		"",
		"Controlled return requirement",
		"  I call `return` with the ordinary structured artifact fields and `cross_examination`. It has one entry for each listed material claim, with claim, disposition (`confirmed-flaw`, `failed-challenge`, or `unresolved`), exact text, and citations. I cite `phase:construct` as a claim under review, never as primary evidence. A confirmed flaw or failed challenge needs a frozen source or my own phase-local receipt; an unresolved point names a closure gap and returns done false.",
	];
	const text = lines.join("\n");
	need(text.length <= caseLimits().crossPacketChars, `The controlled cross-examination packet exceeds the ${caseLimits().crossPacketChars.toLocaleString("en-US")} character storage bound.`);
	return text;
}

function packetMeta(caseFile, at) {
	const construct = phaseOf(caseFile, "construct");
	const blind = phaseOf(caseFile, "falsify-blind");
	need(construct.artifact !== undefined && blind.artifact !== undefined, "The controlled cross-examination needs recorded constructor and blind artifacts.");
	const claims = materialConstructorClaims(caseFile);
	const text = renderCrossExaminationPacket(caseFile);
	return {
		version: 1,
		constructDigest: construct.artifact.digest,
		blindDigest: blind.artifact.digest,
		claims,
		textDigest: digest(text),
		preparedAt: at,
	};
}

function normalizeWitnessCitationList(raw, label) {
	need(Array.isArray(raw) && raw.length <= caseLimits().citations, `${label} citations are invalid.`);
	const citations = raw.map((citation, index) => {
		need(plain(citation), `${label} citation ${index + 1} is invalid.`);
		need(Object.keys(citation).every((key) => ["ref", "kind"].includes(key)), `${label} citation ${index + 1} has unsupported fields.`);
		const ref = compact(citation.ref);
		const kind = String(citation.kind);
		need(ref !== "" && ref.length <= 64, `${label} citation ${index + 1} has invalid ref.`);
		need(ARTIFACT_CITATION_KINDS.has(kind), `${label} citation ${index + 1} has invalid kind.`);
		return { ref, kind };
	});
	need(new Set(citations.map((citation) => citation.ref)).size === citations.length, `${label} cites one ref more than once.`);
	return citations;
}

function normalizeWitnessToolInput(tool, raw, index) {
	need(plain(raw), `Witness allowed tool input ${index + 1} is invalid.`);
	const input = jsonCopy(raw, `Witness allowed tool input ${index + 1}`, caseLimits().sourceMetadataChars);
	const fields = Object.keys(input);
	const own = (name) => Object.hasOwn(input, name);
	if (tool === "read") {
		need(fields.every((key) => ["path", "range", "version"].includes(key)) && own("path"), `Witness allowed read input ${index + 1} must name one exact project path.`);
		const path = compact(input.path);
		need(path !== "" && path.length <= caseLimits().sourceMetadataChars, `Witness allowed read input ${index + 1} has invalid path.`);
		const range = own("range") ? compact(input.range) : undefined;
		const version = own("version") ? compact(input.version) : undefined;
		need(range === undefined || (range !== "" && range.length <= 64), `Witness allowed read input ${index + 1} has invalid range.`);
		need(version === undefined || HEX.test(version), `Witness allowed read input ${index + 1} has invalid version.`);
		return { path, ...(range === undefined ? {} : { range }), ...(version === undefined ? {} : { version }) };
	}
	if (tool === "search") {
		need(fields.every((key) => ["pattern", "path", "glob", "ignore_case", "max"].includes(key)) && own("pattern"), `Witness allowed search input ${index + 1} must name one exact pattern.`);
		const pattern = compact(input.pattern);
		need(pattern !== "" && pattern.length <= caseLimits().sourceMetadataChars, `Witness allowed search input ${index + 1} has invalid pattern.`);
		const path = own("path") ? compact(input.path) : undefined;
		const glob = own("glob") ? compact(input.glob) : undefined;
		const ignoreCase = own("ignore_case") ? input.ignore_case : undefined;
		const max = own("max") ? input.max : undefined;
		need(path === undefined || (path !== "" && path.length <= caseLimits().sourceMetadataChars), `Witness allowed search input ${index + 1} has invalid path.`);
		need(glob === undefined || (glob !== "" && glob.length <= caseLimits().sourceMetadataChars), `Witness allowed search input ${index + 1} has invalid glob.`);
		need(ignoreCase === undefined || typeof ignoreCase === "boolean", `Witness allowed search input ${index + 1} has invalid ignore_case.`);
		need(max === undefined || (Number.isInteger(max) && max >= 1 && max <= POLICY.limits.look.searchMax), `Witness allowed search input ${index + 1} has invalid max.`);
		return { pattern, ...(path === undefined ? {} : { path }), ...(glob === undefined ? {} : { glob }), ...(ignoreCase === undefined ? {} : { ignore_case: ignoreCase }), ...(max === undefined ? {} : { max }) };
	}
	need(tool === "list", `Witness allowed tool input ${index + 1} has unsupported tool ${tool}.`);
	need(fields.every((key) => ["path", "depth"].includes(key)) && own("path"), `Witness allowed list input ${index + 1} must name one exact project path.`);
	const path = compact(input.path);
	const depth = own("depth") ? input.depth : undefined;
	need(path !== "" && path.length <= caseLimits().sourceMetadataChars, `Witness allowed list input ${index + 1} has invalid path.`);
	need(depth === undefined || (Number.isInteger(depth) && depth >= 1 && depth <= POLICY.limits.tree.maxDepth), `Witness allowed list input ${index + 1} has invalid depth.`);
	return { path, ...(depth === undefined ? {} : { depth }) };
}

function normalizeWitnessInputs(raw, caseFile) {
	need(Array.isArray(raw) && raw.length <= caseLimits().witnessInputs, "Witness allowed_inputs are invalid.");
	const carriedReceipts = citedReceiptIds(caseFile);
	const inputs = raw.map((entry, index) => {
		need(plain(entry), `Witness allowed input ${index + 1} is invalid.`);
		const kind = String(entry.kind);
		need(WITNESS_INPUT_KINDS.has(kind), `Witness allowed input ${index + 1} has invalid kind.`);
		if (kind === "source") {
			need(Object.keys(entry).every((key) => ["kind", "ref"].includes(key)), `Witness allowed source ${index + 1} has unsupported fields.`);
			const ref = compact(entry.ref);
			need(caseFile.capsule.sources.some((source) => source.id === ref), `Witness allowed source ${ref || index + 1} is not frozen in this case.`);
			return { kind, ref };
		}
		if (kind === "receipt") {
			need(Object.keys(entry).every((key) => ["kind", "ref"].includes(key)), `Witness allowed receipt ${index + 1} has unsupported fields.`);
			const ref = compact(entry.ref);
			need(RECEIPT_ID.test(ref) && carriedReceipts.has(ref), `Witness allowed receipt ${ref || index + 1} is not cited by a sealed earlier artifact.`);
			return { kind, ref };
		}
		need(Object.keys(entry).every((key) => ["kind", "tool", "input"].includes(key)) && Object.hasOwn(entry, "tool") && Object.hasOwn(entry, "input"), `Witness allowed tool call ${index + 1} needs tool and input.`);
		const tool = String(entry.tool);
		need(RECEIPT_TOOLS.has(tool), `Witness allowed tool call ${index + 1} has unsupported tool.`);
		return { kind, tool, input: normalizeWitnessToolInput(tool, entry.input, index) };
	});
	need(new Set(inputs.map((entry) => JSON.stringify(entry))).size === inputs.length, "Witness allowed_inputs repeats one entry.");
	return inputs;
}

function normalizeWitnessTargets(raw, caseFile) {
	const available = materialClaimIds(caseFile);
	const targets = boundedStrings(raw, "Witness target_claims", { maxItems: caseLimits().witnessClaims, maxChars: 64, allowEmpty: available.length === 0 });
	const known = new Set(available);
	for (const target of targets) need(known.has(target), `Witness target claim ${target} is not a recorded material constructor claim.`);
	return available.filter((target) => targets.includes(target));
}

function normalizeWitnessDocket(raw, caseFile, { at } = {}) {
	need(plain(raw), "A witness docket must be a structured object.");
	need(finite(at), "A witness docket needs a finite capture time.");
	const kind = String(raw.kind);
	need(WITNESS_KINDS.has(kind), "A witness docket kind is specification, main-observation, or closure-gap.");
	const targetClaims = normalizeWitnessTargets(raw.target_claims, caseFile);
	if (kind === "closure-gap") {
		const allowed = new Set(["kind", "target_claims", "closure_gap"]);
		for (const key of Object.keys(raw)) need(allowed.has(key), `A witness closure gap has unsupported field ${key}.`);
		const closureGap = compact(raw.closure_gap);
		need(closureGap !== "" && closureGap.length <= caseLimits().witnessTextChars, "A witness closure gap is missing or oversized.");
		const canonical = { version: 1, id: "g1", kind, targetClaims, closureGap, at };
		return { ...canonical, digest: digest(canonical) };
	}
	const allowed = new Set(["kind", "target_claims", "method", "allowed_inputs", "expected_discriminator", "unresolved_if", "budget", ...(kind === "main-observation" ? ["observation", "citations", "assessment"] : [])]);
	for (const key of Object.keys(raw)) need(allowed.has(key), `A witness ${kind} has unsupported field ${key}.`);
	const method = String(raw.method);
	need(WITNESS_METHODS.has(method), "A witness method is read, search, list, source, trace, or proof.");
	const allowedInputs = normalizeWitnessInputs(raw.allowed_inputs, caseFile);
	need(allowedInputs.length > 0 || targetClaims.length === 0, "A witness specification needs at least one allowed input.");
	const expectedDiscriminator = compact(raw.expected_discriminator);
	const unresolvedIf = compact(raw.unresolved_if);
	need(expectedDiscriminator !== "" && expectedDiscriminator.length <= caseLimits().witnessTextChars, "A witness expected_discriminator is missing or oversized.");
	need(unresolvedIf !== "" && unresolvedIf.length <= caseLimits().witnessTextChars, "A witness unresolved_if is missing or oversized.");
	need(plain(raw.budget) && Object.keys(raw.budget).every((key) => key === "source_calls"), "A witness budget needs only source_calls.");
	const sourceCalls = raw.budget.source_calls;
	need(Number.isInteger(sourceCalls) && sourceCalls >= 0 && sourceCalls <= caseLimits().witnessSourceCalls, `A witness source_calls budget is between 0 and ${caseLimits().witnessSourceCalls}.`);
	const toolCalls = allowedInputs.filter((entry) => entry.kind === "tool-call");
	if (["read", "search", "list"].includes(method)) {
		need(toolCalls.length > 0 && toolCalls.every((entry) => entry.tool === method), `A ${method} witness needs only explicitly allowed ${method} calls.`);
		need(sourceCalls > 0, `A ${method} witness needs a positive source_calls budget.`);
	} else {
		need(toolCalls.length === 0 && sourceCalls === 0, `A ${method} witness has no generic project-source tool authority.`);
	}
	if (kind === "specification") {
		const canonical = { version: 1, id: "w1", kind, targetClaims, method, allowedInputs, expectedDiscriminator, unresolvedIf, budget: { sourceCalls }, at };
		return { ...canonical, digest: digest(canonical), usage: { sourceCalls: 0 } };
	}
	need(["source", "trace", "proof"].includes(method), "A main-context direct observation is source, trace, or proof only.");
	const observation = compact(raw.observation);
	need(observation !== "" && observation.length <= caseLimits().witnessTextChars, "A main-context direct observation is missing or oversized.");
	const citations = normalizeWitnessCitationList(raw.citations, "Main witness observation");
	const allowable = new Set(allowedInputs.filter((entry) => entry.kind !== "tool-call").map((entry) => entry.ref));
	need(citations.length > 0 && citations.every((citation) => (citation.kind === "source" || citation.kind === "receipt") && allowable.has(citation.ref)), "A main-context direct observation cites only its explicit frozen-source or retained-receipt inputs.");
	for (const citation of citations) {
		if (citation.kind === "source") {
			const source = caseFile.capsule.sources.find((entry) => entry.id === citation.ref);
			need(source?.role !== "claim" && source?.capture.status === "captured", `Main witness source ${citation.ref} is not direct frozen evidence.`);
		} else need(caseFile.ledger.some((entry) => entry.id === citation.ref && entry.kind === "receipt") && citedReceiptIds(caseFile).has(citation.ref), `Main witness receipt ${citation.ref} is not a sealed retained input.`);
	}
	const assessment = normalizeClaimAssessments(raw.assessment, targetClaims, "Main witness assessment");
	for (const entry of assessment) {
		for (const ref of entry.citations) {
			const citation = citations.find((candidate) => candidate.ref === ref);
			need(citation !== undefined, `Main witness assessment ${entry.claim} cites ${ref}, but that ref is absent from its direct observation.`);
			if (entry.disposition !== "unresolved") need(citation.kind === "source" || citation.kind === "receipt", `Main witness assessment ${entry.claim} needs direct cited evidence for ${entry.disposition}.`);
		}
	}
	const canonical = { version: 1, id: "w1", kind, targetClaims, method, allowedInputs, expectedDiscriminator, unresolvedIf, budget: { sourceCalls }, observation: { text: observation, citations, assessment }, at };
	return { ...canonical, digest: digest(canonical) };
}

function witnessDocketRaw(docket) {
	if (docket.kind === "closure-gap") return { kind: docket.kind, target_claims: docket.targetClaims, closure_gap: docket.closureGap };
	return {
		kind: docket.kind,
		target_claims: docket.targetClaims,
		method: docket.method,
		allowed_inputs: docket.allowedInputs,
		expected_discriminator: docket.expectedDiscriminator,
		unresolved_if: docket.unresolvedIf,
		budget: { source_calls: docket.budget?.sourceCalls },
		...(docket.kind === "main-observation" ? { observation: docket.observation?.text, citations: docket.observation?.citations, assessment: docket.observation?.assessment } : {}),
	};
}

function checkWitnessDocket(caseFile, docket) {
	need(plain(docket), "its main-owned witness docket is invalid");
	const normalized = normalizeWitnessDocket(witnessDocketRaw(docket), caseFile, { at: docket.at });
	const usage = docket.kind === "specification" ? docket.usage : undefined;
	if (usage !== undefined) need(plain(usage) && Object.keys(usage).every((key) => key === "sourceCalls") && Number.isInteger(usage.sourceCalls) && usage.sourceCalls >= 0 && usage.sourceCalls <= docket.budget.sourceCalls, "its witness source-call usage is invalid");
	need(sameJson({ ...normalized, ...(usage === undefined ? {} : { usage }) }, docket), "its main-owned witness docket is non-canonical");
	return docket;
}

const witnessAllowsSource = (docket, ref) => docket?.allowedInputs?.some((input) => input.kind === "source" && input.ref === ref) === true;
const witnessAllowsCarriedReceipt = (docket, ref) => docket?.allowedInputs?.some((input) => input.kind === "receipt" && input.ref === ref) === true;
function witnessAllowsToolReceipt(docket, receipt) {
	try {
		const input = normalizeWitnessToolInput(receipt.tool, receipt.input, 0);
		return docket?.allowedInputs?.some((entry) => entry.kind === "tool-call" && entry.tool === receipt.tool && sameJson(entry.input, input)) === true;
	} catch {
		return false;
	}
}

function flowShape(caseFile) {
	if (caseFile.flow === undefined) return undefined;
	need(plain(caseFile.flow) && caseFile.flow.version === CASE_FLOW_VERSION, "its case flow version is invalid");
	need(FLOW_STATES.has(caseFile.flow.state), "its case flow state is invalid");
	const allowed = new Set(["version", "state", "blind", "crossPacket", "witness"]);
	for (const key of Object.keys(caseFile.flow)) need(allowed.has(key), `its case flow has unsupported field ${key}`);
	return caseFile.flow;
}

const terminalPhase = (phase) => ["complete", "ended", "stopped"].includes(phase?.status);

function checkPacketMeta(caseFile, packet) {
	need(plain(packet), "its controlled cross-examination packet is invalid");
	const allowed = new Set(["version", "constructDigest", "blindDigest", "claims", "textDigest", "preparedAt", "delivery"]);
	for (const key of Object.keys(packet)) need(allowed.has(key), `its controlled cross-examination packet has unsupported field ${key}`);
	need(packet.version === 1 && typeof packet.constructDigest === "string" && HEX.test(packet.constructDigest) && typeof packet.blindDigest === "string" && HEX.test(packet.blindDigest) && typeof packet.textDigest === "string" && HEX.test(packet.textDigest) && finite(packet.preparedAt), "its controlled cross-examination packet metadata is invalid");
	const construct = phaseOf(caseFile, "construct");
	const blind = phaseOf(caseFile, "falsify-blind");
	need(construct.artifact?.digest === packet.constructDigest, "its controlled cross-examination packet no longer matches the constructor artifact");
	need(blind.artifact?.digest === packet.blindDigest, "its controlled cross-examination packet no longer matches the blind artifact");
	const claims = materialConstructorClaims(caseFile);
	need(sameJson(packet.claims, claims), "its controlled cross-examination material claims are non-canonical");
	need(packet.textDigest === digest(renderCrossExaminationPacket(caseFile)), "its controlled cross-examination packet digest does not match");
	if (packet.delivery === undefined) return;
	need(plain(packet.delivery), "its controlled cross-examination packet delivery is invalid");
	need(Object.keys(packet.delivery).every((key) => ["at", "conversationId", "entryId"].includes(key)), "its controlled cross-examination packet delivery has unsupported fields");
	need(finite(packet.delivery.at) && typeof packet.delivery.conversationId === "string" && packet.delivery.conversationId !== "" && typeof packet.delivery.entryId === "string" && packet.delivery.entryId !== "", "its controlled cross-examination packet delivery is invalid");
	need(blind.conversationId === packet.delivery.conversationId, "its controlled cross-examination packet was not delivered to the blind falsifier context");
}

function checkCaseFlow(caseFile) {
	const flow = flowShape(caseFile);
	if (flow === undefined) return undefined;
	const construct = phaseOf(caseFile, "construct");
	const blind = phaseOf(caseFile, "falsify-blind");
	const cross = phaseOf(caseFile, "falsify-cross-exam");
	const witness = phaseOf(caseFile, "witness");
	if (caseFile.status === "stopped") return flow;
	if (flow.state === "construct") {
		need(["queued", "active"].includes(construct.status) && blind.status === "queued" && cross.status === "queued" && witness.status === "queued", "its construct flow transition is invalid");
		need(flow.blind === undefined && flow.crossPacket === undefined && flow.witness === undefined, "its construct flow has future-pass data");
		return flow;
	}
	need(terminalPhase(construct), "its case flow advanced before construction ended");
	if (flow.state === "falsify-blind") {
		need(["queued", "active"].includes(blind.status) && cross.status === "queued" && witness.status === "queued", "its blind falsification flow transition is invalid");
		need(flow.blind === undefined && flow.crossPacket === undefined && flow.witness === undefined, "its blind falsification flow has cross-examination data before sealing");
		return flow;
	}
	need(terminalPhase(blind), "its case flow advanced before blind falsification ended");
	need(plain(flow.blind) && Object.keys(flow.blind).every((key) => ["phase", "digest", "sealedAt"].includes(key)) && flow.blind.phase === "falsify-blind" && flow.blind.digest === blind.artifact?.digest && typeof flow.blind.digest === "string" && HEX.test(flow.blind.digest) && finite(flow.blind.sealedAt), "its blind falsification seal is invalid");
	checkPacketMeta(caseFile, flow.crossPacket);
	if (flow.state === "falsify-cross-exam") {
		need(["queued", "active"].includes(cross.status) && witness.status === "queued", "its controlled cross-examination flow transition is invalid");
		need(flow.witness === undefined, "its controlled cross-examination flow has a premature witness docket.");
		if (cross.status !== "queued") need(flow.crossPacket.delivery !== undefined && cross.conversationId === flow.crossPacket.delivery.conversationId, "its controlled cross-examination began before packet delivery");
		return flow;
	}
	need(terminalPhase(cross), "its case flow advanced before controlled cross-examination ended");
	need(flow.crossPacket.delivery !== undefined && cross.conversationId === flow.crossPacket.delivery.conversationId, "its controlled cross-examination has no durable packet delivery");
	if (flow.state === "awaiting-witness-specification") {
		need(witness.status === "queued" && flow.witness === undefined, "its case awaits one main-owned witness docket with no started witness");
		return flow;
	}
	const docket = checkWitnessDocket(caseFile, flow.witness);
	if (flow.state === "witness") {
		need(docket.kind === "specification" && ["queued", "active"].includes(witness.status), "its witness flow transition is invalid");
		return flow;
	}
	need(flow.state === "ready-for-synthesis", "its case flow has an invalid terminal state.");
	if (docket.kind === "specification") need(terminalPhase(witness), "its ready-for-synthesis flow has an unfinished witness specification.");
	else need(witness.status === "queued", "its direct observation or closure gap must not impersonate a started witness phase.");
	return flow;
}

function witnessAssessmentForReport(caseFile, docket) {
	if (docket.kind === "main-observation") return docket.observation.assessment;
	if (docket.kind !== "specification") return undefined;
	const phase = phaseOf(caseFile, "witness");
	return phase.status === "complete" && phase.artifact?.kind === "structured" ? phase.artifact.data.witnessAssessment : undefined;
}

function expectedWitnessIds(caseFile, docket) {
	if (docket.kind === "closure-gap") return [];
	if (docket.kind === "main-observation") return [docket.id];
	const phase = phaseOf(caseFile, "witness");
	return terminalPhase(phase) ? [docket.id] : [];
}

function flowReportCanonical(caseFile, raw) {
	need(plain(raw), "its durable case-level report is invalid");
	const allowed = new Set(["version", "at", "outcome", "report", "witnesses", "residual", "closureGap", "budgetLimit", "blockingQuestion", "successor", "digest"]);
	for (const key of Object.keys(raw)) need(allowed.has(key), `its durable case-level report has unsupported field ${key}`);
	need(raw.version === 1 && finite(raw.at), "its durable case-level report version or time is invalid");
	const outcome = String(raw.outcome);
	need(REPORT_OUTCOMES.has(outcome), "its durable case-level report outcome is invalid");
	const report = compact(raw.report);
	need(report !== "" && report.length <= caseLimits().synthesisChars, "its durable case-level report text is missing or oversized");
	const witnesses = boundedStrings(raw.witnesses, "Case-level report witnesses", { maxItems: 1, maxChars: 64 });
	const residual = raw.residual === undefined ? undefined : compact(raw.residual);
	const closureGap = raw.closureGap === undefined ? undefined : compact(raw.closureGap);
	const budgetLimit = raw.budgetLimit === undefined ? undefined : compact(raw.budgetLimit);
	need(residual === undefined || (residual !== "" && residual.length <= caseLimits().residualChars), "its case-level residual uncertainty is invalid");
	need(closureGap === undefined || (closureGap !== "" && closureGap.length <= caseLimits().witnessTextChars), "its case-level closure gap is invalid");
	need(budgetLimit === undefined || (budgetLimit !== "" && budgetLimit.length <= caseLimits().witnessTextChars), "its case-level budget limit is invalid");
	const docket = checkWitnessDocket(caseFile, caseFile.flow.witness);
	need(sameJson(witnesses, expectedWitnessIds(caseFile, docket)), "its durable case-level report names the wrong final witness ids");
	if (outcome === "supported" || outcome === "refuted") {
		need(docket.kind !== "closure-gap", `${outcome} cannot be recorded without a witness.`);
		const allClaims = materialClaimIds(caseFile);
		need(sameJson(docket.targetClaims, allClaims), `${outcome} requires one witness docket that targets every material constructor claim.`);
		const assessments = witnessAssessmentForReport(caseFile, docket);
		need(Array.isArray(assessments) && assessments.length === allClaims.length && assessments.every((entry) => entry.disposition !== "unresolved"), `${outcome} requires a completed witness assessment that settles every material constructor claim.`);
		const candidate = assessments.find((entry) => entry.claim === "construct:candidate");
		need(candidate?.disposition === (outcome === "supported" ? "supports" : "refutes"), `${outcome} needs the witness assessment for construct:candidate to ${outcome === "supported" ? "support" : "refute"} it.`);
	}
	if (outcome === "unresolved") need(residual !== undefined || closureGap !== undefined || budgetLimit !== undefined || docket.kind === "closure-gap", "An unresolved case-level report needs residual uncertainty, a closure gap, or a budget limit.");
	const blockingQuestion = raw.blockingQuestion === undefined ? undefined : compact(raw.blockingQuestion);
	let successor;
	if (outcome === "needs_user_input") {
		need(blockingQuestion !== undefined && blockingQuestion !== "" && blockingQuestion.length <= caseLimits().witnessTextChars, "A needs_user_input report needs one exact blocking question.");
		need(plain(raw.successor) && Object.keys(raw.successor).every((key) => ["predecessor", "question", "boundary"].includes(key)), "A needs_user_input report needs one successor-capsule boundary.");
		const question = compact(raw.successor.question);
		const boundary = compact(raw.successor.boundary);
		need(raw.successor.predecessor === caseFile.id && question === blockingQuestion && boundary !== "" && boundary.length <= caseLimits().witnessTextChars, "A needs_user_input successor must link this case, its exact question, and a bounded new-capsule boundary.");
		successor = { predecessor: caseFile.id, question, boundary };
	} else need(blockingQuestion === undefined && raw.successor === undefined, "Only a needs_user_input report carries a blocking question and successor boundary.");
	const canonical = { version: 1, at: raw.at, outcome, report, witnesses, ...(residual === undefined ? {} : { residual }), ...(closureGap === undefined ? {} : { closureGap }), ...(budgetLimit === undefined ? {} : { budgetLimit }), ...(blockingQuestion === undefined ? {} : { blockingQuestion }), ...(successor === undefined ? {} : { successor }) };
	need(typeof raw.digest === "string" && HEX.test(raw.digest) && raw.digest === digest(canonical), "its durable case-level report digest does not match");
	return { ...canonical, digest: raw.digest };
}

function checkFlowReport(caseFile) {
	if (!usesCaseFlow(caseFile)) return;
	if (caseFile.status === "synthesized" || caseFile.status === "needs-user-input") {
		const report = flowReportCanonical(caseFile, caseFile.synthesis);
		need((caseFile.status === "needs-user-input") === (report.outcome === "needs_user_input"), "its durable case-level report outcome does not match the case status");
		need(sameJson(report, caseFile.synthesis), "its durable case-level report is non-canonical");
	} else need(caseFile.synthesis === undefined, "its running or ready flow case has a premature case-level report");
}

function normalizeV2(caseFile) {
	baseCheck(caseFile);
	need(caseFile.version === CASE_VERSION, `its version ${JSON.stringify(caseFile.version)} is not supported`);
	const flow = flowShape(caseFile);
	need(flow !== undefined || caseFile.status !== "needs-user-input", "only a flow-enabled v2 case may carry needs-user-input status");
	phaseTemplateCheck(caseFile, flow === undefined ? CASE_PHASES : CASE_FLOW_PHASES);
	need(typeof caseFile.claim === "string" && compact(caseFile.claim) !== "", "it has no frozen claim");
	need(finite(caseFile.createdAt) && finite(caseFile.updatedAt), "it has invalid case times");
	const capsule = caseFile.capsule;
	need(capsule.version === CASE_VERSION, "its capsule version is invalid");
	need(capsule.question === caseFile.question && capsule.claim === caseFile.claim, "its frozen question or claim no longer matches the case header");
	need(typeof capsule.context === "string" && capsule.context.length <= caseLimits().contextChars, "its frozen context is invalid");
	need(plain(capsule.resolution), "its frozen resolution is invalid");
	const criteria = boundedStrings(capsule.resolution.criteria, "Resolution criteria", { maxItems: caseLimits().criteria, maxChars: caseLimits().ledgerTextChars, allowEmpty: false });
	const constraints = boundedStrings(capsule.resolution.constraints, "Resolution constraints", { maxItems: caseLimits().constraints, maxChars: caseLimits().ledgerTextChars });
	const nonGoals = boundedStrings(capsule.resolution.nonGoals, "Resolution non-goals", { maxItems: caseLimits().constraints, maxChars: caseLimits().ledgerTextChars });
	need(sameJson(capsule.resolution, { criteria, constraints, nonGoals }), "its frozen resolution is non-canonical");
	const sources = validateSources(capsule.sources, caseFile.createdAt);
	need(sameJson(sources, capsule.sources), "its frozen source entries are non-canonical");
	need(Array.isArray(capsule.ledger) && capsule.ledger.length <= caseLimits().ledgerEntries, "its frozen evidence ledger is invalid");
	const initialLedger = capsule.ledger.map((entry, index) => normalizeLedgerEntry(entry, { index, sources, at: caseFile.createdAt, initial: true }));
	need(new Set(initialLedger.map((entry) => entry.id)).size === initialLedger.length, "its frozen evidence ledger repeats an id.");
	need(sameJson(initialLedger, capsule.ledger), "its frozen evidence ledger is non-canonical");
	const digestInput = { version: CASE_VERSION, question: capsule.question, claim: capsule.claim, context: capsule.context, resolution: capsule.resolution, sources: capsule.sources, ledger: capsule.ledger, capturedAt: capsule.capturedAt };
	need(jsonChars(capsule, "The frozen capsule") <= caseLimits().capsuleChars, `its frozen capsule exceeds the ${caseLimits().capsuleChars.toLocaleString("en-US")} character storage bound.`);
	need(finite(capsule.capturedAt) && typeof capsule.digest === "string" && capsule.digest === digest(digestInput), "its frozen capsule digest does not match");
	need(Array.isArray(caseFile.ledger) && caseFile.ledger.length <= caseLimits().ledgerEntries, "its case evidence ledger is invalid");
	const ledger = caseFile.ledger.map((entry, index) => normalizeLedgerEntry(entry, { index, sources, phases: phaseDefinitions(caseFile), at: caseFile.createdAt }));
	need(new Set(ledger.map((entry) => entry.id)).size === ledger.length, "its case evidence ledger repeats an id.");
	need(sameJson(ledger, caseFile.ledger), "its case evidence ledger is non-canonical");
	need(ledger.length >= initialLedger.length && sameJson(ledger.slice(0, initialLedger.length), initialLedger), "its appended evidence ledger changed the frozen capsule ledger.");
	const receiptCount = ledger.filter((entry) => entry.kind === "receipt").length;
	need(receiptCount <= caseLimits().receipts, "its case receipt limit is exceeded.");
	need(receiptOutputChars(ledger) <= caseLimits().receiptTotalChars, `its retained receipt output exceeds the ${caseLimits().receiptTotalChars.toLocaleString("en-US")} character storage bound.`);
	need(Number.isInteger(caseFile.nextLedger) && caseFile.nextLedger === nextLedgerNumber(ledger), "its next evidence ledger id is invalid.");
	for (const phase of caseFile.phases) checkStoredArtifact(caseFile, phase);
	checkCaseFlow(caseFile);
	checkFlowReport(caseFile);
	return caseFile;
}

/** Normalize only harmless omissions from v1; malformed files stay unreadable. */
function normalize(caseFile) {
	if (caseFile?.version === CASE_VERSION) return normalizeV2(caseFile);
	if (caseFile?.version === 1 || caseFile?.version === undefined) return normalizeV1(caseFile);
	throw new CaseError(`its version ${JSON.stringify(caseFile?.version)} is not supported`);
}

/** Read one case without inventing a state for an unreadable file. */
export function loadCase(brainDir, id) {
	let path;
	try {
		path = casePath(brainDir, id);
	} catch (error) {
		return { error: error.message };
	}
	if (!existsSync(path)) return { error: `No case stands under ${id}.` };
	try {
		return { case: normalize(JSON.parse(readFileSync(path, "utf8"))) };
	} catch (error) {
		return { error: `Case ${id} cannot be read: ${error.message}.` };
	}
}

/** Every readable case, newest first. Bad files are listed as errors rather than silently skipped. */
export function listCases(brainDir) {
	let names = [];
	try { names = readdirSync(casesDir(brainDir)).filter((name) => /^c\d+\.json$/.test(name)); } catch { return []; }
	const all = names.map((name) => {
		const id = name.slice(0, -5);
		const loaded = loadCase(brainDir, id);
		return loaded.case === undefined ? { id, error: loaded.error } : loaded.case;
	});
	return all.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
}

/** Persist one already-normalized case. A v1 case stays v1; it is never silently migrated. */
export function saveCase(brainDir, value) {
	const next = normalize(copy(value));
	mkdirSync(casesDir(brainDir), { recursive: true });
	atomicWrite(casePath(brainDir, next.id), next);
	return next;
}

/** Change one durable case atomically as far as this process is concerned. */
export function updateCase(brainDir, id, change) {
	const loaded = loadCase(brainDir, id);
	if (loaded.case === undefined) throw new CaseError(loaded.error);
	const result = change(loaded.case);
	loaded.case.updatedAt = Date.now();
	saveCase(brainDir, loaded.case);
	return result;
}

function evidenceSource(entry, index, at) {
	need(plain(entry), `Selected evidence ${index + 1} is invalid.`);
	const content = entry.item?.snapshot;
	need(typeof content === "string", `Selected evidence ${index + 1} has no frozen snapshot.`);
	const actual = digest(content);
	if (entry.digest !== undefined) need(entry.digest === actual, `Selected evidence ${index + 1} digest does not match its frozen snapshot.`);
	const locator = entry.source?.ref !== undefined ? { ref: copy(entry.source.ref) } : copy(entry.source ?? { placement: entry.placement });
	return {
		id: `s${index + 1}`,
		role: entry.role ?? "primary",
		label: compact(entry.label ?? entry.placement ?? `selected source ${index + 1}`),
		capture: {
			status: "captured",
			origin: { kind: "shelf-placement", placement: String(entry.placement ?? `shelf-${index + 1}`), label: compact(entry.label ?? entry.placement ?? `selected source ${index + 1}`) },
			locator,
			digest: actual,
			at,
			freshness: String(entry.freshness ?? "unknown"),
		},
		content,
		...(entry.role === "claim" ? { claim: compact(entry.claim ?? entry.label ?? `Claim in selected source ${index + 1}`) } : {}),
	};
}

/** Mint a v2 case and its frozen, digested capsule. The caller has already snapshotted shelf evidence. */
export function createCase(brainDir, { question, claim, context = "", evidence = [], sources, criteria, constraints = [], nonGoals = [], ledger, at = Date.now() } = {}) {
	need(finite(at), "A case needs a finite capture time.");
	const cleanQuestion = compact(question);
	need(cleanQuestion !== "", "A case needs one narrow refutable question.");
	need(cleanQuestion.length <= caseLimits().questionChars, `The question exceeds the ${caseLimits().questionChars.toLocaleString("en-US")} character case limit.`);
	const cleanClaim = compact(claim ?? cleanQuestion);
	need(cleanClaim !== "" && cleanClaim.length <= caseLimits().questionChars, "The case claim is missing or oversized.");
	const cleanContext = String(context ?? "").trim();
	need(cleanContext.length <= caseLimits().contextChars, `The evidence context exceeds the ${caseLimits().contextChars.toLocaleString("en-US")} character case limit.`);
	need(Array.isArray(evidence) && evidence.length <= caseLimits().evidenceItems, `A case carries at most ${caseLimits().evidenceItems} selected shelf placements.`);
	const evidenceChars = evidence.reduce((sum, entry) => sum + String(entry?.item?.snapshot ?? "").length, 0);
	need(evidenceChars <= caseLimits().evidenceChars, `The frozen shelf evidence exceeds the ${caseLimits().evidenceChars.toLocaleString("en-US")} character case limit.`);
	const rawSources = sources === undefined ? evidence.map((entry, index) => evidenceSource(entry, index, at)) : sources;
	const frozenSources = validateSources(rawSources, at);
	const resolution = {
		criteria: criteria === undefined ? ["The conclusion must remain bounded to cited frozen sources or immutable phase-local receipts, and name unresolved material uncertainty."] : boundedStrings(criteria, "Resolution criteria", { maxItems: caseLimits().criteria, maxChars: caseLimits().ledgerTextChars, allowEmpty: false }),
		constraints: boundedStrings(constraints, "Resolution constraints", { maxItems: caseLimits().constraints, maxChars: caseLimits().ledgerTextChars }),
		nonGoals: boundedStrings(nonGoals, "Resolution non-goals", { maxItems: caseLimits().constraints, maxChars: caseLimits().ledgerTextChars }),
	};
	const initialLedger = normalizeInitialLedger(ledger, frozenSources, at);
	need(initialLedger.length <= caseLimits().ledgerEntries, `The initial evidence ledger exceeds ${caseLimits().ledgerEntries} entries.`);
	mkdirSync(casesDir(brainDir), { recursive: true });
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = nextCaseId(casesDir(brainDir));
		const capsuleBase = { version: CASE_VERSION, question: cleanQuestion, claim: cleanClaim, context: cleanContext, resolution, sources: frozenSources, ledger: initialLedger, capturedAt: at };
		const capsuleDigest = digest(capsuleBase);
		const capsule = { ...capsuleBase, digest: capsuleDigest };
		need(jsonChars(capsule, "The frozen capsule") <= caseLimits().capsuleChars, `The frozen capsule exceeds the ${caseLimits().capsuleChars.toLocaleString("en-US")} character storage bound.`);
		const value = {
			version: CASE_VERSION,
			id,
			createdAt: at,
			updatedAt: at,
			status: "running",
			question: cleanQuestion,
			claim: cleanClaim,
			capsule,
			ledger: copy(initialLedger),
			nextLedger: nextLedgerNumber(initialLedger),
			flow: { version: CASE_FLOW_VERSION, state: "construct" },
			phases: phaseTemplate(CASE_FLOW_PHASES),
			messages: [],
			nextMessage: 1,
		};
		try {
			writeFileSync(casePath(brainDir, id), `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf8", flag: "wx" });
			return value;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
	}
	throw new CaseError("No free case id could be minted.");
}

export function phaseOf(caseFile, id) {
	const phase = caseFile?.phases?.find((entry) => entry.id === id);
	if (phase === undefined) throw new CaseError(`${id} is not a phase of ${caseFile?.id ?? "this case"}.`);
	return phase;
}

/** Move the case into one active phase. Queued participation is attached to that phase's initial capsule. */
export function beginCasePhase(brainDir, id, phaseId, { conversationId, at = Date.now() } = {}) {
	return updateCase(brainDir, id, (caseFile) => {
		if (caseFile.status !== "running") throw new CaseError(`Case ${id} is ${caseFile.status}, not running.`);
		const phase = phaseOf(caseFile, phaseId);
		if (phase.status !== "queued") throw new CaseError(`Case ${id}'s ${phase.name} phase is already ${phase.status}.`);
		if (usesCaseFlow(caseFile)) {
			const wanted = { construct: "construct", "falsify-blind": "falsify-blind", "falsify-cross-exam": "falsify-cross-exam", witness: "witness" }[caseFile.flow.state];
			if (wanted === undefined) throw new CaseError(`Case ${id} is ${caseFile.flow.state}; its next authority belongs to the main context, not a phase.`);
			if (phase.id !== wanted) throw new CaseError(`Case ${id}'s flow is ${caseFile.flow.state}; it cannot start ${phase.id}.`);
			if (phase.id === "falsify-cross-exam") {
				const delivery = caseFile.flow.crossPacket?.delivery;
				if (delivery === undefined) throw new CaseError(`Case ${id}'s controlled cross-examination packet is not durably delivered yet.`);
				if (conversationId === undefined || String(conversationId) !== delivery.conversationId) throw new CaseError(`Case ${id}'s controlled cross-examination must reuse its blind falsifier context.`);
			}
		}
		for (const message of caseFile.messages) {
			if (message.route === "queued" && message.delivery === undefined) {
				message.route = "active";
				message.phase = phase.id;
			}
		}
		phase.status = "active";
		phase.startedAt = at;
		if (conversationId !== undefined) phase.conversationId = String(conversationId);
		return { phase: copy(phase), messages: caseFile.messages.filter((message) => message.phase === phase.id && message.delivery === undefined).map(copy) };
	});
}

/** Add a participant message. Active-phase messages wait for its next result; messages between phases queue for the next one. */
export function noteCaseMessage(brainDir, id, value, { at = Date.now(), phase } = {}) {
	const said = String(value ?? "").trim();
	if (said === "") return { accepted: false, reason: "The message is empty." };
	if (said.length > messageChars()) return { accepted: false, reason: `A case message is at most ${messageChars().toLocaleString("en-US")} characters.` };
	return updateCase(brainDir, id, (caseFile) => {
		if (caseFile.status !== "running") return { accepted: false, reason: `Case ${id} is ${caseFile.status}; it is no longer receiving phase input.` };
		if (caseFile.messages.length >= messageLimit()) return { accepted: false, reason: `Case ${id} already holds ${messageLimit()} participant messages, its fixed provenance limit.` };
		const isolatedWitness = usesCaseFlow(caseFile) && (caseFile.flow.state === "witness" || phase === "witness");
		const current = isolatedWitness ? undefined : typeof phase === "string" ? caseFile.phases.find((entry) => entry.id === phase && entry.status === "active") : undefined;
		const entry = { id: `u${caseFile.nextMessage++}`, at, text: said, route: current === undefined ? "queued" : "active", ...(current === undefined ? {} : { phase: current.id }), ...(isolatedWitness ? { unreadBy: "witness", afterCase: true } : {}) };
		caseFile.messages.push(entry);
		return { accepted: true, entry: copy(entry) };
	});
}

/** Mark exact participant records as included in a phase request or result. */
export function markCaseMessagesDelivered(brainDir, id, messageIds, phaseId, { at = Date.now(), via = "result" } = {}) {
	const ids = new Set(Array.isArray(messageIds) ? messageIds.map(String) : []);
	if (ids.size === 0) return [];
	return updateCase(brainDir, id, (caseFile) => {
		const phase = phaseOf(caseFile, phaseId);
		const delivered = [];
		for (const message of caseFile.messages) {
			if (!ids.has(message.id) || message.delivery !== undefined) continue;
			message.delivery = { phase: phase.id, at, via };
			delivered.push(message.id);
		}
		return delivered;
	});
}

/** Record one immutable source-tool receipt outside the frozen capsule. Only a v2 case can cite it directly. */
export function appendCaseReceipt(brainDir, id, phaseId, { tool, arguments: args = {}, output, at = Date.now() } = {}) {
	need(finite(at), "A phase receipt needs a finite capture time.");
	const sourceTool = compact(tool);
	need(RECEIPT_TOOLS.has(sourceTool), "A phase receipt needs read, search, or list as its source tool.");
	const input = jsonCopy(args ?? {}, "A phase receipt input", caseLimits().sourceMetadataChars);
	need(plain(input), "A phase receipt input must be an object.");
	return updateCase(brainDir, id, (caseFile) => {
		if (caseFile.version !== CASE_VERSION) return undefined;
		const phase = phaseOf(caseFile, phaseId);
		if (phase.status !== "active" || caseFile.status !== "running") return undefined;
		// The harness normally refuses this before the source tool reads. Keep receipt persistence equally strict so a
		// manually invoked or replayed append cannot later turn an undeclared witness read into durable direct evidence.
		if (usesCaseFlow(caseFile) && phase.id === "witness") {
			const docket = caseFile.flow.witness;
			if (docket?.kind !== "specification" || !witnessAllowsToolReceipt(docket, { tool: sourceTool, input })) return undefined;
		}
		if (caseFile.ledger.length >= caseLimits().ledgerEntries) return undefined;
		const appendGap = (text) => {
			const gap = { id: `l${caseFile.nextLedger}`, kind: "source-gap", text, citations: [], at };
			need(!caseFile.ledger.some((entry) => entry.id === gap.id), `Case ${caseFile.id} already has evidence ledger entry ${gap.id}.`);
			caseFile.nextLedger += 1;
			caseFile.ledger.push(gap);
			return copy(gap);
		};
		const shown = String(output ?? "");
		if (shown.length > caseLimits().receiptChars) return appendGap(`${sourceTool} output exceeded the immutable receipt bound; it cannot be cited as direct observation.`);
		if (caseFile.ledger.filter((entry) => entry.kind === "receipt").length >= caseLimits().receipts) return appendGap(`The immutable source receipt count is exhausted; this ${sourceTool} result cannot be cited as direct observation.`);
		if (receiptOutputChars(caseFile.ledger) + shown.length > caseLimits().receiptTotalChars) return appendGap(`${sourceTool} output would exceed the immutable receipt storage bound; it cannot be cited as direct observation.`);
		const inputDigest = digest(input);
		const outputDigest = digest(shown);
		const canonical = { phase: phase.id, tool: sourceTool, input, inputDigest, output: shown, outputDigest, at };
		const receipt = { id: `r${caseFile.nextLedger}`, kind: "receipt", ...canonical, digest: digest(canonical) };
		need(!caseFile.ledger.some((entry) => entry.id === receipt.id), `Case ${caseFile.id} already has evidence ledger entry ${receipt.id}.`);
		caseFile.nextLedger += 1;
		caseFile.ledger.push(receipt);
		return copy(receipt);
	});
}

/** Append a non-receipt ledger fact without ever altering the frozen capsule. */
export function appendCaseLedgerEntry(brainDir, id, entry, { at = Date.now() } = {}) {
	return updateCase(brainDir, id, (caseFile) => {
		if (caseFile.version !== CASE_VERSION) throw new CaseError("Only a v2 case has an append-only evidence ledger.");
		need(caseFile.ledger.length < caseLimits().ledgerEntries, `Case ${id}'s evidence ledger reached its ${caseLimits().ledgerEntries} entry bound.`);
		const entryId = entry?.id ?? `l${caseFile.nextLedger}`;
		need(!caseFile.ledger.some((prior) => prior.id === entryId), `Case ${caseFile.id} already has evidence ledger entry ${entryId}.`);
		const value = normalizeLedgerEntry({ ...entry, id: entryId, at: entry?.at ?? at }, { sources: caseFile.capsule.sources, at });
		need(value.kind !== "receipt", "Use appendCaseReceipt for immutable phase-local receipts.");
		const serial = Number(/^l(\d+)$/.exec(value.id)?.[1] ?? 0);
		caseFile.nextLedger = Math.max(caseFile.nextLedger, serial + 1);
		caseFile.ledger.push(value);
		return copy(value);
	});
}

/** Validate a case phase's structured artifact against its frozen sources and append-only receipts. */
export function validateCaseArtifact(caseFile, phaseId, artifact, { done } = {}) {
	need(caseFile?.version === CASE_VERSION, "Structured artifacts belong to v2 cases.");
	const phase = phaseOf(caseFile, phaseId);
	return freezeArtifact(caseFile, phase, artifact, { done, at: 0 }).data;
}

function advanceCaseFlow(caseFile, phase, at) {
	if (!usesCaseFlow(caseFile) || caseFile.status === "stopped" || phase.status === "stopped") return;
	if (phase.id === "construct") {
		caseFile.flow.state = "falsify-blind";
		return;
	}
	if (phase.id === "falsify-blind") {
		need(phase.artifact !== undefined, "A sealed blind phase needs an artifact record.");
		caseFile.flow.state = "falsify-cross-exam";
		caseFile.flow.blind = { phase: "falsify-blind", digest: phase.artifact.digest, sealedAt: at };
		caseFile.flow.crossPacket = packetMeta(caseFile, at);
		return;
	}
	if (phase.id === "falsify-cross-exam") {
		caseFile.flow.state = "awaiting-witness-specification";
		return;
	}
	if (phase.id === "witness") caseFile.flow.state = "ready-for-synthesis";
}

/** Mark the recorded constructor packet as appended to the sealed blind context. The caller must already have a
 * Durable entry receipt; this separate file write is replay-safe by packet digest and entry id. */
export function markCrossExaminationPacketDelivered(brainDir, id, { conversationId, entryId, packetDigest, at = Date.now() } = {}) {
	return updateCase(brainDir, id, (caseFile) => {
		need(usesCaseFlow(caseFile) && caseFile.flow.state === "falsify-cross-exam", `Case ${id} is not awaiting controlled cross-examination packet delivery.`);
		const packet = caseFile.flow.crossPacket;
		need(packet !== undefined && packet.textDigest === packetDigest, `Case ${id}'s controlled cross-examination packet digest does not match.`);
		need(typeof conversationId === "string" && conversationId !== "" && typeof entryId === "string" && entryId !== "" && finite(at), "The controlled cross-examination delivery receipt is invalid.");
		if (packet.delivery !== undefined) {
			need(packet.delivery.conversationId === conversationId && packet.delivery.entryId === entryId, `Case ${id}'s controlled cross-examination packet already has another delivery receipt.`);
			return copy(packet.delivery);
		}
		const blind = phaseOf(caseFile, "falsify-blind");
		need(blind.conversationId === conversationId, `Case ${id}'s controlled cross-examination packet must go to its blind falsifier context.`);
		packet.delivery = { at, conversationId, entryId };
		return copy(packet.delivery);
	});
}

/** The main context alone selects the one witness specification, direct source observation, or closure gap after C2. */
export function recordWitnessDocket(brainDir, id, docket, { at = Date.now() } = {}) {
	return updateCase(brainDir, id, (caseFile) => {
		need(usesCaseFlow(caseFile) && caseFile.flow.state === "awaiting-witness-specification", `Case ${id} is not awaiting one main-owned witness docket.`);
		const value = normalizeWitnessDocket(docket, caseFile, { at });
		caseFile.flow.witness = value;
		caseFile.flow.state = value.kind === "specification" ? "witness" : "ready-for-synthesis";
		// A witness may see only the frozen capsule, sealed artifacts, cited receipts, and this docket. Participant
		// messages stay exact durable provenance for the main context rather than becoming an ambient witness input.
		for (const message of caseFile.messages) {
			if (message.delivery !== undefined) continue;
			delete message.phase;
			message.route = "queued";
			message.unreadBy ??= "witness";
			message.afterCase = true;
		}
		return copy(value);
	});
}

/** Admit one exact source-tool call named by a main-owned witness specification, spending its durable call budget
 * before the tool can inspect project bytes. Non-witness phases retain their existing C1/C2 source behavior. */
export function admitWitnessSourceTool(brainDir, id, phaseId, tool, args, { at = Date.now() } = {}) {
	const loaded = loadCase(brainDir, id);
	if (loaded.case === undefined) throw new CaseError(loaded.error);
	if (!usesCaseFlow(loaded.case) || phaseId !== "witness") return { applicable: false, allowed: true };
	return updateCase(brainDir, id, (caseFile) => {
		const phase = phaseOf(caseFile, phaseId);
		const docket = caseFile.flow.witness;
		if (caseFile.status !== "running" || caseFile.flow.state !== "witness" || phase.status !== "active" || docket?.kind !== "specification") return { applicable: true, allowed: false, reason: `Case ${id}'s witness source authority is no longer active.` };
		let input;
		try { input = normalizeWitnessToolInput(String(tool), args, 0); } catch (error) { return { applicable: true, allowed: false, reason: error.message }; }
		const allowed = docket.allowedInputs.some((entry) => entry.kind === "tool-call" && entry.tool === tool && sameJson(entry.input, input));
		if (!allowed) return { applicable: true, allowed: false, reason: `The ${tool} call is outside case ${id}'s exact main-owned witness docket.` };
		if (docket.usage.sourceCalls >= docket.budget.sourceCalls) return { applicable: true, allowed: false, reason: `Case ${id}'s witness source-call budget of ${docket.budget.sourceCalls} is exhausted.` };
		docket.usage.sourceCalls += 1;
		return { applicable: true, allowed: true, at };
	});
}

/** A phase ended. Messages that had not reached its request stay queued for the next available phase. */
export function finishCasePhase(brainDir, id, phaseId, result, { at = Date.now() } = {}) {
	return updateCase(brainDir, id, (caseFile) => {
		const phase = phaseOf(caseFile, phaseId);
		if (phase.status !== "active") throw new CaseError(`Case ${id}'s ${phase.name} phase is not active.`);
		const stopped = result?.stopped === true || caseFile.status === "stopped";
		const ended = stopped ? "stopped" : result?.returned === true ? "complete" : "ended";
		phase.status = ended;
		phase.endedAt = at;
		if (caseFile.version === CASE_VERSION) {
			phase.artifact = stopped || result?.returned !== true
				? failureArtifact(phase, result?.failure, at)
				: freezeArtifact(caseFile, phase, result?.artifact, { done: result?.done, at });
		} else {
			const report = clip(result?.report ?? result?.failure ?? "", caseLimits().artifactChars);
			phase.artifact = {
				text: report.text,
				chars: report.chars,
				digest: digest(String(result?.report ?? result?.failure ?? "")),
				...(report.clipped ? { clipped: true } : {}),
				...(stopped ? {} : result?.done === true ? { done: true } : result?.returned === true ? { done: false } : {}),
				...(typeof result?.summary === "string" && result.summary.trim() !== "" ? { summary: compact(result.summary) } : {}),
				...(typeof result?.failure === "string" && result.failure.trim() !== "" ? { failure: compact(result.failure) } : {}),
			};
		}
		advanceCaseFlow(caseFile, phase, at);
		const next = caseFile.phases.find((entry) => entry.status === "queued");
		for (const message of caseFile.messages) {
			if (message.phase !== phase.id || message.delivery !== undefined) continue;
			delete message.phase;
			message.route = "queued";
			message.unreadBy = phase.id;
			if (next === undefined) message.afterCase = true;
		}
		return copy(phase);
	});
}

/** Make the completed evidence case available to the main context for its explicit conclusion. */
export function readyCase(brainDir, id, { at = Date.now() } = {}) {
	return updateCase(brainDir, id, (caseFile) => {
		if (caseFile.status !== "running") throw new CaseError(`Case ${id} is ${caseFile.status}, not running.`);
		if (usesCaseFlow(caseFile)) {
			if (caseFile.flow.state !== "ready-for-synthesis") throw new CaseError(`Case ${id} is ${caseFile.flow.state}; the main context has not yet recorded a witness specification or documented closure gap.`);
			const docket = checkWitnessDocket(caseFile, caseFile.flow.witness);
			const unfinished = caseFile.phases.some((phase) => phase.status === "active" || (phase.status === "queued" && !(phase.id === "witness" && docket.kind !== "specification")));
			if (unfinished) throw new CaseError(`Case ${id} still has an unfinished phase.`);
		} else if (caseFile.phases.some((phase) => phase.status === "active" || phase.status === "queued")) throw new CaseError(`Case ${id} still has an unfinished phase.`);
		caseFile.status = "ready";
		caseFile.readyAt = at;
		return copy(caseFile);
	});
}

/** Record a stop before its active phase is interrupted; no later phase may start, and the partial record remains inspectable. */
export function stopCase(brainDir, id, { at = Date.now(), why } = {}) {
	return updateCase(brainDir, id, (caseFile) => {
		if (["synthesized", "needs-user-input"].includes(caseFile.status)) throw new CaseError(`Case ${id} already has its durable case-level report.`);
		caseFile.status = "stopped";
		caseFile.stoppedAt = at;
		if (typeof why === "string" && why.trim() !== "") caseFile.stopReason = compact(why);
		for (const phase of caseFile.phases) if (phase.status === "queued") phase.status = "stopped";
		return copy(caseFile);
	});
}

/** The main context's only conclusion/report. It weighs evidence; phase count is never corroboration. */
export function synthesizeCase(brainDir, id, { outcome, report, residual, closureGap, budgetLimit, blockingQuestion, successorBoundary, at = Date.now() }) {
	const written = compact(report);
	if (written === "") throw new CaseError("A synthesis needs a short report that weighs the phase artifacts.");
	if (written.length > caseLimits().synthesisChars) throw new CaseError(`The synthesis report exceeds the ${caseLimits().synthesisChars.toLocaleString("en-US")} character case limit.`);
	const remaining = residual === undefined ? undefined : compact(residual) || undefined;
	const gap = closureGap === undefined ? undefined : compact(closureGap) || undefined;
	const limit = budgetLimit === undefined ? undefined : compact(budgetLimit) || undefined;
	const question = blockingQuestion === undefined ? undefined : compact(blockingQuestion);
	const boundary = successorBoundary === undefined ? undefined : compact(successorBoundary);
	return updateCase(brainDir, id, (caseFile) => {
		if (caseFile.status !== "ready") throw new CaseError(`Case ${id} is ${caseFile.status}; only a ready case can be synthesized.`);
		if (!usesCaseFlow(caseFile)) {
			if (!["supported", "refuted", "unresolved"].includes(outcome)) throw new CaseError("A historical case synthesis outcome is supported, refuted, or unresolved.");
			if (remaining !== undefined && remaining.length > caseLimits().residualChars) throw new CaseError(`The residual uncertainty exceeds the ${caseLimits().residualChars.toLocaleString("en-US")} character case limit.`);
			caseFile.status = "synthesized";
			caseFile.synthesis = { at, outcome, report: written, ...(remaining === undefined ? {} : { residual: remaining }) };
			return copy(caseFile);
		}
		if (!REPORT_OUTCOMES.has(outcome)) throw new CaseError("A case-level report outcome is supported, refuted, unresolved, or needs_user_input.");
		if (caseFile.flow.state !== "ready-for-synthesis") throw new CaseError(`Case ${id} is ${caseFile.flow.state}; it is not ready for the main case-level report.`);
		const docket = checkWitnessDocket(caseFile, caseFile.flow.witness);
		const witnesses = expectedWitnessIds(caseFile, docket);
		const base = { version: 1, at, outcome, report: written, witnesses, ...(remaining === undefined ? {} : { residual: remaining }), ...(gap === undefined ? {} : { closureGap: gap }), ...(limit === undefined ? {} : { budgetLimit: limit }) };
		const canonical = outcome === "needs_user_input"
			? { ...base, blockingQuestion: question, successor: { predecessor: caseFile.id, question, boundary } }
			: base;
		// Reuse the stored-record validator before writing, so every live outcome follows the exact same authority proof.
		const checked = flowReportCanonical(caseFile, { ...canonical, digest: digest(canonical) });
		caseFile.status = outcome === "needs_user_input" ? "needs-user-input" : "synthesized";
		caseFile.synthesis = checked;
		return copy(caseFile);
	});
}

function renderCapsuleV1(caseFile) {
	const lines = ["Evidence capsule", "", "Question", `  ${caseFile.question}`];
	const context = String(caseFile.capsule?.context ?? "").trim();
	if (context !== "") lines.push("", "Context supplied by the main agent", context);
	const evidence = Array.isArray(caseFile.capsule?.evidence) ? caseFile.capsule.evidence : [];
	if (evidence.length > 0) {
		lines.push("", "Frozen shelf evidence");
		for (const entry of evidence) {
			const source = entry.source?.ref !== undefined ? `${entry.source.ref.type}:${entry.source.ref.id}` : entry.source?.path ?? entry.label ?? "selected source";
			lines.push(`  ${entry.placement ?? "evidence"} · ${entry.label ?? source} · source ${source} · sha256 ${entry.digest ?? "unrecorded"}`);
			lines.push(String(entry.item?.snapshot ?? "").split("\n").map((line) => `    ${line}`).join("\n"));
		}
	}
	lines.push("", `Capsule digest: ${caseFile.capsule?.digest ?? digest(JSON.stringify(caseFile.capsule ?? {}))}.`);
	return lines.join("\n");
}

function renderCapsuleV2(caseFile) {
	const capsule = caseFile.capsule;
	const lines = ["Evidence capsule v2", "", "Question", `  ${caseFile.question}`, "", "Claim", `  ${caseFile.claim}`];
	if (capsule.context !== "") lines.push("", "Context supplied by the main context", capsule.context);
	lines.push("", "Resolution criteria", ...capsule.resolution.criteria.map((entry) => `  ${entry}`));
	lines.push("", "Constraints", ...(capsule.resolution.constraints.length === 0 ? ["  (none)"] : capsule.resolution.constraints.map((entry) => `  ${entry}`)));
	lines.push("", "Non-goals", ...(capsule.resolution.nonGoals.length === 0 ? ["  (none)"] : capsule.resolution.nonGoals.map((entry) => `  ${entry}`)));
	lines.push("", "Frozen sources");
	if (capsule.sources.length === 0) lines.push("  (none)");
	for (const source of capsule.sources) {
		const capture = source.capture;
		lines.push(`  ${source.id} · ${source.role} · ${capture.status} · ${capture.freshness} at capture · ${sourceLabel(source)} · origin ${capture.origin.kind} · locator ${sourceLocator(source)} · sha256 ${capture.digest ?? "unavailable"}`);
		if (source.content !== undefined) lines.push(source.content.split("\n").map((line) => `    ${line}`).join("\n"));
	}
	lines.push("", "Frozen evidence ledger");
	if (capsule.ledger.length === 0) lines.push("  (none)");
	for (const entry of capsule.ledger) lines.push(`  ${entry.id} · ${entry.kind} · ${entry.text}${entry.citations.length === 0 ? "" : ` · cites ${entry.citations.join(", ")}`}`);
	lines.push("", `Capsule digest: ${capsule.digest}.`);
	return lines.join("\n");
}

/** The stable evidence handoff, in text for a phase or the main context. */
export function renderCapsule(caseFile) {
	return caseFile.version === CASE_VERSION ? renderCapsuleV2(caseFile) : renderCapsuleV1(caseFile);
}

function phaseArtifactV1(caseFile, id) {
	const phase = caseFile.phases.find((entry) => entry.id === id);
	if (phase?.artifact === undefined) return `${phase?.name ?? id}: no returned artifact.`;
	const meta = [phase.artifact.done === true ? "returned done" : phase.artifact.done === false ? "returned not done" : phase.status, phase.artifact.clipped ? `stored first ${phase.artifact.text.length.toLocaleString("en-US")} of ${phase.artifact.chars.toLocaleString("en-US")} characters` : `${phase.artifact.chars.toLocaleString("en-US")} characters`, `sha256 ${phase.artifact.digest}`].join(" · ");
	return `${phase.name} (${meta})\n${phase.artifact.text}`;
}

function phaseArtifactV2(caseFile, id) {
	const phase = caseFile.phases.find((entry) => entry.id === id);
	if (phase?.artifact === undefined) return `${phase?.name ?? id}: no returned artifact.`;
	const artifact = phase.artifact;
	const meta = [artifact.kind === "structured" ? (artifact.done ? "returned done" : "returned not done") : "no structured return", `${artifact.chars.toLocaleString("en-US")} characters`, `sha256 ${artifact.digest}`].join(" · ");
	return `${phase.name} (${meta})\n${artifact.rendering}`;
}

const phaseArtifact = (caseFile, id) => caseFile.version === CASE_VERSION ? phaseArtifactV2(caseFile, id) : phaseArtifactV1(caseFile, id);

function citedReceiptIds(caseFile) {
	const ids = new Set();
	for (const phase of caseFile.phases) {
		if (phase.artifact?.kind !== "structured") continue;
		for (const citation of phase.artifact.data.citations) if (citation.kind === "receipt") ids.add(citation.ref);
	}
	return ids;
}

function renderAppendedLedgerEntry(entry, { includeOutput = false } = {}) {
	if (entry.kind !== "receipt") return `${entry.id} · ${entry.kind} · ${entry.text}`;
	const head = `${entry.id} · receipt · ${entry.phase} ${entry.tool} ${JSON.stringify(entry.input)} · input sha256 ${entry.inputDigest} · output sha256 ${entry.outputDigest} · receipt sha256 ${entry.digest}`;
	return includeOutput ? `${head}\n${entry.output.split("\n").map((line) => `  ${line}`).join("\n")}` : head;
}

/** The main-owned witness docket, including the only source-tool calls a C3 witness may make. */
export function renderWitnessDocket(caseFile) {
	need(usesCaseFlow(caseFile) && caseFile.flow.witness !== undefined, "This case has no recorded main-owned witness docket.");
	const docket = checkWitnessDocket(caseFile, caseFile.flow.witness);
	const lines = ["Main-owned witness docket", `  ${docket.id} · ${docket.kind} · sha256 ${docket.digest}`, `  Target claims: ${docket.targetClaims.length === 0 ? "(none)" : docket.targetClaims.join(", ")}`];
	if (docket.kind === "closure-gap") {
		lines.push("", "Documented closure gap", `  ${docket.closureGap}`);
		return lines.join("\n");
	}
	lines.push("", `Method: ${docket.method}.`, "Allowed inputs");
	for (const input of docket.allowedInputs) {
		if (input.kind === "tool-call") lines.push(`  ${input.tool} ${JSON.stringify(input.input)}`);
		else lines.push(`  ${input.kind} ${input.ref}`);
	}
	lines.push("", "Expected discriminator", `  ${docket.expectedDiscriminator}`, "", "Still unresolved if", `  ${docket.unresolvedIf}`, "", `Budget: ${docket.usage === undefined ? 0 : docket.usage.sourceCalls}/${docket.budget.sourceCalls} admitted source calls.`);
	if (docket.kind === "main-observation") {
		lines.push("", "Main-context direct observation", `  ${docket.observation.text} · cites ${docket.observation.citations.map((citation) => citation.ref).join(", ")}`, "", "Assessment");
		for (const assessment of docket.observation.assessment) lines.push(`  ${assessment.claim} · ${assessment.disposition} · ${assessment.text} · cites ${assessment.citations.join(", ")}`);
	}
	return lines.join("\n");
}

/** The intentionally small evidence packet a witness sees: no parent conversation, participant lines, or generic project access. */
export function renderWitnessInputs(caseFile) {
	need(usesCaseFlow(caseFile) && caseFile.flow.witness !== undefined, "This case has no recorded witness inputs.");
	const lines = ["Sealed earlier artifacts"];
	for (const definition of CASE_FLOW_PHASES.filter((phase) => phase.id !== "witness")) lines.push(phaseArtifact(caseFile, definition.id), "");
	if (lines.at(-1) === "") lines.pop();
	const ids = receiptIdsCitedBeforePhase(caseFile, phaseOf(caseFile, "witness"));
	const receipts = caseFile.ledger.filter((entry) => entry.kind === "receipt" && ids.has(entry.id));
	lines.push("", "Cited immutable receipts");
	if (receipts.length === 0) lines.push("  (none)");
	else for (const receipt of receipts) lines.push(renderAppendedLedgerEntry(receipt, { includeOutput: true }));
	return lines.join("\n");
}

/** What the main context receives when it must make the only conclusion. */
export function renderCaseForSynthesis(caseFile) {
	const flow = usesCaseFlow(caseFile);
	const lines = [
		flow
			? `Case ${caseFile.id} is ready for my case-level report. These are bounded artifacts from the same model in deliberately different contexts, not independent agents, votes, or corroboration. I weigh evidence rather than phase agreement. Supported or refuted needs the named witness to settle every material claim; otherwise I record unresolved or needs_user_input.`
			: `Case ${caseFile.id} is ready for my synthesis. These are bounded artifacts from the same model in deliberately different contexts, not independent agents, votes, or corroboration. I weigh the evidence and label the result supported, refuted, or unresolved; agreement does not make a claim true.`,
		"",
		renderCapsule(caseFile),
		"",
		"Phase artifacts",
	];
	for (const phase of phaseDefinitions(caseFile)) lines.push(phaseArtifact(caseFile, phase.id), "");
	if (lines.at(-1) === "") lines.pop();
	if (flow && caseFile.flow.witness !== undefined) lines.push("", renderWitnessDocket(caseFile));
	if (caseFile.version === CASE_VERSION) {
		const added = caseFile.ledger.slice(caseFile.capsule.ledger.length);
		const cited = citedReceiptIds(caseFile);
		lines.push("", "Append-only evidence ledger", added.length === 0 ? "No phase-local source receipts or ledger facts were retained." : added.map((entry) => renderAppendedLedgerEntry(entry, { includeOutput: cited.has(entry.id) })).join("\n"));
	}
	const participation = caseFile.messages.length === 0 ? "No participant messages arrived while the case ran." : caseFile.messages.map((message) => `[${message.id} · ${stamp(message.at)} · ${message.delivery === undefined ? message.afterCase ? "held outside witness inputs for the main context" : "not delivered before the case ended" : `offered to ${message.delivery.phase} by ${message.delivery.via}`}] ${message.text}`).join("\n");
	const next = flow
		? `I now call \`case\` with action \`synthesize\`, id \`${caseFile.id}\`, one outcome, and one concise evidence report. For unresolved I name residual uncertainty, a closure gap, or a budget limit. For needs_user_input I include the exact blocking_question and successor_boundary. I do not treat agreement as corroboration.`
		: `I now call \`case\` with action \`synthesize\`, id \`${caseFile.id}\`, one outcome, a concise evidence-weighting report, and any residual uncertainty.`;
	lines.push("", "Participant provenance", participation, "", next);
	return lines.join("\n");
}

/** Compact user-facing state for /case and the state block. */
export function caseStatusLine(caseFile) {
	const active = caseFile.phases?.find((phase) => phase.status === "active");
	const waiting = caseFile.messages?.filter((message) => message.delivery === undefined).length ?? 0;
	const synthesis = caseFile.synthesis?.outcome;
	const flow = usesCaseFlow(caseFile) ? ` · ${caseFile.flow.state}` : "";
	return `${caseFile.id} · ${caseFile.status}${flow}${active === undefined ? "" : ` · ${active.name}`}${waiting > 0 ? ` · ${waiting} participant ${waiting === 1 ? "message" : "messages"} queued` : ""}${synthesis === undefined ? "" : ` · ${synthesis}`}`;
}

function renderCaseV1(caseFile) {
	const lines = [`Case ${caseFile.id}`, `Status: ${caseFile.status}.`, `Question: ${caseFile.question}`, `Created: ${stamp(caseFile.createdAt)}.`, "", "Phases"];
	for (const phase of caseFile.phases) {
		const artifact = phase.artifact;
		lines.push(`  ${phase.name}: ${phase.status}${phase.conversationId ? ` · context ${phase.conversationId}` : ""}${artifact?.summary ? ` · ${artifact.summary}` : artifact?.failure ? ` · ${artifact.failure}` : ""}`);
		if (artifact !== undefined) lines.push(`    artifact ${artifact.chars.toLocaleString("en-US")} characters · sha256 ${artifact.digest}${artifact.clipped ? " · clipped in this bounded case file" : ""}`);
	}
	lines.push("", `Participant messages: ${caseFile.messages.length}.`);
	for (const message of caseFile.messages) lines.push(`  ${message.id} · ${stamp(message.at)} · ${message.delivery === undefined ? `${message.route}; not delivered` : `offered to ${message.delivery.phase} by ${message.delivery.via}`} · ${message.text}`);
	if (caseFile.synthesis !== undefined) {
		lines.push("", `Main synthesis: ${caseFile.synthesis.outcome}.`, caseFile.synthesis.report);
		if (caseFile.synthesis.residual) lines.push(`Residual uncertainty: ${caseFile.synthesis.residual}`);
	}
	lines.push("", `Durable file: cases/${caseFile.id}.json.`);
	return lines.join("\n");
}

/** A complete terminal inspection of one case without exposing a hidden scratch surface. */
export function renderCase(caseFile) {
	if (caseFile.version !== CASE_VERSION) return renderCaseV1(caseFile);
	const lines = [`Case ${caseFile.id}`, `Version: ${caseFile.version}.`, `Status: ${caseFile.status}.`, `Question: ${caseFile.question}`, `Claim: ${caseFile.claim}`, `Created: ${stamp(caseFile.createdAt)}.`];
	if (usesCaseFlow(caseFile)) {
		lines.push("", `Information flow: ${caseFile.flow.state}.`);
		if (caseFile.flow.blind !== undefined) lines.push(`Blind pass seal: falsify-blind · sha256 ${caseFile.flow.blind.digest} · ${caseFile.flow.crossPacket?.delivery === undefined ? "constructor packet not yet delivered" : `constructor packet delivered to ${caseFile.flow.crossPacket.delivery.conversationId} as ${caseFile.flow.crossPacket.delivery.entryId}`}.`);
		if (caseFile.flow.state === "awaiting-witness-specification") lines.push("The blind and controlled cross-examination artifacts are retained. The main context must next record exactly one witness specification, source-only direct observation, or documented closure gap; no witness or case-level report has run.");
		if (caseFile.flow.witness !== undefined) lines.push("", renderWitnessDocket(caseFile));
		lines.push("", "Scratch/candidate patch: unavailable in this source-only C3 flow; no case path has live-project change authority.");
	}
	lines.push("", "Capsule sources");
	for (const source of caseFile.capsule.sources) lines.push(`  ${source.id}: ${source.role} · ${source.capture.status} · ${source.capture.freshness} at capture · ${sourceLocator(source)} · sha256 ${source.capture.digest ?? "unavailable"}`);
	if (caseFile.capsule.sources.length === 0) lines.push("  (none)");
	lines.push("", "Phases");
	for (const phase of caseFile.phases) {
		const artifact = phase.artifact;
		lines.push(`  ${phase.name}: ${phase.status}${phase.conversationId ? ` · context ${phase.conversationId}` : ""}${artifact?.kind === "failure" ? ` · ${artifact.failure}` : ""}`);
		if (artifact !== undefined) lines.push(`    ${artifact.kind} artifact ${artifact.chars.toLocaleString("en-US")} characters · sha256 ${artifact.digest}`);
	}
	const added = caseFile.ledger.slice(caseFile.capsule.ledger.length);
	lines.push("", `Evidence ledger: ${caseFile.ledger.length} entries (${added.length} appended after capsule freeze).`);
	for (const entry of added) lines.push(`  ${renderAppendedLedgerEntry(entry)}`);
	lines.push("", `Participant messages: ${caseFile.messages.length}.`);
	for (const message of caseFile.messages) lines.push(`  ${message.id} · ${stamp(message.at)} · ${message.delivery === undefined ? message.afterCase ? `${message.route}; held outside witness inputs for the main context` : `${message.route}; not delivered` : `offered to ${message.delivery.phase} by ${message.delivery.via}`} · ${message.text}`);
	if (caseFile.synthesis !== undefined) {
		const heading = usesCaseFlow(caseFile) ? "Main case-level report" : "Main synthesis";
		lines.push("", `${heading}: ${caseFile.synthesis.outcome}.`, caseFile.synthesis.report);
		if (caseFile.synthesis.witnesses !== undefined) lines.push(`Final witness ids: ${caseFile.synthesis.witnesses.length === 0 ? "(none)" : caseFile.synthesis.witnesses.join(", ")}.`);
		if (caseFile.synthesis.residual) lines.push(`Residual uncertainty: ${caseFile.synthesis.residual}`);
		if (caseFile.synthesis.closureGap) lines.push(`Closure gap: ${caseFile.synthesis.closureGap}`);
		if (caseFile.synthesis.budgetLimit) lines.push(`Budget limit: ${caseFile.synthesis.budgetLimit}`);
		if (caseFile.synthesis.blockingQuestion) lines.push(`Blocking question: ${caseFile.synthesis.blockingQuestion}`, `Successor-capsule boundary: ${caseFile.synthesis.successor.boundary}`);
	}
	lines.push("", `Durable file: cases/${caseFile.id}.json.`);
	return lines.join("\n");
}
