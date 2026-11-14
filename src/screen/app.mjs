// The full screen: tabs, a status strip that is always there, and a place to type.
//
//   1 Chat     the conversation; the agent's work folded into pointers (src/screen/chat.mjs)
//   2 Carto    the agent's brain: Atlas, Ledger, Plan, Tree, Assessment, one at a time
//   3 Diff     what was changed: by the last step, in this session, or against the project's own git HEAD
//   4 Shells   the shell windows, live
//   5 Context  what the agent sees: the request it was last sent, part by part, each of which opens
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
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter, join, relative } from "node:path";
import { CombinedAutocompleteProvider, KeybindingsManager, Markdown, ProcessTerminal, ScrollView, setKeybindings, TUI_KEYBINDINGS, TuiAltScreen, visibleWidth, VStack } from "@earendil-works/pi-tui";
import { contextPath, forgetChat, loadContext, reviseNote, shelveForUser } from "../context.mjs";
import { archiveRow, dropRow, foldRow, unarchiveRow, unshelveRow } from "../ops.mjs";
import { CORE_DIR } from "../config.mjs";
import { assessmentPath } from "../assessment.mjs";
import { atlasPath } from "../atlas.mjs";
import { booksPath } from "../books.mjs";
import { loadLedger, open as openEntries } from "../ledger.mjs";
import { isAuthorized, loadPlan, openItems, planPath } from "../plan.mjs";
import { listRequests } from "../requests.mjs";
import { stamp } from "../time.mjs";
import { createChat, homeOf } from "./chat.mjs";
import { copyOut, selectionText, toClipboard } from "./copy.mjs";
import { createPasteWatch, isKeyRelease, isPaste, keyOf } from "./keys.mjs";
import { createList } from "./list.mjs";
import { Air, AIRY_ROWS, ChatBody, Farewell, ListBody, marginOf, Prompt, Sheet, Strip, TabBar, ViewBar } from "./parts.mjs";
import { applyTheme, bar, cut, sgr, short, span } from "./text.mjs";
import { colorMode, makeTheme, markdownTheme, schemeFromEnv } from "./theme.mjs";
import { atlasView, booksView, contextView, diffView, editorCommand, handsView, ledgerView, planView, promptsSource, requestsView, shellsOutView, shellsView, textView, toolSource, treeView } from "./views.mjs";

