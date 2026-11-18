// Presentation-safe formatting for Runtime projections.
//
// Mutable session managers and frozen provider records stay behind application queries and actions. Screen renderers
// receive settled snapshots plus this narrow vocabulary, so they never import a Runtime/domain rule merely to make a
// Runtime row legible.
import { POLICY } from "../config.mjs";
import { composedRows, estimate, isFront, recordLine, sameShelfItem, shelfLabel, splitReadTail } from "../context.mjs";
import { flat } from "../rows.mjs";
import { ago, stamp, took } from "../time.mjs";
import { RECORD } from "../voice.mjs";
import { USER_NAME } from "../user.mjs";

const PROJECT_BLOCK = new RegExp(`^${POLICY.markup.project.open}\\n[\\s\\S]*?\\n${POLICY.markup.project.close}\\n*`);
const ANCHOR = RECORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CONTEXT_BLOCK = new RegExp(`${POLICY.markup.context.open}\\n${ANCHOR}[\\s\\S]*?\\n${POLICY.markup.context.close}\\n*`);
const STATE_BLOCK = new RegExp(`\\n*${POLICY.markup.state.open}\\n${ANCHOR}[\\s\\S]*?\\n${POLICY.markup.state.close}`);
const WINDOWS_BLOCK = new RegExp(`\\n*${POLICY.markup.windows.open}\\n${ANCHOR}[\\s\\S]*?\\n${POLICY.markup.windows.close}`);

const categories = Object.freeze([
	Object.freeze({ id: "system", name: "System prompt", style: "catSystem" }),
	Object.freeze({ id: "tools", name: "Tools", style: "catTools" }),
	Object.freeze({ id: "top", name: "Assessment and graph", style: "catTop" }),
	Object.freeze({ id: "kept", name: "Kept by a collapse", style: "catKept" }),
	Object.freeze({ id: "you", name: "Your messages", style: "catYou" }),
	Object.freeze({ id: "carto", name: "Cartographer's notes", style: "catCarto" }),
	Object.freeze({ id: "agent", name: "Agent: notes and calls", style: "catAgent" }),
	Object.freeze({ id: "result", name: "Tool results", style: "catResult" }),
	Object.freeze({ id: "state", name: "State block", style: "catState" }),
	Object.freeze({ id: "windows", name: "Windows block", style: "catWindows" }),
]);
const styleOf = (id) => categories.find((category) => category.id === id)?.style ?? "";
const shortCount = (value) => {
	if (!Number.isFinite(value)) return "?";
	if (value < POLICY.limits.format.countThousands) return String(Math.round(value));
	if (value < POLICY.limits.format.countTenThousands) return `${(value / POLICY.limits.format.countThousands).toFixed(1)}k`;
	return `${Math.round(value / POLICY.limits.format.countThousands)}k`;
};

const commandSummary = (text) => {
	const value = String(text ?? "");
	return (value.length > POLICY.limits.screen.viewSummaryChars ? `${value.slice(0, POLICY.limits.screen.viewSummaryChars)}…` : value).replace(/\s+/g, " ");
};

const shell = (window) => {
	const shown = window.state === POLICY.enums.windowStates.busy ? window.command ?? "" : window.last?.command ?? "";
	const summary = commandSummary(shown);
	const marks = window.sandbox === false ? " · no sandbox" : window.network ? " · network" : "";
	const state = window.state === POLICY.enums.windowStates.gone
		? [["gone", "err"], [`  ${window.why}`, "muted"]]
		: window.state === POLICY.enums.windowStates.busy
			? [["busy", "warn"], [` ${took(window.running)}`, ""], [`  $ ${summary}`, "bold"], [window.asks ? "  may be waiting for input" : "", "warn"]]
			: [["free", "ok"], [window.last ? `  last: $ ${summary} → exit ${window.last.exit}, ${ago(window.last.ago)}` : "  nothing was run in it yet", "muted"]];
	return {
		shown,
		summary,
		wholeCommand: shown === "" ? undefined : `$ ${flat(shown)}`,
		truncated: shown !== "" && summary !== shown,
		state,
		location: `${window.cwd && window.cwd !== "." ? `  in ${window.cwd}/` : ""}${marks}`,
	};
};

