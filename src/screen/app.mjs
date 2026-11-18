// The full screen: tabs, a status strip that is always there, and a place to type.
//
//   1 Chat     Conversation is user-directed exchange; Work is private shared-brain activity; Consult is its isolated conference audit (src/screen/chat.mjs)
//   2 Carto    the live shared brain: Atlas, Ledger, Plan, Requests, Tree, Current shared brain
//   3 Diff     what was changed: by the last step, in this session, or against the project's own git HEAD
//   4 Shells   the shell windows, live
//   5 Model    sent provider payloads, next-request preview, and current accounting
//
// Two modes, as in vi, and Esc goes from one to the other.
//   typing    every key is text for the agent, in pi-tui's editor: Enter sends, pasted text keeps its lines, Tab
//             completes a command or a path.
//   commands  every key is a command: digits go to a tab, j and k move over the items of the tab, Enter opens
//             and folds, e opens what is selected in the editor, y copies it.
// The tab does not decide the mode: you can type with the plan in view, and move through Chat with the keys.
//
// The screen is built on pi-tui, the terminal library pi itself uses. pi-tui owns the terminal: it reads keys in
// whatever way the terminal speaks (the Kitty keyboard protocol where there is one), lays the parts out, scrolls
// them, lets text be selected with the mouse and copies it, lays sheets over the screen, and writes only the rows
// that changed. What is Cartographer's own is in the other files of this folder: what the tabs hold (chat.mjs,
// list.mjs, views.mjs), how it is coloured (theme.mjs), and how the two are fitted to the screen (parts.mjs).
//
// And it is a face, not a second program. The session is run by the plain terminal (src/terminal.mjs), which is
// handed a `screen` to print to: it carries out the commands, wakes the agent, collapses its context and words
// everything Cartographer has to say, exactly as it does line by line.
import { DEFAULTS, POLICY } from "../config.mjs";
import { EventEmitter } from "node:events";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CombinedAutocompleteProvider, KeybindingsManager, Markdown, ProcessTerminal, ScrollView, setKeybindings, TUI_KEYBINDINGS, TuiAltScreen, visibleWidth, VStack } from "@earendil-works/pi-tui";
import { charsPerTokenNow } from "../calibrate.mjs";
import { createApplication } from "../application/app.mjs";
import { TALK_ACTION } from "../application/talk.mjs";
import { WORKSPACE_ACTION } from "../application/workspace.mjs";
import { launchEditor } from "../infrastructure/editor.mjs";
import { findExecutable, findTextSource, pathExists, readText, writeScratch } from "../infrastructure/filesystem.mjs";
import { stamp } from "../time.mjs";
import { createChat, homeOf } from "./chat.mjs";
import { createDeferredReferenceLabels } from "../application/references.mjs";
import { copyOut, selectionText, toClipboard } from "./copy.mjs";
import { createPasteWatch, isKeyRelease, isPaste, keyOf } from "./keys.mjs";
import { createList } from "./list.mjs";
import { createProjectionScheduler } from "./projections.mjs";
import { Air, AIRY_ROWS, Box, ChatBody, Farewell, ListBody, marginOf, Prompt, Sheet, Strip, TabBar, ViewBar } from "./parts.mjs";
import { applyTheme, bar, cut, sgr, short, span } from "./text.mjs";
import { colorMode, makeTheme, markdownTheme, schemeFromEnv } from "./theme.mjs";
import { accountingProjectionView, atlasView, contextView, diffView, editorCommand, handsView, ledgerView, planView, previewView, rawPayloadView, requestsView, shellsOutView, shellsView, treeView } from "./views.mjs";
import { USER_NAME } from "../user.mjs";

const TOOL_SOURCE_DIR = fileURLToPath(new URL("../tools", import.meta.url));
const PROMPT_SOURCE = fileURLToPath(new URL("../prompt.mjs", import.meta.url));
const promptSource = async () => (await pathExists(PROMPT_SOURCE) ? PROMPT_SOURCE : undefined);
const toolSource = (name) => findTextSource(TOOL_SOURCE_DIR, `name: "${name}"`, { suffix: ".mjs" });

export const TABS = [
	{ id: "chat", name: "Chat" },
	{ id: "carto", name: "Carto" },
	{ id: "diff", name: "Diff" },
	{ id: "shells", name: "Shells" },
	{ id: "context", name: "Model" },
];
/** The views inside a tab; [ and ] go from one to the next. */
export const VIEWS = {
	chat: [
		{ id: "conversation", name: "Conversation" },
		{ id: "work", name: "Work" },
		{ id: "consult", name: "Consult" },
	],
	carto: [
		{ id: "atlas", name: "Atlas" },
		{ id: "ledger", name: "Ledger" },
		{ id: "plan", name: "Plan" },
		{ id: "requests", name: "Requests" },
		{ id: "tree", name: "Tree" },
		{ id: "hands", name: "Current shared brain" },
	],
	diff: [
		{ id: "last", name: "Last step" },
		{ id: "session", name: "This session" },
		{ id: "git", name: "git HEAD" },
	],
	shells: [
		{ id: "list", name: "List" },
		{ id: "out", name: "Output" },
	],
	context: [
		{ id: "window", name: "Latest sent" },
		{ id: "main", name: "Main sent" },
		{ id: "raw", name: "Raw payload" },
		{ id: "preview", name: "Next preview" },
		{ id: "parts", name: "Current accounting" },
	],
};
/** Every list-backed view; Chat's Conversation, Work, and Consult share the chat projection instead. */
const PAGES = ["carto.atlas", "carto.ledger", "carto.plan", "carto.requests", "carto.tree", "carto.hands", "diff.last", "diff.session", "diff.git", "shells.list", "shells.out", "context.window", "context.main", "context.raw", "context.preview", "context.parts"];
/** How often a view is read again while it shows, in milliseconds. */
const EVERY = POLICY.timing.screenRefreshMs;
const QUESTION_ID = new RegExp(POLICY.patterns.questionId);
/** The marks of the spinner that turns while the agent works, and how long each stands. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPIN_MS = POLICY.timing.spinnerMs;

/** The commands that are typed and sent, for the list that opens when a line starts with a slash. */
const COMMANDS = [
	["requests", "what waits for you: change moves, questions of taste, "],
	["approve", "approve requests by id, or the whole plan as it stands"],
	["deny", "turn a request down: /deny ID [why]"],
	["answer", "answer a question of taste: /answer ID words"],
	["plan", "the plan, whether it is authorized, and where the file is"],
	["ledger", "goals, questions and notes, open and closed"],
	["atlas", "the tree, local attention map, and graph's nodes"],
	["focus", "set an explicit atlas focus: /focus NODE_OR_PATH reason"],
	["unfocus", "clear the explicit atlas focus; a running move stays a temporary overlay"],
	["assessment", "the agent's summary of the project"],
		["diff", "what the last change task did to the files", ["all"]],
	["undo", "take the last change task back; again for the one before it"],
	["report", "the last task's report in full; /report t12 shows a kept one"],
	["stop",  "stop what the agent is doing (Ctrl-X); shell windows keep running"],
	["pause", "hold the agent in its stream mid-reply (Ctrl-V); until you unpause it starts nothing of its own — a line or command you write ends the held stream"],
	["copy", "the agent's last message; or: session, report, tab", ["session", "report", "tab"]],
	["model", "the models the server serves; /model NAME (or a number) switches to one"],
	["context", "what the agent's context holds, and when it is next collapsed"],
	["fold", "take a kept report out of the context's view, leaving its one line"],
	["archive", "take a row out of what the agent reads: a report, ledger entry, plan envelope or move, or node"],
	["unarchive", "bring an archived row back into what the agent reads"],
	["done", "settle a row; a reported move opens an evidence-review prompt before it can be accepted"],
	["delete", "a row is gone for good, and the agent is not told: a report, ledger entry, plan envelope or move, or node"],
	["recall", "bring a kept report back into view in full"],
	["shelve", "snapshot a file into view now and carry it through collapse: /shelve PATH [lines]"],
	["unshelve", "take a shelved file off the shelf, or all of them"],
	["send", "type a line into a shell window: /send NAME line"],
	["collapse", "collapse the context now"],
	["new", "start a fresh context with nothing kept in view"],
	["pin", "rewrite the copy of assessment and graph at the top of the context"],
	["yolo", "let declared change moves run without /approve while you watch", ["on", "off"]],
	["initiate", "whether the agent starts working on its own when carto starts; default on", ["on", "off"]],
	["bwrap", "how tasks' commands run: with the sandbox or without", ["on", "off"]],
	["shells", "the shell windows: what runs in each, and its newest lines"],
	["kill", "close a shell window and end what runs in it", ["all"]],
	["wakes", "what the agent has set to wake itself", ["remove"]],
	["thinking", "show or hide what the agent thinks and notes for itself", ["on", "off"]],
	["status", "where the brain is and how full the context is"],
	["keys", "the keys of the full screen"],
	["help", "every command, with what it does"],
	["quit", "leave; unfinished work continues the next time carto starts here"],
];

// A heading stands at the start of its line; an entry is a key, at least two spaces, and what the key does. The
// sheet that shows this (src/screen/parts.mjs) breaks a long entry and keeps its second column.
export const KEYS_HELP = [
	"Two modes",
	"  Esc goes from one to the other. The strip at the bottom shows the keys the tab that shows takes; this sheet and F1 show all of them.",
	"",
	"Typing",
	"  Enter            send. Alt-Enter, Shift-Enter or Ctrl-J breaks the line; so does a backslash before Enter",
	"  Pasted text      keeps its lines and is not sent by itself; a long paste shows as [paste #1 +40 lines], a tab becomes four spaces",
	"  /                at the start of a line lists the commands; Tab completes a command, its word, or a path",
	"  Up, Down         move in what you typed; on its first line, Up brings back what you sent before",
	"  Ctrl-P, Ctrl-N   earlier and later lines you sent",
	"  Ctrl-A, Ctrl-E   start and end of the line; Alt-B and Alt-F go a word back and forward",
	"  Ctrl-W, -U, -K   delete a word, to the start, to the end; Ctrl-Y brings it back; Ctrl-- undoes",
	"",
	"Commands",
	"  1 to 5           go to a tab (Chat holds Conversation, private Work, and the isolated Consult audit)",
	"  [ and ]          the previous and the next view inside Chat, Carto, Diff and Model (H and L do the same)",
	"  j, k             move down and up over the items; g and G go to the first and the last",
	"  Enter, Space, o  open what is selected, or fold it; l opens, h folds. In Work, Enter opens private reasoning or a call, and l takes a call to where its work lives. In Consult, Enter folds a conference or opens its attributed activity. In Shells, Enter on a window shows its output as a terminal emulator does (Enter goes back)",
	"  + and -          open everything, fold everything (zR and zM do the same)",
	"  Ctrl-D, Ctrl-U   scroll half a page; Ctrl-F and Ctrl-B a page; Ctrl-E and Ctrl-Y a row",
	"  /                search the tab that shows; Enter or Down goes to the next match, Up to the one before, Esc closes the search",
	"  e                on an entry of Atlas, Ledger, Plan or Books: the small box on its fields — a live counter shows how full a field is and the book's limit is where it stops; Tab goes to the next field, Enter saves one-line fields, and in a field that holds a long text Enter ends a line and Ctrl-Enter saves; Esc cancels",
	`  E                the $EDITOR door on the same row: the entry's own JSON at its line; on anything but an entry, a template for a new one. Ctrl-O is the same door, in every tab and mode, including while you type; everywhere e does not open the box (the tree, the diff, Chat, Model), e is this same door: in Conversation it rewords a stable source for a future kept talk; private Work cannot be edited; sent Model payloads are read-only`,
	"  f, v, d, x, t    the same keys on a row outside Chat: f folds a report out of view or brings it back (in Current shared brain); v archives a row out of what the agent reads — a report, ledger entry, plan envelope or move, book entry, node of the graph — or brings it back; d deletes it for good (d again), and in Requests forgets it without a word to the agent; t settles it (a ledger entry closes, a reported move opens a prompt for why its proof witnesses its done-when, a completed envelope closes, a book entry settles, a node confirms); sent Model payloads have no delete action; x takes a shelved file off the shelf (in Current shared brain). In Conversation, d removes one stable source from future kept talk only; the active conversation and sent requests stay unchanged.",
	"  n                a new ledger entry, plan envelope, child move on a selected envelope, book entry or node: the small box uses the same operations as the agent (E opens the template in $EDITOR instead)",
	"  a                in Current shared brain, shelve a file (puts /shelve in the prompt); in Requests, approve the request",
	"  y, Y             copy what is selected; copy the whole tab",
	"  r                read the tab again",
	"  :                type a command",
	"  i, a, Esc        type",
	"  ?                this sheet",
	"",
	"Both modes",
	"  Tab, Shift-Tab   the next and the previous tab (while you type, Tab completes instead once there is text)",
	"  PgUp, PgDn       scroll; so does the wheel. Ctrl-Home and Ctrl-End go to the top and the end",
	"  Ctrl-Shift-F     search the tab that shows, where the terminal can send that key (else: Esc, then /)",
	"  Ctrl-T           show or hide the agent's notes and thinking",
	"  Ctrl-C           clear what you have typed; with the line empty, again (soon after) leaves, the way /quit does",
	"  Ctrl-X           stop the agent; Ctrl-V pauses it: holds the agent in its stream mid-reply; until you unpause, it starts nothing of its own (a line or command you write ends the held stream)",
	"  Ctrl-L           draw the screen again",
	"  Ctrl-O           the $EDITOR door, in every tab and mode, including while typing",
	"  F1               this sheet",
	"",
	"The mouse",
	"  A click          on a line selects it and opens or folds it; on a tab's or a view's name goes there; in what you typed, puts the cursor there",
	"  Dragging         selects text, and letting go copies it. A double click selects a word, a triple click a line",
	"  The wheel        scrolls what is under the pointer; the bar at the right edge can be dragged",
	"",
	"Copying whole things",
	"  /copy            the agent's last message",
	"  /copy session    the whole session as Markdown",
	"  /copy report     the last task's report",
	"  /copy tab        the tab that is showing",
	"  Each goes to the clipboard and to a file under .brain/export/.",
].join("\n");

