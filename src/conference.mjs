// Consult conferences: immutable entry capture, durable audit records, and the
// small host-owned continuation-or-report contract used by the same-model consult tool.
//
// This is deliberately a consult-local store. It is not a new generic snapshot,
// provenance, or persona framework: its sources belong to one `co<N>` conference,
// and its roster is the fixed v1 conference roster.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { POLICY } from "./config.mjs";
import { nativeLiteralGrammar } from "./native-grammar.mjs";
import { loadAssessment } from "./assessment.mjs";
import { loadAtlas } from "./atlas.mjs";
import { loadContext } from "./context.mjs";
import { loadLedger } from "./ledger.mjs";
import { loadPlan } from "./plan.mjs";
import { confine, LookError } from "./tools/look.mjs";
import { ensureCatalog, resolveFile } from "./catalog.mjs";

export const CONFERENCE_ID_PATTERN = "co\\d+";
export const CONFERENCE_ID = new RegExp(`^${CONFERENCE_ID_PATTERN}$`);
export const CONFERENCE_VERSION = 1;
export const ROSTER_VERSION = 1;

/** The v1 roster is policy, not model-written conference data. */
export const CONSULT_ROSTER = Object.freeze([
	Object.freeze({ id: "cartographer", name: "Cartographer", book: "persona", criterion: "the caller's project-local purpose, constraints, and practical consequences" }),
	Object.freeze({ id: "atlas", name: "Atlas", book: "atlas", criterion: "topology, relationships, boundaries, and unmapped ground" }),
	Object.freeze({ id: "ledger", name: "Ledger", book: "ledger", criterion: "claims, assumptions, evidence, and what could change the conclusion" }),
	Object.freeze({ id: "plan", name: "Plan", book: "plan", criterion: "scope, sequencing, dependencies, closure conditions, and tradeoffs" }),
	Object.freeze({ id: "assessment", name: "Assessment", book: "assessment", criterion: "project-level understanding, contradictions, and missing context" }),
	Object.freeze({ id: "context", name: "Context", book: "context", criterion: "what has been retained, omitted, or needs clarification at the durable-context boundary" }),
]);

export const PARTICIPANT_IDS = Object.freeze(CONSULT_ROSTER.map((member) => member.id));
const rosterMember = (id) => CONSULT_ROSTER.find((member) => member.id === id);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const flat = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const clip = (value, max) => {
	const text = String(value ?? "");
	return text.length <= max ? { text, clipped: false, originalChars: text.length } : { text: text.slice(0, max), clipped: true, originalChars: text.length };
};
const textOf = (message) => (message?.content ?? []).flatMap((part) => (part?.type === "text" ? [String(part.text ?? "")] : [])).join("").trim();
const thinkingOf = (message) => (message?.content ?? []).flatMap((part) => (part?.type === "thinking" ? [String(part.thinking ?? "")] : [])).join("\n").trim();
/** Keep the private conference audit inspectable without letting one generated field make its durable record unbounded. */
const auditText = (value) => clip(value, POLICY.limits.conference.activityChars);
const auditValue = (value, depth = 0) => {
	if (typeof value === "string") return auditText(value).text;
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (Array.isArray(value)) return value.slice(0, 32).map((entry) => auditValue(entry, depth + 1));
	if (value !== null && typeof value === "object" && depth < 4) {
		return Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, entry]) => [key, auditValue(entry, depth + 1)]));
	}
	return String(value ?? "");
};
/** Prefer Durable's generation task id; direct callers can still supply a message id/timestamp as a stable response key. */
const responseEventId = (eventId, message) => {
	const value = eventId ?? message?.id ?? message?.timestamp;
	return value === undefined || value === null || String(value) === "" ? undefined : String(value);
};
const nowIso = (at = Date.now()) => new Date(at).toISOString();
const sourcePath = (brainDir, id, sourceId) => join(conferenceDir(brainDir, id), "sources", `${sourceId}.txt`);

export class ConferenceError extends Error {}

export const consultsDir = (brainDir) => join(brainDir, "consults");
export const conferenceDir = (brainDir, id) => {
	if (!CONFERENCE_ID.test(String(id ?? ""))) throw new ConferenceError(`Not a valid consultation conference id: ${String(id ?? "")}`);
	return join(consultsDir(brainDir), String(id));
};
export const conferencePath = (brainDir, id) => join(conferenceDir(brainDir, id), "conference.json");

function writeAtomic(path, text) {
	mkdirSync(join(path, ".."), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, text);
	renameSync(temporary, path);
}

function ensureConferenceFolders(brainDir, id) {
	mkdirSync(join(conferenceDir(brainDir, id), "sources"), { recursive: true });
}