const shellOutput = (window) => ({
	state: window.state === POLICY.enums.windowStates.busy
		? [["busy", "warn"], [`  $ ${window.command ?? ""}`, "bold"], [window.asks ? "  · may be waiting for input" : "", "warn"]]
		: window.state === POLICY.enums.windowStates.gone
			? [["gone", "err"], [`  ${window.why ?? ""}`, "muted"]]
			: [["free", "ok"]],
	location: `${window.cwd && window.cwd !== "." ? `  in ${window.cwd}/` : ""}${window.sandbox === false ? "  · no sandbox" : window.network ? "  · network" : ""}`,
});

const contentText = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : "");
const pretty = (value) => {
	try {
		return JSON.stringify(typeof value === "string" ? JSON.parse(value) : value, null, 2);
	} catch {
		return String(value);
	}
};
/** The words of a `chat` call, when its arguments carry them. */
const chatSaid = (args) => {
	try {
		const parsed = typeof args === "string" ? JSON.parse(args) : args;
		const said = parsed?.text;
		return typeof said === "string" && said.trim() !== "" ? said : undefined;
	} catch {
		return undefined;
	}
};

/** A call as it reads: its name, then each argument, long text as text and not as one JSON string. */
const callText = (name, args) => {
	let parsed = args;
	if (typeof args === "string") {
		try {
			parsed = JSON.parse(args);
		} catch {
			return `${name}  ${args}`;
		}
	}
	const lines = [`call ${name}`];
	for (const [key, value] of Object.entries(parsed ?? {})) {
		if (typeof value === "string" && (value.includes("\n") || value.length > POLICY.limits.screen.jsonLongValueChars)) lines.push(`  ${key}:`, ...value.split("\n").map((line) => `    ${line}`));
		else lines.push(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
	}
	return lines.join("\n");
};
const firstWords = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, POLICY.limits.screen.contextSummaryChars);

/** One message of a frozen provider request, separated into the semantic blocks Cartographer supplied and its own content. */
const partsOfMessage = (message, toolNames) => {
	const parts = [];
	let text = contentText(message.content);
	const tail = [];
	const take = (pattern, cat, title, to) => {
		const found = pattern.exec(text);
		if (!found) return;
		to.push({ cat, title, text: found[0].trim() });
		text = text.slice(0, found.index) + text.slice(found.index + found[0].length);
	};
	take(PROJECT_BLOCK, "top", "Assessment and graph, as copied at the last collapse", parts);
	take(CONTEXT_BLOCK, "kept", "What the last collapse kept", parts);
	take(STATE_BLOCK, "state", "State block: the time, the tree, the ledger, the plan", tail);
	take(WINDOWS_BLOCK, "windows", "Windows block: the shell windows as they are", tail);
	const readTail = splitReadTail(text);
	text = readTail.text.trim();
	if (readTail.tail !== undefined) tail.push({ cat: "result", title: "Current read batch: transient file content", text: readTail.tail });
	if (message.role === "assistant") {
		const calls = message.tool_calls ?? [];
		const body = [typeof message.reasoning_content === "string" && message.reasoning_content.trim() !== "" ? `(thinking)\n${message.reasoning_content.trim()}` : "", text, ...calls.map((call) => callText(call.function?.name ?? "?", call.function?.arguments))].filter((part) => part !== "").join("\n\n");
		const names = calls.map((call) => call.function?.name ?? "?");
		const said = calls.length === 1 && calls[0].function?.name === "chat" ? chatSaid(calls[0].function?.arguments) : undefined;
		parts.push({ cat: "agent", title: names.length === 0 ? "Chat · Agent · note" : `Chat · Agent · ${text !== "" ? "note and " : ""}${names.length === 1 ? "call" : "calls"}: ${names.join(", ")}`, text: body, preview: firstWords(text !== "" ? text : calls.map((call) => String(call.function?.arguments ?? "")).join(" ")), ...(said === undefined ? {} : { chat: said }) });
	} else if (message.role === "tool") {
		if (text.startsWith("You are now the task")) parts.push({ cat: "carto", title: "The task's brief", text });
		else if (text !== "") parts.push({ cat: "result", title: `Result of ${toolNames.get(message.tool_call_id) ?? "a call"}`, text });
	} else if (text !== "") {
		if (text.startsWith(POLICY.markup.note.open)) parts.push({ cat: "carto", title: "Cartographer's note", text });
		else if (text.startsWith(POLICY.markup.context.open) || (/^Cartographer: /.test(text) && !text.startsWith(`${USER_NAME}: `))) parts.push({ cat: "carto", title: "Cartographer", text });
		else parts.push({ cat: "you", title: "Chat · You", text });
	}
	return [...parts, ...tail];
};

