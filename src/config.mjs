// Settings: where the model server is and which model to use.
//
// Read in this order, later ones winning:
//   1. defaults
//   2. <core>/config.json            the install's settings, shared by every project (CARTO_CONFIG names another file)
//   3. <project>/.atlas/config.json  one project's own settings
//   4. CARTO_SERVER, CARTO_MODEL     environment
//   5. --url, --model                command line
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The core folder: where Cartographer is installed. Every project runs this one copy. */
export const CORE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const BRAIN_DIR = ".atlas";

const freezeTree = (value) => {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freezeTree(child);
		Object.freeze(value);
	}
	return value;
};

const ACTION = freezeTree({ add: "add", edit: "edit", done: "done", remove: "remove", archive: "archive", unarchive: "unarchive", delete: "delete", before: "before", clear: "clear", recall: "recall", shelve: "shelve", unshelve: "unshelve", fold: "fold", note: "note", collapse: "collapse", set: "set", link: "link", unlink: "unlink", confirm: "confirm", look: "look", tree: "tree", run: "run", read: "read", wait: "wait", send: "send", stop: "stop", close: "close" });
const LEDGER_KIND = freezeTree({ goal: "goal", question: "question", note: "note" });
const PLAN_MODE = freezeTree({ look: "look", change: "change" });
const BOOK_KIND = freezeTree({ assessment: "assessment", practice: "practice" });
const BOOK_NAME = freezeTree({ ledger: "ledger", plan: "plan", books: "books", context: "context" });
const WAKE_KIND = freezeTree({ time: "time", file: "file", window: "window" });
const WINDOW_WAIT_REASON = freezeTree({ done: "done", time: "time", asks: "asks", until: "until", quiet: "quiet", stopped: "stopped", closed: "closed", nudged: "nudged", idle: "idle", read: "read" });

export const DEFAULTS = freezeTree({
	server: undefined,
	model: undefined,
	// What the server was started with (-c). Cartographer never asks for more than this.
	contextWindow: 100000,
	// Upper bound on one reply, thinking included. A file a task writes is part of one reply, so this also bounds
	// how long a file one `write` call can hold.
	maxTokens: 8192,
	// Tool rounds one run may take before it stops and says so. Carrying out a plan takes about two per item.
	mainTurns: 40,
	taskTurns: 30,
	// Seconds a `shell` call waits for its command before it returns and leaves the command running in its window.
	shellWait: 30,
	// Lines of output the agent is shown for each busy shell window, at the end of every request.
	windowTail: 10,
	// Seconds between two firings of one wake trigger, at least: each firing is a whole turn of the model.
	wakeMin: 60,
	// Wake triggers the agent may have set at a time.
	wakesMax: 8,
	// More folders a command may read, besides the system and the project: full paths, or ~/ for the home folder.
	shellRead: [],
	// Levels of the project's file tree the agent is shown below its anchor, until it asks for another depth.
	treeDepth: 3,
	// Whether carto on a terminal takes the whole screen, with tabs. false: the plain line-by-line terminal (--plain).
	screen: true,
	// The colours of the full screen: "auto" asks the terminal what it can show; "truecolor", "256", or "none" for
	// the terminal's own sixteen colours and no backgrounds.
	colors: "auto",
	// "auto" asks the terminal for its background; "dark" or "light" says it.
	theme: "auto",
	// Building from the ground up: `write` creates a new file only, and no longer than this many lines,
	// so a project is assembled one small, exact edit at a time. Adjustable per install/project.
	writeLines: 60,
	writeCreatesOnly: true,
	// Whether change items run without asking for approval. --yolo overrides for one run; /yolo switches it
	// while carto runs, and that switch is never remembered.
	yolo: false,
	// Whether the tasks' commands run in the bubblewrap sandbox. --no-bwrap overrides for one run; /bwrap
	// switches it while carto runs, and that switch is never remembered.
	bwrap: true,
	// Whether a reply that writes the same character or phrase over and over is cut off.
	repeatCut: true,
	// Whether the server is asked how far it is with reading the prompt (llama.cpp's return_progress).
	prefill: true,
	// From how many tokens the server has to read anew the reading is shown on the screen.
	prefillTokens: 1000,
	// Minutes an `ask` waits for the user's answer before the agent is told there was none. 0: it waits without limit.
	askMinutes: 0,
	// Whether the terminal shows what the agent thinks and notes for itself when it starts. Ctrl-T switches it.
	thinking: true,
	// The context engine (src/context.mjs). Sizes are in tokens.
	// How much of the talk between the user and the agent a collapse keeps word for word.
	chatWindow: 8000,
	// How much the shelf holds: files the agent keeps in view across collapses.
	shelfTokens: 12000,
	// While the agent rests, its context is collapsed once at least this much would go.
	collapseTokens: 10000,
	// And after the user has been away this many minutes, whatever would go. 0: never for that reason.
	collapseMinutes: 5,
	// While the agent works, its context is collapsed when it is this full, in percent of contextWindow.
	collapseFull: 80,
	// Whether the collapsed context is sent to the server at once, so that it is read when the next message comes.
	readAhead: true,
});