function nextConferenceId(brainDir) {
	let highest = 0;
	try {
		for (const entry of readdirSync(consultsDir(brainDir), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const match = /^co(\d+)$/.exec(entry.name);
			if (match) highest = Math.max(highest, Number(match[1]));
		}
	} catch {
		// The first conference creates its own directory below.
	}
	return `co${highest + 1}`;
}

/** Read a conference record without inferring or repairing any live state. */
export function loadConference(brainDir, id) {
	let path;
	try { path = conferencePath(brainDir, id); }
	catch (error) { return { error: error.message }; }
	if (!existsSync(path)) return { error: `No consultation conference ${id} exists.` };
	try {
		const conference = JSON.parse(readFileSync(path, "utf8"));
		if (conference === null || typeof conference !== "object" || conference.version !== CONFERENCE_VERSION || conference.id !== id) {
			return { error: `Conference ${id} is not a version ${CONFERENCE_VERSION} conference record.` };
		}
		return { conference };
	} catch (error) {
		return { error: `Conference ${id} cannot be read: ${error.message}` };
	}
}

/** Write one fully validated-by-caller record atomically. */
export function saveConference(brainDir, conference) {
	if (conference === null || typeof conference !== "object" || !CONFERENCE_ID.test(String(conference.id ?? ""))) {
		throw new ConferenceError("Cannot save a conference without a co<N> id.");
	}
	ensureConferenceFolders(brainDir, conference.id);
	writeAtomic(conferencePath(brainDir, conference.id), `${JSON.stringify(conference, null, "\t")}\n`);
	return conference;
}

/** Update one conference record atomically from its newest durable file copy. */
export function updateConference(brainDir, id, change) {
	const loaded = loadConference(brainDir, id);
	if (loaded.conference === undefined) throw new ConferenceError(loaded.error);
	const value = change(loaded.conference) ?? loaded.conference;
	saveConference(brainDir, value);
	return value;
}

export function listConferences(brainDir) {
	let ids = [];
	try {
		ids = readdirSync(consultsDir(brainDir), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && CONFERENCE_ID.test(entry.name))
			.map((entry) => entry.name)
			.sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
	} catch { /* no conferences */ }
	return ids.map((id) => ({ id, ...loadConference(brainDir, id) }));
}

function sourceRecord(id, kind, label, text, extra = {}) {
	return {
		id,
		kind,
		label,
		chars: text.length,
		digest: sha256(text),
		...extra,
	};
}

function writeSource(brainDir, conferenceId, source, text) {
	ensureConferenceFolders(brainDir, conferenceId);
	writeAtomic(sourcePath(brainDir, conferenceId, source.id), text);
	return source;
}

function parseRange(value, lineCount) {
	if (value === undefined || String(value).trim() === "") return { from: 1, to: lineCount };
	const found = /^(\d+)\s*(?:-|to|\.\.)\s*(\d+)$/.exec(String(value).trim());
	if (!found) throw new ConferenceError('A supplied file range must look like "10-80".');
	const from = Number(found[1]);
	const to = Number(found[2]);
	if (from < 1 || to < from || to - from + 1 > POLICY.limits.look.readMaxLines) {
		throw new ConferenceError(`A supplied file range must contain at most ${POLICY.limits.look.readMaxLines} lines and start at line 1 or later.`);
	}
	if (lineCount > 0 && from > lineCount) throw new ConferenceError(`The supplied file has ${lineCount} lines; line ${from} does not exist.`);
	return { from, to: Math.min(to, lineCount) };
}

function utf8Text(buffer, label) {
	if (buffer.subarray(0, POLICY.limits.look.binaryProbeChars).includes(0)) throw new ConferenceError(`${label} appears to be binary and cannot be supplied to a consultation.`);
	try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
	catch { throw new ConferenceError(`${label} is not valid UTF-8 text and cannot be supplied to a consultation.`); }
}

function capturePath(root, path, range) {
	let confined;
	try { confined = confine(root, path); }
	catch (error) {
		if (error instanceof LookError) throw new ConferenceError(`Supplied file refused: ${error.message}`);
		throw error;
	}
	if (!existsSync(confined.abs)) throw new ConferenceError(`Supplied file ${confined.rel} does not exist.`);
	const info = statSync(confined.abs);
	if (!info.isFile()) throw new ConferenceError(`Supplied path ${confined.rel} is not a regular file.`);
	if (info.size > POLICY.limits.look.fileBytes) throw new ConferenceError(`Supplied file ${confined.rel} is over the ${POLICY.limits.look.fileBytes}-byte consultation capture limit.`);
	const full = utf8Text(readFileSync(confined.abs), `Supplied file ${confined.rel}`);
	const lines = full.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const selected = parseRange(range, lines.length);
	return {
		path: confined.rel,
		text: lines.slice(selected.from - 1, selected.to).join("\n"),
		from: selected.from,
		to: selected.to,
		lineCount: lines.length,
	};
}

function captureCatalog(root, brainDir, value) {
	const rawRef = value?.ref ?? (typeof value?.id === "string" ? { id: value.id } : undefined);
	if (rawRef === undefined) return undefined;
	let reference;
	try {
		const namespace = rawRef.namespace ?? ensureCatalog(brainDir).namespace;
		reference = { ...rawRef, namespace, kind: rawRef.kind ?? "file" };
	} catch (error) {
		throw new ConferenceError(`Could not resolve supplied file reference: ${error.message}`);
	}
	if (reference.kind !== "file") throw new ConferenceError("A consultation file reference must name a catalog file.");
	const resolved = resolveFile(root, brainDir, reference);
	if (resolved.status !== "live" || resolved.bytes === undefined || resolved.record === undefined) {
		throw new ConferenceError(`Supplied file reference ${String(reference.id)} is unavailable: ${resolved.error ?? resolved.status}.`);
	}
	if (resolved.bytes.byteLength > POLICY.limits.look.fileBytes) throw new ConferenceError(`Supplied catalog file ${resolved.record.path} is over the consultation capture limit.`);
	const full = utf8Text(resolved.bytes, `Supplied file ${resolved.record.path}`);
	const lines = full.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const selected = parseRange(value?.range, lines.length);
	return {
		path: resolved.record.path,
		text: lines.slice(selected.from - 1, selected.to).join("\n"),
		from: selected.from,
		to: selected.to,
		lineCount: lines.length,
		catalog: { namespace: reference.namespace, id: reference.id, version: resolved.resolvedVersion ?? resolved.currentVersion },
	};
}

function normalizeFileSpec(value) {
	if (typeof value === "string") return { path: value };
	if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
	throw new ConferenceError("Each consultation `files` entry is a path string or an object with path/range or a file reference.");
}

function bookText(brainDir, book) {
	try {
		switch (book) {
			case "atlas": {
				const loaded = loadAtlas(brainDir);
				if (loaded.atlas === undefined) return { text: `(Atlas book was unreadable at entry: ${loaded.error})`, empty: true, unavailable: true };
				const text = JSON.stringify(loaded.atlas, null, 2);
				return { text: loaded.atlas.nodes.length === 0 ? "(The atlas has no nodes at conference entry.)" : text, empty: loaded.atlas.nodes.length === 0 };
			}
			case "ledger": {
				const loaded = loadLedger(brainDir);
				if (loaded.ledger === undefined) return { text: `(Ledger book was unreadable at entry: ${loaded.error})`, empty: true, unavailable: true };
				return { text: loaded.ledger.items.length === 0 ? "(The ledger has no entries at conference entry.)" : JSON.stringify(loaded.ledger, null, 2), empty: loaded.ledger.items.length === 0 };
			}
			case "plan": {
				const loaded = loadPlan(brainDir);
				if (loaded.plan === undefined) return { text: `(Plan book was unreadable at entry: ${loaded.error})`, empty: true, unavailable: true };
				return { text: loaded.plan.items.length === 0 && loaded.plan.moves.length === 0 ? "(The plan has no envelopes or moves at conference entry.)" : JSON.stringify(loaded.plan, null, 2), empty: loaded.plan.items.length === 0 && loaded.plan.moves.length === 0 };
			}
			case "assessment": {
				const assessment = loadAssessment(brainDir);
				return { text: assessment.text === "" ? "(No assessment was written at conference entry.)" : assessment.text, empty: assessment.text === "" };
			}
			case "context": {
				const context = loadContext(brainDir);
				const compact = {
					shelf: context.shelf ?? [],
					chat: context.chat ?? [],
					rows: context.rows ?? [],
				};
				const empty = compact.shelf.length === 0 && compact.chat.length === 0 && compact.rows.length === 0;
				return { text: empty ? "(The retained durable context is empty at conference entry.)" : JSON.stringify(compact, null, 2), empty };
			}
			default:
				throw new ConferenceError(`Unknown consult book ${book}.`);
		}
	} catch (error) {
		return { text: `(${book} book could not be captured at entry: ${error.message ?? error})`, empty: true, unavailable: true };
	}
}

/** Capture caller text/files and all consult-local book snapshots before a child exists. */
export function createConferenceCapture({ root, brainDir, question, context, files = [], myPersona, model, caller, at = Date.now() }) {
	const cleanQuestion = flat(question);
	const cleanPersona = flat(myPersona);
	if (cleanQuestion === "") throw new ConferenceError("`consult` needs one non-empty bounded `question`.");
	if (cleanPersona === "") throw new ConferenceError("`consult` needs a non-empty consult-local `myPersona` for Cartographer's opening turn.");
	if (cleanQuestion.length > POLICY.limits.conference.questionChars) throw new ConferenceError(`The consultation question must be ${POLICY.limits.conference.questionChars} characters or fewer.`);
	if (cleanPersona.length > POLICY.limits.conference.personaChars) throw new ConferenceError(`myPersona must be ${POLICY.limits.conference.personaChars} characters or fewer.`);
	if (!Array.isArray(files)) throw new ConferenceError("`files` must be a list of supplied project file paths or references.");
	if (files.length > POLICY.limits.conference.files) throw new ConferenceError(`A conference accepts at most ${POLICY.limits.conference.files} supplied files.`);

	// Validate and freeze every source before allocating a live co<N> directory. A refused path/range therefore
	// cannot leave a half-conference that a later call could mistake for a recoverable consultation.
	const pending = [];
	const sources = [];
	const addSource = (id, kind, label, body, extra = {}) => {
		const source = sourceRecord(id, kind, label, body, extra);
		pending.push({ source, text: body });
		return source;
	};
	const clippedContext = clip(context ?? "", POLICY.limits.conference.contextChars);
	const contextSource = addSource("c0", "context", "Caller-supplied context", clippedContext.text, {
		clipped: clippedContext.clipped,
		originalChars: clippedContext.originalChars,
	});
	sources.push(contextSource);
	for (const [index, raw] of files.entries()) {
		const spec = normalizeFileSpec(raw);
		let captured;
		if (typeof spec.path === "string" && spec.path.trim() !== "") captured = capturePath(root, spec.path, spec.range);
		else captured = captureCatalog(root, brainDir, spec);
		if (captured === undefined) throw new ConferenceError(`Supplied file ${index + 1} needs a project-relative path or a catalog file reference.`);
		const clipped = clip(captured.text, POLICY.limits.conference.sourceChars);
		const source = addSource(`s${index + 1}`, "file", captured.path, clipped.text, {
			path: captured.path,
			from: captured.from,
			to: captured.to,
			lineCount: captured.lineCount,
			clipped: clipped.clipped,
			originalChars: clipped.originalChars,
			...(captured.catalog === undefined ? {} : { catalog: captured.catalog }),
		});
		sources.push(source);
	}
	const bookSources = {};
	for (const member of CONSULT_ROSTER.filter((entry) => entry.book !== "persona")) {
		const captured = bookText(brainDir, member.book);
		const clipped = clip(captured.text, POLICY.limits.conference.bookChars);
		const source = addSource(`b-${member.id}`, "book", `${member.name} entry snapshot`, clipped.text, {
			book: member.book,
			empty: captured.empty === true,
			unavailable: captured.unavailable === true,
			clipped: clipped.clipped,
			originalChars: clipped.originalChars,
		});
		bookSources[member.id] = source;
	}

	const conferenceId = nextConferenceId(brainDir);
	const record = {
		version: CONFERENCE_VERSION,
		id: conferenceId,
		createdAt: nowIso(at),
		caller: {
			conversationId: String(caller?.conversationId ?? ""),
			callId: String(caller?.callId ?? ""),
			taskId: String(caller?.taskId ?? ""),
		},
		model: { provider: String(model?.provider ?? ""), modelId: String(model?.modelId ?? "") },
		status: "captured",
		question: cleanQuestion,
		myPersona: { text: cleanPersona, digest: sha256(cleanPersona) },
		roster: { version: ROSTER_VERSION, members: CONSULT_ROSTER.map(({ id, book }) => ({ id, book })) },
		sources,
		bookSources,
		// A private, bounded participant timeline powers the Consult view. It remains in this consult-local record;
		// none of it becomes parent conversation/context material.
		activities: [],
		activityCount: 0,
		turns: [],
		selectorEvents: [],
		toolReceipts: [],
		toolReceiptCount: 0,
		requestPlans: [],
		requestPlanCount: 0,
		limits: {
			turns: POLICY.limits.conference.turns,
			debateTurns: POLICY.limits.conference.debateTurns,
			debateParticipants: POLICY.limits.conference.debateParticipants,
			runtimeMs: POLICY.limits.conference.runtimeMs,
		},
		active: { kind: "participant", participant: "cartographer", opening: true },
	};
	ensureConferenceFolders(brainDir, conferenceId);
	for (const item of pending) writeSource(brainDir, conferenceId, item.source, item.text);
	saveConference(brainDir, record);
	return record;
}

/** A compact source manifest shared by all participants. It never includes private book source contents. */
export function commonManifest(record) {
	return record.sources.map((source) => ({
		id: source.id,
		kind: source.kind,
		label: source.label,
		...(source.path === undefined ? {} : { path: source.path }),
		...(source.from === undefined ? {} : { range: `${source.from}-${source.to}` }),
		digest: source.digest,
		chars: source.chars,
		...(source.clipped ? { clipped: true } : {}),
	}));
}

export const CONSULT_SITUATION = `This is an isolated same-model consultation conference. It is advisory: no participant has project, shell, network, shared-brain, plan, approval, or user-decision authority. Speak only from the immutable common packet, shared conference history, and your temporary persona packet. Treat supplied snapshots as material to inspect, not proof. Cite source ids when useful; say what remains uncertain. Do not impersonate another participant, vote, or claim independent corroboration. A participant can inspect only caller-attached immutable sources with consult_source. Deliberating participants do not end the conference. The host makes a separate native-GBNF decision after a bounded debate; only a host-authorized final Cartographer report may call consult_return with an honest structured synthesis. Your active persona packet is request-local: when another participant speaks, it no longer applies.`;

/** First durable user entry in the independent child conversation. */
export function conferenceSeed(record, brainDir) {
	const context = record.sources?.find((source) => source.id === "c0" && source.kind === "context");
	if (context === undefined) throw new ConferenceError(`Conference ${record.id} is missing its required c0 caller-context snapshot.`);
	// Context is the caller's explicit handoff, not an optional live read the first participant may forget to make.
	// Read the captured bytes (and verify their digest) rather than preserving a second mutable copy in the record.
	const callerContext = readConferenceSourceUnchecked(record, context, brainDir);
	return [
		"Conference entry packet",
		`Conference: ${record.id}`,
		`Question: ${record.question}`,
		"Captured caller context (c0):",
		callerContext === "" ? "(No caller-supplied context was captured.)" : callerContext,
		"Common immutable sources:",
		...commonManifest(record).map((source) => `- ${source.id} · ${source.kind} · ${source.label}${source.path ? ` (${source.path}${source.range ? ` lines ${source.range}` : ""})` : ""} · sha256 ${source.digest}${source.clipped ? " · clipped" : ""}`),
		"Use consult_source only for c0 and s<N> sources; book snapshots are private persona material.",
	].join("\n");
}

/** The only changing suffix of a participant request. */
export function participantTail(record) {
	const active = record.active;
	const member = rosterMember(active?.participant);
	if (member === undefined) throw new ConferenceError(`Conference ${record.id} has no valid active participant.`);
	const lines = ["Active participant packet", `You are ${member.name} (${member.id}) for this one turn.`];
	if (member.id === "cartographer") {
		lines.push("Your opening consult-local persona follows. It is not a parent-session instruction and grants no authority.", record.myPersona.text);
	} else {
		const source = record.bookSources?.[member.id];
		if (source === undefined) throw new ConferenceError(`Conference ${record.id} is missing ${member.id}'s book snapshot.`);
		const content = readConferenceSourceUnchecked(record, source);
		lines.push(`Your concern: ${member.criterion}.`, `Your private entry-time ${member.book} snapshot (${source.id}, sha256 ${source.digest}${source.empty ? "; empty snapshot" : ""}):`, content);
	}
	if (active?.phase === "report") {
		if (member.id !== "cartographer") throw new ConferenceError(`Conference ${record.id} assigned a final report to ${member.id}, not Cartographer.`);
		lines.push("The host's native GBNF decision found the bounded debate ready for a final advisory. Write Cartographer's report from the completed conference contributions, name uncertainty honestly, and call consult_return. Do not present plain prose as the final result without that call.");
	} else {
		lines.push("This is a deliberation turn, not the final report. You may call consult_source, then finish your bounded contribution without a tool call so the host can make the next native routing or report decision. consult_return is intentionally unavailable until the host authorizes Cartographer's final report.");
	}
	return lines.join("\n");
}

export function eligibleParticipants(record) {
	const previous = record.active?.previousSpeaker ?? record.turns?.at(-1)?.participant;
	if (previous !== undefined && !PARTICIPANT_IDS.includes(previous)) {
		throw new ConferenceError(`Conference ${record?.id ?? "record"} has an invalid previous participant ${JSON.stringify(String(previous))}; native routing cannot build a grammar from unvalidated state.`);
	}
	return PARTICIPANT_IDS.filter((id) => id !== previous);
}

/** The host holds the minimum debate gate; the model cannot bypass it by requesting a final report early. */
export function debateStatus(record) {
	const limit = (key) => {
		const value = record?.limits?.[key] ?? POLICY.limits.conference[key];
		if (!Number.isInteger(value) || value < 1) throw new ConferenceError(`Conference ${record?.id ?? "record"} has an invalid ${key} debate limit.`);
		return value;
	};
	const turns = Array.isArray(record?.turns) ? record.turns : [];
	const speakers = new Set();
	for (const turn of turns) {
		if (!PARTICIPANT_IDS.includes(turn?.participant)) throw new ConferenceError(`Conference ${record?.id ?? "record"} has an invalid completed participant turn.`);
		speakers.add(turn.participant);
	}
	const debateTurns = limit("debateTurns");
	const debateParticipants = limit("debateParticipants");
	return {
		turns: turns.length,
		participants: [...speakers],
		debateTurns,
		debateParticipants,
		ready: turns.length >= debateTurns && speakers.size >= debateParticipants,
	};
}

const validSelectorEligible = (record, eligible) => {
	if (!Array.isArray(eligible) || eligible.length === 0 || eligible.some((id) => !PARTICIPANT_IDS.includes(id)) || new Set(eligible).size !== eligible.length) {
		throw new ConferenceError(`Conference ${record.id} has no valid eligible participant after ${record.active?.previousSpeaker ?? "the prior turn"}.`);
	}
	const prior = record.active?.previousSpeaker ?? record.turns?.at(-1)?.participant;
	if (prior === undefined) throw new ConferenceError(`Conference ${record.id} has no completed participant to route after.`);
	if (!PARTICIPANT_IDS.includes(prior)) throw new ConferenceError(`Conference ${record.id} has an invalid previous participant for native routing.`);
	if (eligible.includes(prior)) throw new ConferenceError(`Conference ${record.id} native routing would allow the immediately prior participant ${prior}.`);
	return prior;
};

/** Finite host-owned choices: continue the debate with one eligible persona, or authorize Cartographer's report. */
export function selectorOptions(record, eligible = eligibleParticipants(record)) {
	validSelectorEligible(record, eligible);
	const debate = debateStatus(record);
	const options = eligible.map((participant) => ({ value: `continue:${participant}`, decision: "continue", participant }));
	// The report path remains impossible before an actual exchange, and it still respects no-consecutive-speaker
	// routing by requiring Cartographer to be eligible after the immediately prior participant.
	if (debate.ready && eligible.includes("cartographer")) options.push({ value: "report:cartographer", decision: "report", participant: "cartographer" });
	return options;
}

/** One finite native grammar for the selector's routing-or-report decision. */
export function selectorGrammar(options) {
	if (!Array.isArray(options) || options.length === 0 || options.some((option) => typeof option?.value !== "string" || option.value === "" || !PARTICIPANT_IDS.includes(option.participant) || !["continue", "report"].includes(option.decision))) {
		throw new ConferenceError("Cannot build a selector grammar from invalid conference choices.");
	}
	try { return nativeLiteralGrammar(options.map((option) => option.value)); }
	catch (error) { throw new ConferenceError(`Cannot build a selector grammar: ${error.message ?? error}`); }
}

/** The selector packet is neutral: no persona packet and no participant tool surface. */
export function selectorTail(record, eligible = eligibleParticipants(record)) {
	const previous = validSelectorEligible(record, eligible);
	const debate = debateStatus(record);
	const options = selectorOptions(record, eligible);
	const report = options.find((option) => option.decision === "report");
	return [
		"Neutral native selector packet",
		`The immediately preceding conference contribution was spoken by ${previous}.`,
		`Host debate gate: ${debate.turns}/${debate.debateTurns} completed contributions and ${debate.participants.length}/${debate.debateParticipants} distinct participants (${debate.ready ? "met" : "not met"}).`,
		`Choose exactly one finite grammar value: ${options.map((option) => option.value).join(", ")}.`,
		report === undefined
			? "The host has not yet observed enough debate to authorize a report; choose a continue value."
			: "Choose report:cartographer only when the completed debate has reached an honest advisory conclusion or a clearly stated unresolved/needs-input outcome; otherwise choose a continue value.",
		"Native GBNF is the output boundary; do not explain, vote, call a tool, or choose the prior participant. This is a bounded host decision, not a consultation answer.",
		"Roster concerns:",
		...CONSULT_ROSTER.filter((member) => eligible.includes(member.id)).map((member) => `- ${member.id}: ${member.criterion}`),
	].join("\n");
}

/** One finite native grammar, generated only from host-validated eligible IDs. */
export function enumGrammar(ids) {
	if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !PARTICIPANT_IDS.includes(id))) throw new ConferenceError("Cannot build a selector grammar from an invalid eligible roster.");
	try { return nativeLiteralGrammar(ids); }
	catch (error) { throw new ConferenceError(`Cannot build a selector grammar: ${error.message ?? error}`); }
}

