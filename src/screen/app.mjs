// The full screen: tabs, a status strip that is always there, and a place to type.
//
//   1 Chat     Conversation is user-directed exchange; Work is private shared-brain activity; Consult is its isolated conference audit (src/screen/chat.mjs)
//   2 Carto    the live shared brain: Atlas, Ledger, Plan, Requests, Tree, Current shared brain
//   3 Diff     what was changed: by the last step, in this session, or against the project's own git HEAD
//   4 Shells   the shell windows, live
//   5 Model    route readiness, sent provider payloads, next-request preview, and current accounting
//   6 Settings configuration, assessment, session policy, and native-grammar diagnostics
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
// workspace.mjs, review.mjs, runtime.mjs, list.mjs), how it is coloured (theme.mjs), and how the two are fitted to
// the screen (parts.mjs).
//
// And it is a face, not a second program. The session is run by the plain terminal (src/terminal.mjs), which is
// handed a `screen` to print to: it carries out the commands, wakes the agent, collapses its context and words
// everything Cartographer has to say, exactly as it does line by line.
import { DEFAULTS, POLICY } from "../config.mjs";
import { actionPlacementFor, assertActionPlacementParity } from "./action-placement.mjs";
import { EventEmitter } from "node:events";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CombinedAutocompleteProvider, KeybindingsManager, Markdown, ProcessTerminal, ScrollView, setKeybindings, TUI_KEYBINDINGS, TuiAltScreen, visibleWidth, VStack } from "@earendil-works/pi-tui";
import { charsPerTokenNow } from "../calibrate.mjs";
import { createApplication } from "../application/app.mjs";
import { createChatPresentation } from "../application/chat.mjs";
import { createReviewPresentation } from "../application/review-presentation.mjs";
import { createRuntimePresentation } from "../application/runtime-presentation.mjs";
import { createSettingsPresentation } from "../application/settings-presentation.mjs";
import { createWorkspacePresentation } from "../application/workspace-presentation.mjs";
import { REQUEST_ACTION } from "../application/requests.mjs";
import { REVIEW_ACTION } from "../application/review.mjs";
import { TALK_ACTION } from "../application/talk.mjs";
import { WORKSPACE_ACTION } from "../application/workspace.mjs";
import { RUNTIME_ACTION } from "../application/runtime-actions.mjs";
import { SETTINGS_ACTION } from "../application/settings-actions.mjs";
import { launchEditor } from "../infrastructure/editor.mjs";
import { findExecutable, findTextSource, pathExists, readText, writeScratch } from "../infrastructure/filesystem.mjs";
import { stamp } from "../time.mjs";
import { createChat, homeOf } from "./chat.mjs";
import { CommandPalette } from "./command-palette.mjs";
import { ActionDialog } from "./action-dialog.mjs";
import { ActionLauncher } from "./action-launcher.mjs";
import { ConfirmDialog } from "./confirm-dialog.mjs";
import { TargetPicker } from "./target-picker.mjs";
import { createDeferredReferenceLabels } from "../application/references.mjs";
import { copyOut, selectionText, toClipboard } from "./copy.mjs";
import { createPasteWatch, isKeyRelease, isPaste, keyOf } from "./keys.mjs";
import { createFocusManager } from "./focus.mjs";
import { createKeyHints } from "./key-hints.mjs";
import { createList } from "./list.mjs";
import { createRouteManager } from "./routes.mjs";
import { renderAsyncBoundary } from "./async-boundary.mjs";
import { createNoticeStore, NOTICE_LEVEL } from "./notices.mjs";
import { createOverlayManager } from "./overlays.mjs";
import { renderStatusBar } from "./status.mjs";
import { createProjectionScheduler } from "./projections.mjs";
import { Air, AIRY_ROWS, ChatBody, Farewell, Form, ListBody, marginOf, Prompt, Sheet, Strip, TabBar, ViewBar } from "./parts.mjs";
import { applyTheme, cut, sgr } from "./text.mjs";
import { colorMode, makeTheme, markdownTheme, schemeFromEnv } from "./theme.mjs";
import { TOKEN } from "./tokens.mjs";
import { editorCommand } from "./views.mjs";
import { diffView } from "./review.mjs";
import { accountingProjectionView, contextView, modelRoutesView, previewView, rawPayloadView, shellsOutView, shellsView, wakesView } from "./runtime.mjs";
import { settingsAssessmentView, settingsSafetyView } from "./settings.mjs";
import { SettingsSourcePicker, settingsConfigurationView, settingsEditorField, settingsSources, settingsWriteTarget } from "./settings-editor.mjs";
import { atlasView, handsView, ledgerView, planView, requestsView, treeView } from "./workspace.mjs";
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
	{ id: "settings", name: "Settings" },
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
		{ id: "wakes", name: "Wakes" },
	],
	context: [
		{ id: "routes", name: "Routes" },
		{ id: "window", name: "Latest sent" },
		{ id: "main", name: "Main sent" },
		{ id: "raw", name: "Raw payload" },
		{ id: "preview", name: "Next preview" },
		{ id: "parts", name: "Current accounting" },
	],
	settings: [
		{ id: "configuration", name: "Configuration" },
		{ id: "safety", name: "Safety" },
		{ id: "assessment", name: "Assessment" },
	],
};
/** Every list-backed view; Chat's Conversation, Work, and Consult share the chat projection instead. */
const PAGES = ["carto.atlas", "carto.ledger", "carto.plan", "carto.requests", "carto.tree", "carto.hands", "diff.last", "diff.session", "diff.git", "shells.list", "shells.out", "shells.wakes", "context.routes", "context.window", "context.main", "context.raw", "context.preview", "context.parts", "settings.configuration", "settings.safety", "settings.assessment"];
/** How often a view is read again while it shows, in milliseconds. */
const EVERY = POLICY.timing.screenRefreshMs;
const QUESTION_ID = new RegExp(POLICY.patterns.questionId);
/** How long each spinner mark stands; the status strip owns its visible marks. */
const SPIN_MS = POLICY.timing.spinnerMs;

// Palette placement stays separate from capabilities: application metadata owns whether an action is available,
// while this pure Screen registry says which settled route provides its target.
const routeName = ({ tab, view }) => {
	const tabName = TABS.find((entry) => entry.id === tab)?.name ?? tab;
	const viewName = VIEWS[tab]?.find((entry) => entry.id === view)?.name ?? view;
	return `${tabName} · ${viewName}`;
};
export const paletteDestinationFor = (id) => {
	const placement = actionPlacementFor(id);
	if (placement === undefined) return undefined;
	return {
		...placement.route,
		name: routeName(placement.route),
		hint: placement.paletteText ?? "Continue with this action from the settled view.",
	};
};

/** Turn an application capability into an executable launcher entry, never a terminal-command fallback. */
export const paletteItemForCapability = (capability) => {
	const placement = actionPlacementFor(capability.id);
	const destination = paletteDestinationFor(capability.id);
	return {
		id: `capability:${capability.id}`,
		actionId: capability.id,
		label: capability.label,
		category: capability.category,
		availability: capability.availability,
		description: destination === undefined
			? "This registered action has no Screen placement yet."
			: `${destination.name}. ${destination.hint}`,
		keywords: [capability.id, placement?.shortcut, placement?.terminalPath].filter((value) => typeof value === "string" && value !== "").join(" "),
		destination,
		...(destination === undefined ? { disabled: true, disabledReason: "This action has no Screen placement yet." } : {}),
	};
};

