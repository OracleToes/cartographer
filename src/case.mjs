// A bounded same-model evidence case: one frozen capsule, three deliberately separated
// read-only phases, then the main context's explicit synthesis. A case is not a panel of
// agents or a vote. Its file records which context saw which evidence, what the user said
// while it ran, and the artifacts the main context must weigh for itself.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POLICY } from "./config.mjs";
import { stamp } from "./time.mjs";

export const CASE_ID_PATTERN = "c\\d+";
export const CASE_ID = new RegExp(`^${CASE_ID_PATTERN}$`);
export const CASE_PHASES = Object.freeze([
	{ id: "construct", name: "construction", objective: "Construct the narrowest account the frozen evidence supports. State assumptions, observations and the exact claim separately; do not call it confirmed." },
	{ id: "falsify", name: "blind falsification", objective: "Search the frozen evidence and project for a counterexample, missing condition, or alternate explanation. The construction artifact is intentionally not visible here." },
	{ id: "witness", name: "concrete witness", objective: "Make one concrete check against the project or frozen evidence. Distinguish what was observed from what it implies; it may support neither earlier artifact." },
]);

const CASE_STATUSES = new Set(["running", "ready", "synthesized", "stopped"]);
const PHASE_STATUSES = new Set(["queued", "active", "complete", "ended", "stopped"]);
const MESSAGE_ROUTES = new Set(["active", "queued"]);
const digest = (text) => createHash("sha256").update(String(text ?? "")).digest("hex");
const compact = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const clip = (text, max) => {
	const source = String(text ?? "").trim();
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

const phaseTemplate = () => CASE_PHASES.map(({ id, name, objective }) => ({ id, name, objective, status: "queued" }));
const messageLimit = () => POLICY.limits.case.messages;
const messageChars = () => POLICY.limits.case.messageChars;

/** Normalize only harmless omissions from an older or hand-inspected file; malformed files stay unreadable. */
function normalize(caseFile) {
	if (caseFile === null || typeof caseFile !== "object" || Array.isArray(caseFile)) throw new CaseError("it is not one case object");
	if (!CASE_ID.test(caseFile.id)) throw new CaseError("its id is invalid");
	if (typeof caseFile.question !== "string" || caseFile.question.trim() === "") throw new CaseError("it has no question");
	if (!CASE_STATUSES.has(caseFile.status)) throw new CaseError(`its status ${JSON.stringify(caseFile.status)} is invalid`);
	if (caseFile.capsule === null || typeof caseFile.capsule !== "object" || Array.isArray(caseFile.capsule)) throw new CaseError("it has no evidence capsule");
	if (!Array.isArray(caseFile.phases) || caseFile.phases.length !== CASE_PHASES.length) throw new CaseError("it has no complete phase list");
	for (const expected of CASE_PHASES) {
		const phase = caseFile.phases.find((entry) => entry?.id === expected.id);
		if (phase === undefined || !PHASE_STATUSES.has(phase.status)) throw new CaseError(`phase ${expected.id} is invalid`);
		phase.name ??= expected.name;
		phase.objective ??= expected.objective;
	}
	if (!Array.isArray(caseFile.messages)) caseFile.messages = [];
	if (!Number.isInteger(caseFile.nextMessage) || caseFile.nextMessage < 1) {
		const highest = Math.max(0, ...caseFile.messages.map((entry) => Number(/^u(\d+)$/.exec(String(entry?.id ?? ""))?.[1]) || 0));
		caseFile.nextMessage = highest + 1;
	}
	for (const message of caseFile.messages) {
		if (message === null || typeof message !== "object" || !/^u\d+$/.test(String(message.id ?? "")) || typeof message.text !== "string" || !Number.isFinite(message.at) || !MESSAGE_ROUTES.has(message.route)) throw new CaseError("one participant message is invalid");
	}
	return caseFile;
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

/** Persist one already-normalized case. */
export function saveCase(brainDir, value) {
	const next = normalize(JSON.parse(JSON.stringify(value)));
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

/** Mint a case and its frozen capsule. The caller has already selected and snapshotted any shelf evidence. */
export function createCase(brainDir, { question, context = "", evidence = [], at = Date.now() }) {
	const cleanQuestion = compact(question);
	if (cleanQuestion === "") throw new CaseError("A case needs one narrow refutable question.");
	const cleanContext = String(context ?? "").trim();
	if (cleanQuestion.length > POLICY.limits.case.questionChars) throw new CaseError(`The question exceeds the ${POLICY.limits.case.questionChars.toLocaleString("en-US")} character case limit.`);
	if (cleanContext.length > POLICY.limits.case.contextChars) throw new CaseError(`The evidence context exceeds the ${POLICY.limits.case.contextChars.toLocaleString("en-US")} character case limit.`);
	if (!Array.isArray(evidence) || evidence.length > POLICY.limits.case.evidenceItems) throw new CaseError(`A case carries at most ${POLICY.limits.case.evidenceItems} frozen shelf placements.`);
	const evidenceChars = evidence.reduce((sum, entry) => sum + String(entry?.item?.snapshot ?? "").length, 0);
	if (evidenceChars > POLICY.limits.case.evidenceChars) throw new CaseError(`The frozen shelf evidence exceeds the ${POLICY.limits.case.evidenceChars.toLocaleString("en-US")} character case limit.`);
	mkdirSync(casesDir(brainDir), { recursive: true });
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = nextCaseId(casesDir(brainDir));
		const value = {
			version: 1,
			id,
			createdAt: at,
			updatedAt: at,
			status: "running",
			question: cleanQuestion,
			capsule: {
				context: cleanContext,
				evidence: JSON.parse(JSON.stringify(evidence)),
				digest: digest(JSON.stringify({ question: cleanQuestion, context: cleanContext, evidence })),
			},
			phases: phaseTemplate(),
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
		for (const message of caseFile.messages) {
			if (message.route === "queued" && message.delivery === undefined) {
				message.route = "active";
				message.phase = phase.id;
			}
		}
		phase.status = "active";
		phase.startedAt = at;
		if (conversationId !== undefined) phase.conversationId = String(conversationId);
		return { phase: JSON.parse(JSON.stringify(phase)), messages: caseFile.messages.filter((message) => message.phase === phase.id && message.delivery === undefined).map((message) => JSON.parse(JSON.stringify(message))) };
	});
}

/** Add a participant message. Active-phase messages wait for its next result; messages between phases queue for the next one. */
export function noteCaseMessage(brainDir, id, text, { at = Date.now(), phase } = {}) {
	const said = String(text ?? "").trim();
	if (said === "") return { accepted: false, reason: "The message is empty." };
	if (said.length > messageChars()) return { accepted: false, reason: `A case message is at most ${messageChars().toLocaleString("en-US")} characters.` };
	return updateCase(brainDir, id, (caseFile) => {
		if (caseFile.status !== "running") return { accepted: false, reason: `Case ${id} is ${caseFile.status}; it is no longer receiving phase input.` };
		if (caseFile.messages.length >= messageLimit()) return { accepted: false, reason: `Case ${id} already holds ${messageLimit()} participant messages, its fixed provenance limit.` };
		const current = typeof phase === "string" ? caseFile.phases.find((entry) => entry.id === phase && entry.status === "active") : undefined;
		const entry = {
			id: `u${caseFile.nextMessage++}`,
			at,
			text: said,
			route: current === undefined ? "queued" : "active",
			...(current === undefined ? {} : { phase: current.id }),
		};
		caseFile.messages.push(entry);
		return { accepted: true, entry: JSON.parse(JSON.stringify(entry)) };
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

/** A phase ended. Messages that had not reached its request stay queued for the next available phase. */
export function finishCasePhase(brainDir, id, phaseId, result, { at = Date.now() } = {}) {
	return updateCase(brainDir, id, (caseFile) => {
		const phase = phaseOf(caseFile, phaseId);
		if (phase.status !== "active") throw new CaseError(`Case ${id}'s ${phase.name} phase is not active.`);
		const report = clip(result?.report ?? result?.failure ?? "", POLICY.limits.case.artifactChars);
		// A terminal stop wins a race with an ordinary phase return. The late words may remain inspectable, but they
		// cannot turn a stopped case back into a completed phase or make its report look like a completed artifact.
		const stopped = result?.stopped === true || caseFile.status === "stopped";
		const ended = stopped ? "stopped" : result?.returned === true ? "complete" : "ended";
		phase.status = ended;
		phase.endedAt = at;
		phase.artifact = {
			text: report.text,
			chars: report.chars,
			digest: digest(String(result?.report ?? result?.failure ?? "")),
			...(report.clipped ? { clipped: true } : {}),
			...(stopped ? {} : result?.done === true ? { done: true } : result?.returned === true ? { done: false } : {}),
			...(typeof result?.summary === "string" && result.summary.trim() !== "" ? { summary: compact(result.summary) } : {}),
			...(typeof result?.failure === "string" && result.failure.trim() !== "" ? { failure: compact(result.failure) } : {}),
		};
		const next = caseFile.phases.find((entry) => entry.status === "queued");
		for (const message of caseFile.messages) {
			if (message.phase !== phase.id || message.delivery !== undefined) continue;
			delete message.phase;
			message.route = "queued";
			message.unreadBy = phase.id;
			if (next === undefined) message.afterCase = true;
		}
		return JSON.parse(JSON.stringify(phase));
	});
}

/** Make the completed evidence case available to the main context for its explicit conclusion. */
export function readyCase(brainDir, id, { at = Date.now() } = {}) {
	return updateCase(brainDir, id, (caseFile) => {
		if (caseFile.status !== "running") throw new CaseError(`Case ${id} is ${caseFile.status}, not running.`);
		if (caseFile.phases.some((phase) => phase.status === "active" || phase.status === "queued")) throw new CaseError(`Case ${id} still has an unfinished phase.`);
		caseFile.status = "ready";
		caseFile.readyAt = at;
		return JSON.parse(JSON.stringify(caseFile));
	});
}

/** Record a stop before its active phase is interrupted; no later phase may start, and the partial record remains inspectable. */
export function stopCase(brainDir, id, { at = Date.now(), why } = {}) {
	return updateCase(brainDir, id, (caseFile) => {
		if (caseFile.status === "synthesized") throw new CaseError(`Case ${id} is already synthesized.`);
		caseFile.status = "stopped";
		caseFile.stoppedAt = at;
		if (typeof why === "string" && why.trim() !== "") caseFile.stopReason = compact(why);
		for (const phase of caseFile.phases) if (phase.status === "queued") phase.status = "stopped";
		return JSON.parse(JSON.stringify(caseFile));
	});
}

/** The main context's own conclusion. No phase count is turned into corroboration. */
export function synthesizeCase(brainDir, id, { outcome, report, residual, at = Date.now() }) {
	if (!["supported", "refuted", "unresolved"].includes(outcome)) throw new CaseError("A synthesis outcome is supported, refuted, or unresolved.");
	const written = String(report ?? "").trim();
	if (written === "") throw new CaseError("A synthesis needs a short report that weighs the phase artifacts.");
	if (written.length > POLICY.limits.case.synthesisChars) throw new CaseError(`The synthesis report exceeds the ${POLICY.limits.case.synthesisChars.toLocaleString("en-US")} character case limit.`);
	const remaining = String(residual ?? "").trim();
	if (remaining.length > POLICY.limits.case.residualChars) throw new CaseError(`The residual uncertainty exceeds the ${POLICY.limits.case.residualChars.toLocaleString("en-US")} character case limit.`);
	return updateCase(brainDir, id, (caseFile) => {
		if (caseFile.status !== "ready") throw new CaseError(`Case ${id} is ${caseFile.status}; only a ready case can be synthesized.`);
		caseFile.status = "synthesized";
		caseFile.synthesis = { at, outcome, report: written, ...(remaining === "" ? {} : { residual: remaining }) };
		return JSON.parse(JSON.stringify(caseFile));
	});
}

/** The stable evidence handoff, in text for a phase or the main context. */
export function renderCapsule(caseFile) {
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

const phaseArtifact = (caseFile, id) => {
	const phase = caseFile.phases.find((entry) => entry.id === id);
	if (phase?.artifact === undefined) return `${phase?.name ?? id}: no returned artifact.`;
	const meta = [phase.artifact.done === true ? "returned done" : phase.artifact.done === false ? "returned not done" : phase.status, phase.artifact.clipped ? `stored first ${phase.artifact.text.length.toLocaleString("en-US")} of ${phase.artifact.chars.toLocaleString("en-US")} characters` : `${phase.artifact.chars.toLocaleString("en-US")} characters`, `sha256 ${phase.artifact.digest}`].join(" · ");
	return `${phase.name} (${meta})\n${phase.artifact.text}`;
};

/** What the main context receives when it must make the only conclusion. */
export function renderCaseForSynthesis(caseFile) {
	const lines = [
		`Case ${caseFile.id} is ready for my synthesis. These are bounded artifacts from the same model in deliberately different contexts, not independent agents, votes, or corroboration. I weigh the evidence and label the result supported, refuted, or unresolved; agreement does not make a claim true.`,
		"",
		renderCapsule(caseFile),
		"",
		"Phase artifacts",
		phaseArtifact(caseFile, "construct"),
		"",
		phaseArtifact(caseFile, "falsify"),
		"",
		phaseArtifact(caseFile, "witness"),
	];
	const participation = caseFile.messages.length === 0 ? "No participant messages arrived while the case ran." : caseFile.messages.map((message) => `[${message.id} · ${stamp(message.at)} · ${message.delivery === undefined ? "not delivered before the case ended" : `offered to ${message.delivery.phase} by ${message.delivery.via}`}] ${message.text}`).join("\n");
	lines.push("", "Participant provenance", participation, "", `I now call \`case\` with action \`synthesize\`, id \`${caseFile.id}\`, one outcome, a concise evidence-weighting report, and any residual uncertainty.`);
	return lines.join("\n");
}

/** Compact user-facing state for /case and the state block. */
export function caseStatusLine(caseFile) {
	const active = caseFile.phases?.find((phase) => phase.status === "active");
	const waiting = caseFile.messages?.filter((message) => message.delivery === undefined).length ?? 0;
	const synthesis = caseFile.synthesis?.outcome;
	return `${caseFile.id} · ${caseFile.status}${active === undefined ? "" : ` · ${active.name}`}${waiting > 0 ? ` · ${waiting} participant ${waiting === 1 ? "message" : "messages"} queued` : ""}${synthesis === undefined ? "" : ` · ${synthesis}`}`;
}

/** A complete terminal inspection of one case without exposing a hidden scratch surface. */
export function renderCase(caseFile) {
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