/**
 * The raw selector sees only host-owned routing material: the bounded question,
 * completed public contributions, and roster concerns. It never receives a
 * participant's private packet, project path, live tool declaration, or Durable
 * history. The native grammar itself supplies the finite answer boundary.
 */
export function selectorMessages(record, eligible = eligibleParticipants(record)) {
	if (record === null || typeof record !== "object") throw new ConferenceError("Cannot build a native selector request without a conference record.");
	const transcript = (record.turns ?? []).map((turn) => `${turn.participant}: ${flat(turn.text)}`).filter((line) => line !== "").join("\n");
	const clipped = clip(transcript === "" ? "(No completed participant contribution is available.)" : transcript, POLICY.limits.conference.selectorChars);
	return [
		{
			role: "system",
			content: "You are Cartographer's host-owned conference router. Make one bounded continuation-or-report decision from the native grammar. Do not analyze, answer the consultation, call tools, or add prose.",
		},
		{
			role: "user",
			content: [
				`Consultation question:\n${record.question}`,
				`Completed participant contributions${clipped.clipped ? " (tail clipped by host)" : ""}:\n${clipped.text}`,
				selectorTail(record, eligible),
			].join("\n\n"),
		},
	];
}

/**
 * Durable plans every extension tool before request hooks run. Deliberating participants can inspect immutable
 * sources but cannot end the conference; only host-authorized Cartographer report turns receive consult_return.
 * Native selection remains outside this provider payload.
 */