/** Behavior-defining bounds and fixed options that are not end-user settings. Grouped by domain. */
export const POLICY = freezeTree({
	limits: {
		ledger: { textChars: 400, openEntries: 40, closedEntriesKept: 50 },
		books: { textChars: 600, items: 60, outcomeChars: 300 },
		plan: { itemChars: 300, items: 30 },
		atlas: { nameChars: 40, gistChars: 200, detailChars: 2000, nodes: 200, links: 12, files: 12, listedNodes: 40, outlineChars: 6000, bigFileBytes: 5_000_000 },
		assessment: { textChars: 3000 },
		context: { recordTokens: 3000, collapseFloorTokens: 1500, resultChars: 16_000, resultTagChars: 1200, shelfLines: 1000, shelfDiffLines: 120, summaryChars: 400, recordSummaryChars: 180, briefChars: 140, curatedRowChars: 3000, curatedRows: 80, searchPatternChars: 40, shellCommandChars: 60, operationChars: 40, bookWordsChars: 60, genericCallChars: 60, resultRows: 60, resultFirstChars: 90, keptNotesTokens: 4000, largeResultTokens: 300, usefulResultTokens: 400, reuseRatio: 8 },
		git: { errorChars: 400, maxBufferBytes: 256 * 1024 * 1024, checkoutBatchItems: 200, undoTimestampToleranceMs: 1000, checkpointBufferBytes: 64 * 1024 * 1024 },
		checkpoints: { changeRecordLines: 40, folderCollapseFiles: 3 },
		engine: { serverErrorChars: 300, handoffErrorChars: 120, noteChars: 2000, askMaxTokens: 16 },

		look: { readDefaultLines: 300, readMaxLines: 1000, readMaxFiles: 8, lineChars: 400, fileBytes: 2_000_000, binaryProbeChars: 8000, searchDefault: 60, searchMax: 200, searchHitChars: 240, listLines: 400, walkFiles: 20_000, maxBufferBytes: 64 * 1024 * 1024 },
		taskDisplay: { listedNodes: 20, staleNodes: 12 },
		taskHistory: { contextEntries: 40, recentEntries: 40, startLookupEntries: 1, apiEntryPage: 100, apiMaxPages: 50 },
		task: { noteChars: 3000, historyPageEntries: 60, settledDetailChars: 300 },
		requests: { outcomeChars: 400 },
		askChoices: { min: 2, max: 9 },
		bookTool: { refusalChars: 120, keptBookEntries: 12 },
		change: { contentBytes: 1_000_000, binaryProbeChars: 8000 },
		shellOutput: { maxBytes: 64_000, maxLines: 1000, pendingChars: 64_000 },
		windows: { open: 4, waitSeconds: 300, keptLines: 2000, outputReadDefaultLines: 40, outputReadMaxLines: 400, commandSummaryChars: 80, partialChars: 64_000, markerChars: 4200, askLineChars: 200, startupErrorLines: 3, ptyColumns: 120, ptyRows: 40, commandPreviewLines: 5 },
		wakes: { noteChars: 300, noteSummaryChars: 80, pendingChars: 200, intervalSeconds: 7 * 24 * 3600, watchedFiles: 2000, pathExamples: 3 },
		terminal: {
			wakeBurst: 12,
			diffLines: 150,
			heldInputChars: 8000,
			messageSummaryChars: 200,
			changeRecordLines: 12,
			repeatedPhraseChars: 30,
			staleNodes: 12,
			recentReports: 5,
			shellListTail: 8,
			shellBusyTail: 8,
			shellFreeTail: 4,
			callSummary: {
				taskBrief: 100, sendText: 60, waitUntil: 50, windowName: 30, shellCommand: 100,
				writePath: 90, contextOp: 70, lineRange: 20, readPaths: 90, searchPattern: 50,
				atlasCall: 100, wakeCall: 80, genericCall: 80,
			},
			resultSummary: {
				shellLast: 70, context: 110, refusal: 110, atlas: 90, search: 80, list: 80, write: 80,
				taskStream: 110, atlasWritten: 80, atlasRemoved: 60, atlasStale: 60,
				contextChange: 160, wakeChange: 160, atlasChange: 150, runFailure: 300,
				taskReason: 80, handoffFallback: 160, readAheadError: 160, reportLine: 150, windowCommand: 80,
			},
		},
		state: { freeWindowTail: 3, listedNames: 12, commandSummaryChars: 80, outputLineChars: 200 },
		loops: { sameCallFailures: 3, callKeyChars: 200, errorChars: 400, warningReplies: 3, repeatMinChars: 80, repeatPhrases: 8, repeatPhraseMaxChars: 40, repeatOverlapChars: 8 },
		wake: { timesMin: 0, timesDefault: 1 },
		tree: { maxDepth: 6, lines: 60, pathExamples: 3, listDefaultDepth: 2, branchCaps: [30, 12, 6] },
		format: { countThousands: 1000, countTenThousands: 10_000, kibibyte: 1024, mebibyte: 1024 * 1024, durationCompactAtMs: 9950, durationRoundMs: 100, durationDecimals: 1, durationTenthsPerSecond: 10, elapsedSecondPrecisionBelow: 10, rateDecimalBelow: 10, hoursBeforeDays: 48 },
		sandboxOutput: { headChars: 2000, tailChars: 8000, headLines: 40, tailLines: 160, lineChars: 1000 },
		screen: {
			listBodyRows: 400, listColumns: 200, chatLiveRows: 5, chatLiveTextRows: 8,
			chatDetailChars: 20_000, chatDetailRows: 40, chatItems: 1500, airyRows: 16,
			oscChars: 100_000, copyTimeoutMs: 3000, windowsListed: 200, shellViewLines: 400,
			contextWarnPercent: 80, wheelScrollLines: 3,
			viewSummaryChars: 70, contextSummaryChars: 160, consoleErrorChars: 300, taskErrorChars: 200, jsonLongValueChars: 80,
			activeCallChars: 50, notePreviewLines: 2, typedDraftChars: 40, rowWrapChars: 100,
		},
	},
	timing: {
		screenRefreshMs: { carto: 2000, diff: 5000, shells: 700, context: 700, fallback: 2000 },
		screen: { colorQueryMs: 500, flashMs: 4000, rateWindowMs: 1500, stateCacheMs: 1000, prefillRecentMs: 20_000, deleteConfirmMs: 6000, idleFrameMs: 1000 },
		spinnerMs: 80,
		escapeSequenceMs: 40,
		reaperPollMs: 400,
		modelCheckMs: 5000,
		gracefulExitMs: 50,
		terminal: {
			inputFlushMs: 20, taskFlushMs: 5, retryMinimumMs: 50, inputPollMs: 100,
			quitConfirmMs: 2000, shellSendWaitMs: 1000, waitDefaultSeconds: 30, settleFlushPasses: 3,
		},
		windows: {
			versionProbeMs: 5000,
			promptAfterSilenceMs: 1500,
			wakeAfterSilenceMs: 5000,
			returnAfterInputSilenceMs: 1000,
			sendWaitSeconds: 5,
			exitGraceMs: 500,
			startupTimeoutMs: 15_000,
			pollMs: 200,
			interruptWaitMs: [3000, 2000],
			tickerMs: 1000,
		},
		wakePollMs: 500,
		ledgerAgeMs: 3_600_000,
		context: { handoffQuestionSeconds: 90 },
		engine: { readAheadSeconds: 600 },
		sandbox: { toolchainProbeMs: 10_000 },
	},
	protocol: { askTemperature: 0, askStream: false, askThinking: false, noToolChoice: "none" },
	estimation: { charsPerToken: 4 },
	enums: {
		actions: ACTION,
		entryStatus: { open: "open", done: "done" },
		contextRowSpecies: { composed: "composed", curated: "curated" },
		contextVisibility: { now: "now", nextBoundary: "next-boundary" },
		ledgerKind: LEDGER_KIND,
		ledgerKinds: Object.values(LEDGER_KIND),
		planMode: PLAN_MODE,
		planModes: Object.values(PLAN_MODE),
		wakeKinds: WAKE_KIND,
		windowStates: { starting: "starting", idle: "idle", busy: "busy", closed: "closed", gone: "gone" },
		windowWaitReasons: WINDOW_WAIT_REASON,
		bookKind: BOOK_KIND,
		bookKinds: Object.values(BOOK_KIND),
		bookActions: [ACTION.add, ACTION.edit, ACTION.done, ACTION.remove, ACTION.before],
		bookName: BOOK_NAME,
		bookNames: Object.values(BOOK_NAME),
		bookToolActions: [ACTION.add, ACTION.done, ACTION.edit, ACTION.remove, ACTION.archive, ACTION.unarchive, ACTION.delete, ACTION.clear, ACTION.before, ACTION.recall, ACTION.shelve, ACTION.unshelve, ACTION.fold, ACTION.note, ACTION.collapse],
		ledgerNonGoalKinds: [LEDGER_KIND.question, LEDGER_KIND.note],
		wakeActions: [ACTION.set, ACTION.remove],
		atlasKinds: ["component", "finding", "dead_end"],
		atlasActions: { add: ACTION.add, edit: ACTION.edit, link: ACTION.link, unlink: ACTION.unlink, confirm: ACTION.confirm, remove: ACTION.remove, look: ACTION.look, tree: ACTION.tree },
		atlasAuthors: { main: "main", task: "task", user: "user" },
		shellAction: { run: ACTION.run, read: ACTION.read, wait: ACTION.wait, send: ACTION.send, stop: ACTION.stop, close: ACTION.close },
		shellActions: [ACTION.run, ACTION.read, ACTION.wait, ACTION.send, ACTION.stop, ACTION.close],
		toolReplay: { safe: "safe", never: "never", unsafe: "unsafe" },
		colors: ["auto", "truecolor", "256", "none"],
		themes: ["auto", "dark", "light"],
		lookSkipDirs: [".git", "node_modules"],
		wakeSkipDirs: [".git", BRAIN_DIR, "node_modules"],
		sandboxHiddenDirs: ["/tmp", "/var/tmp", "/run", "/mnt", "/media"],
	},
	idPrefixes: {
		report: "t",
		ledger: { goal: "g", question: "q", note: "n" },
		plan: "p",
		wake: "w",
		books: { assessment: "a", practice: "r" },
		taskStep: "s",
		contextRow: "c",
	},
	patterns: {
		windowName: "^[a-z][a-z0-9_-]{0,19}$",
		reportId: "^t\\d+$",
		contextRowId: "^c\\d+$",
		ledgerId: "^[gqn]\\d+$",
		planId: "^p\\d+$",
		questionId: "^q\\d+$",
		wakeIdOrAll: "^(all|w[0-9]+)$",
		keptReport: "This report is kept as (t\\d+)\\.",
		recalledReport: "^Report (t\\d+) · ",
	},
	markup: {
		context: { open: "<context>", close: "</context>" },
		project: { open: "<project>", close: "</project>" },
		state: { open: "<state>", close: "</state>" },
		windows: { open: "<windows>", close: "</windows>" },
		note: { open: "<cartographer>", close: "</cartographer>" },
	},
	control: {
		terminate: Object.freeze({ terminate: true }),
		windowGoneReason: "it ended when Cartographer last exited",
		windowKilledReason: "the user closed it with /kill",
		restingMessage: "Resting.",
	},
	sentinels: { mainWindow: "main", sandboxHome: "home", brainDir: BRAIN_DIR, reportHeading: "REPORT", windowMark: "\x1e", windowSeparator: "\x1f" },
	validation: {
		positiveIntegerMin: 1,
		nonEmptyStringMinLength: 1,
		nonEmptyArrayMinItems: 1,
		planIdMinLength: 2,
		minimumTokenSetting: 500,
		reservedContextDivisor: 2,
		collapsePercent: { min: 30, max: 95 },
		windowTailMax: 40,
		writeLinesMin: 1,
		nonNegativeMin: 0,
		prefillTokensMin: 0,
	},
});