/** The frozen provider request's identity is shared by its semantic and raw audit renderers. */
const sentIdentity = (sent) => {
	const usage = sent.usage ?? {};
	const reported = [
		typeof usage.input === "number" ? `input ${shortCount(usage.input)}` : undefined,
		typeof usage.cacheRead === "number" ? `cache read ${shortCount(usage.cacheRead)}` : undefined,
		typeof usage.cacheWrite === "number" ? `cache write ${shortCount(usage.cacheWrite)}` : undefined,
		typeof usage.output === "number" ? `output ${shortCount(usage.output)}` : undefined,
	].filter((part) => part !== undefined).join(" · ");
	return {
		who: sent.task ? "focus" : "main agent",
		request: sent.requestId ?? `request ${sent.count}`,
		provider: [sent.model?.provider, sent.model?.api, sent.model?.id].filter((part) => typeof part === "string" && part !== "").join(" · "),
		at: stamp(sent.at).split(", ").at(-1),
		age: ago(Date.now() - sent.at),
		reported,
		...(sent.payloadHash === undefined ? {} : { payloadHash: sent.payloadHash }),
	};
};

/** The semantic, read-only description of one frozen sent provider request. */
const sentRequest = (sent, writing) => {
	if (sent === undefined) return undefined;
	const payload = sent.payload ?? {};
	const messages = payload.messages ?? [];
	const parts = [];
	const since = [];
	const add = (key, part, extra = {}) => parts.push({ key, tokens: estimate(part.text), ...part, ...extra });
	const addSince = (key, part, extra = {}) => since.push({ key, tokens: estimate(part.text), ...part, ...extra, since: true });
	const rest = messages[0]?.role === "system" ? messages.slice(1) : messages;
	if (messages[0]?.role === "system") add("system", { cat: "system", title: "System prompt", text: contentText(messages[0].content) });
	const tools = payload.tools ?? [];
	if (tools.length > 0) {
		const text = tools.map((tool) => `── ${tool.function?.name ?? "?"} ──\n${tool.function?.description ?? ""}\nparameters: ${pretty(tool.function?.parameters ?? {})}`).join("\n\n");
		add("tools", { cat: "tools", title: `Tools · ${tools.length}: ${tools.map((tool) => tool.function?.name).join(", ")}`, text, preview: "" }, { tokens: estimate(JSON.stringify(tools)) });
	}
	const toolNames = new Map();
	for (const [index, message] of rest.entries()) {
		for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function?.name ?? "?");
		for (const [number, part] of partsOfMessage(message, toolNames).entries()) add(`m${index}.${number}.${part.cat}`, part);
	}
	const reply = sent.reply ?? writing;
	if (reply !== undefined) {
		const content = Array.isArray(reply.content) ? reply.content : [];
		const calls = content.filter((part) => part.type === "toolCall");
		const text = [
			...content.filter((part) => part.type === "thinking" && String(part.thinking ?? "").trim() !== "").map((part) => `(private reasoning)\n${part.thinking.trim()}`),
			...content.filter((part) => part.type === "text" && part.text.trim() !== "").map((part) => part.text.trim()),
			...calls.map((call) => callText(call.name, call.arguments)),
		].join("\n\n");
		const names = calls.map((call) => call.name);
		addSince("reply", { cat: "agent", title: `${sent.reply === undefined ? "Response, as it is being written" : "Response received"}${names.length > 0 ? ` · ${names.length === 1 ? "call" : "calls"}: ${names.join(", ")}` : " · agent note"}`, text, preview: firstWords(content.filter((part) => part.type === "text").map((part) => part.text).join(" ")) });
		for (const call of calls) {
			const result = sent.results?.get?.(call.id);
			if (result !== undefined) addSince(`result:${call.id}`, { cat: "result", title: `Result after ${call.name}`, text: result });
		}
	}
	return {
		...sentIdentity(sent),
		tools,
		parts,
		since,
		used: parts.reduce((sum, part) => sum + part.tokens, 0),
		collapsedSince: sent.collapsedSince === true,
	};
};

