// Settings: where the model server is and which model to use.
//
// Read in this order, later ones winning:
//   1. defaults
//   2. <core>/config.json            the install's settings, shared by every project
//   3. <project>/.atlas/config.json  one project's own settings
//   4. CARTO_SERVER, CARTO_MODEL     environment
//   5. --url, --model                command line
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The core folder: where Cartographer is installed. Every project runs this one copy. */
export const CORE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const DEFAULTS = {
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
};

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
	const corePath = join(CORE_DIR, "config.json");
	const projectPath = join(brainDir, "config.json");
	const config = {
		...DEFAULTS,
		...readJson(corePath),
		...readJson(projectPath),
		...(env.CARTO_SERVER ? { server: env.CARTO_SERVER } : {}),
		...(env.CARTO_MODEL ? { model: env.CARTO_MODEL } : {}),
		...(flags.url ? { server: flags.url } : {}),
		...(flags.model ? { model: flags.model } : {}),
	};
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
		if (!Number.isInteger(config[key]) || config[key] < 1) throw new ConfigError(`config: ${key} must be a whole number, 1 or more`);
	}
	for (const key of ["chatWindow", "shelfTokens", "collapseTokens"]) {
		if (!Number.isInteger(config[key]) || config[key] < 500) throw new ConfigError(`config: ${key} must be a whole number of tokens, 500 or more`);
	}
	if (config.chatWindow + config.shelfTokens > config.contextWindow / 2) throw new ConfigError("config: chatWindow and shelfTokens together must not be more than half of contextWindow");
	if (typeof config.collapseMinutes !== "number" || !(config.collapseMinutes >= 0)) throw new ConfigError("config: collapseMinutes must be a number of minutes, 0 or more");
	if (!Number.isInteger(config.collapseFull) || config.collapseFull < 30 || config.collapseFull > 95) throw new ConfigError("config: collapseFull must be a whole number from 30 to 95 (percent)");
	for (const key of ["screen", "repeatCut", "prefill"]) if (typeof config[key] !== "boolean") throw new ConfigError(`config: ${key} must be true or false`);
	if (!["auto", "truecolor", "256", "none"].includes(config.colors)) throw new ConfigError('config: colors must be "auto", "truecolor", "256" or "none"');
	if (!["auto", "dark", "light"].includes(config.theme)) throw new ConfigError('config: theme must be "auto", "dark" or "light"');
	if (!Number.isInteger(config.prefillTokens) || config.prefillTokens < 0) throw new ConfigError("config: prefillTokens must be a whole number of tokens, 0 or more");
	if (typeof config.askMinutes !== "number" || !(config.askMinutes >= 0)) throw new ConfigError("config: askMinutes must be a number of minutes, 0 or more");
	if (typeof config.readAhead !== "boolean") throw new ConfigError("config: readAhead must be true or false");
	if (config.windowTail > 40) throw new ConfigError("config: windowTail must be a whole number from 1 to 40");
	if (config.treeDepth > 6) throw new ConfigError("config: treeDepth must be a whole number from 1 to 6");
	if (typeof config.thinking !== "boolean") throw new ConfigError("config: thinking must be true or false");
	if (!Array.isArray(config.shellRead) || config.shellRead.some((path) => typeof path !== "string" || !/^(\/|~\/)/.test(path))) {
		throw new ConfigError('config: shellRead must be a list of folders, each a full path or starting with ~/');
	}
	return config;
}
