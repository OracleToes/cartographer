// `carto`, run from a project folder.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, CORE_DIR, loadConfig } from "./config.mjs";
import { createInterface } from "node:readline";
import { BRAIN, checkProject, findProject, hasBrain, lockBrain, ProjectError, setUpBrain } from "./project.mjs";

const HELP = `carto: Cartographer, run from a project folder.

  carto                 start, or continue, the session of this project
  carto -p "message"    send one message, print the answer, leave
  carto --where         show which folders it would use, and do nothing

  --url URL             model server for this run (an OpenAI-compatible /v1 address)
  --model NAME          model name for this run
  --here                treat the current folder as the project, whatever is above it
  --no-bwrap            run the tasks' commands without the sandbox: directly on this
                        machine, as you, able to reach whatever you can. Also: /bwrap
  --yolo                let the agent carry out change items without /approve, also
                        ones that use the network. For when you are watching. Also: /yolo
  --plain               the line-by-line terminal instead of the full screen with tabs
                        (the default whenever input or output is not a terminal)
  --version, --help

The project is the first folder, going up from where you are, that has a brain or is
the top of a git repository; else the current folder. The home folder is never picked
that way. The project's brain lives in <project>/${BRAIN}/.
Settings: ${join(CORE_DIR, "config.json")}, overridden by <project>/${BRAIN}/config.json.`;

function parse(argv) {
	const flags = {};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			if (argv[i + 1] === undefined) throw new ConfigError(`${arg} needs a value`);
			return argv[++i];
		};
		if (arg === "--url") flags.url = value();
		else if (arg === "--model") flags.model = value();
		else if (arg === "-p" || arg === "--print") flags.message = value();
		else if (arg === "--here") flags.here = true;
		else if (arg === "--no-bwrap") flags.noBwrap = true;
		else if (arg === "--yolo") flags.yolo = true;
		else if (arg === "--plain") flags.plain = true;
		else if (arg === "--where") flags.where = true;
		else if (arg === "--help" || arg === "-h") flags.help = true;
		else if (arg === "--version" || arg === "-v") flags.version = true;
		else if (arg.startsWith("-")) throw new ConfigError(`Unknown option ${arg}. carto --help lists the options.`);
		else rest.push(arg);
	}
	if (rest.length > 0) throw new ConfigError(`Unexpected "${rest[0]}". To send one message use: carto -p "your message"`);
	return flags;
}

/**
 * Ask the server which models it has, so a wrong address or name fails here with a plain message.
 * @returns {Promise<number | undefined>} the context size the server reports for the model, when it reports one
 */
async function checkServer(config) {
	let response;
	try {
		response = await fetch(`${config.server}/models`, { signal: AbortSignal.timeout(5000) });
	} catch (error) {
		throw new ConfigError(`The model server at ${config.server} does not answer (${error.cause?.code ?? error.message}). Is it running?`);
	}
	if (!response.ok) return undefined; // Not every server lists its models; the first request will tell.
	const body = await response.json().catch(() => undefined);
	const listed = (body?.data ?? []).filter((entry) => typeof entry?.id === "string");
	const match = listed.find((entry) => entry.id === config.model);
	// A llama-server run on its own lists its one model by file name and answers to any name.
	const lone = listed.length === 1 && listed[0].owned_by === "llamacpp" ? listed[0] : undefined;
	if (listed.length > 0 && match === undefined && lone === undefined) {
		throw new ConfigError(`The model server has no model named "${config.model}". It has: ${listed.map((entry) => entry.id).join(", ")}.`);
	}
	const size = (match ?? lone)?.meta?.n_ctx;
	return Number.isInteger(size) && size > 0 ? size : undefined;
}

/** Ask one question on the terminal. Ctrl-C and Ctrl-D count as "no". */
function confirm(question) {
	return new Promise((done) => {
		const ask = createInterface({ input: process.stdin, output: process.stdout });
		// Settle first: close() fires the "close" listener below, which would answer "no".
		const finish = (answer) => {
			done(answer.trim().toLowerCase());
			ask.close();
		};
		ask.on("line", finish);
		ask.on("SIGINT", () => {
			process.stdout.write("\n");
			finish("n");
		});
		ask.on("close", () => done("n"));
		ask.setPrompt(question);
		ask.prompt();
	});
}