export function restrictParticipantPayload(payload, { allowReturn = false } = {}) {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new ConferenceError("The participant provider payload is not an OpenAI-compatible object.");
	const expected = new Set(allowReturn ? ["consult_source", "consult_return"] : ["consult_source"]);
	const declared = Array.isArray(payload.tools) ? payload.tools : [];
	const tools = declared.filter((tool) => tool?.type === "function" && expected.has(tool?.function?.name));
	if (tools.length !== expected.size || new Set(tools.map((tool) => tool.function.name)).size !== expected.size) {
		throw new ConferenceError(`The isolated participant payload did not contain exactly ${[...expected].join(" and ")} declarations.`);
	}
	const { tool_choice: ignoredToolChoice, ...withoutChoice } = payload;
	return { ...withoutChoice, tools };
}

/** Inspect an immutable source by ID. Private book snapshots deliberately are not exposed here. */
export function readConferenceSource(brainDir, conference, id) {
	const source = conference.sources?.find((entry) => entry.id === id && (entry.kind === "context" || entry.kind === "file"));
	if (source === undefined) throw new ConferenceError(`Source ${JSON.stringify(String(id ?? ""))} was not captured for this conference. consult_source can only inspect c0 or one captured s<N> source.`);
	return { source, text: readConferenceSourceUnchecked(conference, source, brainDir) };
}