/**
 * pi-tui's terminal, with a way to hand it a key as if it had been pressed: the search of a tab opens on
 * Ctrl-Shift-F, which many terminals cannot send, so the commands mode sends it for them.
 */
class Term extends ProcessTerminal {
	start(onInput, onResize) {
		this.press = onInput;
		super.start(onInput, onResize);
	}
}
/** Ctrl-Shift-F, as a terminal with the Kitty keyboard protocol sends it. */
const SEARCH_KEY = "\x1b[102;6u";

/**
 * Run carto in the full screen.
 * @param {any} session
 * @param {any} options  what runTerminal takes, plus `intro`: lines printed before the screen opened
 * @param {(session: any, options: any) => Promise<number>} runTerminal
 */
export async function runScreen(session, options, runTerminal) {
	const { root, brainDir, config = {} } = options;
	const started = Date.now();
	/** What the terminal core lets the screen ask (src/terminal.mjs, `ui.attach`). */
	let core = { busy: () => false, paused: () => false, thinking: () => true, contextSize: () => undefined };
	// The file-completion helper is resolved before the terminal starts, never by a render or key handler.
	const fileSearch = await findExecutable(["fd", "fdfind"]);

	// ─── The terminal, in pi-tui's hands ─────────────────────────────────────
	// The lines that break in what is typed, and the keys that bring back what was sent before.
	// In the search, the arrows go from match to match as well: Shift-Enter is a key many terminals cannot tell
	// from Enter.
	setKeybindings(
		new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.newLine": ["shift+enter", "ctrl+j", "alt+enter"],
			"tui.editor.historyPrevious": ["ctrl+p"],
			"tui.editor.historyNext": ["ctrl+n"],
			"tui.altScreen.searchNext": ["enter", "ctrl+g", "down"],
			"tui.altScreen.searchPrevious": ["shift+enter", "ctrl+shift+g", "up"],
		}),
	);
	const terminal = new Term();
	const tui = new TuiAltScreen(terminal, false, undefined, {
		mouse: true,
		wheelScrollLines: POLICY.limits.screen.wheelScrollLines,
		// What is selected with the mouse is copied when the button is let go, every way there is.
		copySelection: async (text) => ((await toClipboard(selectionText(text), { write: (sequence) => terminal.write(sequence) })).length > 0 ? true : "no way to the clipboard was found"),
		scrollToEndIndicator: () => `${sgr("bgSel")} ↓ the newest · G or End \x1b[0m`,
		searchMatchStyle: (text) => `${sgr("under")}${text}\x1b[24m`,
		searchCurrentMatchStyle: (text) => `${sgr("chip")}${text}\x1b[0m`,
	});

	// ─── Colours (src/screen/theme.mjs) ──────────────────────────────────────
	// A palette for the terminal's own background. It starts from what the settings and the environment say, and
	// is made again when the terminal answers what its colours are, and whenever it says they have changed.
	const colors = { mode: colorMode(config.colors), background: undefined, foreground: undefined };
	let mdTheme;
	let themeVersion = 0;
	const retheme = () => {
		const theme = makeTheme({ mode: colors.mode, ...(config.theme === "dark" || config.theme === "light" ? { scheme: config.theme } : { background: colors.background, foreground: colors.foreground, scheme: schemeFromEnv() }) });
		applyTheme(theme.styles);
		mdTheme = markdownTheme(theme.styles);
		themeVersion++;
	};
	retheme();
	/** What the agent says, rendered as Markdown by pi-tui: styled lines of exactly `cols` cells. */
	const markdown = (text, cols) => {
		const strip = (line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
		return new Markdown(text, 0, 0, mdTheme).render(cols).map((styled) => ({ styled, cells: visibleWidth(styled), text: strip(styled).trimEnd() }));
	};
	let refreshReferenceLabels = () => {};
	const referenceLabels = createDeferredReferenceLabels({ brainDir, onResolved: () => refreshReferenceLabels() });
	const describeRef = referenceLabels.describe;
	// The Consult subview receives only its own asynchronously refreshed co<N> cache. The records never join parent
	// talk/work, a request, or the shared brain; these synchronous callbacks merely read that isolated cache.
	const CONSULT_PROJECTION = "chat.consult";
	let settleConsultProjection = () => {};
	const consultProjections = createProjectionScheduler({ onSettled: (id, projection) => settleConsultProjection(id, projection) });
	const consultProjection = () => consultProjections.get(CONSULT_PROJECTION);
	const readConferenceRaw = (id) => (consultProjection().data?.conferences ?? []).find((entry) => entry.id === id)?.conference;
	const listConferenceRaw = () => consultProjection().data?.conferences ?? [];
	const chat = createChat({
		markdown,
		describeRef,
		readConference: readConferenceRaw,
		listConferences: listConferenceRaw,
		consultStatus: () => ({ loading: consultProjection().loading, error: consultProjection().error }),
	});
	const askColors = () => {
		if (config.theme === "dark" || config.theme === "light" || colors.mode === "none") return;
		const take = (told) => {
			const rgb = (color) => (color === undefined ? undefined : [color.r, color.g, color.b]);
			const [background, foreground] = [rgb(told.background), rgb(told.foreground)];
			if (background === undefined || (String(background) === String(colors.background) && String(foreground) === String(colors.foreground))) return;
			colors.background = background;
			colors.foreground = foreground;
			retheme();
			chat.restyle();
			tui.invalidate();
			tui.requestRender(true);
		};
		tui.queryTerminalColors({ timeoutMs: POLICY.timing.screen.colorQueryMs, onLateReply: take }).then(take, () => {});
	};

	const state = {
		tab: "chat",
		view: { chat: "conversation", carto: "atlas", diff: "last", shells: "list", context: "window" },
		shell: undefined, // the shell window whose output the Output view shows
		deleteArm: undefined, // a report or Talk source marked for its second d
		mode: "type",
		selected: undefined, // a stop of the Conversation, Work, or Consult projection
		pending: "", // the first key of a command of two (z, then R)
		prompt: "› ",
		busySince: undefined,
		restSince: Date.now(),
		rate: undefined,
		prefill: undefined,
		lastPrefill: undefined,
		// Terminal core failures that must remain visible even when the chat has scrolled: an offline model server
		// is recoverable, but it is not an idle Cartographer session.
		modelError: undefined,
		closed: false,
	};
	const draw = () => {
		if (!state.closed) tui.requestRender();
	};
	refreshReferenceLabels = () => {
		if (state.closed || !chat.refreshActivityLabels()) return;
		draw();
	};
	settleConsultProjection = (id) => {
		if (id !== CONSULT_PROJECTION) return;
		chat.refreshConsult();
		if (!state.closed && state.tab === "chat" && state.view.chat === "consult") draw();
	};
	/** The cells between the margins, as the parts count them. */
	const innerCols = () => Math.max(8, terminal.columns - 2 * marginOf(terminal.columns));
	/** Whether the notes show is the terminal core's to say (Ctrl-T, /thinking); Chat follows it. */
	let lastThinking;
	const syncThinking = () => {
		if (core.thinking() === lastThinking) return;
		lastThinking = core.thinking();
		chat.setThinking(lastThinking);
		draw();
	};
	/** Something to say in passing, which is not worth a line of the conversation. */
	const flash = (text) => {
		if (!state.closed) tui.flash(` ${cut(text, Math.max(16, Math.min(56, terminal.columns - 50)))} `, POLICY.timing.screen.flashMs);
	};

	// ─── The terminal core's side ────────────────────────────────────────────
	const reader = new EventEmitter();
	reader.prompt = () => {};
	reader.setPrompt = (text) => {
		state.prompt = text;
		draw();
	};
	reader.close = () => {
		if (state.closed) return;
		state.closed = true;
		reader.emit("close");
	};
	const keys = new EventEmitter();
	const screen = {
		reader,
		keys,
		print(text) {
			chat.print(text);
			draw();
		},
		user(text) {
			chat.user(text);
			draw();
		},
		block(label, text) {
			chat.block(label, text);
			draw();
		},
		entry(depth, entry, printed, consult) {
			chat.seal();
			chat.entry(depth, entry, printed, consult);
			draw();
		},
		live(depth, message, consult) {
			chat.live(depth, message, consult);
			draw();
		},
		liveTools(depth, slots, consult) {
			chat.liveTools(depth, slots, consult);
			draw();
		},
		attach(given) {
			core = given;
		},
		notice(text) {
			syncThinking();
			flash(text);
		},
		/** A required model-route gate failed. Keep it in the strip as well as the Chat notice. */
		modelError(message) {
			state.modelError = String(message);
			draw();
		},
		/** A successful first-turn proof clears the stale unavailable-route status. */
		modelReady() {
			if (state.modelError === undefined) return;
			state.modelError = undefined;
			draw();
		},
	};
	for (const line of options.intro ?? []) chat.print(`${line}\n`, { keep: true });
	chat.seal();

	// ─── What the status strip is made of ───────────────────────────────────
	session.on?.((event) => {
		if (event.type !== "prefill") return;
		if (event.phase === "sent") state.prefill = { id: event.id, began: event.began, phase: "sent" };
		else if (event.phase === "reading" && state.prefill?.id === event.id) {
			const fresh = event.total - event.cache;
			const done = Math.max(0, event.processed - event.cache);
			state.prefill = { ...state.prefill, phase: "reading", fresh, done, total: event.total, ms: event.time_ms };
		} else if ((event.phase === "writing" || event.phase === "done") && state.prefill?.id === event.id) {
			if (state.prefill.fresh >= (config.prefillTokens ?? DEFAULTS.prefillTokens)) state.lastPrefill = { fresh: state.prefill.fresh, ms: state.prefill.ms ?? event.at - event.began, at: event.at };
			state.prefill = undefined;
		}
		draw();
	});
	// How fast the reply grows: characters now and a moment ago, at about four to a token.
	let rateMark = { at: Date.now(), size: 0 };
	const measure = () => {
		const size = chat.liveSize();
		const now = Date.now();
		if (size < rateMark.size) rateMark = { at: now, size };
		else if (now - rateMark.at >= POLICY.timing.screen.rateWindowMs) {
			const grown = size - rateMark.size;
			state.rate = grown > 0 ? grown / charsPerTokenNow() / ((now - rateMark.at) / 1000) : undefined;
			rateMark = { at: now, size };
		}
	};
	let brain = { at: 0, loading: false, request: 0 };
	/** Refresh status outside rendering. The newest request alone may replace the strip's cached projection. */
	const refreshBrain = (force = false) => {
		if (brain.loading || (!force && Date.now() - brain.at < POLICY.timing.screen.stateCacheMs)) return;
		const request = brain.request + 1;
		brain = { ...brain, at: Date.now(), loading: true, request };
		void queries.status({ yolo: options.gate?.yolo === true })
			.then((result) => {
				if (brain.request !== request) return;
				if (!result.ok) {
					brain = { ...brain, loading: false };
					return;
				}
				const { plan, ledger, requests, waits } = result.data;
				brain = {
					at: brain.at,
					loading: false,
					request,
					requests,
					waits,
					...(plan === undefined || plan.total === 0 ? {} : { plan: `plan ${plan.total - plan.open}/${plan.total} envelopes · ${plan.moves} moves${plan.awaiting > 0 ? ` · ${plan.awaiting} awaiting` : plan.ready ? " · move ready" : ""}` }),
					...(ledger === undefined ? {} : { ledger: ledger.goals === 0 ? "no goal" : `${ledger.goals === 1 ? "1 goal" : `${ledger.goals} goals`}` }),
				};
				draw();
			})
			.catch(() => {
				if (brain.request === request) brain = { ...brain, loading: false };
			});
	};
	const readBrain = () => {
		refreshBrain();
		return brain;
	};
	/** Drop a possibly stale status result after a durable workspace action, then request a replacement. */
	const invalidateBrain = () => {
		brain = { at: 0, loading: false, request: brain.request + 1 };
		refreshBrain(true);
	};
	/** The activity, shared-state, and key-reminder rows of the strip, as spans. */
	const status = () => {
		const busy = core.busy();
		if (busy && state.busySince === undefined) {
			state.busySince = Date.now();
			state.rate = undefined;
		}
		if (!busy && state.busySince !== undefined) {
			state.busySince = undefined;
			state.restSince = Date.now();
			state.prefill = undefined;
		}
		const question = session.asks?.pending();
		const first = [];
		if (question !== undefined) first.push([`? waiting for your answer since ${stamp(question.since).split(", ").at(-1)}`, "warn bold"], [" · type it below", "muted"]);
		else if (busy) {
			const doing = chat.doing();
			// The mark turns while the agent works: the screen is alive also when nothing else on it moves.
			first.push([`${SPINNER[Math.floor(Date.now() / SPIN_MS) % SPINNER.length]} `, "ok"], [doing?.task ?? (session.activeTask?.() !== undefined ? "task" : "working"), "bold"]);
			const reading = state.prefill?.phase === "reading" && state.prefill.fresh >= (config.prefillTokens ?? DEFAULTS.prefillTokens);
			if (reading) {
				const { fresh, done, ms } = state.prefill;
				const rate = ms > 0 ? done / (ms / 1000) : 0;
				const left = rate > 0 ? (fresh - done) / rate : undefined;
				first.push([` · reading ${short(done)} of ${short(fresh)} new ${bar(done / fresh)} ${Math.round((done / fresh) * 100)}%`, "tool"], [`${rate > 0 ? ` · ${Math.round(rate)} tok/s` : ""}${left !== undefined ? ` · writing in ~${Math.max(1, Math.round(left))} s` : ""}`, "muted"]);
			} else if (doing !== undefined) first.push([` · ${doing.what}`, ""]);
			else if (state.prefill?.phase === "sent") first.push([" · waiting for the model", "muted"]);
			first.push([` · ${span(Date.now() - state.busySince)}`, "muted"]);
			if (state.rate !== undefined && !reading) first.push([` · ${state.rate < POLICY.limits.format.rateDecimalBelow ? state.rate.toFixed(1) : Math.round(state.rate)} tok/s`, "muted"]);
			if (state.lastPrefill !== undefined && Date.now() - state.lastPrefill.at < POLICY.timing.screen.prefillRecentMs && !reading) first.push([` · read ${short(state.lastPrefill.fresh)} new in ${span(state.lastPrefill.ms)}`, "muted"]);
		} else first.push(["○ ", "muted"], ["resting", ""], [` · ${span(Date.now() - state.restSince)}`, "muted"]);
		if (core.paused?.()) first.push([" · paused: held · /pause or Ctrl-V lets it go on", "warn"]);

		const second = [];
		const size = core.contextSize();
		// /model re-fits the window while running; options.config is the shared object that follows it. A route
		// error takes precedence over ordinary accounting: the visible status must say why Cartographer is resting.
		const windowSize = options.config?.contextWindow ?? options.contextWindow;
		if (state.modelError !== undefined) second.push([`! ${cut(state.modelError, POLICY.limits.screen.consoleErrorChars)}`, "warn"]);
		else second.push([`ctx ${bar((size ?? 0) / windowSize)} ${size === undefined ? "?" : short(size)}/${short(windowSize)}`, size !== undefined && size / windowSize > POLICY.limits.screen.contextWarnPercent / 100 ? "warn" : ""]);
		const { plan, ledger, waits, requests } = readBrain();
		if (ledger !== undefined) second.push([` · ${ledger}`, "muted"]);
		if (plan !== undefined) second.push([` · ${plan}`, waits ? "warn" : "muted"]);
		if (requests > 0) second.push([` · ${requests === 1 ? "1 request" : `${requests} requests`} for you`, waits ? "warn" : "muted"]);
		const windows = (projectionFor?.("shells.list").data?.windows ?? []).filter((win) => win.state !== POLICY.enums.windowStates.gone);
		if (windows.length > 0) {
			const running = windows.filter((win) => win.state === POLICY.enums.windowStates.busy).length;
			second.push([` · ${windows.length === 1 ? "1 window" : `${windows.length} windows`}${running > 0 ? `, ${running} busy` : ""}`, running > 0 ? "" : "muted"]);
		}
		const wakes = projectionFor?.("runtime.wakes").data?.wakes ?? [];
		if (wakes.length > 0) second.push([` · ${wakes.length === 1 ? "1 wake" : `${wakes.length} wakes`}`, "muted"]);
		if (options.gate?.yolo === true) second.push([" · yolo", "warn"]);
		if (options.runner?.mode === "direct") second.push([" · no sandbox", "warn"]);
		if (!core.thinking()) second.push([" · notes hidden", "muted"]);
		return [first, second, [[` ${legend()}`, "faint"]]];
	};

	/** The keys this view takes, then what every view takes: one line, at the bottom, the same place everywhere. */
	const LEGEND = {
		"chat.conversation": "j k move · Enter open · e reword kept talk · d remove kept talk · y copy",
		"chat.work": "j k move · Enter open · y copy",
		"chat.consult": "j k move · Enter open · + all · y copy",
		"carto.atlas": "t confirm · n new · v archive · d delete · e edit",
		"carto.ledger": "t settle · n new · v archive · d delete · e edit",
		"carto.plan": "t done/review · n new · v archive · d delete · e edit",
		"carto.requests": "a approve · n deny · d forget · e edit",
		"carto.tree": "Enter fold · y copy · e edit",
		"carto.hands": "f fold · v archive · d delete · x unshelve · e edit",
		"diff.last": "Enter open · y copy · e edit",
		"diff.session": "Enter open · y copy · e edit",
		"diff.git": "Enter open · y copy · e edit",
		"shells.list": "Enter output · y copy",
		"shells.out": "Enter back",
		"context.window": "Enter open · y copy",
		"context.main": "Enter open · y copy",
		"context.raw": "Enter open · y copy",
		"context.preview": "Enter open · y copy",
		"context.parts": "Enter open · + all · y copy",
	};
	const legend = () => {
		if (state.mode === "type") return "Esc: commands · Ctrl-O: $EDITOR · ? all keys";
		const id = viewId();
		return `${LEGEND[id] ?? "j k move · Enter open"} · ? all keys`;
	};
	// ─── The tabs that are lists ─────────────────────────────────────────────
	const viewId = (tab = state.tab) => (VIEWS[tab] !== undefined ? `${tab}.${state.view[tab]}` : tab);
	/** The file a view comes from, for `e` when no item names one. */
	const fileOf = (id) =>
		({
			"carto.atlas": queries.paths.atlas,
			"carto.ledger": queries.paths.ledger,
			"carto.plan": queries.paths.plan,
		})[id];
	// Workspace rows and field forms enter the application boundary here. The external file-editor handoffs remain
	// narrow transitional seams; keyboard actions and overlays consume typed results.
	const application = options.application ?? createApplication({
		brainDir,
		root,
		config,
		runtime: {
			main: session.main,
			context: session.context,
			engine: session.engine,
			windows: session.windows,
			wakes: session.wakes,
			model: session.model,
			preview: session.preview,
			runner: options.runner,
			contextWindow: () => options.config?.contextWindow ?? options.contextWindow,
		},
	});
	const queries = application.queries;
	const workspace = Object.freeze({ execute: application.execute, template: application.workspace.template });
	const talk = Object.freeze({ execute: application.execute });
	/** Consult records are loaded only through the application facade and stay in Chat · Consult's private cache. */
	const refreshConsultProjection = (force = false) => {
		const prior = consultProjection();
		if (!force && Date.now() - (prior.requestedAt ?? 0) < (EVERY.chat ?? POLICY.timing.screenRefreshMs.fallback)) return false;
		return consultProjections.refresh(CONSULT_PROJECTION, ({ signal }) => queries.consult.list({ signal }), { force });
	};
	const cancelConsultProjection = () => consultProjections.cancel(CONSULT_PROJECTION);
	/** Cached deferred projections. Rendering never starts a durable read; refresh below owns requests and rejects stale results. */
	const DEFERRED_PROJECTION = Object.freeze({
		"carto.atlas": ({ signal }) => queries.atlas({ signal }),
		"carto.ledger": ({ signal }) => queries.ledger({ signal }),
		"carto.plan": ({ signal }) => queries.plan({ signal }),
		"carto.requests": ({ signal }) => queries.requests({ yolo: options.gate?.yolo === true, signal }),
		"carto.tree": ({ signal }) => queries.tree({ signal }),
		"carto.hands": ({ signal }) => queries.context({ signal }),
		"diff.last": ({ signal }) => queries.review.last({ signal }),
		"diff.session": ({ signal }) => queries.review.session({ started, signal }),
		"diff.git": ({ signal }) => queries.review.git({ signal }),
		"shells.list": ({ signal }) => queries.runtime.shells({ signal }),
		"shells.out": ({ signal }) => queries.runtime.shellOutput({ name: state.shell, signal }),
		"runtime.wakes": ({ signal }) => queries.runtime.wakes({ signal }),
		"context.window": ({ signal }) => queries.runtime.sent({ scope: "newest", signal }),
		"context.main": ({ signal }) => queries.runtime.sent({ scope: "main", signal }),
		"context.raw": ({ signal }) => queries.runtime.sent({ scope: "newest", signal }),
		"context.preview": ({ signal }) => queries.runtime.preview({ signal }),
		"context.parts": ({ signal }) => queries.runtime.context({ signal }),
	});
	const PROJECTION_NAME = Object.freeze({
		"carto.atlas": "Atlas",
		"carto.ledger": "Ledger",
		"carto.plan": "Plan",
		"carto.requests": "Requests",
		"carto.tree": "Project tree",
		"carto.hands": "Current shared brain",
		"diff.last": "Last checkpoint change",
		"diff.session": "Session changes",
		"diff.git": "Git changes",
		"shells.list": "Shell windows",
		"shells.out": "Shell output",
		"runtime.wakes": "Wake schedule",
		"context.window": "Latest sent provider request",
		"context.main": "Main sent provider request",
		"context.raw": "Raw provider payload",
		"context.preview": "Next request preview",
		"context.parts": "Current active-context accounting",
	});
	let settleProjection = () => {};
	const projections = createProjectionScheduler({ onSettled: (id, projection) => settleProjection(id, projection) });
	const projectionFor = (id) => projections.get(id);
	const projectionMessage = (projection) => projection?.error?.message ?? "Cartographer could not refresh this view.";
	const projectionView = (id, render) => {
		const projection = projectionFor(id);
		const name = PROJECTION_NAME[id] ?? "view";
		if (projection.data === undefined) {
			if (projection.error !== undefined) return {
				header: [[[`! ${projectionMessage(projection)}`, "warn"]]],
				items: [{ key: `projection:${id}:error`, plain: true, head: [[`  ${name} could not be loaded. Press r to retry.`, "muted"]] }],
			};
			return {
				header: [[[`${name} is loading…`, "muted"]]],
				items: [{ key: `projection:${id}:loading`, plain: true, head: [["  Reading the current durable view without blocking input…", "faint"]] }],
			};
		}
		const view = render(projection.data);
		const notices = [];
		if (projection.loading) notices.push([[`↻ Refreshing ${name.toLowerCase()} · showing cached data`, "muted"]]);
		else if (projection.error !== undefined) notices.push([[`! ${projectionMessage(projection)} · showing cached data`, "warn"]]);
		if (Array.isArray(projection.data.issues) && projection.data.issues.length > 0) notices.push([[`! ${projection.data.issues.map((issue) => issue.message).join(" · ")}`, "warn"]]);
		return notices.length === 0 ? view : { ...view, header: [...notices, ...view.header] };
	};
	const refreshProjection = (id, force = false) => {
		const query = DEFERRED_PROJECTION[id];
		return query === undefined ? false : projections.refresh(id, query, { force });
	};
	const cancelProjection = (id) => projections.cancel(id);
	let wakesProjectionAt = 0;
	/** The strip owns one timed Runtime snapshot rather than asking the live wake manager while it renders. */
	const refreshWakeProjection = (force = false) => {
		if (!force && Date.now() - wakesProjectionAt < EVERY.shells) return false;
		wakesProjectionAt = Date.now();
		return refreshProjection("runtime.wakes", force);
	};
	const invalidateProjections = () => projections.invalidate();
	/** All adapter actions publish the same invalidation fact, including a slash command handled by the terminal core. */
	const stopApplicationEvents = application.events.subscribe((event) => {
		if (event.type !== "projection.invalidated") return;
		const scopes = event.payload.scopes ?? [];
		if (!scopes.some((scope) => ["workspace", "context", "requests"].includes(scope))) return;
		invalidateBrain();
		invalidateProjections();
		refresh(viewId(), true);
	});
	/** Each view: its list, the part that draws it, and the scroll view the part stands in. */
	const pages = new Map();
	const pageOf = (id = viewId()) => pages.get(id);
	const build = (id, isOpen, cols) => {
		if (id === "carto.atlas") return projectionView(id, (data) => atlasView({ brainDir, atlas: data.atlas, attention: data.attention, lines: data.lines }));
		if (id === "carto.ledger") return projectionView(id, (data) => ledgerView({ brainDir, ledger: data.ledger, lines: data.lines }));
		if (id === "carto.plan") return projectionView(id, (data) => planView({ brainDir, yolo: options.gate?.yolo === true, plan: data.plan, lines: data.lines }));
		if (id === "carto.requests") return projectionView(id, (data) => requestsView({ brainDir, requests: data.items }));
		if (id === "carto.tree") return projectionView(id, (data) => treeView({ root, tree: data }, isOpen));
		if (id === "carto.hands") return projectionView(id, (data) => handsView({ root, context: data }));
		if (id.startsWith("diff.")) return projectionView(id, (data) => diffView({ root, review: data }, id.slice(5)));
		if (id === "shells.list") return projectionView(id, (data) => shellsView(data));
		if (id === "shells.out") return projectionView(id, (data) => shellsOutView(data));
		if (id === "context.window" || id === "context.main") return projectionView(id, (data) => {
			const sent = data.sent;
			return contextView(sent, { windowSize: options.config?.contextWindow ?? options.contextWindow, cols, writing: sent === undefined || sent.reply !== undefined ? undefined : chat.liveMessage(sent.task ? 1 : 0), isOpen });
		});
		if (id === "context.raw") return projectionView(id, (data) => rawPayloadView(data.sent));
		if (id === "context.preview") return projectionView(id, (data) => previewView(data.preview));
		if (id === "context.parts") return projectionView(id, (data) => accountingProjectionView(data, { config }));
		return { header: [], items: [] };
	};
	const rebuild = (id = viewId()) => {
		const page = pageOf(id);
		if (page === undefined) return;
		try {
			page.list.set(build(id, page.list.isOpen, innerCols()));
		} catch (error) {
			page.list.set({ header: [[[`! ${error?.message ?? error}`, "warn"]]], items: [] });
		}
	};
	settleProjection = (id) => {
		if (state.closed) return;
		rebuild(id);
		if (viewId() === id || id === "runtime.wakes") draw();
	};
	/** Read a view again. */
	const refresh = (id = viewId(), force = false) => {
		if (id === "chat.consult") {
			refreshConsultProjection(force);
			if (chat.refreshConsult()) draw();
			return;
		}
		const page = pageOf(id);
		if (page === undefined) return;
		if (!force && Date.now() - page.at < (EVERY[id.split(".")[0]] ?? POLICY.timing.screenRefreshMs.fallback)) return;
		page.at = Date.now();
		refreshProjection(id, force);
		const before = page.list.version;
		rebuild(id);
		if (page.list.version !== before) draw();
	};

	/** Present one typed workspace outcome, then redraw the projection that started the action. */
	const presentWorkspaceResult = (result, id = viewId()) => {
		flash((result.ok ? result.data.line : result.error.message).replace(/\n+/g, " "));
		if (!result.ok) refresh(id, true);
		draw();
		return result.ok;
	};
	/** Run a row action through the typed application boundary, then redraw its projection after it settles. */
	const runWorkspaceAction = (action, input, options_ = {}) => {
		const id = viewId();
		void workspace.execute(action, input, options_)
			.then((result) => presentWorkspaceResult(result, id))
			.catch((error) => flash(`could not complete that workspace action: ${error?.message ?? error}`));
	};
	/** A reported move needs its evidence review in the composer; every other row can settle immediately. */
	const settleWorkspaceRow = async (rowKey, id) => {
		if (!rowKey.startsWith("move:")) return runWorkspaceAction(WORKSPACE_ACTION.settle, { id });
		const found = await queries.entry({ book: "plan", id });
		if (!found.ok) return flash(found.error.message);
		if (found.data.item.status !== POLICY.enums.moveStatus.reported) return runWorkspaceAction(WORKSPACE_ACTION.settle, { id });
		if (viewId() !== "carto.plan") return;
		setMode("type");
		prompt.insertTextAtCursor(`/done ${id} -- `);
		flash(`Write why ${id}'s reported proof witnesses its done-when, then press Enter.`);
	};

	// ─── Copying ─────────────────────────────────────────────────────────────
	const copy = async (text, name, what, extension = "md") => {
		if (String(text).trim() === "") {
			flash(`nothing to copy: ${what} is empty`);
			return void chat.print(`  Nothing to copy: ${what} is empty.\n`);
		}
		try {
			const done = await copyOut(text, { brainDir, name, extension, write: (sequence) => terminal.write(sequence) });
			chat.print(`  Copied ${what} (${done.chars.toLocaleString("en-US")} characters) to the clipboard by way of ${done.ways.join(", ") || "nothing that was found"}.\n  Also written to ${done.file}\n`);
			if (process.env.TMUX) chat.print("  In tmux the clipboard needs `set -g set-clipboard on`; without it, paste from tmux's buffer (prefix ]) or take the file.\n");
			// (Said shortly: it is laid over the row of tabs. The file is named in Chat.)
			flash(`copied ${what}`);
		} catch (error) {
			chat.print(`! could not copy: ${error?.message ?? error}\n`);
		}
		chat.seal();
		draw();
	};
	const tabName = () => `the ${TABS.find((tab) => tab.id === state.tab).name} tab${VIEWS[state.tab] ? ` (${VIEWS[state.tab].find((view) => view.id === state.view[state.tab]).name})` : ""}`;
	const copyTab = () => {
		if (state.tab === "chat") return copy(chatBody.lines().map((line) => line.spans.map(([text]) => text).join("")).join("\n"), `chat-${state.view.chat}`, tabName(), "txt");
		return copy(pageOf().list.text(), viewId().replace(".", "-"), tabName(), "txt");
	};
	const copyCommand = (argument) => {
		if (argument === "session") return copy(chat.transcript({ title: `Cartographer session · ${root} · ${stamp(Date.now())}` }), "session", "the session");
		if (argument === "tab") return copyTab();
		if (argument === "report") return copy(core.lastReport?.() ?? "", "report", "the last report");
		if (argument !== undefined && argument !== "") return void chat.print("  /copy copies the agent's last message; /copy session the whole session; /copy tab the tab that is showing; /copy report the last task's report.\n");
		return copy(chat.lastAgent() ?? "", "message", "the agent's last message");
	};

	// ─── Tabs, views and what scrolls ───────────────────────────────────────
	const chatTab = () => state.tab === "chat";
	const scrollOf = () => (chatTab() ? chatScroll : pageOf().scroll);
	const setTab = (id) => {
		if (!TABS.some((tab) => tab.id === id)) return;
		const previous = viewId();
		state.tab = id;
		if (previous !== viewId()) {
			cancelProjection(previous);
			if (previous === "chat.consult") cancelConsultProjection();
		}
		tui.resetTextSelection();
		refresh(viewId(), true);
		draw();
	};
	const stepTab = (by) => setTab(TABS[(TABS.findIndex((tab) => tab.id === state.tab) + by + TABS.length) % TABS.length].id);
	const setView = (id) => {
		if (VIEWS[state.tab] === undefined) return;
		const previous = viewId();
		state.view[state.tab] = id;
		if (previous !== viewId()) {
			cancelProjection(previous);
			if (previous === "chat.consult") cancelConsultProjection();
		}
		tui.resetTextSelection();
		refresh(viewId(), true);
		draw();
	};
	const stepView = (by) => {
		const views = VIEWS[state.tab];
		if (views === undefined) return;
		setView(views[(views.findIndex((view) => view.id === state.view[state.tab]) + by + views.length) % views.length].id);
	};
	/** Scroll a view so that a row of it shows. */
	const reveal = (scroll, row, { top = false, header = 0 } = {}) => {
		const rows = scroll.viewportHeight;
		if (row < 0 || rows <= 0) return;
		// The first item stands right below the tab's top lines, and those come into view with it.
		if (row <= header && row < rows) scroll.scrollTo(0, { disableFollow: true });
		else if (row < scroll.scrollTop || top) scroll.scrollTo(row, { disableFollow: true });
		else if (row >= scroll.scrollTop + rows) scroll.scrollTo(row - rows + 1, { disableFollow: true });
	};

	// ─── Typing ──────────────────────────────────────────────────────────────
	const setMode = (mode) => {
		state.mode = mode;
		state.pending = "";
		tui.setFocus(mode === "type" ? prompt : commands);
		draw();
	};
	/** What was typed and sent. */
	const submit = (given) => {
		const text = given.trim();
		if (text === "") return;
		prompt.addToHistory(text);
		// New user speech belongs in Chat's Conversation view, even when private Work was open.
		if (state.tab !== "chat") setTab("chat");
		if (state.view.chat !== "conversation") setView("conversation");
		chatScroll.scrollToEnd();
		const [name, argument] = text.slice(1).trim().split(/\s+/);
		if (text.startsWith("/") && !text.includes("\n")) {
			if (name === "keys") return void showKeys();
			chat.print(`› ${text}\n`);
			if (name === "copy") copyCommand(argument);
			else {
				if (name === "help") chat.print("  F1 shows the keys of the full screen. The commands, typed and sent:\n");
				reader.emit("line", text);
			}
			chat.seal();
			return void draw();
		}
		chat.user(text);
		reader.emit("line", text);
		draw();
	};
	/** Give the terminal to another program for a while (an editor), then take it back. */
	const lend = async (work) => {
		process.stdin.off("data", watchInput);
		tui.stop({ preserveScreen: true });
		try {
			return await work();
		} finally {
			process.stdin.on("data", watchInput);
			tui.start();
			tui.setFocus(state.mode === "type" ? prompt : commands);
			tui.requestRender(true);
		}
	};
	/** Hand the terminal to the editor over `file`; false when the editor could not be run. */
	const runEditor = async (file, line) => {
		const editor = process.env.VISUAL || process.env.EDITOR || "vi";
		const done = await lend(() => launchEditor(editorCommand(editor, file, line)));
		if (done.error !== undefined || (done.status !== 0 && done.status !== null)) {
			const why = done.error?.message ?? `it ended with exit ${done.status}`;
			chat.print(`! The editor could not be run (${editor}): ${why}. Set $EDITOR to the editor you use.\n`);
			flash(`the editor could not be run: ${why}`);
			return false;
		}
		return true;
	};
	/** A file to edit a thing in, under the brain's scratch folder. */
	const scratch = (name, text) => writeScratch(brainDir, name, text);
	/** e in Conversation changes only a row that names the source it changes. Work and Consult are private/read-only. */
	const editChat = async () => {
		const line = chatBody.lines()[selectedRow()];
		if (line === undefined) return flash("nothing is selected: j and k select");
		if (chatProjection() !== "talk") return flash("private Work and Consult activity cannot be edited");
		const item = chat.items.find((entry) => entry.key === line.item);
		if (item?.type === "agent" && item.delivery !== "delivered") return flash("undelivered agent speech cannot be edited");
		if (!chat.editable(line.item)) return flash(line.kind === "console" ? "what Cartographer printed cannot be edited" : "only delivered or submitted speech can be edited");
		if (item?.source === undefined) return flash("this speech has no stable source yet, so it is left unchanged");
		const file = await scratch("message.md", item.text);
		if (!(await runEditor(file))) return;
		const now = (await readText(file)).replace(/\n+$/, "");
		if (now === item.text || now === "") return flash("the message stands as it was");
		void talk.execute(TALK_ACTION.revise, { source: item.source, text: now })
			.then((result) => {
				if (!result.ok) return flash(result.error.message);
				inPlace(() => chat.revise(item.key, now));
				flash(result.data.line);
				draw();
			})
			.catch((error) => flash(`could not edit that kept source: ${error?.message ?? error}`));
	};
	/** Remove one selected source from a future collapse; it does not omit its Durable entry or rewrite a sent request. */
	const removeChat = () => {
		const line = chatBody.lines()[selectedRow()];
		if (line === undefined) return flash("nothing is selected: j and k select");
		if (chatProjection() !== "talk") return flash("private Work and Consult activity cannot be removed from future kept talk");
		const item = chat.items.find((entry) => entry.key === line.item);
		if (item?.type === "agent" && item.delivery !== "delivered") return flash("undelivered agent speech is not kept talk");
		if (item?.type !== "user" && item?.type !== "agent") return flash("only submitted or delivered speech can be removed from future kept talk");
		if (item?.source === undefined) return flash("this speech has no stable source yet, so it is left unchanged");
		const arm = `talk:${item.key}`;
		if (state.deleteArm?.id !== arm || Date.now() - state.deleteArm.at >= POLICY.timing.screen.deleteConfirmMs) {
			void talk.execute(TALK_ACTION.forget, { source: item.source })
				.then((result) => {
					if (result.confirmation === undefined) return flash(result.ok ? result.data.line : result.error.message);
					state.deleteArm = { id: arm, at: Date.now(), confirmation: result.confirmation };
					flash("Press d again: remove this source from future kept talk; sent requests and the active conversation stay unchanged");
				})
				.catch((error) => flash(`could not prepare that kept-source removal: ${error?.message ?? error}`));
			return;
		}
		const confirmation = state.deleteArm.confirmation;
		state.deleteArm = undefined;
		if (confirmation === undefined) return flash("the removal confirmation expired; press d again");
		void talk.execute(TALK_ACTION.forget, { source: item.source }, { confirmation: { ...confirmation, acknowledged: true } })
			.then((result) => {
				if (!result.ok) return flash(result.error.message);
				inPlace(() => chat.forget(item.key));
				flash(result.data.line);
				draw();
			})
			.catch((error) => flash(`could not remove that kept source: ${error?.message ?? error}`));
	};
	/** e in Model opens only code and current Carto sources; sent request rows are historical and read-only. */
	/** n in a book view: the external editor stays a transitional handoff; its template and saved row use the typed action boundary. */
	const newEntry = async (book) => {
		const id = viewId();
		try {
			const template = await workspace.template(book);
			if (!template.ok) return presentWorkspaceResult(template, id);
			const file = await scratch(`new-${book}.json`, template.data.text);
			if (!(await runEditor(file))) return false;
			return presentWorkspaceResult(await workspace.execute(WORKSPACE_ACTION.add, { book, text: await readText(file) }), id);
		} catch (error) {
			flash(`could not prepare that new row: ${error?.message ?? error}`);
			return false;
		}
	};
	const BOOK_VIEWS = { "carto.ledger": "ledger", "carto.plan": "plan", "carto.atlas": "atlas" };
	/** e in Model, or on a Current shared brain record that has its own source. */
	const editCurrent = async () => {
		const item = pageOf().list.selected();
		if (item === undefined) return flash("nothing is selected");
		switch (item.editKind) {
			case "prompt": {
				const file = await promptSource();
				if (file === undefined) return flash("the source of the prompt is not here");
				if (!(await runEditor(file))) return;
				return flash("the prompt's wording is code: the next run of carto reads it as it is now");
			}
			case "tool": {
				const name = String(item.key).startsWith("tool:") ? String(item.key).slice(5) : String(item.key);
				const found = await toolSource(name);
				if (found === undefined) return flash(`no source file defines the ${name} tool`);
				if (!(await runEditor(found.file, found.line))) return;
				return flash(`${name}'s description is code: the next run of carto reads it as it is now`);
			}
			case "tools":
				return flash("the tools are one block; Enter opens it to a line per tool, and e on one opens where it is defined");
			case "assessment": {
				const file = queries.paths.assessment;
				if (!(await runEditor(file))) return;
				refresh(viewId(), true);
				return flash("edited; the copy at the top of the context is rewritten at the next collapse, or /pin now");
			}
			case "store": {
				if (!(await runEditor(queries.paths.context))) return;
				refresh(viewId(), true);
				return flash("the store of what the collapse keeps, edited by hand · take care: a file that does not parse falls back to a fresh one");
			}
			case "chat-you":
			case "chat-agent":
				return flash("this is a frozen sent-request row. Open Chat's Conversation view to change a current kept source; sent requests stay as sent.");
			case "reply":
				return flash("the reply is being written; e on it works once it is done");
			case "result":
				return flash(`tool work cannot be edited: e opens a message of ${USER_NAME} or the agent`);
			case "state":
				return flash("the state block is written anew for every request; what it reads is editable: e on Atlas, Ledger, Plan or Assessment in the Carto tab");
			case "windows":
				return flash("the windows block is written anew for every request, from the windows themselves");
			case "carto":
				return flash("what Cartographer writes into a message cannot be edited");
			default: {
				// A kept row that is a ledger entry opens the small box on its fields, as in the Ledger view.
				if (typeof item.key === "string" && item.key.startsWith("entry:")) return void openFieldBox(viewId(), item.key);
				// Current shared brain: a shelved file is its file; a report is its file in .brain/reports.
				if (typeof item.path === "string" && item.path !== "") {
					if (!(await pathExists(item.path))) return flash("the shelved file is not there");
					if (!(await runEditor(item.path))) return;
					refresh(viewId(), true);
					return flash("edited; the shelf reads it anew at the next collapse");
				}
				if (typeof item.key === "string" && item.key.startsWith("report:")) {
					const file = join(brainDir, "reports", `${item.key.slice(7)}.md`);
					if (!(await pathExists(file))) return flash("the report's file is not there");
					if (!(await runEditor(file))) return;
					return flash("the report's file is edited; the record line keeps the summary it was written with");
				}
				return flash("that is what was sent, and what was sent cannot be changed");
			}
		}
	};
	// ─── The fields the small box edits ───────────────────────────────────────
	// The book views open one of these on e; E keeps the editor on the entry's own JSON. The limits are the books'
	// own, so the box never holds more than the book would; the counter shows how much of the field is used.
	const ROW_KEY = /^(?:entry|item|envelope|move|node):/;
	const boxWidth = (fields, cols) => {
		const longest = Math.max(...fields.map((field) => Math.min(field.limit, 80)));
		const single = !fields.some((field) => field.multiline);
		return Math.max(46, Math.min(cols - 4, single ? longest + 14 : 78));
	};
	/** The fields of the row the list has selected, read through the workspace query boundary. */
	const editFieldsFor = async (viewId_, rowKey) => {
		const id = rowKey.slice(rowKey.indexOf(":") + 1);
		const book = viewId_ === "carto.atlas" ? "atlas" : viewId_ === "carto.plan" ? "plan" : (viewId_ === "carto.ledger" || ((viewId_ === "context.main" || viewId_ === "context.window") && rowKey.startsWith("entry:"))) ? "ledger" : undefined;
		if (book === undefined) return undefined;
		const found = await queries.entry({ book, id });
		if (!found.ok) return { error: found.error.message };
		const { item } = found.data;
		if (book === "ledger") {
			const fields = [{ id: "text", label: "Text", limit: POLICY.limits.ledger.textChars, value: item.text }];
			if (item.kind === POLICY.enums.ledgerKind.goal) fields.push({ id: "doneWhen", label: "Done when", limit: POLICY.limits.ledger.textChars, multiline: true, value: item.doneWhen ?? "" });
			if (item.status === POLICY.enums.entryStatus.done) fields.push({ id: "outcome", label: "Outcome", limit: POLICY.limits.ledger.textChars, value: item.outcome ?? "" });
			return { id, fields };
		}
		if (book === "plan") {
			if (!rowKey.startsWith("move:")) {
				const fields = [
					{ id: "text", label: "Intent", limit: POLICY.limits.plan.itemChars, value: item.text },
					{ id: "doneWhen", label: "Done when", limit: POLICY.limits.plan.itemChars, multiline: true, value: item.doneWhen ?? "" },
				];
				if (item.status === POLICY.enums.entryStatus.done) fields.push({ id: "outcome", label: "Outcome", limit: POLICY.limits.plan.itemChars, value: item.outcome ?? "" });
				return { id, fields };
			}
			const changing = found.data.parent?.mode === POLICY.enums.planMode.change;
			const budget = item.budget ?? { replies: item.turns, fileOps: 0, commandStarts: 0 };
			return {
				id,
				fields: [
					{ id: "text", label: "Action", limit: POLICY.limits.plan.itemChars, value: item.action ?? item.text },
					{ id: "doneWhen", label: "Done when", limit: POLICY.limits.plan.itemChars, multiline: true, value: item.doneWhen ?? "" },
					{ id: "proof", label: changing ? "Required proof" : "Proof, if needed", limit: POLICY.limits.plan.proofChars, multiline: true, value: item.proof ?? "" },
					{ id: "targets", label: "Targets, one per line", limit: POLICY.limits.plan.itemChars, multiline: true, value: (item.targets ?? []).join("\n") },
					...(changing ? [
						{ id: "filesAllowed", label: "File operations allowed", limit: 5, value: String(item.capabilities?.files === true) },
						{ id: "commandsAllowed", label: "Commands allowed", limit: 5, value: String(item.capabilities?.commands === true) },
						{ id: "networkAllowed", label: "Network allowed", limit: 5, value: String(item.capabilities?.network === true) },
						{ id: "replies", label: "Reply budget", limit: 1, value: String(budget.replies ?? item.turns ?? POLICY.limits.plan.moveTurns.change) },
						{ id: "fileOps", label: "File-operation budget", limit: 1, value: String(budget.fileOps ?? POLICY.limits.plan.moveBudget.fileOps) },
						{ id: "commandStarts", label: "Command-start budget", limit: 1, value: String(budget.commandStarts ?? POLICY.limits.plan.moveBudget.commandStarts) },
					] : []),
				],
			};
		}
		return {
			id,
			fields: [
				{ id: "gist", label: "Gist", limit: POLICY.limits.atlas.gistChars, value: item.gist },
				{ id: "detail", label: "Detail", limit: POLICY.limits.atlas.detailChars, multiline: true, value: item.detail ?? "" },
				{ id: "name", label: "Name", limit: POLICY.limits.atlas.nameChars, value: item.name },
			],
		};
	};
	// Snapshot of what the box opens with, so a save knows which fields were edited.
	const openFieldBox = async (viewId_, rowKey) => {
		const found = await editFieldsFor(viewId_, rowKey);
		if (viewId() !== viewId_) return;
		if (found === undefined) return flash("that is not an entry of its book, or the book cannot be read");
		if (found.error !== undefined) return flash(found.error);
		const { id, fields } = found;
		const handle = tui.showOverlay(new Box({
			title: id,
			fields,
			keyOf,
			flash,
			close: () => handle.hide(),
			save: (drafts) => {
				/** @type {Record<string, string>} */
				const changes = {};
				for (const field of fields) if (drafts.get(field.id) !== field.value) changes[field.id] = drafts.get(field.id);
				if (Object.keys(changes).length === 0) {
					flash("nothing was changed");
					return true;
				}
				// Move targets are a list in the plan but a readable line-per-path field in the box.
				if (viewId_ === "carto.plan" && rowKey.startsWith("move:")) {
					if (changes.targets !== undefined) changes.targets = String(changes.targets).split(/[\n,]/).map((path) => path.trim()).filter((path) => path !== "");
					const capabilities = {};
					for (const [field, key] of [["filesAllowed", "files"], ["commandsAllowed", "commands"], ["networkAllowed", "network"]]) {
						if (changes[field] === undefined) continue;
						capabilities[key] = boolOf(String(changes[field]));
						delete changes[field];
					}
					if (Object.keys(capabilities).length > 0) changes.capabilities = capabilities;
					const budget = {};
					for (const [field, key] of [["replies", "replies"], ["fileOps", "fileOps"], ["commandStarts", "commandStarts"]]) {
						if (changes[field] === undefined) continue;
						const raw = String(changes[field]).trim();
						budget[key] = /^\d+$/.test(raw) ? Number(raw) : raw;
						delete changes[field];
					}
					if (Object.keys(budget).length > 0) changes.budget = budget;
				}
				return workspace.execute(WORKSPACE_ACTION.edit, { id, changes })
					.then((result) => presentWorkspaceResult(result, viewId_));
			},
			redraw: draw,
		}), { width: boxWidth(fields, terminal.columns), anchor: "center" });
	};
	/** The fields of a new entry of `book`, from the same template n used to open in the editor. */
	const ADD_FIELDS = {
		ledger: () => [
			{ id: "kind", label: "Kind", limit: 8, value: "note" },
			{ id: "text", label: "Text", limit: POLICY.limits.ledger.textChars, value: "" },
			{ id: "doneWhen", label: "Done when", limit: POLICY.limits.ledger.textChars, multiline: true, value: "" },
			{ id: "salient", label: "Salient", limit: 5, value: "false" },
		],
		plan: () => [
			{ id: "mode", label: "Mode", limit: 6, value: "change" },
			{ id: "text", label: "Intent", limit: POLICY.limits.plan.itemChars, value: "" },
			{ id: "doneWhen", label: "Done when", limit: POLICY.limits.plan.itemChars, multiline: true, value: "" },
			{ id: "network", label: "Network", limit: 5, value: "false" },
			{ id: "standing", label: "Standing", limit: 5, value: "false" },
		],
		atlas: () => [
			{ id: "name", label: "Name", limit: POLICY.limits.atlas.nameChars, value: "" },
			{ id: "gist", label: "Gist", limit: POLICY.limits.atlas.gistChars, value: "" },
			{ id: "detail", label: "Detail", limit: POLICY.limits.atlas.detailChars, multiline: true, value: "" },
		],
	};
	/** true/false as a boolean; anything else goes to the book as it was said, and the book refuses it in its own words. */
	const boolOf = (raw) => {
		const word = raw.trim().toLowerCase();
		return word === "true" ? true : word === "false" ? false : raw.trim();
	};
	const addOpOf = (book, drafts) => {
		const said = (key) => drafts.get(key) ?? "";
		const bool = (key) => (said(key).trim() === "" ? undefined : boolOf(said(key)));
		if (book === "ledger") {
			return { kind: said("kind").trim(), text: said("text"), ...(said("doneWhen").trim() !== "" ? { done_when: said("doneWhen") } : {}), ...(bool("salient") !== undefined ? { salient: bool("salient") } : {}) };
		}
		if (book === "plan") {
			return { mode: said("mode").trim(), text: said("text"), ...(said("doneWhen").trim() !== "" ? { done_when: said("doneWhen") } : {}), ...(bool("network") !== undefined ? { network: bool("network") } : {}), ...(bool("standing") !== undefined ? { standing: bool("standing") } : {}) };
		}
		return { name: said("name"), gist: said("gist"), ...(said("detail").trim() !== "" ? { detail: said("detail") } : {}) };
	};
	const openAddBox = (book) => {
		const template = ADD_FIELDS[book];
		if (template === undefined) return flash("this view has no add");
		const id = viewId();
		const fields = template();
		const handle = tui.showOverlay(new Box({
			title: `new ${book}`,
			fields,
			keyOf,
			flash,
			close: () => handle.hide(),
			save: (drafts) => workspace.execute(WORKSPACE_ACTION.add, { book, text: JSON.stringify(addOpOf(book, drafts)) })
				.then((result) => presentWorkspaceResult(result, id)),
			redraw: draw,
		}), { width: boxWidth(fields, terminal.columns), anchor: "center" });
	};
	/** `n` on an envelope declares a child move through the typed workspace action. */
	const openMoveBox = async (parentId) => {
		const found = await queries.entry({ book: "plan", id: parentId });
		if (viewId() !== "carto.plan") return;
		if (!found.ok || found.data.item.parent !== undefined) return flash(found.ok ? "that envelope is no longer in the plan" : found.error.message);
		const parent = found.data.item;
		if (parent.status !== POLICY.enums.entryStatus.open || parent.archived === true) return flash(`${parent.id} is not an open envelope`);
		const changing = parent.mode === POLICY.enums.planMode.change;
		const fields = [
			{ id: "text", label: "Action", limit: POLICY.limits.plan.itemChars, value: "" },
			{ id: "doneWhen", label: "Done when", limit: POLICY.limits.plan.itemChars, multiline: true, value: "" },
			...(changing ? [
				{ id: "targets", label: "Targets, one per line", limit: POLICY.limits.plan.itemChars, multiline: true, value: "" },
				{ id: "proof", label: "Required proof", limit: POLICY.limits.plan.proofChars, multiline: true, value: "" },
				{ id: "filesAllowed", label: "File operations allowed", limit: 5, value: "true" },
				{ id: "commandsAllowed", label: "Commands allowed", limit: 5, value: "true" },
				{ id: "networkAllowed", label: "Network allowed", limit: 5, value: "false" },
				{ id: "replies", label: "Reply budget", limit: 1, value: String(POLICY.limits.plan.moveTurns.change) },
				{ id: "fileOps", label: "File-operation budget", limit: 1, value: String(POLICY.limits.plan.moveBudget.fileOps) },
				{ id: "commandStarts", label: "Command-start budget", limit: 1, value: String(POLICY.limits.plan.moveBudget.commandStarts) },
			] : [{ id: "proof", label: "Proof, if needed", limit: POLICY.limits.plan.proofChars, multiline: true, value: "" }]),
		];
		const handle = tui.showOverlay(new Box({
			title: `new move under ${parent.id}`,
			fields,
			keyOf,
			flash,
			close: () => handle.hide(),
			save: (drafts) => {
				const said = (key) => drafts.get(key) ?? "";
				const number = (key) => {
					const raw = said(key).trim();
					return /^\d+$/.test(raw) ? Number(raw) : raw;
				};
				return workspace.execute(WORKSPACE_ACTION.addMove, {
					parent: parent.id,
					text: said("text"),
					doneWhen: said("doneWhen"),
					...(changing ? {
						targets: said("targets").split(/[\n,]/).map((path) => path.trim()).filter((path) => path !== ""),
						proof: said("proof"),
						capabilities: { files: boolOf(said("filesAllowed")), commands: boolOf(said("commandsAllowed")), network: boolOf(said("networkAllowed")) },
						budget: { replies: number("replies"), fileOps: number("fileOps"), commandStarts: number("commandStarts") },
					} : said("proof").trim() !== "" ? { proof: said("proof") } : {}),
				}).then((result) => presentWorkspaceResult(result, "carto.plan"));
			},
			redraw: draw,
		}), { width: boxWidth(fields, terminal.columns), anchor: "center" });
	};
	/** The $EDITOR on the file of the row, or on the whole book by the row's line: the door Ctrl-O keeps open everywhere. */
	const editTarget = async () => {
		const item = pageOf().list.selected();
		const target = item?.target ?? (fileOf(viewId()) !== undefined ? { file: fileOf(viewId()) } : undefined);
		if (target === undefined) return flash("this line has no file to open");
		if (target.folder) return flash("that is a folder: open it with Enter, and press e on a file");
		if (!(await pathExists(target.file))) return flash(`${relative(root, target.file)} does not exist`);
		if (!(await runEditor(target.file, target.line))) return;
		invalidateBrain();
		refresh(viewId(), true);
	};
	const edit = async () => {
		if (chatTab()) return editChat();
		if (state.tab === "context" || viewId() === "carto.hands") return editCurrent();
		if (BOOK_VIEWS[viewId()] !== undefined) {
			const item = pageOf().list.selected();
			const rowKey = typeof item?.key === "string" ? item.key : undefined;
			if (rowKey !== undefined && ROW_KEY.test(rowKey)) return void openFieldBox(viewId(), rowKey);
			// Not an entry (the book could not be read, or it is empty): the editor door is what is left.
			return editTarget();
		}
		return editTarget();
	};
	/** E, or Ctrl-O in any tab and mode: the $EDITOR door — the entry's own JSON, or the add template on a line that is no entry. */
	const editInEditor = async () => {
		if (chatTab()) return editChat();
		if (state.tab === "context" || viewId() === "carto.hands") return editCurrent();
		const book = BOOK_VIEWS[viewId()];
		if (book !== undefined) {
			const item = pageOf().list.selected();
			const rowKey = typeof item?.key === "string" ? item.key : undefined;
			if (rowKey === undefined || !ROW_KEY.test(rowKey)) return newEntry(book);
		}
		return editTarget();
	};

	// ─── Selecting in Chat ───────────────────────────────────────────────────
	// A stop is what one press of j or k moves over: a message, a run's line, one call with what it returned.
	const stopOf = (line) => (line?.item === undefined || line.spans.length === 0 ? undefined : `${line.item}:${line.row ?? ""}:${line.kind === "detail" ? "call" : line.kind}`);
	const stops = () => {
		const seen = [];
		for (const [index, line] of chatBody.lines().entries()) {
			const stop = stopOf(line);
			if (stop !== undefined && seen.at(-1)?.stop !== stop) seen.push({ stop, index });
		}
		return seen;
	};
	const selectedRow = () => (state.selected === undefined ? -1 : chatBody.lines().findIndex((line) => stopOf(line) === state.selected));
	const showStop = (next) => {
		state.selected = next.stop;
		reveal(chatScroll, next.index + chatBody.leadNow());
	};
	/**
	 * Change what Chat shows without the window moving: Chat follows its end, and would slide when something
	 * above the end opens. The window is held where it is, the change is made, and the selection is shown.
	 */
	const inPlace = (change) => {
		chatScroll.scrollTo(chatScroll.scrollTop, { disableFollow: true });
		change();
		reveal(chatScroll, selectedRow() + chatBody.leadNow());
	};
	/** The shared chat model shown in Chat's Conversation, Work, or isolated Consult subtab. */
	const chatProjection = () => (state.view.chat === "work" ? "work" : state.view.chat === "consult" ? "consult" : "talk");
	const moveSelection = (by) => {
		const all = stops();
		if (all.length === 0) return;
		let at = all.findIndex(({ stop }) => stop === state.selected);
		// Scrolled away from the selection, the keys start from what is in view.
		const row = at === -1 ? -1 : all[at].index;
		const [top, rows] = [chatScroll.scrollTop - chatBody.leadNow(), chatScroll.viewportHeight];
		if (rows > 0 && (row < top || row >= top + rows)) {
			const inView = all.filter(({ index }) => index >= top && index < top + rows);
			if (inView.length > 0) return void showStop(by > 0 ? inView[0] : inView.at(-1));
			at = -1;
		}
		showStop(at === -1 ? all.at(-1) : all[Math.max(0, Math.min(all.length - 1, at + by))]);
	};
	/** Open or fold what is selected in Chat; `to` forces one of the two. With `jump`, a call goes to its tab. */
	const activate = ({ to, jump = false } = {}) => {
		const line = chatBody.lines()[selectedRow()];
		if (line === undefined) return;
		if (line.kind === "live") return void inPlace(() => chat.toggleLive(line.liveDepth, to));
		else if (line.kind === "group" || line.kind === "block" || line.kind === "consult") inPlace(() => chat.toggle(line.item, to));
		else if (line.kind === "consult-event") inPlace(() => chat.toggleRow(line.item, line.row, to));
		else if (line.kind === "call" || line.kind === "note" || line.kind === "reasoning" || line.kind === "detail") {
			const item = chat.items.find((entry) => entry.key === line.item);
			const row = item?.rows?.[line.row];
			const home = row?.kind === "call" ? homeOf(row.name, row.args) : undefined;
			// Work that lives in a tab is shown there; anything else opens where it stands.
			if (jump && home !== undefined && line.kind === "call" && !row.open && row.state !== "failed") {
				if (home.view !== undefined) state.view[home.tab] = home.view;
				if (home.tab === "diff") state.view.diff = "last";
				return void setTab(home.tab);
			}
			inPlace(() => chat.toggleRow(line.item, line.row, to));
		}
	};
	const copySelected = () => {
		if (!chatTab()) {
			const { list } = pageOf();
			const item = list.selected();
			if (item === undefined) return copyTab();
			return copy(list.copyOf(item), viewId().replace(".", "-"), "the selected item", "txt");
		}
		const line = chatBody.lines()[selectedRow()];
		if (line === undefined) return flash("nothing is selected: j and k select");
		copy(chat.textOf(line.item, line.row), "message", line.kind === "consult" ? "that consultation" : line.kind === "consult-event" ? "that consultation activity" : line.kind === "call" || line.kind === "detail" ? "that call and its result" : line.kind === "group" ? "that run of calls" : line.kind === "live" ? "that live reasoning" : "that message");
	};

	// ─── The commands mode ───────────────────────────────────────────────────
	const showKeys = () => {
		if (tui.hasOverlay()) return;
		const sheet = new Sheet({ title: "Keys", text: KEYS_HELP, rows: () => terminal.rows, keyOf, close: () => handle.hide() });
		const handle = tui.showOverlay(sheet, { width: Math.max(20, Math.min(108, terminal.columns - 4)), anchor: "center" });
	};
	/** One command, by the name of its key (src/screen/keys.mjs). */
	const command = (key) => {
		const inChat = chatTab();
		const page = inChat ? undefined : pageOf();
		const list = page?.list;
		const scroll = scrollOf();
		const half = Math.max(1, Math.floor(scroll.viewportHeight / 2));
		const full = Math.max(1, scroll.viewportHeight - 2);
		// The second key of a command of two.
		if (state.pending === "z") {
			state.pending = "";
			const second = { R: "+", M: "-", o: "l", c: "h", a: "enter" }[key];
			return second === undefined ? undefined : command(second);
		}
		if (key === "z") return void (state.pending = "z");
		// The rows of the views outside Talk and Work use the current record's own operations: f folds a report,
		// v archives a row out of what the agent reads, d deletes it for good, t settles it, and x unshelves a file.
		// They stand on a report or shelved file in Current shared brain, a graph node, a ledger entry, a plan envelope
		// or move, or a request. Model rows are frozen or prospective and have no mutable-record action.
		if (!inChat) {
			const item = pageOf().list.selected();
			const rowKey = typeof item?.key === "string" ? item.key : undefined;
			const bookId = rowKey !== undefined && /^[a-z]+:/.test(rowKey) ? rowKey.slice(rowKey.indexOf(":") + 1) : undefined;
			const deletable = rowKey !== undefined && /^(?:report|entry|item|envelope|move|node|request):/.test(rowKey);
			if (key === "f" && rowKey !== undefined && rowKey.startsWith("report:")) return void runWorkspaceAction(WORKSPACE_ACTION.toggleFold, { id: bookId });
			if (key === "v" && rowKey !== undefined && /^(?:report|entry|item|envelope|move|node):/.test(rowKey)) return void runWorkspaceAction(item.archived === true ? WORKSPACE_ACTION.unarchive : WORKSPACE_ACTION.archive, { id: bookId });
			if (key === "t" && rowKey !== undefined && /^(?:report|entry|item|envelope|move|node):/.test(rowKey)) return void settleWorkspaceRow(rowKey, bookId);
			if (key === "x" && rowKey !== undefined && rowKey.startsWith("shelf:")) return void runWorkspaceAction(WORKSPACE_ACTION.unshelve, { id: bookId });
			// Deleting is for good, so it asks twice: the first d arms it, the second, soon after, carries it out.
			// A request is not deleted but forgotten: the agent is told nothing of it, and so forgets it had asked.
			if (key === "d" && deletable) {
				if (state.deleteArm?.id === rowKey && Date.now() - state.deleteArm.at < POLICY.timing.screen.deleteConfirmMs) {
					state.deleteArm = undefined;
					return void runWorkspaceAction(WORKSPACE_ACTION.delete, { id: bookId }, {
						confirmation: { actionId: WORKSPACE_ACTION.delete, target: bookId, acknowledged: true },
					});
				}
				state.deleteArm = { id: rowKey, at: Date.now() };
				flash(viewId() === "carto.requests" ? `Press d again: ${bookId} is forgotten` : `Press d again: ${bookId} goes for good`);
				return;
			}
			if (key === "d" && rowKey !== undefined && rowKey.startsWith("shelf:")) return flash("a shelved file is not deleted: x takes it off the shelf");
			// A request is approved or turned down the way the commands do it, so that the agent is told what changed.
			if (viewId() === "carto.requests" && rowKey !== undefined && rowKey.startsWith("request:")) {
				if (key === "a") {
					if (QUESTION_ID.test(bookId)) return flash("a question is answered with words: /answer " + bookId + " words");
					setMode("type");
					return void submit(`/approve ${bookId}`);
				}
				if (key === "n") {
					setMode("type");
					return void submit(`/deny ${bookId}`);
				}
			}
			// In Plan, n on an envelope declares one child move; elsewhere it opens the book's new-entry box.
			if (key === "n" && viewId() === "carto.plan" && rowKey?.startsWith("envelope:")) return void openMoveBox(bookId);
			if (key === "n" && BOOK_VIEWS[viewId()] !== undefined) return void openAddBox(BOOK_VIEWS[viewId()]);
			// In Current shared brain, a puts /shelve in the prompt: shelving names a file, and the file is yours to name.
			if (key === "a" && viewId() === "carto.hands") {
				setMode("type");
				prompt.insertTextAtCursor("/shelve ");
				return;
			}
		}
		if (key === "escape" || key === "i" || key === "a") return void setMode("type");
		// As in vi: a colon starts a command, a slash a search.
		if (key === ":") {
			setMode("type");
			if (prompt.getText() === "") prompt.insertTextAtCursor("/");
			return;
		}
		if (key === "/") return void terminal.press?.(SEARCH_KEY);
		if (/^[1-5]$/.test(key)) return void setTab(TABS[Number(key) - 1].id);
		if (key === "?") return void showKeys();
		if (key === "]" || key === "L") return void stepView(1);
		if (key === "[" || key === "H") return void stepView(-1);
		if (key === "y") return void copySelected();
		if (key === "Y") return void copyTab();
		if (key === "e") return void edit();
		if (key === "E") return void editInEditor();
		if (key === "r") {
			invalidateBrain();
			refresh(viewId(), true);
			return void flash("read again");
		}
		if (key === "ctrl+d") return void scroll.scrollBy(half);
		if (key === "ctrl+u") return void scroll.scrollBy(-half);
		if (key === "ctrl+f") return void scroll.scrollBy(full);
		if (key === "ctrl+b") return void scroll.scrollBy(-full);
		if (key === "ctrl+e") return void scroll.scrollBy(1);
		if (key === "ctrl+y") return void scroll.scrollBy(-1);
		if (inChat) {
			if (key === "d") return void removeChat();
			if (key === "j" || key === "down") return void moveSelection(1);
			if (key === "k" || key === "up") return void moveSelection(-1);
			if (key === "g" || key === "home") return void (stops().length > 0 && showStop(stops()[0]));
			if (key === "G" || key === "end") {
				if (stops().length > 0) state.selected = stops().at(-1).stop;
				return void chatScroll.scrollToEnd();
			}
			if (key === "enter" || key === " " || key === "o") return void activate({ jump: true });
			if (key === "l" || key === "right") return void activate({ to: true });
			if (key === "h" || key === "left") return void activate({ to: false });
			if (key === "+") return void inPlace(() => chat.setAll(true));
			if (key === "-") return void inPlace(() => chat.setAll(false));
			// A key that is no command says so, once it is a key that types: the screen heard it.
			if (key !== undefined && [...key].length === 1) flash(`${key === " " ? "Space" : key} is not a command · ? lists them`);
			return;
		}
		// In Shells: Enter opens the selected window's output as a terminal emulator sees it, and goes back.
		if (state.tab === "shells" && (key === "enter" || key === " " || key === "o")) {
			if (state.view.shells === "out") return void setView("list");
			const item = pageOf().list.selected();
			if (typeof item?.key === "string" && item.key.startsWith("window:")) {
				state.shell = item.key.slice(7);
				setView("out");
			}
			return;
		}
		const cols = innerCols();
		const show = () => reveal(page.scroll, list.selectedRow(cols), { header: list.headerRows() });
		// Scrolled away from the selection, the keys act on what is in view.
		const anchor = () => list.selectVisible(cols, page.scroll.scrollTop, page.scroll.viewportHeight);
		if (key === "j" || key === "down") {
			// A tab with nothing to select is scrolled instead.
			if (!anchor() && !list.move(1)) page.scroll.scrollBy(1);
			return void show();
		}
		if (key === "k" || key === "up") {
			if (!anchor() && !list.move(-1)) page.scroll.scrollBy(-1);
			return void show();
		}
		if (key === "g" || key === "home") {
			list.first();
			return void page.scroll.scrollToStart();
		}
		if (key === "G" || key === "end") {
			list.last();
			rebuild();
			return void page.scroll.scrollToEnd();
		}
		const toggle = (to) => {
			anchor();
			if (!list.toggle(undefined, to) && to === undefined) flash("nothing more to show for this line");
			rebuild();
			show();
		};
		if (key === "enter" || key === " " || key === "o") return void toggle(undefined);
		if (key === "l" || key === "right") return void toggle(true);
		if (key === "h" || key === "left") return void toggle(false);
		if (key === "+") {
			list.openAll();
			rebuild();
			return void show();
		}
		if (key === "-") {
			list.foldAll();
			list.first();
			rebuild();
			return void page.scroll.scrollToStart();
		}
		if (key !== undefined && [...key].length === 1) flash(`${key === " " ? "Space" : key} is not a command · ? lists them`);
	};
	/** What has the keys in the commands mode: a part that shows nothing. */
	const commands = {
		render: () => [],
		invalidate() {},
		handleInput(data) {
			if (state.closed) return;
			try {
				command(keyOf(data));
			} catch (error) {
				chat.print(`! ${error?.message ?? error}\n`);
			}
			draw();
		},
	};

	// ─── The parts, and how they are laid out ───────────────────────────────
	const ui = {
		state,
		chat,
		chatProjection,
		tabs: TABS,
		themeVersion: () => themeVersion,
		chatRows: () => chatScroll.viewportHeight,
		stopOf,
		setTab,
		setView,
		setMode,
		status,
		views: () => VIEWS[state.tab] ?? [],
		view: () => state.view[state.tab],
		fileHint() {
			if (state.tab === "context") return undefined;
			const item = pageOf()?.list.selected();
			const file = item?.target?.file ?? item?.path ?? fileOf(viewId());
			if (file === undefined) return undefined;
			const rel = relative(root, file) || ".";
			// Where e opens the small box on the row's fields (said in the strip below), the editor is E; anywhere else, e is the editor.
			const rowKey = typeof item?.key === "string" ? item.key : undefined;
			const smallBox = BOOK_VIEWS[viewId()] !== undefined && rowKey !== undefined && ROW_KEY.test(rowKey);
			return smallBox ? `E opens ${rel}` : `e opens ${rel}`;
		},
		/** A click on a row of Chat: select it, and open or fold it. */
		clickChat(row) {
			state.selected = stopOf(chatBody.lines()[row]);
			if (state.selected !== undefined) activate({ jump: true });
			draw();
		},
		clickList(list, row) {
			const page = pageOf();
			const key = list.keyAtRow(innerCols(), row);
			if (key === undefined) return;
			list.select(key);
			list.toggle(key);
			rebuild();
			draw();
		},
		/** The line the place to type shows in the commands mode. */
		commandLine() {
			const question = session.asks?.pending();
			const typed = prompt.getText();
			const draft = typed === "" ? "" : `   (typed so far: ${cut(typed.replace(/\n/g, " ⏎ "), POLICY.limits.screen.typedDraftChars)})`;
			let hint = "Esc or i to write";
			if (question !== undefined) hint = "the agent waits for your answer: Esc, then type it";
			if (state.pending !== "") hint = `${state.pending}…`;
			return [[" COMMAND MODE ", "chip"], [`  ${hint}`, question !== undefined ? "warn" : "muted"], [draft, "faint"]];
		},
		prompt() {
			const question = session.asks?.pending();
			if (question !== undefined) return { text: "Answer › ", style: "warn bold" };
			// Keep the terminal core's safety marks at the place someone acts, but give the words a stable human role
			// rather than a bare glyph. The strip repeats the broader state; this is the immediate composition cue.
			const marks = state.prompt.replace(/\s*›\s*$/, "").trim();
			const task = session.activeTask?.() !== undefined && core.busy();
			const role = task ? "Task" : "You";
			if (marks !== "") return { text: `${marks} ${role} › `, style: "warn bold" };
			if (task) return { text: "Task › ", style: "tool bold" };
			return { text: "You › ", style: "user bold" };
		},
		placeholder: () => {
			if (session.asks?.pending() !== undefined) return "Write the answer";
			if (core.busy()) return "Message the agent while it works · Esc for commands";
			return "Message Cartographer, or /help · Esc for commands";
		},
	};
	const chatBody = new ChatBody(ui);
	const scrollbar = { scrollbar: "auto", scrollbarTrackStyle: (text) => `${sgr("faint")}${text}\x1b[39m`, scrollbarThumbStyle: (text) => `${sgr("muted")}${text}\x1b[39m` };
	const chatScroll = new ScrollView(chatBody, { follow: "end", primary: true, ...scrollbar });
	for (const id of PAGES) {
		const list = createList();
		const body = new ListBody(ui, list);
		pages.set(id, { list, body, scroll: new ScrollView(body, { follow: "none", primary: true, ...scrollbar }), at: 0, text: undefined });
	}
	// (Each switches off only what it switched on, so the background of the list holds under it.)
	const paint = (style) => (text) => `${sgr(style)}${text}\x1b[22;39m`;
	const prompt = new Prompt(tui, { borderColor: (text) => text, selectList: { selectedPrefix: paint("user"), selectedText: paint("user bold"), description: paint("faint"), scrollInfo: paint("faint"), noMatch: paint("faint") } }, ui);
	prompt.onSubmit = (text) => {
		try {
			submit(text);
		} catch (error) {
			chat.print(`! ${error?.message ?? error}\n`);
		}
	};
	/** Command completion uses the same cached shell projection as the view; it never probes the live window manager from a key handler. */
	const windowNames = () => (projectionFor("shells.list").data?.windows ?? []).filter((win) => win.state !== POLICY.enums.windowStates.gone).map((win) => win.name);
	prompt.setAutocompleteProvider(
		new CombinedAutocompleteProvider(
			COMMANDS.map(([name, description, words]) => ({
				name,
				description,
				...(words !== undefined
					? {
							getArgumentCompletions: (prefix) => {
								const all = name === "kill" ? [...windowNames(), ...words] : words;
								const fits = all.filter((word) => word.startsWith(prefix.trim()));
								return fits.length === 0 ? null : fits.map((word) => ({ value: word, label: word }));
							},
						}
					: {}),
			})),
			root,
			fileSearch ?? null,
		),
	);
	const full = { basis: 0, grow: 1, minSize: 1 };
	const airy = ({ height }) => height >= AIRY_ROWS;
	tui.setLayoutRoot(
		new VStack([
			new TabBar(ui),
			{ component: new ViewBar(ui), visible: () => VIEWS[state.tab] !== undefined },
			{ component: new Air(), visible: airy },
			{ component: chatScroll, ...full, visible: () => chatTab() },
			...PAGES.map((id) => ({ component: pages.get(id).scroll, ...full, visible: () => !chatTab() && viewId() === id })),
			{ component: new Air(), visible: airy },
			new Strip(ui),
			{ component: prompt, basis: "auto" },
			commands,
		]),
	);

	// ─── Keys that are not the editor's and not a command ───────────────────
	// What the terminal read, before pi-tui cuts it into keys: for text pasted without being marked as pasted.
	const pasted = createPasteWatch();
	const watchInput = (chunk) => pasted.read(chunk);
	/** The keys the commands mode takes that the editor has no use for with Alt held. */
	const AFTER_ESCAPE = new Set([..."12345jkgGhloeYriazR+-[]HL?/: "]);
	tui.addInputListener((data) => {
		if (state.closed || isKeyRelease(data)) return undefined;
		// A sheet lies over the screen: the keys are its own.
		if (tui.hasOverlay()) return undefined;
		// What is pasted is text for the agent, whatever the mode was: it is typed, and not sent.
		if (isPaste(data)) {
			if (state.mode !== "type") setMode("type");
			return undefined;
		}
		if (state.mode === "type") {
			const end = pasted.lineEnd(data);
			if (end === "skip") return { consume: true };
			if (end === "break") {
				prompt.insertTextAtCursor("\n");
				draw();
				return { consume: true };
			}
		}
		const key = keyOf(data);
		const done = { consume: true };
		if (key === "ctrl+c") {
			// Bash-like: first Ctrl-C clears what is typed. With the line standing empty, the terminal core hears
			// it, and a second Ctrl-C soon after leaves the way /quit does.
			if (prompt.getText() !== "") {
				prompt.setText("");
				return done;
			}
			reader.emit("SIGINT");
		}
		else if (key === "ctrl+x") keys.emit("keypress", "", { ctrl: true, name: "x" });
		else if (key === "ctrl+v") keys.emit("keypress", "", { ctrl: true, name: "v" });
		else if (key === "ctrl+t") keys.emit("keypress", "", { ctrl: true, name: "t" });
		else if (key === "ctrl+l") tui.requestRender(true);
		else if (key === "ctrl+o") editInEditor();
		else if (key === "f1") showKeys();
		else if (key === "shift+tab") stepTab(-1);
		// While something is typed, Tab completes it; otherwise it goes to the next tab.
		else if (key === "tab" && (state.mode === "command" || (prompt.getText() === "" && !prompt.isShowingAutocomplete()))) stepTab(1);
		else if (key === "escape" && state.mode === "type" && !prompt.isShowingAutocomplete()) setMode("command");
		// Enter on a command whose last word is being completed: the editor takes the completion and would wait
		// for a second Enter. A command is sent with one.
		else if (key === "enter" && state.mode === "type" && prompt.isShowingAutocomplete() && /^\/\S+\s/.test(prompt.getText()) && !prompt.getText().includes("\n")) {
			prompt.handleInput(data);
			if (!prompt.isShowingAutocomplete()) prompt.handleInput(data);
		}
		// Escape and then a key, so close together that the terminal took them for Alt and that key (tmux holds
		// Escape back for a moment to see what follows): the two keys, one after the other.
		else if (state.mode === "type" && key?.startsWith("alt+") && AFTER_ESCAPE.has(key.slice(4)) && !prompt.isShowingAutocomplete()) {
			setMode("command");
			command(key.slice(4));
		} else return undefined;
		draw();
		return done;
	});

	// ─── The clock ───────────────────────────────────────────────────────────
	// Elapsed times, the rate, the spinner, and the tabs that are read again. pi-tui writes only the rows that
	// differ, so a frame in which nothing moved costs nothing.
	let lastFrame = 0;
	const tick = setInterval(() => {
		if (state.closed) return;
		measure();
		syncThinking();
		if (!chatTab()) refresh();
		else if (state.view.chat === "consult") refresh("chat.consult");
		// Shell names and activity are also a status/completion source. Keep their deferred snapshot warm without
		// ever asking the live process manager from rendering or a key handler.
		if (viewId() !== "shells.list") refresh("shells.list");
		// The window of the conversation has another height than the one it was last drawn for (the screen was
		// resized, or what is typed grew): it is drawn again.
		else if (chatBody.rows !== chatScroll.viewportHeight) draw();
		refreshWakeProjection();
		const busy = core.busy();
		if (Date.now() - lastFrame >= (busy ? SPIN_MS : POLICY.timing.screen.idleFrameMs)) {
			lastFrame = Date.now();
			draw();
		}
	}, SPIN_MS);

	let stopped = false;
	const stop = ({ farewell = false } = {}) => {
		if (stopped) return;
		stopped = true;
		stopApplicationEvents();
		referenceLabels.dispose();
		for (const id of projections.keys()) cancelProjection(id);
		cancelConsultProjection();
		clearInterval(tick);
		process.stdin.off("data", watchInput);
		// What stays on the terminal: the conversation, as it stood. A process that is going down in a hurry
		// leaves only the screen it found.
		try {
			if (farewell) tui.setLayoutRoot(new Farewell(ui));
			tui.stop(farewell ? {} : { preserveScreen: true });
		} catch {
			// The terminal is gone, or was never ours.
		}
	};
	const onExit = () => stop();
	process.once("exit", onExit);
	process.stdin.on("data", watchInput);
	tui.start();
	refreshWakeProjection(true);
	terminal.setTitle(`carto · ${basename(root)}`);
	tui.setFocus(prompt);
	askColors();
	// A terminal that tells when its colours change (the desktop went from light to dark) is asked again then.
	tui.setTerminalColorSchemeNotifications(true);
	tui.onTerminalColorSchemeChange(() => askColors());
	try {
		return await runTerminal(session, { ...options, application, interactive: true, screen });
	} finally {
		state.closed = true;
		stop({ farewell: true });
		applyTheme(undefined);
		process.off("exit", onExit);
	}
}
