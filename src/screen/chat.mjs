// Conversation, Work, and Consult are three subtabs of the same local Chat event feed.
//
// Conversation holds only the user's submitted speech and an agent `chat` call while it is sending or after its result says
// it was delivered. Work holds private reasoning, ordinary agent notes, calls/results, failures, harness notices,
// and request blocks. Consult is a separate local projection of private co<N> conference records and child streams;
// its material never enters Conversation or Work. A failed `chat` call leaves Conversation and stands in Work as a failed speech attempt. Work keeps the
// old useful grouping: a run is one line, "▸ 20 calls · 1m 12s"; opening it shows its calls and results, or leads
// to the tab where that work lives (a write to Diff, a command to Shells, the plan to Carto).
//
// How it looks is a hierarchy, and a line says where it stands in it (src/screen/theme.mjs has the colours):
//   what you say           a block in your hue, bold
//   what the agent says    plain text on the screen's own background, as Markdown: the most readable thing there is
//   what the agent does    a block in the tools' hue; a mark at full strength for each call, the rest muted
//   what Cartographer says muted, with its mark picked out; a warning in the colour of attention
//   notes and thinking     faint and italic, on a quiet violet block with a fine rail
// Blocks of different kinds stand a blank row apart, and what a task leaves behind stands right under its run.
//
// This file is the model: items in, lines out. A line is { spans, bg?, styled?, … }: `bg` names the block it
// belongs to, and `styled` is the line with its escape sequences when a Markdown renderer made it. It draws
// nothing and knows no terminal (src/screen/app.mjs does).
import { POLICY } from "../config.mjs";
import { describeCall, describeResult } from "../terminal.mjs";
import { isFront } from "../context.mjs";
import { splitTop } from "../top.mjs";
import { CONSULT_ROSTER } from "../conference.mjs";
import { cut, repeats, span, width, wrap } from "./text.mjs";

/** How many of a run's newest calls are shown while it is going on. */
const LIVE_ROWS = POLICY.limits.screen.chatLiveRows;
/** How many rows of a call body or consultation tail are shown while it is being written. */
const LIVE_TEXT_ROWS = POLICY.limits.screen.chatLiveTextRows;
/** How many rows of live reasoning stay in Chat until it is opened deliberately. */
const LIVE_NOTE_ROWS = POLICY.limits.screen.notePreviewLines;
/** The most of one result that is kept for opening it in place. */
const DETAIL_MAX = POLICY.limits.screen.chatDetailChars;
/** The most rows an opened result shows; the rest is in the tab it leads to, or in /report. */
const DETAIL_ROWS = POLICY.limits.screen.chatDetailRows;
/** The most rows an opened request block shows (the state block and the copy at the top of the context). */
const BLOCK_ROWS = DETAIL_ROWS * 2;
/** Items kept; older ones leave the tab (they stay in the session and in the export of what is left). */
const ITEMS_MAX = POLICY.limits.screen.chatItems;

/** An empty row between two blocks. One for all of them, so that it is painted once. */
const BLANK = { spans: [] };

/** The tab a call's work lives in, and the view inside it. */
export function homeOf(name, args = {}) {
	if (name === "book") {
		const target = args?.target;
		if (target === "file" && (args?.action === "create" || args?.action === "edit" || args?.action === "remove")) return { tab: "diff" };
		if (target === "ledger" || target === "plan" || target === "atlas") return { tab: "carto", view: target };
		// The assessment rides in the context tab's copied top block; it has no view of its own.
		if (target === "assessment") return { tab: "context", view: "window" };
		if (target === "context") return { tab: "context" };
		return undefined;
	}
	if (name === "write" || name === "edit") return { tab: "diff" };
	if (name === "shell") return { tab: "shells" };
	if (name === "plan") return { tab: "carto", view: "plan" };
	if (name === "ledger") return { tab: "carto", view: "ledger" };
	if (name === "assess") return { tab: "context", view: "window" };
	if (name === "context" || name === "shelf") return { tab: "context" };
	return undefined;
}

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
const thinkingOf = (message) => (message?.content ?? []).flatMap((part) => (part.type === "thinking" ? [part.thinking ?? ""] : [])).join("\n");
/** What the live note shows and copies: the model's reasoning followed by its ordinary text. */
const noteOf = (message) => [thinkingOf(message), textOf(message)].filter((part) => part.trim() !== "").join("\n");
const callsOf = (message) => (Array.isArray(message?.content) ? message.content.filter((part) => part.type === "toolCall") : []);
/** A Conversation item is direct two-party speech. Failed delivery is private work, not a statement that reached the user. */
const inTalk = (item) => item?.type === "user" || (item?.type === "agent" && item.delivery !== "failed");
/** The visible identity cue is deliberately an admitted Durable entry, never the visible saying or a local row number. */
const sourceLabel = (source) => source?.kind === "durable-message" ? ` · Durable ${source.entryId}/${source.position}` : " · source pending";
const privateLabel = (kind) => {
	if (kind === "reasoning") return "Private reasoning · provider response · replay: provider-bound";
	if (kind === "note") return "Agent note · provider response · replay: active-context dependent";
	return kind;
};
const plain = (text) => text.replace(/<\/?harness>/g, "").replace(/\[error\] (Tool call blocked: )?/, "").trim();
/** The argument of a call that is worth watching while it is written: the longest text in it. */
function bodyOf(call) {
	const args = call.arguments ?? {};
	let best = "";
	for (const key of ["content", "newText", "new_text", "oldText", "old_text", "command", "brief", "report", "detail", "gist", "text", "done_when", "input", "context", "question"]) {
		if (typeof args[key] === "string" && args[key].length > best.length) best = args[key];
	}
	return best;
}

/** The newest rows of a live reply, with how many earlier rows the compact view leaves out. */
function previewTail(text, cols, rows) {
	const wrapped = wrap(text, cols);
	const omitted = Math.max(0, wrapped.length - rows);
	return { lines: wrapped.slice(omitted), omitted };
}

const CONSULT_MEMBERS = new Map(CONSULT_ROSTER.map((member) => [member.id, member]));
const personaName = (id) => CONSULT_MEMBERS.get(id)?.name ?? (typeof id === "string" && id !== "" ? `${id.slice(0, 1).toUpperCase()}${id.slice(1)}` : "Conference host");
const selectorLabel = (selection) => selection?.decision === "report" ? "Conference host · native final-report decision" : "Conference host · native debate routing";
const consultCall = (call) => {
	const args = call?.arguments ?? call?.args ?? {};
	if (call?.name === "consult_source" || call?.action !== undefined) {
		const action = args.action ?? call.action ?? "inspect";
		const source = args.id ?? call.source;
		const range = args.range ?? call.range;
		const pattern = args.pattern ?? call.pattern;
		return `consult_source · ${action}${source === undefined ? "" : ` ${source}`}${range === undefined || range === "" ? "" : ` · lines ${range}`}${pattern === undefined || pattern === "" ? "" : ` · ${JSON.stringify(pattern)}`}`;
	}
	if (call?.name === "consult_return" || call?.action === "return") return "consult_return · advisory synthesis";
	return `${call?.name ?? call?.action ?? "consult tool"}${Object.keys(args).length === 0 ? "" : ` · ${cut(JSON.stringify(args), 120)}`}`;
};
const consultResult = (receipt) => {
	if (typeof receipt?.result === "string" && receipt.result !== "") return receipt.result;
	if (receipt?.action === "search") return `${receipt.hits ?? 0} ${receipt.hits === 1 ? "match" : "matches"}${receipt.source === undefined ? "" : ` in ${receipt.source}`}.`;
	if (receipt?.action === "list") return `Listed ${(receipt.sources ?? []).length} immutable common ${(receipt.sources ?? []).length === 1 ? "source" : "sources"}.`;
	if (receipt?.action === "read") return `Read immutable source ${receipt.source ?? "(unknown)"}${receipt.range === undefined ? "" : ` · lines ${receipt.range}`}.`;
	return "No retained result text.";
};
const resultSignature = (record) => {
	try { return JSON.stringify(record); } catch { return String(record?.id ?? ""); }
};

/**
 * @param {{ now?: () => number, markdown?: (text: string, cols: number) => { styled: string, cells: number, text: string }[], describeRef?: (ref: object) => string | undefined, readFile?: (rel: string) => string | undefined, readConference?: (id: string) => object | undefined, listConferences?: () => { id: string, conference?: object }[] }} options
 *   markdown: renders what the agent says; without it, the text is wrapped as it is
 *   readConference/listConferences: read consult-local co<N> audit records only for the dedicated Consult
 *   projection. Their private material is never copied into a parent conversation or ordinary Work projection.
 */