function readConferenceSourceUnchecked(record, source, suppliedBrainDir) {
	const brainDir = suppliedBrainDir ?? record.__brainDir;
	if (typeof brainDir !== "string") throw new ConferenceError("Conference source resolution needs its brain directory.");
	const path = sourcePath(brainDir, record.id, source.id);
	if (!existsSync(path)) throw new ConferenceError(`The immutable source ${source.id} is missing from conference ${record.id}.`);
	const text = readFileSync(path, "utf8");
	if (sha256(text) !== source.digest) throw new ConferenceError(`The immutable source ${source.id} no longer matches its recorded digest.`);
	return text;
}

/** Attach a nonserialized brain location for short-lived local packet rendering. */
export function withConferenceBrain(conference, brainDir) {
	return { ...conference, __brainDir: brainDir };
}

/**
 * Record one private participant response, including reasoning and local-tool calls, exactly once.
 *
 * This is intentionally distinct from `turns`: a turn closes only when no tool call was made and becomes eligible
 * for host routing. The activity timeline is the Consult-view audit and never crosses into the caller's context.
 */
export function recordParticipantActivity(brainDir, id, participant, message, at = Date.now(), eventId) {
	if (!PARTICIPANT_IDS.includes(participant)) throw new ConferenceError(`Conference ${id} cannot record an unrecognized participant ${JSON.stringify(String(participant))}.`);
	const content = Array.isArray(message?.content) ? message.content : [];
	const digest = sha256(JSON.stringify(content));
	// A Durable generation task is the stable identity of one terminal provider response. Do not use generated words
	// as the identity: two genuine rounds may say exactly the same thing, while a restarted hook must remain idempotent.
	const responseId = responseEventId(eventId, message);
	const reasoning = auditText(thinkingOf(message));
	const prose = auditText(textOf(message));
	const calls = content
		.filter((part) => part?.type === "toolCall")
		.map((call) => ({
			id: typeof call.id === "string" ? call.id : undefined,
			name: String(call.name ?? "unknown"),
			arguments: auditValue(call.arguments ?? {}),
		}))
		.map((call) => Object.fromEntries(Object.entries(call).filter(([, value]) => value !== undefined)));
	return updateConference(brainDir, id, (record) => {
		record.activities ??= [];
		// Check the durable identity before status/speaker state. A recovered afterResponse hook may arrive after
		// routing advanced; it is then an idempotent replay, not an unauthorized new contribution.
		const existing = responseId === undefined
			? record.activities.find((activity) => activity.digest === digest && activity.participant === participant)
			: record.activities.find((activity) => activity.eventId === responseId);
		if (existing !== undefined) return record;
		if (record.status !== "running") throw new ConferenceError(`Conference ${id} is ${record.status}, not running.`);
		if (record.active?.kind !== "participant" || record.active.participant !== participant) {
			throw new ConferenceError(`Conference ${id} cannot record a ${participant} activity while ${record.active?.kind === "participant" ? record.active.participant : record.active?.kind ?? "nobody"} is active.`);
		}
		const activity = {
			index: (record.activityCount ?? record.activities.length) + 1,
			participant,
			at: nowIso(at),
			digest,
			...(responseId === undefined ? {} : { eventId: responseId }),
			...(reasoning.text === "" ? {} : { reasoning: reasoning.text, ...(reasoning.clipped ? { reasoningClipped: true, reasoningChars: reasoning.originalChars } : {}) }),
			...(prose.text === "" ? {} : { prose: prose.text, ...(prose.clipped ? { proseClipped: true, proseChars: prose.originalChars } : {}) }),
			...(calls.length === 0 ? {} : { calls }),
			...(typeof message?.stopReason === "string" ? { stopReason: message.stopReason } : {}),
		};
		record.activityCount = activity.index;
		record.activities.push(activity);
		const cap = POLICY.limits.conference.activities;
		if (record.activities.length > cap) record.activities.splice(0, record.activities.length - cap);
		return record;
	});
}

/** Record one completed no-tool participant turn exactly once. */
export function recordParticipantTurn(brainDir, id, participant, message, at = Date.now(), eventId) {
	if (!PARTICIPANT_IDS.includes(participant)) throw new ConferenceError(`Conference ${id} cannot record an unrecognized participant ${JSON.stringify(String(participant))}.`);
	const spoken = textOf(message);
	const digest = sha256(JSON.stringify(message?.content ?? []));
	const responseId = responseEventId(eventId, message);
	const loaded = loadConference(brainDir, id);
	if (loaded.conference === undefined) throw new ConferenceError(loaded.error);
	// Recovery can replay the afterResponse hook after selector state has advanced. Once the durable turn exists,
	// return before activity's active-speaker guard instead of rejecting an idempotent replay.
	const recordedTurn = responseId === undefined
		? loaded.conference.turns?.findLast?.((turn) => turn.digest === digest && turn.participant === participant)
		: loaded.conference.turns?.findLast?.((turn) => turn.eventId === responseId);
	if (recordedTurn !== undefined) return loaded.conference;
	// Keep direct recovery/manual callers as rich as the normal extension path. A preceding afterResponse activity
	// with this Durable response identity is deliberately a no-op here.
	recordParticipantActivity(brainDir, id, participant, message, at, eventId);
	return updateConference(brainDir, id, (record) => {
		const existing = responseId === undefined
			? record.turns?.findLast?.((turn) => turn.digest === digest && turn.participant === participant)
			: record.turns?.findLast?.((turn) => turn.eventId === responseId);
		if (existing !== undefined) return record;
		if (record.status !== "running") throw new ConferenceError(`Conference ${id} is ${record.status}, not running.`);
		if (record.active?.kind !== "participant" || record.active.participant !== participant) {
			throw new ConferenceError(`Conference ${id} cannot record a completed ${participant} turn while ${record.active?.kind === "participant" ? record.active.participant : record.active?.kind ?? "nobody"} is active.`);
		}
		record.turns ??= [];
		record.turns.push({ index: record.turns.length + 1, participant, at: nowIso(at), digest, ...(responseId === undefined ? {} : { eventId: responseId }), text: spoken });
		record.active = { kind: "selector", previousSpeaker: participant };
		return record;
	});
}