/** The bar: the whole window as one row of cells, in the order the model reads it. */
const contextBar = (parts, windowSize, cols) => {
	const cells = Math.max(10, cols);
	const per = windowSize / cells;
	const spans = [];
	let at = 0;
	let index = 0;
	for (let cell = 0; cell < cells; cell++) {
		const middle = (cell + 0.5) * per;
		while (index < parts.length && at + parts[index].tokens <= middle) {
			at += parts[index].tokens;
			index++;
		}
		const part = parts[index];
		const [mark, style] = part === undefined ? ["□", "faint"] : ["■", styleOf(part.cat)];
		if (spans.at(-1)?.[1] === style && spans.at(-1)[0].startsWith(mark)) spans.at(-1)[0] += mark;
		else spans.push([mark, style]);
	}
	return spans;
};

const rawPayload = (sent) => sent === undefined ? undefined : { ...sentIdentity(sent), payloadJson: sent.payloadJson };

/** The current request plan is not a provider payload yet. Its display facts stay here so the screen never guesses a lifecycle from provider JSON. */
const plannedText = (fragment) => {
	if (typeof fragment === "string") return fragment;
	if (fragment === null || typeof fragment !== "object") return String(fragment ?? "");
	if (!Array.isArray(fragment.content)) return pretty(fragment);
	return fragment.content.map((part) => {
		if (part?.type === "text") return part.text ?? "";
		if (part?.type === "thinking") return `(private reasoning)\n${part.thinking ?? ""}`;
		if (part?.type === "toolCall") return callText(part.name ?? "?", part.arguments);
		return pretty(part);
	}).filter((text) => text !== "").join("\n\n");
};
const plannedTitle = (part) => {
	if (part.kind === "brain-copy") return "Frozen brain copy for this preview";
	if (part.kind === "generated-state") return "Generated state block";
	if (part.kind === "generated-windows") return "Generated windows block";
	if (part.kind === "transient-read-tail") return "Current read batch · transient";
	if (part.kind === "focus-capsule") return "Prepared focus capsule · captured handoff";
	if (part.kind === "focus-start") return "Focused task start query · request-only";
	return `${part.role ?? "active"} message from active conversation`;
};
const previewDescription = (preview) => {
	if (preview === undefined) return { state: "calculating" };
	if (preview?.error !== undefined) return { state: "error", error: preview.error };
	if (preview.plan === undefined) return { state: "empty" };
	return {
		state: "ready",
		at: Number.isFinite(preview.at) ? stamp(preview.at).split(", ").at(-1) : "just now",
		parts: (preview.plan.parts ?? []).map((part) => ({
			id: part.id,
			source: part.source,
			title: plannedTitle(part),
			text: plannedText(part.fragment),
		})),
	};
};