export function createChat({ now = () => Date.now(), markdown, describeRef, readConference, listConferences } = {}) {
	/** @type {any[]} */
	const items = [];
	const rows = new Map(); // call id -> row
	const live = new Map(); // depth -> the reply being written there
	const toolTails = new Map(); // call id -> the tail of a running tool's output, as the harness keeps it
	// Consultations have their own local projection. Nothing in this map is an ordinary parent Chat item or becomes
	// parent context: ids point only at co<N> audit records and transient child-conversation display events.
	const consultations = new Map(); // co<N> (or provisional parent-call key) -> session
	const consultByCall = new Map(); // parent/child tool call id -> session key
	const consultLive = new Map(); // child depth -> currently-streaming participant reply
	let thinking = true;
	// Counted up when the colours change: what was rendered with the old ones is made again.
	let styleRev = 0;
	let serial = 0;
	let version = 0;
	const touch = () => {
		version++;
	};
	const push = (item) => {
		item.key = ++serial;
		items.push(item);
		if (items.length > ITEMS_MAX) items.splice(0, items.length - ITEMS_MAX);
		touch();
		return item;
	};
	/** The run of calls that is going on, or a new one. */
	const group = () => {
		const last = items.at(-1);
		if (last?.type === "group" && !last.closed) return last;
		return push({ type: "group", rows: [], open: false, closed: false, started: now() });
	};
	/** What is said ends the run before it. */
	const closeGroup = () => {
		const last = items.at(-1);
		if (last?.type === "group" && !last.closed) {
			last.closed = true;
			last.ended = now();
		}
	};
	const say = (item) => {
		closeGroup();
		return push({ at: now(), ...item });
	};


	const consultKey = (id, callId) => (typeof id === "string" && /^co\d+$/.test(id) ? `consult:${id}` : `consult:pending:${String(callId ?? ++serial)}`);
	const mergeConsult = (target, source) => {
		if (target === source) return target;
		for (const [key, event] of source.events) if (!target.events.has(key)) target.events.set(key, event);
		target.eventOpen ??= new Map();
		for (const [key, open] of source.eventOpen ?? []) if (!target.eventOpen.has(key)) target.eventOpen.set(key, open);
		for (const [id, call] of source.calls) if (!target.calls.has(id)) target.calls.set(id, call);
		for (const [id, tool] of source.liveTools) if (!target.liveTools.has(id)) target.liveTools.set(id, tool);
		target.question ??= source.question;
		target.receipt ??= source.receipt;
		target.outerState ??= source.outerState;
		if (source.record !== undefined && target.record === undefined) {
			target.record = source.record;
			target.recordSign = source.recordSign;
		}
		for (const [callId, key] of consultByCall) if (key === source.key) consultByCall.set(callId, target.key);
		for (const [depth, current] of consultLive) if (current.key === source.key) current.key = target.key;
		consultations.delete(source.key);
		return target;
	};
	const ensureConsult = ({ id, callId, question, depth } = {}) => {
		const wanted = consultKey(id, callId);
		const known = callId === undefined ? undefined : consultations.get(consultByCall.get(callId));
		let session = consultations.get(wanted);
		if (session === undefined && known !== undefined) {
			if (wanted !== known.key) {
				const oldKey = known.key;
				consultations.delete(oldKey);
				known.key = wanted;
				known.id = typeof id === "string" && /^co\d+$/.test(id) ? id : known.id;
				consultations.set(wanted, known);
				for (const [knownCall, key] of consultByCall) if (key === oldKey) consultByCall.set(knownCall, wanted);
			}
			session = known;
		} else if (session !== undefined && known !== undefined && session !== known) session = mergeConsult(session, known);
		if (session === undefined) {
			session = {
				key: wanted,
				id: typeof id === "string" && /^co\d+$/.test(id) ? id : undefined,
				question: typeof question === "string" && question.trim() !== "" ? question : undefined,
				open: true,
				events: new Map(),
				eventOpen: new Map(),
				calls: new Map(),
				liveTools: new Map(),
			};
			consultations.set(wanted, session);
		}
		if (typeof id === "string" && /^co\d+$/.test(id)) session.id = id;
		if (typeof question === "string" && question.trim() !== "") session.question = question;
		if (callId !== undefined) consultByCall.set(callId, session.key);
		if (depth !== undefined) session.depth = depth;
		return session;
	};
	const updateConsultRecord = (session, record) => {
		if (record === undefined || record === null || typeof record !== "object") return false;
		const sign = resultSignature(record);
		const changed = session.recordSign !== sign;
		session.record = record;
		session.recordSign = sign;
		session.id ??= typeof record.id === "string" ? record.id : undefined;
		session.question ??= typeof record.question === "string" ? record.question : undefined;
		return changed;
	};
	const readConsult = (session) => {
		if (session.id === undefined || typeof readConference !== "function") return session.record;
		try { updateConsultRecord(session, readConference(session.id)); } catch { /* An unreadable private audit is named in Consult rather than copied elsewhere. */ }
		return session.record;
	};
	const syncConsults = ({ discover = false } = {}) => {
		let changed = false;
		const loaded = new Set();
		if (discover && typeof listConferences === "function") {
			try {
				for (const listed of listConferences() ?? []) {
					const id = typeof listed?.id === "string" ? listed.id : listed?.conference?.id;
					if (id === undefined || !/^co\d+$/.test(id)) continue;
					const session = ensureConsult({ id, question: listed?.conference?.question });
					if (listed?.conference !== undefined) {
						changed = updateConsultRecord(session, listed.conference) || changed;
						loaded.add(session.key);
					}
				}
			} catch { /* A broken consult directory is rendered as an empty/unavailable view, never as parent work. */ }
		}
		for (const session of consultations.values()) {
			if (loaded.has(session.key)) continue;
			const before = session.recordSign;
			readConsult(session);
			if (before !== session.recordSign) changed = true;
		}
		return changed;
	};
	const activityParticipant = (session, message, fallback) => {
		// Terminal ownership propagation carries the active persona for a current child response. Never synchronously
		// read co<N> merely to guess a historic one: only a deliberate Consult paint may load that private audit.
		if (fallback !== undefined) return fallback;
		const record = session.record;
		const calls = callsOf(message);
		const prose = textOf(message).trim();
		const ids = new Set(calls.map((call) => call.id).filter((id) => typeof id === "string"));
		const activity = record?.activities?.findLast?.((entry) => entry?.participant && (
			(ids.size > 0 && Array.isArray(entry.calls) && entry.calls.some((call) => ids.has(call.id))) ||
			(ids.size === 0 && typeof entry.prose === "string" && entry.prose === prose)
		));
		const turn = ids.size === 0 && prose !== "" ? record?.turns?.findLast?.((entry) => entry?.participant && entry.text === prose) : undefined;
		return activity?.participant ?? turn?.participant ?? (calls.some((call) => call.name === "consult_return") ? record?.final?.participant : undefined);
	};
	const addConsultEvent = (session, event) => {
		const old = session.events.get(event.key);
		if (old === undefined || resultSignature(old) !== resultSignature(event)) session.events.set(event.key, { ...old, ...event });
	};
	const consultEntry = (depth, entry, consult) => {
		const session = ensureConsult({ id: consult?.conference, depth });
		if (consult?.status !== undefined) session.status = consult.status;
		for (const [position, message] of (entry.model ?? []).entries()) {
			const source = `${entry?.id ?? message.timestamp ?? `replay-${(session.eventSerial = (session.eventSerial ?? 0) + 1)}`}:${position}`;
			if (message.role === "assistant") {
				const participant = activityParticipant(session, message, consult?.participant);
				if (participant === undefined) continue;
				const reasoning = thinkingOf(message).trim();
				const prose = textOf(message).trim();
				if (reasoning !== "") addConsultEvent(session, { key: `stream:${source}:reasoning`, at: message.timestamp, participant, type: "reasoning", text: reasoning, live: false });
				if (prose !== "") addConsultEvent(session, { key: `stream:${source}:prose`, at: message.timestamp, participant, type: "prose", text: prose, live: false });
				for (const call of callsOf(message)) {
					const callId = typeof call.id === "string" ? call.id : `${source}:${call.name}`;
					session.calls.set(callId, { participant, call, at: message.timestamp });
					consultByCall.set(callId, session.key);
					addConsultEvent(session, { key: `stream:${source}:call:${callId}`, at: message.timestamp, participant, type: "tool-call", call, callId, live: false });
				}
				consultLive.delete(depth);
			} else if (message.role === "toolResult") {
				const known = session.calls.get(message.toolCallId);
				const participant = known?.participant ?? consult?.participant ?? session.record?.active?.participant ?? session.record?.final?.participant;
				if (participant === undefined) continue;
				const body = textOf(message);
				addConsultEvent(session, { key: `stream:${source}:result:${message.toolCallId}`, at: message.timestamp, participant, type: "tool-result", call: known?.call, callId: message.toolCallId, text: body, isError: message.isError === true, live: false });
				session.liveTools.delete(message.toolCallId);
			}
		}
		return session;
	};

	const eventTime = (at, fallback) => {
		if (typeof at === "number" && Number.isFinite(at)) return at;
		const parsed = Date.parse(String(at ?? ""));
		return Number.isFinite(parsed) ? parsed : fallback;
	};
	const consultEvents = (session, record) => {
		const events = [];
		let order = 0;
		const add = (event) => events.push({ ...event, order: ++order });
		const activities = Array.isArray(record?.activities) ? record.activities : [];
		const durableCallIds = new Set();
		const durableResults = new Set();
		const matchedReceiptCalls = new Set();
		// A digest-less replay event can only be paired with durable prose by content. Keep a count rather than a
		// boolean: repeated identical contributions are distinct events and must not erase one another from Consult.
		const durableTextEvents = new Map();
		const textKey = (participant, type, text) => `${participant ?? ""}\u0000${type}\u0000${text ?? ""}`;
		const noteDurableText = (participant, type, text) => {
			const key = textKey(participant, type, text);
			durableTextEvents.set(key, (durableTextEvents.get(key) ?? 0) + 1);
		};
		for (const activity of activities) {
			const base = `audit:activity:${activity.index ?? activity.digest ?? ++order}`;
			if (typeof activity.reasoning === "string" && activity.reasoning !== "") {
				noteDurableText(activity.participant, "reasoning", activity.reasoning);
				add({ key: `${base}:reasoning`, at: activity.at, participant: activity.participant, type: "reasoning", text: activity.reasoning, clipped: activity.reasoningClipped === true, chars: activity.reasoningChars });
			}
			if (typeof activity.prose === "string" && activity.prose !== "") {
				noteDurableText(activity.participant, "prose", activity.prose);
				add({ key: `${base}:prose`, at: activity.at, participant: activity.participant, type: "prose", text: activity.prose, clipped: activity.proseClipped === true, chars: activity.proseChars });
			}
			for (const [index, call] of (activity.calls ?? []).entries()) {
				const callId = typeof call?.id === "string" ? call.id : undefined;
				if (callId !== undefined) {
					durableCallIds.add(callId);
					session.calls.set(callId, { participant: activity.participant, call, at: activity.at });
					consultByCall.set(callId, session.key);
				}
				add({ key: `${base}:call:${callId ?? index}`, at: activity.at, participant: activity.participant, type: "tool-call", call, callId });
			}
		}
		// Older co<N> records predate the activity timeline. Their completed prose remains attributable rather than
		// disappearing merely because the UI learned a richer schema later.
		if (activities.length === 0) for (const turn of record?.turns ?? []) {
			if (typeof turn?.text !== "string" || turn.text === "") continue;
			noteDurableText(turn.participant, "prose", turn.text);
			add({ key: `audit:turn:${turn.index ?? ++order}`, at: turn.at, participant: turn.participant, type: "prose", text: turn.text });
		}
		for (const receipt of record?.toolReceipts ?? []) {
			let callId = typeof receipt.callId === "string" ? receipt.callId : undefined;
			let known = callId === undefined ? undefined : session.calls.get(callId);
			// Very old/local direct callers may not retain a Durable call id on their receipt. Pair that receipt with an
			// unclaimed matching activity call before synthesizing a historic one, so one source read stays one call/result.
			if (known === undefined && callId === undefined) {
				const match = [...session.calls.entries()].findLast(([knownId, entry]) => {
					if (matchedReceiptCalls.has(knownId) || entry.participant !== receipt.participant) return false;
					const args = entry.call?.arguments ?? entry.call?.args ?? {};
					if (receipt.action === "return") return entry.call?.name === "consult_return" || args.action === "return";
					return (entry.call?.name === "consult_source" || args.action !== undefined)
						&& (receipt.action === undefined || String(args.action ?? entry.call?.action ?? "") === String(receipt.action))
						&& (receipt.source === undefined || String(args.id ?? entry.call?.source ?? "") === String(receipt.source))
						&& (receipt.range === undefined || String(args.range ?? entry.call?.range ?? "") === String(receipt.range))
						&& (receipt.pattern === undefined || String(args.pattern ?? entry.call?.pattern ?? "") === String(receipt.pattern));
				});
				if (match !== undefined) {
					[callId, known] = match;
					matchedReceiptCalls.add(callId);
				}
			}
			if (callId !== undefined) durableResults.add(callId);
			const call = known?.call ?? {
				name: receipt.action === "return" ? "consult_return" : "consult_source",
				arguments: {
					...(receipt.action === undefined ? {} : { action: receipt.action }),
					...(receipt.source === undefined ? {} : { id: receipt.source }),
					...(receipt.range === undefined ? {} : { range: receipt.range }),
					...(receipt.pattern === undefined ? {} : { pattern: receipt.pattern }),
				},
			};
			// Pre-activity audits retained only a receipt. Give that historic receipt an explicit inferred call block so
			// the Consult view still distinguishes what the persona asked from what it received.
			const receiptKey = receipt.index ?? receipt.callId ?? receipt.id ?? ++order;
			if (known === undefined) add({ key: `audit:receipt-call:${receiptKey}`, at: receipt.at, participant: receipt.participant, type: "tool-call", call, callId });
			add({ key: `audit:result:${receiptKey}`, at: receipt.at, participant: receipt.participant ?? known?.participant, type: "tool-result", call, callId, text: consultResult(receipt), isError: receipt.isError === true, clipped: receipt.resultClipped === true, chars: receipt.resultChars });
		}
		for (const selection of record?.selectorEvents ?? []) {
			const report = selection.decision === "report";
			const debate = selection.debate === undefined ? "" : ` Debate gate: ${selection.debate.turns}/${selection.debate.debateTurns} contributions and ${(selection.debate.participants ?? []).length}/${selection.debate.debateParticipants} members${selection.debate.ready ? " met" : " not met"}.`;
			add({
				key: `audit:selector:${selection.index ?? ++order}`,
				at: selection.at,
				type: "selector",
				participant: selection.participant,
				decision: selection.decision,
				text: report
					? `After ${personaName(selection.after)}, native GBNF concluded the bounded debate and authorized Cartographer to write the final advisory. Eligible: ${(selection.eligible ?? []).map(personaName).join(", ") || "none"}.${debate}${selection.grammarEnforced === true ? " Grammar enforced." : ""}${selection.native?.status === undefined ? "" : ` HTTP ${selection.native.status}.`}`
					: `After ${personaName(selection.after)} → ${personaName(selection.participant)} to continue the debate. Eligible: ${(selection.eligible ?? []).map(personaName).join(", ") || "none"}.${debate}${selection.grammarEnforced === true ? " Native GBNF grammar enforced." : ""}${selection.native?.status === undefined ? "" : ` HTTP ${selection.native.status}.`}`,
			});
		}
		if (record?.final !== undefined) {
			const final = record.final;
			const sections = [String(final.synthesis ?? "")];
			if (final.recommendation) sections.push(`Recommendation: ${final.recommendation}`);
			for (const [label, values] of [["Evidence", final.evidence], ["Assumptions", final.assumptions], ["Uncertainties", final.uncertainties], ["Alternatives", final.alternatives], ["Next checks", final.next_checks]]) {
				if (!Array.isArray(values) || values.length === 0) continue;
				sections.push(`${label}:\n${values.map((value) => `- ${typeof value === "object" ? `${value.source ?? value.option ?? ""}${value.claim ? ` · ${value.claim}` : value.tradeoff ? ` — ${value.tradeoff}` : ""}` : value}`).join("\n")}`);
			}
			if (final.blocking_question) sections.push(`Blocking question: ${final.blocking_question}`);
			add({ key: "audit:final", at: final.at, participant: final.participant, type: "final", outcome: final.outcome, text: sections.filter((section) => section.trim() !== "").join("\n\n") });
		} else if (record?.ended !== undefined) {
			add({ key: "audit:ended", at: record.ended.at, type: "status", text: `The conference ended ${record.status}: ${record.ended.reason}` , isError: record.status === "failed" || record.status === "blocked" });
		}
		for (const event of session.events.values()) {
			let duplicate = event.type === "tool-call"
				? event.callId !== undefined && durableCallIds.has(event.callId)
				: event.type === "tool-result"
					? event.callId !== undefined && durableResults.has(event.callId)
					: false;
			if (!duplicate && (event.type === "prose" || event.type === "reasoning")) {
				const key = textKey(event.participant, event.type, event.text);
				const matches = durableTextEvents.get(key) ?? 0;
				if (matches > 0) {
					durableTextEvents.set(key, matches - 1);
					duplicate = true;
				}
			}
			if (!duplicate) add(event);
		}
		for (const [depth, current] of consultLive) {
			if (current.key !== session.key || current.message === undefined) continue;
			const participant = current.participant ?? record?.active?.participant;
			if (participant === undefined) continue;
			const reasoning = thinkingOf(current.message).trim();
			const prose = textOf(current.message).trim();
			if (reasoning !== "") add({ key: `live:${depth}:reasoning`, at: now(), participant, type: "reasoning", text: reasoning, live: true });
			if (prose !== "") add({ key: `live:${depth}:prose`, at: now(), participant, type: "prose", text: prose, live: true });
			for (const call of callsOf(current.message)) {
				const callId = typeof call.id === "string" ? call.id : `live:${depth}:${call.name}`;
				session.calls.set(callId, { participant, call, at: now() });
				add({ key: `live:${depth}:call:${callId}`, at: now(), participant, type: "tool-call", call, callId, live: true });
			}
		}
		for (const [callId, tool] of session.liveTools) {
			const known = session.calls.get(callId);
			const participant = tool.participant ?? known?.participant ?? record?.active?.participant;
			if (participant === undefined) continue;
			add({ key: `live:tool:${callId}`, at: now(), participant, type: "tool-result", call: tool.call ?? known?.call, callId, text: tool.text === "" ? "Waiting for the consult-local tool result…" : tool.text, isError: false, clipped: tool.clipped, live: true });
		}
		return events.sort((left, right) => eventTime(left.at, left.order) - eventTime(right.at, right.order) || left.order - right.order);
	};
	const consultMemberStatus = (member, record, events) => {
		const id = member.id;
		const activity = events.filter((event) => event.participant === id && event.type !== "selector" && event.type !== "status");
		const active = record?.active?.kind === "participant" && record.active.participant === id;
		const final = record?.final?.participant === id;
		if (final) return `final advisory · ${record.final.outcome}`;
		if (active && record?.active?.phase === "report") return activity.some((event) => event.live) ? "writing host-authorized final advisory" : "host-authorized final advisory";
		if (active) return activity.some((event) => event.live) ? "speaking now" : "active · awaiting contribution";
		if (activity.length > 0) return `${activity.filter((event) => event.type === "prose").length} contribution${activity.filter((event) => event.type === "prose").length === 1 ? "" : "s"} · standing by`;
		if (record?.active?.kind === "selector" && (record.selectorEvents ?? []).at(-1)?.eligible?.includes(id)) return "eligible for host routing";
		return "ready · no contribution yet";
	};
	const consultExport = (session, eventKey) => {
		const record = readConsult(session);
		const events = consultEvents(session, record);
		const heading = `# Consultation ${session.id ?? "starting"}\n\n`;
		if (eventKey !== undefined) {
			const event = events.find((candidate) => candidate.key === String(eventKey));
			if (event === undefined) return "";
			const label = event.type === "selector" ? selectorLabel(event) : `${personaName(event.participant)} · ${event.type === "tool-call" ? "tool call" : event.type === "tool-result" ? "tool result" : event.type === "final" ? `final advisory · ${event.outcome}` : event.type}`;
			return `${label}\n\n${event.type === "tool-call" ? `${consultCall(event.call)}\n${JSON.stringify(event.call?.arguments ?? event.call?.args ?? {}, null, 2)}` : event.text ?? ""}\n`;
		}
		const rows = [heading, `Status: ${record?.status ?? session.outerState ?? "starting"}`, `Question: ${record?.question ?? session.question ?? "(not available yet)"}`, "", "## Roster", ""];
		for (const member of CONSULT_ROSTER) rows.push(`- ${member.name}: ${consultMemberStatus(member, record, events)}`);
		for (const event of events) {
			const label = event.type === "selector" ? selectorLabel(event) : `${personaName(event.participant)} · ${event.type === "tool-call" ? "tool call" : event.type === "tool-result" ? "tool result" : event.type === "final" ? `final advisory · ${event.outcome}` : event.type}`;
			rows.push("", `## ${label}`, "", event.type === "tool-call" ? `${consultCall(event.call)}\n\n\`\`\`json\n${JSON.stringify(event.call?.arguments ?? event.call?.args ?? {}, null, 2)}\n\`\`\`` : event.text ?? "");
		}
		return `${rows.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
	};
	const consultLines = (cols) => {
		syncConsults({ discover: true });
		const out = [];
		const inner = cols - 2;
		const add = (spans, ref = {}) => out.push({ spans, ...ref, ...(ref.bg !== undefined ? { pad: 1 } : {}) });
		const blank = () => { if (out.length > 0 && out.at(-1).spans.length > 0) out.push(BLANK); };
		if (consultations.size === 0) {
			add([["No consultation conferences yet", "muted"]], { kind: "consult-empty", bg: "bgTool" });
			add([["When Cartographer runs consult, its isolated member activity appears here — never in parent Conversation or Work.", "faint"]], { kind: "consult-empty", bg: "bgTool" });
			return out;
		}
		for (const session of consultations.values()) {
			// syncConsults just refreshed this local audit. Reuse that snapshot for this render so Consult does one read
			// per conference per paint, while still refreshing on every deliberate Consult view/refresh.
			const record = session.record ?? readConsult(session);
			const events = consultEvents(session, record);
			const id = session.id ?? "starting";
			const status = record?.status ?? session.outerState ?? session.status ?? "starting";
			const ref = { item: session.key, kind: "consult", bg: "bgTool" };
			blank();
			add([[session.open ? "▾ " : "▸ ", status === "failed" || status === "blocked" ? "err" : status === "running" ? "warn" : "tool"], [`Consultation ${id} · ${status}`, status === "returned" ? "ok bold" : status === "failed" || status === "blocked" ? "err bold" : "bold"]], ref);
			const question = record?.question ?? session.question ?? "Waiting for the parent consult call to publish its immutable conference id.";
			for (const piece of wrap(`Question · ${question}`, inner - 2)) add([["  ", "faint"], [piece, "muted"]], ref);
			const model = record?.model?.provider && record?.model?.modelId ? ` · same model ${record.model.provider}/${record.model.modelId}` : "";
			add([[`  Isolated private co<N> audit${model} · it is advisory and never enters parent context`, "faint"]], ref);
			const retained = [];
			if ((record?.activityCount ?? record?.activities?.length ?? 0) > (record?.activities?.length ?? 0)) retained.push(`${record?.activities?.length ?? 0}/${record.activityCount} participant activities`);
			if ((record?.toolReceiptCount ?? record?.toolReceipts?.length ?? 0) > (record?.toolReceipts?.length ?? 0)) retained.push(`${record?.toolReceipts?.length ?? 0}/${record.toolReceiptCount} local tool results`);
			if (retained.length > 0) add([[`  Retention · durable audit keeps newest ${retained.join(" · ")}`, "faint"]], ref);
			if (!session.open) continue;
			add([["  Members", "carto bold"]], ref);
			for (const member of CONSULT_ROSTER) {
				const memberStatus = consultMemberStatus(member, record, events);
				const active = record?.active?.kind === "participant" && record.active.participant === member.id;
				add([["  ○ ", active ? "warn" : "faint"], [`${member.name} · ${memberStatus}`, active ? "bold" : "muted"]], ref);
			}
			if (record === undefined && session.id !== undefined) add([["  ! The private conference record cannot be read yet; the parent receipt below is all that is available.", "err"]], ref);
			if (events.length === 0) {
				const pending = record?.active?.kind === "selector" ? `The host is choosing after ${personaName(record.active.previousSpeaker)} with native GBNF.` : record?.active?.participant ? `${personaName(record.active.participant)} has the active consult turn.` : "No member activity has been recorded yet.";
				add([["  ", "faint"], [pending, "faint"]], ref);
			}
			for (const event of events) {
				if (event.type === "reasoning" && !thinking) continue;
				blank();
				event.open = session.eventOpen?.get(event.key) ?? event.open ?? (session.openAllEvents === true);
				const eventRef = { item: session.key, row: event.key, kind: "consult-event", bg: event.type === "reasoning" ? "bgNote" : "bgTool" };
				const label = event.type === "selector"
					? selectorLabel(event)
					: event.type === "tool-call"
						? `${personaName(event.participant)} · tool call · ${consultCall(event.call)}`
						: event.type === "tool-result"
							? `${personaName(event.participant)} · tool result${event.call ? ` · ${consultCall(event.call)}` : ""}${event.live ? " · running" : event.isError ? " · refused" : " · completed"}`
							: event.type === "final"
								? `${personaName(event.participant)} · final advisory · ${event.outcome}`
								: event.type === "status"
									? "Conference host · status"
									: `${personaName(event.participant)} · ${event.type === "reasoning" ? "reasoning" : "chat / prose"}${event.live ? " · writing" : ""}`;
				const detail = event.type === "tool-call"
					? JSON.stringify(event.call?.arguments ?? event.call?.args ?? {}, null, 2)
					: event.text ?? "";
				const room = Math.max(8, inner - 4);
				const body = detail === "" ? [] : wrap(detail, room);
				const preview = event.type === "reasoning" ? LIVE_NOTE_ROWS : event.type === "tool-result" ? LIVE_TEXT_ROWS : DETAIL_ROWS;
				const expandable = body.length > preview;
				add([[expandable ? (event.open ? "  ▾ " : "  ▸ ") : "  · ", "faint"], [cut(label, inner - 4), event.isError ? "err" : event.type === "final" ? "ok bold" : event.type === "reasoning" ? "faint" : "bold"]], eventRef);
				for (const piece of (event.open ? body : body.slice(0, preview))) add([["    ", "faint"], [piece, event.isError ? "err" : event.type === "reasoning" ? "note italic" : "muted"]], eventRef);
				if (!event.open && body.length > preview) add([["    ", "faint"], [`… ${body.length - preview} more lines · Enter opens`, "faint"]], eventRef);
				if (event.clipped) add([["    ", "faint"], [`… retained result was clipped from ${event.chars ?? "a longer"} characters`, "faint"]], eventRef);
			}
			if (session.receipt !== undefined && record?.final === undefined && record?.ended === undefined) {
				blank();
				add([["  Parent receipt · the conference is still being read from its private audit", "faint"]], ref);
				for (const piece of wrap(plain(session.receipt), inner - 4)) add([["    ", "faint"], [piece, "muted"]], ref);
			}
		}
		return out;
	};

	const api = {
		get version() {
			return version;
		},
		items,
		/** Refresh consult-local audit files only while the caller deliberately asks for Consult. */
		refreshConsult() {
			const changed = syncConsults({ discover: true });
			if (changed) touch();
			return changed;
		},
		setThinking(on) {
			thinking = on;
			touch();
		},
		/** What the user typed. It becomes source-bound when its admitted Durable entry arrives; that handoff is FIFO,
		 * not a comparison of visible words. */
		user(text, { source, pending = source === undefined } = {}) {
			say({ type: "user", text, ...(source === undefined ? {} : { source }), ...(pending ? { pending: true } : {}) });
		},
		/** Bind an already-visible submitted row to its admitted source without matching on its text. */
		bindNextUser(source) {
			const item = items.find((entry) => entry.type === "user" && entry.pending === true);
			if (item === undefined) return false;
			item.source = source;
			delete item.pending;
			item.rev = (item.rev ?? 0) + 1;
			touch();
			return true;
		},

		/** Text from Cartographer itself: what a command printed, a notice. Consecutive pieces are one block. `{ keep: true }`: survives a collapse of the conversation. */
		print(text, options = {}) {
			const cleaned = String(text).replace(/\r\x1b\[2?K/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
			if (cleaned === "") return;
			const last = items.at(-1);
			if (last?.type === "console" && !last.sealed) {
				last.text += cleaned;
				if (options.keep === true) last.keep = true;
			} else say({ type: "console", text: cleaned, ...(options.keep === true ? { keep: true } : {}) });
			touch();
		},
		/** The block of printed text is complete: what is printed next starts a new one. */
		seal() {
			const last = items.at(-1);
			if (last?.type === "console") last.sealed = true;
		},
		/**
		 * A collapse of the main context: everything the agent could see before it is out of the tab, so only the
		 * marker of the collapse stands. Items flagged `keep` (what was said before the screen opened) survive.
		 */
		collapse() {
			for (let index = items.length - 1; index >= 0; index--) if (items[index].keep !== true) items.splice(index, 1);
			rows.clear();
			live.clear();
			touch();
		},
		/**
		 * A block the agent sees at the start or the end of its request — the copy at the top of the context, the
		 * state block, the shell windows block, the current read batch. One line until opened, the way a run of calls folds.
		 */
		block(label, text) {
			closeGroup();
			push({ type: "block", label: String(label).replace(/\s+/g, " ").trim(), text: String(text), open: false, at: now() });
		},
		/**
		 * One new entry of a conversation: depth 0 is the main agent, 1 a task. `printed` is what the plain
		 * terminal says about it, used for the outcome of a task and for a collapse.
		 */
		entry(depth, entry, printed = "", consult) {
			// Conference-child messages bypass ordinary Work altogether. They are still durable and selectable, but only
			// in Chat · Consult, preserving the consult/parent boundary while keeping live activity legible.
			if (consult?.conference !== undefined) {
				consultEntry(depth, entry, consult);
				touch();
				return;
			}
			const entrySource = (position, callId) => {
				const carried = entry.source?.kind === "durable-message" ? entry.source : undefined;
				const base = carried ?? (entry?.id === undefined || entry?.conversationId === undefined ? undefined : { kind: "durable-message", conversationId: String(entry.conversationId), entryId: String(entry.id), position });
				return base === undefined || callId === undefined ? base : { ...base, callId };
			};
			for (const [position, message] of (entry.model ?? []).entries()) {
				if (message.role === "assistant") {
					live.delete(depth);
					const reasoning = thinkingOf(message).trim();
					const note = textOf(message).trim();
					const calls = message.stopReason === "length" ? [] : callsOf(message);
					const privateRow = (kind, text) => {
						if (text === "") return;
						const row = { kind, depth, text, origin: "provider response" };
						if (depth === 0 && calls.length === 0) say({ type: kind, text, depth, origin: row.origin });
						else group().rows.push(row);
					};
					privateRow("reasoning", reasoning);
					privateRow("note", note);
					if (depth === 0 && message.stopReason === "length") say({ type: "console", text: `! The agent's reply was cut off at the output limit (maxTokens in the settings). Say "continue" to let it go on.\n`, sealed: true });
					for (const call of calls) {
						if (call.name === "chat") {
							const text = typeof call.arguments?.text === "string" ? call.arguments.text.trim() : "";
							const speech = text === "" ? undefined : say({ type: "agent", text, task: depth > 0, depth, callId: call.id, delivery: "sending", source: entrySource(position, call.id) });
							rows.set(call.id, { quiet: true, name: "chat", speech });
							continue;
						}
						const row = { kind: "call", depth, id: call.id, name: call.name, label: describeCall(call, describeRef), args: call.arguments ?? {}, state: "running", started: now(), ...(call.name === "ask" || call.name === "return" ? { hiddenInAll: true } : {}), ...(call.name === "consult" ? { hiddenInAll: true, hiddenInWork: true } : {}) };
						if (call.name === "consult") {
							const conference = ensureConsult({ callId: call.id, question: call.arguments?.question, depth });
							row.consultKey = conference.key;
							conference.outerState = "running";
						}
						rows.set(call.id, row);
						group().rows.push(row);
					}
					touch();
				} else if (message.role === "toolResult") {
					const row = rows.get(message.toolCallId);
					const text = textOf(message);
					if (row?.speech !== undefined) {
						row.speech.delivery = message.isError ? "failed" : "delivered";
						row.speech.result = message.isError ? cut(plain(text).replace(/\n/g, " "), POLICY.limits.screen.consoleErrorChars) : undefined;
						row.speech.rev = (row.speech.rev ?? 0) + 1;
						touch();
						continue;
					}
					if (row === undefined || row.quiet) {
						if (message.isError && row?.quiet) say({ type: "console", text: `! ${row.name ?? "chat"}: ${cut(plain(text).replace(/\n/g, " "), POLICY.limits.screen.consoleErrorChars)}\n`, sealed: true });
						continue;
					}
					row.state = message.isError ? "failed" : "done";
					row.ended = now();
					row.result = row.name === "task" ? (message.isError ? cut(plain(text).replace(/\n/g, " "), POLICY.limits.screen.taskErrorChars) : `report ${message.details?.report ?? ""}`.trim()) : describeResult(message) || undefined;
					// The consult's answer is not in the result (the receipt keeps the session lean); no detail to show.
					row.receipt = row.name === "consult" ? text : undefined;
					row.detail = row.name === "consult" ? undefined : text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}\n… (${text.length - DETAIL_MAX} more characters)` : text;
					row.details = message.details;
					if (row.name === "consult") {
						const conference = ensureConsult({ id: message.details?.conference, callId: row.id, question: row.args?.question, depth: row.depth });
						row.consultKey = conference.key;
						conference.outerState = row.state;
						conference.receipt = text;
						if (message.details?.conference !== undefined) delete row.conference;
					}
					// What a task leaves behind is said in full: the report line, changed files and declared move.
					if (depth === 0 && row.name === "task" && printed.trim() !== "") {
						const outcome = printed.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
						say({ type: "console", text: outcome.endsWith("\n") ? outcome : `${outcome}\n`, sealed: true, of: row.id });
					}
					touch();
				} else if (message.role === "user" && depth === 0 && isFront({ role: "user", content: [{ type: "text", text: splitTop(textOf(message)).text }] })) {
					// The front block of a collapse, whenever it reached the tab — live or replayed: everything the
					// agent could see before it is out of view, so only the marker stands.
					api.collapse();
					const said = printed.trim() !== "" ? printed.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") : "◆ the context was collapsed; /context shows it\n";
					say({ type: "console", text: said, sealed: true });
				} else if (message.role === "user" && depth === 0) {
					const text = textOf(message).trim();
					if (text !== "") {
						// A live submit already made its row. Bind the next lifecycle-pending row; replay has none and adds one.
						if (!api.bindNextUser(entrySource(position))) say({ type: "user", text, source: entrySource(position) });
					}
				}
			}
		},
		/** The reply that is being written at this depth, as far as it has come; undefined when none is. */
		live(depth, message, consult) {
			if (consult?.conference !== undefined) {
				if (message === undefined) {
					if (consultLive.delete(depth)) touch();
					return;
				}
				const session = ensureConsult({ id: consult.conference, depth });
				const before = consultLive.get(depth);
				const sameReply = before?.message?.timestamp === message.timestamp;
				consultLive.set(depth, { key: session.key, depth, message, participant: consult.participant ?? activityParticipant(session, message), since: sameReply ? before.since : now(), open: sameReply && before.open === true });
				touch();
				return;
			}
			if (message === undefined) {
				if (live.delete(depth)) touch();
				return;
			}
			const before = live.get(depth);
			const sameReply = before?.message.timestamp === message.timestamp;
			live.set(depth, { message, since: sameReply ? before.since : now(), open: sameReply && before.open === true });
			touch();
		},
		/** Open or fold the full live reasoning stream at one conversation depth. */
		toggleLive(depth, to) {
			const entry = live.get(depth);
			if (entry === undefined) return false;
			entry.open = to ?? !entry.open;
			touch();
			return true;
		},
		/** What running tools at this depth are saying, as far as the harness keeps it: bounded tails only. */
		liveTools(depth, slots, consult) {
			if (consult?.conference !== undefined) {
				const session = ensureConsult({ id: consult.conference, depth });
				let changed = false;
				const seen = new Set();
				for (const slot of slots ?? []) {
					if (slot?.callId === undefined || slot?.status !== "running") continue;
					seen.add(slot.callId);
					const known = session.calls.get(slot.callId);
					const participant = known?.participant ?? consult.participant ?? session.record?.active?.participant ?? session.record?.final?.participant;
					const next = { participant, call: known?.call, text: typeof slot.output === "string" ? slot.output : "", clipped: (slot.droppedBytes ?? 0) > 0, status: slot.status };
					if (resultSignature(session.liveTools.get(slot.callId)) !== resultSignature(next)) {
						session.liveTools.set(slot.callId, next);
						changed = true;
					}
				}
				for (const callId of [...session.liveTools.keys()]) if (!seen.has(callId)) {
					session.liveTools.delete(callId);
					changed = true;
				}
				if (changed) touch();
				return;
			}
			const next = new Map();
			let detailsChanged = false;
			for (const slot of slots ?? []) {
				if (slot?.callId === undefined || slot?.status !== "running") continue;
				// The parent-facing call carries only co<N> metadata. Link that outer call to its separate Consult
				// session; do not render its private notebook in Work.
				const row = rows.get(slot.callId);
				if (row?.name === "consult" && slot.details !== undefined) {
					const sign = JSON.stringify(slot.details);
					if (row.liveDetailsSign !== sign) {
						row.liveDetailsSign = sign;
						row.details = slot.details;
						const session = ensureConsult({ id: slot.details?.conference, callId: row.id, question: row.args?.question, depth: row.depth });
						row.consultKey = session.key;
						session.outerState = "running";
						delete row.conference;
						detailsChanged = true;
					}
				}
				if (typeof slot.output !== "string" || slot.output === "") continue;
				next.set(slot.callId, { text: slot.output, clipped: (slot.droppedBytes ?? 0) > 0 });
			}
			let same = next.size === toolTails.size;
			if (same) for (const [id, entry] of next) {
				const previous = toolTails.get(id);
				if (previous === undefined || previous.text !== entry.text || previous.clipped !== entry.clipped) {
					same = false;
					break;
				}
			}
			toolTails.clear();
			for (const [id, entry] of next) toolTails.set(id, entry);
			if (!same || detailsChanged) touch();
		},
		/** Whether the end of what is being written is the same thing over and over (src/screen/text.mjs). */
		stuck() {
			for (const { message } of live.values()) {
				const parts = [thinkingOf(message), textOf(message), ...callsOf(message).map((call) => bodyOf(call) || JSON.stringify(call.arguments ?? {}))];
				for (const part of parts) {
					const found = repeats(part);
					if (found !== undefined) return found;
				}
			}
			return undefined;
		},
		/** Roughly how many characters the replies being written hold: for the rate of writing. */
		liveSize() {
			let size = 0;
			for (const { message } of live.values()) size += thinkingOf(message).length + textOf(message).length + callsOf(message).reduce((sum, call) => sum + JSON.stringify(call.arguments ?? {}).length, 0);
			for (const { message } of consultLive.values()) size += thinkingOf(message).length + textOf(message).length + callsOf(message).reduce((sum, call) => sum + JSON.stringify(call.arguments ?? {}).length, 0);
			return size;
		},
		/** What the agent is doing now, in a few words, and where: { what, depth, task? }. */
		doing() {
			const last = items.at(-1);
			const running = last?.type === "group" && !last.closed ? last.rows.filter((row) => row.kind === "call" && row.state === "running") : [];
			const taskRow = running.find((row) => row.name === "task");
			const task = taskRow === undefined ? undefined : taskRow.args?.move ? `move ${taskRow.args.move}` : taskRow.args?.item ? `task ${taskRow.args.item}` : "task";
			const deepest = [...live.keys()].sort((a, b) => b - a)[0];
			if (deepest !== undefined) {
				const { message } = live.get(deepest);
				const call = callsOf(message).at(-1);
				if (call?.name === "chat" || call?.name === "ask") return { what: "writing to you", depth: deepest, task };
				if (call !== undefined) return { what: `writing ${cut(describeCall(call, describeRef).replace(/\s+/g, " "), POLICY.limits.screen.activeCallChars)}`, depth: deepest, task };
				if (textOf(message).trim() !== "") return { what: "writing a note", depth: deepest, task };
				return { what: "thinking", depth: deepest, task };
			}
			const liveConference = [...consultLive.values()].at(-1);
			if (liveConference !== undefined) {
				const participant = personaName(liveConference.participant);
				const call = callsOf(liveConference.message).at(-1);
				return { what: call === undefined ? `${participant} is thinking in consultation` : `${participant} is ${consultCall(call)}`, depth: liveConference.depth, task };
			}
			// The call that runs now: inside a task, the task's own call and not the task.
			const row = running.filter((entry) => entry !== taskRow).at(-1);
			if (row?.name === "consult") return { what: "the consultation conference is running", depth: row.depth, task };
			if (row !== undefined) return { what: cut(row.label.replace(/\s+/g, " "), POLICY.limits.screen.activeCallChars), depth: row.depth, task };
			if (taskRow !== undefined) return { what: "between two steps", depth: 1, task };
			return undefined;
		},
		/** The last agent speech whose chat result says it was delivered. */
		lastAgent: () => items.findLast((item) => item.type === "agent" && item.delivery === "delivered")?.text,
		toggle(key, to) {
			const consultation = consultations.get(String(key));
			if (consultation !== undefined) consultation.open = to ?? !consultation.open;
			else {
				const item = items.find((entry) => entry.key === key);
				if (item?.type === "group" || item?.type === "block") item.open = to ?? !item.open;
			}
			touch();
		},
		/** Open every run of calls and the live reasoning stream, or fold them all with what was opened inside them. */
		setAll(open) {
			for (const item of items) {
				if (item.type !== "group") continue;
				item.open = open;
				if (!open) for (const row of item.rows) row.open = false;
				item.rev = (item.rev ?? 0) + 1;
			}
			for (const entry of live.values()) entry.open = open;
			for (const consultation of consultations.values()) {
				consultation.open = open;
				consultation.openAllEvents = open;
				for (const event of consultation.events.values()) event.open = open;
			}
			touch();
		},
		/** The colours have changed: what was rendered with the old ones is rendered again. */
		restyle() {
			for (const item of items) delete item.md;
			styleRev++;
			touch();
		},
		/** The reply that is being written at a depth, as far as it has come. */
		liveMessage: (depth) => live.get(depth)?.message,
		/**
		 * Whether a message as it shows can be edited with e: the words of the user and of the agent. Tool work
		 * (a run of calls, a call with what it returned) cannot, nor what Cartographer printed.
		 */
		editable(key) {
			const item = items.find((entry) => entry.key === key);
			return item?.type === "user" || item?.type === "agent" || item?.type === "note";
		},
	/** A message said anew, as it shows. The conversation's stored entries cannot change; this changes the tab. */
	revise(key, text) {
		const item = items.find((entry) => entry.key === key);
		if (item === undefined || (item.type !== "user" && item.type !== "agent" && item.type !== "note")) return false;
		const said = String(text ?? "").replace(/\s+$/, "");
		if (said === "" || said === item.text) return false;
		item.text = said;
		item.rev = (item.rev ?? 0) + 1;
		delete item.md;
		touch();
		return true;
	},
	/** A source removed from future kept talk is gone from this local Conversation projection too. */
	forget(key) {
		const at = items.findIndex((entry) => entry.key === key);
		if (at < 0) return false;
		items.splice(at, 1);
		touch();
		return true;
	},
		toggleRow(key, index, to) {
			const consultation = consultations.get(String(key));
			if (consultation !== undefined) {
				const event = consultation.events.get(String(index));
				const prior = event?.open ?? consultation.eventOpen?.get(String(index)) ?? (consultation.openAllEvents === true);
				const next = to ?? !prior;
				consultation.eventOpen ??= new Map();
				consultation.eventOpen.set(String(index), next);
				if (event !== undefined) event.open = next;
			} else {
				const item = items.find((entry) => entry.key === key);
				const row = item?.rows?.[index];
				if (row !== undefined) {
					row.open = to ?? !row.open;
					item.rev = (item.rev ?? 0) + 1;
				}
			}
			touch();
		},

		/**
		 * The tab as lines of `cols` cells. Each line says what it belongs to, so that a selection or a click can
		 * act on it: { spans, item, row?, kind }.
		 */
		// `all` keeps the old mixed projection for direct callers during the migration; the screen names Conversation, Work, or Consult.
		lines(cols, projection = "all") {
			if (projection === "consult") return consultLines(cols);
			const out = [];
			// Where the lines being made go: the lines of one item while it is made, else the tab's.
			let sink = out;
			// A line of a block has a blank cell before its text, which the screen adds (`pad`).
			const add = (spans, ref = {}) => sink.push({ spans, ...ref, ...(ref.bg !== undefined ? { pad: 1 } : {}) });
			const blank = () => {
				if (out.length > 0 && out.at(-1).spans.length > 0) out.push(BLANK);
			};
			// So the text of a block is that much narrower, and a cell more at its right edge.
			const inner = cols - 2;
			/** What the agent says, as Markdown when a renderer is there. */
			const said = (text, ref, cache) => {
				if (markdown === undefined) {
					for (const piece of wrap(text, cols)) add([[piece, ""]], ref);
					return;
				}
				let rendered = cache?.md;
				if (rendered === undefined || rendered.cols !== cols || rendered.text !== text) {
					try {
						rendered = { cols, text, lines: markdown(text, cols) };
					} catch {
						rendered = { cols, text, lines: wrap(text, cols).map((piece) => ({ styled: piece, cells: width(piece), text: piece })) };
					}
					if (cache !== undefined) cache.md = rendered;
				}
				for (const line of rendered.lines) add([[line.text, ""]], { ...ref, styled: line.styled, cells: line.cells });
			};
			const callLine = (row) => {
				const mark = row.state === "running" ? "…" : row.state === "failed" ? "✗" : "✓";
				const style = row.state === "failed" ? "err" : row.state === "running" ? "warn" : "ok";
				const indent = row.depth > 0 ? "  │ " : "  ";
				const result = row.result !== undefined ? `  → ${row.result}` : row.state === "running" ? `  ${span(now() - row.started)}` : "";
				const source = row.depth > 0 ? "Focus" : "Main";
				const lifecycle = row.state === "running" ? "running" : row.state === "failed" ? "failed" : "completed";
				const label = projection === "work" ? `${source} · call · ${row.label.replace(/\n/g, " ")} · ${lifecycle}` : row.label.replace(/\n/g, " ");
				const room = Math.max(10, inner - width(indent) - 2 - width(result));
				return [[indent, "faint"], [`${mark} `, style], [cut(label, room), ""], [result, row.state === "failed" ? "err" : "muted"]];
			};
			const rowLines = (item, index) => {
				const row = item.rows[index];
				const ref = { item: item.key, row: index, bg: "bgTool" };
				if (row.kind === "note" || row.kind === "reasoning") {
					if (!thinking) return;
					const indent = row.depth > 0 ? "  │ ┊ " : "  ┊ ";
					const text = wrap(row.text, inner - width(indent));
					const source = row.depth > 0 ? "Focus" : "Main";
					const label = row.kind === "reasoning" ? "Private reasoning · provider response · replay: provider-bound" : "Agent note · provider response · replay: active-context dependent";
					if (projection === "work" || row.open || text.length > POLICY.limits.screen.notePreviewLines) add([[indent, "faint"], [projection === "work" ? `${source} · ${label}` : label, "faint"]], { ...ref, kind: row.kind });
					for (const piece of row.open ? text : text.slice(0, POLICY.limits.screen.notePreviewLines)) add([[indent, "faint"], [piece, "note italic"]], { ...ref, kind: row.kind });
					if (!row.open && text.length > POLICY.limits.screen.notePreviewLines) add([[indent, "faint"], [`… ${text.length - POLICY.limits.screen.notePreviewLines} more lines`, "faint"]], { ...ref, kind: row.kind });
					return;
				}
				if (row.name === "consult") {
					// Parent calls are only correlation pointers. The dedicated Consult projection is the sole screen surface
					// allowed to read or render a co<N> notebook, including its compact outer receipt.
					add(callLine(row), { ...ref, kind: "call" });
					return;
				}
				add(callLine(row), { ...ref, kind: "call" });
				if (row.open && row.detail !== undefined) {
					const indent = row.depth > 0 ? "  │   " : "    ";
					const text = wrap(plain(row.detail), inner - width(indent));
					for (const piece of text.slice(0, DETAIL_ROWS)) add([[indent, "faint"], [piece, row.state === "failed" ? "err" : "muted"]], { ...ref, kind: "detail" });
					if (text.length > DETAIL_ROWS) add([[indent, "faint"], [`… ${text.length - DETAIL_ROWS} more lines${row.name === "task" ? " (/report shows the report)" : ""}`, "faint"]], { ...ref, kind: "detail" });
				}
			};
			/** One line that Cartographer printed: its mark picked out, the rest by what the line is. */
			const printed = (piece, question) => {
				if (question) return [[piece, ""]];
				const mark = /^(\s*)([!●◆◂▸?›✓○])(\s?)(.*)$/s.exec(piece);
				if (mark === null) return [[piece, /^\s{2,}/.test(piece) ? "faint" : "muted"]];
				const [, lead, sign, gap, rest] = mark;
				if (sign === "!") return [[piece, "warn"]];
				if (sign === "›") return [[`${lead}${sign}${gap}`, "user"], [rest, "muted"]];
				return [[`${lead}${sign}${gap}`, sign === "✓" ? "ok" : "carto"], [rest, lead === "" ? "muted" : "faint"]];
			};
			/** The lines of one item, without the empty row that may stand before it. */
			const make = (item) => {
				if (item.type === "user") {
					for (const [index, piece] of wrap(item.text, inner - 2).entries()) add([[index === 0 ? "› " : "  ", "user bold"], [piece, "bold"]], { item: item.key, kind: "user", bg: "bgUser" });
					if (projection === "talk") add([[`  You → agent · submitted${sourceLabel(item.source)}`, "faint"]], { item: item.key, kind: "user", bg: "bgUser" });
				} else if (item.type === "agent") {
					const state = item.delivery === "failed" ? "failed" : item.delivery === "delivered" ? "delivered" : "sending";
					const ref = { item: item.key, kind: "agent", ...(state === "failed" ? { bg: "bgTool" } : {}) };
					if (projection !== "all") add([[`Agent speech${item.task ? " · focus" : ""} · ${state}${item.callId === undefined ? "" : ` · chat call ${item.callId}`}${sourceLabel(item.source)}`, state === "failed" ? "err" : state === "sending" ? "warn" : "faint"]], ref);
					said(item.text, ref, item);
					if (state === "failed" && item.result !== undefined) add([[`  Failed delivery · ${item.result}`, "err"]], ref);
				} else if (item.type === "block") {
					const ref = { item: item.key, kind: "block", bg: "bgTool" };
					if (projection === "work") add([["Harness · request block · active context", "faint"]], ref);
					add([[item.open ? "▾ " : "▸ ", "carto"], [cut(item.label, inner - 2), "muted"]], ref);
					if (item.open) {
						const indent = "  ";
						const pieces = wrap(item.text, inner - width(indent));
						for (const piece of pieces.slice(0, BLOCK_ROWS)) add([[indent, "faint"], [piece, "muted"]], ref);
						if (pieces.length > BLOCK_ROWS) add([[indent, "faint"], [`… ${pieces.length - BLOCK_ROWS} more lines (y copies it)`, "faint"]], ref);
					}
				} else if (item.type === "note" || item.type === "reasoning") {
					if (!thinking) return;
					// Private material is its own quiet block, rather than borrowing the tools' cyan. Its rail and faint
					// violet surface make it easy to keep separate from both speech and work without elevating its weight.
					const ref = { item: item.key, kind: item.type, bg: "bgNote" };
					if (projection === "work") add([[`Main · ${privateLabel(item.type)}`, "faint"]], ref);
					for (const piece of wrap(item.text, cols - 2)) add([[piece, "note italic"]], ref);
				} else if (item.type === "console") {
					if (projection === "work") add([["Harness · notice", "faint"]], { item: item.key, kind: "console" });
					const question = /^\? /.test(item.text);
					for (const [index, piece] of item.text.replace(/\n$/, "").split("\n").entries()) {
						const rows = wrap(piece, cols);
						const head = question && index === 0 ? [["? ", "warn bold"], [rows[0].slice(2), "bold"]] : printed(rows[0], question && !/^\s{2}(Type |no answer|nobody)/.test(piece));
						add(head, { item: item.key, kind: "console" });
						// A long line keeps the style of its end on the rows it runs over.
						for (const part of rows.slice(1)) add([[part, head.at(-1)[1]]], { item: item.key, kind: "console" });
					}
				} else if (item.type === "group") {
					const indexes = item.rows.map((_row, index) => index).filter((index) => (projection !== "all" || item.rows[index].hiddenInAll !== true) && !(projection === "work" && item.rows[index].hiddenInWork === true));
					const shownRows = indexes.map((index) => item.rows[index]);
					const calls = shownRows.filter((row) => row.kind === "call");
					const privateRows = shownRows.filter((row) => row.kind === "note" || row.kind === "reasoning");
					if (calls.length === 0 && (!thinking || privateRows.length === 0)) return;
					const running = !item.closed;
					const open = item.open || running;
					const failed = calls.filter((row) => row.state === "failed").length;
					const tasks = calls.filter((row) => row.name === "task").map((row) => row.details?.report ?? (row.args?.move ? `move ${row.args.move}` : row.args?.item ? `task ${row.args.item}` : "task"));
					const consults = calls.filter((row) => row.name === "consult").map((row) => cut(String(row.args?.question ?? "").replace(/\s+/g, " "), 48)).filter((text) => text !== "");
					const took = span((item.ended ?? now()) - item.started);
					const head = [calls.length === 0 ? "Private response" : calls.length === 1 ? "1 call" : `${calls.length} calls`, ...new Set([...tasks, ...consults]), took].join(" · ");
					add([[open ? "▾ " : "▸ ", running ? "warn" : "tool"], [head, running ? "" : "muted"], [failed > 0 ? ` · ${failed} failed` : "", "err"]], { item: item.key, kind: "group", bg: "bgTool" });
					if (open) {
						// A run that is going on shows its newest rows; opened by hand, it shows all of them.
						const from = item.open ? 0 : Math.max(0, indexes.length - LIVE_ROWS);
						if (from > 0) add([["  ", ""], [`… ${from} earlier: Enter on the line above shows all`, "faint"]], { item: item.key, kind: "group", bg: "bgTool" });
						for (const index of indexes.slice(from)) rowLines(item, index);
					}
				}
			};
			// An item's lines are made once and kept until the item changes: a long conversation is not made again
			// for every word the agent writes. What the lines depend on is put into one string; a run of calls
			// that is going on, or that shows a clock, is made every time.
			const base = `${cols}|${thinking}|${styleRev}|${projection}`;
			const linesOf = (item) => {
				const still = item.type !== "group" || (item.closed && !item.rows.some((row) => row.kind === "call" && row.state === "running"));
				const sign = !still ? undefined : item.type === "group" ? `${base}|${item.rev ?? 0}|${item.rows.length}|${item.open}` : item.type === "block" ? `${base}|${item.text.length}|${item.open ?? ""}` : `${base}|${item.rev ?? 0}|${item.text}|${item.delivery ?? ""}|${item.result ?? ""}|${item.source?.id ?? ""}|${item.source?.callId ?? ""}|${item.pending === true}`;
				if (sign !== undefined && item.made?.sign === sign) return item.made.lines;
				sink = [];
				make(item);
				const made = sink;
				sink = out;
				item.made = sign === undefined ? undefined : { sign, lines: made };
				return made;
			};
			let before;
			for (const item of items) {
				if (projection === "talk" && !inTalk(item)) continue;
				if (projection === "work" && inTalk(item)) continue;
				const own = linesOf(item);
				if (own.length === 0) continue;
				// Blocks of different kinds stand an empty row apart; what a task left behind stands under its run.
				const privateItem = item.type === "note" || item.type === "reasoning";
				const apart = privateItem ? before !== "note" && before !== "reasoning" : item.type === "console" ? before !== "console" && !(before === "group" && item.of !== undefined) : true;
				if (apart) blank();
				for (const line of own) out.push(line);
				before = item.type;
			}
			// A live provider response has the same boundary as completed work: its `chat` call is prospective speech in
			// Talk, while private response material and other calls are Work. Nothing here has a delivery result yet.
			for (const depth of [...live.keys()].sort((a, b) => a - b)) {
				const current = live.get(depth);
				const { message } = current;
				const focused = depth > 0;
				const indent = focused ? "  │ " : "";
				const source = focused ? "Focus" : "Main";
				const noteLead = focused ? `${indent}┊ ` : "";
				const calls = callsOf(message);
				if (projection !== "work") {
					for (const call of calls.filter((entry) => entry.name === "chat" && typeof entry.arguments?.text === "string" && entry.arguments.text.trim() !== "")) {
						if (!focused && before !== "agent") blank();
						if (projection === "talk") add([[`Agent speech${focused ? " · focus" : ""} · sending · chat call ${call.id}`, "warn"]], { kind: "live-speech" });
						said(call.arguments.text.trim(), { kind: "live-speech" });
						before = "agent";
					}
				}
				if (projection === "talk") continue;
				// A main reply's private material should look like its completed counterpart from the first token. A focus
				// stays inside the teal work block that owns it.
				const block = { bg: focused ? "bgTool" : "bgNote" };
				const privateResponse = (kind, text) => {
					if (text.trim() === "" || !thinking) return;
					const room = inner - width(indent) - 2;
					const full = current.open ? wrap(text, room) : undefined;
					const preview = current.open ? undefined : previewTail(text, room, LIVE_NOTE_ROWS);
					const pieces = full ?? preview.lines;
					const omitted = preview?.omitted ?? 0;
					const expandable = current.open || omitted > 0;
					const ref = expandable ? { item: `live:${depth}`, kind: "live", liveDepth: depth, ...block } : { kind: "live", ...block };
					const label = privateLabel(kind);
					if (!focused && before !== kind) blank();
					if (expandable) {
						const lines = current.open ? `${full.length} ${full.length === 1 ? "line" : "lines"} · Enter folds` : `${omitted} earlier ${omitted === 1 ? "line" : "lines"} · Enter opens all`;
						const scope = projection === "work" ? `${source} · ` : "";
						add([[`${indent}${current.open ? "▾" : "▸"} `, "faint"], [`${scope}${label} · ${lines}`, "faint"]], ref);
					} else if (projection === "work") add([[noteLead, "faint"], [`${source} · ${label}`, "faint"]], ref);
					for (const piece of pieces) add([[noteLead, "faint"], [piece, "note italic"]], ref);
					before = kind;
				};
				if (projection === "all") privateResponse(thinkingOf(message).trim() === "" ? "note" : "thinking", noteOf(message));
				else {
					privateResponse("reasoning", thinkingOf(message));
					privateResponse("note", textOf(message));
				}
				if (!thinking && projection === "all" && noteOf(message).trim() !== "" && calls.length === 0) {
					if (!focused && before !== "note") blank();
					add([[noteLead, "faint"], ["thinking… (Ctrl-T shows it)", "faint"]], { kind: "live", ...block });
					before = "note";
				}
				for (const call of calls.filter((entry) => entry.name !== "chat")) {
					const label = describeCall(call, describeRef).replace(/\n/g, " ");
					const shown = projection === "work" ? `${source} · call · ${label} · sending` : label;
					add([[`${indent}✎ `, "warn"], [cut(shown, inner - width(indent) - 2), "bold"]], { kind: "live", bg: "bgTool" });
					const body = bodyOf(call);
					if (body !== "") {
						const text = wrap(body, inner - width(indent) - 4);
						for (const piece of text.slice(-LIVE_TEXT_ROWS)) add([[`${indent}  │ `, "faint"], [piece, "muted"]], { kind: "live", bg: "bgTool" });
					}
				}
			}
			return out;
		},

		/** The text of one item, for copying. */
		textOf(key, rowIndex) {
			const consultation = consultations.get(String(key));
			if (consultation !== undefined) return consultExport(consultation, rowIndex);
			const liveKey = /^live:(\d+)$/.exec(String(key));
			if (liveKey !== null) {
				const message = live.get(Number(liveKey[1]))?.message;
				return message === undefined ? "" : noteOf(message);
			}
			const item = items.find((entry) => entry.key === key);
			if (item === undefined) return "";
			if (item.type === "block") return item.text;
			if (item.type === "group") {
				const row = rowIndex === undefined ? undefined : item.rows[rowIndex];
				if (row?.kind === "note" || row?.kind === "reasoning") return row.text;
						if (row?.name === "consult") return "Private consultation activity is available only in Chat · Consult.";
				if (row !== undefined) return `${row.label}${row.result ? `  → ${row.result}` : ""}${row.detail ? `\n\n${plain(row.detail)}` : ""}`;
				return item.rows.map((entry) => ((entry.kind === "note" || entry.kind === "reasoning") ? `  ┊ ${entry.text.split("\n")[0]}` : `${entry.depth > 0 ? "  │ " : "  "}${entry.label}${entry.result ? `  → ${entry.result}` : ""}`)).join("\n");
			}
			return item.text ?? "";
		},
		/** The whole session as Markdown: what was said in full, each call as one line. */
		transcript({ title = "Cartographer session" } = {}) {
			const parts = [`# ${title}`, ""];
			for (const item of items) {
				if (item.type === "user") parts.push("## You", "", item.text, "");
				else if (item.type === "agent" && item.delivery === "delivered") parts.push(`## Cartographer${item.task ? " (from a task)" : ""}`, "", item.text, "");
				else if (item.type === "agent") parts.push(`> Private work — speech ${item.delivery ?? "not delivered"}: ${item.text.replace(/\s+/g, " ")}`, "");
				else if (item.type === "note" || item.type === "reasoning") parts.push(...item.text.split("\n").map((line) => `> Private ${item.type}: ${line}`), "");
				else if (item.type === "block") parts.push("```text", `// ${item.label}`, item.text.replace(/\n+$/, ""), "```", "");
				else if (item.type === "console") parts.push("```text", item.text.replace(/\n+$/, ""), "```", "");
				else if (item.type === "group" && item.rows.length > 0) {
					for (const row of item.rows) {
						if (row.hiddenInAll === true) continue;
						if (row.kind === "note" || row.kind === "reasoning") parts.push(`${row.depth > 0 ? "  " : ""}- _private ${row.kind}:_ ${row.text.replace(/\s+/g, " ")}`);
						else parts.push(`${row.depth > 0 ? "  " : ""}- \`${row.label.replace(/\n/g, " ").replace(/`/g, "'")}\`${row.result ? ` → ${row.result}` : ""}${row.state === "failed" ? " (failed)" : ""}`);
					}
					parts.push("");
				}
			}
			return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
		},
	};
	return api;
}