/** Record one validated native routing-or-report decision and stage its labelled host handoff. */
export function recordSelectorChoice(brainDir, id, selectedValue, { nativeResult, at = Date.now() } = {}) {
	return updateConference(brainDir, id, (record) => {
		record.selectorEvents ??= [];
		const previous = record.active?.previousSpeaker ?? record.turns?.at(-1)?.participant;
		if (previous === undefined) throw new ConferenceError(`Conference ${id} has no completed participant to route after.`);
		const eligible = eligibleParticipants(record);
		const options = selectorOptions(record, eligible);
		const choice = options.find((option) => option.value === selectedValue);
		if (choice === undefined) throw new ConferenceError(`Selector choice ${String(selectedValue)} is not an eligible native decision after ${previous}.`);
		const prior = record.selectorEvents.at(-1);
		// A replay can arrive after the first execution has already moved the durable state to that participant.
		if (record.active?.kind === "participant" && record.active.participant === choice.participant && prior?.participant === choice.participant && (prior?.decision ?? "continue") === choice.decision) return record;
		if (record.status !== "running" || record.active?.kind !== "selector") throw new ConferenceError(`Conference ${id} is not waiting for a neutral selector choice.`);
		if (prior?.participant === choice.participant && prior?.after === previous && (prior?.decision ?? "continue") === choice.decision) return record;
		const response = nativeResult?.response;
		const debate = debateStatus(record);
		record.selectorEvents.push({
			index: record.selectorEvents.length + 1,
			at: nowIso(at),
			after: previous,
			eligible,
			options: options.map((option) => option.value),
			decision: choice.decision,
			participant: choice.participant,
			debate: { turns: debate.turns, participants: [...debate.participants], debateTurns: debate.debateTurns, debateParticipants: debate.debateParticipants, ready: debate.ready },
			grammar: selectorGrammar(options),
			method: "llama.cpp-native-gbnf",
			grammarEnforced: true,
			...(response === undefined ? {} : {
				native: {
					status: response.status,
					...(nativeResult?.finishReason === undefined ? {} : { finishReason: nativeResult.finishReason }),
					...(nativeResult?.elapsedMs === undefined ? {} : { elapsedMs: nativeResult.elapsedMs }),
				},
			}),
		});
		// The child needs one labelled continuation after a native decision. Clearing this marker in
		// `consumeSelectorHandoff` makes a later participant tool round unable to replay that host event.
		record.active = {
			kind: "participant",
			participant: choice.participant,
			opening: false,
			previousSpeaker: previous,
			nativeSelectionPending: true,
			phase: choice.decision === "report" ? "report" : "debate",
		};
		return record;
	});
}

/** Consume exactly one durable host continuation after the native selector chose a participant. */
export function consumeSelectorHandoff(brainDir, id) {
	return updateConference(brainDir, id, (record) => {
		if (record.status !== "running" || record.active?.kind !== "participant" || record.active.nativeSelectionPending !== true) return record;
		const { nativeSelectionPending: ignored, ...active } = record.active;
		record.active = active;
		return record;
	});
}

export function recordRequestPlan(brainDir, id, kind, stableMessages, tail, at = Date.now()) {
	const stable = JSON.stringify(stableMessages);
	const transient = String(tail ?? "");
	return updateConference(brainDir, id, (record) => {
		record.requestPlans ??= [];
		const plan = {
			index: (record.requestPlanCount ?? record.requestPlans.length) + 1,
			kind,
			at: nowIso(at),
			stableDigest: sha256(stable),
			stableMessages: stableMessages.length,
			tailDigest: sha256(transient),
			tailChars: transient.length,
			historyTurns: record.turns?.length ?? 0,
			historySelections: record.selectorEvents?.length ?? 0,
		};
		const prior = record.requestPlans.at(-1);
		if (prior?.kind === plan.kind && prior?.stableDigest === plan.stableDigest && prior?.tailDigest === plan.tailDigest) return record;
		record.requestPlanCount = plan.index;
		record.requestPlans.push(plan);
		const cap = POLICY.limits.conference.requestPlans;
		if (record.requestPlans.length > cap) record.requestPlans.splice(0, record.requestPlans.length - cap);
		return record;
	});
}

export function recordToolReceipt(brainDir, id, receipt) {
	return updateConference(brainDir, id, (record) => {
		record.toolReceipts ??= [];
		const digest = sha256(JSON.stringify(receipt));
		// Durable may replay a safe local tool after a process interruption. A known call id is the stable identity
		// of that attempted tool/result pair; do not turn replay into a second visible result.
		if ((typeof receipt?.callId === "string" && record.toolReceipts.some((entry) => entry.callId === receipt.callId)) || record.toolReceipts.some((entry) => entry.digest === digest)) return record;
		const index = (record.toolReceiptCount ?? record.toolReceipts.length) + 1;
		record.toolReceiptCount = index;
		// Preserve a receipt id when supplied, but assign a monotonic local fallback after pruning so receipt-to-call
		// display pairing remains unambiguous for callers that do not provide a tool-call id.
		record.toolReceipts.push({ ...receipt, id: receipt.id ?? `receipt-${index}`, index, digest, at: receipt.at ?? nowIso() });
		const cap = POLICY.limits.conference.toolReceipts;
		if (record.toolReceipts.length > cap) record.toolReceipts.splice(0, record.toolReceipts.length - cap);
		return record;
	});
}

export function completeConference(brainDir, id, participant, outcome, at = Date.now()) {
	return updateConference(brainDir, id, (record) => {
		if (record.final !== undefined) return record;
		if (record.status !== "running" || record.active?.kind !== "participant" || record.active.participant !== "cartographer" || participant !== "cartographer" || record.active.phase !== "report") {
			throw new ConferenceError(`Conference ${id} cannot accept a final return from ${participant} without a host-authorized Cartographer report state.`);
		}
		const packet = { kind: "opening-persona", id: "myPersona", digest: record.myPersona?.digest };
		if (typeof packet.digest !== "string" || packet.digest === "") throw new ConferenceError(`Conference ${id} has no immutable ${participant} packet to attribute its final return.`);
		const artifact = {
			...outcome,
			participant,
			at: nowIso(at),
			provenance: {
				participantPacket: packet,
				selectorHistory: (record.selectorEvents ?? []).map((event) => ({
					index: event.index,
					after: event.after,
					eligible: [...event.eligible],
					...(Array.isArray(event.options) ? { options: [...event.options] } : {}),
					...(typeof event.decision === "string" ? { decision: event.decision } : {}),
					...(event.debate === undefined ? {} : { debate: event.debate }),
					participant: event.participant,
					grammar: event.grammar,
					method: event.method ?? (event.payloadObserved === true ? "legacy-openai-custom-tool" : "unknown"),
					grammarEnforced: event.grammarEnforced === true || event.payloadObserved === true,
					...(event.native === undefined ? {} : { native: event.native }),
				})),
			},
		};
		record.final = { ...artifact, digest: sha256(JSON.stringify(artifact)) };
		record.status = "returned";
		delete record.active;
		return record;
	});
}

export function endConference(brainDir, id, status, reason, at = Date.now()) {
	if (!["failed", "interrupted", "cancelled", "blocked"].includes(status)) throw new ConferenceError(`Invalid non-return conference status ${status}.`);
	return updateConference(brainDir, id, (record) => {
		if (["returned", "failed", "interrupted", "cancelled", "blocked"].includes(record.status)) return record;
		record.status = status;
		record.ended = { at: nowIso(at), reason: String(reason ?? "ended without a final consult_return") };
		delete record.active;
		return record;
	});
}

export function attachChildConference(brainDir, id, childConversationId, at = Date.now()) {
	return updateConference(brainDir, id, (record) => {
		if (record.childConversationId !== undefined && record.childConversationId !== String(childConversationId)) {
			throw new ConferenceError(`Conference ${id} already belongs to another child conversation.`);
		}
		record.childConversationId = String(childConversationId);
		record.status = "running";
		record.startedAt ??= nowIso(at);
		return record;
	});
}

export function findConferenceByChild(brainDir, childConversationId) {
	const child = String(childConversationId ?? "");
	return listConferences(brainDir).find((entry) => entry.conference?.childConversationId === child)?.conference;
}

export function findConferenceByCaller(brainDir, { taskId, callId } = {}) {
	const task = String(taskId ?? "");
	const call = String(callId ?? "");
	return listConferences(brainDir).find((entry) => entry.conference?.caller?.taskId === task && entry.conference?.caller?.callId === call)?.conference;
}