/** Current active-context accounting stays distinct from a sent request or a next-request preview. */
const accountingRows = ({ messages = [], sizes = {}, contextWindow } = {}, config = {}) => {
	const tokens = (value) => Number.isFinite(value) ? shortCount(value) : "?";
	const plural = (value, word) => `${value} ${word}${value === 1 ? "" : "s"}`;
	const rows = [];
	const row = (name, value, what) => rows.push(`    ${name.padEnd(8)}${tokens(value).padStart(7)}   ${what}`);
	const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined;
	const known = [sizes.fixed, sizes.top, sizes.front?.total, sizes.work, sizes.state].reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
	if (sizes.fixed === undefined) rows.push(`  The agent's context: of ${tokens(window)} tokens, not measured yet (nothing has been sent in this run of carto yet; the parts below are estimates, without the prompt and the tools)`);
	else rows.push(`  The agent's context: about ${tokens(sizes.used ?? known)} of ${tokens(window)} tokens${sizes.used === undefined ? " (estimated; the server has not counted it yet)" : " (measured, as the server counted it; the parts below are estimates)"}`);
	row("fixed", sizes.fixed, "the prompt and the tools; never changes");
	row("top", sizes.top, "the assessment and the graph, as copied at the last collapse");
	if (sizes.front === undefined) row("kept", 0, "nothing yet: the context has not been collapsed");
	else {
		const kept = sizes.front.tokens ?? {};
		row("record", kept.record, `${plural(sizes.front.kept?.tasks ?? 0, "finished task")}, one line each`);
		row("shelf", kept.shelf, (sizes.front.shelf ?? []).length === 0 ? "empty" : (sizes.front.shelf ?? []).map((item) => `${shelfLabel(item)} [${item.id}]`).join(", "));
		row("talk", kept.talk, `${plural(sizes.front.kept?.talk ?? 0, "message")} between you and the agent${Number.isFinite(config.chatWindow) ? `, of at most ${tokens(config.chatWindow)} tokens` : ""}`);
	}
	const since = messages.filter((message) => !isFront(message)).length;
	const from = sizes.front === undefined ? "the start" : "the last collapse";
	row("work", sizes.work, since === 0 ? `nothing since ${from}` : `${plural(since, "message")} since ${from}; a collapse frees about ${tokens(sizes.frees)}`);
	row("state", sizes.state, "the state block, written anew for every request");
	const store = sizes.store ?? { shelf: [], rows: [] };
	const shelf = Array.isArray(store.shelf) ? store.shelf : [];
	const keptShelf = sizes.front?.shelf ?? [];
	const waiting = shelf.filter((item) => !keptShelf.some((entry) => sameShelfItem(entry, item)));
	const leaving = keptShelf.filter((entry) => !shelf.some((item) => sameShelfItem(entry, item)));
	if (waiting.length > 0) rows.push(`  new shelf snapshots, in view now and carried into the next collapse: ${waiting.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}`);
	if (leaving.length > 0) rows.push(`  taken off the shelf, gone at the next collapse: ${leaving.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}`);
	const records = composedRows(store);
	if (records.length > 0) {
		rows.push(`  kept reports: ${records.length} (${records[0].id} to ${records.at(-1).id}); the newest:`);
		for (const record of records.slice(-POLICY.limits.terminal.recentReports)) rows.push(`    ${recordLine(record)}`);
	}
	if (store.last !== undefined) rows.push(`  last collapse: ${stamp(store.last.at)} (${store.last.reason ?? "unknown reason"})${store.last.before !== undefined && store.last.after !== undefined ? `, about ${tokens(store.last.before)} → ${tokens(store.last.after)} tokens` : ""}`);
	const next = Number.isFinite(config.collapseTokens) ? `once ${tokens(config.collapseTokens)} tokens would go` : "at the configured threshold";
	const away = Number.isFinite(config.collapseMinutes) && config.collapseMinutes > 0 ? ` or you have been away ${took(config.collapseMinutes * 60_000)}` : "";
	rows.push(`  next: while the agent rests, ${next}${away}; when a goal closes; while it works, at ${tokens(sizes.full)} tokens. /collapse does it now.`);
	return rows;
};

/** The vocabulary migrated Runtime renderers need. Other Runtime surfaces join this adapter as they migrate. */
export function createRuntimePresentation() {
	return Object.freeze({
		shells: Object.freeze({ shell, shellOutput }),
		sent: Object.freeze({ categories, styleOf, short: shortCount, estimate, pretty, firstWords, describe: sentRequest, raw: rawPayload, contextBar }),
		preview: Object.freeze({ describe: previewDescription }),
		accounting: Object.freeze({ rows: accountingRows }),
	});
}