/** The commands that are typed and sent, for the list that opens when a line starts with a slash. */
export const COMMANDS = [
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
	["consult", "consultation conference audits; /consult co1 shows its immutable packet; /consult probe [PATH] writes a native-grammar diagnostic", ["probe"]],
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
	["exit", "leave; the same as /quit"],
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
	"  1 to 6           go to a tab (Chat holds Conversation, private Work, and the isolated Consult audit)",
	"  [ and ]          the previous and the next view inside the tab that shows (H and L do the same)",
	"  j, k             move down and up over the items; g and G go to the first and the last",
	"  Enter, Space, o  open what is selected, or fold it; l opens, h folds. In Work, Enter opens private reasoning or a call, and l takes a call to where its work lives. In Consult, Enter folds a conference or opens its attributed activity. In Shells, Enter on a window shows its output as a terminal emulator does (Enter goes back); in Wakes it opens the selected schedule row. In Model → Routes, Enter validates the active route or selects and validates another route.",
	"  + and -          open everything, fold everything (zR and zM do the same)",
	"  Ctrl-D, Ctrl-U   scroll half a page; Ctrl-F and Ctrl-B a page; Ctrl-E and Ctrl-Y a row",
	"  /                search the tab that shows; Enter or Down goes to the next match, Up to the one before, Esc closes the search",
	"  e                on a row of Atlas, Ledger or Plan: the small box on its fields — a live counter shows how full a field is and the row's limit is where it stops; Tab goes to the next field, Enter saves one-line fields, and in a field that holds a long text Enter ends a line and Ctrl-Enter saves; Esc cancels. In Settings → Configuration, it opens the selected schema-derived saved-setting form.",
	`  E                the $EDITOR door on the same row: on an Atlas, Ledger or Plan row, the entry's own JSON; with no such row, a template for a new one. On another editable source it opens that source. Ctrl-O is the same door, in every tab and mode, including while you type; Settings → Configuration keeps e for its saved-setting form, while its $EDITOR door names no raw configuration-file editor. In Conversation e rewords a stable source for a future kept talk; private Work cannot be edited; sent Model payloads are read-only`,
	"  f, v, d, x, t    the same keys on a row outside Chat: f folds a report out of view or brings it back (in Current shared brain); v archives a row out of what the agent reads — a report, ledger entry, plan envelope or move, node of the graph — or brings it back; d opens a confirmation before it deletes for good, in Requests before it forgets without a word to the agent, and in Shells → Wakes before it removes the selected wake; t settles it (a ledger entry closes, a reported move opens a prompt for why its proof witnesses its done-when, a completed envelope closes, a node confirms); sent Model payloads have no delete action; x takes a shelved file off the shelf (in Current shared brain), or in Settings → Configuration resets the selected saved-source override. In Conversation, d opens confirmation before removing one stable source from future kept talk only; the active conversation and sent requests stay unchanged.",
	"  u                in Diff, asks before taking the latest checkpoint change back and reopening its move for approval when it has one",
	"  n                a new ledger entry, plan envelope, child move on a selected envelope, or Atlas node: the small box uses the same operations as the agent (E opens the template in $EDITOR instead)",
	"  s                in Settings → Configuration, choose the writable project or install source that an edit/reset affects; environment and command-line overrides stay read-only",
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
	"  Ctrl-K           search navigation and registered actions in the command palette",
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
	/** What the terminal core lets the screen ask (src/terminal.mjs, `ui.attach`): ephemeral local activity only. */
	let core = { busy: () => false, paused: () => false, thinking: () => true };
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
		scrollToEndIndicator: () => `${sgr(TOKEN.interaction.selected)} ↓ the newest · G or End \x1b[0m`,
		searchMatchStyle: (text) => `${sgr(TOKEN.emphasis.underline)}${text}\x1b[24m`,
		searchCurrentMatchStyle: (text) => `${sgr(TOKEN.interaction.chip)}${text}\x1b[0m`,
	});

	// ─── Colours (src/screen/theme.mjs) ──────────────────────────────────────
	// A palette for the terminal's own background. It starts from what the settings and the environment say, and
	// is made again when the terminal answers what its colours are, and whenever it says they have changed.
	const colors = { mode: colorMode(config.colors), background: undefined, foreground: undefined };
	let configuredTheme = config.theme;
	let mdTheme;
	let themeVersion = 0;
	const retheme = () => {
		const theme = makeTheme({ mode: colors.mode, ...(configuredTheme === "dark" || configuredTheme === "light" ? { scheme: configuredTheme } : { background: colors.background, foreground: colors.foreground, scheme: schemeFromEnv() }) });
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
	const workspacePresentation = createWorkspacePresentation();
	const reviewPresentation = createReviewPresentation();
	const runtimePresentation = createRuntimePresentation();
	const settingsPresentation = createSettingsPresentation();
	// The Consult subview receives only its own asynchronously refreshed co<N> cache. The records never join parent
	// talk/work, a request, or the shared brain; these synchronous callbacks merely read that isolated cache.
	const CONSULT_PROJECTION = "chat.consult";
	let settleConsultProjection = () => {};
	const consultProjections = createProjectionScheduler({ onSettled: (id, projection) => settleConsultProjection(id, projection) });
	const consultProjection = () => consultProjections.get(CONSULT_PROJECTION);
	const chat = createChat({
		markdown,
		presentation: createChatPresentation({ describeRef }),
	});
	chat.setConsultProjection(consultProjection());
	const askColors = () => {
		if (configuredTheme === "dark" || configuredTheme === "light" || colors.mode === "none") return;
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
		view: { chat: "conversation", carto: "atlas", diff: "last", shells: "list", context: "routes" },
		settingsScope: "project", // the explicit persisted source Configuration edits; never an environment or CLI override
		shell: undefined, // the shell window whose output the Output view shows
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
	// A route is tab plus its remembered subview. Its shell effects are installed after projection refresh exists;
	// the manager itself is ready now so every later reader gets the same validated route identity.
	let settleRoute = () => {};
	const routes = createRouteManager({ tabs: TABS, views: VIEWS, state, onChange: (change) => settleRoute(change) });
	// Replaced once the composer and command sink exist. Keeping a harmless coordinator here makes early lifecycle
	// callbacks unable to trip over a temporal focus dependency.
	let shellFocus = Object.freeze({ focus: () => false, restore: () => false });
	const notices = createNoticeStore({ ttlMs: POLICY.timing.screen.flashMs });
	const noticeLevel = (text) => {
		const message = String(text ?? "").trim();
		if (/^(?:!|could not\b|cannot\b|failed\b|error\b)/i.test(message)) return NOTICE_LEVEL.error;
		if (/^(?:nothing\b|no\b|not\b|only\b|the .* is not\b)/i.test(message)) return NOTICE_LEVEL.warning;
		return NOTICE_LEVEL.info;
	};
	refreshReferenceLabels = () => {
		if (state.closed || !chat.refreshActivityLabels()) return;
		draw();
	};
	settleConsultProjection = (id, projection) => {
		if (id !== CONSULT_PROJECTION) return;
		chat.setConsultProjection(projection);
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
	/** Something to say in passing: a flash for immediacy, plus a bounded notice that stays in the shell footer. */
	const flash = (text, level = noticeLevel(text)) => {
		if (state.closed) return undefined;
		const notice = notices.add({ message: text, level });
		tui.flash(` ${cut(text, Math.max(16, Math.min(56, terminal.columns - 50)))} `, POLICY.timing.screen.flashMs);
		draw();
		return notice;
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
		/** A successful first-turn proof clears the stale unavailable-route status and replaces its cached route fact. */
		modelReady() {
			const hadError = state.modelError !== undefined;
			state.modelError = undefined;
			refreshRuntimeModelProjection(true);
			refreshRuntimeStatusProjection(true);
			if (hadError) draw();
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
	/** The status strip reads its settled snapshot only; the clock and invalidations below own replacement reads. */
	const readBrain = () => brain;
	/** Drop a possibly stale status result after a durable workspace action, then request a replacement. */
	const invalidateBrain = () => {
		brain = { at: 0, loading: false, request: brain.request + 1 };
		refreshBrain(true);
	};
	/** The strip and composer read one deferred activity snapshot rather than probing asks/task state while they render. */
	const currentRuntimeActivity = () => runtimeActivityProjection().data ?? {};
	/** The strip paints only cached projections; refreshBrain and the projection clock own all deferred reads. */
	const status = () => renderStatusBar({
		state,
		core,
		chat,
		activity: currentRuntimeActivity(),
		brain: readBrain(),
		runtime: runtimeStatusForStrip(),
		notice: notices.latest({ live: true }),
		legend: legend(),
		config,
		options,
	});

	/** The footer has route-local meanings, but capability-backed actions remain tied to the one registered availability source. */
	const keyHints = createKeyHints({
		typing: "Esc: commands · Ctrl-K: palette · Ctrl-O: $EDITOR · ? all keys",
		fallback: ["j k move", "Enter open"],
		global: ["Ctrl-K palette", "? all keys"],
		routes: {
			"chat.conversation": [
				"j k move",
				"Enter open",
				{ text: "e reword kept talk", capability: TALK_ACTION.revise },
				{ text: "d remove kept talk", capability: TALK_ACTION.forget },
				"y copy",
			],
			"chat.work": ["j k move", "Enter open", "y copy"],
			"chat.consult": ["j k move", "Enter open", "+ all", "y copy"],
			"carto.atlas": [
				{ text: "t confirm", capability: WORKSPACE_ACTION.settle },
				{ text: "n new", capability: WORKSPACE_ACTION.add },
				{ text: "v archive", capabilities: [WORKSPACE_ACTION.archive, WORKSPACE_ACTION.unarchive] },
				{ text: "d delete", capability: WORKSPACE_ACTION.delete },
				"e edit",
			],
			"carto.ledger": [
				{ text: "t settle", capability: WORKSPACE_ACTION.settle },
				{ text: "n new", capability: WORKSPACE_ACTION.add },
				{ text: "v archive", capabilities: [WORKSPACE_ACTION.archive, WORKSPACE_ACTION.unarchive] },
				{ text: "d delete", capability: WORKSPACE_ACTION.delete },
				"e edit",
			],
			"carto.plan": [
				{ text: "t done/review", capability: WORKSPACE_ACTION.settle },
				{ text: "n new", capabilities: [WORKSPACE_ACTION.add, WORKSPACE_ACTION.addMove] },
				{ text: "v archive", capabilities: [WORKSPACE_ACTION.archive, WORKSPACE_ACTION.unarchive] },
				{ text: "d delete", capability: WORKSPACE_ACTION.delete },
				"e edit",
			],
			"carto.requests": [
				{ text: "a approve", capability: REQUEST_ACTION.approve },
				{ text: "n deny", capability: REQUEST_ACTION.deny },
				{ text: "d forget", capability: WORKSPACE_ACTION.delete },
				"e edit",
			],
			"carto.tree": ["Enter fold", "y copy", "e edit"],
			"carto.hands": [
				{ text: "f fold", capability: WORKSPACE_ACTION.toggleFold },
				{ text: "v archive", capabilities: [WORKSPACE_ACTION.archive, WORKSPACE_ACTION.unarchive] },
				{ text: "d delete", capability: WORKSPACE_ACTION.delete },
				{ text: "x unshelve", capability: WORKSPACE_ACTION.unshelve },
				"e edit",
			],
			"diff.last": [{ text: "u undo", capability: REVIEW_ACTION.undo }, "Enter open", "y copy", "e edit"],
			"diff.session": [{ text: "u undo", capability: REVIEW_ACTION.undo }, "Enter open", "y copy", "e edit"],
			"diff.git": [{ text: "u undo", capability: REVIEW_ACTION.undo }, "Enter open", "y copy", "e edit"],
			"shells.list": ["Enter output", "y copy"],
			"shells.out": ["Enter back"],
			"shells.wakes": [{ text: "d remove", capability: RUNTIME_ACTION.removeWake }, "Enter open", "y copy"],
			"context.routes": [{ text: "Enter connect/select", capabilities: [RUNTIME_ACTION.ensureModel, RUNTIME_ACTION.selectModel] }, "y copy"],
			"context.window": ["Enter open", "y copy"],
			"context.main": ["Enter open", "y copy"],
			"context.raw": ["Enter open", "y copy"],
			"context.preview": ["Enter open", "y copy"],
			"context.parts": ["Enter open", "+ all", "y copy"],
			"settings.configuration": [
				"j k move",
				{ text: "Enter/e edit", capability: SETTINGS_ACTION.edit },
				{ text: "x reset", capability: SETTINGS_ACTION.reset },
				"s source",
				"y copy",
			],
			"settings.safety": ["j k move", "Enter open", "y copy"],
			"settings.assessment": ["j k move", "Enter open", "e edit", "y copy"],
		},
	});
	const legend = () => keyHints.text({ mode: state.mode, route: viewId(), capabilities: paletteCapabilities });
	// ─── The tabs that are lists ─────────────────────────────────────────────
	const viewId = () => routes.id();
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
		configuration: options.configuration,
		runtime: {
			main: session.main,
			context: session.context,
			engine: session.engine,
			windows: session.windows,
			wakes: session.wakes,
			asks: session.asks,
			activeTask: session.activeTask,
			work: session.work,
			model: session.models?.current ?? session.model,
			models: session.models,
			preview: session.preview,
			runner: options.runner,
			gate: options.gate,
			initiation: options.initiation,
			contextWindow: () => options.config?.contextWindow ?? options.contextWindow,
		},
	});
	assertActionPlacementParity(application.capabilities);
	const queries = application.queries;
	// Availability is a composition-time snapshot: opening the palette never consults a manager from a key handler
	// or render pass. The registered capability remains its single metadata source, including disabled reasons.
	const paletteCapabilities = Object.freeze(application.capabilities.list().map((capability) => Object.freeze({ ...capability })));
	const workspace = Object.freeze({ execute: application.execute, template: application.workspace.template });
	const review = Object.freeze({ execute: application.execute });
	const talk = Object.freeze({ execute: application.execute });
	/** Consult records are loaded only through the application facade and stay in Chat · Consult's private cache. */
	const refreshConsultProjection = (force = false) => {
		const prior = consultProjection();
		if (!force && Date.now() - (prior.requestedAt ?? 0) < (EVERY.chat ?? POLICY.timing.screenRefreshMs.fallback)) return false;
		const started = consultProjections.refresh(CONSULT_PROJECTION, ({ signal }) => queries.consult.list({ signal }), { force });
		if (started) chat.setConsultProjection(consultProjection());
		return started;
	};
	const cancelConsultProjection = () => {
		const cancelled = consultProjections.cancel(CONSULT_PROJECTION);
		if (cancelled) chat.setConsultProjection(consultProjection());
		return cancelled;
	};
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
		"shells.wakes": ({ signal }) => queries.runtime.wakes({ signal }),
		"runtime.status": ({ signal }) => queries.runtime.status({ signal }),
		"context.routes": ({ signal }) => queries.runtime.models({ signal }),
		"context.window": ({ signal }) => queries.runtime.sent({ scope: "newest", signal }),
		"context.main": ({ signal }) => queries.runtime.sent({ scope: "main", signal }),
		"context.raw": ({ signal }) => queries.runtime.sent({ scope: "newest", signal }),
		"context.preview": ({ signal }) => queries.runtime.preview({ signal }),
		"context.parts": ({ signal }) => queries.runtime.context({ signal }),
		"settings.configuration": ({ signal }) => queries.settings.status({ signal }),
		"settings.safety": ({ signal }) => queries.settings.status({ signal }),
		"settings.assessment": ({ signal }) => queries.runtime.assessment({ signal }),
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
		"shells.wakes": "Wake schedule",
		"runtime.status": "Runtime status",
		"context.routes": "Model routes",
		"context.window": "Latest sent provider request",
		"context.main": "Main sent provider request",
		"context.raw": "Raw provider payload",
		"context.preview": "Next request preview",
		"context.parts": "Current active-context accounting",
		"settings.configuration": "Configuration",
		"settings.safety": "Safety",
		"settings.assessment": "Assessment",
	});
	let settleProjection = () => {};
	// Constructed after overlay helpers exist. Projection settlement may happen sooner, so this remains optional here.
	let actionLauncher;
	const projections = createProjectionScheduler({ onSettled: (id, projection) => settleProjection(id, projection) });
	const projectionFor = (id) => projections.get(id);
	const RUNTIME_ACTIVITY_PROJECTION = "runtime.activity";
	const runtimeActivityProjection = () => projectionFor(RUNTIME_ACTIVITY_PROJECTION);
	let runtimeActivityAt = 0;
	/** Questions and task ownership are live lifecycle state, so the screen refreshes a small deferred snapshot instead of reading them while it paints. */
	const refreshRuntimeActivity = (force = false) => {
		if (!force && Date.now() - runtimeActivityAt < EVERY.chat) return false;
		runtimeActivityAt = Date.now();
		return projections.refresh(RUNTIME_ACTIVITY_PROJECTION, ({ signal }) => queries.runtime.activity({ signal }), { force });
	};
	// Feature renderers receive settled data only. The shared boundary owns the shell language for first load,
	// stale cache, retryable failure, and projection issues without letting a paint trigger another read.
	const projectionView = (id, render) => renderAsyncBoundary({
		id,
		name: PROJECTION_NAME[id] ?? "view",
		projection: projectionFor(id),
		render,
	});
	const refreshProjection = (id, force = false) => {
		const query = DEFERRED_PROJECTION[id];
		return query === undefined ? false : projections.refresh(id, query, { force });
	};
	const cancelProjection = (id) => projections.cancel(id);
	const RUNTIME_STATUS_PROJECTION = "runtime.status";
	const RUNTIME_MODEL_PROJECTION = "context.routes";
	const runtimeStatusProjection = () => projectionFor(RUNTIME_STATUS_PROJECTION);
	const runtimeModelProjection = () => projectionFor(RUNTIME_MODEL_PROJECTION);
	let runtimeStatusAt = 0;
	/** The persistent strip owns this timed Runtime snapshot rather than asking live conversation/shell/wake managers while it paints. */
	const refreshRuntimeStatusProjection = (force = false) => {
		if (!force && Date.now() - runtimeStatusAt < POLICY.timing.screen.stateCacheMs) return false;
		runtimeStatusAt = Date.now();
		return refreshProjection(RUNTIME_STATUS_PROJECTION, force);
	};
	/** Route discovery can reach a server, so it refreshes on opening, explicit retry, and route lifecycle changes—not every frame. */
	const refreshRuntimeModelProjection = (force = false) => refreshProjection(RUNTIME_MODEL_PROJECTION, force);
	/** Status formatting stays in Runtime presentation; this shell component receives only its settled display facts. */
	const runtimeStatusForStrip = () => {
		const statusProjection = runtimeStatusProjection();
		const routesProjection = runtimeModelProjection();
		return runtimePresentation.status.describe(statusProjection.data, {
			routes: routesProjection.data,
			statusLoading: statusProjection.loading === true,
			statusError: statusProjection.error,
			routesLoading: routesProjection.loading === true,
			routesError: routesProjection.error,
			reportedError: state.modelError,
		});
	};
	const invalidateProjections = () => projections.invalidate();
	/** All adapter actions publish the same invalidation fact, including a slash command handled by the terminal core. */
	const stopApplicationEvents = application.events.subscribe((event) => {
		if (event.type !== "projection.invalidated") return;
		const scopes = event.payload.scopes ?? [];
		const brainChanged = scopes.some((scope) => ["workspace", "context", "requests"].includes(scope));
		const runtimeChanged = scopes.includes("runtime");
		const settingsChanged = scopes.some((scope) => ["settings", "configuration"].includes(scope));
		const projectionChanged = brainChanged || runtimeChanged || settingsChanged || scopes.includes("review");
		if (!projectionChanged) return;
		if (brainChanged) invalidateBrain();
		invalidateProjections();
		if (runtimeChanged) {
			refreshRuntimeStatusProjection(true);
			if ([RUNTIME_ACTION.ensureModel, RUNTIME_ACTION.selectModel].includes(event.payload.action)) refreshRuntimeModelProjection(true);
		}
		refresh(viewId(), true);
	});
	/** Each view: its list, the part that draws it, and the scroll view the part stands in. */
	const pages = new Map();
	const pageOf = (id = viewId()) => pages.get(id);
	const build = (id, isOpen, cols) => {
		if (id === "carto.atlas") return projectionView(id, (data) => atlasView({ file: data.file, atlas: data.atlas, attention: data.attention, lines: data.lines, presentation: workspacePresentation.atlas }));
		if (id === "carto.ledger") return projectionView(id, (data) => ledgerView({ file: data.file, ledger: data.ledger, lines: data.lines, presentation: workspacePresentation.ledger }));
		if (id === "carto.plan") return projectionView(id, (data) => planView({ file: data.file, yolo: options.gate?.yolo === true, plan: data.plan, lines: data.lines, presentation: workspacePresentation.plan }));
		if (id === "carto.requests") return projectionView(id, (data) => requestsView({ requests: data.items, presentation: workspacePresentation.requests }));
		if (id === "carto.tree") return projectionView(id, (data) => treeView({ tree: data, presentation: workspacePresentation.tree }, isOpen));
		if (id === "carto.hands") return projectionView(id, (data) => handsView({ context: data, presentation: workspacePresentation.hands }));
		if (id.startsWith("diff.")) return projectionView(id, (data) => diffView({ review: data, presentation: reviewPresentation }, id.slice(5)));
		if (id === "shells.list") return projectionView(id, (data) => shellsView({ ...data, presentation: runtimePresentation.shells }));
		if (id === "shells.out") return projectionView(id, (data) => shellsOutView({ ...data, presentation: runtimePresentation.shells }));
		if (id === "shells.wakes") return projectionView(id, (data) => wakesView({ wakes: data.wakes, lines: data.lines, presentation: runtimePresentation.wakes }));
		if (id === "context.routes") return projectionView(id, (data) => modelRoutesView({ routes: data, presentation: runtimePresentation.modelRoutes }));
		if (id === "context.window" || id === "context.main") return projectionView(id, (data) => {
			const sent = data.sent;
			return contextView({ sent, windowSize: options.config?.contextWindow ?? options.contextWindow, cols, writing: sent === undefined || sent.reply !== undefined ? undefined : chat.liveMessage(sent.task ? 1 : 0), isOpen, presentation: runtimePresentation.sent });
		});
		if (id === "context.raw") return projectionView(id, (data) => rawPayloadView({ sent: data.sent, presentation: runtimePresentation.sent }));
		if (id === "context.preview") return projectionView(id, (data) => previewView({ preview: data.preview, presentation: runtimePresentation.preview }));
		if (id === "context.parts") return projectionView(id, (data) => accountingProjectionView({ accounting: data, config, presentation: runtimePresentation.accounting }));
		if (id === "settings.configuration") return projectionView(id, (data) => settingsConfigurationView({
			settings: data,
			scope: state.settingsScope,
			selected: pageOf(id)?.list.selected()?.key,
			wide: cols >= 100,
		}));
		if (id === "settings.safety") return projectionView(id, (data) => settingsSafetyView({ settings: data, presentation: settingsPresentation.overview }));
		if (id === "settings.assessment") return projectionView(id, (data) => settingsAssessmentView({ assessment: data, presentation: settingsPresentation.assessment }));
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
		if (id === RUNTIME_ACTIVITY_PROJECTION || id === RUNTIME_STATUS_PROJECTION) return void draw();
		rebuild(id);
		if (viewId() === id) {
			draw();
			// A palette launch waits for this already-settled projection instead of asking a live manager for targets.
			// The launcher ignores unrelated routes and any currently-open dialog/picker.
			actionLauncher?.onRouteSettled(routes.current());
		}
	};
	/** Read a view again. */
	const refresh = (id = viewId(), force = false) => {
		if (id === "chat.consult") {
			if (refreshConsultProjection(force)) draw();
			return;
		}
		const page = pageOf(id);
		if (page === undefined) return;
		// Unlike frozen payload/context projections, route discovery reaches the model server. Opening, r, and lifecycle
		// events own retries; an idle frame must not keep issuing `/models` checks.
		if (id === RUNTIME_MODEL_PROJECTION && !force) return;
		if (!force && Date.now() - page.at < (EVERY[id.split(".")[0]] ?? POLICY.timing.screenRefreshMs.fallback)) return;
		page.at = Date.now();
		refreshProjection(id, force);
		const before = page.list.version;
		rebuild(id);
		if (page.list.version !== before) draw();
	};

	/** Present one typed workspace outcome, then redraw the projection that started the action. */
	const presentWorkspaceResult = (result, id = viewId()) => {
		flash((result.ok ? result.data.line : result.error.message).replace(/\n+/g, " "), result.ok ? NOTICE_LEVEL.success : NOTICE_LEVEL.error);
		if (!result.ok) refresh(id, true);
		draw();
		return result.ok;
	};
	/** Runtime controls use the same typed result/confirmation boundary as terminal commands and other feature actions. */
	const presentRuntimeResult = (result, id = viewId()) => {
		flash((result.ok ? result.data.line : result.error.message).replace(/\n+/g, " "), result.ok ? NOTICE_LEVEL.success : NOTICE_LEVEL.error);
		if (!result.ok) refresh(id, true);
		draw();
		return result.ok;
	};
	/** A live appearance setting changes this Screen only when the saved write became the effective value. */
	const applyLiveScreenSetting = (row) => {
		if (row?.apply !== "live-screen") return;
		if (row.key === "colors" && typeof row.effectiveValue === "string") colors.mode = colorMode(row.effectiveValue);
		if (row.key === "theme" && typeof row.effectiveValue === "string") configuredTheme = row.effectiveValue;
		if (row.key !== "colors" && row.key !== "theme") return;
		retheme();
		chat.restyle();
		askColors();
		tui.invalidate();
	};
	/** Settings actions preserve the form on an ordinary failure, and refresh the settled provenance after a conflict. */
	const presentSettingsResult = (result, id = viewId()) => {
		const line = result.ok ? result.data.line : result.error.message;
		flash(String(line).replace(/\n+/g, " "), result.ok ? (result.data.changed === false ? NOTICE_LEVEL.info : NOTICE_LEVEL.success) : NOTICE_LEVEL.error);
		if (result.ok) applyLiveScreenSetting(result.data.row);
		else refresh(id, true);
		draw();
		return result.ok;
	};
	const selectedSetting = () => {
		const item = pageOf("settings.configuration")?.list.selected();
		return item?.setting?.row;
	};
	const cachedSettings = () => projectionFor("settings.configuration").data ?? projectionFor("settings.safety").data;
	/** Configuration sources are explicit: a read-only project never silently becomes an install write. */
	const settingsTarget = ({ key, scope } = {}) => {
		const settings = cachedSettings();
		const rows = Array.isArray(settings?.configuration?.rows) ? settings.configuration.rows : [];
		const row = typeof key === "string" && key !== "" ? rows.find((entry) => entry?.key === key) : selectedSetting();
		if (row === undefined || settings === undefined) return undefined;
		try { return { row, settings, target: settingsWriteTarget(settings, row, scope ?? state.settingsScope) }; }
		catch { return undefined; }
	};
	/** A target picker sees only render rows or Chat's already-settled local transcript—never a manager. */
	const actionTargetsFor = (placement, pending) => {
		const source = placement.targetSource;
		if (source === "none") return { state: "ready", targets: [] };
		if (source === "kept-talk") {
			const selectedLine = chatBody.lines()[selectedRow()];
			const targets = chat.items
				.filter((item) => (item?.type === "user" || item?.type === "agent") && item.source !== undefined)
				.map((item) => ({
					key: `talk:${item.key}`,
					value: item.key,
					label: String(item.text ?? "speech").replace(/\s+/g, " ").trim().slice(0, 120) || "speech",
					detail: item.type === "agent" ? "Delivered agent speech kept for a future collapse." : "Submitted user speech kept for a future collapse.",
					input: { source: item.source },
					...(item.type === "agent" && item.delivery !== "delivered" ? { disabled: true, disabledReason: "Undelivered agent speech is not a stable kept-talk source." } : {}),
				}));
			if (targets.length === 0) return { state: "unavailable", reason: "No stable kept-talk source is available in Conversation. Refresh and try again." };
			return { state: "ready", targets, selected: selectedLine?.item === undefined ? undefined : `talk:${selectedLine.item}` };
		}
		const id = `${placement.route.tab}.${placement.route.view}`;
		const projection = projectionFor(id);
		if (projection.data === undefined) {
			if (projection.loading === true) return { state: "loading" };
			return { state: "unavailable", reason: projection.error?.message === undefined ? "That target view is not settled. Refresh and try again." : `That target view is unavailable: ${projection.error.message}` };
		}
		const page = pageOf(id);
		if (page === undefined) return { state: "unavailable", reason: "That target view is unavailable. Refresh and try again." };
		const items = page.list.items();
		const label = (item) => (item.head ?? []).map(([part]) => String(part)).join("").replace(/\s+/g, " ").trim() || String(item.key ?? "target");
		const selected = page.list.selected()?.key;
		const keyed = (pattern, input) => items.flatMap((item) => {
			const matched = pattern.exec(String(item.key ?? ""));
			if (matched === null) return [];
			return [{ key: item.key, value: matched[1], label: label(item), input: input(matched[1], item) }];
		});
		let targets;
		if (source === "requests") {
			targets = keyed(/^request:(.+)$/, (requestId) => pending.actionId === REQUEST_ACTION.approve ? { ids: [requestId] } : { id: requestId });
		} else if (source === "shell-windows") {
			targets = keyed(/^window:(.+)$/, (name) => ({ name }));
		} else if (source === "wakes") {
			targets = keyed(/^wake:(.+)$/, (wakeId) => ({ id: wakeId }));
		} else if (source === "model-routes") {
			targets = items.flatMap((item) => typeof item.target?.modelId !== "string" || item.target.modelId === "" ? [] : [{
				key: item.key,
				value: item.target.modelId,
				label: label(item),
				input: { modelId: item.target.modelId, ...(Number.isInteger(item.target.contextWindow) && item.target.contextWindow > 0 ? { contextWindow: item.target.contextWindow } : {}) },
			}]);
		} else if (source === "atlas-nodes") {
			targets = keyed(/^node:(.+)$/, (node) => ({ target: node }));
		} else if (source === "files") {
			targets = items.flatMap((item) => typeof item.target?.file !== "string" || item.target.file === "" || item.target.folder === true ? [] : [{ key: item.key, value: item.target.file, label: label(item), input: { path: item.target.file } }]);
		} else if (source === "plan-envelopes") {
			targets = keyed(/^envelope:(.+)$/, (parent) => ({ parent, rowKey: `envelope:${parent}` }));
		} else if (source === "settings") {
			targets = items.flatMap((item) => {
			const row = item.setting?.row;
			const write = item.setting?.write;
			if (typeof row?.key !== "string" || row.key === "" || typeof write?.scope !== "string") return [];
			const unavailable = write.writable !== true
				? `The ${write.scope} configuration source is read-only. Choose a writable saved source first.`
				: write.expectedRevision === undefined ? "Refresh Settings before changing this setting so its saved-source revision is known." : undefined;
			return [{
				key: item.key,
				value: row.key,
				label: label(item),
				input: { key: row.key, scope: write.scope, ...(write.expectedRevision === undefined ? {} : { expectedRevision: write.expectedRevision }) },
				...(unavailable === undefined ? {} : { disabled: true, disabledReason: unavailable }),
			}];
		});
		} else if (source === "workspace-rows") {
			const allowed = pending.actionId === WORKSPACE_ACTION.unshelve ? /^(shelf):(.+)$/
				: [WORKSPACE_ACTION.fold, WORKSPACE_ACTION.recall, WORKSPACE_ACTION.toggleFold].includes(pending.actionId) ? /^(report):(.+)$/
					: /^(report|entry|item|envelope|move|node):(.+)$/;
			targets = items.flatMap((item) => {
				const matched = allowed.exec(String(item.key ?? ""));
				if (matched === null) return [];
				const rowId = matched[2];
				return [{ key: item.key, value: rowId, label: label(item), input: { id: rowId, rowKey: item.key } }];
			});
		}
		if (!Array.isArray(targets) || targets.length === 0) return { state: "unavailable", reason: "No current target is available in this settled view. Refresh and try again." };
		return { state: "ready", targets, selected };
	};
	const chooseSettingsSource = () => {
		const settings = cachedSettings();
		if (settings === undefined) return flash("Configuration is still loading; refresh Settings before choosing a source.");
		const sources = settingsSources(settings);
		if (!sources.some((source) => source.writable === true)) return flash("Neither saved configuration source is writable in this session.");
		openModal(({ close }) => new SettingsSourcePicker({
			sources,
			selected: state.settingsScope,
			keyOf,
			close,
			flash,
			choose: (source) => {
				state.settingsScope = source.scope;
				rebuild("settings.configuration");
				flash(`save target: ${source.scope} configuration`, NOTICE_LEVEL.info);
				draw();
				return true;
			},
		}), { width: Math.max(30, Math.min(76, terminal.columns - 4)), anchor: "center" });
	};
	const requestSettingsEdit = (requested) => {
		const selected = settingsTarget(requested);
		if (selected === undefined) {
			flash("Choose a settled configuration setting before editing.");
			return false;
		}
		const { row, target } = selected;
		if (target.writable !== true) {
			flash(`The ${target.scope} configuration source is read-only. Press s to choose a writable saved source.`);
			return false;
		}
		if (target.expectedRevision === undefined) {
			flash("Refresh Settings before editing so the selected source revision is known.");
			return false;
		}
		const field = settingsEditorField(row, target);
		return openModal(({ close }) => new Form({
			title: `Edit ${row.label} · ${target.scope}`,
			fields: [field],
			keyOf,
			flash,
			close,
			save: (drafts) => application.execute(SETTINGS_ACTION.edit, {
				key: row.key,
				value: drafts.get("value"),
				scope: target.scope,
				expectedRevision: target.expectedRevision,
			}).then((asked) => {
				if (asked.confirmation === undefined) return presentSettingsResult(asked, "settings.configuration");
				// The form owns its draft until it reaches the application's confirmation boundary. Once the backend asks
				// for acknowledgement, that exact request replaces the form; a cancelled confirmation makes no write.
				close();
				setTimeout(() => {
					if (!state.closed) openConfirmation(asked.confirmation, () => application.execute(SETTINGS_ACTION.edit, {
						key: row.key,
						value: drafts.get("value"),
						scope: target.scope,
						expectedRevision: target.expectedRevision,
					}, {
						confirmation: { ...asked.confirmation, acknowledged: true },
					}).then((result) => presentSettingsResult(result, "settings.configuration")), { title: `Save ${row.label}?` });
				}, 0);
				return true;
			}),
			redraw: draw,
		}), { width: boxWidth([field], terminal.columns), anchor: "center" });
	};
	const requestSettingsReset = () => {
		const selected = settingsTarget();
		if (selected === undefined) return flash("Choose a settled configuration setting before resetting it.");
		const { row, target } = selected;
		if (target.writable !== true) return flash(`The ${target.scope} configuration source is read-only. Press s to choose a writable saved source.`);
		if (target.expectedRevision === undefined) return flash("Refresh Settings before resetting so the selected source revision is known.");
		void application.execute(SETTINGS_ACTION.reset, {
			key: row.key,
			scope: target.scope,
			expectedRevision: target.expectedRevision,
		})
			.then((result) => presentSettingsResult(result, "settings.configuration"))
			.catch((error) => flash(`could not reset that setting: ${error?.message ?? error}`));
	};
	/** Choose or validate a settled route row through the typed Runtime model boundary; there is no provider call in this key handler. */
	const requestModelRoute = (target) => {
		if (target === undefined || typeof target.modelId !== "string" || target.modelId === "") return flash("choose a model route before connecting");
		const route = viewId();
		const action = target.active === true ? RUNTIME_ACTION.ensureModel : RUNTIME_ACTION.selectModel;
		const input = action === RUNTIME_ACTION.ensureModel
			? {}
			: { modelId: target.modelId, ...(Number.isInteger(target.contextWindow) && target.contextWindow > 0 ? { contextWindow: target.contextWindow } : {}) };
		void application.execute(action, input)
			.then((result) => presentRuntimeResult(result, route))
			.catch((error) => flash(`could not prepare that model route: ${error?.message ?? error}`));
	};
	const requestWakeRemoval = (wake) => {
		if (wake === undefined || typeof wake.id !== "string" || wake.id === "") return flash("choose a wake before removing it");
		const route = viewId();
		void application.execute(RUNTIME_ACTION.removeWake, { id: wake.id })
			.then((asked) => {
				if (asked.confirmation === undefined) return presentRuntimeResult(asked, route);
				openConfirmation(asked.confirmation, () => application.execute(RUNTIME_ACTION.removeWake, { id: wake.id }, {
					confirmation: { ...asked.confirmation, acknowledged: true },
				}).then((result) => presentRuntimeResult(result, route)), { title: wake.id === "all" ? "Remove every wake?" : "Remove wake?" });
			})
			.catch((error) => flash(`could not prepare that wake removal: ${error?.message ?? error}`));
	};
	/** Run a row action through the typed application boundary, then redraw its projection after it settles. */
	const runWorkspaceAction = (action, input, options_ = {}) => {
		const id = viewId();
		void workspace.execute(action, input, options_)
			.then((result) => presentWorkspaceResult(result, id))
			.catch((error) => flash(`could not complete that workspace action: ${error?.message ?? error}`));
	};
	/** A destructive workspace action first receives the application's scoped confirmation request, then the shared modal acknowledges that exact action and target. */
	const requestWorkspaceDelete = (id) => {
		const route = viewId();
		void workspace.execute(WORKSPACE_ACTION.delete, { id })
			.then((asked) => {
				if (asked.confirmation === undefined) return presentWorkspaceResult(asked, route);
				openConfirmation(asked.confirmation, () => workspace.execute(WORKSPACE_ACTION.delete, { id }, {
					confirmation: { ...asked.confirmation, acknowledged: true },
				}).then((result) => presentWorkspaceResult(result, route)), {
					title: route === "carto.requests" ? "Forget request?" : "Delete permanently?",
				});
			})
			.catch((error) => flash(`could not prepare that deletion: ${error?.message ?? error}`));
	};
	/** Undo crosses the same typed boundary as /undo; Screen schedules ingress and owns only the acknowledgement overlay. */
	const presentReviewResult = (result, id = viewId()) => {
		flash((result.ok ? result.data.line : result.error.message).replace(/\n+/g, " "), result.ok ? NOTICE_LEVEL.success : NOTICE_LEVEL.error);
		if (!result.ok) refresh(id, true);
		draw();
		return result.ok;
	};
	const requestReviewUndo = () => {
		if (core.busy()) return flash("The agent is working. Stop it first, then undo its checkpoint change.");
		const route = viewId();
		void (async () => {
			// Match /undo: active shell changes become their own latest checkpoint before this recovery is named.
			if (application.capabilities.availability(REVIEW_ACTION.recordWindows)?.enabled === true) {
				const recorded = await review.execute(REVIEW_ACTION.recordWindows);
				if (!recorded.ok) return presentReviewResult(recorded, route);
			}
			const asked = await review.execute(REVIEW_ACTION.undo);
			if (asked.confirmation === undefined) return presentReviewResult(asked, route);
			openConfirmation(asked.confirmation, () => review.execute(REVIEW_ACTION.undo, {}, {
				confirmation: { ...asked.confirmation, acknowledged: true },
			}).then((result) => presentReviewResult(result, route)), { title: "Undo checkpoint change?" });
		})().catch((error) => flash(`could not prepare that recovery: ${error?.message ?? error}`));
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
	// One route transition owns selection reset, stale-query cancellation, replacement reads, and redraw. Its callback
	// still runs for an explicit visit to the current route, preserving the old click/key refresh behavior.
	settleRoute = ({ previous, current, changed }) => {
		if (changed) {
			cancelProjection(previous.id);
			if (previous.id === "chat.consult") cancelConsultProjection();
			// A route change before target settlement is an explicit abandonment, not permission to keep a hidden
			// picker pending behind a different view. Overlay-backed/executing launches retain their own safeguards.
			actionLauncher?.onRouteChanged(current);
		}
		tui.resetTextSelection();
		refresh(current.id, true);
		draw();
	};
	const setTab = (id) => routes.setTab(id);
	const stepTab = (by) => routes.stepTab(by);
	const setView = (id) => routes.setView(id);
	const stepView = (by) => routes.stepView(by);
	const setRoute = (route) => routes.setRoute(route);
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
		shellFocus.focus(mode === "type" ? "composer" : "commands");
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
			shellFocus.restore();
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
		void talk.execute(TALK_ACTION.forget, { source: item.source })
			.then((asked) => {
				if (asked.confirmation === undefined) return flash(asked.ok ? asked.data.line : asked.error.message);
				openConfirmation(asked.confirmation, async () => {
					const result = await talk.execute(TALK_ACTION.forget, { source: item.source }, { confirmation: { ...asked.confirmation, acknowledged: true } });
					if (!result.ok) {
						flash(result.error.message);
						return false;
					}
					inPlace(() => chat.forget(item.key));
					flash(result.data.line);
					draw();
					return true;
				}, { title: "Remove kept talk?" });
			})
			.catch((error) => flash(`could not prepare that kept-source removal: ${error?.message ?? error}`));
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
	// ─── The shared form fields ───────────────────────────────────────────────
	// The book views open one of these on e; E keeps the editor on the entry's own JSON. The limits are the books'
	// own, so the form never holds more than the book would; the counter shows how much of the field is used.
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
		if (viewId() !== viewId_) return false;
		if (found === undefined) {
			flash("that is not an entry of its book, or the book cannot be read");
			return false;
		}
		if (found.error !== undefined) {
			flash(found.error);
			return false;
		}
		const { id, fields } = found;
		return openModal(({ close }) => new Form({
			title: id,
			fields,
			keyOf,
			flash,
			close,
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
		if (template === undefined) {
			flash("this view has no add");
			return false;
		}
		const id = viewId();
		const fields = template();
		return openModal(({ close }) => new Form({
			title: `new ${book}`,
			fields,
			keyOf,
			flash,
			close,
			save: (drafts) => workspace.execute(WORKSPACE_ACTION.add, { book, text: JSON.stringify(addOpOf(book, drafts)) })
				.then((result) => presentWorkspaceResult(result, id)),
			redraw: draw,
		}), { width: boxWidth(fields, terminal.columns), anchor: "center" });
	};
	/** `n` on an envelope declares a child move through the typed workspace action. */
	const openMoveBox = async (parentId) => {
		const found = await queries.entry({ book: "plan", id: parentId });
		if (viewId() !== "carto.plan") return false;
		if (!found.ok || found.data.item.parent !== undefined) {
			flash(found.ok ? "that envelope is no longer in the plan" : found.error.message);
			return false;
		}
		const parent = found.data.item;
		if (parent.status !== POLICY.enums.entryStatus.open || parent.archived === true) {
			flash(`${parent.id} is not an open envelope`);
			return false;
		}
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
		return openModal(({ close }) => new Form({
			title: `new move under ${parent.id}`,
			fields,
			keyOf,
			flash,
			close,
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
				const view = home.tab === "diff" ? "last" : home.view;
				return void setRoute({ tab: home.tab, ...(view === undefined ? {} : { view }) });
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
		openModal(({ close }) => new Sheet({ title: "Keys", text: KEYS_HELP, rows: () => terminal.rows, keyOf, close }), { width: Math.max(20, Math.min(108, terminal.columns - 4)), anchor: "center" });
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
			if (viewId() === "settings.configuration") {
				if (key === "enter" || key === "e") return void requestSettingsEdit();
				if (key === "x") return void requestSettingsReset();
				if (key === "s") return void chooseSettingsSource();
			}
			if (key === "u" && viewId().startsWith("diff.")) return void requestReviewUndo();
			const item = pageOf().list.selected();
			const rowKey = typeof item?.key === "string" ? item.key : undefined;
			const bookId = rowKey !== undefined && /^[a-z]+:/.test(rowKey) ? rowKey.slice(rowKey.indexOf(":") + 1) : undefined;
			const deletable = rowKey !== undefined && /^(?:report|entry|item|envelope|move|node|request):/.test(rowKey);
			if (key === "f" && rowKey !== undefined && rowKey.startsWith("report:")) return void runWorkspaceAction(WORKSPACE_ACTION.toggleFold, { id: bookId });
			if (key === "v" && rowKey !== undefined && /^(?:report|entry|item|envelope|move|node):/.test(rowKey)) return void runWorkspaceAction(item.archived === true ? WORKSPACE_ACTION.unarchive : WORKSPACE_ACTION.archive, { id: bookId });
			if (key === "t" && rowKey !== undefined && /^(?:report|entry|item|envelope|move|node):/.test(rowKey)) return void settleWorkspaceRow(rowKey, bookId);
			if (key === "x" && rowKey !== undefined && rowKey.startsWith("shelf:")) return void runWorkspaceAction(WORKSPACE_ACTION.unshelve, { id: bookId });
			if (viewId() === "context.routes" && (key === "enter" || key === " " || key === "o")) return void requestModelRoute(item?.target);
			if (key === "d" && viewId() === "shells.wakes" && rowKey?.startsWith("wake:")) return void requestWakeRemoval({ id: rowKey.slice(5) });
			// Deleting is for good, so it always opens the same scoped confirmation. A request is not deleted but
			// forgotten: the agent is told nothing of it, and so forgets it had asked.
			if (key === "d" && deletable) return void requestWorkspaceDelete(bookId);
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
		if (/^[1-6]$/.test(key)) return void setTab(TABS[Number(key) - 1].id);
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
			if (viewId() === "settings.configuration") rebuild();
			return void show();
		}
		if (key === "k" || key === "up") {
			if (!anchor() && !list.move(-1)) page.scroll.scrollBy(-1);
			if (viewId() === "settings.configuration") rebuild();
			return void show();
		}
		if (key === "g" || key === "home") {
			list.first();
			if (viewId() === "settings.configuration") rebuild();
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
			const question = currentRuntimeActivity().question;
			const typed = prompt.getText();
			const draft = typed === "" ? "" : `   (typed so far: ${cut(typed.replace(/\n/g, " ⏎ "), POLICY.limits.screen.typedDraftChars)})`;
			let hint = "Esc or i to write";
			if (question !== undefined) hint = "the agent waits for your answer: Esc, then type it";
			if (state.pending !== "") hint = `${state.pending}…`;
			return [[" COMMAND MODE ", "chip"], [`  ${hint}`, question !== undefined ? "warn" : "muted"], [draft, "faint"]];
		},
		prompt() {
			const activity = currentRuntimeActivity();
			if (activity.question !== undefined) return { text: "Answer › ", style: "warn bold" };
			// Keep the terminal core's safety marks at the place someone acts, but give the words a stable human role
			// rather than a bare glyph. The strip repeats the broader state; this is the immediate composition cue.
			const marks = state.prompt.replace(/\s*›\s*$/, "").trim();
			const task = activity.taskActive && core.busy();
			const role = task ? "Task" : "You";
			if (marks !== "") return { text: `${marks} ${role} › `, style: "warn bold" };
			if (task) return { text: "Task › ", style: "tool bold" };
			return { text: "You › ", style: "user bold" };
		},
		placeholder: () => {
			if (currentRuntimeActivity().question !== undefined) return "Write the answer";
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
	// Modes, overlays, and external-editor handoffs restore one named shell focus rather than each choosing a
	// component independently. Modal components retain their own internal field/cursor focus while they are open.
	shellFocus = createFocusManager({
		initial: "composer",
		resolve: (region) => region === "composer" ? prompt : region === "commands" ? commands : undefined,
		apply: (component) => tui.setFocus(component),
	});
	// Forms, help, and destructive acknowledgements share one focus-capturing modal owner. pi-tui restores the
	// normal editor/command focus after a hidden overlay; the explicit fallback also covers a modal that settles
	// after a terminal resize or action error.
	const overlays = createOverlayManager({
		show: (component, overlayOptions) => tui.showOverlay(component, overlayOptions),
		restoreFocus: () => {
			if (!state.closed) shellFocus.restore();
		},
		redraw: draw,
	});
	const openModal = (create, overlayOptions) => {
		if (tui.hasOverlay() && !overlays.hasOpen()) {
			flash("finish or cancel the open dialog first");
			return undefined;
		}
		const opened = overlays.open(create, overlayOptions);
		if (opened === undefined) flash("finish or cancel the open dialog first");
		return opened;
	};
	const openConfirmation = (confirmation, confirm, { title, cancel } = {}) => openModal(({ close }) => new ConfirmDialog({
		title,
		confirmation,
		keyOf,
		close,
		confirm,
		flash,
		redraw: draw,
		...(typeof cancel === "function" ? { cancel } : {}),
	}), { width: Math.max(20, Math.min(76, terminal.columns - 4)), anchor: "center" });
	const presentLaunchedResult = (result, pending) => {
		const id = `${pending.placement.route.tab}.${pending.placement.route.view}`;
		if (pending.actionId.startsWith("settings.")) return presentSettingsResult(result, id);
		if (pending.actionId.startsWith("runtime.")) return presentRuntimeResult(result, id);
		if (pending.actionId.startsWith("review.")) return presentReviewResult(result, id);
		if (pending.actionId.startsWith("workspace.")) return presentWorkspaceResult(result, id);
		if (pending.actionId.startsWith("request.") || pending.actionId.startsWith("context.")) {
			flash((result.ok ? result.data.line : result.error.message).replace(/\n+/g, " "), result.ok ? NOTICE_LEVEL.success : NOTICE_LEVEL.error);
			if (!result.ok) refresh(id, true);
			draw();
			return result.ok;
		}
		if (pending.actionId.startsWith("talk.")) {
			flash((result.ok ? result.data.line : result.error.message).replace(/\n+/g, " "), result.ok ? NOTICE_LEVEL.success : NOTICE_LEVEL.error);
			draw();
			return result.ok;
		}
		return presentWorkspaceResult(result, id);
	};
	const openExistingActionControl = ({ plan, placement, dispatch }) => {
		const input = plan.input ?? {};
		if (plan.actionId === REVIEW_ACTION.undo) {
			return (async () => {
				if (core.busy()) {
					flash("The agent is working. Stop it first, then undo its checkpoint change.");
					return false;
				}
				// Preserve the established recovery bridge: active shell changes become their own checkpoint before undo
				// names a recovery target. Both legs remain application actions; only the launcher owns confirmation.
				if (application.capabilities.availability(REVIEW_ACTION.recordWindows)?.enabled === true) {
					const recorded = await application.execute(REVIEW_ACTION.recordWindows);
					if (!recorded.ok) return presentReviewResult(recorded, `${placement.route.tab}.${placement.route.view}`);
				}
				return dispatch();
			})();
		}
		if (plan.actionId === SETTINGS_ACTION.edit) return requestSettingsEdit(input);
		if (plan.actionId === WORKSPACE_ACTION.add) return openAddBox(BOOK_VIEWS[viewId()] ?? "ledger");
		if (plan.actionId === WORKSPACE_ACTION.addMove) {
			if (typeof input.parent !== "string" || input.parent === "") return false;
			return openMoveBox(input.parent);
		}
		if (plan.actionId === WORKSPACE_ACTION.edit) {
			if (typeof input.rowKey !== "string" || input.rowKey === "") return false;
			return openFieldBox(viewId(), input.rowKey);
		}
		if (plan.actionId === WORKSPACE_ACTION.settle) {
			if (typeof input.id !== "string" || input.id === "") return false;
			// Palette candidates are settled Ledger rows at this placement. Dispatching retains the application's durable
			// validation without re-querying a row from the key/overlay path; Plan's reported-move review bridge remains
			// the contextual `t` control on its own settled view.
			return dispatch();
		}
		return false;
	};
	// The palette feeds this single launcher. Its target callback reads only current list/chat rows and its execution
	// callback is application.execute; no Screen component receives a manager or performs a hidden live lookup.
	actionLauncher = new ActionLauncher({
		capabilities: application.capabilities,
		specs: application.actionSpecs,
		placements: Object.freeze({ get: actionPlacementFor }),
		execute: application.execute,
		currentRoute: () => routes.current(),
		navigate: (route) => setRoute(route),
		targetsFor: actionTargetsFor,
		openDialog: ({ plan, submit, cancel }) => openModal(({ close }) => new ActionDialog({
			actionId: plan.actionId,
			title: plan.title,
			fields: plan.fields,
			input: plan.input,
			keyOf,
			close,
			flash,
			redraw: draw,
			submit,
			cancel,
		}), { width: boxWidth(plan.fields, terminal.columns), anchor: "center" }),
		openTargetPicker: ({ title, targets, choose, cancel }) => openModal(({ close }) => new TargetPicker({
			title,
			targets,
			keyOf,
			close,
			flash,
			redraw: draw,
			choose,
			cancel,
		}), { width: Math.max(28, Math.min(82, terminal.columns - 4)), anchor: "center" }),
		openConfirmation: ({ confirmation, confirm, cancel }) => openConfirmation(confirmation, confirm, {
			title: `${application.capabilities.get(confirmation.actionId)?.label ?? "Confirm action"}?`,
			cancel,
		}),
		openExistingControl: openExistingActionControl,
		present: presentLaunchedResult,
		flash,
	});
	const paletteItems = () => [
		{ id: "navigate.chat", label: "Go to Chat", category: "navigation", description: "Conversation, private Work, and isolated Consult.", destination: { tab: "chat", view: "conversation", name: "Chat" } },
		{ id: "navigate.carto", label: "Go to Carto", category: "navigation", description: "Atlas, Ledger, Plan, Requests, Tree, and the shared brain.", destination: { tab: "carto", view: "atlas", name: "Carto" } },
		{ id: "navigate.review", label: "Go to Diff and review", category: "navigation", description: "Last-step, session, and git change inspection.", destination: { tab: "diff", view: "last", name: "Diff · Last step" } },
		{ id: "navigate.shells", label: "Go to Shells", category: "navigation", description: "Open shell windows and their captured output.", destination: { tab: "shells", view: "list", name: "Shells · List" } },
		{ id: "navigate.model", label: "Go to Model", category: "navigation", description: "Model-route readiness, sent requests, preview, and current context accounting.", destination: { tab: "context", view: "routes", name: "Model · Routes" } },
		{ id: "navigate.settings", label: "Go to Settings", category: "navigation", description: "Configuration, session policy, provider diagnostics, and assessment.", destination: { tab: "settings", view: "configuration", name: "Settings · Configuration" } },
		{ id: "shell.refresh", label: "Refresh visible view", category: "navigation", description: "Discard the visible projection cache and ask its deferred boundary for a replacement." },
		...paletteCapabilities.map(paletteItemForCapability),
	];
	const openPaletteDestination = (destination) => {
		if (destination === undefined) return false;
		const current = routes.current();
		if (current.tab === destination.tab && (destination.view === undefined || current.view === destination.view)) return true;
		return setRoute({ tab: destination.tab, ...(destination.view === undefined ? {} : { view: destination.view }) });
	};
	const showPalette = () => openModal(({ close }) => new CommandPalette({
		title: "Command palette",
		items: paletteItems,
		keyOf,
		close,
		flash,
		redraw: draw,
		activate: async (item) => {
			if (item.id === "shell.refresh") {
				invalidateBrain();
				refresh(viewId(), true);
				flash("read again", NOTICE_LEVEL.info);
				return true;
			}
			if (item.actionId !== undefined) {
				const started = await actionLauncher.begin(item.actionId, { waitForResume: true });
				// CommandPalette closes only after this promise resolves. Defer target/dialog resolution one turn so the
				// shared overlay owner never stacks it on the palette; route settlement resumes a loading target later.
				if (started) setTimeout(() => {
					if (!state.closed) void actionLauncher.resume();
				}, 0);
				return started;
			}
			if (openPaletteDestination(item.destination)) {
				flash(`opened ${item.destination.name}`, NOTICE_LEVEL.info);
				return true;
			}
			return false;
		},
	}), { width: Math.max(20, Math.min(82, terminal.columns - 4)), anchor: "center" });
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
	const AFTER_ESCAPE = new Set([..."123456jkgGhloeYriazuR+-[]HL?/: "]);
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
		else if (key === "ctrl+k") showPalette();
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
		refreshBrain();
		if (!chatTab()) refresh();
		else if (state.view.chat === "consult") refresh("chat.consult");
		// The strip owns one compact deferred Runtime status snapshot. It supersedes the old off-screen shell/wake
		// probes while keeping shell and wake view reads bound to their own visible projections.
		refreshRuntimeStatusProjection();
		// The window of the conversation has another height than the one it was last drawn for (the screen was
		// resized, or what is typed grew): it is drawn again.
		if (chatTab() && chatBody.rows !== chatScroll.viewportHeight) draw();
		refreshRuntimeActivity();
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
	refreshBrain(true);
	refreshRuntimeStatusProjection(true);
	refreshRuntimeModelProjection(true);
	refreshRuntimeActivity(true);
	terminal.setTitle(`carto · ${basename(root)}`);
	shellFocus.restore();
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