export const TABS = [
	{ id: "chat", name: "Chat" },
	{ id: "carto", name: "Carto" },
	{ id: "diff", name: "Diff" },
	{ id: "shells", name: "Shells" },
	{ id: "context", name: "Context" },
];
/** The views inside a tab; [ and ] go from one to the next. */
const VIEWS = {
	carto: [
		{ id: "atlas", name: "Atlas" },
		{ id: "ledger", name: "Ledger" },
		{ id: "plan", name: "Plan" },
		{ id: "requests", name: "Requests" },
		{ id: "tree", name: "Tree" },
		{ id: "books", name: "Books" },
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
		{ id: "window", name: "Window" },
		{ id: "main", name: "Main agent" },
		{ id: "parts", name: "Parts" },
		{ id: "hands", name: "Hands" },
	],
};
/** Every view of every tab but Chat, by the name it is kept under. */
const PAGES = ["carto.atlas", "carto.ledger", "carto.plan", "carto.requests", "carto.tree", "carto.books", "diff.last", "diff.session", "diff.git", "shells.list", "shells.out", "context.window", "context.main", "context.parts", "context.hands"];
/** How often a view is read again while it shows, in milliseconds. */
const EVERY = { carto: 2000, diff: 5000, shells: 700, context: 700 };
/** The marks of the spinner that turns while the agent works, and how long each stands. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPIN_MS = 80;

/** The commands that are typed and sent, for the list that opens when a line starts with a slash. */
const COMMANDS = [
	["requests", "what waits for you: change items, questions of taste, changes to the agent's prompt"],
	["approve", "approve requests by id, or the whole plan as it stands"],
	["deny", "turn a request down: /deny ID [why]"],
	["answer", "answer a question of taste: /answer ID words"],
	["plan", "the plan, whether it is authorized, and where the file is"],
	["ledger", "goals, questions and notes, open and closed"],
	["atlas", "the tree as the agent sees it, and the graph's nodes"],
	["assessment", "the agent's summary of the project"],
	["practice", "the agent's notes on how it works"],
	["prompt", "the agent's approved changes to its own prompt"],
	["diff", "what the last change task did to the files", ["all"]],
	["undo", "take the last change task back; again for the one before it"],
	["report", "the last task's report in full; /report t12 shows a kept one"],
	["stop", "stop what the agent is doing (Ctrl-X); shell windows keep running"],
	["pause", "hold everything new back from the agent while it finishes (Ctrl-V)"],
	["copy", "the agent's last message; or: session, report, tab", ["session", "report", "tab"]],
	["model", "the models the server serves; /model NAME (or a number) switches to one"],
	["context", "what the agent's context holds, and when it is next collapsed"],
	["fold", "take a kept report out of the context's view, leaving its one line"],
	["archive", "take a row out of what the agent reads: a report, a ledger entry, a plan item, a node"],
	["unarchive", "bring an archived row back into what the agent reads"],
	["delete", "a row is gone for good, and the agent is not told: a report, a ledger entry, a plan item, a proposal, a node"],
	["recall", "bring a kept report back into view in full"],
	["shelve", "keep a file in view from the next collapse on: /shelve PATH [lines]"],
	["unshelve", "take a shelved file off the shelf, or all of them"],
	["send", "type a line into a shell window: /send NAME line"],
	["collapse", "collapse the context now"],
	["new", "start a fresh context with nothing kept in view"],
	["pin", "rewrite the copy of assessment and graph at the top of the context"],
	["yolo", "let change items run without /approve while you watch", ["on", "off"]],
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
	"  Esc goes from one to the other, and the bottom of the screen shows which you are in.",
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
	"  1 to 5           go to a tab",
	"  [ and ]          the previous and the next view inside Carto, Diff and Context (H and L do the same)",
	"  j, k             move down and up over the items; g and G go to the first and the last",
	"  Enter, Space, o  open what is selected, or fold it; l opens, h folds. In Chat, Enter on a call goes to the tab where that work lives. In Shells, Enter on a window shows its output as a terminal emulator does (Enter goes back)",
	"  + and -          open everything, fold everything (zR and zM do the same)",
	"  Ctrl-D, Ctrl-U   scroll half a page; Ctrl-F and Ctrl-B a page; Ctrl-E and Ctrl-Y a row",
	"  /                search the tab that shows; Enter or Down goes to the next match, Up to the one before, Esc closes the search",
	"  e                open what is selected in $EDITOR: a file of the tree, a changed file at its first change, a ledger entry, a plan item or a node where it stands in its file; in Chat, a message of the user or the agent (tool work cannot be edited); in Context, the system prompt's prompt.json, a tool where it is defined, a shelved file",
	"  f, v, d, x       the same keys on a row of any view but Chat: f folds a report out of view or brings it back (in Hands); v archives a row out of what the agent reads — a report, a ledger entry, a plan item, a node of the graph — or brings it back; d deletes it for good (d again), and in Requests forgets it without a word to the agent; in the Context window d takes a message of yours or the agent's out of the talk the collapse keeps; x takes a shelved file off the shelf (in Hands)",
	"  a                in Hands, shelve a file (puts /shelve in the prompt); in Requests, approve the request",
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
	"  Ctrl-X           stop the agent; Ctrl-V pauses it: it finishes what it is doing and gets nothing new",
	"  Ctrl-L           draw the screen again",
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
	"  Each goes to the clipboard and to a file under .atlas/export/.",
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

/** The program `name` on the PATH, or undefined. */
function onPath(name) {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir === "") continue;
		try {
			accessSync(join(dir, name), constants.X_OK);
			return join(dir, name);
		} catch {
			// Not here.
		}
	}
	return undefined;
}

/**
 * Run carto in the full screen.
 * @param {any} session
 * @param {any} options  what runTerminal takes, plus `intro`: lines printed before the screen opened
 * @param {(session: any, options: any) => Promise<number>} runTerminal
 */
