// The plain terminal: what you type goes to the main agent, and what the agent and
// its tasks do is printed as it happens.
//
// Everything shown here is read from the session's committed state, the same state
// a later dashboard will read. Nothing here decides anything.
//
//   › your message
//   ┊ what the main agent thinks and notes for itself, streamed (Ctrl-T hides and shows it)
//   what the main agent says to you with `chat`, streamed
//   ▸ task  first line of the brief
//   │ read src/a.ts                     → 212 lines
//   │ read src/b.ts                     → 200 lines
//   │ search /register/ in src           → 9 matches
//   ◂ report  1.3k characters  (/report shows it)
//
// It is also where the user authorizes the plan (/approve) and takes a change task
// back (/undo): the two things only the user can do. And it is what wakes the agent
// when something happens in a shell window while the agent is not working.
import { POLICY } from "./config.mjs";
import { createRefDescriber } from "./refs.mjs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { atlasSummary, attentionSummary, renderAttention, renderOutline } from "./atlas.mjs";
import { changeRecord, changeSummary } from "./checkpoints.mjs";
import { bindTalkSource, contextPath, FLOOR, isFront, recordLine, shelfLabel, composedRows, sameShelfItem, splitReadTail } from "./context.mjs";
import { createApplication } from "./application/app.mjs";
import { consultMessageFingerprint } from "./application/queries.mjs";
import { describeCall, describeResult } from "./application/activity.mjs";
export { describeCall, describeResult } from "./application/activity.mjs";
import { CONTEXT_ACTION } from "./application/context.mjs";
import { WORKSPACE_ACTION } from "./application/workspace.mjs";
import { REQUEST_ACTION } from "./application/requests.mjs";
import { REVIEW_ACTION } from "./application/review.mjs";
import { RUNTIME_ACTION } from "./application/runtime-actions.mjs";
import { conferenceStatusLine, renderConference } from "./conference.mjs";
import { ConsultProbeError, renderLlamaCppSelectorProbe, runLlamaCppSelectorProbe, selectorProbeLogPath, writeSelectorProbeLog } from "./consult-probe.mjs";
import { HANDOFF_NOTE } from "./prompt.mjs";
import { sandboxLine } from "./sandbox.mjs";
import { open, openCounts, renderLedger } from "./ledger.mjs";
import { awaitsApproval, planSummary, planWaits, renderPlan, runnableMoves, waiting as waitingItems, YOLO_LINE } from "./plan.mjs";
import { approvalWordTargets, isApprovalWords } from "./requests.mjs";
import { splitState, windowLines } from "./state.mjs";
import { ago, stamp, took } from "./time.mjs";
import { splitTop } from "./top.mjs";
import { treeSection } from "./tree.mjs";
import { eventLine, isNote, isNoChat, startNote, wakeNote, withoutQuietWakes } from "./wake.mjs";
import { questionText, spanOf } from "./tools/ask.mjs";
import { repeats } from "./screen/text.mjs";
import { REPEAT_NOTE } from "./wake.mjs";
import { createStreamFreeze } from "./stream.mjs";
import { WAKE_MIN, wakeAbout, wakesPath } from "./wakes.mjs";
import { USER_NAME } from "./user.mjs";
import { planRequest, withoutAdditions } from "./request.mjs";
import { bridgeRequestSources } from "./request-sources.mjs";

/**
 * How often the agent is woken in quick succession before its wakes are spaced out. One more becomes free with
 * every `wakeMin` seconds that pass, and a message of the user makes all of them free. A wake that has to wait is
 * not dropped: it is told with the next one. So an agent that runs in circles is slowed down, and one that
 * watches over something for days is never stopped.
 */
export const WAKE_BURST = POLICY.limits.terminal.wakeBurst;
const KILLED = POLICY.control.windowKilledReason;