export function conferenceStatusLine(record) {
	const speaker = record.active?.participant;
	const turns = record.turns?.length ?? 0;
	const selections = record.selectorEvents?.length ?? 0;
	return `${record.id} · ${record.status}${speaker ? ` · ${speaker} speaking` : ""} · ${turns} ${turns === 1 ? "turn" : "turns"} · ${selections} selector ${selections === 1 ? "event" : "events"} · ${record.model?.provider}/${record.model?.modelId}`;
}

/** Audit output deliberately names records and snapshots without spilling them into ordinary parent chat. */
export function renderConference(record, { audit = true } = {}) {
	const limits = record.limits ?? {};
	const turns = record.turns ?? [];
	const activities = record.activities ?? [];
	const selections = record.selectorEvents ?? [];
	const plans = record.requestPlans ?? [];
	const sources = record.sources ?? [];
	const duration = (() => {
		const start = Date.parse(record.startedAt ?? record.createdAt ?? "");
		const end = Date.parse(record.ended?.at ?? record.final?.at ?? "");
		if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
		return `${Math.round((end - start) / 1000)}s`;
	})();
	const sourceLine = (source) => [
		source.id,
		source.kind,
		source.label,
		source.path === undefined ? undefined : `${source.path}${source.from === undefined ? "" : ` lines ${source.from}-${source.to}`}`,
		`${source.chars ?? 0} chars`,
		`sha256 ${source.digest}`,
		source.clipped ? `clipped from ${source.originalChars ?? "an earlier"} chars` : undefined,
		source.unavailable ? "unavailable at entry" : undefined,
	].filter((part) => part !== undefined).join(" · ");
	const lines = [
		`Consult conference ${record.id}`,
		`Status: ${record.status}. Model: ${record.model?.provider}/${record.model?.modelId}.`,
		`Question: ${record.question}`,
		"Structured notebook only: immutable snapshots, labelled turns, selector events, and tool receipts; no filesystem or command scratch.",
		`Lifecycle: captured ${record.createdAt ?? "unknown"}${record.startedAt === undefined ? "" : ` · child started ${record.startedAt}`}${duration === undefined ? "" : ` · elapsed ${duration}`}.`,
		`Budget: ${turns.length}/${limits.turns ?? POLICY.limits.conference.turns} completed participant turns · ${activities.length}/${POLICY.limits.conference.activities} retained participant activities${record.activityCount === undefined || record.activityCount === activities.length ? "" : ` (${record.activityCount} total)`} · ${selections.length} selector events · ${(record.toolReceipts ?? []).length}/${POLICY.limits.conference.toolReceipts} retained local tool receipts${record.toolReceiptCount === undefined || record.toolReceiptCount === (record.toolReceipts ?? []).length ? "" : ` (${record.toolReceiptCount} total)`} · ${plans.length}/${POLICY.limits.conference.requestPlans} retained request-plan audits${record.requestPlanCount === undefined || record.requestPlanCount === plans.length ? "" : ` (${record.requestPlanCount} total)`} · runtime cap ${Math.round((limits.runtimeMs ?? POLICY.limits.conference.runtimeMs) / 1000)}s.`,  
		"Routing: each selector event is a host-owned llama.cpp native-GBNF continue-or-report choice from a host-computed eligible set; the immediately prior speaker is excluded.",
	];
	if (record.active?.kind === "participant") lines.push(record.active.phase === "report" ? "Current participant: cartographer, host-authorized to write the final advisory." : `Current participant: ${record.active.participant}.`);
	else if (record.active?.kind === "selector") lines.push(`Current state: neutral selector after ${record.active.previousSpeaker ?? "the prior participant"}.`);
	lines.push(`Roster v${record.roster?.version ?? ROSTER_VERSION}: ${CONSULT_ROSTER.map((member) => {
		const source = record.bookSources?.[member.id];
		return member.id === "cartographer" ? "cartographer (opening persona)" : `${member.id}${source?.empty ? " (empty entry snapshot)" : ""}${source?.unavailable ? " (unavailable at entry)" : ""}`;
	}).join(", ")}.`);
	if (!audit) return lines.join("\n");

	lines.push("Captured common sources:");
	for (const source of sources) lines.push(`  ${sourceLine(source)}`);
	lines.push("Private participant packets:");
	lines.push(`  cartographer · opening persona · sha256 ${record.myPersona?.digest ?? "missing"}.`);
	for (const member of CONSULT_ROSTER.filter((entry) => entry.id !== "cartographer")) {
		const source = record.bookSources?.[member.id];
		lines.push(source === undefined
			? `  ${member.id} · ${member.book} entry snapshot missing.`
			: `  ${member.id} · ${sourceLine(source)}${source.empty ? " · empty snapshot" : ""}.`);
	}
	if (plans.length > 0) {
		lines.push("Request-plan audit:");
		for (const plan of plans) {
			if (plan.kind === "native-selector") {
				lines.push(`  ${plan.index}. raw native selector · ${plan.stableMessages} bounded decision messages sha256 ${plan.stableDigest} · GBNF ${plan.tailChars} chars sha256 ${plan.tailDigest} · prior turns ${plan.historyTurns}, selections ${plan.historySelections}.`);
			} else {
				lines.push(`  ${plan.index}. ${plan.kind} participant request · ${plan.stableMessages} shared messages · stable sha256 ${plan.stableDigest} · transient ${plan.tailChars} chars sha256 ${plan.tailDigest} · prior turns ${plan.historyTurns}, selections ${plan.historySelections}.`);
			}
		}
	}
	if (activities.length > 0) {
		lines.push("Participant activity timeline:");
		for (const activity of activities) {
			const kinds = [
				activity.reasoning ? `reasoning${activity.reasoningClipped ? " (clipped)" : ""}` : undefined,
				activity.prose ? `prose${activity.proseClipped ? " (clipped)" : ""}` : undefined,
				Array.isArray(activity.calls) && activity.calls.length > 0 ? `tools ${activity.calls.map((call) => call.name).join(", ")}` : undefined,
			].filter((kind) => kind !== undefined);
			lines.push(`  ${activity.index}. ${activity.participant} · ${activity.at} · ${kinds.join(" · ") || "empty response"}.`);
		}
	}
	if (turns.length > 0) {
		lines.push("Participant turns:");
		for (const turn of turns) lines.push(`  ${turn.index}. ${turn.participant} · ${turn.at}${turn.text ? ` · ${flat(turn.text).slice(0, 240)}` : " · (no prose)"}`);
	}
	if (selections.length > 0) {
		lines.push("Selector events:");
		for (const event of selections) {
			const method = event.method ?? (event.payloadObserved === true ? "archived legacy selector" : "unknown selector method");
			const enforced = event.grammarEnforced === true || event.payloadObserved === true;
			const native = event.native === undefined ? "" : ` · HTTP ${event.native.status}${event.native.finishReason === undefined ? "" : ` · ${event.native.finishReason}`}${event.native.elapsedMs === undefined ? "" : ` · ${event.native.elapsedMs} ms`}`;
			const decision = event.decision === "report" ? "authorize Cartographer final report" : `continue with ${event.participant}`;
			const debate = event.debate === undefined ? "" : ` · debate ${event.debate.turns}/${event.debate.debateTurns} turns, ${event.debate.participants?.length ?? 0}/${event.debate.debateParticipants} members${event.debate.ready ? " ready" : " not ready"}`;
			lines.push(`  ${event.index}. after ${event.after} → ${decision}; eligible ${event.eligible.join(", ")} · ${method} · grammar enforced ${enforced ? "yes" : "no"}${debate}${native} · ${event.at}.`);
		}
	}
	if ((record.toolReceipts ?? []).length > 0) {
		lines.push("Consult-local tool receipts:");
		for (const receipt of record.toolReceipts) {
			const facts = [receipt.id ?? receipt.action ?? "receipt", receipt.participant, receipt.action, receipt.source, receipt.range === undefined ? undefined : `range ${receipt.range}`, receipt.pattern === undefined ? undefined : `pattern ${JSON.stringify(receipt.pattern)}`, receipt.hits === undefined ? undefined : `${receipt.hits} hits`, receipt.isError ? "refused" : undefined, typeof receipt.result === "string" && receipt.result !== "" ? `result ${flat(receipt.result).slice(0, 240)}${receipt.resultClipped ? " (clipped)" : ""}` : undefined, receipt.at, receipt.digest === undefined ? undefined : `sha256 ${receipt.digest}`].filter((value) => value !== undefined);
			lines.push(`  ${facts.join(" · ")}.`);
		}
	}
	if (record.final !== undefined) {
		const final = record.final;
		lines.push(`Final return by ${final.participant} (${final.outcome}) at ${final.at}:`, String(final.synthesis ?? ""));
		if (final.recommendation) lines.push(`Recommendation: ${final.recommendation}`);
		if (final.evidence?.length > 0) {
			lines.push("Evidence citations (snapshot references, not proof):");
			for (const evidence of final.evidence) lines.push(`  ${evidence.source} · ${evidence.claim}`);
		}
		for (const [label, items] of [["Assumptions", final.assumptions], ["Uncertainties", final.uncertainties], ["Alternatives", final.alternatives], ["Next checks", final.next_checks]]) {
			if (!Array.isArray(items) || items.length === 0) continue;
			lines.push(`${label}:`);
			for (const item of items) lines.push(`  ${typeof item === "object" ? `${item.option} — ${item.tradeoff}` : item}`);
		}
		if (final.blocking_question) lines.push(`Blocking question: ${final.blocking_question}`);
		const packet = final.provenance?.participantPacket;
		if (packet !== undefined) lines.push(`Final provenance: ${packet.kind}${packet.id === undefined ? "" : ` ${packet.id}`} · sha256 ${packet.digest}.`);
		if (final.provenance?.selectorHistory?.length > 0) lines.push(`Final selector history: ${final.provenance.selectorHistory.map((event) => `${event.after}→${event.participant}`).join(", ")}.`);
		lines.push(`Final artifact digest: ${final.digest}.`);
	} else if (record.ended !== undefined) {
		lines.push(`No synthesis was fabricated. Ended ${record.status} at ${record.ended.at}: ${record.ended.reason}`);
	} else lines.push("No final synthesis stands yet; only the host may mark this conference ended.");
	return lines.join("\n");
}