export async function runScreen(session, options, runTerminal) {
	const { root, brainDir, config = {} } = options;
	const coreDir = options.coreDir ?? CORE_DIR;
	const started = Date.now();
	/** What the terminal core lets the screen ask (src/terminal.mjs, `ui.attach`). */
	let core = { busy: () => false, paused: () => false, thinking: () => true, contextSize: () => undefined, capture: async () => "" };

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
		wheelScrollLines: 3,
		// What is selected with the mouse is copied when the button is let go, every way there is.
		copySelection: async (text) => (toClipboard(selectionText(text), { write: (sequence) => terminal.write(sequence) }).length > 0 ? true : "no way to the clipboard was found"),
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
	const chat = createChat({ markdown });
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
		tui.queryTerminalColors({ timeoutMs: 500, onLateReply: take }).then(take, () => {});
	};

	const state = {
		tab: "chat",
		view: { carto: "atlas", diff: "last", shells: "list", context: "window" },
		shell: undefined, // the shell window whose output the Output view shows
		deleteArm: undefined, // a report marked for deleting in Hands, waiting for the second d
		mode: "type",
		selected: undefined, // a stop of the Chat tab
		pending: "", // the first key of a command of two (z, then R)
		prompt: "› ",
		busySince: undefined,
		restSince: Date.now(),
		rate: undefined,
		prefill: undefined,
		lastPrefill: undefined,
		closed: false,
	};
	const draw = () => {
		if (!state.closed) tui.requestRender();
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
		if (!state.closed) tui.flash(` ${cut(text, Math.max(16, Math.min(56, terminal.columns - 50)))} `, 4000);
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
		entry(depth, entry, printed) {
			chat.seal();
			chat.entry(depth, entry, printed);
			draw();
		},
		live(depth, message) {
			chat.live(depth, message);
			draw();
		},
		attach(given) {
			core = given;
		},
		notice(text) {
			syncThinking();
			flash(text);
		},
	};
	for (const line of options.intro ?? []) chat.print(`${line}\n`);
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
			if (state.prefill.fresh >= (config.prefillTokens ?? 1000)) state.lastPrefill = { fresh: state.prefill.fresh, ms: state.prefill.ms ?? event.at - event.began, at: event.at };
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
		else if (now - rateMark.at >= 1500) {
			const grown = size - rateMark.size;
			state.rate = grown > 0 ? grown / 4 / ((now - rateMark.at) / 1000) : undefined;
			rateMark = { at: now, size };
		}
	};
	let brain = { at: 0 };
	const readBrain = () => {
		if (Date.now() - brain.at < 1000) return brain;
		const next = { at: Date.now() };
		try {
			const requests = listRequests(brainDir, { yolo: options.gate?.yolo === true });
			next.requests = requests.length;
			next.waits = requests.some((request) => request.kind === "approval");
			const { plan } = loadPlan(brainDir);
			if (plan !== undefined && plan.items.length > 0) {
				const open = openItems(plan).length;
				next.plan = `plan ${plan.items.length - open}/${plan.items.length}${isAuthorized(plan) ? " · approved" : ""}`;
			}
			const { ledger } = loadLedger(brainDir);
			if (ledger !== undefined) {
				const goals = openEntries(ledger, "goal").length;
				next.ledger = goals === 0 ? "no goal" : `${goals === 1 ? "1 goal" : `${goals} goals`}`;
			}
		} catch {
			// A file edited into something unreadable is said by its tab, not by the strip.
		}
		brain = next;
		return brain;
	};
	/** The two rows of the strip, as spans. */
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
			const reading = state.prefill?.phase === "reading" && state.prefill.fresh >= (config.prefillTokens ?? 1000);
			if (reading) {
				const { fresh, done, ms } = state.prefill;
				const rate = ms > 0 ? done / (ms / 1000) : 0;
				const left = rate > 0 ? (fresh - done) / rate : undefined;
				first.push([` · reading ${short(done)} of ${short(fresh)} new ${bar(done / fresh)} ${Math.round((done / fresh) * 100)}%`, "tool"], [`${rate > 0 ? ` · ${Math.round(rate)} tok/s` : ""}${left !== undefined ? ` · writing in ~${Math.max(1, Math.round(left))} s` : ""}`, "muted"]);
			} else if (doing !== undefined) first.push([` · ${doing.what}`, ""]);
			else if (state.prefill?.phase === "sent") first.push([" · waiting for the model", "muted"]);
			first.push([` · ${span(Date.now() - state.busySince)}`, "muted"]);
			if (state.rate !== undefined && !reading) first.push([` · ${state.rate < 10 ? state.rate.toFixed(1) : Math.round(state.rate)} tok/s`, "muted"]);
			if (state.lastPrefill !== undefined && Date.now() - state.lastPrefill.at < 20_000 && !reading) first.push([` · read ${short(state.lastPrefill.fresh)} new in ${span(state.lastPrefill.ms)}`, "muted"]);
		} else first.push(["○ ", "muted"], ["resting", ""], [` · ${span(Date.now() - state.restSince)}`, "muted"]);
		if (core.paused?.()) first.push([" · paused: the agent gets nothing new · /pause or Ctrl-V lets it go on", "warn"]);

		const second = [];
		const size = core.contextSize();
		const windowSize = options.contextWindow;
		second.push([`ctx ${bar((size ?? 0) / windowSize)} ${size === undefined ? "?" : short(size)}/${short(windowSize)}`, size !== undefined && size / windowSize > 0.8 ? "warn" : ""]);
		const { plan, ledger, waits, requests } = readBrain();
		if (ledger !== undefined) second.push([` · ${ledger}`, "muted"]);
		if (plan !== undefined) second.push([` · ${plan}`, waits ? "warn" : "muted"]);
		if (requests > 0) second.push([` · ${requests === 1 ? "1 request" : `${requests} requests`} for you`, waits ? "warn" : "muted"]);
		const windows = (session.windows?.list(0) ?? []).filter((win) => win.state !== "gone");
		if (windows.length > 0) {
			const running = windows.filter((win) => win.state === "busy").length;
			second.push([` · ${windows.length === 1 ? "1 window" : `${windows.length} windows`}${running > 0 ? `, ${running} busy` : ""}`, running > 0 ? "" : "muted"]);
		}
		const wakes = session.wakes?.list() ?? [];
		if (wakes.length > 0) second.push([` · ${wakes.length === 1 ? "1 wake" : `${wakes.length} wakes`}`, "muted"]);
		if (options.gate?.yolo === true) second.push([" · yolo", "warn"]);
		if (options.runner?.mode === "direct") second.push([" · no sandbox", "warn"]);
		if (!core.thinking()) second.push([" · notes hidden", "muted"]);
		return [first, second];
	};

	// ─── The tabs that are lists ─────────────────────────────────────────────
	const viewId = (tab = state.tab) => (VIEWS[tab] !== undefined ? `${tab}.${state.view[tab]}` : tab);
	/** The file a view comes from, for `e` when no item names one. */
	const fileOf = (id) =>
		({
			"carto.atlas": atlasPath(brainDir),
			"carto.ledger": join(brainDir, "carto-ledger.json"),
			"carto.plan": planPath(brainDir),
			"carto.books": booksPath(brainDir),
		})[id];
	const env = { root, brainDir, session, started };
	/** Each view: its list, the part that draws it, and the scroll view the part stands in. */
	const pages = new Map();
	const pageOf = (id = viewId()) => pages.get(id);
	const build = (id, isOpen, cols) => {
		if (id === "carto.atlas") return atlasView(env);
		if (id === "carto.ledger") return ledgerView(env);
		if (id === "carto.plan") return planView({ ...env, yolo: options.gate?.yolo === true });
		if (id === "carto.requests") return requestsView({ brainDir, yolo: options.gate?.yolo === true });
		if (id === "carto.tree") return treeView(env, isOpen);
		if (id === "carto.books") return booksView(env);
		if (id.startsWith("diff.")) return diffView(env, id.slice(5));
		if (id === "shells.list") return shellsView(env);
		if (id === "shells.out") return shellsOutView(env, state.shell);
		if (id === "context.window" || id === "context.main") {
			const sent = session.engine?.window(id === "context.main" ? "main" : "newest");
			return contextView(sent, { windowSize: options.contextWindow, cols, writing: sent === undefined || sent.reply !== undefined ? undefined : chat.liveMessage(sent.task ? 1 : 0), isOpen, edits: messageEdits, deleted: messageDeleted });
		}
		if (id === "context.parts") return textView(pageOf(id).text ?? "  …");
		if (id === "context.hands") return handsView({ root, brainDir });
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
	/** Read a view again. */
	const refresh = (id = viewId(), force = false) => {
		const page = pageOf(id);
		if (page === undefined) return;
		if (!force && Date.now() - page.at < (EVERY[id.split(".")[0]] ?? 2000)) return;
		page.at = Date.now();
		if (id === "context.parts") {
			Promise.resolve(core.capture("/context"))
				.then((text) => {
					const next = String(text ?? "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
					if (next !== page.text) {
						page.text = next;
						rebuild(id);
						draw();
					}
				})
				.catch(() => {});
		}
		const before = page.list.version;
		rebuild(id);
		if (page.list.version !== before) draw();
	};

	// ─── Copying ─────────────────────────────────────────────────────────────
	const copy = (text, name, what, extension = "md") => {
		if (String(text).trim() === "") {
			flash(`nothing to copy: ${what} is empty`);
			return void chat.print(`  Nothing to copy: ${what} is empty.\n`);
		}
		try {
			const done = copyOut(text, { brainDir, name, extension, write: (sequence) => terminal.write(sequence) });
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
	const tabName = () => (state.tab === "chat" ? "the Chat tab" : `the ${TABS.find((tab) => tab.id === state.tab).name} tab${VIEWS[state.tab] ? ` (${VIEWS[state.tab].find((view) => view.id === state.view[state.tab]).name})` : ""}`);
	const copyTab = () => {
		if (state.tab === "chat") return copy(chatBody.lines().map((line) => line.spans.map(([text]) => text).join("")).join("\n"), "chat", tabName(), "txt");
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
	const scrollOf = () => (state.tab === "chat" ? chatScroll : pageOf().scroll);
	const setTab = (id) => {
		if (!TABS.some((tab) => tab.id === id)) return;
		state.tab = id;
		tui.resetTextSelection();
		refresh(viewId(), true);
		draw();
	};
	const stepTab = (by) => setTab(TABS[(TABS.findIndex((tab) => tab.id === state.tab) + by + TABS.length) % TABS.length].id);
	const setView = (id) => {
		if (VIEWS[state.tab] === undefined) return;
		state.view[state.tab] = id;
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
		// What is sent is answered in Chat, at its end.
		if (state.tab !== "chat") setTab("chat");
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
	const lend = (work) => {
		process.stdin.off("data", watchInput);
		tui.stop({ preserveScreen: true });
		try {
			return work();
		} finally {
			process.stdin.on("data", watchInput);
			tui.start();
			tui.setFocus(state.mode === "type" ? prompt : commands);
			tui.requestRender(true);
		}
	};
	/** Hand the terminal to the editor over `file`; false when the editor could not be run. */
	const runEditor = (file, line) => {
		const editor = process.env.VISUAL || process.env.EDITOR || "vi";
		const done = lend(() => spawnSync(editorCommand(editor, file, line), { stdio: "inherit", shell: true }));
		if (done.error !== undefined || (done.status !== 0 && done.status !== null)) {
			const why = done.error?.message ?? `it ended with exit ${done.status}`;
			chat.print(`! The editor could not be run (${editor}): ${why}. Set $EDITOR to the editor you use.\n`);
			flash(`the editor could not be run: ${why}`);
			return false;
		}
		return true;
	};
	/** A file to edit a thing in, under the brain's scratch folder. */
	const scratch = (name, text) => {
		const dir = join(brainDir, "scratch");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, name);
		writeFileSync(file, `${text}\n`);
		return file;
	};
	/** e in the Chat tab: the words of the user and of the agent can be said anew; tool work cannot. */
	const editChat = () => {
		const line = chatBody.lines()[selectedRow()];
		if (line === undefined) return flash("nothing is selected: j and k select");
		if (!chat.editable(line.item)) {
			return flash(line.kind === "console" ? "what Cartographer printed cannot be edited" : "tool work cannot be edited: e opens a message of the user or the agent");
		}
		const item = chat.items.find((entry) => entry.key === line.item);
		const file = scratch("message.md", item.text);
		if (!runEditor(file)) return;
		const now = readFileSync(file, "utf8").replace(/\n+$/, "");
		if (now === item.text || now === "") return flash("the message stands as it was");
		const was = item.text;
		inPlace(() => chat.revise(item.key, now));
		// What the talk keeps is rewritten to match, so what comes after reads the edited words. A note of the
		// agent stands nowhere in the talk, so for one the edit is in the tab only.
		if (item.type !== "note") reviseNote(brainDir, was, now);
		flash(item.type === "user" ? "your message is edited · what follows reads the edited words" : "the agent's words are edited · the talk the context keeps says the same");
	};
	/** e in the Context tab: the system prompt's wording and the tools' descriptions are files of their own. */
	/** What the user has said anew in the editor, by the text it was sent with. The tab shows the new words where the old stood; the sizes stay those of what was sent. */
	const messageEdits = new Map();
	/** What the user has deleted in the Context window, by the text it was sent with: the parts stand out of the list. */
	const messageDeleted = new Set();
	/** A message edited here is also edited in the Chat tab, when it stands there by the same words. */
	const syncChat = (base, now, type) => {
		const item = chat.items.findLast((entry) => (type === undefined || entry.type === type) && entry.text === base);
		if (item !== undefined) chat.revise(item.key, now);
	};
	/** The Context tab's messages: surgery on what shows and on the talk the collapse keeps; the stored conversation is never rewritten. */
	const editMessage = (item) => {
		const full = item.copy ?? item.body;
		if (typeof full !== "string" || full === "") return flash("nothing to edit here");
		// A message of yours was sent with a stamp of its own; the words are what stands without it, and that is what is edited.
		let base = full;
		let suffix = "";
		if (item.editKind === "chat-you") {
			const found = /\n\n\[(?:sent|noted) [^\]]*\]$/.exec(full);
			if (found !== null) {
				suffix = found[0];
				base = full.slice(0, found.index);
			}
		}
		// What the agent said to you, where the part is its words: the saying is edited, not the rendering of the call.
		if (typeof item.chat === "string") base = item.chat;
		const file = scratch("message.md", base);
		if (!runEditor(file)) return;
		const now = readFileSync(file, "utf8").replace(/\n+$/, "");
		if (now === base || now === "") return flash("the message stands as it was");
		const shown = typeof item.chat === "string" ? full.split(base).join(now) : now + suffix;
		messageEdits.set(full, shown);
		reviseNote(brainDir, base, now);
		syncChat(base, now, item.editKind === "chat-you" ? "user" : item.editKind === "chat-agent" ? "agent" : undefined);
		refresh(viewId(), true);
		flash(item.editKind === "chat-you" ? "your message is edited · what follows reads the edited words" : "edited where it shows, and in the talk the collapse keeps · what was sent stays as it was");
	};
	/** d on a message of the Context window, yours or the agent's: it leaves the talk the collapse keeps, and the views. What was sent stays stored, and the agent reads it until the next collapse. */
	const deleteChat = (item) => {
		const full = item.copy ?? item.body;
		if (typeof full !== "string" || full === "") return flash("nothing to delete here");
		// A message of yours was sent with a stamp of its own; the words are what stands without it, and that is what is deleted.
		let base = full;
		if (item.editKind === "chat-you") {
			const found = /\n\n\[(?:sent|noted) [^\]]*\]$/.exec(full);
			if (found !== null) base = full.slice(0, found.index);
		}
		if (typeof item.chat === "string") base = item.chat;
		if (!forgetChat(brainDir, base)) return flash("the talk the collapse keeps does not hold it: a collapse may have dropped it already");
		messageDeleted.add(full);
		messageDeleted.add(base);
		// Where the same words stand in the Chat tab, they go too.
		const twin = chat.items.findLast((entry) => entry.text === base || entry.text === full);
		if (twin !== undefined) inPlace(() => chat.forget(twin.key));
		refresh(viewId(), true);
		flash("deleted from the talk the collapse keeps, and from view · what was sent stays stored, and the agent reads it until the next collapse");
	};
	const editContext = () => {
		const item = pageOf().list.selected();
		if (item === undefined) return flash("nothing is selected");
		switch (item.editKind) {
			case "prompt": {
				const file = promptSource();
				if (file === undefined) return flash("the source of the prompt is not here");
				if (!runEditor(file)) return;
				return flash("the prompt's wording is code: the next run of carto reads it as it is now");
			}
			case "tool": {
				const name = String(item.key).startsWith("tool:") ? String(item.key).slice(5) : String(item.key);
				const found = toolSource(name);
				if (found === undefined) return flash(`no source file defines the ${name} tool`);
				if (!runEditor(found.file, found.line)) return;
				return flash(`${name}'s description is code: the next run of carto reads it as it is now`);
			}
			case "tools":
				return flash("the tools are one block; Enter opens it to a line per tool, and e on one opens where it is defined");
			case "assessment": {
				const file = assessmentPath(brainDir);
				if (!runEditor(file)) return;
				refresh(viewId(), true);
				return flash("edited; the copy at the top of the context is rewritten at the next collapse, or /pin now");
			}
			case "store": {
				if (!runEditor(contextPath(brainDir))) return;
				refresh(viewId(), true);
				return flash("the store of what the collapse keeps, edited by hand · take care: a file that does not parse falls back to a fresh one");
			}
			case "chat-you":
			case "chat-agent":
				return editMessage(item);
			case "reply":
				return flash("the reply is being written; e on it works once it is done");
			case "result":
				return flash("tool work cannot be edited: e opens a message of the user or the agent");
			case "state":
				return flash("the state block is written anew for every request; what it reads is editable: e on Atlas, Ledger, Plan or Assessment in the Carto tab");
			case "windows":
				return flash("the windows block is written anew for every request, from the windows themselves");
			case "carto":
				return flash("what Cartographer writes into a message cannot be edited");
			default: {
				// Hands: a shelved file is its file; a report is its file in .atlas/reports.
				if (typeof item.path === "string" && item.path !== "") {
					if (!existsSync(item.path)) return flash("the shelved file is not there");
					if (!runEditor(item.path)) return;
					refresh(viewId(), true);
					return flash("edited; the shelf reads it anew at the next collapse");
				}
				if (typeof item.key === "string" && item.key.startsWith("report:")) {
					const file = join(brainDir, "reports", `${item.key.slice(7)}.md`);
					if (!existsSync(file)) return flash("the report's file is not there");
					if (!runEditor(file)) return;
					return flash("the report's file is edited; the record line keeps the summary it was written with");
				}
				return flash("that is what was sent, and what was sent cannot be changed");
			}
		}
	};
	const edit = () => {
		if (state.tab === "chat") return editChat();
		if (state.tab === "context") return editContext();
		const item = pageOf().list.selected();
		const target = item?.target ?? (fileOf(viewId()) !== undefined ? { file: fileOf(viewId()) } : undefined);
		if (target === undefined) return flash("this line has no file to open");
		if (target.folder) return flash("that is a folder: open it with Enter, and press e on a file");
		if (!existsSync(target.file)) return flash(`${relative(root, target.file)} does not exist`);
		if (!runEditor(target.file, target.line)) return;
		brain.at = 0;
		refresh(viewId(), true);
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
		if (line.kind === "group") inPlace(() => chat.toggle(line.item, to));
		else if (line.kind === "call" || line.kind === "note" || line.kind === "detail") {
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
		if (state.tab !== "chat") {
			const { list } = pageOf();
			const item = list.selected();
			if (item === undefined) return copyTab();
			return copy(list.copyOf(item), viewId().replace(".", "-"), "the selected item", "txt");
		}
		const line = chatBody.lines()[selectedRow()];
		if (line === undefined) return flash("nothing is selected: j and k select");
		copy(chat.textOf(line.item, line.row), "message", line.kind === "call" || line.kind === "detail" ? "that call and its result" : line.kind === "group" ? "that run of calls" : "that message");
	};

	// ─── The commands mode ───────────────────────────────────────────────────
	const showKeys = () => {
		if (tui.hasOverlay()) return;
		const sheet = new Sheet({ title: "Keys", text: KEYS_HELP, rows: () => terminal.rows, keyOf, close: () => handle.hide() });
		const handle = tui.showOverlay(sheet, { width: Math.max(20, Math.min(108, terminal.columns - 4)), anchor: "center" });
	};
	/** One command, by the name of its key (src/screen/keys.mjs). */
	const command = (key) => {
		const inChat = state.tab === "chat";
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
		// The rows of the views, in every tab but Chat: the same keys do everywhere what they do in Hands — f
		// folds a report, v archives a row out of what the agent reads, d deletes it for good, x unshelves a file.
		// They stand on whatever the view shows: a report or a shelved file in Hands, a node of the graph, a
		// ledger entry, a plan item in Carto, a request in Requests, a message of the user or the agent in the
		// Context window. The operations themselves are in src/ops.mjs, the same code the commands run.
		if (!inChat) {
			const item = pageOf().list.selected();
			const rowKey = typeof item?.key === "string" ? item.key : undefined;
			const bookId = rowKey !== undefined && /^[a-z]+:/.test(rowKey) ? rowKey.slice(rowKey.indexOf(":") + 1) : undefined;
			const deletable = rowKey !== undefined && (/^(?:report|entry|item|node|request):/.test(rowKey) || item.editKind === "chat-you" || item.editKind === "chat-agent");
			if (key === "f" && rowKey !== undefined && rowKey.startsWith("report:")) {
				const said = foldRow(brainDir, bookId);
				flash(said.replace(/\n+/g, " "));
				refresh(viewId(), true);
				return;
			}
			if (key === "v" && rowKey !== undefined && /^(?:report|entry|item|node):/.test(rowKey)) {
				flash(item.archived === true ? unarchiveRow(brainDir, bookId) : archiveRow(brainDir, bookId));
				refresh(viewId(), true);
				return;
			}
			if (key === "x" && rowKey !== undefined && rowKey.startsWith("shelf:")) {
				try {
					flash(unshelveRow(brainDir, bookId));
				} catch (error) {
					flash(error.message);
				}
				refresh(viewId(), true);
				return;
			}
			// Deleting is for good, so it asks twice: the first d arms it, the second, soon after, carries it out.
			// A request is not deleted but forgotten: the agent is told nothing of it, and so forgets it had asked.
			if (key === "d" && deletable) {
				if (state.deleteArm?.id === rowKey && Date.now() - state.deleteArm.at < 6000) {
					state.deleteArm = undefined;
					if (item.editKind === "chat-you" || item.editKind === "chat-agent") deleteChat(item);
					else flash(dropRow(brainDir, coreDir, bookId));
					refresh(viewId(), true);
					return;
				}
				state.deleteArm = { id: rowKey, at: Date.now() };
				flash(viewId() === "carto.requests" ? `Press d again: ${bookId} is forgotten` : item.editKind === "chat-you" || item.editKind === "chat-agent" ? "Press d again: the message goes for good" : `Press d again: ${bookId} goes for good`);
				return;
			}
			if (key === "d" && rowKey !== undefined && rowKey.startsWith("shelf:")) return flash("a shelved file is not deleted: x takes it off the shelf");
			// A request is approved or turned down the way the commands do it, so that the agent is told what changed.
			if (viewId() === "carto.requests" && rowKey !== undefined && rowKey.startsWith("request:")) {
				if (key === "a") {
					if (/^q\d+$/.test(bookId)) return flash("a question is answered with words: /answer " + bookId + " words");
					setMode("type");
					return void submit(`/approve ${bookId}`);
				}
				if (key === "n") {
					setMode("type");
					return void submit(`/deny ${bookId}`);
				}
			}
			// In Hands, a puts /shelve in the prompt: shelving names a file, and the file is yours to name.
			if (key === "a" && viewId() === "context.hands") {
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
		if (key === "r") {
			brain.at = 0;
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
		hint: () => (state.mode === "type" ? "Esc: commands · F1: keys" : state.tab === "chat" ? "j k move · Enter open · y copy · ? keys" : "j k · Enter open · + all · e edit · ? keys"),
		fileHint() {
			if (state.tab === "context") return undefined;
			const file = pageOf()?.list.selected()?.target?.file ?? fileOf(viewId());
			return file === undefined ? undefined : relative(root, file) || ".";
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
			const draft = typed === "" ? "" : `   (typed so far: ${cut(typed.replace(/\n/g, " ⏎ "), 40)})`;
			const hint = state.pending !== "" ? `${state.pending}…` : question !== undefined ? "the agent waits for your answer: Esc, then type it" : "Esc or i to type";
			return [[" COMMANDS ", "chip"], [`  ${hint}`, question !== undefined ? "warn" : "muted"], [draft, "faint"]];
		},
		prompt() {
			const question = session.asks?.pending();
			if (question !== undefined) return { text: "? ", style: "warn bold" };
			// What is switched off is in the strip; here stands only where the words go.
			return { text: session.activeTask?.() !== undefined && core.busy() ? "→ task › " : "› ", style: "user bold" };
		},
		placeholder: () => (session.asks?.pending() !== undefined ? "your answer" : core.busy() ? "type to speak to the agent while it works · Esc for commands" : "type a message, or /help · Esc for commands"),
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
	const windowNames = () => (session.windows?.list(0) ?? []).filter((win) => win.state !== "gone").map((win) => win.name);
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
			onPath("fd") ?? onPath("fdfind") ?? null,
		),
	);
	const full = { basis: 0, grow: 1, minSize: 1 };
	const airy = ({ height }) => height >= AIRY_ROWS;
	tui.setLayoutRoot(
		new VStack([
			new TabBar(ui),
			{ component: new ViewBar(ui), visible: () => VIEWS[state.tab] !== undefined },
			{ component: new Air(), visible: airy },
			{ component: chatScroll, ...full, visible: () => state.tab === "chat" },
			...PAGES.map((id) => ({ component: pages.get(id).scroll, ...full, visible: () => state.tab !== "chat" && viewId() === id })),
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
		if (state.tab !== "chat") refresh();
		// The window of the conversation has another height than the one it was last drawn for (the screen was
		// resized, or what is typed grew): it is drawn again.
		else if (chatBody.rows !== chatScroll.viewportHeight) draw();
		const busy = core.busy();
		if (Date.now() - lastFrame >= (busy ? SPIN_MS : 1000)) {
			lastFrame = Date.now();
			draw();
		}
	}, SPIN_MS);

	let stopped = false;
	const stop = ({ farewell = false } = {}) => {
		if (stopped) return;
		stopped = true;
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
	terminal.setTitle(`carto · ${basename(root)}`);
	tui.setFocus(prompt);
	askColors();
	// A terminal that tells when its colours change (the desktop went from light to dark) is asked again then.
	tui.setTerminalColorSchemeNotifications(true);
	tui.onTerminalColorSchemeChange(() => askColors());
	try {
		return await runTerminal(session, { ...options, interactive: true, screen });
	} finally {
		state.closed = true;
		stop({ farewell: true });
		applyTheme(undefined);
		process.off("exit", onExit);
	}
}