/** Lines of a patch shown by /diff before it is cut; `/diff all` shows everything. */
const DIFF_LINES = POLICY.limits.terminal.diffLines;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
const callsOf = (message) => (Array.isArray(message?.content) ? message.content : []).filter((part) => part.type === "toolCall");
/** What a reply holds that is the agent's own: the model's reasoning and its plain text, in the order written. */
const notesOf = (message) => (Array.isArray(message?.content) ? message.content : []).flatMap((part) => (part.type === "thinking" ? [part.thinking ?? ""] : part.type === "text" ? [part.text] : [])).filter((text) => text !== "").join("\n");
/** What a reply says to the user: the text of its `chat` calls, also while a call is still being written. */
const chatOf = (message) => callsOf(message).flatMap((call) => (call.name === "chat" && typeof call.arguments?.text === "string" && call.arguments.text !== "" ? [call.arguments.text] : [])).join("\n\n");
/** In front of each line of the agent's own text. */
const GUTTER = "┊ ";
const KEPT_REPORT_SUFFIX = new RegExp(`\\n\\n${POLICY.patterns.keptReport}$`);
const oneLine = (text, max) => {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const count = (n) => (n >= POLICY.limits.format.countTenThousands ? `${Math.round(n / POLICY.limits.format.countThousands)}k` : n >= POLICY.limits.format.countThousands ? `${(n / POLICY.limits.format.countThousands).toFixed(1)}k` : String(n));

/** A harness message without its wrapping. */
const plain = (text) => text.replace(/<\/?harness>/g, "").replace(/\[error\] (Tool call blocked: )?|^Tool call blocked: /, "").trim();

/**
 * @param {{ harness: any, main: any, context: any, windows?: ReturnType<typeof import("./windows.mjs").createWindows>, wakes?: ReturnType<typeof import("./wakes.mjs").createWakes> }} session
 * @param {{ input: NodeJS.ReadableStream, output: NodeJS.WritableStream, interactive: boolean, contextWindow: number, root: string, brainDir: string, oneShot?: string, gate?: { yolo: boolean }, initiation?: { on: boolean }, wakeMin?: number }} options
 *   gate: whether declared change moves run without /approve; /yolo changes it, and the tools read it (src/harness.mjs)
 * @returns {Promise<number>} exit code
 */
/** Sent for the user when /approve finds nothing to authorize; like the message that follows an approval, in their voice. */
const NOTHING_TO_APPROVE =
	"I typed /approve, but the plan holds no declared change move waiting for approval, so nothing changed. I can only approve the current move revisions stored in the plan; chat wording is not a move. Add a narrow move, then ask me again.";

export async function runTerminal(session, options) {
	const { harness, main, context, windows, wakes, engine, asks } = session;
	// The gate between the model's response body and the network; the full build wires it for real. Tests and
	// harnesses that bring their own session may not — there the pause is simply an interrupt.
	const streamFreeze = session.streamFreeze ?? createStreamFreeze();
	const config = options.config ?? {};
	// Modern sessions expose one model-management port. Keep an adapter only for narrow test/integration sessions that
	// still provide the former aliases; all terminal behavior below reaches it through the application boundary.
	const modelManager = session.models ?? Object.freeze({
		current: typeof session.model === "function" ? session.model.bind(session) : undefined,
		inspect: typeof session.checkServer === "function" ? session.checkServer.bind(session) : undefined,
		ensure: typeof session.ensureModelReady === "function" ? session.ensureModelReady.bind(session) : undefined,
		ready: typeof session.isModelReady === "function" ? session.isModelReady.bind(session) : undefined,
		known: () => Array.isArray(session.servedModels) ? session.servedModels : [config.model].filter((id) => typeof id === "string" && id !== ""),
		select: typeof session.setModel === "function" ? async (modelId, limits = {}) => await session.setModel(modelId, context, limits) : undefined,
	});
	// The task message port has the same compatibility shape: old test sessions retain their aliases, while normal
	// terminal and Screen paths route their durable task steering through the application action below.
	const workMessenger = session.work ?? Object.freeze({
		tell: typeof session.tellWork === "function" ? session.tellWork.bind(session) : typeof session.tellTask === "function" ? session.tellTask.bind(session) : undefined,
	});
	const application = options.application ?? createApplication({
		brainDir: options.brainDir,
		root: options.root,
		config,
		runtime: {
			main,
			context,
			engine,
			windows,
			wakes,
			work: workMessenger,
			model: modelManager.current,
			models: modelManager,
			preview: session.preview,
			runner: options.runner,
			contextWindow: () => options.contextWindow,
		},
	});
	const queries = application.queries;
	const gate = options.gate ?? { yolo: false };
	/** Whether the agent starts on its own at the start (config `initiate`; /initiate switches it while carto runs, never remembered). */
	const initiation = options.initiation ?? { on: true };
	// The full screen (src/screen/app.mjs), when carto runs in it. It is this terminal with another face: the same
	// commands, wakes and rests, and the same words for what Cartographer itself has to say. What differs is where
	// text goes. Everything printed is handed to the screen as text for its Chat tab, except what is printed about
	// one entry of a conversation: that is handed over together with the entry, which the screen draws itself.
	const describeRef = createRefDescriber({ brainDir: options.brainDir });
	const ui = options.screen;
	let capture;
	const out = ui
		? {
				isTTY: false,
				write: (text) => {
					if (capture !== undefined) capture.push(text);
					else ui.print(text);
					return true;
				},
				listeners: () => [],
				on() {},
				off() {},
			}
		: options.output;
	const fancy = options.interactive && ui === undefined;
	const dim = (text) => (fancy ? `\x1b[2m${text}\x1b[0m` : text);
	const bold = (text) => (fancy ? `\x1b[1m${text}\x1b[0m` : text);

	// ─── Printing ───────────────────────────────────────────────────────────
	let midLine = false; // the cursor is inside streamed text
	let midNotes = false; // and that text is the agent's own
	const endLine = () => {
		if (midLine) out.write("\n");
		midLine = false;
		midNotes = false;
	};
	const line = (text = "") => {
		endLine();
		out.write(`${text}\n`);
	};
	const stream = (text) => {
		if (text === "") return;
		if (midNotes) endLine();
		out.write(text);
		midLine = !text.endsWith("\n");
	};
	/** The terminal adds its marker; application services provide the typed outcome and its safe message. */
	const workspaceLine = async (action, input, actionOptions = {}) => {
		const result = await application.execute(action, input, actionOptions);
		return result.ok ? result.data.line : `! ${result.error.message}`;
	};
	const contextAction = (action, input, actionOptions = {}) => application.execute(action, input, actionOptions);
	const requestAction = (action, input, actionOptions = {}) => application.execute(action, input, actionOptions);
	const reviewAction = (action, input, actionOptions = {}) => application.execute(action, input, actionOptions);
	const runtimeAction = (action, input, actionOptions = {}) => application.execute(action, input, actionOptions);
	/** A named terminal command is the user's acknowledgement for its own destructive Review recovery. */
	const acknowledgedReviewAction = async (action, input = {}) => {
		const asked = await reviewAction(action, input);
		if (asked.ok || asked.confirmation === undefined) return asked;
		return reviewAction(action, input, { confirmation: { ...asked.confirmation, acknowledged: true } });
	};
	/** A named terminal command is the user's acknowledgement for its own destructive runtime control. */
	const acknowledgedRuntimeAction = (action, target, input) => runtimeAction(action, input, {
		confirmation: { actionId: action, target, acknowledged: true },
	});
	/** Run durable row mutations in order: each operation reads and writes the same book. */
	const workspaceLines = async (action, ids, actionOptions = () => ({})) => {
		const lines = [];
		for (const id of ids) lines.push(await workspaceLine(action, { id }, actionOptions(id)));
		return lines.join("\n  ");
	};
	// A server is optional while Cartographer opens: local commands remain available, and a later model turn retries
	// this gate. Keep one clear failure on screen rather than making an unavailable endpoint look like a hung UI.
	let lastModelError;
	const applyModelLimits = (limits) => {
		if (Number.isInteger(limits?.usableContextWindow) && limits.usableContextWindow > 0) options.contextWindow = limits.usableContextWindow;
	};
	const showModelError = (error) => {
		const message = String(error?.message ?? error);
		if (message === "" || message === lastModelError) return;
		lastModelError = message;
		// Chat output can scroll in the full-screen view. Keep this recoverable gate failure in that view's persistent
		// status strip as well, so a stopped server is never mistaken for an idle or hung Cartographer session.
		ui?.modelError?.(message);
		line(`! ${message}`);
	};
	// Preserve the old read-ahead rule for transitional sessions without an explicit readiness probe while using the
	// model port whenever one is available.
	let modelRouteReady = typeof modelManager.ready === "function" ? modelManager.ready() === true : true;
	const ensureModelReady = async () => {
		const availability = application.capabilities.availability(RUNTIME_ACTION.ensureModel);
		// Compatibility sessions that have no model manager let their own submit implementation decide readiness.
		if (availability?.enabled !== true) return true;
		if (!modelRouteReady) line(dim("  connecting to the model server and checking native GBNF; a stopped model may start now"));
		const result = await runtimeAction(RUNTIME_ACTION.ensureModel);
		if (!result.ok) {
			showModelError(result.error);
			return false;
		}
		applyModelLimits(result.data.limits);
		modelRouteReady = true;
		lastModelError = undefined;
		ui?.modelReady?.();
		return true;
	};
	/** The agent's own text: dim, each line behind the gutter. */
	const streamNotes = (text) => {
		if (text === "") return;
		if (midLine && !midNotes) endLine();
		for (const piece of text.split(/(\n)/)) {
			if (piece === "") continue;
			if (piece === "\n") {
				// An empty line keeps its gutter, so that the block reads as one.
				if (!midLine) out.write(dim(GUTTER.trimEnd()));
				out.write("\n");
				midLine = false;
			} else {
				out.write(dim(midLine ? piece : `${GUTTER}${piece}`));
				midLine = true;
			}
		}
		midNotes = midLine;
	};

	// Whether the agent's own text is shown. Ctrl-T and /thinking switch it. What was held back since the newest
	// message came in is kept, its end at least, so that switching it on shows it.
	let thinking = options.thinking !== false;
	let held = "";
	const HELD_MAX = POLICY.limits.terminal.heldInputChars;

	let lastReport;
	let lastUsage;
	let contextSize;
	let failed = false;
	const streaming = { stamp: undefined, notes: "", chat: "", marked: false };
	/** Print what a reply of the main agent has gained since it was last looked at: its own text, then what it says to the user. */
	const advance = (message, final) => {
		if (streaming.stamp !== message.timestamp) {
			streaming.stamp = message.timestamp;
			streaming.notes = "";
			streaming.chat = "";
			streaming.marked = false;
			// Each reply's own text starts on a line of its own.
			if (held !== "" && !held.endsWith("\n")) held += "\n";
		}
		const notes = notesOf(message);
		if (notes.length > streaming.notes.length && notes.startsWith(streaming.notes)) {
			const more = notes.slice(streaming.notes.length);
			streaming.notes = notes;
			if (thinking) streamNotes(more);
			else {
				held += more;
				if (held.length > HELD_MAX) held = `…${held.slice(-HELD_MAX)}`;
				if (!streaming.marked) {
					streaming.marked = true;
					line(dim(`${GUTTER}thinking… ${fancy ? "(Ctrl-T shows it)" : "(/thinking on shows it)"}`));
				}
			}
		}
		const chat = chatOf(message);
		if (chat.length > streaming.chat.length && chat.startsWith(streaming.chat)) {
			stream(chat.slice(streaming.chat.length));
			streaming.chat = chat;
		} else if (final && chat !== streaming.chat) {
			// What was streamed is not how it ended: the answer is printed whole.
			endLine();
			stream(chat);
			streaming.chat = chat;
		}
	};
	const showThinking = (on) => {
		thinking = on;
		// The full screen keeps the notes itself and shows or hides them where they stand; it says the change in passing.
		if (ui !== undefined) {
			held = "";
			return void ui.notice?.(on ? "notes and thinking are shown" : "notes and thinking are hidden");
		}
		if (on && held !== "") {
			endLine();
			streamNotes(held);
			endLine();
			held = "";
		}
		line(dim(`${GUTTER}${on ? "thinking is shown" : "thinking is hidden"}${fancy ? " (Ctrl-T switches)" : ""}`));
	};
	const finished = new Set(); // stamps of messages already printed in full
	const pendingCalls = new Map(); // call id -> { depth, text } waiting for its result
	const attached = new Set();
	const watches = [];
	// Conference child ids are supplied by a deliberately narrow, deferred Consult routing projection. It carries
	// identity, state, and opaque message keys only; full conference material stays in the isolated Consult surface.
	const conferenceRoutes = new Map();

	// The call for which Cartographer last said that it ended a turn, per depth: several results of one reply carry it.
	const saidLoop = [];
	/** Print what one new entry of a conversation means. depth 0 is the main agent, 1 a task. */
	const showEntry = (depth, entry, consult) => {
		if ((entry.model ?? []).some((message) => message.role === "assistant")) saidLoop[depth] = undefined;
		showOne(depth, entry, consult);
		// A call that failed the same way again and again (src/harness.mjs): said after the call's own line.
		for (const message of entry.model ?? []) {
			const loop = message.role === "toolResult" ? message.details?.loop : undefined;
			if (loop?.call === undefined || saidLoop[depth] === loop.call) continue;
			saidLoop[depth] = loop.call;
			const what = `the same call was sent ${loop.total} times and failed each time: ${oneLine(loop.call, POLICY.limits.loops.callKeyChars)}`;
			line(`${depth === 0 ? "" : dim("│ ")}! ${loop.ends === false ? `The agent is told to stop: ${what}` : `Cartographer ended the ${depth === 0 ? "turn" : "task"}: ${what}`}`);
		}
	};
	// Lines that wait for the result of a call: the line of a task that starts after it, and what Cartographer
	// asked the agent while that call was carried out.
	const afterCall = new Map();
	const afterResult = [];
	const afterReply = [];
	const promoteChatSources = (message, source) => {
		if (message?.role !== "assistant" || source?.kind !== "durable-message") return;
		for (const part of message.content ?? []) if (part?.type === "toolCall" && part.name === "chat") {
			bindTalkSource(options.brainDir, { kind: "chat-call", conversationId: String(source.conversationId), callId: String(part.id) }, { ...source, callId: String(part.id) });
		}
	};
	const showOne = (depth, entry, consult) => {
		// `chat` records its tool call before Durable commits the assistant entry on some paths. Promote that
		// provisional call correlation to the admitted entry id before the screen exposes an edit handle.
		if (entry?.id !== undefined && entry?.conversationId !== undefined) for (const [position, message] of (entry.model ?? []).entries()) {
			promoteChatSources(message, { kind: "durable-message", conversationId: String(entry.conversationId), entryId: String(entry.id), position });
		}
		if (ui === undefined) showMessages(depth, entry);
		else {
			capture = [];
			let printed = "";
			try {
				showMessages(depth, entry);
				endLine();
			} finally {
				printed = capture.join("");
				capture = undefined;
			}
			for (const message of entry.model ?? []) if (message.role === "assistant") finished.add(message.timestamp);
			ui.entry(depth, entry, printed, consult);
		}
		if (depth === 0 && (entry.model ?? []).some((message) => message.role === "assistant")) for (const print of afterReply.splice(0)) print();
		for (const message of entry.model ?? []) {
			if (depth !== 0 || message.role !== "toolResult") continue;
			for (const print of afterResult.splice(0)) print();
			// A file the atlas made because a node was linked to it (src/atlas.mjs).
			if (Array.isArray(message.details?.created)) line(`${bold("●")} atlas  created ${message.details.created.join(", ")}, empty: a node was linked to ${message.details.created.length === 1 ? "it" : "them"} and ${message.details.created.length === 1 ? "it" : "they"} did not exist`);
			const waits = afterCall.get(message.toolCallId);
			afterCall.delete(message.toolCallId);
			if (waits !== undefined) line(waits);
		}
	};
	const showMessages = (depth, entry) => {
		const bar = depth === 0 ? "" : dim("│ ");
		for (const message of entry.model ?? []) {
			if (message.role === "user" && depth === 0 && isFront(message)) {
				collapsedLine();
			} else if (message.role === "user" && depth === 0 && isNoChat(message)) {
				// Said the first time in a turn; the later notes of the turn pass without a word.
				if (!/had no tool call\. Noted\./.test(typeof message.content === "string" ? message.content : textOf(message))) line(dim("◆ That reply had no tool call: it is a note the agent wrote to itself, not an answer to you. The agent goes on."));
			} else if (message.role === "assistant") {
				const text = textOf(message);
				const calls = callsOf(message);
				if (depth === 0) {
					// The reply may already be on screen from streaming; print what is missing.
					if (!finished.has(message.timestamp)) advance(message, true);
					finished.add(message.timestamp);
					endLine();
					// The newest reply says how full the context is. A reply that was stopped reports nothing.
					if ((message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0) > 0) lastUsage = message.usage;
					// A reply that hits the output limit just ends; without this line it looks as if the agent fell silent.
					if (message.stopReason === "length") line(`! The agent's reply was cut off at the output limit (maxTokens in the settings). Say "continue" to let it go on.`);
				} else if (text.trim() !== "" && thinking) {
					// A task's own words, beside its calls or as a note of their own.
					line(`${bar}${dim(oneLine(text, POLICY.limits.terminal.resultSummary.taskStream))}`);
				}
				// A reply cut off at the output limit may end in half a call, which is never carried out.
				let commandShown = false;
				for (const call of message.stopReason === "length" ? [] : calls) {
					const text = describeCall(call, describeRef);
					// A task runs for a while, so its call is shown at once. So is a command, the first of a reply: the
					// user sees what is running while it runs. Every other call is shown together with its result, as one line.
					// What `chat` says is on screen already.
					if (depth === 0 && call.name === "chat") continue;
					// What a task says to the user stands on the screen like any other `chat`.
					if (depth > 0 && call.name === "chat" && typeof call.arguments?.text === "string") {
						line(call.arguments.text);
						pendingCalls.set(call.id, { text, shown: true, quiet: true });
						continue;
					}
					// A question is shown when it is put (see `asks.on` below).
					if (call.name === "ask" || call.name === "return") {
						pendingCalls.set(call.id, { text, shown: true, quiet: true });
						continue;
					}
					// A task after other calls of the same reply starts when they are through: its line waits for them.
					const before = calls[calls.indexOf(call) - 1];
					if (depth === 0 && call.name === "task" && before !== undefined) afterCall.set(before.id, `${bold("▸")} ${text}`);
					else if (depth === 0 && call.name === "task") line(`${bold("▸")} ${text}`);
					// So is a wait of the main agent for a window: it can take minutes.
					else if (depth === 0 && call.name === "shell" && call.arguments?.action === POLICY.enums.shellAction.wait) {
						line(`${bold("▸")} ${text}`);
						pendingCalls.set(call.id, { text, shown: true });
					}
					else if (depth > 0 && (call.name === "shell" && ["run", "send", "wait"].includes(call.arguments?.action ?? "run")) && !commandShown) {
						commandShown = true;
						line(`${bar}${text}`);
						pendingCalls.set(call.id, { text, shown: true });
					} else pendingCalls.set(call.id, { text });
				}
			} else if (message.role === "toolResult") {
				if (depth === 0 && message.toolName === "chat") {
					if (message.isError) line(`${bold("●")} chat  not shown: ${oneLine(plain(textOf(message)), POLICY.limits.terminal.messageSummaryChars)}`);
				} else if (depth === 0) {
					if (message.toolName === "task") {
						// Without the line that tells the agent the id: the report line here shows it.
						const text = textOf(message).replace(KEPT_REPORT_SUFFIX, "");
						if (message.isError && /was aborted/.test(text)) {
							// A change task that was stopped has no record after it, but it may have written files already.
							line(`${bold("◂")} task stopped${message.details?.mode === POLICY.enums.planMode.change ? " · it may have changed files already: /diff shows them, /undo takes them back" : ""}`);
						} else if (message.isError) line(`${bold("◂")} ${oneLine(plain(text), POLICY.limits.terminal.messageSummaryChars)}`);
						else {
							lastReport = text;
							line(`${bold("◂")} report${message.details?.report ? ` ${message.details.report}` : ""}  ${count(text.length)} characters${message.details?.done === false ? " · returned not done" : ""}  ${dim("(/report shows it)")}`);
							// A focus reports one move; only the orchestrator accepts it after review.
							if (message.details?.move !== undefined && message.details?.done === true) line(`${bold("●")} plan  ${message.details.move} reported; review its evidence before accepting it`);
							else if (message.details?.done === false && message.details?.move !== undefined) line(`${bold("●")} plan  ${message.details.move} is blocked: ${message.details.reason ?? "the focus returned not done"}`);
						}
						// What the task put on the main agent's shelf.
						if (Array.isArray(message.details?.shelved)) {
							line(`${bold("◂")} shelf  the task added ${message.details.shelved.join(", ")}  ${dim("(/context shows the shelf)")}`);
						}
						// What a change task did to the files, from the checkpoints and not from its report.
						const changes = message.details?.changes;
						if (Array.isArray(changes)) {
							if (changes.length === 0) line(`${bold("◂")} no file was changed`);
							else {
								line(`${bold("◂")} changed ${changeSummary(changes)}  ${dim("(/diff shows the changes, /undo takes them back)")}`);
								for (const text of changeRecord(changes, POLICY.limits.terminal.changeRecordLines)) line(dim(text));
							}
						}
						// What shell windows changed before the task, with no task around them: a step of its own.
						const outside = message.details?.outside;
						if (outside !== undefined) windowStepLine(outside);
						const left = message.details?.windows;
						if (Array.isArray(left) && left.length > 0) line(`${bold("◂")} still running: ${left.map((name) => `window ${name}`).join(", ")}  ${dim("(/shells shows them, /kill NAME ends one)")}`);
						// What the task did to the graph, from the record as well.
						const mapped = message.details?.atlas;
						if (mapped !== undefined) {
							const parts = [];
							if (mapped.written?.length > 0) parts.push(`wrote ${oneLine(mapped.written.join(", "), POLICY.limits.terminal.resultSummary.atlasWritten)}`);
							if (mapped.removed?.length > 0) parts.push(`removed ${oneLine(mapped.removed.join(", "), POLICY.limits.terminal.resultSummary.atlasRemoved)}`);
							if (mapped.stale?.length > 0) parts.push(`may now be out of date: ${oneLine(mapped.stale.join(", "), POLICY.limits.terminal.resultSummary.atlasStale)}`);
							if (parts.length > 0) line(`${bold("◂")} atlas  ${parts.join(" · ")}  ${dim("(/atlas shows the graph)")}`);
						}
					} else if (message.toolName === "book") {
						// The brain tools; each keeps the words on the screen it had as a tool of its own.
						const name = message.details?.target ?? message.details?.book ?? "book";
						const call = pendingCalls.get(message.toolCallId);
						pendingCalls.delete(message.toolCallId);
						const shown = Array.isArray(message.details?.shown) ? message.details.shown : [];
						if (name === "ledger" || name === "plan") {
							if (message.isError || shown.length === 0) line(`${bold("●")} ${name}  not changed: ${oneLine(plain(textOf(message)), POLICY.limits.terminal.messageSummaryChars)}`);
							// A goal's done-when line goes on a line of its own: together they are too long to read as one.
							else for (const change of shown) line(`${bold("●")} ${name}  ${change.replace(/ \(done when: (.*)\)$/s, `\n${" ".repeat(name.length + 4)}done when: $1`)}`);
							if (message.details?.pinned === true) line(`${bold("●")} top of the context rewritten: the assessment and the graph as they are now ${dim("(the next answer reads the whole context again)")}`);
						} else if (name === "context") {
							if (message.isError || shown.length === 0) line(`${bold("●")} context  nothing done: ${oneLine(plain(textOf(message)), POLICY.limits.terminal.messageSummaryChars)}`);
							else for (const change of shown) line(`${bold("●")} context  ${oneLine(change, POLICY.limits.terminal.resultSummary.contextChange)}`);
						} else if (name === "assessment" && !message.isError && shown.length > 0) {
							for (const change of shown) line(`${bold("●")} ${change}  ${dim("(/assessment shows it)")}`);
						} else if (name === "atlas") {
							// What the agent wrote to its map, one line each.
							if (message.isError || shown.length === 0) line(`${bold("●")} atlas  not changed: ${oneLine(plain(textOf(message)), POLICY.limits.terminal.messageSummaryChars)}`);
							else for (const change of shown) line(`${bold("●")} atlas  ${oneLine(change, POLICY.limits.terminal.resultSummary.atlasChange)}`);
						} else {
							if (call?.quiet && !message.isError) continue;
							if (call?.shown && !call.quiet) line(`  ${dim(`→ ${describeResult(message)}`)}`);
							else line(`${bold("▸")} ${call?.text ?? name}  ${dim(`→ ${describeResult(message)}`)}`);
						}
					} else if (message.toolName === "wake" || message.toolName === "sleep") {
						pendingCalls.delete(message.toolCallId);
						const shown = Array.isArray(message.details?.shown) ? message.details.shown : [];
						if (message.isError || shown.length === 0) line(`${bold("●")} ${message.toolName}  ${message.toolName === "wake" ? "not changed" : "refused"}: ${oneLine(plain(textOf(message)), POLICY.limits.terminal.messageSummaryChars)}`);
						else for (const change of shown) line(`${bold("●")} ${message.toolName === "sleep" ? dim(change) : `wake  ${oneLine(change, POLICY.limits.terminal.resultSummary.wakeChange)}`}`);
					} else {
						const call = pendingCalls.get(message.toolCallId);
						pendingCalls.delete(message.toolCallId);
						if (call?.quiet && !message.isError) continue;
						if (call?.shown && !call.quiet) line(`  ${dim(`→ ${describeResult(message)}`)}`);
						else line(`${bold("▸")} ${call?.text ?? message.toolName}  ${dim(`→ ${describeResult(message)}`)}`);
					}
				} else {
					const call = pendingCalls.get(message.toolCallId);
					pendingCalls.delete(message.toolCallId);
					if (call?.quiet && !message.isError) continue;
					if (message.toolName === "return" && !message.isError) continue;
					if (call?.shown && !call.quiet) line(`${bar}  ${dim(`→ ${describeResult(message)}`)}`);
					else line(`${bar}${(call?.text ?? message.toolName).padEnd(48)} ${dim(`→ ${describeResult(message)}`)}`);
				}
			}
		}
	};

	/** What shell windows changed while no task ran. */
	function windowStepLine(step) {
		const who = step.names.length === 1 ? `window ${step.names[0]}` : `windows ${step.names.join(", ")}`;
		line(`${bold("◂")} ${who} changed ${changeSummary(step.changes)} with no task running  ${dim("(/diff shows the changes, /undo takes them back)")}`);
		for (const text of changeRecord(step.changes, POLICY.limits.terminal.changeRecordLines)) line(dim(text));
	}

	/** Print the main agent's reply as it is generated. */
	const showLive = (live, depth = 0, consult) => {
		const message = live?.generation?.message;
		const writing = message === undefined || finished.has(message.timestamp) ? undefined : message;
		checkRepeat(writing, depth);
		if (ui !== undefined) {
			ui.live(depth, writing, consult);
			// A conference child stays isolated from ordinary Work, but its live reasoning and local tools still need
			// to reach the dedicated Consult projection as they grow.
			ui.liveTools?.(depth, live?.tools, consult);
			return;
		}
		if (writing === undefined || depth > 0) return;
		advance(message, false);
	};

	// ─── A reply that repeats itself ─────────────────────────────────────────
	// A local model sometimes loses its way and writes the same character or phrase until it is stopped. That is
	// seen in the reply as it grows: the reply is cut off, and the agent is told and gets one more try. The second
	// time in a row, the agent is stopped and the user decides.
	let cuts = 0;
	let cutting = false;
	let cutDone = Promise.resolve();
	const repeatingIn = (message) => {
		for (const part of message.content ?? []) {
			const text = part.type === "thinking" ? part.thinking : part.type === "text" ? part.text : part.type === "toolCall" ? JSON.stringify(part.arguments ?? {}) : "";
			const found = repeats(text);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	const checkRepeat = (message, depth) => {
		if (message === undefined || cutting || stopped || closing || config.repeatCut === false) return;
		const found = repeatingIn(message);
		if (found === undefined) return;
		cutting = true;
		cuts++;
		const again = cuts > 1;
		const what = `${JSON.stringify(oneLine(found.unit, POLICY.limits.terminal.repeatedPhraseChars))}, ${found.times} times over`;
		line(`! The ${depth > 0 ? "task" : "agent"}'s reply was repeating itself (${what}). Cartographer cut it off${again ? " again, and stopped the agent: say how it should go on. If this keeps happening, look at the model's sampling settings." : " and lets the agent try once more."}`);
		streamFreeze.abandon();
		cutDone = main
			.abort(context)
			.then(() => harness.waitForIdle(context))
			.then(() =>
				enqueue(async () => {
					cutting = false;
					if (again || stopped || closing) return;
					await submit(REPEAT_NOTE(what, depth > 0));
				}),
			)
			.catch((error) => {
				cutting = false;
				line(`! could not stop the reply: ${error?.message ?? error}`);
			});
	};

	let busy = false;
	let stopped = false;
	let closing = false;
	let paused = false; // the user's pause: the agent is interrupted at once and gets nothing new until it is lifted
	let onIdle = () => {};
	// Wakes the agent may still get at once (see WAKE_BURST), and since when the next one is being earned.
	const spacing = (options.wakeMin ?? WAKE_MIN) * 1000;
	let credit = WAKE_BURST;
	let creditAt = Date.now();
	let slowed = false;
	let retry;
	/** The user wrote something: every wake is free again, and the turn that begins is theirs. */
	const userSpoke = () => {
		// The server is needed for their message now; what it was reading ahead can wait.
		stopReadAhead();
		clearTimeout(awayTimer);
		credit = WAKE_BURST;
		creditAt = Date.now();
		slowed = false;
		wakes?.begin([]);
		cuts = 0;
	};
	let lastFailure;

	// Every change is handled in order, one at a time, whichever conversation it came from.
	let queue = Promise.resolve();
	const enqueue = (work) => {
		queue = queue.then(work).catch((error) => line(`! display error: ${error?.message ?? error}`));
		return queue;
	};

	/** The folded blocks of a request (they are what the agent sees, and then does not need to hold again). */
	const printBlocks = (state, windows, tail) => {
		if (state !== undefined) ui.block("the state block — the time, the atlas, the ledger, the plan", state);
		if (windows !== undefined) ui.block("the shell windows as they stand", windows);
		if (tail !== undefined) ui.block("the current read batch — its contents stand at the end of the request", tail);
	};
	const isCollapsedFront = (depth, message, body = undefined) => {
		if (depth !== 0 || message.role !== "user") return false;
		let visible = body;
		if (visible === undefined) {
			const { text: afterTail } = splitReadTail(textOf(message));
			const { text: afterState } = splitState(afterTail);
			visible = splitTop(afterState).text;
		}
		return isFront({ role: "user", content: [{ type: "text", text: visible }] });
	};
	/**
	 * One dressed message, the way the agent sees it: folded for what the request adds, the message's own words in
	 * between, the blocks the message carries after it. The screen only; the plain terminal has its own behavior.
	 */
	const renderDressed = (depth, message, source, consult, collapseStore = {}) => {
		promoteChatSources(message, source);
		const original = textOf(message);
		const { text: afterTail, tail } = splitReadTail(original);
		const { text: afterState, state, windows } = splitState(afterTail);
		const { text: afterTop, top } = splitTop(afterState);
		const body = afterTop;
		const front = isCollapsedFront(depth, message, body);
		if (front) {
			// The front block of a collapse: everything before it is gone from the agent's view, so the tab shows
			// only the marker (the collapse leaves the intro alone), and then what stands in its place.
			ui.entry(depth, { model: [message] }, `◆ ${collapsePrinted({ reason: "a collapse", ...(collapseStore.last ?? {}), kept: collapseStore.last?.kept ?? collapseStore.front?.kept, left: collapseStore.front?.left })}`, consult);
			if (top !== undefined) ui.block("the copy at the top of the context — my assessment and my graph", top);
		} else {
			if (top !== undefined) ui.block("the copy at the top of the context — my assessment and my graph", top);
			if (message.role === "user" && body.startsWith(`${POLICY.markup.note.open}\n`)) {
				// A task's collapsed steps: one block stands in their place, and the steps themselves are gone.
				ui.print(`◆ its steps collapsed — their results are no longer in view, one line each says what they were\n`);
			} else if (message.role === "user") {
				const cleaned = withoutAdditions(body).trim();
				if (cleaned === "") {
					// A message that was all additions is not shown; the agent never saw words of its own there.
				} else if (isNote({ role: "user", content: [{ type: "text", text: cleaned }] })) {
					ui.print(`◆ a note Cartographer left itself: ${oneLine(cleaned.replace(/\n/g, " "), POLICY.limits.terminal.messageSummaryChars)}\n`);
				} else {
						ui.entry(depth, { model: [{ ...message, content: [{ type: "text", text: cleaned }] }], source }, "", consult);
				}
			} else {
				const cleaned = message.role === "toolResult" ? withoutAdditions(body).trim() : undefined;
					ui.entry(depth, { model: [cleaned === undefined ? message : { ...message, content: [{ type: "text", text: cleaned }] }] }, "", consult);
			}
		}
		if (state !== undefined || windows !== undefined || tail !== undefined) printBlocks(state, windows, tail);
	};
	/**
	 * Replay what the agent keeps in view, in the order it sees it: on start, before any new entry arrives. The
	 * plain terminal prints nothing of the past; the screen shows it. A task's replay begins at its brief (the
	 * fork point is the main conversation's story, shown at depth 0).
	 */
	const replayHistory = async (conversation, id, depth, fallback = [], consult) => {
		if (ui === undefined) return;
		// What the agent keeps in view is the current stretch of the conversation since its last restart, exactly as
		// the request sees it — not a window of the newest entries. The brief of a task's fork is in it, unless the task
		// has collapsed since, in which case everything before its restart is out of view anyway.
		let entries = fallback;
		try {
			entries = (await conversation.context(context)).entries ?? fallback;
		} catch {
			// An unreadable stretch: show what the watch happens to hold rather than nothing.
		}
		if (entries.length === 0) return;
		const found = depth === 0 ? 0 : entries.findIndex((entry) => entry.kind === "carto.brief" || entry.kind === "carto.sibling");
		const at = found < 0 ? 0 : found;
		const own = depth === 0 ? entries : entries.slice(at);
		if (consult !== undefined) {
			// A conference child has its own consult-local projection. Do not dress its replay through the ordinary
			// request/block renderer: that could surface private child state as a Work block before chat.mjs routes its
			// attributed messages to Consult. The durable co<N> audit remains the historic source of truth. Replay uses
			// only a durable message match for attribution; a later active speaker must not relabel old pruned activity.
			for (const entry of own) {
				const message = (entry.model ?? []).find((candidate) => candidate.role === "assistant") ?? (entry.model ?? [])[0];
				ui.entry(depth, entry, "", consultScope(id, message, { activeFallback: false }) ?? consult);
			}
			return;
		}
		// The brief and sibling notes of the fork are the main conversation's rows; they are not the task's story.
		const briefIds = new Set();
		for (const entry of own) for (const message of entry.model ?? []) if (message.role === "toolResult" && message.toolName === "task") briefIds.add(message.toolCallId);
		let view;
		try {
			view = await conversation.context(context);
		} catch {
			view = undefined;
		}
		let raw;
		let sources;
		if (view !== undefined) {
			// A task inherits its fork's active context. The screen starts at its brief, so retain only the active
			// contributions of its own stretch. This is still the Durable contribution projection, not entry.model.
			const allowed = new Set(own.map((entry) => String(entry.id)));
			const allSources = bridgeRequestSources(view.messages ?? [], view);
			const ownCalls = new Set();
			for (const [index, entry] of (view.entries ?? []).entries()) {
				if (!allowed.has(String(entry.id))) continue;
				for (const message of view.contributions?.[index] ?? []) if (message.role === "assistant") for (const part of message.content ?? []) if (part?.type === "toolCall") ownCalls.add(part.id);
			}
			raw = [];
			sources = [];
			for (const [index, message] of (view.messages ?? []).entries()) {
				const source = allSources[index];
				const ownMessage = source !== undefined && allowed.has(source.entryId);
				const ownSyntheticResult = source === undefined && message.role === "toolResult" && ownCalls.has(message.toolCallId);
				// The main view owns every active non-system row. An ambiguous bridge may still be shown, but reaches
				// Talk without an edit handle; it never borrows another row's identity.
				const ownUnmappedMain = depth === 0 && source === undefined && message.role !== "system";
				if (!ownMessage && !ownSyntheticResult && !ownUnmappedMain) continue;
				raw.push(message);
				sources.push(source);
			}
		} else {
			// An unreadable ContextView must not blank the screen. This compatibility fallback has no mutable source
			// handles: raw entry models are only shown, never used to target an edit or removal.
			raw = [];
			for (const entry of own) for (const message of entry.model ?? []) if (message.role !== "system") raw.push(message);
		}
		if (raw.length === 0) return;
		let dressed;
		let dressedSources;
		try {
			const plan = planRequest(raw, { brainDir: options.brainDir, root: options.root, runner: options.runner, config, gate, main: depth === 0, conversationId: depth === 0 ? undefined : id, used: engine.usedBy(id), sources, fired: [], wakeLines: depth === 0 ? wakes?.lines() : undefined, windowRows: windows?.list(config.windowTail) });
			dressed = plan.messages;
			dressedSources = new Map(plan.parts.filter((part) => part.kind === "active-message" || part.kind === "focus-capsule").map((part) => [part.message, part.sourceRef]));
		} catch (error) {
			ui.print(`! the stored conversation could not be shown as the agent sees it (${error?.message ?? error}); it is stored safely\n`);
			dressed = raw;
		}
		// This lifecycle replay resolves durable collapse metadata before it hands the matching row to the synchronous screen renderer.
		const contextProjection = dressed.some((message) => isCollapsedFront(depth, message)) ? await queries.context() : undefined;
		const collapseStore = contextProjection?.ok ? contextProjection.data.store : {};
		for (const [index, message] of dressed.entries()) {
			if (message.role === "toolResult" && briefIds.has(message.toolCallId)) continue;
			renderDressed(depth, message, dressedSources?.get(index), consult, collapseStore);
		}
	};

	/** Refresh the narrow routing cache before a child replay or live frame is classified. A failed refresh leaves the
	 * last safe route in place; it never falls back to opening a full conference record in ordinary Work lifecycle code. */
	const refreshConsultRouting = async () => {
		const projection = await queries.consult.routing();
		if (!projection.ok) return false;
		conferenceRoutes.clear();
		for (const route of projection.data.routes) {
			if (typeof route?.childConversationId === "string" && route.childConversationId !== "") conferenceRoutes.set(route.childConversationId, route);
		}
		return true;
	};
	/**
	 * Conference children are ordinary Durable conversations for scheduling, but not ordinary parent/focus work for
	 * presentation. The cached route carries only its co<N> identity, state, and opaque attribution keys; Consult
	 * itself owns the full audit record.
	 */
	const consultScope = (id, message, { activeFallback = true } = {}) => {
		const route = conferenceRoutes.get(String(id ?? ""));
		if (route === undefined) return undefined;
		let participant;
		if (message?.role === "assistant") {
			const calls = callsOf(message);
			const callIds = new Set(calls.map((call) => call.id).filter((callId) => typeof callId === "string"));
			const messageHash = callIds.size === 0 ? consultMessageFingerprint(textOf(message)) : undefined;
			const activity = route.activity?.findLast?.((entry) => entry?.participant && (
				(callIds.size > 0 && Array.isArray(entry.callIds) && entry.callIds.some((callId) => callIds.has(callId))) ||
				(callIds.size === 0 && entry.proseHash === messageHash)
			));
			participant = activity?.participant;
			if (participant === undefined && calls.some((call) => call.name === "consult_return")) participant = route.finalParticipant;
			if (participant === undefined && calls.length === 0) participant = route.turns?.findLast?.((turn) => turn.textHash === messageHash)?.participant;
		}
		if (activeFallback) participant ??= route.activeParticipant ?? route.finalParticipant;
		return { conference: route.conference, ...(participant === undefined ? {} : { participant }), ...(route.status === undefined ? {} : { status: route.status }) };
	};

	const follow = async (id, depth) => {
		const conversation = depth === 0 ? main : await harness.conversation(id, context);
		if (conversation === undefined) return;
		const watch = await conversation.watch(context);
		watches.push(watch);
		// A conference child is classified from the deferred minimal route before its synchronous replay renderer runs.
		if (depth > 0) await refreshConsultRouting();
		// Awaited: entries that come in while the replay is built are handed in after it, in order.
		const replayConsult = consultScope(id);
		await replayHistory(conversation, id, depth, watch.value.entries ?? [], replayConsult === undefined ? undefined : { conference: replayConsult.conference, status: replayConsult.status });
		if (depth === 0 && watch.value.docs["pi.live"]?.run !== undefined) line(dim("Continuing unfinished work from the last session…"));
		// The main agent's history is not replayed. A task is shown from its brief on.
		let newest = watch.value.entries.at(-1)?.id ?? 0;
		if (depth > 0) {
			const briefs = watch.value.entries.filter((entry) => entry.kind === "carto.brief" || entry.kind === "carto.sibling");
			newest = briefs.at(-1)?.id ?? newest;
		}
		const handle = async (value) => {
			if (stopped) return;
			// Participant state can advance independently of the Durable child entry. Refresh its opaque routing keys
			// before the synchronous renderer assigns this frame to Consult.
			if (depth > 0) await refreshConsultRouting();
			for (const entry of value.entries) if (entry.id > newest) {
				const message = (entry.model ?? []).find((candidate) => candidate.role === "assistant") ?? (entry.model ?? [])[0];
				showEntry(depth, entry, consultScope(id, message));
			}
			newest = Math.max(newest, value.entries.at(-1)?.id ?? 0);
			const live = value.docs["pi.live"];
			const writing = live?.generation?.message;
			if (depth > 0) showLive(live, depth, consultScope(id, writing));
			if (depth === 0) {
				showLive(live, 0, consultScope(id, writing));
				if (live?.runFailure !== undefined && live.runFailure.taskId !== lastFailure) {
					lastFailure = live.runFailure.taskId;
					const { reason, detail } = live.runFailure;
					if (reason === "turn_limit") {
						line(`! The agent used all its turns for this message (${detail ?? "the limit"}) without finishing. Say "continue" to let it go on.`);
					} else if (reason !== "aborted") {
						failed = true;
						line(`! the run stopped: ${reason}${detail ? ` (${oneLine(detail, POLICY.limits.terminal.resultSummary.runFailure)})` : ""}`);
					}
				}
				const nowBusy = live?.run !== undefined;
				if (busy && !nowBusy) {
					busy = false;
					onIdle();
				} else busy = nowBusy;
			}
			// A running task names its own conversation in the call's details.
			for (const slot of live?.tools ?? []) {
				const child = slot.details?.conversationId;
				if (child !== undefined && !attached.has(child)) {
					attached.add(child);
					await follow(child, depth + 1);
				}
			}
		};
		await handle(watch.value);
		watch.start(async (call) => {
			if (call.kind === "value") await enqueue(() => handle(call.value));
		});
	};

	// ─── The context engine on screen (src/engine.mjs) ──────────────────────
	const tokens = (n) => (Number.isFinite(n) ? `${count(n)}` : "?");
	/** The words of the collapse marker, in a few lines; `line` per piece elsewhere. */
	const collapsePrinted = (info) => {
		const kept = [plural(info.kept?.tasks ?? 0, "task record"), plural(info.kept?.shelf ?? 0, "shelf item"), `${plural(info.kept?.talk ?? 0, "message")} of talk`].join(", ");
		const size = info.before !== undefined && info.after !== undefined ? `about ${tokens(info.before)} → ${tokens(info.after)} tokens` : info.after !== undefined ? `now about ${tokens(info.after)} tokens` : "";
		const lines = [`context collapsed (${ofAgent(info.reason)})${size === "" ? "" : `: ${size}`} · kept ${kept}  (/context shows it)`];
		for (const entry of info.left ?? []) lines.push(`  taken off the shelf: ${shelfLabel(entry.item)} (${entry.why})`);
		return lines.join("\n");
	};
	/** A collapse of the main context, said when its front block shows up in the conversation. */
	function collapsedLine() {
		// Said once: by `rest` for a collapse it made, by the conversation's entry for one made in the middle of a turn.
		const info = engine?.takeCollapsed();
		if (info === undefined) return;
		line(`${bold("◆")} ${collapsePrinted(info)}`);
	}
	/** A reason as the front block words it for the agent ("you asked for it"), worded for the user. */
	const ofAgent = (reason) => reason.replace(/^you asked/, "the agent asked").replace(/ while you rested$/, " while it rested");
	/** A reason as the engine words it for a task ("My context held …"), worded for the user. */
	const ofTask = (reason) => oneLine(reason, POLICY.limits.terminal.resultSummary.taskReason).replace(/^My context/, "its context").replace(/^I asked/, "it asked");
	/** The question before a collapse and what came back. */
	const askedLine = (event) => {
		const who = event.task ? dim("│ ") : "";
		if (event.skipped) line(`${who}${dim("◆ not asked before collapsing: carto has only just started, and the question would make the server read the whole context first")}`);
		else if (event.error !== undefined) line(`${who}! The question before the collapse got no answer (${oneLine(event.error, POLICY.limits.terminal.messageSummaryChars)}). The context is collapsed without it.`);
		else line(`${who}${dim(`◆ asked before collapsing (${event.task ? ofTask(event.reason) : event.reason}): does it need to write something down first? ${event.handoff ? "yes" : "no"} · ${(event.ms / 1000).toFixed(1)} s`)}`);
	};
	engine?.on((event) => {
		enqueue(async () => {
			if (stopped) return;
			if (event.type === "asked" && !event.task && busy) afterResult.push(() => askedLine(event));
			else if (event.type === "asked") askedLine(event);
			else if (event.type === "task-collapsed") line(`${dim("│ ")}${bold("◆")} the task's steps collapsed (${ofTask(event.reason)}): ${event.replies === 1 ? "1 reply" : `${event.replies} replies`} with ${plural(event.calls, "call")}, now one block of notes`);
		});
	});
	// The read-ahead that is on its way, and the timer for the user being away.
	let readingAhead;
	let awayTimer;
	let reprompt = () => {};
	function stopReadAhead() {
		readingAhead?.abort();
		readingAhead = undefined;
	}
	/**
	 * The agent rests: collapse its context when that is due. With `away`, the user has been gone for a while;
	 * with `user`, they asked for it; with `final`, nothing follows, so nothing is read ahead.
	 * @returns {Promise<boolean>} whether something was done
	 */
	const rest = async ({ away = false, user = false, final = false } = {}) => {
		// Paused, the context is left as it stands, unless the user asked for the collapse themselves.
		if (engine === undefined || busy || stopped || closing || (paused && !user)) return false;
		const view = await main.context(context);
		const would = engine.droppable(view.messages);
		const due = engine.due();
		let reason;
		let asked = false;
		if (user) reason = `${USER_NAME} asked for it`;
		else if (due !== undefined && (due.asked || due.forced === true || would >= FLOOR)) {
			reason = due.reason;
			asked = due.asked === true;
		} else if (would >= config.collapseTokens) reason = `about ${tokens(would)} tokens of finished work were in view while you rested`;
		else if (away && would >= FLOOR) reason = `${USER_NAME} had been away for ${took(config.collapseMinutes * 60_000)}`;
		else {
			engine.forget();
			return false;
		}
		// O1: the metacognition question before a collapse is opt-in (config handoffQuestion). Off, the collapse is mechanical.
		if (!asked && config.handoffQuestion === true) {
			const results = view.messages.slice(view.messages.findLastIndex((message) => message.role === "assistant") + 1).filter((message) => message.role === "toolResult");
			const choice = await engine.ask(main.id, { reason, results });
			askedLine({ reason, ...choice });
			if (choice.handoff) {
				// One turn to write it down; the collapse comes when that turn is over.
				engine.want(reason, { asked: true, atRest: true });
				wakes?.begin([]);
				const submission = await submit(HANDOFF_NOTE(reason));
				if (submission === undefined) return false;
				if (!options.interactive) {
					await waitFor(submission);
					await settle();
					usageLine();
					return await rest({ final });
				}
				return true;
			}
		}
		const { text, info } = engine.collapse({ reason });
		await main.reset(text, context);
		// A collapse is the boundary at which the prompt the agent approved for itself takes effect.
		// In the line-by-line terminal the marker is said here; in the full screen it is said by the
		// conversation's front-block entry, so that it is said after everything before it is wiped.
		if (ui === undefined) collapsedLine();
		// Read-ahead is optional performance work, never a reason to wake or require a model while Cartographer is
		// opening offline. Once the first actual model turn has proven its route, it resumes its usual behavior.
		if (config.readAhead !== false && !final && modelRouteReady) {
			const ahead = engine.readAhead(text, info.at);
			if (ahead !== undefined) {
				readingAhead = ahead;
				const said = ahead.done.then((result) =>
					enqueue(async () => {
						if (readingAhead === ahead) readingAhead = undefined;
						if (stopped || result.aborted) return;
						if (result.error !== undefined) line(dim(`  the server could not read the new context ahead (${oneLine(result.error, POLICY.limits.terminal.resultSummary.readAheadError)}); the next answer reads it`));
						else line(dim(`  read ahead by the server${result.tokens ? `: ${tokens(result.tokens)} tokens` : ""} in ${(result.ms / 1000).toFixed(1)} s, so the next answer starts at once`));
						reprompt();
					}),
				);
				if (!options.interactive) await said;
			}
		}
		return true;
	};

	/** Wait until the main agent is idle and everything it did has been printed. */
	const settle = async () => {
		for (;;) {
			// A reply that was cut off for repeating itself gets one more try, which is part of this turn.
			const cut = cutDone;
			await cut;
			await harness.waitForIdle(context);
			for (let i = 0; i < POLICY.timing.terminal.settleFlushPasses; i++) {
				await new Promise((resolve) => setTimeout(resolve, POLICY.timing.terminal.inputFlushMs));
				await queue;
			}
			if (cut === cutDone && !cutting) break;
		}
		for (const print of [...afterResult.splice(0), ...afterReply.splice(0)]) print();
		endLine();
	};

	// ─── Questions the agent waits on (src/asks.mjs), and what the session says for itself ──
	/** Lines of piped input that are still to come: one of them answers a question the agent puts. */
	const piped = [];
	let askPrompt = () => {};
	const showQuestion = (question) => {
		line(`${bold("?")} ${questionText(question.text, question.choices).split("\n").join("\n  ")}`);
		line(dim(`  ${question.choices.length > 0 ? "Type a number, or an answer of your own." : "Type your answer."} The ${question.task ? "task" : "agent"} waits for it.`));
	};
	asks?.on((event) => {
		enqueue(async () => {
			if (stopped) return;
			if (event.type === "asked") {
				showQuestion(event.question);
				askPrompt();
			} else if (event.outcome?.kind === "timeout") {
				// The prompt for the answer stands on this line: take it away.
				if (out.isTTY) out.write("\r\x1b[2K");
				line(dim(`  no answer within ${spanOf(event.outcome.minutes)}: the agent is told and goes on`));
			} else if (event.outcome?.kind === "absent") line(dim("  nobody is at the terminal to answer: the agent is told and goes on"));
		});
	});
	session.on?.((event) => {
		enqueue(async () => {
			if (stopped) return;
			if (event.type === "model-ready") {
				applyModelLimits(event.limits);
				modelRouteReady = true;
				lastModelError = undefined;
				ui?.modelReady?.();
				return;
			}
			if (event.type === "model-error") {
				showModelError(event.error);
				return;
			}
			if (event.main !== true) return;
			// Said after the reply it is about, which comes in a moment later.
			if (event.type === "limit") afterReply.push(() => line(`! The agent made ${event.replies} replies in this turn without calling \`sleep\`, so Cartographer ended the turn. Say "continue" to let it go on.`));
			else if (event.type === "same-note") afterReply.push(() => line(`! Cartographer ended the turn: the agent wrote ${event.empty ? `nothing and called nothing, ${event.times} times in a row` : `the same note ${event.times} times in a row and called nothing`}.`));
		});
	});
	/** With piped input: wait for a turn to end. A question put meanwhile is answered by the next line of input. */
	const waitFor = async (submission) => {
		let over = false;
		const done = submission.wait(context).then(() => {
			over = true;
		});
		while (!over) {
			let off = () => {};
			const asked = new Promise((resolve) => {
				if (asks?.pending() !== undefined) return void resolve();
				off = asks?.on((event) => event.type === "asked" && resolve()) ?? off;
			});
			await Promise.race([done, asked]);
			off();
			if (over) break;
			// The question is printed before it is answered.
			await queue;
			if (asks?.pending() === undefined) continue;
			// A command among the piped lines is carried out; the first line that is none is the answer.
			while (piped[0]?.startsWith("/")) await command(piped.shift());
			const answer = piped.shift();
			if (answer === undefined) asks.absent();
			else {
				line(`› ${answer}`);
				asks.answer(answer);
			}
			await new Promise((resolve) => setTimeout(resolve, POLICY.timing.terminal.taskFlushMs));
		}
	};

	const usageLine = () => {
		if (lastUsage === undefined) return;
		const size = (lastUsage.input ?? 0) + (lastUsage.cacheRead ?? 0) + (lastUsage.output ?? 0);
		contextSize = size;
		// The full screen shows this in its status strip, all the time.
		if (ui !== undefined) return void (lastUsage = undefined);
		line(dim(`  context ${count(size)} of ${count(options.contextWindow)} tokens · ${count(lastUsage.input ?? 0)} read for this answer`));
		lastUsage = undefined;
	};

	/** One line on the ledger; a file that cannot be read is said loudly, because the agent cannot use it either. */
	const renderLedgerLine = (projection) => {
		if (!projection.ok) return line(`! ${projection.error.message}. Repair the file; until then the agent works without it.`);
		const { ledger } = projection.data;
		if (open(ledger, POLICY.enums.ledgerKind.goal).length === 0) line(dim(`ledger: ${openCounts(ledger)} · no goal yet: say what you want to achieve`));
		else line(dim(`ledger: ${openCounts(ledger)} · /ledger shows them`));
	};
	const ledgerLine = async () => renderLedgerLine(await queries.ledger());

	/** One line on the plan, when there is one. */
	const planLine = async () => {
		const projection = await queries.plan();
		if (!projection.ok) return line(`! ${projection.error.message}. Repair the file; until then no declared move can run.`);
		const plan = projection.data.plan;
		if (plan.items.length === 0) return;
		line(dim(`plan: ${planSummary(plan)} · /plan shows envelopes and moves${awaitsApproval(plan) && !gate.yolo ? ", /approve snapshots current move revisions" : ""}`));
	};

	/** Said once for each state of the plan that waits for the user, when the agent has stopped. */
	let reminded;
	const approvalLine = async () => {
		const projection = await queries.plan();
		if (!projection.ok || !planWaits(projection.data.plan) || gate.yolo) {
			reminded = undefined;
			return;
		}
		const waiting = waitingItems(projection.data.plan);
		const mark = JSON.stringify(waiting.map((move) => [move.id, move.action ?? move.text, move.capabilities?.network === true]));
		const online = waiting.filter((move) => move.capabilities?.network === true).length;
		const notes = [online > 0 ? `${online} with network access` : ""].filter((note) => note !== "");
		if (mark === reminded) return;
		reminded = mark;
		line(`${bold("plan")}  ${plural(waiting.length, "change move")} ${waiting.length === 1 ? "waits" : "wait"} for you${notes.length > 0 ? ` (${notes.join(", ")})` : ""}: /plan shows the move contracts, /approve snapshots their current revisions`);
	};

	const submit = async (content) => {
		// A new turn: what the last one held back is no longer the newest thinking.
		if (!busy) held = "";
		const ledgerProjection = await queries.ledger();
		if (!ledgerProjection.ok) renderLedgerLine(ledgerProjection);
		// This runs after the terminal has opened. A cold llama-swap route may now load, but an absent server leaves
		// the local Cartographer session open and the user's message is not admitted into an unserviceable run.
		if (!(await ensureModelReady())) return undefined;
		busy = true;
		try {
			// While the agent is working, a message joins the current run after its current tool round.
			return await main.submit({ type: "input", content, whenBusy: "steer" }, context);
		} catch (error) {
			line(`! could not send: ${error?.message ?? error}`);
			return undefined;
		}
	};

	/** Send a message the program writes on the user's behalf. With piped input, wait for the answer as for any line. */
	const send = async (content) => {
		const submission = await submit(content);
		if (submission === undefined || options.interactive) return;
		await waitFor(submission);
		await settle();
		usageLine();
		await approvalLine();
	};

	/**
	 * Record what the windows changed since the last checkpoint as a step of its own. Only while no task runs: during
	 * a change task the changes are the task's.
	 */
	const recordWindows = async () => {
		if (windows === undefined || busy) return undefined;
		const outcome = await application.execute(REVIEW_ACTION.recordWindows);
		if (!outcome.ok) {
			line(`! ${outcome.error.message}`);
			return undefined;
		}
		const step = outcome.data.step;
		if (step !== undefined) windowStepLine(step);
		return step;
	};

	// A wake the agent set has fired while it works: it finds the firing in the state block of its next request. If
	// it is only waiting for a window, that wait ends, so that the request comes now. A task that waits goes on
	// waiting: the main agent is told when the task has reported.
	wakes?.on((event) => {
		if (!busy) return;
		line(`${bold("◆")} ${eventLine(event)}  ${dim("(the agent is working: it reads this at its next step)")}`);
		windows?.nudge(`your wake ${event.id} fired (${event.about}): ${event.what}`, { mainOnly: true });
	});
	/** What the piped loop and the prompt do when a held wake becomes free. */
	let onRetry = () => {};
	/**
	 * Tell the agent what happened while it was not working (in its shell windows, or a wake it set fired), so that
	 * it goes on by itself.
	 * @returns the submission, or undefined when there was nothing to tell, the agent is busy, or the wake has to wait
	 */
	const wake = async () => {
		// Paused, the agent is woken by nothing: what happened waits, and is told when the pause is lifted.
		if (paused || busy || stopped || !(windows?.hasNews() || wakes?.hasNews())) return undefined;
		const earned = Math.floor((Date.now() - creditAt) / spacing);
		if (earned > 0) {
			credit = Math.min(WAKE_BURST, credit + earned);
			creditAt = credit === WAKE_BURST ? Date.now() : creditAt + earned * spacing;
		}
		if (credit <= 0) {
			// Nothing is taken: what happened is told when the next wake is free.
			if (!slowed) line(`! The agent was woken ${WAKE_BURST} times in quick succession without a word from you. From here on it is woken at most once every ${took(spacing)}; what happens meanwhile is told together. Write something to lift this; /stop stops it, /wakes and /shells show what wakes it.`);
			slowed = true;
			if (retry === undefined) {
				retry = setTimeout(() => {
					retry = undefined;
					onRetry();
				}, Math.max(POLICY.timing.terminal.retryMinimumMs, creditAt + spacing - Date.now()));
				retry.unref();
			}
			return undefined;
		}
		const events = [...(windows?.takeNews() ?? []), ...(wakes?.takeNews() ?? [])];
		for (const event of events) line(`${bold("◆")} ${eventLine(event)}`);
		const step = await recordWindows();
		if (step !== undefined) events.push({ type: "changed", names: step.names, summary: changeSummary(step.changes) });
		if (credit === WAKE_BURST) creditAt = Date.now();
		credit--;
		wakes?.begin(events.filter((event) => event.type === "wake").map((event) => event.id));
		return await submit(wakeNote(events));
	};
	/** How long until a held wake is free, in ms; undefined when none is held. */
	const heldFor = () => (credit <= 0 && (windows?.hasNews() || wakes?.hasNews()) ? Math.max(0, creditAt + spacing - Date.now()) : undefined);

	/** With piped input: let the agent react to its windows before the next line is read. */
	const woken = async () => {
		for (;;) {
			const submission = await wake();
			if (submission === undefined) return;
			await waitFor(submission);
			await settle();
			usageLine();
			await approvalLine();
		}
	};

	/** The prompt says when the sandbox is off, so that it cannot be forgotten. */
	let setPrompt = () => {};

	const command = async (text) => {
		const [name, ...parts] = text.slice(1).trim().split(/\s+/);
		const argument = parts[0];
		const args = parts.filter((part) => part !== "");
		const tail = args.slice(1).join(" ");
		// Anything written while the agent is held in its stream lets go of that stream — except /pause, the lever itself.
		if (paused && name !== "pause" && streamFreeze.frozen()) {
			streamFreeze.abandon();
			line(dim("  (the held stream was let go: the agent's reply ends here)"));
		}
		switch (name) {
			case "help":
				line(
					[
						"  /thinking  show or hide what the agent thinks and notes for itself (/thinking on, /thinking off; Ctrl-T does the same)",
						"  /report   the last task's report in full; /report t12 shows a kept one",
						"  /consult  consultation conference audits; /consult co1 shows its immutable packet, participant/selector trail, receipts, and final or incomplete outcome; /consult probe [PATH] writes a no-project llama.cpp native-grammar selector diagnostic",
						"  /ledger   goals, questions and notes, open and closed, and where the file is",
						"  /plan     the plan, whether it is authorized, and where the file is",
						"  /atlas    the tree as the agent sees it, its local attention map, the graph's nodes, and where the file is",
						"  /focus TARGET reason    set an explicit atlas focus on a node id/name or project path",
						"  /unfocus  clear the explicit atlas focus (a running move's targets remain temporary)",
						"  /assessment  the agent's summary of the project, and where the file is",
						"  /pin      rewrite the copy of assessment and graph at the top of the context now",
						"  /requests what waits for you: declared move revisions and questions of taste",
						"  /approve  /approve ID ... approves those requests; /approve alone snapshots every current waiting move revision",
						"  /deny     /deny ID [why] turns a request down; /delete ID --yes forgets one without a word to the agent",
						"  /answer   /answer ID words answers a question of taste",
						"  /pause    hold the agent in its stream mid-reply (Ctrl-V); until you unpause it starts nothing of its own — a line or command you write ends the held stream",
						"  /yolo     /yolo on lets declared change moves run without /approve while you watch; /yolo off ends that",
						"  /initiate /initiate off keeps the agent waiting for you at the start; /initiate on lets it start on its own again",
						"  /wakes    what the agent has set to wake itself; /wakes remove ID (or all) takes one away",
						"  /diff     what the last change task did to the files (/diff all: the whole patch)",
						"  /undo     take the last change task back; again for the one before it",
						"  /bwrap    how tasks' commands run; /bwrap off runs them without the sandbox, /bwrap on with it",
						"  /shells   the shell windows: what runs in each, for how long, and its newest lines",
						"  /kill     /kill NAME closes a shell window and ends what runs in it; /kill all closes every one",
						"  /stop     stop what the agent is doing (Ctrl-X does the same); shell windows keep running",
						"  /model    the models the server serves; /model NAME (or a number) switches to one",
						"  /context  what the agent's context holds: its parts, their sizes, the shelf, when it is next collapsed",
						"  /fold ID  what the agent does with `fold`: take a report out of view, leaving its one line",
						"  /recall ID  bring a kept report back in full; /shelve and /unshelve tend the shelf as the agent does",
					"  /archive ID …, /unarchive ID …  take a row out of what the agent reads, or bring it back: a report's record line (t1), a ledger entry, a plan envelope or move, a node of the graph; the row stays on disk either way",
					"  /done ID …  settle rows; a reported move needs /done mN -- REVIEW saying why its proof witnesses its done-when",
					"  /delete ID … --yes  a row is gone for good and the agent is not told: a report (its record line and its file), a ledger entry, a plan envelope or move, a node of the graph",
						"  /collapse collapse the context now: task records, the shelf and the last of the talk stay",
						"  /send NAME line  type a line into a shell window, as you; /shells lists the windows",
						"  /new      start a fresh context with nothing kept in view; the session's history stays stored",
						"  /status   where the brain is and how full the context is",
						"  /quit     leave; unfinished work continues the next time carto starts here",
					].join("\n"),
				);
				return true;
			case "requests": {
				const result = await queries.requests({ yolo: gate.yolo });
				if (!result.ok) line(`! ${result.error.message}`);
				else {
					const all = result.data.items;
					for (const issue of result.data.issues) line(`! ${issue.message}`);
					if (all.length === 0) line("  Nothing waits for you. /plan, /ledger and /requests show what the agent has written.");
					else {
						line(`  ${bold("Requests")}  ${plural(all.length, "request")} wait${all.length === 1 ? "s" : ""} for you:`);
						for (const request of all) line(`    ${request.id}  [${request.kind}]  ${request.text}`);
						line(dim("  /approve ID ... approves · /deny ID [why] turns one down · /answer ID words answers a question"));
					}
				}
				return true;
			}
			case "report": {
				if (argument !== undefined) {
					const result = await queries.report(argument);
					line(result.ok ? result.data.text : result.error.kind === "not-found" ? `  ${result.error.message} /context lists the kept ones.` : `! ${result.error.message}`);
				} else line(lastReport === undefined ? "  No task has reported in this run of carto." : lastReport);
				return true;
			}
			case "consult": {
				if (argument === "probe") {
					if (args.length > 2) {
						line("  /consult probe [PATH] accepts at most one project-relative JSON log path (paths with spaces are not supported).");
						return true;
					}
					if (busy) {
						line("  The agent is working. /stop first, then /consult probe, so the raw native-grammar check does not compete with a live request.");
						return true;
					}
					try {
						if (!(await ensureModelReady())) return true;
						const models = await queries.runtime.models();
						const modelId = models.ok ? models.data.currentId ?? config.model : config.model;
						const logPath = selectorProbeLogPath({ root: options.root, brainDir: options.brainDir, path: args[1] });
						line(dim("  Running two synthetic, selector-only llama.cpp GBNF requests. They send no project files, chat, tools, or conference capture."));
						const record = await runLlamaCppSelectorProbe({ server: config.server, modelId });
						const written = writeSelectorProbeLog(logPath, record);
						line(renderLlamaCppSelectorProbe(record));
						const shown = relative(options.root, written) || written;
						line(`  JSON log: ${shown}${args[1] === undefined ? "  (ignored under .brain/export; pass a project-relative PATH to commit one)" : ""}`);
						line(dim("  A PASS is inspectable evidence for Cartographer's required native-grammar boundary on this endpoint; it does not establish calibrated or semantically correct routing."));
					} catch (error) {
						const message = error instanceof ConsultProbeError ? error.message : error?.message ?? String(error);
						line(`! Native llama.cpp selector probe could not run: ${message}`);
					}
					return true;
				}
				if (argument !== undefined) {
					const result = await queries.consult.get(argument);
					line(result.ok ? renderConference(result.data.conference) : `! ${result.error.message}`);
					return true;
				}
				const result = await queries.consult.list();
				if (!result.ok) line(`! ${result.error.message}`);
				else if (result.data.conferences.length === 0) line("  No consultation conference stands yet. A same-model `consult` creates a co<N> record; /consult co1 shows its private auditable notebook. /consult probe checks a llama.cpp native GBNF selector without creating a conference.");
				else {
					line(`  ${bold("Consult conferences")}`);
					for (const entry of result.data.conferences) line(entry.error === undefined ? `    ${conferenceStatusLine(entry.conference)}` : `    ${entry.id} · unreadable: ${entry.error}`);
					line(dim("  /consult co1 shows immutable sources, roster snapshots, participant turns, selector grammar events, tool receipts, and the returned or incomplete outcome. /consult probe [PATH] writes a standalone native-grammar diagnostic. /stop cancels an active outer call."));
				}
				return true;
			}
			case "context": {
				if (engine === undefined) return true;
				const projection = await queries.runtime.context();
				if (!projection.ok) {
					line(`! ${projection.error.message}`);
					return true;
				}
				const { messages, sizes } = projection.data;
				const contextWindow = projection.data.contextWindow ?? options.contextWindow;
				const row = (name, n, what) => line(`    ${name.padEnd(8)}${tokens(n).padStart(7)}   ${what}`);
				const known = [sizes.fixed, sizes.top, sizes.front?.total, sizes.work, sizes.state].reduce((sum, n) => sum + (n ?? 0), 0);
				if (sizes.fixed === undefined) line(`  The agent's context: of ${tokens(contextWindow)} tokens, not measured yet (nothing has been sent in this run of carto yet; the parts below are estimates, without the prompt and the tools)`);
				else line(`  The agent's context: about ${tokens(sizes.used ?? known)} of ${tokens(contextWindow)} tokens${sizes.used === undefined ? " (estimated; the server has not counted it yet)" : " (measured, as the server counted it; the parts below are estimates)"}`);
				row("fixed", sizes.fixed, "the prompt and the tools; never changes");
				row("top", sizes.top, "the assessment and the graph, as copied at the last collapse");
				if (sizes.front === undefined) row("kept", 0, "nothing yet: the context has not been collapsed");
				else {
					const t = sizes.front.tokens ?? {};
					row("record", t.record, `${plural(sizes.front.kept?.tasks ?? 0, "finished task")}, one line each`);
					row("shelf", t.shelf, (sizes.front.shelf ?? []).length === 0 ? "empty" : (sizes.front.shelf ?? []).map((item) => `${shelfLabel(item)} [${item.id}]`).join(", "));
					row("talk", t.talk, `${plural(sizes.front.kept?.talk ?? 0, "message")} between you and the agent, of at most ${tokens(config.chatWindow)} tokens`);
				}
				const since = messages.filter((message) => !isFront(message)).length;
				const from = sizes.front === undefined ? "the start" : "the last collapse";
				row("work", sizes.work, since === 0 ? `nothing since ${from}` : `${plural(since, "message")} since ${from}; a collapse frees about ${tokens(sizes.frees)}`);
				row("state", sizes.state, "the state block, written anew for every request");
				const store = sizes.store;
				const waiting = store.shelf.filter((item) => !(sizes.front?.shelf ?? []).some((entry) => sameShelfItem(entry, item)));
				const leaving = (sizes.front?.shelf ?? []).filter((entry) => !store.shelf.some((item) => sameShelfItem(entry, item)));
				if (waiting.length > 0) line(`  new shelf snapshots, in view now and carried into the next collapse: ${waiting.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}`);
				if (leaving.length > 0) line(`  taken off the shelf, gone at the next collapse: ${leaving.map((item) => `${shelfLabel(item)} [${item.id}]`).join(", ")}`);
				if (composedRows(store).length > 0) {
					line(`  kept reports: ${composedRows(store).length} (${composedRows(store)[0].id} to ${composedRows(store).at(-1).id}); the newest:`);
					for (const record of composedRows(store).slice(-POLICY.limits.terminal.recentReports)) line(dim(`    ${oneLine(recordLine(record), POLICY.limits.terminal.resultSummary.reportLine)}`));
				}
				if (store.last !== undefined) line(`  last collapse: ${stamp(store.last.at)} (${ofAgent(store.last.reason)})${store.last.before !== undefined && store.last.after !== undefined ? `, about ${tokens(store.last.before)} → ${tokens(store.last.after)} tokens` : ""}`);
				line(
					dim(
						`  next: while the agent rests, once ${tokens(config.collapseTokens)} tokens would go${config.collapseMinutes > 0 ? ` or you have been away ${took(config.collapseMinutes * 60_000)}` : ""}; when a goal closes; while it works, at ${tokens(sizes.full)} tokens. /collapse does it now.`,
					),
				);
				line(dim(`  ${contextPath(options.brainDir)} · the reports are in ${join(options.brainDir, "reports")}`));
				return true;
			}
			case "collapse": {
				if (busy) {
					line("  The agent is working. /stop first, then /collapse; or tell it to collapse its context.");
					return true;
				}
				if (!(await rest({ user: true }))) line("  Nothing was collapsed.");
				return true;
			}
			case "ledger": {
				const result = await queries.ledger();
				if (!result.ok) line(`! ${result.error.message}`);
				else line(renderLedger(result.data.ledger, { closed: true }));
				line(dim(`  ${queries.paths.ledger} · edit it by hand, or tell the agent what to change`));
				return true;
			}
			case "plan": {
				const result = await queries.plan();
				if (!result.ok) line(`! ${result.error.message}`);
				else line(renderPlan(result.data.plan, { done: true, yolo: gate.yolo }));
				line(dim(`  ${queries.paths.plan} · edit it by hand, or tell the agent what to change`));
				return true;
			}
			case "focus": {
				if (argument === undefined || tail === "") {
					line("  /focus needs a node id/name or project path, then a short reason. Example: /focus c3 trace the request path");
					return true;
				}
				line(await workspaceLine(WORKSPACE_ACTION.focusAtlas, { target: argument, reason: tail }));
				return true;
			}
			case "unfocus":
				line(await workspaceLine(WORKSPACE_ACTION.unfocusAtlas));
				return true;
			case "atlas": {
				const [result, tree] = await Promise.all([queries.atlas(), queries.tree()]);
				const atlas = result.ok ? result.data.atlas : undefined;
				line(bold("Tree"));
				if (!tree.ok) line(`! ${tree.error.message}`);
				else {
					if (result.ok) for (const issue of tree.data.issues) line(`! ${issue.message}`);
					line(treeSection(options.root, atlas?.view, {
						marks: new Map(Object.entries(tree.data.marks)),
						files: tree.data.files.map((file) => file.path),
						depth: options.treeDepth,
					}).text);
				}
				if (!result.ok) line(`! ${result.error.message}`);
				else {
					for (const issue of result.data.issues) line(`! ${issue.message}`);
					line(bold(`Graph: ${atlasSummary(atlas)}`));
					const local = renderAttention(result.data.attention, { idle: !busy && result.data.attention.active.length === 0 });
					if (local !== "") line(local);
					if (atlas.nodes.length > 0) line(renderOutline(atlas, Number.POSITIVE_INFINITY));
				}
				line(dim(`  ${queries.paths.atlas} · /focus TARGET reason sets a lens; /unfocus clears it; edit it by hand, or tell the agent what to change`));
				return true;
			}
			case "assessment": {
				const result = await queries.runtime.assessment();
				if (!result.ok) line(`! ${result.error.message}`);
				else {
					const { assessment, top, changes } = result.data;
					line(assessment.text === "" ? "  No assessment yet. The agent writes one when it knows the project." : assessment.text);
					const lag = changes !== undefined && (changes.assessment || changes.written.length > 0 || changes.removed.length > 0);
					if (top !== undefined) line(dim(`  The copy at the top of the agent's context is from ${stamp(Date.parse(top.at))} (${top.reason})${lag ? "; the assessment or the graph changed since. It is rewritten when a goal closes, on /new, or with /pin" : " and is current"}.`));
				}
				line(dim(`  ${queries.paths.assessment} · edit it by hand, or tell the agent what to change`));
				return true;
			}
			case "pin": {
				if (busy) {
					line("  The agent is working. /stop first, then /pin.");
					return true;
				}
				const result = await contextAction(CONTEXT_ACTION.pinTop, { reason: `${USER_NAME} asked for it` });
				if (!result.ok) line(`! ${result.error.message}`);
				else if (result.data.changed) line(`${bold("●")} top of the context rewritten: the assessment and the graph as they are now ${dim("(the next answer reads the whole context again)")}`);
				else line("  The copy at the top of the context is already current.");
				return true;
			}
			case "thinking": {
				if (argument !== undefined && argument !== "on" && argument !== "off") line("  /thinking switches it, /thinking on shows what the agent thinks and notes for itself, /thinking off hides it.");
				else showThinking(argument === undefined ? !thinking : argument === "on");
				return true;
			}
			case "approve": {
				// `/approve p7` expands only to p7's waiting child moves now. `/approve` snapshots every
				// waiting move at this moment; adding another move later never inherits this decision.
				if (args.length > 0) {
					const result = await requestAction(REQUEST_ACTION.approve, { ids: args });
					if (!result.ok) {
						line(`! ${result.error.message}`);
						return true;
					}
					const names = result.data.approved;
					if (names.length === 0) line(`  None of ${args.join(", ")} names a move revision that waits. /requests lists them.`);
					else {
						line(`${bold("●")} moves  approved ${names.join(", ")}`);
						await send(`I approved the current revisions of ${names.join(", ")}. Only those declared moves may now run; later moves still need their own approval.`);
					}
					for (const id of result.data.unknown) line(dim(`  ${id} is not a move or envelope snapshot that waits. /requests lists them.`));
					return true;
				}
				const projection = await queries.plan();
				if (!projection.ok) line(`! ${projection.error.message}`);
				else {
					const pending = waitingItems(projection.data.plan);
					const result = await requestAction(REQUEST_ACTION.approve, { ids: [] });
					if (!result.ok) line(`! ${result.error.message}`);
					else if (pending.length === 0) {
						line("  The plan has no declared change move waiting for approval. /plan shows envelopes and moves. The agent is told.");
						await send(NOTHING_TO_APPROVE);
					} else if (result.data.approved.length === 0) {
						line("  No declared change move was still waiting for approval. /plan shows envelopes and moves.");
					} else {
						const names = result.data.approved;
						line(`${bold("●")} moves  approved by you: ${plural(names.length, "change move")} may run${options.runner?.mode === "direct" ? " · the sandbox is OFF: their commands run directly on this machine" : ""}`);
						for (const move of pending) line(dim(`  ${move.id} ${move.action ?? move.text}${move.capabilities?.network === true ? "  · its commands reach the network" : ""}`));
						await send(`I approve the current declared move revisions: ${names.join(", ")}. Carry out only one move per focus and review each report before accepting it.`);
					}
				}
				return true;
			}
			case "deny": {
				if (argument === undefined) {
					line("  /deny ID [why] turns down one request. /requests lists the ids.");
					return true;
				}
				const result = await requestAction(REQUEST_ACTION.deny, { id: argument, reason: tail });
				if (!result.ok) line(result.error.kind === "not-found" ? `  ${argument} is not a request that waits. /requests lists them.` : `! ${result.error.message}`);
				else {
					const turned = result.data.request;
					line(`${bold("●")} requests  ${argument} turned down${tail === "" ? "" : `: ${tail}`}`);
					await send(`I turned down ${argument}: ${turned.text}. Do not carry it out${tail === "" ? "" : `; my reason was: ${tail}`}. Go on with whatever does not depend on it.`);
				}
				return true;
			}
			case "answer": {
				if (argument === undefined || tail === "") {
					line("  /answer ID words answers a question of taste. /requests lists the ids.");
					return true;
				}
				const result = await requestAction(REQUEST_ACTION.answer, { id: argument, text: tail });
				if (!result.ok) line(result.error.kind === "not-found" ? `  ${argument} is not an open question. /requests lists them.` : `! ${result.error.message}`);
				else {
					const answered = result.data.request;
					line(`${bold("●")} requests  ${argument} answered: ${tail}`);
					await send(`My answer to ${argument} (${answered.text}) is: ${tail}. Use it and go on with whatever does not depend on it.`);
				}
				return true;
			}
			case "yolo": {
				const projection = await queries.plan();
				const plan = projection.ok ? projection.data.plan : undefined;
				const waiting = plan === undefined ? [] : waitingItems(plan);
				if (argument === undefined) {
					line(`  ${gate.yolo ? YOLO_LINE : "approval: on · declared change moves wait for /approve"}`);
					line(dim(`  /yolo ${gate.yolo ? "off asks for /approve again" : "on lets declared change moves run without /approve"}`));
				} else if (argument === "on") {
					if (gate.yolo) line("  Approval is already off.");
					else {
						gate.yolo = true;
						line(`${bold("●")} ${YOLO_LINE}`);
						line(dim("  Every change is still one declared move with its own targets, budget, checkpoint and report. The sandbox is a separate switch (/bwrap). Not remembered: the next start asks for approval again."));
						if (options.runner?.mode === "direct") line("! The sandbox is OFF as well: commands run directly on this machine, and nothing asks you first.");
						setPrompt();
						// The agent may be resting in front of a plan that waited for the user: tell it, as /approve does.
						if (!busy && plan !== undefined && awaitsApproval(plan)) await send(`I have switched approval off: declared change moves may run without /approve while it stays off. Carry out exactly one current move revision per focus${waiting.length === 1 ? ` (${waiting[0].id})` : ""}; its targets, capabilities, budgets, checkpoints, report and acceptance still apply.`);
					}
				} else if (argument === "off") {
					if (!gate.yolo) line("  Approval is already on.");
					else {
						gate.yolo = false;
						line(`${bold("●")} approval: on · declared change moves wait for /approve again${busy ? " · a task that is running finishes" : ""}`);
						setPrompt();
						reminded = undefined;
						if (!busy) await approvalLine();
					}
				} else line("  /yolo shows the setting, /yolo on switches approval off, /yolo off switches it back on.");
				return true;
			}
			case "initiate": {
				if (argument === undefined) {
					line(initiation.on ? "  the agent starts on its own when carto starts, and after a wake with nothing owed" : "  the agent waits for you; it does nothing until you write");
					line(dim(`  /initiate ${initiation.on ? "off keeps it waiting" : "on lets it start on its own"} · the settings hold the default (\`initiate\`), a switch while running is never remembered`));
					return true;
				}
				if (argument !== "on" && argument !== "off") {
					line("  /initiate shows the setting, /initiate on lets the agent start on its own, /initiate off makes it wait for you.");
					return true;
				}
				const to = argument === "on";
				if (to === initiation.on) {
					line(to ? "  The agent already starts on its own." : "  The agent already waits for you.");
					return true;
				}
				initiation.on = to;
				setPrompt();
				line(`${bold("●")} ${to ? "the agent starts on its own again" : "the agent waits for you: it does nothing until you write"}`);
				line(dim("  Not remembered: the next start follows the setting (\`initiate\` in the settings)."));
				// Switched on while it rests: its start is now.
				if (to && !busy && !paused && options.interactive) {
					enqueue(async () => {
						if (busy || closing) return;
						line(dim("  it starts now"));
						await submit(startNote());
					});
				}
				return true;
			}
			case "wakes": {
				if (wakes === undefined) return true;
				const [, , id] = text.slice(1).trim().split(/\s+/);
				if (argument === "remove") {
					const outcome = await acknowledgedRuntimeAction(RUNTIME_ACTION.removeWake, id ?? "", { id: id ?? "" });
					if (!outcome.ok) {
						line(outcome.error.kind === "not-found" || outcome.error.kind === "validation" ? `  ${outcome.error.message}` : `! ${outcome.error.message}`);
						return true;
					}
					for (const gone of outcome.data.removed) line(`${bold("●")} wake  - ${gone.id} ${wakeAbout(gone)} · removed by you`);
					return true;
				}
				if (argument !== undefined) {
					line("  /wakes lists them; /wakes remove ID takes one away, /wakes remove all every one.");
					return true;
				}
				const projection = await queries.runtime.wakes();
				if (!projection.ok) {
					line(`! ${projection.error.message}`);
					return true;
				}
				const lines = projection.data.lines;
				if (lines.length === 0) line("  The agent has set no wake.");
				else for (const text of lines) line(`  ${text}`);
				const held = heldFor();
				if (held !== undefined) line(dim(`  woken ${WAKE_BURST} times in quick succession: the next wake is held for ${took(held)}`));
				line(dim(`  ${wakesPath(options.brainDir)} · /wakes remove ID takes one away`));
				return true;
			}
			case "diff": {
				try {
					await recordWindows();
					const projection = await queries.review.last();
					if (!projection.ok) {
						line(`! ${projection.error.message}`);
						return true;
					}
					const last = projection.data.last;
					if (last === undefined) {
						line("  No change task has run that is still in effect.");
						return true;
					}
					line(`  ${last.item ?? (last.windows ? `window ${last.windows.join(", ")}` : "change task")} · ${last.text}${last.finished ? "" : " · cut off before it finished; compared with the files as they are now"}`);
					if (last.changes.length === 0) line("  It changed no file.");
					for (const text of changeRecord(last.changes)) line(text);
					const patch = last.patch.split("\n").filter((row) => !/^(diff --git|index |new file mode|deleted file mode)/.test(row));
					const rows = argument === "all" ? patch : patch.slice(0, DIFF_LINES);
					for (const row of rows) {
						if (!fancy) line(row);
						else if (row.startsWith("+") && !row.startsWith("+++")) line(`\x1b[32m${row}\x1b[0m`);
						else if (row.startsWith("-") && !row.startsWith("---")) line(`\x1b[31m${row}\x1b[0m`);
						else line(dim(row));
					}
					if (rows.length < patch.length) line(dim(`  ${patch.length - rows.length} more lines; /diff all shows everything`));
				} catch (error) {
					line(`! ${error?.message ?? error}`);
				}
				return true;
			}
			case "undo": {
				if (busy) {
					line("  The agent is working. /stop first, then /undo.");
					return true;
				}
				try {
					await recordWindows();
					const outcome = await acknowledgedReviewAction(REVIEW_ACTION.undo);
					if (!outcome.ok) {
						line(`! ${outcome.error.message}`);
						return true;
					}
					const result = outcome.data.undone;
					if (result === undefined) {
						line(`  ${outcome.data.line}`);
						return true;
					}
					line(`${bold("●")} undone  ${result.item ?? (result.windows ? `window ${result.windows.join(", ")}` : "change task")} · ${result.text}`);
					if (result.changes.length === 0) line(dim("  The files were already as they were before it."));
					for (const text of changeRecord(result.changes)) line(dim(text));
					// A checkpoint belongs to one move. Undoing it makes that exact move a new, unapproved
					// revision; later accepted siblings are blocked for deliberate review.
					if (outcome.data.plan?.state === "unavailable" || outcome.data.plan?.state === "failed") line(`! ${outcome.data.plan.message}`);
					else if (outcome.data.plan?.state === "updated") line(dim(`  ${outcome.data.plan.line} ${gate.yolo ? "Approval is off, but the new revision still has to stay within its move contract." : "Its new revision needs /approve before another focus can run it."}`));
					if (result.windows !== undefined) line(dim("  The plan is as it was, and the window may still be running: /shells shows it. Tell the agent what you took back."));
					line(dim("  /undo again takes back the change task before this one."));
				} catch (error) {
					line(`! ${error?.message ?? error}`);
				}
				return true;
			}
			case "bwrap": {
				const runner = options.runner;
				const want = (argument ?? "").toLowerCase();
				if (runner === undefined) return true;
				if (want === "") {
					line(`  ${sandboxLine(runner)}`);
					line(dim(runner.mode === "direct" ? "  /bwrap on puts the commands back into the sandbox." : "  /bwrap off lets the commands run directly on this machine, outside the project too."));
					return true;
				}
				if (want !== "on" && want !== "off") {
					line("  /bwrap shows how commands run; /bwrap off and /bwrap on switch.");
					return true;
				}
				// A task that is running was told how its commands run when it started.
				if (busy) {
					line("  The agent is working. /stop first, then /bwrap.");
					return true;
				}
				if (want === "off") {
					if (runner.off) line("  The sandbox is already off.");
					else {
						if (!(await closeForSwitch("off"))) return true;
						runner.off = true;
						line(`${bold("!")} sandbox OFF. The commands of change tasks now run directly on this machine, as you.`);
						line("  They can read, change and delete whatever you can, anywhere, and they reach the network.");
						line("  /undo covers the project folder only. A plan still needs /approve before anything runs.");
						const projection = await queries.plan();
						const open = projection.ok ? runnableMoves(projection.data.plan).length : 0;
						if (open > 0) line(`  The plan has ${plural(open, "approved move")} ready to run without the sandbox.`);
						line(dim("  This holds until /bwrap on, or until you leave: the next start is sandboxed again."));
					}
				} else if (!runner.off) line(runner.mode === "sandbox" ? "  The sandbox is already on." : `  ${sandboxLine(runner)}`);
				else {
					if (!(await closeForSwitch("on"))) return true;
					runner.off = false;
					line(runner.mode === "sandbox" ? `${bold("●")} ${sandboxLine(runner)}` : `  ${sandboxLine(runner)}`);
				}
				setPrompt();
				return true;
			}
			case "stop": {
				if (!busy) {
					line("  nothing runs: the agent rests (Ctrl-X does the same when something does)");
					return true;
				}
				streamFreeze.abandon();
				await main.abort(context);
				line(dim("  stopped"));
				await runningLine();
				return true;
			}
			case "pause": {
				// Pausing holds the agent mid-sentence: the gate keeps the model's reply unread — nothing is committed —
				// and if nothing else is written, lifting the pause lets the very same stream go on. When the agent is
				// mid-round of tool calls there is no stream to hold, so the pause cuts it at once (as /stop does). A line or
				// a command written while paused abandons the held stream for good: the agent is interrupted at once and
				// what was written is the next thing it sees. Until the pause is lifted it starts nothing of its own:
				// no wake of its own, no auto-collapse.
				const to = argument === "on" ? true : argument === "off" ? false : !paused;
				if (to === paused) {
					line(to ? "  already paused. /pause or Ctrl-V lets it go on." : "  nothing is paused.");
					return true;
				}
				paused = to;
				setPrompt();
				if (paused) {
					if (streamFreeze.freeze()) {
						line(`${bold("●")} paused: the agent is held in its stream, mid-sentence · /pause or Ctrl-V lets it continue · a line or command you write ends it`);
					} else {
						streamFreeze.abandon();
						if (busy) await main.abort(context);
						line(busy
							? `${bold("●")} paused: the agent is interrupted where it stands · your lines still reach it · /pause or Ctrl-V lets it go on`
							: `${bold("●")} paused: the agent starts nothing of its own · your lines still reach it · /pause or Ctrl-V lets it go on`);
					}
					return true;
				}
				const resumed = streamFreeze.resume();
				line(resumed
					? `${bold("●")} on again — the agent goes on with its stream`
					: `${bold("●")} on again, and what happened while it was paused is told`);
				await wake();
				return true;
			}
			case "shells": {
				const projection = await queries.runtime.shells();
				if (!projection.ok) {
					line(`! ${projection.error.message}`);
					return true;
				}
				const all = projection.data.windows;
				if (all.length === 0) line("  No shell window is open. A change task opens one when it runs a command.");
				else {
					for (const text of windowLines(all, { busy: POLICY.limits.terminal.shellBusyTail, free: POLICY.limits.terminal.shellFreeTail })) line(text.replace(/ `window` close clears this line\.$/, " The agent is told."));
					line(dim("  /kill NAME closes a window and ends what runs in it; /kill all closes every one."));
				}
				return true;
			}
			case "kill": {
				// Only windows that are open. A line about one that is gone is the agent's to read and clear.
				const projection = await queries.runtime.shells();
				if (!projection.ok) {
					line(`! ${projection.error.message}`);
					return true;
				}
				const all = projection.data.windows.filter((win) => win.state !== POLICY.enums.windowStates.gone);
				if (argument === undefined || argument === "") {
					line(all.length === 0 ? "  No shell window is open." : `  /kill NAME closes one window, /kill all every one. Open: ${all.map((win) => win.name).join(", ")}.`);
					return true;
				}
				const chosen = argument === "all" && !all.some((win) => win.name === "all") ? all : all.filter((win) => win.name === argument);
				if (chosen.length === 0) {
					line(argument === "all" || all.length === 0 ? "  No shell window is open." : `  There is no window ${JSON.stringify(argument)}. Open: ${all.map((win) => win.name).join(", ")}.`);
					return true;
				}
				let closed = false;
				for (const win of chosen) {
					const outcome = await acknowledgedRuntimeAction(RUNTIME_ACTION.closeShell, win.name, { name: win.name, reason: KILLED });
					if (!outcome.ok) {
						line(`! ${outcome.error.message}`);
						continue;
					}
					closed = true;
					const command = outcome.data.closed.running;
					line(`${bold("●")} closed window ${win.name}${command === undefined ? "" : `, and \`${oneLine(command, POLICY.limits.terminal.resultSummary.windowCommand)}\` ended with it`}`);
				}
				if (closed && !busy) line(dim("  The agent sees this the next time it works. Tell it why, if it matters."));
				return true;
			}
			case "wait": {
				// For piped input, where carto leaves after the last line: wait for the windows' commands to end and for
				// the wakes the agent has set, at most this many seconds, and let the agent react to each.
				if (options.interactive) {
					line("  /wait is for piped input. Here the agent is woken by itself when a window's command ends or a wake fires.");
					return true;
				}
				const until = Date.now() + (Number.isFinite(Number(argument)) && Number(argument) > 0 ? Number(argument) : POLICY.timing.terminal.waitDefaultSeconds) * 1000;
				for (;;) {
					await woken();
					const pending = (windows?.list(0) ?? []).some((win) => win.state === POLICY.enums.windowStates.busy) || (wakes?.list().length ?? 0) > 0 || heldFor() !== undefined;
					if (!pending || Date.now() >= until) break;
					await new Promise((resolve) => setTimeout(resolve, POLICY.timing.terminal.inputPollMs));
				}
				return true;
			}
			case "new":
				if (busy) {
					line("  The agent is working. /stop first, then /new.");
					return true;
				}
				stopReadAhead();
				engine?.forget();
				await main.reset(undefined, context);
				// Nothing is carried over: not the talk, not the record of tasks, not the shelf. Reports stay on disk.
				const cleared = await contextAction(CONTEXT_ACTION.clearKept);
				if (!cleared.ok) line(`! ${cleared.error.message}`);
				// Everything is read again anyway: the moment to bring the top of the context up to date.
				const refreshed = await contextAction(CONTEXT_ACTION.pinTop, { reason: "a fresh context" });
				if (!refreshed.ok) line(`! ${refreshed.error.message}`);
				line(dim("  fresh context; earlier messages are no longer in view, and nothing was kept of them (/collapse keeps the talk, the task records and the shelf)"));
				return true;
			case "status": {
				const projection = await queries.runtime.status();
				if (!projection.ok) {
					line(`! ${projection.error.message}`);
					return true;
				}
				const snapshot = projection.data;
				const last = snapshot.messages.filter((message) => message.role === "assistant").at(-1);
				const size = last?.usage ? (last.usage.input ?? 0) + (last.usage.cacheRead ?? 0) + (last.usage.output ?? 0) : 0;
				line(`  ${withoutQuietWakes(snapshot.messages).length} messages in view · context ${count(size)} of ${count(options.contextWindow)} tokens · model ${snapshot.modelId ?? config.model} · ${busy ? "working" : "idle"}`);
				if (options.runner !== undefined) line(`  ${sandboxLine(options.runner)}`);
				const all = snapshot.windows.filter((win) => win.state !== POLICY.enums.windowStates.gone);
				if (all.length > 0) line(`  ${plural(all.length, "shell window")} open, ${all.filter((win) => win.state === POLICY.enums.windowStates.busy).length} busy · /shells shows them`);
				if (gate.yolo) line(`  ${YOLO_LINE}`);
				line(initiation.on ? dim("  the agent starts on its own (/initiate off keeps it waiting)") : dim("  the agent waits for you (/initiate on lets it start on its own)"));
				if (snapshot.wakes.length > 0) line(`  ${plural(snapshot.wakes.length, "wake")} set${snapshot.nextWakeDue === undefined ? "" : `, the next in ${took(snapshot.nextWakeDue)}`} · /wakes shows them`);
				return true;
			}
			case "model": {
				// Model discovery belongs to the deferred Runtime facade. An offline server leaves already-known routes
				// visible and reports its typed issue without reaching session transport helpers from this adapter.
				const projection = await queries.runtime.models();
				if (!projection.ok) {
					line(`! ${projection.error.message}`);
					return true;
				}
				const snapshot = projection.data;
				if (snapshot.issue !== undefined) showModelError(snapshot.issue);
				applyModelLimits(snapshot.limits);
				const entries = snapshot.models;
				const served = entries.map((entry) => entry.id);
				const current = snapshot.currentId ?? config.model;
				if (argument === undefined) {
					line(`  ${bold("Models")}  on ${current}  ·  the server serves:`);
					entries.forEach((entry, index) => {
						line(`    ${index + 1}  ${entry.id}${entry.id === current ? "  ← on" : ""}${entry.contextWindow === undefined ? "" : dim(`  · server capacity ${count(entry.contextWindow)} tokens`)}`);
					});
					line(dim("  /model NAME, or /model 3 with a number from this list, switches to it. A task forked after runs on it too; Cartographer uses each reported capacity as its full context limit."));
					return true;
				}
				const byNumber = /^\d+$/.test(argument) ? served[Number(argument) - 1] : undefined;
				const wanted = byNumber ?? served.find((id) => id === argument);
				if (wanted === undefined) {
					line(`  The server has no model "${argument}". It serves: ${served.join(", ")}. /model lists them.`);
					return true;
				}
				if (wanted === current) {
					line(`  Already on ${wanted}.`);
					return true;
				}
				const reported = entries.find((entry) => entry.id === wanted)?.contextWindow;
				// The application action owns the required native-grammar gate so every programmatic and terminal switch shares it.
				const selected = await runtimeAction(RUNTIME_ACTION.selectModel, { modelId: wanted, ...(reported === undefined ? {} : { contextWindow: reported }) });
				if (!selected.ok) {
					line(`  ${wanted} was not selected: ${selected.error.message}`);
					return true;
				}
				const effective = selected.data.limits;
				modelRouteReady = true;
				const was = options.contextWindow;
				options.contextWindow = effective.usableContextWindow;
				const contextMessage = effective.serverContextWindow !== undefined
					? ` · context ${count(effective.usableContextWindow)} tokens (server capacity ${count(effective.serverContextWindow)}; settings cap ${count(effective.configuredContextWindow)})`
					: effective.usableContextWindow !== was ? ` · context ${count(effective.usableContextWindow)} tokens (was ${count(was)})` : ` · context ${count(effective.usableContextWindow)} tokens`;
				line(`${bold("●")} model  ${current} → ${wanted}${contextMessage}${busy ? " · the answer being written finishes on the old one" : ""}`);
				if (Number.isInteger(config.chatWindow) && config.chatWindow > effective.usableContextWindow / POLICY.validation.chatWindowDivisor)
					line(dim(`  Warning: chatWindow is ${count(config.chatWindow)} tokens, more than half of ${count(effective.usableContextWindow)}. It stays as set; chatWindow in the settings is the setting to lower.`));
				return true;
			}
			case "fold": {
				const ids = (argument ?? "").split(/[\s,]+/).filter((id) => id !== "");
				if (ids.length === 0) {
					line("  /fold ID takes a report out of view, leaving its one line: the same `fold` the agent does with `context`. /context lists what is in view.");
					return true;
				}
				line(`  ${await workspaceLines(WORKSPACE_ACTION.fold, ids)}`);
				return true;
			}
			case "recall": {
				const ids = (argument ?? "").split(/[\s,]+/).filter((id) => id !== "");
				if (ids.length === 0) {
					line("  /recall ID brings a kept report back in full, into view. /context lists the kept ones.");
					return true;
				}
				line(`  ${await workspaceLines(WORKSPACE_ACTION.recall, ids)}`);
				return true;
			}
			case "shelve":
			case "unshelve": {
				if (argument === undefined) {
					line(`  /${name} PATH [lines] ${name === "shelve" ? "saves a full backing snapshot and carries selected content through collapse" : "takes a shelf item off by path or stable ID (all takes every one)"}.`);
					return true;
				}
				if (name === "unshelve") line(`  ${await workspaceLine(WORKSPACE_ACTION.unshelve, { id: argument })}`);
				else line(`  ${await workspaceLine(WORKSPACE_ACTION.shelve, { path: argument, lines: tail })}`);
				return true;
			}
			case "archive":
			case "unarchive": {
				const ids = args;
				if (ids.length === 0) {
					line(`  /${name} ID … ${name === "archive" ? "takes a row out of what the agent reads, keeping it on disk: a report's record line (t1), a ledger entry, a plan envelope or move, a node of the graph" : "brings an archived row back into what the agent reads"}.`);
					return true;
				}
				line(`  ${await workspaceLines(name === "archive" ? WORKSPACE_ACTION.archive : WORKSPACE_ACTION.unarchive, ids)}`);
				return true;
			}
			case "done": {
				if (argument === undefined || args.length === 0) {
					line("  /done ID … settles rows. To accept a reported move, write /done mN -- REVIEW, saying how its reported proof witnesses its done-when.");
					return true;
				}
				const reviewAt = parts.indexOf("--");
				if (reviewAt >= 0) {
					if (reviewAt !== 1 || parts.length < 3) {
						line("  /done mN -- REVIEW accepts one reported move. Put the exact evidence review after --.");
						return true;
					}
					line(`  ${await workspaceLine(WORKSPACE_ACTION.settle, { id: argument, review: parts.slice(2).join(" ") })}`);
					return true;
				}
				line(`  ${await workspaceLines(WORKSPACE_ACTION.settle, args)}`);
				return true;
			}
			case "delete": {
				const ids = args.filter((id) => id !== "--yes");
				if (ids.length === 0) {
					line("  /delete ID … --yes removes a row for good, and nothing of it is said to the agent (it forgets it): a report (t1), a ledger entry, a plan envelope or move, a node of the graph. /archive hides a row and keeps it.");
					return true;
				}
				if (!args.includes("--yes")) {
					line(`  /delete is permanent. To remove ${ids.join(", ")}, run: /delete ${ids.join(" ")} --yes`);
					return true;
				}
				line(`  ${await workspaceLines(WORKSPACE_ACTION.delete, ids, (id) => ({ confirmation: { actionId: WORKSPACE_ACTION.delete, target: id, acknowledged: true } }))}`);
				return true;
			}
			case "send": {
				if (argument === undefined || tail === "") {
					line("  /send NAME line types a line into a shell window, as you. /shells lists the windows.");
					return true;
				}
				const outcome = await runtimeAction(RUNTIME_ACTION.sendShell, { name: argument, line: tail });
				if (!outcome.ok) line(`! ${outcome.error.message}`);
				else line(dim(`  typed into ${argument}: ${tail}`));
				return true;
			}
			case "quit":
			case "exit":
				return false;
			default:
				line(`  Unknown command /${name}. /help lists them.`);
				return true;
		}
	};

	/** A window keeps the way it was opened, so a switch of the sandbox closes every one. */
	async function closeForSwitch(to) {
		const projection = await queries.runtime.shells();
		if (!projection.ok) {
			line(`! ${projection.error.message}`);
			return false;
		}
		const were = projection.data.windows.filter((win) => win.state !== POLICY.enums.windowStates.gone);
		if (were.length === 0) return true;
		await recordWindows();
		const outcome = await acknowledgedRuntimeAction(RUNTIME_ACTION.closeAllShells, "all", {
			reason: `${USER_NAME} switched the sandbox ${to}, which closes every window`,
		});
		if (!outcome.ok) {
			line(`! ${outcome.error.message}`);
			return false;
		}
		line(`${bold("●")} closed ${were.length === 1 ? "window" : "windows"} ${were.map((win) => win.name).join(", ")}${were.some((win) => win.state === POLICY.enums.windowStates.busy) ? ", and what ran there ended" : ""}: a window keeps the way it was opened`);
		return true;
	}

	/** Which windows are still at work, said after the agent was stopped. */
	async function runningLine() {
		const projection = await queries.runtime.shells();
		if (!projection.ok) return void line(`! ${projection.error.message}`);
		const running = projection.data.windows.filter((win) => win.state === POLICY.enums.windowStates.busy);
		if (running.length > 0) line(dim(`  still running: ${running.map((win) => `window ${win.name}`).join(", ")} · /shells shows them, /kill NAME ends one, /kill all every one`));
	}

	/** One line on the atlas and the assessment. */
	const atlasLine = async () => {
		const atlasProjection = await queries.atlas();
		if (!atlasProjection.ok) {
			const detail = atlasProjection.error.detail ?? atlasProjection.error.message;
			return line(`! The atlas cannot be read: ${detail}. Repair the file; until then the agent cannot use its graph.`);
		}
		const assessmentProjection = await queries.assessment();
		const { atlas, attention: snapshot } = atlasProjection.data;
		const assessment = assessmentProjection.ok ? assessmentProjection.data.assessment : { text: "" };
		const attention = attentionSummary(snapshot);
		line(dim(`atlas: ${atlasSummary(atlas)}${attention === "" ? "" : ` · ${attention}`} · ${assessment.text === "" ? "no assessment yet" : `assessment written ${ago(Date.now() - (assessment.written ?? Date.now()))}`}${atlas.nodes.length > 0 || assessment.text !== "" ? " · /atlas and /assessment show them" : ""}`));
	};

	// ─── Start ──────────────────────────────────────────────────────────────
	await ledgerLine();
	await planLine();
	await atlasLine();
	const shellSnapshot = await queries.runtime.shells();
	if (!shellSnapshot.ok) line(`! ${shellSnapshot.error.message}`);
	else {
		const lost = shellSnapshot.data.windows.filter((win) => win.state === POLICY.enums.windowStates.gone);
		if (lost.length > 0) line(dim(`windows: ${lost.map((win) => win.name).join(", ")} ended with the last session${lost.some((win) => win.command) ? ", with what ran there" : ""} · the agent is told`));
	}
	await follow(main.id, 0);
	// A restarted outer tool normally names its child in a live slot, but a settled/recovered watch can arrive
	// without that transient slot. Follow any still-running co<N> child directly from the minimal routing projection
	// so Consult continues to show its live participant stream without loading audit material into Work lifecycle code.
	await refreshConsultRouting();
	for (const route of conferenceRoutes.values()) {
		const child = route.status === "running" ? route.childConversationId : undefined;
		if (typeof child !== "string" || child === "" || attached.has(child)) continue;
		attached.add(child);
		await follow(child, 1);
	}
	harness.resume();
	if (busy) {
		// The work that was going on when carto last went away goes on. The screen and the prompt must come up
		// while it does, so that the user can talk into it and leave it; only piped input waits here, for its
		// first line is part of the same queue. settle() waits for the queue, so it must not run inside it.
		const finishing = async () => {
			await settle();
			usageLine();
			await approvalLine();
		};
		if (options.oneShot !== undefined || !options.interactive) await finishing();
		else finishing().catch((error) => line(`! display error: ${error?.message ?? error}`));
	}

	// After this nothing more is printed. A watch waits for its running listener when stopped, and a listener waits
	// for the queue, so this must not be awaited from inside the queue.
	const stop = async () => {
		stopped = true;
		stopReadAhead();
		clearTimeout(awayTimer);
		clearTimeout(retry);
		wakes?.shutdown();
		await Promise.all(watches.map((watch) => watch.stop().catch(() => {})));
	};

	// One message, or piped input: send each line, wait for the answer, leave.
	if (options.oneShot !== undefined || !options.interactive) {
		const lines = [];
		if (options.oneShot !== undefined) lines.push(options.oneShot);
		else {
			const reader = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
			for await (const text of reader) if (text.trim() !== "") lines.push(text);
		}
		piped.push(...lines);
		while (piped.length > 0) {
			const text = piped.shift();
			if (text.startsWith("/")) {
				if (!(await command(text))) break;
				continue;
			}
			line(`› ${text}`);
			userSpoke();
			const submission = await submit(text);
			if (submission === undefined) {
				failed = true;
				break;
			}
			await waitFor(submission);
			await settle();
			usageLine();
			await approvalLine();
			await woken();
			// The agent rests until the next line: the moment to collapse its context when that is due.
			await rest({ final: piped.length === 0 });
		}
		await recordWindows();
		await stop();
		return failed ? 1 : 0;
	}

	// Interactive.
	// readline draws its prompt again whenever the terminal is resized, also in the middle of the agent's work,
	// where it lands between the lines of a task. While the agent works, it is not drawn.
	const resizeBefore = new Set(out.listeners?.("resize") ?? []);
	const reader = ui !== undefined ? ui.reader : createInterface({ input: options.input, output: out, prompt: "› " });
	ui?.attach({
		busy: () => busy,
		paused: () => paused,
		thinking: () => thinking,
		lastReport: () => lastReport,
	});
	for (const listener of out.listeners?.("resize") ?? []) {
		if (resizeBefore.has(listener)) continue;
		out.off("resize", listener);
		out.on("resize", (...args) => {
			if (!busy || asks?.pending() !== undefined) listener(...args);
		});
	}
	// The prompt says what is switched off, so that it cannot be forgotten.
	setPrompt = () => {
		const marks = [gate.yolo ? "yolo" : "", paused ? "paused" : "", options.runner?.mode === "direct" ? "no sandbox" : "", initiation.on ? "" : "waits"].filter((mark) => mark !== "");
		reader.setPrompt(marks.length > 0 ? `[${marks.join(", ")}] › ` : "› ");
	};
	setPrompt();
	askPrompt = () => {
		if (!closing) reader.prompt(true);
	};
	onIdle = () => {
		enqueue(async () => {
			for (const print of [...afterResult.splice(0), ...afterReply.splice(0)]) print();
			endLine();
			usageLine();
			await approvalLine();
			// Something may have happened in a window while the agent was finishing.
			if (closing || (await wake()) !== undefined) return;
			// The agent rests: the moment to collapse its context when that is due.
			await rest();
			if (busy) return;
			reader.prompt();
			armAway();
		});
	};
	reprompt = () => {
		if (!busy && !closing) reader.prompt(true);
	};
	/** After the user has been away for a while, the context is collapsed whatever its size. */
	const armAway = () => {
		clearTimeout(awayTimer);
		if (!(config.collapseMinutes > 0)) return;
		awayTimer = setTimeout(() => {
			enqueue(async () => {
				if (busy || closing) return;
				out.write("\r\x1b[K");
				await rest({ away: true });
				if (!busy) reader.prompt(true);
			});
		}, config.collapseMinutes * 60_000);
		awayTimer.unref();
	};
	// A command ended, or a program asks for input, and no call was waiting for it.
	const unlistenWindows = windows?.on(() => {
		enqueue(async () => {
			if (!busy && !closing) await wake();
		});
	});
	// A wake the agent set has fired while it rests: it gets a turn.
	const unlistenWakes = wakes?.on(() => {
		enqueue(async () => {
			if (!busy && !closing) await wake();
		});
	});
	const unlisten = () => {
		unlistenWindows?.();
		unlistenWakes?.();
	};
	onRetry = () => {
		enqueue(async () => {
			if (!busy && !closing) await wake();
		});
	};
	return await new Promise((resolve) => {
		const leave = async () => {
			if (closing) return;
			closing = true;
			reader.close();
			unlisten?.();
			if (busy) line(dim("Leaving. Unfinished work continues the next time carto starts here."));
			else await recordWindows();
			const shellSnapshot = await queries.runtime.shells();
			if (!shellSnapshot.ok) line(`! ${shellSnapshot.error.message}`);
			else {
				const running = shellSnapshot.data.windows.filter((win) => win.state === POLICY.enums.windowStates.busy);
				if (running.length > 0) line(dim(`Leaving. ${running.length === 1 ? `Window ${running[0].name} ends` : `Windows ${running.map((win) => win.name).join(", ")} end`} now, with what runs there.`));
			}
			await stop();
			resolve(0);
		};
		reader.on("line", (raw) => {
			const text = raw.trim();
			enqueue(async () => {
				if (text === "") {
					if (!busy) reader.prompt();
					return;
				}
				if (text.startsWith("/")) {
					if (!(await command(text))) return void leave();
					if (!busy) reader.prompt();
					return;
				}
				// The agent waits on a question: this line is the answer.
				if (asks?.pending() !== undefined) {
					asks.answer(text);
					return;
				}
				// Their words carry an exact current move approval; a bare yes never sweeps a batch. The query resolves
				// the current target IDs, while the request action—not this terminal handler—makes the durable decision.
				if (gate.yolo !== true && isApprovalWords(text)) {
					const projection = await queries.plan();
					if (projection.ok) {
						const targets = approvalWordTargets(projection.data.plan, text);
						if (targets !== undefined) {
							const approval = await requestAction(REQUEST_ACTION.approve, { ids: targets });
							if (!approval.ok) line(`! ${approval.error.message}`);
							else if (approval.data.approved.length > 0) {
								// A named target may deliberately include a network move. Unnamed words never do, so the
								// pre-action projection truthfully names the network work that still waits.
								const named = /[pm]\d+/i.test(text);
								const held = named ? [] : waitingItems(projection.data.plan).filter((move) => move.capabilities?.network === true).map((move) => move.id);
								line(`${bold("●")} approved from your words: ${approval.data.approved.join(", ")}${held.length > 0 ? ` · still waiting for you: ${held.join(", ")} (network)` : ""}`);
							}
						}
					}
				}
				const wasBusy = busy;
				userSpoke();
				// A private task owns its input while it runs and receives this line with its next result. The action records
				// that durable steering after leaving the input handler; a task that completed in the meantime falls through
				// to the ordinary main-agent interruption below.
				const routeAvailable = application.capabilities.availability(RUNTIME_ACTION.routeTaskMessage)?.enabled === true;
				const routed = wasBusy && routeAvailable ? await runtimeAction(RUNTIME_ACTION.routeTaskMessage, { text }) : undefined;
				if (routed !== undefined && !routed.ok) {
					line(`! ${routed.error.message}`);
					return;
				}
				if (routed?.data.routed === true) {
					windows?.nudge();
					line(dim("  (sent to the running task: it reads it at its next step, and the main agent is told with the report)"));
					return;
				}
				if (wasBusy) {
					// A new message interrupts at once: whatever the agent is doing — even a stream held by the pause — stops here,
					// and this line is the next thing.
					streamFreeze.abandon();
					await main.abort(context);
				}
				// A call that only waits for a window returns, so that the agent reads this sooner.
				if (wasBusy) windows?.nudge();
				const submission = await submit(text);
				if (submission === undefined) {
					busy = wasBusy;
					if (!busy) reader.prompt();
				}
			});
		});
		// Bash-like: Ctrl-C clears what is typed on the line. With the line already clear, Ctrl-C twice in a row
		// leaves the way /quit does; Ctrl-X stops the agent instead, and Ctrl-V holds the agent in its stream (Ctrl-V again lets it continue).
		let armedQuit = 0;
		reader.on("SIGINT", () => {
			const typed = typeof reader.line === "string" ? reader.line : "";
			if (typed !== "") {
				reader.line = "";
				reader.cursor = 0;
				out.write("\r\x1b[K");
				if (!busy) reader.prompt(true);
				return;
			}
			const now = Date.now();
			if (now - armedQuit < POLICY.timing.terminal.quitConfirmMs) return void leave();
			armedQuit = now;
			line(dim(busy ? "  Ctrl-C again to leave; Ctrl-X stops the agent" : "  Ctrl-C again to leave"));
		});
		reader.on("close", () => void leave());
		// Ctrl-T: show or hide the agent's own text. readline has no use for the key; nor for Ctrl-X and Ctrl-V.
		(ui !== undefined ? ui.keys : options.input).on("keypress", (_text, key) => {
			if (key?.ctrl !== true || closing) return;
			if (key.name === "x") return void enqueue(async () => command("/stop"));
			if (key.name === "v") return void enqueue(async () => command("/pause"));
			if (key.name !== "t") return;
			enqueue(async () => {
				// The prompt and what is typed on it are taken off the line, and put back after.
				if (!busy) out.write("\r\x1b[K");
				showThinking(!thinking);
				if (!busy) reader.prompt(true);
			});
		});
		line(dim(ui !== undefined ? "Type a message. /help lists commands, F1 the keys. Ctrl-C clears the line; again leaves. Ctrl-X stops the agent; Ctrl-V holds the agent in its stream, and Ctrl-V again lets it continue." : "Type a message. /help lists commands. Ctrl-C clears the line; again leaves. Ctrl-X stops the agent; Ctrl-V holds the agent in its stream, and Ctrl-V again lets it continue; Ctrl-T hides and shows its thinking."));
		// Check connectivity only after the terminal exists. This does not load a model; an unavailable server becomes a
		// recoverable on-screen status instead of preventing Cartographer from opening.
		if (application.capabilities.availability(RUNTIME_ACTION.ensureModel).enabled) {
			void queries.runtime.models().then((projection) => enqueue(async () => {
				if (stopped || closing) return;
				if (!projection.ok) return showModelError(projection.error);
				applyModelLimits(projection.data.limits);
				if (projection.data.issue !== undefined) showModelError(projection.data.issue);
			}));
		}
		// A context left large by the last session is collapsed before the first message has to carry it. Then,
		// unless the setting says otherwise, the agent gets its first turn without waiting to be addressed.
		enqueue(async () => {
			await rest();
			if (busy) return;
			if (initiation.on) {
				line(dim("the agent starts on its own · /initiate off keeps it waiting"));
				if (await submit(startNote()) !== undefined) return; // its turn; the idle handler prints and prompts
			}
			reader.prompt();
			armAway();
		});
	});
}