export async function main(argv) {
	let release = () => {};
	let session;
	try {
		const flags = parse(argv);
		if (flags.help) return void console.log(HELP);
		if (flags.version) return void console.log(JSON.parse(readFileSync(join(CORE_DIR, "package.json"), "utf8")).version);

		const project = flags.here ? { root: realpathSync(process.cwd()), why: "here" } : findProject(process.cwd());
		const brainPath = join(project.root, BRAIN);
		const isNew = !hasBrain(project.root);
		if (flags.where) {
			let refused = false;
			try {
				checkProject(project.root, { allowHome: flags.here === true });
			} catch {
				refused = true;
			}
			const why = refused ? "refused without --here: not a project folder" : flags.here ? "--here" : { brain: "the nearest folder with a brain", git: "the top of the git repository", here: "the current folder; no brain or git repository above it" }[project.why];
			console.log(`core     ${CORE_DIR}`);
			console.log(`project  ${project.root}  (${why})`);
			console.log(`brain    ${brainPath}${isNew ? "  (not set up yet)" : ""}`);
			return;
		}
		checkProject(project.root, { allowHome: flags.here === true });
		// Settings and server are checked first, so a run that cannot start leaves nothing behind in the project.
		const config = loadConfig({ brainDir: brainPath, flags });
		const serverContext = await checkServer(config);
		let contextNote = "";
		if (serverContext !== undefined && serverContext < config.contextWindow) {
			contextNote = ` · context ${serverContext} tokens (the server's limit; the settings say ${config.contextWindow})`;
			config.contextWindow = serverContext;
		}
		const interactive = flags.message === undefined && process.stdin.isTTY === true;
		// A brain in the wrong folder is easy to make and annoying to notice later, so the first time is confirmed.
		if (isNew && interactive) {
			const answer = await confirm(`No brain for this project yet. Set one up in ${brainPath}? [Y/n] `);
			if (answer !== "" && answer !== "y" && answer !== "yes") {
				console.log("Nothing was set up. To use the folder you are in as the project, run carto --here.");
				return;
			}
		}
		const { brainDir, created } = setUpBrain(project.root);
		release = lockBrain(brainDir);
		const { adoptOldLedger } = await import("./ledger.mjs");
		const adopted = adoptOldLedger(brainDir);

		// The full screen takes the terminal over, so what is said before it opens is said again inside it.
		const fullScreen = interactive && process.stdout.isTTY === true && flags.plain !== true && config.screen !== false && process.env.TERM !== "dumb";
		const intro = [];
		const say = (text) => {
			intro.push(text);
			console.log(text);
		};
		say(`Cartographer · ${project.root}`);
		say(`${created ? "new brain" : "brain"} ${brainPath} · ${config.model} at ${config.server}${contextNote}`);
		const { createRunner, sandboxLine } = await import("./sandbox.mjs");
		const { YOLO_LINE } = await import("./plan.mjs");
		const runner = createRunner({ off: flags.noBwrap === true });
		say(sandboxLine(runner));
		// Whether change items run without /approve. Never read from a file: the user says it anew at each start.
		const gate = { yolo: flags.yolo === true };
		if (gate.yolo) say(YOLO_LINE);
		if (adopted) say("The ledger file ledger.json is now carto-ledger.json; its entries are unchanged.");

		// Loaded here, so --help and a wrong setting answer at once.
		const { openSession } = await import("./harness.mjs");
		const { runTerminal } = await import("./terminal.mjs");
		session = await openSession({ root: project.root, brainDir, config, runner, gate });
		const run = fullScreen ? async (given, options) => (await import("./screen/app.mjs")).runScreen(given, { ...options, intro }, runTerminal) : runTerminal;
		const code = await run(session, {
			input: process.stdin,
			output: process.stdout,
			interactive,
			contextWindow: config.contextWindow,
			config,
			root: project.root,
			brainDir,
			runner,
			gate,
			wakeMin: config.wakeMin,
			treeDepth: config.treeDepth,
			thinking: config.thinking !== false,
			oneShot: flags.message,
		});
		process.exitCode = code;
	} catch (error) {
		if (error instanceof ConfigError || error instanceof ProjectError) console.error(error.message);
		else console.error(error);
		process.exitCode = 1;
	} finally {
		release();
		// Work that is still running is not waited for: it is stored, and continues at the next start.
		// The shell windows are ended by the process's exit (src/windows.mjs), not closed here: closing would
		// clear the record that lets the next start say which windows were running something and are gone.
		setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
		if (session !== undefined) await session.harness.close(session.context).catch(() => {});
		process.exit(process.exitCode ?? 0);
	}
}