export class ConfigError extends Error {}

function readJson(path) {
	if (!existsSync(path)) return {};
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("it must hold one JSON object");
		return value;
	} catch (error) {
		throw new ConfigError(`${path} cannot be read: ${error.message}`);
	}
}

/**
 * @param {{ brainDir: string, flags: { url?: string, model?: string }, env?: NodeJS.ProcessEnv }} input
 */
export function loadConfig({ brainDir, flags, env = process.env }) {
	// The install's settings stand next to the code; CARTO_CONFIG names another file in their place, so that a
	// checkout with settings of its own (the tests, or a second install sharing one copy) can read none at all.
	const corePath = env.CARTO_CONFIG ? env.CARTO_CONFIG : join(CORE_DIR, "config.json");
	const projectPath = join(brainDir, "config.json");
	const config = {
		...DEFAULTS,
		shellRead: [...DEFAULTS.shellRead],
		...readJson(corePath),
		...readJson(projectPath),
		...(env.CARTO_SERVER ? { server: env.CARTO_SERVER } : {}),
		...(env.CARTO_MODEL ? { model: env.CARTO_MODEL } : {}),
		...(flags.url ? { server: flags.url } : {}),
		...(flags.model ? { model: flags.model } : {}),
	};
	// The write limit may be overridden for one run (the stand-in tests exercise the old create-or-replace
	// behaviour, so they relax it); real runs keep the strict default above.
	if (env.CARTO_WRITE_LINES !== undefined && env.CARTO_WRITE_LINES !== "") config.writeLines = Number(env.CARTO_WRITE_LINES);
	if (env.CARTO_WRITE_CREATES_ONLY !== undefined && env.CARTO_WRITE_CREATES_ONLY !== "") config.writeCreatesOnly = env.CARTO_WRITE_CREATES_ONLY === "1" || env.CARTO_WRITE_CREATES_ONLY === "true";
	if (typeof config.server !== "string" || typeof config.model !== "string") {
		throw new ConfigError(
			[
				"No model server is configured.",
				`Put this in ${corePath} (the port and model are yours to change):`,
				'  { "server": "http://127.0.0.1:8888/v1", "model": "ByteShape" }',
				"or pass --url and --model.",
			].join("\n"),
		);
	}
	config.server = config.server.replace(/\/+$/, "");
	for (const key of ["contextWindow", "maxTokens", "mainTurns", "taskTurns", "shellWait", "treeDepth", "windowTail", "wakeMin", "wakesMax"]) {
		if (!Number.isInteger(config[key]) || config[key] < POLICY.validation.positiveIntegerMin) throw new ConfigError(`config: ${key} must be a whole number, ${POLICY.validation.positiveIntegerMin} or more`);
	}
	for (const key of ["chatWindow", "shelfTokens", "collapseTokens"]) {
		if (!Number.isInteger(config[key]) || config[key] < POLICY.validation.minimumTokenSetting) throw new ConfigError(`config: ${key} must be a whole number of tokens, ${POLICY.validation.minimumTokenSetting} or more`);
	}
	if (config.chatWindow + config.shelfTokens > config.contextWindow / POLICY.validation.reservedContextDivisor) throw new ConfigError("config: chatWindow and shelfTokens together must not be more than half of contextWindow");
	if (typeof config.collapseMinutes !== "number" || !(config.collapseMinutes >= POLICY.validation.nonNegativeMin)) throw new ConfigError(`config: collapseMinutes must be a number of minutes, ${POLICY.validation.nonNegativeMin} or more`);
	if (!Number.isInteger(config.collapseFull) || config.collapseFull < POLICY.validation.collapsePercent.min || config.collapseFull > POLICY.validation.collapsePercent.max) throw new ConfigError(`config: collapseFull must be a whole number from ${POLICY.validation.collapsePercent.min} to ${POLICY.validation.collapsePercent.max} (percent)`);
	for (const key of ["screen", "repeatCut", "prefill", "writeCreatesOnly", "yolo", "bwrap"]) if (typeof config[key] !== "boolean") throw new ConfigError(`config: ${key} must be true or false`);
	if (!Number.isInteger(config.writeLines) || config.writeLines < POLICY.validation.writeLinesMin) throw new ConfigError(`config: writeLines must be a whole number of lines, ${POLICY.validation.writeLinesMin} or more`);
	if (!POLICY.enums.colors.includes(config.colors)) throw new ConfigError(`config: colors must be ${POLICY.enums.colors.slice(0, -1).map((color) => JSON.stringify(color)).join(", ")} or ${JSON.stringify(POLICY.enums.colors.at(-1))}`);
	if (!POLICY.enums.themes.includes(config.theme)) throw new ConfigError(`config: theme must be ${POLICY.enums.themes.slice(0, -1).map((theme) => JSON.stringify(theme)).join(", ")} or ${JSON.stringify(POLICY.enums.themes.at(-1))}`);
	if (!Number.isInteger(config.prefillTokens) || config.prefillTokens < POLICY.validation.prefillTokensMin) throw new ConfigError(`config: prefillTokens must be a whole number of tokens, ${POLICY.validation.prefillTokensMin} or more`);
	if (typeof config.askMinutes !== "number" || !(config.askMinutes >= POLICY.validation.nonNegativeMin)) throw new ConfigError(`config: askMinutes must be a number of minutes, ${POLICY.validation.nonNegativeMin} or more`);
	if (typeof config.readAhead !== "boolean") throw new ConfigError("config: readAhead must be true or false");
	if (config.windowTail > POLICY.validation.windowTailMax) throw new ConfigError(`config: windowTail must be a whole number from ${POLICY.validation.positiveIntegerMin} to ${POLICY.validation.windowTailMax}`);
	if (config.treeDepth > POLICY.limits.tree.maxDepth) throw new ConfigError(`config: treeDepth must be a whole number from ${POLICY.validation.positiveIntegerMin} to ${POLICY.limits.tree.maxDepth}`);
	if (typeof config.thinking !== "boolean") throw new ConfigError("config: thinking must be true or false");
	if (!Array.isArray(config.shellRead) || config.shellRead.some((path) => typeof path !== "string" || !/^(\/|~\/)/.test(path))) {
		throw new ConfigError('config: shellRead must be a list of folders, each a full path or starting with ~/');
	}
	return config;
}