/** A compact parent-facing result; private notebook material remains in the audit record. */
export function renderConferenceResult(record) {
	if (record.final !== undefined) {
		const final = record.final;
		const recommendation = typeof final.recommendation === "string" && final.recommendation.trim() !== "" ? ` Recommendation: ${final.recommendation}` : "";
		const uncertainty = Array.isArray(final.uncertainties) && final.uncertainties.length > 0 ? ` Uncertainties: ${final.uncertainties.join("; ")}` : "";
		return `Consult conference ${record.id} returned ${final.outcome} from ${final.participant}. ${final.synthesis}${recommendation}${uncertainty} This remains advisory material; verify current facts and keep user-value decisions with the user.`;
	}
	return `Consult conference ${record.id} ended ${record.status} without a final synthesis: ${record.ended?.reason ?? "no consult_return was recorded"}. No conclusion was fabricated.`;
}

/** Validate the structured terminal object before it becomes an auditable final result. */
export function validateConsultReturn(args, { sourceIds } = {}) {
	const outcomes = new Set(["answered", "unresolved", "needs_input", "blocked"]);
	const outcome = String(args?.outcome ?? "");
	const synthesis = flat(args?.synthesis);
	if (!outcomes.has(outcome)) throw new ConferenceError("consult_return outcome must be answered, unresolved, needs_input, or blocked.");
	if (synthesis === "") throw new ConferenceError("consult_return needs a non-empty synthesis.");
	if (synthesis.length > POLICY.limits.conference.returnChars) throw new ConferenceError(`consult_return synthesis must be ${POLICY.limits.conference.returnChars} characters or fewer.`);
	const strings = (value, field, maximum = POLICY.limits.conference.returnItems) => {
		if (value === undefined) return [];
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || flat(item) === "")) throw new ConferenceError(`consult_return ${field} must be a list of non-empty strings.`);
		if (value.length > maximum) throw new ConferenceError(`consult_return ${field} has too many entries.`);
		return value.map((item) => flat(item));
	};
	const evidence = args?.evidence === undefined ? [] : args.evidence;
	if (!Array.isArray(evidence) || evidence.some((entry) => entry === null || typeof entry !== "object" || typeof entry.source !== "string" || typeof entry.claim !== "string")) {
		throw new ConferenceError("consult_return evidence must be a list of { source, claim } objects.");
	}
	if (evidence.length > POLICY.limits.conference.returnItems) throw new ConferenceError("consult_return evidence has too many entries.");
	const knownSources = sourceIds === undefined ? undefined : new Set([...sourceIds].map((id) => String(id)));
	const normalizedEvidence = evidence.map((entry) => ({ source: flat(entry.source), claim: flat(entry.claim) }));
	if (normalizedEvidence.some((entry) => entry.source === "" || entry.claim === "")) throw new ConferenceError("consult_return evidence source and claim must both be non-empty.");
	if (knownSources !== undefined && normalizedEvidence.some((entry) => !knownSources.has(entry.source))) {
		throw new ConferenceError("consult_return evidence may cite only this conference's immutable source ids.");
	}
	const recommendation = flat(args?.recommendation);
	if (recommendation.length > POLICY.limits.conference.returnChars) throw new ConferenceError(`consult_return recommendation must be ${POLICY.limits.conference.returnChars} characters or fewer.`);
	const alternatives = args?.alternatives === undefined ? [] : args.alternatives;
	if (!Array.isArray(alternatives) || alternatives.some((entry) => entry === null || typeof entry !== "object" || typeof entry.option !== "string" || typeof entry.tradeoff !== "string" || flat(entry.option) === "" || flat(entry.tradeoff) === "")) {
		throw new ConferenceError("consult_return alternatives must be a list of { option, tradeoff } objects with non-empty strings.");
	}
	if (alternatives.length > POLICY.limits.conference.returnItems) throw new ConferenceError("consult_return alternatives has too many entries.");
	const blockingQuestion = args?.blocking_question === undefined ? undefined : flat(args.blocking_question);
	if (blockingQuestion !== undefined && blockingQuestion.length > POLICY.limits.conference.returnChars) throw new ConferenceError(`consult_return blocking_question must be ${POLICY.limits.conference.returnChars} characters or fewer.`);
	if (outcome === "needs_input" && !blockingQuestion) throw new ConferenceError("consult_return with needs_input requires blocking_question.");
	return {
		outcome,
		synthesis,
		...(recommendation === "" ? {} : { recommendation }),
		evidence: normalizedEvidence,
		assumptions: strings(args?.assumptions, "assumptions"),
		uncertainties: strings(args?.uncertainties, "uncertainties"),
		alternatives: alternatives.map((entry) => ({ option: flat(entry.option), tradeoff: flat(entry.tradeoff) })),
		next_checks: strings(args?.next_checks, "next_checks"),
		...(blockingQuestion ? { blocking_question: blockingQuestion } : {}),
	};
}

/** Used by migration code to produce safe relative archive labels. */
export const archiveLabel = (brainDir, path) => relative(brainDir, path).replace(/\\/g, "/");
