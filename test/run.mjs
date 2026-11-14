// Tests: install layout, launch, the brain folder, chat, tasks, the ledger, the plan, checkpoints, shell windows, the atlas, the assessment, time,
// wakes, approval switched off, standing items and the context engine.
// They run the real `carto` command in throwaway project folders against the stand-in
// server (test/stand-in.mjs), so no model is needed.
//
//   npm test            (about three and a half minutes)
//   npm test -- kill    only tests whose name contains "kill"
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addRecord, archiveReports, deleteReports, droppable, dressTask, foldReports, KEPT_AS, loadContext, parseLines, recallReport, ShelfError, shelfLabel, shelveForUser, reviseNote, stepsOf, supersededBy, unarchiveReports, unshelveForUser, updateContext, writeFront, withoutTags } from "../src/context.mjs";
import { TASK_HEADER } from "../src/prompt.mjs";
import { changeRecord, changesBetween, checkpoint, isIgnored, lastChange, undo } from "../src/checkpoints.mjs";
import { ASSESSMENT_MAX, saveAssessment } from "../src/assessment.mjs";
import { applyAtlasOp, AtlasError, DETAIL_MAX, GIST_MAX, loadAtlas, nodeChanges, nodeHashes, NODES_MAX, renderOutline, saveAtlas, staleNodes } from "../src/atlas.mjs";
import { applyOp, LedgerError, loadLedger, OPEN_MAX, renderLedger, saveLedger, TEXT_MAX } from "../src/ledger.mjs";
import { applyPlanOp, authorize, ITEM_MAX, loadPlan, openOnce, PlanError, planSummary, renderPlan, savePlan, YOLO_LINE } from "../src/plan.mjs";
import { withoutAdditions, withTimes } from "../src/request.mjs";
import { stateBlock, windowsBlock, withoutState, withoutWindows, withState } from "../src/state.mjs";
import { ago, STAMP, stamp, took } from "../src/time.mjs";
import { loadTop, noteAssessed, pin, sinceTop, topPath, withoutTop, withTop } from "../src/top.mjs";
import { drawTree, treeSection } from "../src/tree.mjs";
import { atlasTool } from "../src/tools/atlas.mjs";
import { ChangeError, confineWrite, editOne, writeOne } from "../src/tools/change.mjs";
import { bookTool } from "../src/tools/book.mjs";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { confine, listProject, LookError, projectFiles, readOne, searchProject } from "../src/tools/look.mjs";
import { findProject, setUpBrain } from "../src/project.mjs";
import { findSandbox, HEAD_LINES, HEAD_MAX, LINE_MAX, Output, TAIL_LINES, TAIL_MAX } from "../src/sandbox.mjs";
import { describeCall, describeResult, WAKE_BURST } from "../src/terminal.mjs";
import { isNote, wakeNote, withoutQuietWakes } from "../src/wake.mjs";
import { createWakes, NOTE_MAX, WakeError, wakesPath, WAKES_MAX } from "../src/wakes.mjs";
import { createWindows, findScript, KEEP_LINES, WindowError } from "../src/windows.mjs";
import { startStandIn } from "./stand-in.mjs";

const CORE = dirname(dirname(fileURLToPath(import.meta.url)));
const CARTO = join(CORE, "bin", "carto");
// The stand-in's briefs were written before the mechanical `write` limit (src/config.mjs): they replace
// whole files again and again. Relax that strict default for every child carto this test file spawns,
// including the direct spawns in the kill tests. Tests of the limit itself pass CARTO_WRITE_* in `env`
// to turn it back on for one run.
process.env.CARTO_WRITE_LINES ??= "1000000";
process.env.CARTO_WRITE_CREATES_ONLY ??= "0";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "carto-test-")));
// The tests must not read the install's own settings: this checkout may hold a config.json of the user's own
// (yolo, bwrap, the context window), which turned half the suite red on such an install. Every carto these
// tests spawn reads an empty one instead, so the defaults are what is under test.
const EMPTY_CONFIG = join(scratch, "empty-config.json");
writeFileSync(EMPTY_CONFIG, "{}\n");
process.env.CARTO_CONFIG = EMPTY_CONFIG;
let only; // a substring filter: `node test/run.mjs ledger` runs the tests whose names hold it
// How many tests run beside each other: --jobs N (or -j N, or CARTO_TEST_JOBS), else one per core to a cap of 8.
// Tests wait on the machine most of the time, so several at once are safe; the waits that measure it get SLOW,
// the same factor, so that a loaded run is not failed by a clock.
let jobsArg;
{
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--jobs" || argv[i] === "-j") jobsArg = Number(argv[++i]);
		else if (argv[i].startsWith("--jobs=")) jobsArg = Number(argv[i].slice("--jobs=".length));
		else if (only === undefined) only = argv[i];
	}
}
const JOBS = Number.isInteger(jobsArg) && jobsArg >= 1 ? jobsArg : Math.min(8, Math.max(1, availableParallelism() - 1));
const SLOW = 1 + (JOBS - 1) * 0.5;
process.env.CARTO_TEST_SLOW = String(SLOW);

const tests = [];
/** A test that must run with no other test beside it takes `{ alone: true }`: it changes something that
 * every other test reads while it runs — one swaps this process's environment for its shell windows. */
const test = (name, run, { alone = false } = {}) => tests.push({ name, run, alone });

/** A throwaway project with a few files. `git: true` makes it a repository.
 * Tests that run beside each other must not share a folder (a project holds a lock, and its brain one
 * session), so a name a second test asks for gets a number: three tests say "kill", each has its own. */
const projectCounts = new Map();
function makeProject(name, { git = true } = {}) {
	const seen = projectCounts.get(name) ?? 0;
	projectCounts.set(name, seen + 1);
	const root = join(scratch, seen === 0 ? name : `${name}-${seen + 1}`);
	mkdirSync(join(root, "src", "deep", "er"), { recursive: true });
	writeFileSync(join(root, "README.md"), "# Demo project\nA small thing for tests.\n");
	writeFileSync(join(root, "src", "math.js"), "export function add(a, b) {\n  // MARKER-ONLY-IN-FILE\n  return a + b;\n}\n");
	writeFileSync(join(root, "src", "main.js"), 'import { add } from "./math.js";\nconsole.log(add(1, 2));\n');
	writeFileSync(join(root, "src", "deep", "er", "leaf.txt"), "leaf\n");
	writeFileSync(join(root, "long.txt"), Array.from({ length: 700 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
	if (git) {
		writeFileSync(join(root, ".gitignore"), "ignored.log\n");
		writeFileSync(join(root, "ignored.log"), "add add add\n");
	}
	return root;
}

/**
 * Run a command to its end. `carto` is started through Node rather than directly, so the tests do not depend on the
 * file's executable permission, which a download or an unpacked archive may not keep. One test checks the permission.
 */
function run(command, args, { cwd, env = {}, input, timeoutMs = 30_000, throughNode = command === CARTO } = {}) {
	return new Promise((resolve) => {
		if (throughNode) [command, args] = [process.execPath, [command, ...args]];
		const child = spawn(command, args, { cwd, env: { ...process.env, CARTO_SERVER: "", CARTO_MODEL: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs * SLOW);
		// A command that cannot be started at all is a result like any other, not a crash of the test run.
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: -1, signal: null, stdout, stderr: `${stderr}could not start ${command}: ${error.message}\n`, all: `${stdout}${stderr}could not start ${command}: ${error.message}\n` });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr, all: stdout + stderr });
		});
		// A child that exits before reading its input closes the pipe; that is not a test failure.
		child.stdin.on("error", () => {});
		child.stdin.end(input ?? "");
	});
}

const git = (cwd, ...args) => run("git", args, { cwd });

/** `carto` in `cwd`, against a stand-in server. */
const carto = (cwd, server, args = [], options = {}) =>
	run(CARTO, [...(server ? ["--url", server.url, "--model", "stand-in"] : []), ...args], { cwd, ...options });

/**
 * `carto` on a terminal of its own, which is the only way to see what it asks an interactive user. Each step waits
 * for a text to appear on the screen (or, given a number, that many seconds), then types a line. Needs python3 for the terminal; resolves undefined without it.
 */
const PTY = `
import json, os, pty, select, sys, time
steps = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
seen = b""
def pump(until, limit):
    global seen
    end = time.time() + limit
    while time.time() < end:
        if until is not None and until.encode() in seen: return True
        if select.select([fd], [], [], 0.05)[0]:
            try: seen += os.read(fd, 65536)
            except OSError: return until is None
    return False
for step in steps:
    wait, text = step[0], step[1]
    if isinstance(wait, (int, float)): pump(None, wait)
    elif not pump(wait, 20): break
    # A third entry that is false: the keys alone, without Enter after them.
    os.write(fd, text.encode() + (b"" if len(step) > 2 and not step[2] else b"\\r"))
pump(None, 20)
sys.stdout.write(seen.decode(errors="replace"))
`;
let python;
async function cartoOnTerminal(cwd, server, args, steps) {
	python ??= (await run("python3", ["-c", "import pty"])).code === 0;
	if (!python) return undefined;
	// The line-by-line terminal, unless the test is about the full screen.
	const command = [process.execPath, CARTO, "--url", server.url, "--model", "stand-in", ...(args.includes("--screen") ? args.filter((arg) => arg !== "--screen") : ["--plain", ...args])];
	const result = await run("python3", ["-c", PTY, JSON.stringify(steps), ...command], { cwd, timeoutMs: 70_000 });
	// Colour codes and carriage returns are the terminal's business, not the test's.
	return { ...result, screen: result.stdout.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "") };
}

/**
 * Run carto in its full screen on a terminal of the given size, and read the screen as a person would: test/vt.py
 * keeps the grid of characters that the escape sequences paint. A step is [wait, keys] or [wait, keys, false]:
 * `wait` is text that must stand on the screen (or a number of seconds), then the keys are typed, with Enter after
 * them unless the third entry is false. <UP> <DOWN> <ENTER> <TAB> <ESC> <PGUP> <CTRLT> <CTRLC> <CTRLD> <CTRLJ> are keys,
 * <NL> is a line end inside what is typed at once, and <PASTE>…</PASTE> is text the terminal marks as pasted.
 * @returns {Promise<undefined | { shots: string[], last: string, after: string, osc: string[], alt: boolean, modes: string[], painted: { text: string, edge: string | null, bg: string | null, mid: string | null }[] }>}
 *   shots: the screen at each wait; alt: whether the alternate screen is still on at the end; modes: the terminal modes left on;
 *   painted: the last screen row by row, with the background colour at its very edge, inside the margin, and in the middle
 */
async function cartoOnScreen(cwd, server, args, steps, { rows = 24, cols = 100, env = {} } = {}) {
	python ??= (await run("python3", ["-c", "import pty"])).code === 0;
	if (!python) return undefined;
	const command = [process.execPath, CARTO, "--url", server.url, "--model", "stand-in", ...args];
	const result = await run("python3", [join(dirname(fileURLToPath(import.meta.url)), "vt.py"), String(rows), String(cols), JSON.stringify(steps), ...command], { cwd, env, timeoutMs: 90_000 });
	let parsed;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error(`the screen could not be read:\n${result.all}`);
	}
	// The screen has an empty margin of two cells at its left edge: the tests read what stands between the margins.
	const inside = (shot) => shot.split("\n").map((line) => (line.startsWith("  ") ? line.slice(2) : line)).join("\n");
	const shots = parsed.shots.map(inside);
	return { ...parsed, shots, last: shots.at(-1) };
}

const ok = (result, what) => assert.equal(result.code, 0, `${what}: carto should exit 0, got ${result.code} ${result.signal ?? ""}\n${result.all}`);
const has = (text, part, what) => assert.ok(text.includes(part), `${what}: expected to find ${JSON.stringify(part)} in:\n${text}`);
const hasNot = (text, part, what) => assert.ok(!text.includes(part), `${what}: did not expect ${JSON.stringify(part)} in:\n${text}`);
/** A message's text as the server received it, state block included. */
const rawText = (message) => (typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join(""));
/** A message's text as it is stored in the conversation: without what Cartographer adds to a request on its way out. */
const messageText = (message) => withoutAdditions(rawText(message));
/** The state block a request carried, or undefined. */
const stateOf = (request) => /<state>\nWritten by Cartographer[\s\S]*\n<\/state>/.exec(rawText(request.messages.at(-1)))?.[0];
/** The windows block a request carried at its very end, or undefined. */
const windowsIn = (request) => /<windows>\nWritten by Cartographer[\s\S]*\n<\/windows>$/.exec(rawText(request.messages.at(-1)))?.[0];
/** How many windows blocks a request holds in all its messages. */
const windowsCount = (request) => request.messages.map(rawText).join("\n").split("<windows>\nWritten by Cartographer").length - 1;
/** The state block without its "Commands" paragraph, which is there only when commands do not run in the sandbox. */
const ledgerState = (request) => stateOf(request)?.replace(/\nCommands\n[^\n]*\n\n/, "\n");
/** How many state blocks a request holds in all its messages. */
const stateCount = (request) => request.messages.map(rawText).join("\n").split("<state>\nWritten by Cartographer").length - 1;
/**
 * A request's messages as every later request sends them again: without the state block and the windows block, which
 * only the last message of a request carries. What is added in front and the times stay, since they must be the same every time.
 */
const withoutTail = (text) => withoutState(withoutWindows(text));
const stored = (request) => request.messages.map((message) => (rawText(message) !== withoutTail(rawText(message)) ? { ...message, content: withoutTail(rawText(message)) } : message));

/** What the tests tell the stand-in to write to the ledger. */
const GOAL = { action: "add", kind: "goal", text: "Make the dashboard multi-player", done_when: "Two players can log in at once" };
const ledgerMessage = (...ops) => `ledger: ${JSON.stringify(ops)}`;

// ─── Launch and the brain folder ────────────────────────────────────────────

test("launch: --where from a subfolder of a repository names the repository, and creates nothing", async () => {
	const root = makeProject("where");
	await git(root, "init", "-q");
	const result = await carto(join(root, "src", "deep"), undefined, ["--where"]);
	ok(result, "--where");
	has(result.stdout, `core     ${CORE}`, "core folder");
	has(result.stdout, `project  ${root}  (the top of the git repository)`, "project folder");
	has(result.stdout, `brain    ${join(root, ".atlas")}  (not set up yet)`, "brain folder");
	assert.ok(!existsSync(join(root, ".atlas")), "--where must not create the brain");
});

test("install: bin/carto may be executed", () => {
	try {
		accessSync(CARTO, constants.X_OK);
	} catch {
		assert.fail(`${CARTO} is not marked executable, so the carto command cannot start (a download does not keep that mark).\nFix: bash ${join(CORE, "install.sh")}   (or: chmod +x ${CARTO})`);
	}
});

test("launch: the command works through a symlink, as install.sh sets it up", async () => {
	const root = makeProject("symlink");
	const bin = join(scratch, "bin");
	mkdirSync(bin, { recursive: true });
	symlinkSync(CARTO, join(bin, "carto"));
	const result = await run(join(bin, "carto"), ["--where"], { cwd: root, throughNode: true });
	ok(result, "carto through a symlink");
	has(result.stdout, `core     ${CORE}`, "the core folder is the real one, not the symlink's");
});

test("launch: without settings it says how to configure, and leaves nothing in the project", async () => {
	const root = makeProject("no-config");
	// This test's own config: a file that is not there, whatever the install has.
	const noConfig = join(scratch, "no-such-config.json");
	const result = await carto(root, undefined, [], { env: { CARTO_SERVER: "", CARTO_MODEL: "", CARTO_CONFIG: noConfig } });
	assert.equal(result.code, 1, `expected exit 1:\n${result.all}`);
	has(result.stderr, "No model server is configured.", "message");
	has(result.stderr, noConfig, "names the file to write");
	assert.ok(!existsSync(join(root, ".atlas")), "a run that cannot start must not create the brain");
});

test("launch: a server that does not answer is reported plainly", async () => {
	const root = makeProject("no-server");
	const result = await carto(root, undefined, ["--url", "http://127.0.0.1:9/v1", "--model", "x"]);
	assert.equal(result.code, 1, `expected exit 1:\n${result.all}`);
	has(result.stderr, "The model server at http://127.0.0.1:9/v1 does not answer", "message");
	assert.ok(!existsSync(join(root, ".atlas")), "a run that cannot start must not create the brain");
});

test("launch: a model name the server does not have is reported with the names it has", async () => {
	const root = makeProject("wrong-model");
	const server = await startStandIn({ models: ["ByteShape", "other"] });
	try {
		const result = await run(CARTO, ["--url", server.url, "--model", "Byteshape"], { cwd: root });
		assert.equal(result.code, 1, `expected exit 1:\n${result.all}`);
		has(result.stderr, 'has no model named "Byteshape". It has: ByteShape, other.', "message");
	} finally {
		await server.close();
	}
});

test("launch: a llama-server run on its own answers to any name, and its context size is used when smaller", async () => {
	const root = makeProject("lone-server", { git: false });
	const server = await startStandIn({ models: [{ id: "../some-file.gguf", object: "model", owned_by: "llamacpp", meta: { n_ctx: 8192 } }] });
	try {
		const result = await run(CARTO, ["--url", server.url, "--model", "anything", "-p", "say: hi"], { cwd: root });
		ok(result, "a name the lone server does not list");
		has(result.stdout, "context 8192 tokens (the server's limit; the settings say 100000)", "the smaller context size is used and stated");
		has(result.stdout, "of 8.2k tokens", "and shown in the context line");
	} finally {
		await server.close();
	}
});

test("task: the main agent is told when it runs out of turns", async () => {
	const root = makeProject("main-turns", { git: false });
	mkdirSync(join(root, ".atlas"));
	writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ mainTurns: 1 }));
	const server = await startStandIn();
	try {
		const result = await carto(root, server, ["-p", "task: list:"]);
		has(result.stdout, "! The agent used all its turns for this message", "the terminal says so");
		has(result.stdout, 'Say "continue" to let it go on.', "and what to do");
	} finally {
		await server.close();
	}
});

test("launch: the home folder is refused unless --here is given", async () => {
	const home = join(scratch, "fake-home");
	mkdirSync(home, { recursive: true });
	const server = await startStandIn();
	try {
		const refused = await carto(home, server, ["-p", "say: hi"], { env: { HOME: home } });
		assert.equal(refused.code, 1, `expected exit 1:\n${refused.all}`);
		has(refused.stderr, `${home} is not a project folder. Run carto from inside a project, or pass --here`, "message");
		const where = await carto(home, undefined, ["--where"], { env: { HOME: home } });
		has(where.stdout, `project  ${home}  (refused without --here: not a project folder)`, "--where says so too");
		assert.ok(!existsSync(join(home, ".atlas")), "no brain in the home folder");
		const allowed = await carto(home, server, ["--here", "-p", "say: hi"], { env: { HOME: home } });
		ok(allowed, "--here");
		assert.ok(existsSync(join(home, ".atlas", "session.sqlite")), "--here sets up the brain");
	} finally {
		await server.close();
	}
});

test("launch: a brain or a repository in the home folder does not swallow the folders under it", async () => {
	const home = join(scratch, "home-with-brain");
	const dice = join(home, "Projects", "simpledice");
	mkdirSync(dice, { recursive: true });
	mkdirSync(join(home, ".git"));
	const server = await startStandIn();
	try {
		// A brain in the home folder, as an earlier mistake or a --here run leaves it.
		ok(await carto(home, server, ["--here", "-p", "say: hi"], { env: { HOME: home } }), "--here in the home folder");
		assert.ok(existsSync(join(home, ".atlas", "session.sqlite")), "the home folder now has a brain");

		const where = await carto(dice, undefined, ["--where"], { env: { HOME: home } });
		ok(where, "--where below the home folder");
		has(where.stdout, `project  ${dice}  (the current folder; no brain or git repository above it)`, "the project is the folder carto was started in");
		has(where.stdout, `brain    ${join(dice, ".atlas")}  (not set up yet)`, "with its own brain");

		const result = await carto(dice, server, ["-p", "task: list:"], { env: { HOME: home } });
		ok(result, "a run below the home folder");
		has(result.stdout, `Cartographer · ${dice}`, "the header names the project");
		has(result.stdout, `new brain ${join(dice, ".atlas")}`, "a new brain is set up there");
		has(result.stdout, "→ The project folder is empty", "and the task looks at that folder, not at the home folder");

		const refused = await carto(home, server, ["-p", "say: hi"], { env: { HOME: home } });
		assert.equal(refused.code, 1, `the home folder is still refused without --here, brain or not:\n${refused.all}`);
	} finally {
		await server.close();
	}
});

test("launch: an .atlas folder left by the Orchestrator extension is not a brain, and its files are left alone", async () => {
	const root = makeProject("orchestrator-leftovers", { git: false });
	const atlas = join(root, ".atlas");
	mkdirSync(atlas);
	const theirs = {
		"ledger.json": JSON.stringify({ version: 2, clock: 3, reports: 0, next: { w: 2 }, items: { w1: { id: "w1", kind: "want", text: "an old want" } } }),
		"graph.json": JSON.stringify({ nodes: {}, edges: [] }),
		"working-direction.json": JSON.stringify({ text: "old direction" }),
		".gitignore": "*\n",
	};
	for (const [name, content] of Object.entries(theirs)) writeFileSync(join(atlas, name), content);
	const server = await startStandIn();
	try {
		// From a subfolder: the folder above has `.atlas/`, but not a Cartographer brain, so it is not picked.
		const where = await carto(join(root, "src"), undefined, ["--where"]);
		has(where.stdout, `project  ${join(root, "src")}  (the current folder`, "a leftover .atlas above does not make that folder the project");

		const result = await carto(root, server, ["-p", ledgerMessage(GOAL)]);
		ok(result, "a run in the folder with the leftovers");
		has(result.stdout, `new brain ${atlas}`, "the brain counts as new");
		hasNot(result.stdout, "cannot be read", "the old ledger is not mistaken for Cartographer's");
		has(result.stdout, "● ledger  + goal g1", "and the ledger works");
		for (const [name, content] of Object.entries(theirs)) assert.equal(readFileSync(join(atlas, name), "utf8"), content, `${name} is left exactly as it was`);
		assert.ok(existsSync(join(atlas, "carto-ledger.json")), "Cartographer's ledger has its own file");
		assert.ok(existsSync(join(atlas, "plugins")), "the plugins folder is added");
		const again = await carto(join(root, "src"), undefined, ["--where"]);
		has(again.stdout, `project  ${root}  (the nearest folder with a brain)`, "once it has a brain, the folder is found from below");
	} finally {
		await server.close();
	}
});

test("launch: the first run in a project asks before it sets up a brain, and a no leaves nothing behind", async () => {
	const root = makeProject("first-run-question", { git: false });
	const server = await startStandIn();
	try {
		const question = `No brain for this project yet. Set one up in ${join(root, ".atlas")}? [Y/n]`;
		const no = await cartoOnTerminal(root, server, [], [[question, "n"]]);
		if (no === undefined) return "python3 is needed for a terminal";
		has(no.screen, "Nothing was set up.", "the answer no");
		assert.ok(!existsSync(join(root, ".atlas")), "no brain folder after a no");
		assert.equal(server.requests.length, 0, "and no request to the model");

		const yes = await cartoOnTerminal(root, server, [], [[question, ""], ["Type a message.", "say: hello"], ["context ", "/quit"]]);
		has(yes.screen, `new brain ${join(root, ".atlas")}`, "Enter sets the brain up");
		has(yes.screen, "\nhello\n", "and the conversation works after the question");
		assert.ok(existsSync(join(root, ".atlas", "session.sqlite")), "the brain exists");

		const again = await cartoOnTerminal(root, server, [], [["Type a message.", "/quit"]]);
		hasNot(again.screen, "Set one up", "the question is asked once");
		has(again.screen, `\nbrain ${join(root, ".atlas")}`, "the second start uses the brain");

		// Not on a terminal there is nobody to ask: -p and piped input set the brain up without the question.
		const other = makeProject("first-run-piped", { git: false });
		const piped = await carto(other, server, [], { input: "say: hi\n" });
		ok(piped, "piped input");
		hasNot(piped.stdout, "Set one up", "no question when the input is a pipe");
	} finally {
		await server.close();
	}
});

test("launch: a ledger kept under the old file name is taken over; the Orchestrator's file of that name is not", async () => {
	const root = makeProject("old-ledger-name");
	const atlas = join(root, ".atlas");
	const server = await startStandIn();
	try {
		ok(await carto(root, server, ["-p", ledgerMessage(GOAL)]), "first run");
		renameSync(join(atlas, "carto-ledger.json"), join(atlas, "ledger.json"));
		const result = await carto(root, server, ["-p", "say: hi"]);
		ok(result, "a run with the ledger under its old name");
		has(result.stdout, "The ledger file ledger.json is now carto-ledger.json", "the user is told");
		has(result.stdout, "ledger: 1 goal", "and the entries are there");
		assert.ok(!existsSync(join(atlas, "ledger.json")), "the old file is gone");
		assert.equal(readLedger(root).items[0].id, "g1");

		// With both files there, the old name belongs to someone else.
		const theirs = JSON.stringify({ version: 1, next: 2, items: [{ id: "n1", kind: "note", text: "someone else's" }] });
		writeFileSync(join(atlas, "ledger.json"), theirs);
		const again = await carto(root, server, ["-p", "say: hi"]);
		hasNot(again.stdout, "is now carto-ledger.json", "nothing is taken over twice");
		assert.equal(readFileSync(join(atlas, "ledger.json"), "utf8"), theirs);
		assert.equal(readLedger(root).items[0].id, "g1", "Cartographer's own ledger is not replaced");
	} finally {
		await server.close();
	}
});

test("launch: going up, the first brain or git repository is the project", () => {
	const top = join(scratch, "nearest");
	mkdirSync(join(top, "src", "deep"), { recursive: true });
	mkdirSync(join(top, "vendor", "lib", "src"), { recursive: true });
	mkdirSync(join(top, "vendor", "lib", ".git"));
	assert.deepEqual(findProject(join(top, "src", "deep")), { root: join(top, "src", "deep"), why: "here" }, "nothing above: the folder itself");
	setUpBrain(top);
	assert.deepEqual(findProject(join(top, "src", "deep")), { root: join(top, "src", "deep"), why: "here" }, "an .atlas folder without a session is not a brain");
	writeFileSync(join(top, ".atlas", "session.sqlite"), "");
	assert.deepEqual(findProject(join(top, "src", "deep")), { root: top, why: "brain" }, "a brain above");
	assert.deepEqual(findProject(join(top, "vendor", "lib", "src")), { root: join(top, "vendor", "lib"), why: "git" }, "a repository nearer than the brain wins");

	// What setUpBrain does to a .gitignore that is already there.
	assert.equal(readFileSync(join(top, ".atlas", ".gitignore"), "utf8"), "session.sqlite*\ncarto.lock\ncheckpoints.git/\nhome/\ncarto-context.json\nreports/\ncarto-wakes.json\nexport/\n", "a new one");
	writeFileSync(join(top, ".atlas", ".gitignore"), "notes.txt");
	setUpBrain(top);
	assert.equal(readFileSync(join(top, ".atlas", ".gitignore"), "utf8"), "notes.txt\nsession.sqlite*\ncarto.lock\ncheckpoints.git/\nhome/\ncarto-context.json\nreports/\ncarto-wakes.json\nexport/\n", "missing lines are added to an existing one");
	setUpBrain(top);
	assert.equal(readFileSync(join(top, ".atlas", ".gitignore"), "utf8"), "notes.txt\nsession.sqlite*\ncarto.lock\ncheckpoints.git/\nhome/\ncarto-context.json\nreports/\ncarto-wakes.json\nexport/\n", "and not twice");
});

test("brain: the first run creates .atlas with the session and a plugins folder; a subfolder uses the same brain", async () => {
	const root = makeProject("brain", { git: false });
	const server = await startStandIn();
	try {
		const first = await carto(root, server, ["-p", "say: hello from the stand-in"]);
		ok(first, "first run");
		has(first.stdout, `new brain ${join(root, ".atlas")}`, "says the brain is new");
		has(first.stdout, "hello from the stand-in", "the answer is printed");
		const brain = readdirSync(join(root, ".atlas")).sort();
		assert.deepEqual(brain.filter((name) => !name.startsWith("session.sqlite-")), [".gitignore", "carto-context.json", "carto-top.json", "plugins", "session.sqlite"], `brain contents: ${brain}`);
		has(readFileSync(join(root, ".atlas", ".gitignore"), "utf8"), "session.sqlite*", "the session is kept out of git");
		assert.ok(!existsSync(join(root, ".atlas", "carto.lock")), "the lock is removed on exit");
		assert.ok(!existsSync(join(root, "node_modules")), "nothing of the program is copied into the project");

		const second = await carto(join(root, "src", "deep"), server, ["-p", "say: again"]);
		ok(second, "second run from a subfolder");
		has(second.stdout, `brain ${join(root, ".atlas")}`, "uses the brain of the folder above");
		hasNot(second.stdout, "new brain", "does not create a second brain");
		assert.ok(!existsSync(join(root, "src", "deep", ".atlas")), "no brain in the subfolder");

		// The session carried over: the second run's request holds the first exchange.
		const texts = server.requests.at(-1).messages.map(messageText);
		assert.ok(texts.includes("say: hello from the stand-in"), `the first message is still in context: ${JSON.stringify(texts.slice(1))}`);
		const said = server.requests.at(-1).messages.flatMap((message) => message.tool_calls ?? []).filter((call) => call.function.name === "chat").map((call) => JSON.parse(call.function.arguments).text);
		assert.deepEqual(said.slice(0, 1), ["hello from the stand-in"], "and so is the first answer, as what the agent said with `chat`");
	} finally {
		await server.close();
	}
});

test("brain: one carto per project at a time", async () => {
	const root = makeProject("lock", { git: false });
	const server = await startStandIn({ holdWhen: () => true });
	try {
		const running = carto(root, server, ["-p", "say: slow"]);
		await until(() => server.heldCount() === 1, "the first carto reaches the server");
		const second = await carto(root, server, ["-p", "say: hi"]);
		assert.equal(second.code, 1, `the second carto must be refused:\n${second.all}`);
		has(second.stderr, "already running in this project", "message");
		server.release();
		ok(await running, "the first carto finishes");
	} finally {
		await server.close();
	}
});

// ─── Tasks ───────────────────────────────────────────────────────────────────

test("task: the main agent hands looking to a task, and only the report comes back", async () => {
	const root = makeProject("task");
	await git(root, "init", "-q");
	const server = await startStandIn();
	try {
		const result = await carto(root, server, ["-p", "task: list:\\nread: src/math.js, src/main.js\\nsearch: add"]);
		ok(result, "task run");
		// What the terminal shows.
		has(result.stdout, "▸ task  list: read: src/math.js, src/main.js search: add", "the task line");
		assert.match(result.stdout, /│ list \.\s+→ project: 6 files/, `the list step:\n${result.stdout}`);
		assert.match(result.stdout, /│ read src\/math\.js, src\/main\.js\s+→ 9 lines/, `the read step:\n${result.stdout}`);
		assert.match(result.stdout, /│ search \/add\/\s+→ 3 matches in 2 files of the project\./, `the search step (ignored.log must not count):\n${result.stdout}`);
		has(result.stdout, "◂ report", "the report line");
		has(result.stdout, "Report received: REPORT", "the main agent's answer uses the report");

		const [mainFirst, taskFirst, taskSecond, , taskLast, mainLast] = server.requests;
		assert.equal(server.requests.length, 6, `six requests: main, four of the task, main; got ${server.requests.length}`);
		// The task's prompt is the main agent's prompt plus the call and the brief: this is what makes a task cheap to start.
		assert.deepEqual(taskFirst.tools, mainFirst.tools, "a task is offered exactly the main agent's tools");
		assert.deepEqual(taskFirst.messages.slice(0, mainFirst.messages.length), stored(mainFirst), "the task's prompt starts with the main agent's stored conversation, unchanged");
		for (const request of [taskFirst, taskSecond, taskLast]) assert.equal(stateCount(request), 0, "a task's requests carry no state block");
		assert.equal(taskFirst.messages.length, mainFirst.messages.length + 2, "then the call and the brief, nothing else");
		const brief = messageText(taskFirst.messages.at(-1));
		assert.ok(brief.startsWith("You are now the task, not the main agent."), `the brief begins with the role line: ${brief}`);
		has(brief, "Brief:\nlist:\nread: src/math.js, src/main.js\nsearch: add", "the brief is passed on as written");
		assert.deepEqual(taskSecond.messages.slice(0, taskFirst.messages.length), taskFirst.messages, "the task's prompt only grows at the end");
		// The file's text was in the task's context and never reaches the main agent's.
		has(JSON.stringify(taskLast.messages), "MARKER-ONLY-IN-FILE", "the task saw the file");
		hasNot(JSON.stringify(mainLast.messages), "MARKER-ONLY-IN-FILE", "the main agent's context holds no task working steps");
		assert.equal(mainLast.messages.length, mainFirst.messages.length + 2, "the main agent's context grew by the call and the report only");
		has(messageText(mainLast.messages.at(-1)), "REPORT\nproject: 6 files", "the report is the result of the call");
		hasNot(messageText(mainLast.messages.at(-1)), "You are now the task", "the brief does not come back as the result");
	} finally {
		await server.close();
	}
});

test("task: the main agent cannot look itself, and a task cannot start a task", async () => {
	const root = makeProject("refusals", { git: false });
	const server = await startStandIn();
	try {
		const main = await carto(root, server, ["-p", "look: read: src/math.js"]);
		ok(main, "main looks");
		const refused = messageText(server.requests.at(-1).messages.at(-1));
		has(refused, "The main agent does not look at the project itself. Hand this to a task", "the refusal says what to do instead");
		hasNot(JSON.stringify(server.requests.at(-1).messages), "MARKER-ONLY-IN-FILE", "the file was not read");
		has(main.stdout, "▸ read src/math.js  → refused: The main agent does not look", "the screen shows the call and its refusal");
		assert.equal(main.stdout.split("▸ read").length - 1, 1, `the refused call is one line on the screen:\n${main.stdout}`);

		const nested = await carto(root, server, ["-p", "task: task: go deeper\\nlist:"]);
		ok(nested, "task starts task");
		const seen = server.requests.map((request) => messageText(request.messages.at(-1)));
		assert.ok(seen.some((text) => text.includes("A task cannot start another task. Do the work yourself")), `the task is told it cannot: ${JSON.stringify(seen.slice(-4))}`);
		has(nested.stdout, "│ task  go deeper", "the refused call is shown");
		has(nested.stdout, "refused: A task cannot start another task", "with the refusal");
		assert.match(nested.stdout, /│ list \.\s+→ project: 5 files/, `and the task carried on:\n${nested.stdout}`);
	} finally {
		await server.close();
	}
});

test("task: two tasks asked for in one turn run one after the other, each with its own brief", async () => {
	const root = makeProject("two-tasks", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, ["-p", "task: read: README.md || task: read: src/main.js"]);
		ok(result, "two tasks");
		const briefs = server.requests.map((request) => request.messages.filter((message) => message.role === "tool").map(messageText));
		const firstTask = briefs.find((texts) => texts.some((text) => text.includes("Brief:\nread: README.md")));
		const secondTask = briefs.find((texts) => texts.some((text) => text.includes("Brief:\nread: src/main.js")));
		assert.ok(firstTask && secondTask, `both briefs were delivered: ${JSON.stringify(briefs)}`);
		assert.equal(firstTask.at(1), "This call is a separate task, not yours. Your brief is in the result above: carry it out now.", "the first task is told the other call is not its own");
		assert.equal(secondTask.at(0), "This call is a separate task, not yours. Your brief is in the next result.", "and so is the second");
		hasNot(firstTask.join("\n"), "Brief:\nread: src/main.js", "the first task does not get the second brief");
		const order = server.requests.map((request) => JSON.stringify(request.messages.at(-1)));
		const firstDone = order.findIndex((text) => text.includes("== README.md"));
		const secondStarted = order.findIndex((text) => text.includes("Brief:\\nread: src/main.js"));
		assert.ok(firstDone >= 0 && secondStarted > firstDone, `the second task starts after the first has worked (${firstDone}, ${secondStarted})`);
		has(result.stdout, "Report received: REPORT\nThis call is a separate task, not yours. Your brief is in the result above: carry it out now.\n== README.md (lines 1-2 of 2) ++ REPORT\n== src/main.js (lines 1-2 of 2)", "both reports reach the main agent, in order");
	} finally {
		await server.close();
	}
});

test("task: a task that never returns is ended at its reply limit, is told when few replies are left, and its notes come back", async () => {
	const root = makeProject("turn-limit", { git: false });
	mkdirSync(join(root, ".atlas"));
	writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ taskTurns: 5 }));
	const server = await startStandIn();
	try {
		const result = await carto(root, server, ["-p", "task: loop"]);
		ok(result, "looping task");
		has(result.stdout, "Cartographer ended the task: it used all 5 of its replies without calling `return`, so there is no report and nothing says the work is done.\nIt had written nothing.\nGive a narrower brief, or split the work.", "the main agent is told why, and what to do");
		const inTask = server.requests.filter(isTask);
		assert.equal(inTask.length, 5, `the task got exactly 5 replies, got ${inTask.length}`);
		const last = (request) => rawText(request.messages.at(-1));
		hasNot(last(inTask[1]), "left in this task", "with four replies left nothing is said");
		has(last(inTask[2]), "\n\nCartographer: 3 more replies are left in this task. Call `return` now, with what you have and with what is left undone.", "with three left the task is told, after the result it got");
		has(last(inTask[3]), "\n\nCartographer: 2 more replies are left in this task.", "with two");
		has(last(inTask[4]), "\n\nCartographer: one more reply is left in this task.", "and with one");
		hasNot(result.stdout, "task ended by Cartographer: it called", "the old line is gone");

		// A task that only writes notes: each is followed up, they count, and they are what comes back.
		const before = server.requests.length;
		const notes = await carto(root, server, ["-p", "task: babble"]);
		ok(notes, "a task that only writes notes");
		const mine = server.requests.slice(before).filter(isTask);
		assert.equal(mine.length, 5, `five replies again, got ${mine.length}`);
		has(last(mine[1]), "Your last message had no tool call.\n\nSo it is kept as a note to yourself, and nobody else read it. Go on with the brief. When the work is finished, call `return` with your report.\n</cartographer>", "the first note is explained");
		has(last(mine[2]), "Your last message had no tool call. Noted.\n\nCartographer: 3 more replies are left in this task.", "the next ones are only acknowledged, and the count is said there too");
		has(last(mine[4]), "Your last message had no tool call. Noted.\n\nCartographer: one more reply is left in this task. Call `return` now", "down to the last");
		assert.equal(rawText(mine[4].messages.findLast((message) => message.role === "assistant")), "Note to self: Babble 4.", "in the request a note is marked as one");
		has(notes.stdout, "it used all 5 of its replies without calling `return`, so there is no report and nothing says the work is done.\nWhat it had written for itself:\n- Babble 1.\n- Babble 2.\n- Babble 3.\n- Babble 4.\n- Babble 5.\nGive a narrower brief, or split the work.", "the notes are what the main agent gets");
		has(notes.stdout, "│ Babble 3.\n", "and the user saw them as they were written");

		// The same note again and again is a model that is stuck.
		const stuck = await carto(root, server, ["-p", "task: mumble"]);
		ok(stuck, "a task that repeats itself");
		has(stuck.stdout, "Cartographer ended the task: it wrote the same note 3 times in a row and called nothing, so there is no report.\nWhat it had written for itself:\n- Mumble.\n- Mumble.\n- Mumble.\nIf the work is still needed, start another task with a brief that says what to do first.", "it is ended at the third");
	} finally {
		await server.close();
	}
});

test("task: `return` needs a report, and a task that writes nothing at all is ended", async () => {
	const root = makeProject("silent", { git: false });
	const server = await startStandIn();
	try {
		const empty = await carto(root, server, ["-p", `task: ${['return: {"report":"  ","done":true}', "read: a.txt"].join("\\n")}`]);
		ok(empty, "a return without a report");
		has(resultsOf(server, "return")[0], "`report` is empty, so the task has not ended. Call `return` again with the report: what you found or changed, and what is left.", "it is refused");
		has(empty.stdout, "│ read a.txt", "and the task goes on");
		assert.match(empty.stdout, /\n◂ report t1 {2}\d+ characters/, "until it returns with one");

		const result = await carto(root, server, ["-p", "task: silent"]);
		ok(result, "silent task");
		has(result.stdout, "Cartographer ended the task: it wrote nothing and called nothing, 3 times in a row, so there is no report.\nIt had written nothing.", "message");
	} finally {
		await server.close();
	}
});

test("kill: after a kill mid-inference, the restart does not wait for the stuck agent to talk to the user", async () => {
	const root = makeProject("kill", { git: false });
	// Hold any request the tool result of a call waits behind, for good: the agent is stuck mid-inference,
	// before and after the restart, and nothing the user does should wait on it.
	const server = await startStandIn({ holdWhen: (body) => body.messages.at(-1)?.role === "tool" });
	try {
		const child = spawn(process.execPath, [CARTO, "--url", server.url, "--model", "stand-in", "-p", "look: list: ."], { cwd: root, stdio: "ignore" });
		const gone = new Promise((resolve) => child.on("close", resolve));
		await until(() => server.heldCount() === 1, "the agent reaches its second step");
		child.kill("SIGKILL");
		await gone;
		server.release();
		// The released request never finishes: after the restart the same step is held again, still mid-inference.
		const before = server.requests.length;

		const resumed = await cartoOnTerminal(root, server, [], [
			["Continuing unfinished work", "/books"],
			["carto-books.json", "say: you answer at once though the task hangs"],
			["sent; the agent reads it after its current step", "\u0018", false],
			[3, "", false],
			[1.5, "/quit"],
		]);
		ok(resumed, "restart after the kill (the stale lock is taken over)");
		has(resumed.screen, "Continuing unfinished work from the last session", "says it is continuing");
		has(resumed.screen, "you answer at once though the task hangs", "the user's own line was accepted while the agent hung");
		// The echo of the line holds it once; the agent's answer holds it again.
		const said = resumed.screen.split("you answer at once though the task hangs").length - 1;
		assert.ok(said >= 2, `the agent answered what it had held: the words stand ${said} times on the screen`);
		assert.ok(server.requests.slice(before).length <= 3, `only the unfinished step was redone: ${server.requests.slice(before).length} requests after the restart`);
	} finally {
		await server.close();
	}
});

test("kill: carto killed in the middle of a task picks the task up again at the next start", async () => {
	const root = makeProject("kill", { git: false });
	// Hold the task's second request: the task has started, done one step, and is waiting for the model.
	// Held once: the same request sent again after the restart is answered.
	let heldOnce = false;
	const isTaskSecond = (body) => {
		if (heldOnce || !body.messages.some((message) => messageText(message).startsWith("You are now the task")) || !messageText(body.messages.at(-1)).startsWith("project:")) return false;
		heldOnce = true;
		return true;
	};
	const server = await startStandIn({ holdWhen: isTaskSecond });
	try {
		const child = spawn(process.execPath, [CARTO, "--url", server.url, "--model", "stand-in", "-p", "task: list:\\nread: src/math.js"], { cwd: root, stdio: "ignore" });
		const gone = new Promise((resolve) => child.on("close", resolve));
		await until(() => server.heldCount() === 1, "the task reaches its second step");
		child.kill("SIGKILL");
		await gone;
		server.release();
		assert.ok(existsSync(join(root, ".atlas", "carto.lock")), "the killed process left its lock behind");
		const before = server.requests.length;

		const resumed = await carto(root, server, [], { input: "" });
		ok(resumed, "restart after the kill (the stale lock is taken over)");
		has(resumed.stdout, "Continuing unfinished work from the last session", "says it is continuing");
		has(resumed.stdout, "Report received: REPORT\nproject: 5 files\n== src/math.js (lines 1-4 of 4)", "the task finished and its report reached the main agent");
		const after = server.requests.slice(before);
		const briefs = after.filter((request) => request.messages.filter((message) => messageText(message).startsWith("You are now the task")).length > 1);
		assert.equal(briefs.length, 0, "the task was continued, not started a second time");
		assert.ok(after.length <= 3, `only the unfinished steps were redone: ${after.length} requests after the restart`);
	} finally {
		await server.close();
	}
});

// ─── The ledger ──────────────────────────────────────────────────────────────

const readLedger = (root) => JSON.parse(readFileSync(join(root, ".atlas", "carto-ledger.json"), "utf8"));

test("ledger: the agent's entries are saved in the brain, shown as they are written, and still there in the next session", async () => {
	const root = makeProject("ledger", { git: false });
	const server = await startStandIn();
	try {
		const first = await carto(root, server, ["-p", ledgerMessage(GOAL, { action: "add", kind: "note", text: "The user prefers small steps" }, { action: "add", kind: "question", text: "Password or token login?" })]);
		ok(first, "adding entries");
		has(first.stdout, "ledger: no goals, no questions, no notes · no goal yet: say what you want to achieve", "the start says there is no goal");
		has(first.stdout, "● ledger  + goal g1  Make the dashboard multi-player\n          done when: Two players can log in at once\n", "the goal is shown as written");
		has(first.stdout, "● ledger  + note n2  The user prefers small steps", "the note");
		has(first.stdout, "● ledger  + question q3  Password or token login?", "the question");
		hasNot(first.stdout, "▸ ledger", "a ledger change is shown by its result, not as a call line");
		has(messageText(server.requests.at(-1).messages.at(-1)), "g1 added.\nn2 added.\nq3 added.\nOpen: 1 goal, 1 question, 1 note.", "what the agent is told");
		const file = readLedger(root);
		assert.deepEqual(file.items.map((item) => [item.id, item.kind, item.status]), [["g1", "goal", "open"], ["n2", "note", "open"], ["q3", "question", "open"]], "the file holds the three entries");
		assert.equal(file.items[0].doneWhen, "Two players can log in at once", "the goal keeps its done-when line");

		const second = await carto(root, server, ["-p", ledgerMessage({ action: "done", id: "q3", text: "Token" }, { action: "edit", id: "g1", done_when: "Two browsers show two guilds" }, { action: "remove", id: "n2" }, { action: "done", id: "x9" })]);
		ok(second, "changing entries");
		has(second.stdout, "ledger: 1 goal, 1 question, 1 note · /ledger shows them", "the next session starts with the ledger");
		has(second.stdout, "● ledger  ✓ question q3  Password or token login? → Token", "closing");
		has(second.stdout, "● ledger  ~ goal g1  Make the dashboard multi-player\n          done when: Two browsers show two guilds\n", "rewording");
		has(second.stdout, "● ledger  - note n2  The user prefers small steps", "removing");
		const told = messageText(server.requests.at(-1).messages.at(-1));
		has(told, "Op 4 (done x9) not applied: There is no entry x9. Open entries: g1.", "an operation that cannot be applied is reported with what exists");
		has(told, "3 of 4 applied and saved; send only the ones not applied again.", "and the others are saved");

		const third = await carto(root, server, [], { input: "/ledger\n" });
		ok(third, "/ledger");
		has(third.stdout, "Goals:\n  g1  Make the dashboard multi-player (done when: Two browsers show two guilds)\nClosed:\n  q3  Password or token login? → Token", "/ledger lists open and closed entries");
		has(third.stdout, join(root, ".atlas", "carto-ledger.json"), "and says where the file is");
	} finally {
		await server.close();
	}
});

test("state: every request of the main agent ends with the current ledger, once, and it is never stored", async () => {
	const root = makeProject("state", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, ["-p", "say: hello"]), "first message");
		const empty = stateOf(server.requests[0]);
		assert.ok(empty, `the first request carries a state block: ${rawText(server.requests[0].messages.at(-1))}`);
		has(empty, "Written by Cartographer, not by the user.", "it says who wrote it");
		has(ledgerState(server.requests[0]), "Ledger\nThe ledger is empty.\n\nNo goal is set.", "an empty ledger and no goal");
		has(empty, "Find out what the user wants to achieve.", "with no goal the agent is told to find one out");
		assert.match(rawText(server.requests[0].messages.at(-1)), /<\/project>\n\nsay: hello\n\n\[sent [^\]]+\]\n\n<state>\n/, "the block follows the user's words and when they were sent");

		ok(await carto(root, server, ["-p", ledgerMessage(GOAL)]), "adding a goal");
		const [before, after] = server.requests.slice(-2);
		has(stateOf(before), "The ledger is empty.", "the request that makes the change still shows the old state");
		has(ledgerState(after), "Goals:\n  g1  Make the dashboard multi-player (done when: Two players can log in at once)\n\nAnswer the user's newest message first. Beyond that, work toward the open goals.", "the next request shows the goal and what to do about it");
		hasNot(stateOf(after), "No goal is set", "and no longer asks for one");
		assert.ok(rawText(after.messages.at(-1)).includes("Open: 1 goal, no questions, no notes.\n\n<state>"), "after a tool result the block is added to that result");
		for (const request of server.requests) assert.equal(stateCount(request), 1, `each request holds exactly one state block, got ${stateCount(request)}`);
		assert.deepEqual(after.messages.slice(0, -1), stored(before).concat(after.messages.slice(before.messages.length, -1)), "earlier messages are sent as stored, without a block");

		// A task gets none, and the main agent's request after the task has it again.
		ok(await carto(root, server, ["-p", "task: list:"]), "a task");
		const task = server.requests.filter((request) => request.messages.some((message) => messageText(message).startsWith("You are now the task")));
		assert.ok(task.length > 0 && task.every((request) => stateCount(request) === 0), "no state block in a task's requests");
		has(stateOf(server.requests.at(-1)), "g1  Make the dashboard", "the main agent's request after the report has the block");

		// A fresh context forgets the conversation and keeps the ledger.
		const fresh = await carto(root, server, [], { input: "/new\nsay: after the fresh start\n" });
		ok(fresh, "/new then a message");
		const last = server.requests.at(-1);
		assert.deepEqual(last.messages.map((message) => message.role), ["system", "user"], "the context is fresh");
		has(stateOf(last), "g1  Make the dashboard multi-player", "and the goal is still shown");
	} finally {
		await server.close();
	}
});

test("state: an edit made by hand shows at the next request; a broken file is reported and never overwritten", async () => {
	const root = makeProject("hand-edit", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, ["-p", ledgerMessage(GOAL)]), "adding a goal");
		const file = readLedger(root);
		file.items[0].text = "Make the dashboard work for two players";
		file.items.push({ id: "n7", kind: "note", text: "Written by hand" });
		writeFileSync(join(root, ".atlas", "carto-ledger.json"), JSON.stringify(file));
		ok(await carto(root, server, ["-p", ledgerMessage({ action: "add", kind: "note", text: "After the hand edit" })]), "a message after the edit");
		const state = stateOf(server.requests.at(-2));
		has(state, "g1  Make the dashboard work for two players", "the reworded goal is shown");
		has(state, "n7  Written by hand", "and the entry added by hand");
		assert.deepEqual(readLedger(root).items.map((item) => item.id), ["g1", "n7", "n8"], "a new entry gets an id after the highest in the file");

		const broken = '{ "items": [ { "id": "g1", "kind": "goal", "text": "half an edit"';
		writeFileSync(join(root, ".atlas", "carto-ledger.json"), broken);
		const result = await carto(root, server, ["-p", ledgerMessage({ action: "add", kind: "note", text: "Must not be saved" })]);
		ok(result, "a message with a broken ledger file");
		has(result.stdout, "! The ledger cannot be read:", "the user is told at the start");
		has(result.stdout, "is not valid JSON", "and why");
		has(stateOf(server.requests.at(-2)), "The ledger cannot be read:", "the agent is told in the state block");
		has(stateOf(server.requests.at(-2)), "Tell the user", "and what to do");
		has(messageText(server.requests.at(-1).messages.at(-1)), "Nothing was changed. Tell the user; they have to repair the file.", "the tool refuses");
		has(result.stdout, "● ledger  not changed:", "the terminal shows that nothing was changed");
		assert.equal(readFileSync(join(root, ".atlas", "carto-ledger.json"), "utf8"), broken, "the broken file is left exactly as it was");
	} finally {
		await server.close();
	}
});

test("task: a task that reaches for a tool of the main agent is refused and goes on; it ends with `return` alone", async () => {
	const root = makeProject("task-early", { git: false });
	const server = await startStandIn();
	try {
		const reach = `${ledgerMessage(GOAL)} +++ ${planMessage({ action: "add", mode: "change", text: "Serve it" })}`;
		const brief = ["read: README.md", `saying The look task found a demo project. >> ${reach}`, "list: src", `saying I am the main agent again. It is a small demo with two source files. >> ${reach}`, "read: a.txt"].join("\\n");
		const result = await carto(root, server, ["-p", `task: ${brief}`]);
		ok(result, "a task that reaches for the ledger and the plan");
		const told = "You are still the task. When its work is finished, call `return` with your report; until then, go on with the brief.";
		const inTask = server.requests.filter(isTask);
		const refused = inTask.filter((request) => request.messages.at(-1).role === "tool" && rawText(request.messages.at(-1)).includes("belongs to the main agent"));
		assert.equal(refused.length, 2, "both times the task goes on");
		for (const request of refused) {
			has(rawText(request.messages.at(-2)), `Tool call blocked: The ledger belongs to the main agent. If something should be recorded, say so in your report. ${told}`, "and is told how a task ends");
			has(rawText(request.messages.at(-1)), `Tool call blocked: The plan belongs to the main agent. If the plan should change, say so in your report. ${told}`, "for each call");
		}
		assert.match(result.stdout, /│ list src\s+→ /, "it carried on with its work");
		has(result.stdout, "│ read a.txt", "also after the second time");
		hasNot(result.stdout, "task ended by Cartographer", "nothing ends it but itself");
		const report = rawText(server.requests.at(-1).messages.at(-1));
		assert.match(report, /^REPORT\n== README\.md /, `what it returned is the report:\n${report}`);
		assert.equal(server.requests.at(-1).messages.at(-1).role, "tool", "as the result of its `task` call");
		assert.ok(!existsSync(join(root, ".atlas", "carto-ledger.json")) && !existsSync(join(root, ".atlas", "carto-plan.json")), "nothing was written to the ledger or the plan");

		// `return` in the same reply as other calls: they are carried out, and the task ends there.
		const both = await carto(root, server, ["-p", `task: ${['read: README.md +++ return: {"report":"Read it.","done":true}', "read: a.txt"].join("\\n")}`]);
		ok(both, "a return beside another call");
		hasNot(both.stdout, "│ read a.txt", "the task ended with that reply");
		has(both.stdout, "Report received: Read it.", "with what it returned");

		// The main agent has no task to end.
		const main = await carto(root, server, ["-p", 'return: {"report":"x","done":true}']);
		ok(main, "the main agent calls return");
		has(main.stdout, "refused: `return` ends a task, and you are the main agent: there is no task to end.", "refused");

		// A task that does nothing else is the same call failing again and again.
		const only = await carto(root, server, ["-p", `task: ${[ledgerMessage(GOAL), ledgerMessage(GOAL), ledgerMessage(GOAL), "read: a.txt"].join("\\n")}`]);
		ok(only, "a task that only reaches");
		has(only.stdout, "Cartographer ended the task: it sent the same call 3 times and it failed each time", "the loop stop ends it");
	} finally {
		await server.close();
	}
});

test("plan: /approve with nothing to authorize tells the agent to write the plan", async () => {
	const root = makeProject("approve-nothing", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: lines("say: the plan is to serve the folder; type /approve", "/approve", planMessage(LOOK_ITEM), "/approve") });
		ok(result, "/approve before any plan");
		assert.equal(result.stdout.split("The plan has no open change item, so there is nothing to authorize. /plan shows it. The agent is told.").length - 1, 2, `the user is told, also with only a look item:\n${result.stdout}`);
		const told = server.requests.filter((request) => request.messages.at(-1).role === "user" && messageText(request.messages.at(-1)).startsWith("I typed /approve, but the plan holds no open change item, so nothing was authorized. I can only approve what the plan holds: what you describe in the chat is not in it. If you have changes for me to approve, write them with `plan` now, then ask me again."));
		assert.equal(told.length, 2, "and the agent gets a turn to write it, each time");
		assert.ok(readPlan(root).authorized === undefined, "nothing is authorized");
	} finally {
		await server.close();
	}
});

test("ledger: a task cannot write it", async () => {
	const root = makeProject("ledger-task", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, ["-p", `task: ${ledgerMessage(GOAL)}\\nlist:`]);
		ok(result, "a task tries the ledger");
		const seen = server.requests.map((request) => messageText(request.messages.at(-1)));
		assert.ok(seen.some((text) => text.includes("The ledger belongs to the main agent. If something should be recorded, say so in your report.")), `the task is told: ${JSON.stringify(seen.slice(-3))}`);
		assert.ok(!existsSync(join(root, ".atlas", "carto-ledger.json")), "nothing was written");
	} finally {
		await server.close();
	}
});

test("ledger: operations, limits and what a file must hold", () => {
	const now = "2026-01-01T00:00:00.000Z";
	const ledger = { version: 1, next: 1, items: [] };
	assert.equal(applyOp(ledger, GOAL, now).line, "g1 added.");
	assert.throws(() => applyOp(ledger, { action: "add", kind: "goal", text: "No done-when" }, now), /`done_when` \(how you and the user will know the goal is reached\) is required/, "a goal needs a done-when line");
	assert.throws(() => applyOp(ledger, { action: "add", kind: "note" }, now), /`text` \(the entry itself, one line in your words\) is required/, "an entry needs text");
	assert.throws(() => applyOp(ledger, { action: "add", kind: "wish", text: "x" }, now), /it is one of goal, question, note/, "an unknown kind");
	assert.throws(() => applyOp(ledger, { action: "add", kind: "note", text: "x".repeat(TEXT_MAX + 1) }, now), /the limit is 400/, "a long text");
	assert.throws(() => applyOp(ledger, { action: "edit", id: "g1" }, now), /An edit needs `text`, `done_when`, or both/, "an edit without new wording");
	assert.throws(() => applyOp(ledger, { action: "frob", id: "g1" }, now), /the actions are add, done, edit, remove/, "an unknown action");
	assert.equal(ledger.next, 2, "a refused operation uses no id");
	applyOp(ledger, { action: "add", kind: "note", text: "  two\n lines  " }, now);
	assert.equal(ledger.items[1].text, "two lines", "text is kept as one line");
	assert.throws(() => applyOp(ledger, { action: "edit", id: "n2", done_when: "x" }, now), /only a goal has a done-when line/, "done-when on a note");
	has(applyOp(ledger, { action: "done", id: "g1", text: "Shipped" }, now).line, "Tell the user what was achieved against its done-when line, and ask whether that is what they wanted.", "closing a goal prompts a conversation, it does not gate");
	assert.equal(applyOp(ledger, { action: "done", id: "g1" }, now).line, "g1 was already closed.", "closing twice");
	applyOp(ledger, { action: "remove", id: "n2" }, now);
	assert.equal(applyOp(ledger, { action: "add", kind: "note", text: "next" }, now).line, "n3 added.", "the id of a removed entry is not used again");
	assert.equal(renderLedger(ledger), "Notes:\n  n3  next\n(1 closed entry not shown)");

	const full = { version: 1, next: 1, items: [] };
	for (let i = 0; i < OPEN_MAX; i++) applyOp(full, { action: "add", kind: "note", text: `note ${i}` }, now);
	assert.throws(() => applyOp(full, { action: "add", kind: "note", text: "one too many" }, now), LedgerError, "the number of open entries is limited");

	const dir = join(scratch, "ledger-files");
	mkdirSync(dir, { recursive: true });
	const bad = (content) => {
		writeFileSync(join(dir, "carto-ledger.json"), typeof content === "string" ? content : JSON.stringify(content));
		return loadLedger(dir).error ?? "";
	};
	assert.deepEqual(loadLedger(join(dir, "none")).ledger, { version: 1, next: 1, items: [] }, "no file is an empty ledger");
	has(bad("{ nope"), "is not valid JSON", "broken JSON");
	has(bad({ items: "x" }), 'must hold an object with an "items" list', "no list");
	has(bad({ items: [{ id: "g1", kind: "dream", text: "x" }] }), 'entry 1: "kind" must be one of goal, question, note', "a wrong kind");
	has(bad({ items: [{ id: "one", kind: "note", text: "x" }] }), '"id" must look like g1, q2 or n3', "a wrong id");
	has(bad({ items: [{ id: "n1", kind: "note", text: "x" }, { id: "n1", kind: "note", text: "y" }] }), "the id n1 is used twice", "a repeated id");
	has(bad({ items: [{ id: "n1", kind: "note" }] }), '(n1): "text" is missing', "no text");
	assert.equal(bad({ items: [{ id: "n4", kind: "note", text: "by hand", mine: true }] }), "", "a minimal entry written by hand is accepted");
	assert.equal(loadLedger(dir).ledger.next, 5, "and the next id follows it");
	assert.equal(loadLedger(dir).ledger.items[0].mine, true, "fields the program does not know are kept");
});

test("ledger: a call that is run again after a crash is not applied twice", async () => {
	const dir = join(scratch, "ledger-rerun");
	mkdirSync(dir, { recursive: true });
	const tool = bookTool({ brainDir: dir });
	const api = { taskId: "task-1", now: () => 0, conversationId: ROOT_CONVERSATION_ID };
	const first = await tool.execute({ book: "ledger", ops: [{ action: "add", kind: "note", text: "once" }] }, api);
	assert.equal(first.output[0].text, "n1 added.\nOpen: no goals, no questions, 1 note.");
	const again = await tool.execute({ book: "ledger", ops: [{ action: "add", kind: "note", text: "once" }] }, api);
	has(again.output[0].text, "These operations were already applied, before a restart.", "the rerun says so");
	assert.equal(loadLedger(dir).ledger.items.length, 1, "and adds nothing");
	await tool.execute({ book: "ledger", ops: [{ action: "add", kind: "note", text: "twice" }] }, { ...api, taskId: "task-2" });
	assert.equal(loadLedger(dir).ledger.items.length, 2, "another call is applied");
});

test("state: the block is added to the last message of a request only, and the input is left alone", () => {
	const user = [{ role: "user", content: "hello" }];
	assert.deepEqual(withState(user, "<state>S</state>"), [{ role: "user", content: "hello\n\n<state>S</state>" }]);
	assert.deepEqual(user, [{ role: "user", content: "hello" }], "the input is not changed");
	const result = [{ role: "user", content: "a" }, { role: "assistant", content: [] }, { role: "toolResult", content: [{ type: "text", text: "r" }] }];
	const out = withState(result, "<state>S</state>");
	assert.deepEqual(out[2].content, [{ type: "text", text: "r\n\n<state>S</state>" }], "a tool result gets it joined to its text");
	assert.deepEqual(result[2].content, [{ type: "text", text: "r" }], "and the stored result is not changed");
	assert.equal(out[0], result[0], "earlier messages are passed through");
	const answered = [{ role: "user", content: "a" }, { role: "assistant", content: [] }];
	assert.equal(withState(answered, "<state>S</state>"), answered, "nothing is added after an assistant message");
	assert.equal(withoutState(`hello\n\n${stateBlock(join(scratch, "nowhere"))}`), "hello");
	assert.equal(withoutState("the tags <state> and </state> in a sentence"), "the tags <state> and </state> in a sentence", "a mention of the tags is not a block");
	const dir = join(scratch, "state-unit");
	mkdirSync(dir, { recursive: true });
	saveLedger(dir, { version: 1, next: 2, items: [{ id: "q1", kind: "question", text: "Which port?", status: "open" }] });
	assert.equal(
		stateBlock(dir, undefined, { now: new Date(2026, 0, 1, 9, 5).getTime() }),
		"<state>\nWritten by Cartographer, not by the user. This is the current state; it replaces any state you saw before.\n\nNow: Thu 1 Jan 2026, 09:05.\n\nLedger\nQuestions for the user:\n  q1  Which port?\n\nNo goal is set. Looking and answering questions is fine without one. Find out what the user wants to achieve. When you and the user agree on it, record it as a goal with a done-when line. You need not sit idle meanwhile: in the same reply you may start a look task that maps a part of the project the graph says nothing about, and has what it finds recorded as nodes. What deserves a node, and when the graph is good enough to stop and wait, is yours to decide.\n</state>",
	);
});

// ─── The plan, change tasks, checkpoints ─────────────────────────────────────

const readPlan = (root) => JSON.parse(readFileSync(join(root, ".atlas", "carto-plan.json"), "utf8"));
const planMessage = (...ops) => `plan: ${JSON.stringify(ops)}`;
const LOOK_ITEM = { action: "add", mode: "look", text: "See what is in the project" };
const WRITE_ITEM = { action: "add", mode: "change", text: "Write the roller" };
const README_ITEM = { action: "add", mode: "change", text: "Mention it in the README" };
/** Piped input: one message or command per line. */
const lines = (...parts) => `${parts.join("\n")}\n`;

test("plan: operations, when the authorization is withdrawn, limits and what a file must hold", () => {
	const now = "2026-01-01T00:00:00.000Z";
	const plan = { version: 1, next: 1, items: [] };
	const apply = (op) => applyPlanOp(plan, op, now);
	assert.equal(apply(LOOK_ITEM).shown, "+ p1 [look] See what is in the project");
	assert.equal(apply(WRITE_ITEM).line, "p2 added.");
	assert.equal(apply({ action: "add", mode: "look", text: "First of all", before: "p1" }).line, "p3 added.");
	assert.deepEqual(plan.items.map((item) => item.id), ["p3", "p1", "p2"], "`before` places an item");
	assert.equal(planSummary(plan), "3 items · 1 change item not authorized");
	assert.equal(renderPlan(plan), "Not approved: change items wait for the user. Look items may run.\n  p3 [look] First of all\n  p1 [look] See what is in the project\n  p2 [change] Write the roller");

	assert.equal(authorize(plan, now), 1, "authorizing says how many change items it covers");
	assert.equal(planSummary(plan), "3 items · authorized");
	// What leaves the authorization alone: nothing the user agreed to has changed.
	for (const op of [LOOK_ITEM, { action: "edit", id: "p1", text: "Look closer" }, { action: "done", id: "p3" }, { action: "remove", id: "p4" }, { action: "edit", id: "p2", text: "Write the roller" }]) {
		assert.ok(!apply(op).withdrawn && plan.authorized === now, `${op.action} of a look item, or an edit that changes nothing, keeps the authorization`);
	}
	// What withdraws it.
	const withdrawing = [
		[README_ITEM, "adding a change item"],
		[{ action: "edit", id: "p2", text: "Write the roller and its tests" }, "rewording a change item"],
		[{ action: "edit", id: "p1", mode: "change" }, "turning a look item into a change item"],
	];
	for (const [op, what] of withdrawing) {
		plan.authorized = now;
		const result = apply(op);
		assert.ok(result.withdrawn && plan.authorized === undefined, `${what} withdraws the authorization`);
		has(result.line, "the user's authorization no longer holds. Tell the user what changed and why, and ask them to type /approve.", what);
	}
	assert.ok(!apply(README_ITEM).withdrawn, "nothing is withdrawn when nothing was authorized");

	plan.authorized = now;
	assert.equal(apply({ action: "done", id: "p2", text: "roll.py written" }).shown, "✓ p2 [change] Write the roller and its tests → roll.py written");
	assert.ok(plan.authorized === now, "finishing a change item keeps the authorization");
	for (const item of plan.items.filter((entry) => entry.status === "open").slice(1)) apply({ action: "done", id: item.id });
	has(apply({ action: "done", id: plan.items.find((item) => item.status === "open").id }).line, "Every item is done. Check each open goal against its done-when line", "the last item");
	assert.equal(apply({ action: "clear" }).line, "The plan is empty now.");
	assert.ok(plan.items.length === 0 && plan.authorized === undefined, "clearing drops the items and the authorization");
	assert.equal(apply(WRITE_ITEM).shown, "+ p7 [change] Write the roller", "ids are not reused after a clear");

	const refuse = (op, part) => assert.throws(() => apply(op), (error) => error instanceof PlanError && error.message.includes(part), `${JSON.stringify(op)} should be refused with: ${part}`);
	refuse({ action: "add", mode: "write", text: "x" }, "it is look (the task only reads) or change (the task writes files)");
	refuse({ action: "add", mode: "look" }, "`text` is required");
	refuse({ action: "add", mode: "look", text: "x".repeat(ITEM_MAX + 1) }, `the limit is ${ITEM_MAX}`);
	refuse({ action: "done", id: "p99" }, 'There is no item "p99". The plan has p7.');
	refuse({ action: "edit", id: "p7" }, "An edit needs `text`, `mode`, `network` or `standing`.");
	refuse({ action: "approve" }, "the actions are add, edit, done, remove, clear");

	// The file: a hand-written one needs little, and a broken one is reported.
	const root = makeProject("plan-file", { git: false });
	const brain = setUpBrain(root).brainDir;
	assert.deepEqual(loadPlan(brain).plan, { version: 1, next: 1, items: [] }, "no file is an empty plan");
	writeFileSync(join(brain, "carto-plan.json"), JSON.stringify({ items: [{ id: "p4", mode: "change", text: "by hand" }], authorized: now }));
	const loaded = loadPlan(brain).plan;
	assert.deepEqual([loaded.items[0].status, loaded.next, loaded.authorized], ["open", 5, now], "id, mode and text are enough; the user can authorize by hand");
	writeFileSync(join(brain, "carto-plan.json"), JSON.stringify({ items: [{ id: "p1", mode: "maybe", text: "x" }] }));
	has(loadPlan(brain).error, 'item 1 needs a "mode" that is one of look, change', "a wrong mode");
	writeFileSync(join(brain, "carto-plan.json"), "{ not json");
	has(loadPlan(brain).error, "is not valid JSON", "a broken file");
});

test("plan: the agent's plan is saved and shown, and the state block says what it waits for", async () => {
	const root = makeProject("plan", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], {
			input: lines(ledgerMessage(GOAL), "say: before the plan", planMessage(LOOK_ITEM, WRITE_ITEM), planMessage({ action: "done", id: "p1" }), "task(p1): list:", "/plan", "/approve", planMessage({ action: "done", id: "p2" }), "task: plan: [{\"action\":\"clear\"}]"),
		});
		ok(result, "a session with a plan");
		has(result.stdout, "● plan  + p1 [look] See what is in the project\n● plan  + p2 [change] Write the roller\n", "the items are shown as written");
		has(result.stdout, "\nplan  1 change item waits for you: /plan shows the plan, /approve authorizes it\n", "the user is told that the plan waits for them");
		assert.equal(result.stdout.split("waits for you").length - 1, 1, `and told once for the same plan:\n${result.stdout}`);
		has(result.stdout, "Not approved: change items wait for the user. Look items may run.\n  ✓ p1 [look] See what is in the project\n  p2 [change] Write the roller\n", "/plan");
		has(result.stdout, "● plan  authorized by you: 1 change item may run\n  p2 Write the roller\n", "/approve");
		has(result.stdout, "refused: The plan belongs to the main agent. If the plan should change, say so in your report.", "a task cannot write the plan");
		has(result.stdout, "◂ p1 is marked done. For further work, add a new item to the plan.", "a finished item is not run again");

		// The state block of the request that followed each step.
		const blocks = server.requests.map(stateOf).filter((block) => block !== undefined);
		const after = (part) => blocks[server.requests.filter((request) => stateOf(request) !== undefined).findIndex((request) => messageText(request.messages.at(-1)).includes(part))];
		has(after("say: before the plan"), "If reaching one needs changes to the project, find out what you need with look tasks, then write the plan.", "a goal and no plan");
		hasNot(after("say: before the plan"), "\nPlan\n", "no plan section without a plan");
		const waiting = after("p2 added.");
		has(waiting, "\n\nPlan\nNot approved: change items wait for the user. Look items may run.\n  p1 [look] See what is in the project\n  p2 [change] Write the roller\n\n", "the plan is in the block");
		has(waiting, "carry out p1 with `task`: look items need no authorization. Change items wait for the user: show them the plan in a few lines and ask them to type /approve.", "a look item is next");
		has(after("p1 done."), "Change items wait for the user: show them the plan in a few lines and ask them to type /approve. Do not start p2 before that.", "a change item is next and not authorized");
		const authorized = after("I authorize the plan as it stands.");
		has(authorized, "Authorized by the user: change items may run.\n  p2 [change] Write the roller\n  (done: p1)", "after /approve");
		has(authorized, "carry out the plan: p2 is next. Call `task` with its id and a brief", "what to do with an authorized plan");
		has(after("p2 done."), "Every item of the plan is done. Check each open goal against its done-when line.", "every item done");
		hasNot(after("p2 done."), "No goal is recorded", "the goal is there");
		assert.equal(readPlan(root).items.length, 2, "a refused task left the plan alone");

		// A plan left waiting is named at the next start.
		writeFileSync(join(root, ".atlas", "carto-plan.json"), JSON.stringify({ items: [{ id: "p1", mode: "change", text: "by hand" }] }));
		const next = await carto(root, server, ["-p", "say: hi"]);
		has(next.stdout, "\nplan: 1 item · 1 change item not authorized · /plan shows it, /approve authorizes it\n", "the start-up line");
		has(stateOf(server.requests.at(-1)), "  p1 [change] by hand\n", "an edit by hand reaches the agent");
	} finally {
		await server.close();
	}
});

test("change: nothing in the project is written without an authorized plan", async () => {
	const root = makeProject("unauthorized");
	const server = await startStandIn();
	const before = readdirSync(root).sort();
	try {
		const result = await carto(root, server, [], {
			input: lines("look: write: sneaky.txt <<< main", "look: edit: README.md <<< Demo >>> Hacked", "task: write: sneaky.txt <<< look task\\nedit: README.md <<< Demo >>> Hacked", planMessage(LOOK_ITEM, WRITE_ITEM), "task(p2): write: sneaky.txt <<< early", "task(p1): write: sneaky.txt <<< look item", "task(p9): list:", "/approve", planMessage(README_ITEM), "task(p2): write: sneaky.txt <<< after the plan grew"),
		});
		ok(result, "attempts to write without authorization");
		has(result.stdout, "▸ write sneaky.txt  → refused: The main agent does not change files itself.", "the main agent's write");
		has(result.stdout, "▸ edit README.md  → refused: The main agent does not change files itself.", "the main agent's edit");
		has(result.stdout, "│ write sneaky.txt                                 → refused: This is a look task, so it cannot change files.", "a look task's write");
		has(result.stdout, "│ edit README.md                                   → refused: This is a look task, so it cannot change files.", "a look task's edit");
		has(result.stdout, "◂ p2 is a change item and the user has not authorized the plan, so this task was not started and nothing was changed.", "a change item before /approve");
		has(result.stdout, 'There is no plan item "p9". The plan has p1, p2.', "an item that does not exist");
		has(result.stdout, "● plan  authorization withdrawn: a change item was added or changed", "the screen says when the authorization goes");
		assert.equal(result.stdout.split("p2 is a change item and the user has not authorized the plan").length - 1, 4, `refused before /approve and again after the plan grew (each shown twice):\n${result.stdout}`);
		assert.equal(result.stdout.split("│ write sneaky.txt").length - 1, 2, "the task for the look item p1 ran as a look task; the refused change tasks never started");
		assert.deepEqual(readdirSync(root).sort(), [...before, ".atlas"].sort(), "no file was created");
		assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# Demo project\nA small thing for tests.\n", "and none was edited");
		assert.ok(!existsSync(join(root, ".atlas", "checkpoints.git")), "a task that never started takes no checkpoint");
	} finally {
		await server.close();
	}
});

test("change: an authorized change task writes and edits; the main agent gets the record of changed files and not their text", async () => {
	const root = makeProject("change");
	await git(root, "init", "-q");
	await git(root, "-c", "user.name=T", "-c", "user.email=t@t", "add", "-A");
	await git(root, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "start");
	const repo = async () => [(await git(root, "rev-parse", "HEAD")).stdout, (await git(root, "for-each-ref")).stdout, (await git(root, "status", "--porcelain")).stdout];
	const [headBefore, refsBefore] = await repo();
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], {
			input: lines(
				planMessage(WRITE_ITEM),
				"/approve",
				"task(p1): undone\\nread: src/math.js\\nwrite: roll.py <<< import random\\\\nMARKER_WRITTEN = random.randint(1, 6)\\\\n\\nwrite: src/new/deep/util.js <<< export const one = 1;\\\\n\\nedit: src/math.js <<< return a + b; >>> return b + a; // MARKER_EDITED\\nedit: src/math.js <<< not in the file >>> x\\nedit: src/main.js <<< add >>> sum",
			),
		});
		ok(result, "a change task");
		assert.equal(readFileSync(join(root, "roll.py"), "utf8"), "import random\nMARKER_WRITTEN = random.randint(1, 6)\n", "the file was written");
		assert.equal(readFileSync(join(root, "src/new/deep/util.js"), "utf8"), "export const one = 1;\n", "folders are created as needed");
		has(readFileSync(join(root, "src/math.js"), "utf8"), "  return b + a; // MARKER_EDITED\n", "the passage was replaced");
		has(result.stdout, "▸ task p1  undone read: src/math.js", "the call names its plan item");
		has(result.stdout, "│ write roll.py                                    → 2 lines, a new file\n", "write on the screen");
		has(result.stdout, "│ edit src/math.js                                 → 1 line from line 3 replaced by 1 line\n", "edit on the screen");
		has(result.stdout, "→ refused: `old_text` was not found in src/math.js. It must match the file exactly", "an edit that matches nothing");
		has(result.stdout, "→ refused: `old_text` is found 2 times in src/main.js. Add the lines around the passage", "an edit that matches twice");
		has(result.stdout, "◂ changed 3 files (+4 −1)  (/diff shows the changes, /undo takes them back)\n  new      roll.py (+2)\n  changed  src/math.js (+1 −1)\n  new      src/new/deep/util.js (+1)\n", "the record on the screen");

		// What the task was told, and what came back to the main agent.
		const brief = server.requests.map((request) => request.messages.map(messageText).find((text) => text.startsWith("You are now the task"))).find((text) => text !== undefined);
		has(brief, "This is a change task for plan item p1 (Write the roller): besides `read`, `search` and `list`, `write`", "the brief says what kind of task it is");
		const back = messageText(server.requests.at(-1).messages.at(-1));
		has(back, "\n\nCartographer's record of the files changed during this task:\n  new      roll.py (+2)\n  changed  src/math.js (+1 −1)\n  new      src/new/deep/util.js (+1)", "the record follows the report");
		// (The stand-in's brief spells out what to write, so the written text is in the main agent's own call.
		// What must not be there is anything the task read, or the task's write and edit calls.)
		const mainSaw = JSON.stringify(server.requests.at(-1).messages);
		hasNot(mainSaw, "MARKER-ONLY-IN-FILE", "what the task read stays in the task");
		for (const name of ["write", "edit", "read"]) hasNot(mainSaw, `"name":"${name}"`, "the task's working steps stay in the task");

		// The project's own repository is not touched: the changes show up there as ordinary uncommitted work.
		const [headAfter, refsAfter, status] = await repo();
		assert.deepEqual([headAfter, refsAfter], [headBefore, refsBefore], "no commit and no ref in the project's repository");
		assert.equal(status, " M src/math.js\n?? .atlas/\n?? roll.py\n?? src/new/\n", "its status shows the changes as uncommitted work");
		has(readFileSync(join(root, ".atlas", ".gitignore"), "utf8"), "checkpoints.git/", "the checkpoints are kept out of the project's repository");

		// A reply that runs into the output limit in the middle of a write: nothing is written, and the main agent is
		// told why and what to do, not that the report was missing.
		const cut = await carto(root, server, ["-p", "task(p1): undone\nwrite: before-cut.txt <<< kept\\n\ncut\nwrite: after-cut.txt <<< never"]);
		const cutResult = messageText(server.requests.at(-1).messages.at(-1));
		has(cutResult, "The task's reply was cut off at the output limit (8192 tokens for one reply), so the task ended there.", "the cause");
		has(cutResult, "have it write a long file in parts, the first part with `write` and each further part added with `edit`", "what to do");
		has(cutResult, "Cartographer's record of the files changed during this task:\n  new      before-cut.txt (+1)", "what it did before the cut is in the record");
		assert.ok(!existsSync(join(root, "cut-off.txt")) && !existsSync(join(root, "after-cut.txt")), "the cut-off call wrote nothing, and the task did not go on");
		has(cut.stdout, "◂ The task's reply was cut off at the output limit", "the screen says it too");
		const mainCut = await carto(root, server, ["-p", "cut"]);
		has(mainCut.stdout, `! The agent's reply was cut off at the output limit (maxTokens in the settings). Say "continue" to let it go on.`, "the main agent's own reply cut off");
		hasNot(mainCut.stdout, "▸ task", "and the unfinished call is not carried out");

		// A look task between change tasks records nothing; a task that changes nothing says so.
		const idle = await carto(root, server, ["-p", "task(p1): read: roll.py"]);
		has(idle.stdout, "◂ no file was changed", "a change task that only read");
		has(messageText(server.requests.at(-1).messages.at(-1)), "Cartographer's record: no file was changed during this task.", "and the main agent is told so");
	} finally {
		await server.close();
	}
});

test("change: the paths a task may write to", () => {
	const root = makeProject("write-paths");
	const brain = setUpBrain(root).brainDir;
	const outside = join(scratch, "write-outside");
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "target.txt"), "outside\n");
	symlinkSync(outside, join(root, "link-dir"));
	symlinkSync(join(outside, "target.txt"), join(root, "link-file"));
	symlinkSync(join(root, "README.md"), join(root, "link-inside"));
	mkdirSync(join(root, ".git"));
	const refuse = (path, part) => {
		assert.throws(() => writeOne(root, brain, path, "x"), (error) => error instanceof ChangeError && error.message.includes(part), `write ${path} should be refused with: ${part}`);
		assert.throws(() => editOne(root, brain, path, "a", "b"), (error) => error instanceof ChangeError && error.message.includes(part), `edit ${path} should be refused with: ${part}`);
	};
	refuse("../write-outside/new.txt", "is outside the project");
	refuse("/etc/passwd", "is outside the project");
	refuse(join(outside, "target.txt"), "is outside the project");
	refuse("link-dir/new.txt", "leads outside the project (a symlinked folder)");
	refuse("link-dir/deeper/new.txt", "leads outside the project (a symlinked folder)");
	refuse("link-file", "is a symlink");
	refuse("link-inside", "is a symlink");
	refuse(".atlas/carto-plan.json", "is in .atlas/, which is Cartographer's own folder");
	refuse(".git/hooks/pre-commit", "is inside a .git folder");
	refuse("src/.git/config", "is inside a .git folder");
	refuse("ignored.log", "is ignored by git. Checkpoints leave ignored files out, so a change there could not be undone");
	refuse("node_modules/pkg/index.js", "is ignored by git");
	mkdirSync(join(root, "vendor/lib/.git"), { recursive: true });
	mkdirSync(join(root, "vendor/lib/src"));
	refuse("vendor/lib/src/x.js", "is inside vendor/lib, a git repository of its own. Checkpoints do not hold its files");
	refuse("src", "is a folder, not a file");
	refuse(".", "is the project folder, not a file");
	refuse("README.md/below.txt", "README.md is a file, so nothing can be created below it");
	refuse("", "a path is needed");
	assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "outside\n", "nothing outside was touched");
	assert.deepEqual(readdirSync(outside), ["target.txt"], "and nothing was created there");
	assert.equal(confineWrite(root, brain, "./src/../src/math.js").rel, "src/math.js", "a path is brought to its plain form");

	assert.equal(writeOne(root, brain, "notes/a.txt", "one\ntwo\n"), "Wrote notes/a.txt: 2 lines, a new file.");
	assert.equal(writeOne(root, brain, "notes/a.txt", "one\ntwo\nthree"), "Wrote notes/a.txt: 3 lines, replacing a file of 2 lines.");
	assert.equal(editOne(root, brain, "notes/a.txt", "two\nthree", "2"), "Edited notes/a.txt: 2 lines from line 2 replaced by 1 line.");
	assert.equal(editOne(root, brain, "notes/a.txt", "\n2", ""), "Edited notes/a.txt: 2 lines from line 1 replaced by 0 lines.");
	assert.equal(readFileSync(join(root, "notes/a.txt"), "utf8"), "one", "the file after the edits");
	const fails = (work, part) => assert.throws(work, (error) => error instanceof ChangeError && error.message.includes(part), `expected a refusal with: ${part}`);
	fails(() => editOne(root, brain, "notes/missing.txt", "a", "b"), "does not exist. Use `write` to create a file");
	fails(() => editOne(root, brain, "notes/a.txt", "one", "one"), "are the same, so nothing would change");
	fails(() => editOne(root, brain, "notes/a.txt", "", "x"), "`old_text` is required");
	fails(() => writeOne(root, brain, "notes/b.txt", undefined), "`content` is required");
	fails(() => writeOne(root, brain, "notes/big.txt", "x".repeat(1_000_001)), "is larger than 1 MB");
});

test("checkpoints: files come back byte for byte; an undo takes back one task and leaves everything else", () => {
	const root = makeProject("checkpoints");
	const brain = setUpBrain(root).brainDir;
	// A project that asks git to rewrite line endings must still get its bytes back.
	writeFileSync(join(root, ".gitattributes"), "* text=auto eol=lf\n");
	writeFileSync(join(root, "crlf.txt"), "a\r\nb\r\n");
	writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2, 0, 255]));
	assert.equal(lastChange(root, brain), undefined, "nothing to show before any task");
	assert.equal(undo(root, brain), undefined, "and nothing to undo");
	assert.deepEqual([isIgnored(root, brain, "ignored.log"), isIgnored(root, brain, "src/math.js"), isIgnored(root, brain, ".atlas/x"), isIgnored(root, brain, "a/node_modules/b.js")], [true, false, true, true], "what a checkpoint leaves out");

	// The first task: changes, deletes and creates.
	const before1 = checkpoint(root, brain, "before p1: first task");
	writeFileSync(join(root, "crlf.txt"), "changed\n");
	rmSync(join(root, "binary.dat"));
	mkdirSync(join(root, "made/deep"), { recursive: true });
	writeFileSync(join(root, "made/deep/new.txt"), "new\n");
	writeFileSync(join(root, "ignored.log"), "written during the task\n");
	const after1 = checkpoint(root, brain, "after p1");
	assert.deepEqual(
		changesBetween(root, brain, before1, after1),
		[
			{ path: "binary.dat", status: "deleted" },
			{ path: "crlf.txt", status: "changed", added: 1, removed: 2 },
			{ path: "made/deep/new.txt", status: "new", added: 1, removed: 0 },
		],
		"the record of a task",
	);
	// The second task, then the user's own work.
	checkpoint(root, brain, "before p2: second task");
	writeFileSync(join(root, "second.txt"), "2\n");
	checkpoint(root, brain, "after p2");
	writeFileSync(join(root, "users-own.txt"), "written by the user after the tasks\n");
	writeFileSync(join(root, "README.md"), "edited by the user after the tasks\n");

	assert.deepEqual([lastChange(root, brain).item, lastChange(root, brain).changes.map((change) => change.path)], ["p2", ["second.txt"]], "the last change is the second task's, without the user's work");
	const first = undo(root, brain);
	assert.deepEqual([first.item, first.text, first.changes], ["p2", "second task", [{ path: "second.txt", status: "deleted", added: 0, removed: 1 }]], "the first undo takes back the second task");
	assert.ok(!existsSync(join(root, "second.txt")) && existsSync(join(root, "made/deep/new.txt")), "and only that");
	const second = undo(root, brain);
	assert.equal(second.item, "p1", "the next undo takes back the task before it");
	assert.equal(readFileSync(join(root, "crlf.txt"), "utf8"), "a\r\nb\r\n", "a changed file is back, byte for byte");
	assert.deepEqual([...readFileSync(join(root, "binary.dat"))], [0, 1, 2, 0, 255], "a deleted file is back");
	assert.ok(!existsSync(join(root, "made")), "a created file is gone, with the folders made for it");
	assert.equal(readFileSync(join(root, "users-own.txt"), "utf8"), "written by the user after the tasks\n", "the user's new file is left alone");
	assert.equal(readFileSync(join(root, "README.md"), "utf8"), "edited by the user after the tasks\n", "and so is the user's edit to a file no task touched");
	assert.equal(readFileSync(join(root, "ignored.log"), "utf8"), "written during the task\n", "ignored files are not part of it");
	assert.equal(undo(root, brain), undefined, "then nothing is left to undo");
	assert.equal(lastChange(root, brain), undefined, "and nothing to show");

	// A task that was cut off has no checkpoint after it: the undo goes back to the checkpoint before it.
	checkpoint(root, brain, "before p3: cut off");
	writeFileSync(join(root, "half.txt"), "half\n");
	const cut = lastChange(root, brain);
	assert.deepEqual([cut.finished, cut.changes.map((change) => change.path)], [false, ["half.txt"]], "what a cut-off task did is the difference to the files as they are");
	assert.equal(undo(root, brain).item, "p3");
	assert.ok(!existsSync(join(root, "half.txt")), "its file is gone");
});

test("undo: /undo takes the last change task back, reopens its item and withdraws the authorization", async () => {
	const root = makeProject("undo", { git: false });
	const server = await startStandIn();
	try {
		const first = await carto(root, server, [], {
			input: lines(
				planMessage(WRITE_ITEM, README_ITEM),
				"/diff",
				"/undo",
				"/approve",
				"task(p1): write: roll.py <<< roll\\\\n",
				"task(p2): edit: README.md <<< # Demo project >>> # Demo project\\\\nRun roll.py",
				planMessage({ action: "done", id: "p1" }, { action: "done", id: "p2", text: "README mentions it" }),
				"/diff",
				"/undo",
				"/plan",
				"say: what now",
				"task(p2): write: again.txt <<< x",
			),
		});
		ok(first, "a session with an undo");
		has(first.stdout, "  No change task has run that is still in effect.\n  There is no change task left to undo.\n", "/diff and /undo before any change task");
		has(first.stdout, "  p2 · Mention it in the README\n  changed  README.md (+1)\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,3 @@\n # Demo project\n+Run roll.py\n A small thing for tests.\n", "/diff shows the last change task's patch");
		has(first.stdout, "● undone  p2 · Mention it in the README\n  changed  README.md (−1)\n  p2 is open again. The plan needs /approve again before a change item runs.", "/undo says what it did");
		assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# Demo project\nA small thing for tests.\n", "the edit is taken back");
		assert.equal(readFileSync(join(root, "roll.py"), "utf8"), "roll\n", "the task before it is still in effect");
		has(first.stdout, "Not approved: change items wait for the user. Look items may run.\n  ✓ p1 [change] Write the roller\n  p2 [change] Mention it in the README (undone by the user: the files are as they were before this item ran)\n", "/plan after the undo");
		const told = server.requests.map(stateOf).filter((block) => block?.includes("undone by the user")).at(0);
		has(told, "p2 [change] Mention it in the README (undone by the user: the files are as they were before this item ran)", "the agent learns of the undo from the state block");
		has(told, "Do not start p2 before that. No goal is recorded for this plan: agree one with the user", "and that it has to wait; a plan without a goal is pointed out");
		has(first.stdout, "◂ p2 is a change item and the user has not authorized the plan", "a change task after the undo is refused");
		assert.ok(!existsSync(join(root, "again.txt")), "and writes nothing");
		const plan = readPlan(root);
		assert.deepEqual([plan.authorized, plan.items[1].status, plan.items[1].outcome, typeof plan.items[1].undone], [undefined, "open", undefined, "string"], "the plan file after the undo");

		// A second session: the checkpoints are still there. /approve clears the mark; /undo goes one task further back.
		const second = await carto(root, server, [], { input: lines("/approve", "/undo", "/undo") });
		assert.equal(readPlan(root).items[1].undone, undefined, "authorizing again clears the mark");
		has(second.stdout, "● undone  p1 · Write the roller\n  deleted  roll.py (−1)\n  p1 is open again.", "the next undo takes back the first task");
		assert.ok(!existsSync(join(root, "roll.py")), "its file is gone");
		has(second.stdout, "  There is no change task left to undo.", "and then nothing is left");
	} finally {
		await server.close();
	}
});

test("undo: an item the agent already cleared from the plan is put back, so the agent learns of the undo", async () => {
	const root = makeProject("undo-cleared", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], {
			input: lines(
				planMessage(LOOK_ITEM, WRITE_ITEM),
				"/approve",
				"task(p2): write: roll.py <<< roll\\\\n",
				planMessage({ action: "done", id: "p2" }, { action: "clear" }),
				"/undo",
				"say: what now",
				planMessage({ action: "add", mode: "look", text: "Look again" }),
			),
		});
		ok(result, "a session with an undo after the plan was cleared");
		has(result.stdout, "● plan  cleared (2 items)", "the agent cleared its plan");
		has(result.stdout, "● undone  p2 · Write the roller\n  deleted  roll.py (−1)\n  p2 is back in the plan, open. The plan needs /approve again before a change item runs.", "/undo says the item is back");
		assert.ok(!existsSync(join(root, "roll.py")), "the file is gone");
		const told = server.requests.map(stateOf).filter((block) => block?.includes("undone by the user")).at(0);
		has(told, "Not approved: change items wait for the user. Look items may run.\n  p2 [change] Write the roller (undone by the user: the files are as they were before this item ran)", "the agent sees the item again, marked");
		const plan = readPlan(root);
		assert.deepEqual(plan.items.map((item) => `${item.id} ${item.mode} ${item.status}`), ["p2 change open", "p3 look open"], "the plan file: the item is back and later ids go on from where they were");
		assert.equal(plan.authorized, undefined, "nothing is authorized");
	} finally {
		await server.close();
	}
});

test("kill: carto killed in the middle of a change task finishes it at the next start, and the undo goes back to before the task", async () => {
	const root = makeProject("kill-change", { git: false });
	let heldOnce = false;
	const afterFirstWrite = (body) => {
		if (heldOnce || !messageText(body.messages.at(-1)).startsWith("Wrote one.txt")) return false;
		heldOnce = true;
		return true;
	};
	const server = await startStandIn({ holdWhen: afterFirstWrite });
	try {
		ok(await carto(root, server, [], { input: lines(planMessage(WRITE_ITEM), "/approve") }), "plan and authorization");
		const child = spawn(process.execPath, [CARTO, "--url", server.url, "--model", "stand-in", "-p", "task(p1): write: one.txt <<< 1\\nwrite: two.txt <<< 2\\nedit: one.txt <<< 1 >>> one"], { cwd: root, stdio: "ignore" });
		const gone = new Promise((resolve) => child.on("close", resolve));
		await until(() => server.heldCount() === 1, "the task has written its first file");
		child.kill("SIGKILL");
		await gone;
		server.release();
		assert.ok(existsSync(join(root, "one.txt")) && !existsSync(join(root, "two.txt")), "killed after the first write");

		const resumed = await carto(root, server, [], { input: lines("/undo") });
		ok(resumed, "restart after the kill");
		has(resumed.stdout, "│ write two.txt", "the task went on where it was");
		has(resumed.stdout, "│ edit one.txt                                     → 1 line from line 1 replaced by 1 line", "and may still change files: its kind survives the restart");
		has(resumed.stdout, "◂ changed 2 files (+2)\u0020\u0020(/diff", "the record covers the whole task, the part before the kill included");
		has(resumed.stdout, "● undone  p1 · Write the roller\n  deleted  one.txt (−1)\n  deleted  two.txt (−1)\n", "the undo takes back both parts");
		assert.ok(!existsSync(join(root, "one.txt")) && !existsSync(join(root, "two.txt")), "the files are gone");
	} finally {
		await server.close();
	}
});

// ─── The shell ───────────────────────────────────────────────────────────────
// Commands run for real, inside bubblewrap. On a machine without a working bwrap these tests are skipped,
// except the one that checks what Cartographer does without it.

const NO_SANDBOX = () => (findSandbox().ok ? undefined : `no sandbox on this machine: ${findSandbox().why}`);
const RUN_ITEM = { action: "add", mode: "change", text: "Run things" };
const NET_ITEM = { action: "add", mode: "change", network: true, text: "Fetch things" };
/** The text of every result the server was sent for a call of tool `name`, in order, each once. */
function resultsOf(server, name, book, action) {
	const seen = new Map();
	for (const request of server.requests) {
		const calls = new Map();
		for (const message of request.messages) {
			for (const call of message.tool_calls ?? []) calls.set(call.id, call.function);
			if (message.role === "tool") {
				const fn = calls.get(message.tool_call_id);
				if (fn?.name !== name) continue;
				let args = {};
				try { args = JSON.parse(fn.arguments ?? "{}"); } catch {}
				if (book !== undefined && args.book !== book) continue;
				// A window action of the one shell tool: everything but run, the default.
				if (action === "window" && (args.action === undefined || args.action === "run")) continue;
				if (action !== undefined && action !== "window" && (args.action ?? "run") !== action) continue;
				seen.set(message.tool_call_id, messageText(message));
			}
		}
	}
	return [...seen.values()];
}

test("shell: the output keeps its start and its end, without colour codes and redrawn lines", () => {
	const small = new Output();
	small.add("one\ntw");
	small.add("o\n\x1b[31mred\x1b[0m\n10%\r50%\r100%\nwindows\r\nlast, without a line end");
	assert.equal(small.text(), "one\ntwo\nred\n100%\nwindows\nlast, without a line end", "small output is kept whole");
	assert.deepEqual([small.lines, small.omittedLines, small.last], [6, 0, "last, without a line end"], "its counts");

	const big = new Output();
	for (let i = 1; i <= 5000; i++) big.add(`line number ${i}\n`);
	const text = big.text();
	assert.ok(text.startsWith("line number 1\nline number 2\n"), "the start is kept");
	assert.ok(text.endsWith("line number 4999\nline number 5000"), "the end is kept");
	assert.ok(text.length <= HEAD_MAX + TAIL_MAX + 300, `it is bounded: ${text.length} characters`);
	const gap = /\[(\d+) lines left out here: the output was 5000 lines\. To see them, run the command again through grep, head or tail/.exec(text);
	assert.ok(gap, "the gap says how much is missing and how to see it");
	assert.equal(text.split("\n").length - 1 + Number(gap[1]), 5000, "kept and left-out lines add up");
	assert.equal(text.split("\n").length, HEAD_LINES + TAIL_LINES + 1, "it is bounded in lines as well");
	const wide = new Output();
	for (let i = 1; i <= 100; i++) wide.add(`${String(i).padStart(3, "0")} ${"w".repeat(400)}\n`);
	assert.ok(wide.text().length <= HEAD_MAX + TAIL_MAX + 300 && wide.text().endsWith(`100 ${"w".repeat(400)}`), `and in characters: ${wide.text().length}`);

	const long = new Output();
	long.add(`${"x".repeat(LINE_MAX + 500)}\nshort\n`);
	assert.equal(long.text(), `${"x".repeat(LINE_MAX)} [line cut: ${LINE_MAX + 500} characters]\nshort`, "a very long line is shortened");
	const endless = new Output();
	for (let i = 0; i < 300; i++) endless.add("y".repeat(1000));
	assert.ok(endless.text().length < HEAD_MAX + TAIL_MAX + 300, "a line that never ends does not grow without bound");
});

test("shell: a command that makes thousands of files gets a short record", () => {
	const few = [{ path: "a.txt", status: "new", added: 1, removed: 0 }, { path: "src/b.js", status: "changed", added: 2, removed: 1 }];
	assert.deepEqual(changeRecord(few), ["  new      a.txt (+1)", "  changed  src/b.js (+2 −1)"], "a few files are listed one by one");
	const many = [
		{ path: "app.py", status: "changed", added: 3, removed: 1 },
		...Array.from({ length: 900 }, (_, i) => ({ path: `.venv/lib/site/file${i}.py`, status: "new", added: 10, removed: 0 })),
		...Array.from({ length: 50 }, (_, i) => ({ path: `build/out${i}.o`, status: i < 10 ? "deleted" : "new" })),
		{ path: "tests/test_app.py", status: "new", added: 12, removed: 0 },
	];
	assert.deepEqual(
		changeRecord(many),
		["  changed  app.py (+3 −1)", "  folder   .venv/ 900 files: 900 new", "  folder   build/ 50 files: 40 new, 10 deleted", "  new      tests/test_app.py (+12)"],
		"past forty files a folder is one line, and the files that stand alone are still named",
	);
	const flat = Array.from({ length: 60 }, (_, i) => ({ path: `f${i}.txt`, status: "new", added: 1, removed: 0 }));
	assert.deepEqual(changeRecord(flat).slice(-2), ["  new      f39.txt (+1)", "  and 20 more lines like these"], "and the list itself is bounded");
});

/** Shell windows of a project, opened by the test itself rather than by `carto`. */
const windowsOf = (root, brainDir, { mode = "sandbox", read = [] } = {}) => createWindows({ root, brainDir, config: { shellRead: read }, runner: { mode, available: findSandbox() } });
/** A command that rewrites a file twenty times a second, for as long as it lives. */
// The time is taken before the file is opened, so the file is empty for an instant only: a checkpoint or a kill almost never sees it so.
const LOOP = (file) => `while :; do echo $(date +%s%N) > ${file}; sleep 0.05; done`;
/** Whether such a file is still being rewritten. */
async function beating(file) {
	const before = readFileSync(file, "utf8");
	await new Promise((resolve) => setTimeout(resolve, 400 * SLOW));
	return readFileSync(file, "utf8") !== before;
}
/** How the tests start `carto` so that commands run on this machine: in the sandbox where there is one. */
const RUNS = () => (findSandbox().ok ? [] : ["--no-bwrap"]);
const NO_WINDOWS = () => (findScript() ? undefined : "the script program (util-linux) is needed for a shell window");

test("shell: what a window can reach: the project, and not the home folder, the system, the brain, .git or the network", async () => {
	const skip = NO_SANDBOX();
	if (skip) return skip;
	const root = makeProject("sandbox");
	await git(root, "init", "-q");
	const { brainDir } = setUpBrain(root);
	// A home folder with a secret and a toolchain, and an environment with a secret.
	const home = join(scratch, "sandbox-home");
	mkdirSync(join(home, "tools", "bin"), { recursive: true });
	mkdirSync(join(home, ".ssh"));
	mkdirSync(join(home, "docs"));
	writeFileSync(join(home, "docs", "manual.txt"), "the manual\n");
	writeFileSync(join(home, ".ssh", "id_secret"), "PRIVATE-KEY\n");
	writeFileSync(join(home, "tools", "bin", "hello-tool"), "#!/bin/sh\necho hello from the toolchain\n");
	chmodSync(join(home, "tools", "bin", "hello-tool"), 0o755);
	const outside = join(scratch, "outside.txt");
	writeFileSync(outside, "untouched\n");
	const server = await startStandIn();
	const port = new URL(server.url).port;
	const saved = { HOME: process.env.HOME, PATH: process.env.PATH, SECRET: process.env.CARTO_TEST_SECRET };
	Object.assign(process.env, { HOME: home, PATH: `${join(home, "tools", "bin")}:${saved.PATH}`, CARTO_TEST_SECRET: "TOKEN-123" });
	const windows = windowsOf(root, brainDir);
	const withDocs = windowsOf(root, brainDir, { read: ["~/docs"] });
	const sh = (command, { window = "main", network = false, from = windows, waitMs = 20_000, signal } = {}) => from.run(window, command, { network, waitMs, signal });
	try {
		let result = await sh("echo made > made.txt && mkdir -p build && mv src/main.js build/ && rm long.txt && cat made.txt");
		assert.deepEqual([result.reason, result.exit, result.text, result.sandbox, result.network], ["done", 0, "made", true, false], "it works in the project directory");
		assert.ok(existsSync(join(root, "build", "main.js")) && !existsSync(join(root, "long.txt")), "files are written, moved and deleted there");

		result = await sh(`echo x > ${outside}; echo x > /usr/carto-test; echo x > ${home}/real-home.txt; echo "status $?"`);
		has(result.text, "Read-only file system", "writing outside the project fails");
		assert.equal(readFileSync(outside, "utf8"), "untouched\n", "a file next to the project is untouched");
		assert.ok(!existsSync(join(home, "real-home.txt")), "nothing lands in the real home folder");

		result = await sh(`cat ~/.ssh/id_secret; cat ${home}/.ssh/id_secret; echo "home: $(ls -a ~ | tr '\\n' ' ')"; echo "beside: $(ls ${scratch} | tr '\\n' ' ')"`);
		hasNot(result.text, "PRIVATE-KEY", "the home folder's files cannot be read");
		// What is there instead is the sandbox's own home: the file the command before this one wrote, and the toolchain.
		has(result.text, "home: . .. real-home.txt tools \n", "they are not even listed");
		// (outside.txt there is the one the command before wrote into the window's own /tmp; the real one is untouched.)
		has(`${result.text}\n`, "beside: outside.txt sandbox sandbox-home \n", "nor is what lies next to the project in /tmp");
		assert.ok(existsSync(join(brainDir, "home", "real-home.txt")), "what a command writes to its home lands in the sandbox's own");

		result = await sh("hello-tool");
		assert.deepEqual([result.exit, result.text], [0, "hello from the toolchain"], "a PATH entry in the home folder still works");

		// The shellRead setting shows one more folder of the home, read-only.
		result = await sh("cat ~/docs/manual.txt 2>&1; echo x > ~/docs/new.txt");
		has(result.text, "No such file or directory", "a folder of the home that is not named stays hidden");
		result = await sh("cat ~/docs/manual.txt; echo x > ~/docs/new.txt", { from: withDocs, window: "docs" });
		assert.equal(result.text.split("\n")[0], "the manual", "a folder named in shellRead can be read");
		has(result.text, "Read-only file system", "and not written");

		result = await sh("echo kept > ~/cache.txt; touch .atlas/x; echo x > .atlas/home/y; touch .git/x; git status --short | head -1");
		assert.equal((result.text.match(/Read-only file system/g) ?? []).length, 3, `the brain and .git are read-only:\n${result.text}`);
		assert.ok(!existsSync(join(brainDir, "x")) && !existsSync(join(root, ".git", "x")), "nothing was written there");
		has(result.text, "?? ", "git can still read the repository");
		result = await sh("cat ~/cache.txt", { window: "other" });
		assert.equal(result.text, "kept", "the sandbox's own home is the same in every window");
		assert.equal(readFileSync(join(brainDir, "home", "cache.txt"), "utf8"), "kept\n", "it lives in the brain");

		result = await sh("env");
		hasNot(result.text, "TOKEN-123", "the user's environment is not passed on");
		has(`${result.text}\n`, `HOME=${home}\n`, "HOME is the home path");

		// The network belongs to the window: it is what the plan item said when the window was opened.
		const reach = `exec 3<>/dev/tcp/127.0.0.1/${port} && echo reached`;
		result = await sh(reach);
		assert.notEqual(result.exit, 0, "without network, a server on this machine cannot be reached");
		hasNot(result.text, "reached", "without network");
		result = await sh(reach, { window: "net", network: true });
		assert.deepEqual([result.exit, result.text, result.network], [0, "reached", true], "a window opened for an item marked network can");
		await assert.rejects(sh("echo x", { window: "net" }), /Window net was opened by a task whose plan item is marked network, and this task's item is not\. Run this in a window of another name\./, "a task without the mark cannot borrow that window");
		await assert.rejects(sh("echo x", { network: true }), /Window main was opened without network access, and it keeps it that way\. This task may use the network: run this in a window of another name\./, "and a window without network does not get it later");

		result = await sh(`kill -0 ${process.pid}; ps -e -o pid= | wc -l`);
		has(result.text, "No such process", "processes outside the sandbox cannot be signalled");

		// What a command leaves running stays, as in any terminal. It ends when the window is closed.
		result = await sh(`${LOOP("beat.txt")} & sleep 0.3; echo started`);
		assert.deepEqual([result.reason, result.exit, result.text], ["done", 0, "started"], "a command that leaves a process behind returns");
		assert.equal(await beating(join(root, "beat.txt")), true, "and the process goes on in the window");
		windows.close("main");
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(await beating(join(root, "beat.txt")), false, "closing the window ends everything in it");

		// A stop from the user interrupts the command the call is waiting for.
		const stop = new AbortController();
		setTimeout(() => stop.abort(), 300);
		result = await sh("echo going; sleep 60; echo never", { signal: stop.signal });
		assert.deepEqual([result.reason, result.state, result.text.split("\n")[0]], ["stopped", "idle", "going"], "a stop from the user ends the command");
		hasNot(result.text, "never", "and what came after it in the same line");
		result = await sh("echo alive");
		assert.equal(result.text, "alive", "the window itself stays");
	} finally {
		windows.shutdown();
		withDocs.shutdown();
		process.env.HOME = saved.HOME;
		process.env.PATH = saved.PATH;
		delete process.env.CARTO_TEST_SECRET;
		await server.close();
	}
}, { alone: true });

test("windows: a command outlives the call that started it; wait, read, send, stop and close reach it", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("windows");
	const { brainDir } = setUpBrain(root);
	const windows = windowsOf(root, brainDir, { mode: findSandbox().ok ? "sandbox" : "direct" });
	const events = [];
	windows.on((event) => events.push(event));
	const run = (name, command, waitMs = 10_000) => windows.run(name, command, { waitMs });
	try {
		// The folder and the environment stay from one command to the next.
		let result = await run("main", "cd src; export COLOUR=teal; false");
		assert.deepEqual([result.reason, result.exit, result.cwd, result.state], ["done", 1, "src", "idle"], "how a command ended, and where it left the window");
		result = await run("main", "pwd; echo $COLOUR; test -t 1 && echo a terminal");
		assert.equal(result.text, `${root}/src\nteal\na terminal`, "the next command starts where the last one ended, on a terminal");
		result = await run("main", "echo 'unbalanced");
		assert.equal(result.exit, 2, "a command bash cannot read fails");
		has(result.text, "unexpected EOF", "with bash's own words");
		assert.equal((await run("main", "echo still here")).text, "still here", "and the window is not left waiting for the rest of the line");
		assert.equal((await run("main", "echo one\necho two")).text, "one\ntwo", "a command of several lines");

		// A command that has not ended when the call returns keeps running.
		const first = await run("server", "for i in 1 2 3 4 5 6; do echo tick $i; sleep 0.3; done; echo ready", 400);
		assert.deepEqual([first.reason, first.state, first.exit], ["time", "busy", undefined], "the call returns, the command goes on");
		await assert.rejects(run("server", "echo no", 100), (error) => error instanceof WindowError && /^Window server is busy with `for i in 1 2 3 4 5 6; do echo tick \$i; sleep 0\.3; done; echo ready` \(running \d s\)\. To run this beside it, give `shell` another `window` name\. To deal with what is running, use this tool's other actions: wait for it, stop it, or send it a line of input\.$/.test(error.message), "a busy window takes no second command, and says what to do");
		assert.equal((await run("main", "echo beside")).text, "beside", "another window works meanwhile");
		result = await windows.wait("server", { waitMs: 10_000, until: "tick 4" });
		assert.equal(result.reason, "until", "a wait can end at a line");
		assert.equal(`${first.text}\n${result.text}`, "tick 1\ntick 2\ntick 3\ntick 4", "each call returns what was printed since the last one, nothing twice and nothing lost");
		result = await windows.wait("server", { waitMs: 10_000 });
		assert.deepEqual([result.reason, result.exit, result.text, result.state], ["done", 0, "tick 5\ntick 6\nready", "idle"], "or at the command's end");
		assert.equal((await windows.wait("server", { waitMs: 100 })).reason, "idle", "with nothing running there is nothing to wait for");
		assert.deepEqual(events, [], "a command that a call waited for is no news");

		// A command that ends while nobody waits is news: this is what wakes the agent.
		await run("server", "sleep 0.3; echo late", 0);
		await until(() => events.length === 1, "the command's end is announced");
		assert.deepEqual([events[0].type, events[0].name, events[0].exit, events[0].command], ["ended", "server", 0, "sleep 0.3; echo late"], "what is announced");
		assert.equal(windows.hasNews(), true, "it is news");
		windows.noteShown();
		assert.equal(windows.hasNews(), false, "until the main agent has been shown the windows");
		result = await windows.wait("server", { waitMs: 100 });
		assert.deepEqual([result.reason, result.exit, result.text], ["done", 0, "late"], "a wait after the end returns the end");

		// A program that asks.
		result = await run("repl", 'read -p "name? " n; echo "hello $n"; sleep 30');
		assert.deepEqual([result.reason, result.text, result.state], ["asks", "name? ", "busy"], "a program that stops at a line without an end is taken to ask");
		assert.ok(result.ms < 5000, `and the call does not wait out its time: ${result.ms} ms`);
		assert.equal(windows.list().find((entry) => entry.name === "repl").asks, true, "the list says so too");
		result = await windows.send("repl", "momo", { waitMs: 10_000 });
		assert.deepEqual([result.reason, result.text], ["quiet", "name? momo\nhello momo"], "a line typed into it, and what it answered");
		result = await windows.stop("repl");
		assert.deepEqual([result.ended, result.exit, result.state], [true, 130, "idle"], "Ctrl-C ends it and leaves the window free");
		await assert.rejects(windows.send("repl", "x", { waitMs: 100 }), /Nothing is running in window repl, so there is nothing to send input to\./, "input needs a program");
		await run("repl", 'read -p "again? " n', 0);
		await until(() => events.some((event) => event.type === "asks"), "a question nobody waits for is announced", 12_000);
		assert.deepEqual([events.at(-1).name, events.at(-1).line], ["repl", "again? "], "with the line it stopped at");
		assert.equal((await windows.send("repl", "yes", { waitMs: 5000 })).reason, "done", "the answer ends it");

		assert.equal(windows.read("server", 2).text, "$ sleep 0.3; echo late\nlate", "reading a window: its newest lines, commands included");
		assert.deepEqual(windows.list(1).map((entry) => [entry.name, entry.state, entry.cwd, entry.last?.exit, entry.tail]), [["main", "idle", "src", 0, ["beside"]], ["server", "idle", ".", 0, ["late"]], ["repl", "idle", ".", 0, ["again? yes"]]], "the list");

		// Names, and how many.
		await assert.rejects(run("Bad Name", "true"), /A window name is a short word in lower case, such as main, server or tests; "Bad Name" is not\./, "a name");
		await run("four", `${LOOP("beat.txt")} & sleep 0.3; echo started`);
		await assert.rejects(run("five", "true"), /4 windows are open, which is the limit: main, server, repl, four\. Close one with `window` first, or run this in one of them\./, "at most four");
		assert.deepEqual(windows.takeActive().sort(), ["four", "main", "repl", "server"], "which windows ran something");
		assert.deepEqual(windows.takeActive(), [], "is asked once");

		// Closing ends what runs there, also what was left in the background.
		assert.equal(await beating(join(root, "beat.txt")), true, "a background process runs on in its window");
		assert.deepEqual(windows.close("four"), { name: "four" }, "close");
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(await beating(join(root, "beat.txt")), false, "and ends with it");
		assert.throws(() => windows.read("four"), /There is no window "four"\. Open: main, server, repl\./, "a closed window is gone");

		// A command that ends the window's own shell.
		result = await run("main", "echo last words; exit 7");
		assert.deepEqual([result.reason, result.exit, result.state, result.text], ["closed", 7, "closed", "last words"], "exit closes the window, and the call says with which status");
		assert.equal(windows.has("main"), false, "the window is gone");
		result = await run("main", "pwd");
		assert.equal(result.text, root, "and opens anew at the project root");
	} finally {
		windows.shutdown();
	}
});

test("windows: long output keeps its start and its end; what was running at the last exit is reported as gone", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("windows-record");
	const { brainDir } = setUpBrain(root);
	const mode = findSandbox().ok ? "sandbox" : "direct";
	const first = windowsOf(root, brainDir, { mode });
	let second;
	try {
		const big = await first.run("main", "seq 1 6000", { waitMs: 20_000 });
		assert.match(big.text, /^1\n2\n[\s\S]*\n\[\d+ lines left out here: the output was 6000 lines\.[^\n]*\]\n[\s\S]*\n5999\n6000$/, `more than a window keeps: the start and the end are still there:\n${big.text.slice(0, 200)} … ${big.text.slice(-200)}`);
		assert.equal(big.text.split("\n").length, HEAD_LINES + TAIL_LINES + 1, "and the result is bounded");
		assert.equal(first.read("main", 1).kept, 6001, "the window counts every line");
		assert.equal(first.read("main", 400).text.split("\n").length, 400, "and shows at most 400 at a time");
		assert.ok(KEEP_LINES < 6000, "the window itself keeps fewer lines than that");
		const held = first.read("main", 1).lines;
		assert.ok(held >= KEEP_LINES && held <= KEEP_LINES + 1, `and holds no more than its limit: ${held} lines`);

		// A window keeps the way it was opened. The terminal closes all windows at a switch; this is the rule
		// underneath, for a switch that reaches the windows any other way.
		const runner = { mode, available: findSandbox() };
		const switched = createWindows({ root, brainDir, config: { shellRead: [] }, runner });
		try {
			await switched.run("kept", "echo before", { waitMs: 10_000 });
			runner.mode = mode === "sandbox" ? "direct" : "sandbox";
			await assert.rejects(
				switched.run("kept", "echo after", { waitMs: 10_000 }),
				(error) => error instanceof WindowError && error.message === `Window kept was opened ${mode === "sandbox" ? "in the sandbox" : "with the sandbox off"}, and that has changed since. Close it with \`window\`, then run this again: the window opens anew.`,
				"a window opened one way takes no command once the sandbox was switched",
			);
		} finally {
			switched.shutdown();
		}

		await first.run("server", "echo listening; sleep 60", { waitMs: 300 });
		assert.deepEqual(JSON.parse(readFileSync(join(brainDir, "carto-windows.json"), "utf8")), { open: [{ name: "main" }, { name: "server", command: "echo listening; sleep 60" }], gone: [] }, "the record of what is open");

		// The next start of the program: its windows ended with it.
		second = windowsOf(root, brainDir, { mode });
		assert.deepEqual(second.list(), [{ name: "server", state: "gone", why: "it ended when Cartographer last exited", command: "echo listening; sleep 60", tail: [] }], "a window that was running something is reported; one that stood free is not");
		assert.throws(() => second.read("server"), /Window server is gone: it ended when Cartographer last exited, and with it `echo listening; sleep 60`\. `shell` with this window name opens a new one\./, "asking for it says what happened");
		assert.deepEqual(second.close("server"), { name: "server", wasGone: true }, "closing it clears the line");
		assert.deepEqual(second.list(), [], "and it is forgotten");
	} finally {
		first.shutdown();
		second?.shutdown();
	}
});

test("windows: what the windows block says about them", () => {
	assert.equal(windowsBlock([]), "", "no window, no block");
	assert.equal(windowsBlock(undefined), "", "nor without a session");
	const shown = [
		{ name: "main", state: "idle", cwd: "src", network: false, sandbox: true, last: { command: "npm test", exit: 1, ms: 4000, ago: 120_000 }, tail: ["$ npm test", "2 failed", "done"] },
		{ name: "server", state: "busy", cwd: ".", network: true, sandbox: true, command: "python -m http.server\n  8000", running: 65_000, quiet: 3000, asks: false, tail: ["b", "c", "d", "e", "f", "g"] },
		{ name: "repl", state: "busy", cwd: "tools", network: true, sandbox: false, command: "python", running: 5000, quiet: 4000, asks: true, tail: [">>> "] },
		{ name: "old", state: "gone", why: "it ended when Cartographer last exited", command: "make watch", tail: [] },
		{ name: "fresh", state: "idle", cwd: ".", network: false, sandbox: true, tail: [] },
	];
	const text = windowsBlock(shown);
	assert.equal(
		text,
		[
			"<windows>",
			"Written by Cartographer, not by the user. The shell windows as they are at this moment:",
			"  main · free, in src/ · last: `npm test` ended with exit 1, 2 m ago",
			"    | 2 failed",
			"    | done",
			"  server · busy for 1 m 5 s with `python -m http.server …` · network",
			"    | b",
			"    | c",
			"    | d",
			"    | e",
			"    | f",
			"    | g",
			"  repl · busy for 5 s with `python`, in tools/ · no sandbox · nothing printed for 4 s and its last line has no line end: it may be waiting for input",
			"    | >>> ",
			"  old · gone: it ended when Cartographer last exited, and `make watch` ended with it. `window` close clears this line.",
			"  fresh · free · nothing was run in it yet",
			"A window keeps running what was started in it until it is stopped or closed. Close the ones nobody needs any more.",
			"</windows>",
		].join("\n"),
	);
	// How much of a busy window's output is shown is a setting; a free window shows at most three lines.
	const long = [{ name: "w", state: "busy", cwd: ".", network: false, sandbox: true, command: "make", running: 1000, quiet: 0, asks: false, tail: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`) }];
	assert.deepEqual(windowsBlock(long).split("\n").slice(3, -2), Array.from({ length: 10 }, (_, i) => `    | line ${i + 21}`), "ten lines of a busy window unless the setting says otherwise");
	assert.equal(windowsBlock(long, { tail: 4 }).split("\n").slice(3, -2).length, 4, "the setting");
	assert.equal(windowsBlock([{ ...shown[0], tail: ["a", "b", "c", "d", "e"] }]).split("\n").slice(3, -2).join(), "    | c,    | d,    | e", "three of a free one");
	assert.equal(windowsBlock(long, { tail: 2 }).split("\n").slice(3, -2).length, 2, "and fewer when the setting is smaller");
	// Taking the block out of a text leaves the text; a mention of the tags is not a block.
	assert.equal(withoutWindows(`before\n\n${text}`), "before", "the block can be taken out again");
	const mention = "ends with a block between <windows> and </windows>, yours";
	assert.equal(withoutWindows(mention), mention, "a sentence that names the tags is left alone");
	// A note Cartographer writes to wake the agent is not a message of the user.
	const note = wakeNote([{ type: "ended", name: "build", command: "make all\n  -j4", exit: 2, ms: 75_000 }, { type: "asks", name: "repl", command: "python", line: ">>> " }]);
	assert.equal(
		note,
		[
			"<cartographer>",
			"Written by Cartographer, not by the user. Nobody typed this. It tells you what happened while you were not working.",
			"",
			"Window build: `make all` ended with exit 2 after 1 m 15 s.",
			"Window repl: `python` has printed nothing for a while and its last line has no line end, so it may be waiting for input. The line: >>> ",
			"",
			"Decide what this means for the goal and act on it. When nothing needs doing, call `sleep` and write nothing: a turn in which you did nothing else is forgotten when the next such note comes.",
			"</cartographer>",
		].join("\n"),
	);
	assert.equal(isNote({ role: "user", content: [{ type: "text", text: note }] }), true, "a note is known by its first lines");
	assert.equal(isNote({ role: "user", content: "<cartographer> is a tag I typed myself" }), false, "what the user types is not taken for one");
	const at = Date.UTC(2026, 0, 5, 10, 0);
	const timed = withTimes([{ role: "user", content: note, timestamp: at }, { role: "user", content: "hello", timestamp: at }]);
	assert.match(timed[0].content, /<\/cartographer>\n\n\[noted [A-Z]/, "a note is marked as noted");
	assert.match(timed[1].content, /^hello\n\n\[sent [A-Z]/, "and a message of the user as sent");
	assert.equal(withoutAdditions(timed[0].content), note, "the mark comes off again like the other");
});

test("shell: only a change task of the authorized plan types into a window; the task gets the output and the exit status", async () => {
	const skip = NO_SANDBOX();
	if (skip) return skip;
	const root = makeProject("shell", { git: false });
	writeFileSync(join(root, "app.py"), 'print("hello from app")\n');
	const server = await startStandIn();
	const port = new URL(server.url).port;
	try {
		const result = await carto(root, server, [], {
			timeoutMs: 60_000,
			input: lines(
				"look: shell: echo main > main.txt",
				"task: shell: echo look > look.txt",
				planMessage(RUN_ITEM, NET_ITEM),
				"task(p1): shell: echo early > early.txt",
				"/approve",
				`task(p1): shell: cat app.py; echo made > made.txt; rm long.txt\\nshell: cd src; pwd; ls\\nshell: pwd\\nshell[wait=1]: echo before; sleep 30; echo after\\nshell: echo second\\nwindow: main stop\\nshell: echo to-stderr >&2; (exit 3)\\nshell: seq 1 6000\\nshell: exec 3<>/dev/tcp/127.0.0.1/${port} && echo reached\\nshell: exit 5\\nshell: pwd`,
				`task(p2): shell: echo in-main\\nshell[window=net]: exec 3<>/dev/tcp/127.0.0.1/${port} && echo reached\\nshell[window=net]: mkdir gen; for i in $(seq 1 60); do echo $i > gen/f$i.txt; done`,
			),
		});
		ok(result, "a session with commands");
		has(result.stdout, "sandbox: bubblewrap ", "the header names the sandbox");
		has(result.stdout, "→ refused: The main agent does not run commands itself.", "the main agent is refused");
		has(result.stdout, "│   → refused: This is a look task, so it cannot run commands.", "a look task is refused");
		has(result.stdout, "◂ p1 is a change item and the user has not authorized the plan", "a change item before /approve is not started");
		for (const name of ["main.txt", "look.txt", "early.txt"]) assert.ok(!existsSync(join(root, name)), `${name} was not written`);

		has(result.stdout, "● plan  + p2 [change, network] Fetch things", "the plan shows which item has the network");
		has(result.stdout, "plan  2 change items wait for you (1 with network access): /plan shows the plan, /approve authorizes it", "and so does the line that asks for /approve");
		has(result.stdout, "  p2 Fetch things  · its commands reach the network\n", "and the authorization");

		const outputs = resultsOf(server, "shell", undefined, "run").filter((text) => !text.includes("Tool call blocked"));
		assert.equal(outputs.length, 13, `thirteen commands were answered:\n${outputs.join("\n---\n")}`);
		assert.match(outputs[0], /^print\("hello from app"\)\n\[exit 0 · \d+\.\d s · window main\]$/, "the output, then the exit status, the time and the window");
		assert.equal(readFileSync(join(root, "made.txt"), "utf8"), "made\n", "the command wrote into the project");
		assert.match(outputs[1], new RegExp(`^${root}/src\\ndeep\\s+main\\.js\\s+math\\.js\\n\\[exit 0 · \\d+\\.\\d s · window main, in src/\\]$`), "a command that changes the folder: the status line says where the window is now (ls prints in columns: it is on a terminal)");
		assert.match(outputs[2], new RegExp(`^${root}/src\\n\\[exit 0`), "and the next command starts there");
		assert.match(outputs[3], /^before\n\[still running after 1\.0 s in window main: the command keeps going there, and you can go on with other work\. The windows block at the end of each request shows how it is doing\. The same tool's actions wait for it, send it input, stop it or close it\. A run with another window name runs something beside it\.\]$/, "a command that takes longer than the call waits: it keeps running");
		assert.match(outputs[4], /^Refused: Window main is busy with `echo before; sleep 30; echo after` \(running \d s\)\. To run this beside it, give `shell` another `window` name\./, "the window is busy meanwhile");
		assert.match(resultsOf(server, "shell", undefined, "window")[0], /^\^C\n\[stopped with Ctrl-C: exit 130 · window main is free\]$/, "`window` stops it");
		assert.match(outputs[5], /^to-stderr\n\[exit 3 · \d+\.\d s · window main, in src\/ · this window has no network\]$/, "errors are part of the output; a failure names the missing network");
		assert.match(outputs[6], /^1\n2\n[\s\S]*\n\[\d+ lines left out here: the output was 6000 lines\.[^\n]*\]\n[\s\S]*\n5999\n6000\n\[exit 0/, `long output is cut in the middle:\n${outputs[6].slice(0, 300)} … ${outputs[6].slice(-300)}`);
		assert.equal(outputs[6].split("\n").length, HEAD_LINES + TAIL_LINES + 2, "and bounded, with the line on how it ended still there");
		hasNot(outputs[7], "reached", "a window of an item without the mark has no network");
		assert.equal(outputs[8], "(no output)\n[exit 5 · the command ended the window's own shell (`exit` does that), so window main is closed, and its folder and environment are gone. The next `shell` call opens it anew, in the project directory.]", "a command that exits the shell closes the window, and is told so");
		assert.match(outputs[9], new RegExp(`^${root}\\n\\[exit 0 · \\d+\\.\\d s · window main\\]$`), "the next command opens it anew at the project root");
		assert.equal(outputs[10], "Refused: Window main was opened without network access, and it keeps it that way. This task may use the network: run this in a window of another name.", "a task with network does not get it in a window opened without");
		assert.match(outputs[11], /^reached\n\[exit 0 · \d+\.\d s · window net\]$/, "in a window of its own it has it");

		has(result.stdout, "│ $ cd src; pwd; ls\n│   → exit 0 · ", "the screen shows the command, then how it ended");
		has(result.stdout, "│ $ echo before; sleep 30; echo after\n│   → still running after 1.0 s · before\n", "a command that is still running");
		assert.match(result.stdout, /│ window main  stop {2,}→ stopped · exit 130 · \d\.\d s · \^C\n/, "the stop");
		has(result.stdout, "│ $ echo to-stderr >&2; (exit 3)\n│   → exit 3 · ", "a failing command");
		has(result.stdout, "│ $ exit 5\n│   → exit 5 · the window closed\n", "a window that closed");
		has(result.stdout, `│ $ exec 3<>/dev/tcp/127.0.0.1/${port} && echo reached  (window net)\n│   → exit 0 · `, "a command in a window that is not main names it");
		has(result.stdout, "◂ changed 2 files (+1 −700)  (/diff shows the changes, /undo takes them back)\n  deleted  long.txt (−700)\n  new      made.txt (+1)\n", "what the commands did to the files is in the record");

		// A command that makes many files: the record names the folder, not each file.
		has(messageText(server.requests.at(-1).messages.at(-1)), "\n\nCartographer's record of the files changed during this task:\n  folder   gen/ 60 files: 60 new", "the record the main agent gets is short");
		has(result.stdout, "◂ changed 60 files (+60)  (/diff shows the changes, /undo takes them back)\n  folder   gen/ 60 files: 60 new\n", "and so is the screen's");

		const briefs = server.requests.flatMap((request) => request.messages.map(messageText).filter((text) => text.startsWith("You are now the task")));
		has(briefs.find((text) => text.includes("plan item p1")), "`write`, `edit` and `shell` work for you, inside the project directory. Change only what the brief asks for. Cartographer records every file you change, and the user can undo it. When what you wrote can be run, run it, and put the command and what it printed into your report. Commands in this task have no network;", "the brief of a change task");
		has(briefs.find((text) => text.includes("plan item p2")), "Commands in this task can reach the network.", "the brief of a task with network");
		has(server.requests[0].messages[0].content, "Running. A change task runs commands with `shell`, which types them into a shell window: a bash that stays open under a name.", "the prompt says how commands are run");
		assert.deepEqual(server.requests[0].tools.map((tool) => tool.function.name).filter((name) => name === "shell" || name === "window"), ["shell"], "the one tool for the windows");

		// The undo takes back what the commands did.
		const undone = await carto(root, server, [], { input: lines("/undo", "/undo") });
		has(undone.stdout, "● undone  p2 · Fetch things\n  folder   gen/ 60 files: 60 deleted\n", "the undo of the many files");
		assert.ok(!existsSync(join(root, "gen")), "the folder the command made is gone");
		has(undone.stdout, "● undone  p1 · Run things\n  new      long.txt (+700)\n  deleted  made.txt (−1)\n", "the undo restores the deleted file and removes the new one");
		assert.ok(existsSync(join(root, "long.txt")) && !existsSync(join(root, "made.txt")), "the files are as before");
		hasNot(undone.stdout, "windows: ", "windows that stood free when carto left are not mentioned at the next start");
	} finally {
		await server.close();
	}
});

test("windows: the main agent and every task see the windows at the end of each request; reading, waiting, stopping and closing are open to all, typing is not", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("windows-main", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, RUNS(), {
			timeoutMs: 60_000,
			input: lines(
				planMessage(RUN_ITEM),
				"/approve",
				"window: main read",
				"task(p1): shell: cd src; echo one\\nshell[window=server,wait=0]: echo listening; sleep 30\\nlist",
				"say: hello",
				"window[seconds=5]: server wait listening",
				"window[lines=1]: server read",
				"look: window: server send hi",
				"task: window: server read\\nwindow: server send hi",
				"window: server stop",
				"window: server close",
				"/status",
				"window: main close",
				"/shells",
			),
		});
		ok(result, "a session with windows");
		const answers = resultsOf(server, "shell", undefined, "window").filter((text) => !text.includes("Tool call blocked"));
		assert.equal(answers[0], 'Refused: There is no window "main". No window is open: `shell` opens one when it runs a command.', "before any window is open");

		// The task's result says what it left running.
		const report = server.requests.flatMap((request) => request.messages.map(messageText)).find((text) => text.includes("Windows still running after this task"));
		assert.match(report, /\n\nWindows still running after this task: server \(`echo listening; sleep 30`, for \d s\)\. The windows block at the end of the request shows how they are doing\./, "the record names the windows that are still at work");
		has(result.stdout, "◂ still running: window server  (/shells shows them, /kill NAME ends one)\n", "and so does the screen");

		// The windows block: every window, what runs there, its newest lines; the last thing in the request.
		const hello = server.requests.find((request) => rawText(request.messages.at(-1)).startsWith("say: hello"));
		const block = windowsIn(hello);
		assert.match(
			block ?? "",
			/^<windows>\nWritten by Cartographer, not by the user\. The shell windows as they are at this moment:\n  main · free, in src\/(?: · no sandbox)? · last: `cd src; echo one` ended with exit 0, (?:just now|\d s ago)\n    \| one\n  server · busy for \d s with `echo listening; sleep 30`(?: · no sandbox)?\n    \| \$ echo listening; sleep 30\n    \| listening\nA window keeps running what was started in it until it is stopped or closed\. Close the ones nobody needs any more\.\n<\/windows>$/,
			`the windows block of the main agent:\n${rawText(hello.messages.at(-1))}`,
		);
		has(rawText(hello.messages.at(-1)), "\n</state>\n\n<windows>\n", "it follows the state block: what changes most comes last");
		hasNot(stateOf(hello), "listening", "and the state block itself holds no window");
		assert.equal(windowsIn(server.requests[0]), undefined, "with no window open there is no block");
		for (const request of server.requests) assert.ok(windowsCount(request) <= 1, "a request never holds more than one: the block is not stored");

		assert.match(answers[1], /^listening\n\[the line appeared after \d\.\d s; the command is still running in window server\]$/, "the main agent waits for a line; one printed before the call counts");
		assert.match(answers[2], /^listening\n\[window server: busy with `echo listening; sleep 30` for \d s · 2 lines in all\]$/, "and reads");
		has(result.stdout, '▸ window server  send  "hi"  → refused: The main agent does not run commands itself.', "typing into a window is refused to the main agent");
		// A task sees the same block, at the end of each of its requests and nowhere in what is stored.
		const lookRequests = server.requests.filter((request) => request.messages.some((message) => messageText(message).startsWith("You are now the task")) && request.messages.some((message) => rawText(message).includes("This is a look task")));
		assert.ok(lookRequests.length >= 2, "the look task made several requests");
		for (const request of lookRequests) {
			assert.match(windowsIn(request) ?? "", /^<windows>\n[^\n]*\n  main · free, in src\/[^\n]*\n    \| one\n  server · busy for \d+ s with `echo listening; sleep 30`[^\n]*\n    \| \$ echo listening; sleep 30\n    \| listening\nA window keeps/, `each request of a task ends with the windows:\n${rawText(request.messages.at(-1))}`);
			assert.equal(stateOf(request), undefined, "and still has no state block");
			assert.equal(windowsCount(request), 1, "one block, on the last message only");
		}
		const brief = server.requests.flatMap((request) => request.messages.map(messageText)).filter((text) => text.startsWith("You are now the task")).at(-1);
		hasNot(brief, "busy for", "the stored brief holds no copy of the windows, which would go stale");
		assert.match(answers[3], /^\$ echo listening; sleep 30\nlistening\n\[window server: busy with /, "a look task reads a window");
		has(result.stdout, '│ window server  send  "hi"\n│   → refused: This is a look task, so it cannot run commands.', "and cannot type into it");
		assert.match(answers.find((text) => text.includes("stopped with Ctrl-C")), /^\^C\n\[stopped with Ctrl-C: exit 130 · window server is free\]$/, "the main agent stops a command");
		has(answers, "Window server is closed.", "and closes a window");
		assert.match(result.stdout, /▸ window server {2}stop {2}→ stopped · exit 130 · \d+(\.\d)? s/, "the screen shows it");
		has(result.stdout, "  1 shell window open, 0 busy · /shells shows them\n", "/status counts the windows");
		has(result.stdout, "  No shell window is open. A change task opens one when it runs a command.\n", "/shells when the last one is closed");
	} finally {
		await server.close();
	}
});

test("windows: the agent is woken when a command ends while it rests; what the window changed is a step of its own", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("windows-wake", { git: false });
	const server = await startStandIn();
	try {
		const command = "sleep 1; echo built > out.txt; echo finished";
		const result = await carto(root, server, RUNS(), {
			timeoutMs: 60_000,
			input: lines(
				planMessage(RUN_ITEM),
				"/approve",
				"say: noted. ON WAKE: window: build read",
				`task(p1): write: a.txt <<< by the task\\nshell[window=build,wait=0]: ${command}`,
				"/wait 20",
				"/diff",
				"/undo",
				"/undo",
			),
		});
		ok(result, "a session where a command ends by itself");
		has(result.stdout, "◂ changed 1 file (+1)  (/diff shows the changes, /undo takes them back)\n  new      a.txt (+1)\n", "the task's own change");
		has(result.stdout, "◂ still running: window build  ", "the task left a command running");
		has(result.stdout, `◆ Window build: \`${command}\` ended with exit 0 after 1 s.\n`, "the screen says when it ended");
		has(result.stdout, "◂ window build changed 1 file (+1) with no task running  (/diff shows the changes, /undo takes them back)\n  new      out.txt (+1)\n", "and what it changed after the task was over");

		// The note that wakes the agent.
		const woken = server.requests.find((request) => rawText(request.messages.at(-1)).startsWith("<cartographer>"));
		assert.ok(woken, "the agent was sent a note");
		const note = rawText(woken.messages.at(-1));
		has(note, `<cartographer>\nWritten by Cartographer, not by the user. Nobody typed this. It tells you what happened while you were not working.\n\nWindow build: \`${command}\` ended with exit 0 after 1 s.\nFiles changed while window build ran with no task around: 1 file (+1). The user can see them with /diff and take them back with /undo.\n\n`, "what it says");
		has(note, "</cartographer>\n\n[noted ", "it is marked as noted, not as sent by the user");
		assert.match(windowsIn(woken), /\n {2}build · free(?: · no sandbox)? · last: `sleep 1; echo built > out\.txt; echo finished` ended with exit 0, (?:just now|\d s ago)\n {4}\| finished\n/, "and the windows block shows the window");
		assert.match(stateOf(woken), /\nNow: [^\n]*\. The user's newest message came (?:just now|\d+ s ago)\./, "the note does not count as a message of the user");
		has(result.stdout, "▸ window build  read  → ", "the agent acts on it by itself");
		has(result.stdout, "Report received: $ sleep 1; echo built > out.txt; echo finished\nfinished\n[window build: nothing is running", "and gets what it asked for");

		// The step of its own: shown by /diff, taken back by /undo, and the task's step is the one before it.
		has(result.stdout, "  window build · files changed while the window ran, outside a task\n  new      out.txt (+1)\n", "/diff shows the window's step");
		has(result.stdout, "● undone  window build · files changed while the window ran, outside a task\n  deleted  out.txt (−1)\n  The plan is as it was, and the window may still be running: /shells shows it. Tell the agent what you took back.\n", "/undo takes it back");
		has(result.stdout, "● undone  p1 · Run things\n  deleted  a.txt (−1)\n", "/undo again takes the task back");
		assert.ok(!existsSync(join(root, "out.txt")) && !existsSync(join(root, "a.txt")), "both files are gone");

		// With a terminal the agent is woken without anyone asking.
		ok(await carto(root, server, RUNS(), { input: lines("/approve") }), "the plan authorized again");
		const live = await cartoOnTerminal(root, server, RUNS(), [
			["Type a message", "task(p1): shell[window=build,wait=0]: sleep 1; echo finished"],
			["Woken: ", "/quit"],
		]);
		if (live === undefined) return "python3 is needed for a terminal";
		has(live.screen, "◆ Window build: `sleep 1; echo finished` ended with exit 0 after 1 s.\n", "on a terminal: the line");
		has(live.screen, "Woken: Window build: `sleep 1; echo finished` ended with exit 0 after 1 s.", "and the agent's answer to the note");
	} finally {
		await server.close();
	}
});

test("windows: what ended while the agent worked was shown to it and does not wake it; the user's own edits are no window's step", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("windows-seen", { git: false });
	const server = await startStandIn();
	try {
		const quick = "sleep 0.4; echo finished";
		const first = await carto(root, server, RUNS(), {
			timeoutMs: 60_000,
			input: lines(planMessage(RUN_ITEM), "/approve", `task(p1): write: a.txt <<< by the task\\nshell[window=bg,wait=0]: ${quick}\\nshell: sleep 1.5; echo slow`, "/wait 3", "say: bye"),
		});
		ok(first, "a command that ends while the task is still at work");
		const after = server.requests.find((request) => stateOf(request) !== undefined && windowsIn(request)?.includes("\n  bg · "));
		assert.ok(after, "the main agent's request after the task");
		assert.match(windowsIn(after), /\n {2}bg · free(?: · no sandbox)? · last: `sleep 0\.4; echo finished` ended with exit 0, (?:just now|\d s ago)\n {4}\| finished\n/, "the windows block shows that the command ended");
		hasNot(first.stdout, "◆ Window bg", "so the agent is not woken for what it was already shown");
		assert.equal(server.requests.some((request) => rawText(request.messages.at(-1)).startsWith("<cartographer>")), false, "and no note is sent");
		hasNot(first.stdout, "with no task running", "what the window did during the task is the task's step");

		// The user edits a file while no window is at work: that is nobody's step, and /undo does not touch it.
		writeFileSync(join(root, "mine.txt"), "by hand\n");
		const second = await carto(root, server, RUNS(), { input: lines("/diff", "/undo") });
		ok(second, "the next start");
		hasNot(second.stdout, "with no task running", "nothing is recorded under a window's name");
		has(second.stdout, "● undone  p1 · Run things\n  deleted  a.txt (−1)\n", "/undo takes the task back");
		assert.equal(readFileSync(join(root, "mine.txt"), "utf8"), "by hand\n", "and leaves the user's file alone");
	} finally {
		await server.close();
	}
});

test("windows: what a window changed between two tasks is recorded before the second one starts, as its own step", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("windows-between", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, RUNS(), {
			timeoutMs: 60_000,
			input: lines(
				planMessage(RUN_ITEM, { action: "add", mode: "change", text: "Write more" }),
				"/approve",
				"task(p1): write: a.txt <<< first\\nshell[window=bg,wait=0]: sleep 0.5; echo late > late.txt; echo written; sleep 30",
				"window[seconds=10]: bg wait written",
				"task(p2): write: b.txt <<< second",
				"/undo",
				"/undo",
			),
		});
		ok(result, "two tasks with a window at work between them");
		const second = resultsOf(server, "task").at(-1);
		has(second, "Cartographer's record of the files changed during this task:\n  new      b.txt (+1)\n", "the second task's record holds its own file only");
		has(second, "\n\nBefore this task started, Cartographer recorded what changed while window bg ran with no task around, as a step of its own:\n  new      late.txt (+1)", "and says what the window did before it");
		has(result.stdout, "◂ window bg changed 1 file (+1) with no task running  (/diff shows the changes, /undo takes them back)\n  new      late.txt (+1)\n", "the screen shows the window's step");
		has(result.stdout, "● undone  p2 · Write more\n  deleted  b.txt (−1)\n", "/undo takes the second task back");
		has(result.stdout, "● undone  window bg · files changed while the window ran, outside a task\n  deleted  late.txt (−1)\n", "/undo again takes the window's step back, and only that");
		assert.deepEqual([existsSync(join(root, "a.txt")), existsSync(join(root, "late.txt")), existsSync(join(root, "b.txt"))], [true, false, false], "the first task's file stays");
	} finally {
		await server.close();
	}
});

test("windows: a task that left a command running sees its progress at the end of each request; the windowTail setting bounds the lines", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("windows-live", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, RUNS(), { input: lines(planMessage(RUN_ITEM, { action: "add", mode: "change", text: "Run more" }), "/approve") }), "plan and authorization");
		const before = server.requests.length;
		const command = "echo one; sleep 1; echo two; sleep 30";
		ok(await carto(root, server, RUNS(), { timeoutMs: 60_000, input: lines(`task(p1): shell[window=bg,wait=0]: ${command}\\nshell: sleep 1.6; echo slow`) }), "a task with a command in the background");
		const mine = server.requests.slice(before).filter((request) => request.messages.some((message) => rawText(message).includes("This is a change task for plan item p1")));
		assert.equal(mine.length, 3, "the task made three requests: the brief, and one after each command");
		assert.equal(windowsIn(mine[0]), undefined, "before any window is open, a task's request has no block");
		assert.match(windowsIn(mine[1]) ?? "", /\n {2}bg · busy for \d s with `echo one; sleep 1; echo two; sleep 30`[^\n]*\n {4}\| \$ echo one; sleep 1; echo two; sleep 30\n(?: {4}\| one\n)?A window keeps/, `after starting it: busy, and what it printed so far:\n${rawText(mine[1].messages.at(-1))}`);
		hasNot(windowsIn(mine[1]), "| two", "the second line is not printed yet");
		assert.match(windowsIn(mine[2]) ?? "", /\n {2}bg · busy for \d s with [^\n]*\n {4}\| \$ echo one; sleep 1; echo two; sleep 30\n {4}\| one\n {4}\| two\n {2}main · free[^\n]* · last: `sleep 1\.6; echo slow` ended with exit 0, just now\n {4}\| slow\nA window keeps/, `one command later, without asking: the line it printed meanwhile, and the window the task just used:\n${rawText(mine[2].messages.at(-1))}`);
		for (const request of mine) assert.ok(windowsCount(request) <= 1, "the block of an earlier request is not sent again");
		assert.deepEqual(stored(mine[1]).map(rawText), stored(mine[2]).slice(0, mine[1].messages.length).map(rawText), "apart from the block, what was sent before is sent again unchanged");

		// The setting.
		writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ windowTail: 2 }));
		const next = server.requests.length;
		ok(await carto(root, server, RUNS(), { timeoutMs: 60_000, input: lines(`task(p2): shell[window=bg,wait=0]: ${command}\\nshell: sleep 1.6; echo slow`) }), "the same with windowTail 2");
		const last = server.requests.slice(next).filter((request) => request.messages.some((message) => rawText(message).includes("This is a change task for plan item p2"))).at(-1);
		assert.match(windowsIn(last) ?? "", /\n {2}bg · busy for \d s with [^\n]*\n {4}\| one\n {4}\| two\n {2}main · free/, `two lines of the busy window:\n${windowsIn(last)}`);
		for (const [value, message] of [[0, "config: windowTail must be a whole number, 1 or more"], [41, "config: windowTail must be a whole number from 1 to 40"]]) {
			writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ windowTail: value }));
			const refused = await carto(root, server, [], { input: "" });
			assert.notEqual(refused.code, 0, `windowTail ${value} is refused`);
			has(refused.stderr, message, "and the message says what is allowed");
		}
	} finally {
		await server.close();
	}
});

test("windows: an agent that its windows keep waking is slowed down, and not stopped", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("windows-loop", { git: false });
	mkdirSync(join(root, ".atlas"), { recursive: true });
	// One more wake becomes free every 3 seconds.
	writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ wakeMin: 3 }));
	const server = await startStandIn();
	try {
		// (`undone`: the task returns not done, so the item stays open for the next one.)
		const again = "task(p1): undone\\nshell[window=w,wait=0]: sleep 0.2";
		const started = Date.now();
		const result = await carto(root, server, RUNS(), { timeoutMs: 120_000, input: lines(planMessage(RUN_ITEM), "/approve", `say: noted. ON EVERY WAKE: ${again}`, again, "/wait 16", "/wakes", again, "/wait 2") });
		const seconds = (Date.now() - started) / 1000;
		ok(result, "a session that wakes itself");
		const told = `! The agent was woken ${WAKE_BURST} times in quick succession without a word from you. From here on it is woken at most once every 3 s; what happens meanwhile is told together. Write something to lift this; /stop stops it, /wakes and /shells show what wakes it.\n`;
		assert.equal(result.stdout.split(told).length - 1, 1, `the user is told once:\n${result.stdout}`);
		const [quick, slow] = result.stdout.split(told);
		const wakesIn = (text) => text.split("\n").filter((line) => line.startsWith("◆ Window w: `sleep 0.2` ended with exit 0")).length;
		assert.ok(wakesIn(quick) >= WAKE_BURST, `the first ${WAKE_BURST} come at once: ${wakesIn(quick)}`);
		const [held, lifted] = [slow.slice(0, slow.lastIndexOf(`› ${again}`)), slow.slice(slow.lastIndexOf(`› ${again}`))];
		assert.ok(wakesIn(held) >= 2, `after that it is still woken: ${wakesIn(held)} times\n${held}`);
		const before = wakesIn(quick) + wakesIn(held);
		assert.ok(before <= WAKE_BURST + Math.ceil(seconds / 3) + 1, `but not more often than one every 3 s: ${before} wakes in ${seconds} s`);
		assert.equal(server.requests.filter((request) => rawText(request.messages.at(-1)).startsWith("<cartographer>")).length, before + wakesIn(lifted), "each line on the screen is a note the agent was sent");
		assert.match(held, /\n {2}woken 12 times in quick succession: the next wake is held for \d s\n/, "/wakes says that a wake is held");
		assert.ok(wakesIn(lifted) >= 2, `a word from the user lifts it: ${wakesIn(lifted)} wakes in the two seconds after\n${lifted}`);
	} finally {
		await server.close();
	}
});

test("windows: /shells shows them, /kill closes one or all, and the agent is told what the user closed", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("windows-kill", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, RUNS(), {
			timeoutMs: 60_000,
			input: lines(planMessage(RUN_ITEM), "/approve", "/shells", `task(p1): shell[window=a,wait=0]: ${LOOP("beat.txt")}\\nshell[window=b]: echo from b`, "/shells", "/kill", "/kill nope", "/kill a", "say: after", "/kill all", "/kill all", "/status"),
		});
		ok(result, "a session with /kill");
		has(result.stdout, "  No shell window is open. A change task opens one when it runs a command.\n", "/shells with none");
		assert.match(result.stdout, /\n {2}a · busy for \d s with `while :; do echo \$\(date \+%s%N\) > beat\.txt; sleep 0\.05; done`[^\n]*\n {4}\| \$ while :; do echo \$\(date \+%s%N\) > beat\.txt; sleep 0\.05; done\n {2}b · free[^\n]* · last: `echo from b` ended with exit 0, (?:just now|\d s ago)\n {4}\| from b\n {2}\/kill NAME closes a window and ends what runs in it; \/kill all closes every one\.\n/, "/shells with two");
		has(result.stdout, "  /kill NAME closes one window, /kill all every one. Open: a, b.\n", "/kill alone says how");
		has(result.stdout, '  There is no window "nope". Open: a, b.\n', "a name that is not there");
		has(result.stdout, "● closed window a, and `while :; do echo $(date +%s%N) > beat.txt; sleep 0.05; done` ended with it\n  The agent sees this the next time it works. Tell it why, if it matters.\n", "/kill NAME");
		assert.equal(await beating(join(root, "beat.txt")), false, "what ran there has ended");
		const state = windowsIn(server.requests.find((request) => rawText(request.messages.at(-1)).startsWith("say: after")));
		has(state, "\n  a · gone: the user closed it with /kill, and `while :; do echo $(date +%s%N) > beat.txt; sleep 0.05; done` ended with it. `window` close clears this line.\n", "the agent is told who closed it");
		has(result.stdout, "● closed window b\n  The agent sees this the next time it works. Tell it why, if it matters.\n  No shell window is open.\n", "/kill all, and /kill all with none left");
		has(result.stdout, "◂ window a changed 1 file (+1 −1) with no task running  (/diff shows the changes, /undo takes them back)\n  changed  beat.txt (+1 −1)\n", "what the window changed after its task is recorded when carto leaves");
		hasNot(result.stdout.slice(result.stdout.lastIndexOf("messages in view")), "shell window", "/status then counts none");
	} finally {
		await server.close();
	}
});

test("windows: a message from the user ends a wait, so that the agent reads it", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("windows-nudge", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, RUNS(), { input: lines(planMessage(RUN_ITEM), "/approve") }), "plan and authorization");
		const result = await cartoOnTerminal(root, server, RUNS(), [
			["Type a message", "task(p1): shell[window=bg,wait=0]: sleep 60"],
			["still running: window bg", "window[seconds=60]: bg wait"],
			// The main agent's wait is shown when it starts, not only when it ends.
			["window bg  wait", "say: are you there"],
			["(sent; the agent reads it", ""],
			[3, "/quit"],
		]);
		if (result === undefined) return "python3 is needed for a terminal";
		const waited = resultsOf(server, "shell", undefined, "window").at(-1);
		assert.match(waited, /^\(no new output\)\n\[the wait ended after \d\.\d s because the user wrote a message; the command is still running in window bg\]$/, `the wait ends early and says why:\n${waited}`);
		assert.match(result.screen, /▸ window bg {2}wait\n[\s\S]*\n {2}→ still running after \d\.\d s(?: · no sandbox)?\n/, "the screen shows the wait, then how it ended");
		has(result.screen, "\nare you there\n", "and the agent answers the message");
		has(result.screen, "Leaving. Window bg ends now, with what runs there.\n", "leaving says which windows end");
	} finally {
		await server.close();
	}
});

test("shell: carto killed in the middle of a command: the command ends with it and is not run a second time", async () => {
	const skip = NO_SANDBOX();
	if (skip) return skip;
	const root = makeProject("shell-kill", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: lines(planMessage(RUN_ITEM), "/approve") }), "plan and authorization");
		const command = `echo run >> runs.txt; ${LOOP("beat.txt")}`;
		const child = spawn(process.execPath, [CARTO, "--url", server.url, "--model", "stand-in", "-p", `task(p1): shell: ${command}\\nshell: cat runs.txt`], { cwd: root, stdio: "ignore" });
		const gone = new Promise((resolve) => child.on("close", resolve));
		await until(() => existsSync(join(root, "beat.txt")), "the command is running");
		child.kill("SIGKILL");
		await gone;
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(await beating(join(root, "beat.txt")), false, "the window ended with carto, and the command with it");

		const resumed = await carto(root, server, [], { input: "" });
		ok(resumed, "restart after the kill");
		has(resumed.stdout, "windows: main ended with the last session, with what ran there · the agent is told\n", "the start says which windows are gone");
		assert.equal(readFileSync(join(root, "runs.txt"), "utf8"), "run\n", "the command was not run again");
		const outputs = resultsOf(server, "shell");
		has(outputs[0], "interrupted", "the task is told that the command was interrupted");
		assert.match(outputs[1], /^run\n\[exit 0/, "and goes on with its next step, in a window opened anew");
		has(resumed.stdout, "◂ changed 2 files", "the record covers what the interrupted command did");
	} finally {
		await server.close();
	}
});

test("shell: /stop interrupts the command the agent is waiting for, and leaves the other windows running", async () => {
	const skip = NO_SANDBOX();
	if (skip) return skip;
	const root = makeProject("shell-stop", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: lines(planMessage(RUN_ITEM), "/approve") }), "plan and authorization");
		const result = await cartoOnTerminal(root, server, [], [
			["Type a message", `task(p1): shell[window=bg,wait=0]: ${LOOP("bg.txt")}\\nshell: echo hi; ${LOOP("beat.txt")}\\nshell: echo second > second.txt`],
			// The wait texts are matched against the raw screen, where colour codes sit between the bar and the command.
			["$ echo hi", ""],
			// Long enough for the command to be well under way.
			[1, "/stop"],
			["task stopped", "/shells"],
			[1.5, "/kill bg"],
			["closed window bg", "/quit"],
		]);
		if (result === undefined) return "python3 is needed for a terminal";
		has(result.screen, "│   → stopped\n", "the screen says the command was stopped");
		has(result.screen, "◂ task stopped · it may have changed files already: /diff shows them, /undo takes them back", "and the task with it");
		has(result.screen, "  still running: window bg · /shells shows them, /kill NAME ends one, /kill all every one\n", "and which windows are still at work");
		assert.match(result.screen, /\n {2}bg · busy for \d s with `while :; do echo \$\(date \+%s%N\) > bg\.txt; sleep 0\.05; done`\n/, "/shells shows the one that runs on");
		assert.match(result.screen, /\n {2}main · free · last: `echo hi; while :; do echo \$\(date \+%s%N\) > beat\.txt; sleep 0\.05; done` ended with exit 130, /, "and the one whose command was interrupted, still open");
		has(result.screen, "● closed window bg, and `while :; do echo $(date +%s%N) > bg.txt; sleep 0.05; done` ended with it\n", "/kill ends the other");
		// A loop that is ended between emptying its file and writing to it leaves the file empty: then the time the file was last written is the beat.
		const beat = (name) => Number(readFileSync(join(root, name), "utf8")) || statSync(join(root, name)).mtimeMs * 1e6;
		const [stopped, killed] = [beat("beat.txt"), beat("bg.txt")];
		assert.ok(killed - stopped > 1e9, `the other window ran on for more than a second after /stop: ${Math.round((killed - stopped) / 1e6)} ms`);
		assert.equal(await beating(join(root, "bg.txt")), false, "after /kill it is gone");
		assert.ok(!existsSync(join(root, "second.txt")), "the task did not go on to its next command");
	} finally {
		await server.close();
	}
});

/** A PATH with git and what a shell window needs, and nothing else: no bwrap. */
async function pathWithoutBwrap(name) {
	const bin = join(scratch, name);
	mkdirSync(bin);
	for (const tool of ["git", "sh", "bash", "sleep", "date", "cat", "script", "stty"]) {
		const where = (await run("sh", ["-c", `command -v ${tool}`])).stdout.trim();
		if (where !== "") symlinkSync(where, join(bin, tool));
	}
	return bin;
}

test("shell: without bubblewrap no command is run, and the agent is told so; --no-bwrap runs commands there", async () => {
	const root = makeProject("no-sandbox", { git: false });
	const bin = await pathWithoutBwrap("bin-without-bwrap");
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { env: { PATH: bin }, input: lines(planMessage(RUN_ITEM), "/approve", "task(p1): shell: echo ran > ran.txt\\nwrite: note.txt <<< written", "/bwrap on", "/bwrap") });
		ok(result, "a session without a sandbox");
		has(result.stdout, "no sandbox: bubblewrap (the bwrap command) is not installed · tasks cannot run commands (carto --no-bwrap, or /bwrap off, runs them without one)", "the header says so, and what the user can do");
		has(result.stdout, "→ refused: Commands cannot be run in this session: bubblewrap (the bwrap command) is not installed, and the user has not", "the command is refused");
		assert.ok(!existsSync(join(root, "ran.txt")), "and not run");
		assert.ok(existsSync(join(root, "note.txt")), "writing still works");
		const told = stateOf(server.requests[0]);
		has(told, "\n\nCommands\nNo command can be run in this session: bubblewrap (the bwrap command) is not installed. `shell` is refused. After a change, tell the user how to run or try what was written, and say plainly that it has not been run.", "the state block says that nothing can be run");
		const brief = server.requests.flatMap((request) => request.messages.map(messageText)).find((text) => text.startsWith("You are now the task"));
		has(brief, "besides `read`, `search` and `list`, `write` and `edit` work for you, inside the project directory.", "the brief names the tools that work");
		has(brief, "`shell` is refused in this session, so nothing can be run: say in your report how to run what you wrote.", "and says what to do instead");
		assert.equal((result.stdout.match(/no sandbox: bubblewrap \(the bwrap command\) is not installed/g) ?? []).length, 3, "/bwrap on cannot switch on what is not there, and /bwrap says the same");

		// The same machine, with the sandbox switched off at launch: commands run.
		if (NO_WINDOWS()) return NO_WINDOWS();
		const direct = await carto(root, server, ["--no-bwrap"], { env: { PATH: bin }, input: lines("/undo", "/approve", "task(p1): shell: echo ran > ran.txt; cat ran.txt") });
		ok(direct, "a session with --no-bwrap");
		has(direct.stdout, "sandbox: OFF · tasks run commands directly on this machine, as you: they reach whatever you can, and the network\n", "the header");
		assert.equal(readFileSync(join(root, "ran.txt"), "utf8"), "ran\n", "the command ran");
		assert.match(resultsOf(server, "shell").at(-1), /^ran\n\[exit 0 · \d+\.\d s · window main\]$/, "and the task got its output, and nothing the terminal echoed");
	} finally {
		await server.close();
	}
});

test("bwrap: with the sandbox off a command reaches beyond the project; the agent, the task and the screen are told", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("direct", { git: false });
	const outside = join(scratch, "direct-outside.txt");
	const server = await startStandIn();
	try {
		const result = await carto(root, server, ["--no-bwrap"], {
			env: { CARTO_TEST_SECRET: "TOKEN-456" },
			timeoutMs: 60_000,
			input: lines(
				planMessage(RUN_ITEM),
				"/approve",
				`task(p1): shell: echo beyond > ${outside}; echo inside > inside.txt; echo "secret=$CARTO_TEST_SECRET"\\nshell[wait=1]: echo before; sleep 30\\nwindow: main stop\\nshell: (exit 3)\\nwrite: ../direct-written.txt <<< no`,
				"/status",
				"/bwrap",
			),
		});
		ok(result, "a session with the sandbox off");
		has(result.stdout, "sandbox: OFF · tasks run commands directly on this machine", "the header says that the sandbox is off");
		has(result.stdout, "● plan  authorized by you: 1 change item may run · the sandbox is OFF: their commands run directly on this machine\n", "so does the authorization");
		assert.equal(readFileSync(outside, "utf8"), "beyond\n", "a command wrote outside the project");
		const outputs = resultsOf(server, "shell", undefined, "run");
		assert.match(outputs[0], /^secret=TOKEN-456\n\[exit 0 · /, "it runs with the user's own environment");
		assert.match(outputs[1], /^before\n\[still running after 1\.0 s in window main: /, "a command that takes longer keeps running here too");
		assert.match(outputs[2], /^\(no output\)\n\[exit 3 · \d+\.\d s · window main\]$/, "a failure, and no missing network is named");
		has(result.stdout, "│   → exit 0 · 0.0 s · no sandbox · secret=TOKEN-456\n", "the screen marks each command that ran without the sandbox");
		has(result.stdout, "→ refused: ../direct-written.txt is outside the project", "write and edit stay inside the project");
		assert.ok(!existsSync(join(scratch, "direct-written.txt")), "nothing was written there");

		const brief = server.requests.flatMap((request) => request.messages.map(messageText)).find((text) => text.startsWith("You are now the task"));
		has(brief, "`write`, `edit` and `shell` work for you. Change only what the brief asks for.", "the brief no longer says: inside the project directory");
		has(brief, "The user has switched the sandbox off: your commands run directly on this machine, as the user, with the network. They can change and delete files anywhere the user can, and what a command does outside the project directory is not recorded and cannot be undone. `write` and `edit` still reach the project directory only. Work inside the project directory unless the brief names a path outside it.", "and says what that means");
		has(stateOf(server.requests[0]), "\n\nCommands\nThe user has switched the sandbox off. A change task's commands now run directly on this machine, as the user:", "the main agent is told in the state block");
		has(windowsIn(server.requests.at(-1)), "\n  main · free · no sandbox · last: `(exit 3)` ended with exit 3, ", "and each window there is marked");
		hasNot(server.requests[0].messages[0].content, "switched the sandbox off", "and not in the system prompt, which stays the same");
		const back = messageText(server.requests.at(-1).messages.at(-1));
		has(back, "Cartographer's record of the files changed during this task:\n  new      inside.txt (+1)\nThe sandbox was off for this task. The record covers the project directory only: what a command changed outside it is not listed here and cannot be undone.", "the record says what it does not cover");
		has(result.stdout, "idle\n  sandbox: OFF · ", "/status says it");
		has(result.stdout, "  /bwrap on puts the commands back into the sandbox.\n", "/bwrap says how to go back");

		// The undo takes back what is in the project, and nothing else.
		const undone = await carto(root, server, [], { input: lines("/undo") });
		assert.ok(!existsSync(join(root, "inside.txt")) && existsSync(outside), "an undo reaches the project only");
		hasNot(undone.stdout, "sandbox: OFF", "the next start is not switched off");
	} finally {
		await server.close();
	}
});

test("bwrap: /bwrap off and /bwrap on switch while the session runs, and the system prompt stays the same", async () => {
	const skip = NO_SANDBOX();
	if (skip) return skip;
	const root = makeProject("switch", { git: false });
	const outside = join(scratch, "switch-outside.txt");
	const server = await startStandIn();
	try {
		const attempt = `shell: echo x >> ${outside}`;
		const result = await carto(root, server, [], {
			input: lines(planMessage(RUN_ITEM, RUN_ITEM, RUN_ITEM), "/approve", "/bwrap", `task(p1): ${attempt}`, "/bwrap off", "/bwrap off", `task(p2): ${attempt}`, "/bwrap on", "/bwrap on", `task(p3): ${attempt}`, "/bwrap sideways"),
		});
		ok(result, "a session with the switch");
		has(result.stdout, "  sandbox: bubblewrap ", "/bwrap shows how commands run");
		has(result.stdout, "  /bwrap off lets the commands run directly on this machine, outside the project too.\n", "and how to change it");
		has(
			result.stdout,
			"! sandbox OFF. The commands of change tasks now run directly on this machine, as you.\n  They can read, change and delete whatever you can, anywhere, and they reach the network.\n  /undo covers the project folder only. A plan still needs /approve before anything runs.\n  The plan is authorized: its 2 open change items will run without the sandbox.\n  This holds until /bwrap on, or until you leave: the next start is sandboxed again.\n",
			"switching off says what it means",
		);
		has(result.stdout, "  The sandbox is already off.\n", "twice is said");
		has(result.stdout, "● sandbox: bubblewrap ", "switching on");
		has(result.stdout, "  The sandbox is already on.\n", "twice is said");
		has(result.stdout, "  /bwrap shows how commands run; /bwrap off and /bwrap on switch.\n", "anything else is explained");
		// A window keeps the way it was opened, so each switch closes the windows: the same name is a new window after it.
		assert.equal((result.stdout.match(/● closed window main: a window keeps the way it was opened\n/g) ?? []).length, 2, "each switch closes the open window");
		assert.equal(readFileSync(outside, "utf8"), "x\n", "only the command run while the sandbox was off wrote outside the project");
		// (In the sandbox the same command writes into a /tmp of its own, which is gone when the window closes.)
		assert.deepEqual(
			result.stdout.split("\n").filter((text) => text.startsWith("│   → ")).map((text) => text.includes("· no sandbox")),
			[false, true, false],
			"the screen marks the one command that ran without the sandbox",
		);

		const states = server.requests.map(stateOf).filter((block) => block !== undefined);
		assert.ok(!states[0].includes("\nCommands\n"), "in the sandbox the state block says nothing about commands");
		assert.ok(states.some((block) => block.includes("\nCommands\nThe user has switched the sandbox off.")), "off: the state block says so");
		assert.ok(server.requests.map(windowsIn).some((block) => block?.includes("\n  main · gone: the user switched the sandbox off, which closes every window. `window` close clears this line.\n")), "and why the window is gone");
		assert.ok(!states.at(-1).includes("\nCommands\n"), "on again: it is gone");
		assert.equal(new Set(server.requests.map((request) => request.messages[0].content)).size, 1, "the system prompt is the same in every request");
		assert.equal(new Set(server.requests.map((request) => JSON.stringify(request.tools))).size, 1, "and so are the tools");
	} finally {
		await server.close();
	}
});

test("bwrap: with the sandbox off, a window still ends with /kill and /stop, and with carto when carto is killed", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("direct-kill", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: lines(planMessage(RUN_ITEM, RUN_ITEM), "/approve") }), "plan and authorization");

		// What a command leaves running in the background ends when its window is closed, as it does in the sandbox.
		const windows = windowsOf(root, join(root, ".atlas"), { mode: "direct" });
		try {
			const left = await windows.run("side", `(${LOOP("left.txt")}) & sleep 0.3; echo started`, { waitMs: 20_000 });
			assert.deepEqual([left.exit, left.text, left.sandbox, left.network], [0, "started", false, true], "a command that leaves a process behind returns");
			assert.equal(await beating(join(root, "left.txt")), true, "and the process runs on");
			windows.close("side");
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(await beating(join(root, "left.txt")), false, "until the window is closed");
		} finally {
			windows.shutdown();
		}

		// Killed: a watcher process ends the window within about a second.
		const child = spawn(process.execPath, [CARTO, "--no-bwrap", "--url", server.url, "--model", "stand-in", "-p", `task(p1): shell: echo run >> runs.txt; ${LOOP("beat.txt")}`], { cwd: root, stdio: "ignore" });
		const gone = new Promise((resolve) => child.on("close", resolve));
		await until(() => existsSync(join(root, "beat.txt")), "the command is running");
		assert.equal(await beating(join(root, "beat.txt")), true, "it runs");
		child.kill("SIGKILL");
		await gone;
		await new Promise((resolve) => setTimeout(resolve, 2500));
		assert.equal(await beating(join(root, "beat.txt")), false, "the command ended after carto was killed");

		const resumed = await carto(root, server, [], { input: "" });
		ok(resumed, "restart after the kill");
		assert.equal(readFileSync(join(root, "runs.txt"), "utf8"), "run\n", "the command was not run again");
		assert.ok(
			server.requests.map(windowsIn).some((block) => block?.includes(`\n  main · gone: it ended when Cartographer last exited, and \`${`echo run >> runs.txt; ${LOOP("beat.txt")}`.slice(0, 80)}…\` ended with it. \`window\` close clears this line.\n`)),
			"the agent is told that the window is gone, and what was running in it",
		);

		// Stopped by the user.
		const result = await cartoOnTerminal(root, server, ["--no-bwrap"], [
			["Type a message", `task(p2): shell: echo hi; ${LOOP("beat2.txt")}`],
			["$ echo hi", ""],
			[1, "/bwrap on"],
			["/stop first", "/stop"],
			["task stopped", "/quit"],
		]);
		if (result === undefined) return "python3 is needed for a terminal";
		has(result.screen, "[no sandbox] › ", "the prompt says that the sandbox is off");
		has(result.screen, "  The agent is working. /stop first, then /bwrap.\n", "the switch waits until the agent has stopped");
		has(result.screen, "│   → stopped\n", "the screen says the command was stopped");
		assert.equal(await beating(join(root, "beat2.txt")), false, "the command's processes are gone");
	} finally {
		await server.close();
	}
});

test("plan: the network mark belongs to change items, and giving it withdraws the authorization", () => {
	const plan = { version: 1, next: 1, items: [] };
	const now = "2026-01-01T00:00:00.000Z";
	assert.throws(() => applyPlanOp(plan, { action: "add", mode: "look", text: "Look", network: true }, now), /`network` goes with a change item: only a change task runs commands\./, "a look item cannot have it");
	assert.equal(applyPlanOp(plan, { action: "add", mode: "change", text: "Install", network: true }, now).shown, "+ p1 [change, network] Install", "a change item shows it");
	applyPlanOp(plan, { action: "add", mode: "change", text: "Build" }, now);
	applyPlanOp(plan, { action: "add", mode: "look", text: "Read" }, now);
	authorize(plan, now);
	assert.equal(applyPlanOp(plan, { action: "edit", id: "p1", network: false }, now).withdrawn, false, "taking the network away asks for less");
	assert.ok(plan.authorized !== undefined && plan.items[0].network === undefined, "the authorization stands and the mark is gone");
	assert.equal(applyPlanOp(plan, { action: "edit", id: "p2", network: true }, now).withdrawn, true, "giving it asks for more");
	assert.equal(plan.authorized, undefined, "the authorization is withdrawn");
	assert.throws(() => applyPlanOp(plan, { action: "edit", id: "p3", network: true }, now), /`network` goes with a change item/, "a look item cannot be given it");
	applyPlanOp(plan, { action: "edit", id: "p2", mode: "look" }, now);
	assert.equal(plan.items[1].network, undefined, "an item turned into a look item loses it");
	has(renderPlan(plan), "p1 [change] Install", "the plan as text");

	// By hand: the mark counts on a change item only, and only as true.
	const root = makeProject("plan-network", { git: false });
	const { brainDir } = setUpBrain(root);
	writeFileSync(join(brainDir, "carto-plan.json"), JSON.stringify({ items: [{ id: "p1", mode: "look", text: "a", network: true }, { id: "p2", mode: "change", text: "b", network: "yes" }, { id: "p3", mode: "change", text: "c", network: true }] }));
	assert.deepEqual(loadPlan(brainDir).plan.items.map((item) => item.network), [undefined, undefined, true], "a plan file edited by hand");
});

// ─── Looking: only inside the project ───────────────────────────────────────

test("look: paths outside the project are refused, also through a symlink; the brain is not listed", async () => {
	const root = makeProject("confine");
	await git(root, "init", "-q");
	writeFileSync(join(scratch, "outside.txt"), "OUTSIDE-SECRET body-9431\n");
	symlinkSync(join(scratch, "outside.txt"), join(root, "link.txt"));
	symlinkSync(scratch, join(root, "linkdir"));
	const server = await startStandIn();
	try {
		const result = await carto(root, server, ["-p", "task: read: ../outside.txt, /etc/passwd, link.txt, linkdir/outside.txt\\nlist: ..\\nsearch: OUTSIDE-SECRET\\nsearch: x in ../\\nlist:"]);
		ok(result, "confinement run");
		const everything = JSON.stringify(server.requests);
		hasNot(everything, "body-9431", "the outside file's text never reached the model");
		hasNot(everything, "root:x:0", "/etc/passwd never reached the model");
		const results = server.requests.at(-2).messages.filter((message) => message.role === "tool").map(messageText);
		const read = results.find((text) => text.includes("== ../outside.txt"));
		has(read, "== ../outside.txt\nRefused: ../outside.txt is outside the project", "a relative path out");
		has(read, "== /etc/passwd\nRefused: /etc/passwd is outside the project", "an absolute path out");
		has(read, "== link.txt\nRefused: link.txt leads outside the project (a symlink)", "a symlinked file");
		has(read, "Refused: linkdir/outside.txt leads outside the project (a symlink)", "a file under a symlinked folder");
		assert.ok(results.some((text) => text.startsWith("Refused: .. is outside the project")), `list .. is refused: ${JSON.stringify(results)}`);
		assert.ok(results.some((text) => text.startsWith("No match for /OUTSIDE-SECRET/")), "search does not follow the symlinks out");
		assert.ok(results.some((text) => text.startsWith("Refused: ../ is outside the project")), "search in ../ is refused");
		const listing = results.at(-1);
		has(listing, "README.md", "the listing shows project files");
		hasNot(listing, ".atlas", "the brain folder is not part of the project listing");
		hasNot(listing, "session.sqlite", "nor is the session");
		hasNot(listing, "ignored.log", "files git ignores are not listed");
	} finally {
		await server.close();
	}
});

test("look: read gives line numbers, ranges, and says how to continue", () => {
	const root = makeProject("read-unit", { git: false });
	const whole = readOne(root, "src/math.js");
	assert.equal(whole, "== src/math.js (lines 1-4 of 4)\n1  export function add(a, b) {\n2    // MARKER-ONLY-IN-FILE\n3    return a + b;\n4  }");
	const start = readOne(root, "long.txt");
	has(start, "== long.txt (lines 1-300 of 700)", "the default is 300 lines");
	has(start, "(400 more lines; continue with offset 301)", "it says how to go on");
	const middle = readOne(root, "long.txt", 698, 50);
	assert.equal(middle, "== long.txt (lines 698-700 of 700)\n698  line 698\n699  line 699\n700  line 700");
	has(readOne(root, "long.txt", 900), "The file has 700 lines; line 900 does not exist.", "past the end");
	has(readOne(root, "src"), "This is a directory. Use `list`", "a directory");
	has(readOne(root, "nope.js"), "Not found. Use `list` or `search`", "a missing file");
	writeFileSync(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3]));
	has(readOne(root, "blob.bin"), "A binary file (4 B)", "a binary file");
	writeFileSync(join(root, "wide.txt"), `${"x".repeat(1000)}\n`);
	has(readOne(root, "wide.txt"), "…[line cut, 1000 characters]", "a very long line is cut and says so");
});

test("look: search and list", () => {
	const root = makeProject("search-unit", { git: false });
	const found = searchProject(root, { pattern: "add" });
	has(found, "3 matches in 2 files of the project.", "count");
	has(found, "src/math.js:1: export function add(a, b) {", "path:line: text");
	has(searchProject(root, { pattern: "ADD", ignore_case: true, glob: "main.*" }), "2 matches in 1 file of the project (files matching main.*).", "glob and case");
	has(searchProject(root, { pattern: "add", path: "src/deep" }), "No match for /add/ in src/deep (1 file searched).", "path scope");
	has(searchProject(root, { pattern: "add(" }), "is not a valid regular expression", "a broken pattern is searched as text");
	has(searchProject(root, { pattern: "add(" }), "2 matches in 2 files", "and still finds it");
	has(searchProject(root, { pattern: "line", max: 5 }), "700 matches in 1 file of the project; the first 5 are shown", "the cut is stated");
	assert.throws(() => searchProject(root, { pattern: "x", path: "../.." }), LookError, "search outside the project throws");

	const tree = listProject(root, {});
	has(tree, "project: 5 files", "count");
	has(tree, "src/\n  deep/  (1 file deeper)\n  main.js", "folders first by name, deeper files counted");
	has(listProject(root, { path: "src", depth: 3 }), "deep/\n  er/\n    leaf.txt  5 B", "depth");
	has(listProject(root, { path: "README.md" }), "is a file. Use `read`", "a file");
	assert.throws(() => confine(root, "/"), LookError, "the root of the disk is outside");
	assert.equal(confine(root, "./src/../src/math.js").rel, "src/math.js", "a path that stays inside is normalized");
});

test("terminal: one line per tool call", () => {
	assert.equal(describeCall({ name: "read", arguments: { paths: ["a.js", "b.js"], offset: 40, limit: 20 } }), "read a.js, b.js (from line 40, 20 lines)");
	assert.equal(describeCall({ name: "search", arguments: { pattern: "foo", path: "src", glob: "*.ts" } }), "search /foo/ in src (*.ts)");
	assert.equal(describeCall({ name: "list", arguments: {} }), "list .");
	assert.equal(describeCall({ name: "task", arguments: { brief: "Find\nthe  thing" } }), "task  Find the thing");
	assert.equal(describeCall({ name: "task", arguments: { brief: "Write it", item: "p2" } }), "task p2  Write it");
	assert.equal(describeCall({ name: "write", arguments: { path: "src/a.py", content: "x\n" } }), "write src/a.py");
	assert.equal(describeCall({ name: "edit", arguments: { path: "src/a.py", old_text: "a", new_text: "b" } }), "edit src/a.py");
	assert.equal(describeCall({ name: "book", arguments: { book: "plan", ops: [{ action: "add", mode: "change" }, { action: "done", id: "p2" }, { action: "clear" }] } }), "plan add change · done p2 · clear");
	assert.equal(describeCall({ name: "shell", arguments: { command: "python -m pytest\n  -q", window: "tests" } }), "$ python -m pytest -q  (window tests)");
	assert.equal(describeCall({ name: "shell", arguments: { command: "ls", window: "main" } }), "$ ls");
	assert.equal(describeCall({ name: "shell", arguments: { window: "server", action: "wait", until: "ready" } }), 'window server  wait  until "ready"');
	assert.equal(describeCall({ name: "shell", arguments: { window: "repl", action: "send", text: "yes" } }), 'window repl  send  "yes"');
	assert.equal(describeCall({ name: "shell", arguments: { window: "server", action: "close" } }), "window server  close");
	const shellResult = (details, text = "x", isError = false) => describeResult({ role: "toolResult", toolName: "shell", isError, details, content: [{ type: "text", text }] });
	assert.equal(shellResult({ exit: 0, seconds: 0.4, last: "3 passed" }), "exit 0 · 0.4 s · 3 passed");
	assert.equal(shellResult({ exit: 1, seconds: 12.3, last: "" }, "x", true), "exit 1 · 12 s");
	assert.equal(shellResult({ running: true, seconds: 30, last: "still going" }), "still running after 30 s · still going");
	assert.equal(shellResult({ running: true, asks: true, seconds: 1.6, last: "name?" }), "may be waiting for input after 1.6 s · name?");
	assert.equal(shellResult({ closed: true, exit: 3, seconds: 0.1, last: "" }, "x", true), "exit 3 · the window closed");
	assert.equal(shellResult({ exit: 0, seconds: 0.2, sandbox: false, last: "ok" }), "exit 0 · 0.2 s · no sandbox · ok");
	assert.equal(describeResult({ role: "toolResult", toolName: "shell", details: { window: "server", action: "read", running: true, seconds: 0, lines: 12, last: "tick" }, content: [{ type: "text", text: "x" }] }), "12 lines · still running · tick");
	assert.equal(describeResult({ role: "toolResult", toolName: "shell", details: { window: "server", action: "close", closed: true }, content: [{ type: "text", text: "Window server is closed." }] }), "closed");
	assert.equal(shellResult(undefined, "<harness>\n[error] Tool shell was aborted\n</harness>", true), "stopped");
	assert.equal(shellResult(undefined, "<harness>\n[error] Tool shell was interrupted by a restart and may have partially run\n</harness>", true), "cut off by a restart, and not run again");
	assert.equal(shellResult(undefined, "Refused: `command` is empty: give the command line to run.", true), "refused: `command` is empty: give the command line to run.");
	assert.equal(describeCall({ name: "book", arguments: { book: "ledger", ops: [{ action: "add", kind: "goal" }, { action: "done", id: "q2" }] } }), "ledger add goal · done q2");
});

// ─── The atlas, the assessment, and time ───────────────────────────────────

const atlasMessage = (...ops) => `atlas: ${JSON.stringify(ops)}`;
const readAtlas = (root) => JSON.parse(readFileSync(join(root, ".atlas", "carto-atlas.json"), "utf8"));
/** The first message of a request after the system prompt: where the copy of the assessment and the graph stands. */
const firstMessage = (request) => rawText(request.messages[1]);
/** Whether a request is a task's, not the main agent's. */
const isTask = (request) => request.messages.some((message) => messageText(message).startsWith("You are now the task"));

test("time: stamps, durations and ages are written one way", () => {
	const at = new Date(2026, 10, 10, 14, 5).getTime();
	assert.equal(stamp(at), "Tue 10 Nov 2026, 14:05");
	assert.match(stamp(new Date(2026, 0, 1, 0, 0).getTime()), new RegExp(`^${STAMP}$`), "the pattern matches what is written");
	assert.deepEqual([0, 42_000, 120_000, 130_000, 3_900_000, 266_400_000].map(took), ["0 s", "42 s", "2 m", "2 m 10 s", "1 h 5 m", "3 d 2 h"]);
	assert.deepEqual([30_000, 300_000, 3 * 3_600_000, 47 * 3_600_000, 50 * 3_600_000].map(ago), ["just now", "5 m ago", "3 h ago", "47 h ago", "2 d ago"]);
});

test("tree: levels, folders with counts, the anchor, the marks of nodes, and a drawing that is made smaller to fit", () => {
	const files = ["README.md", "a/b/c/d/deep.txt", "a/b/one.js", "a/two.js", "z.txt"];
	assert.deepEqual(drawTree(files, { depth: 3 }).lines, ["a/", "  b/", "    c/  (1 file)", "    one.js", "  two.js", "README.md", "z.txt"], "three levels; a folder below them is one line");
	assert.deepEqual(drawTree(files, { depth: 1 }).lines, ["a/  (3 files)", "README.md", "z.txt"], "one level");
	assert.deepEqual(drawTree(files, { anchor: "a/b", depth: 2 }).lines, ["c/", "  d/  (1 file)", "one.js"], "from an anchor");
	const marks = new Map([["a", ["top"]], ["a/two.js", ["w", "x", "y", "z"]]]);
	const marked = drawTree(files, { depth: 2, marks }).lines;
	assert.ok(marked.includes("a/  [top]") && marked.includes("  two.js  [w, x, y, +1]"), `nodes are named on what they link to: ${marked.join(" | ")}`);
	const many = Array.from({ length: 100 }, (_, index) => `many/f${String(index).padStart(3, "0")}.txt`);
	const small = drawTree([...many, "other/x.txt"], { depth: 3, maxLines: 20 });
	assert.ok(small.lines.length <= 20, `at most 20 lines, got ${small.lines.length}`);
	assert.ok(small.lines.includes("  … 88 more files") && small.cap === 12, `fewer entries of a folder before fewer levels: ${small.lines.join(" | ")}`);
	assert.equal(small.depth, 3, "the levels stay when fewer entries are enough");
	assert.ok(drawTree([...many, "other/x.txt"], { depth: 3, maxLines: 4 }).lines.length <= 4, "and it never exceeds the limit");

	const root = makeProject("tree-unit", { git: false });
	mkdirSync(join(root, ".atlas"));
	writeFileSync(join(root, ".atlas", "note.txt"), "brain\n");
	const whole = treeSection(root).text;
	has(whole, "From the project root, 3 levels deep: 5 files in all.\nsrc/\n  deep/\n    er/  (1 file)\n  main.js\n  math.js\nREADME.md\nlong.txt", "the whole project");
	hasNot(whole, ".atlas", "the brain is not part of the project");
	has(treeSection(root, { anchor: "src/", depth: 1 }).text, 'From src/ (the anchor you set), 1 level deep: 3 of the project\'s 5 files are under it. `atlas` with a tree operation and anchor "." returns to the project root.\nsrc/\n  deep/  (1 file)\n  main.js\n  math.js', "anchored");
	const lost = treeSection(root, { anchor: "gone" });
	has(lost.text, "The anchor was gone, which is no longer a folder with files in it.", "a folder that is gone is said");
	has(lost.text, "From the project root", "and the tree falls back to the root");
	has(treeSection(root, {}, { depth: 1 }).text, "From the project root, 1 level deep", "the default depth comes from the settings");
});

test("atlas: operations on nodes, what a file link checks, limits and what a file must hold", () => {
	const root = makeProject("atlas-unit", { git: false });
	const atlas = { version: 1, view: { anchor: "." }, nodes: [] };
	const who = { root, now: new Date().toISOString(), by: "task", main: false, files: () => projectFiles(root) };
	const apply = (op, as = who) => applyAtlasOp(atlas, op, as);
	const refused = (op, pattern, what, as = who) => assert.throws(() => apply(op, as), (error) => error instanceof AtlasError && pattern.test(error.message), what);

	// Writing and rewriting.
	const made = apply({ action: "add", name: "Math Helpers", gist: "adds", kind: "component", files: ["src/math.js"], links: ["Entry Point", "math helpers"] });
	assert.equal(made.line, "math_helpers written. It links to entry_point, which is not a node yet.");
	assert.equal(made.shown, "+ component math_helpers  adds  [src/math.js]  → entry_point");
	assert.deepEqual(atlas.nodes[0].links, ["entry_point"], "a link to itself is dropped");
	assert.match(atlas.nodes[0].seen["src/math.js"], /^f:[0-9a-f]{12}$/, "the file's fingerprint is kept");
	assert.equal(apply({ action: "edit", name: "MATH-helpers", gist: "adds two numbers", detail: "Pure.", files: ["./src/main.js"] }).line.split(".")[0], "math_helpers rewritten", "any spelling of the name finds the node");
	assert.deepEqual([atlas.nodes.length, atlas.nodes[0].gist, atlas.nodes[0].kind, atlas.nodes[0].files], [1, "adds two numbers", "component", ["src/math.js", "src/main.js"]], "the gist is replaced, files are added, the kind stays");
	apply({ action: "add", name: "plain", gist: "a node with no file and no link" });
	assert.deepEqual([atlas.nodes[1].files, atlas.nodes[1].links, atlas.nodes[1].kind], [[], [], undefined], "a node needs no file, no link and no kind");

	refused({ action: "add", name: "x" }, /`gist` .* is required/, "no gist");
	refused({ action: "add", name: "x", gist: "g".repeat(GIST_MAX + 1) }, /the limit is 200/, "a gist that is too long");
	refused({ action: "add", name: "x", gist: "g", detail: "d".repeat(DETAIL_MAX + 1) }, /the limit is 2000/, "detail that is too long");
	refused({ action: "add", name: "x", gist: "g", kind: "hypothesis" }, /it is one of component, finding, dead_end, or left out/, "an unknown kind");
	refused({ action: "add", name: "x", gist: "g", files: ["src/nope.js"] }, /there is no file or folder src\/nope.js in the project/, "a file that is not there");
	refused({ action: "add", name: "x", gist: "g", files: ["../elsewhere.txt"] }, /outside the project/, "a file outside the project");
	refused({ action: "add", name: "!!!", gist: "g" }, /`name` is required/, "no usable name");
	refused({ action: "fuse", name: "x" }, /the actions are add, edit, link, unlink, confirm, remove, look, tree/, "an unknown action");
	assert.equal(atlas.nodes.length, 2, "a refused operation leaves nothing behind");

	// What a file link checks.
	assert.deepEqual(staleNodes(root, atlas), [], "nothing is out of date at first");
	writeFileSync(join(root, "src", "math.js"), "export const add = (a, b) => b + a; // changed\n");
	const stale = staleNodes(root, atlas);
	assert.deepEqual(stale.map((node) => node.name), ["math_helpers"], "a changed file marks its node");
	assert.match(stale[0].why[0], /^src\/math\.js changed just now$/);
	has(apply({ action: "look", name: "math helpers" }).line, "src/math.js  (changed just now, after this node was written: the node may be out of date)", "look says which file changed");
	assert.equal(apply({ action: "confirm", names: ["math_helpers", "nobody"] }).line, "math_helpers confirmed. There is no node nobody.");
	assert.deepEqual(staleNodes(root, atlas), [], "confirming clears the mark");
	rmSync(join(root, "src", "main.js"));
	assert.deepEqual(staleNodes(root, atlas)[0].why, ["src/main.js is gone"], "a file that is gone marks its node");
	has(apply({ action: "confirm", names: ["math_helpers"] }).line, "but src/main.js is gone: unlink it, or link what replaced it.", "confirming does not hide that");
	assert.equal(apply({ action: "unlink", name: "math_helpers", files: ["src/main.js"] }).line, "math_helpers no longer links to src/main.js.");
	assert.deepEqual([staleNodes(root, atlas), Object.keys(atlas.nodes[0].seen)], [[], ["src/math.js"]], "unlinking it clears the mark, and its fingerprint goes");
	writeFileSync(join(root, "src", "math.js"), "export const add = (a, b) => a + b; // changed once more\n");
	apply({ action: "edit", name: "math_helpers", gist: "adds, the other way round" });
	assert.deepEqual(staleNodes(root, atlas), [], "rewriting a node says it is true of the files as they are now");
	apply({ action: "add", name: "sources", gist: "all the code", files: ["src"] });
	writeFileSync(join(root, "src", "added.js"), "export {};\n");
	assert.deepEqual(staleNodes(root, atlas).map((node) => node.name), ["sources"], "a folder link notices a file that is added to the folder");
	apply({ action: "confirm", names: ["sources"] });

	// Links between nodes, looking, removing.
	assert.equal(apply({ action: "link", name: "plain", links: ["math_helpers", "later"], files: ["README.md"] }).line, "plain linked to math_helpers, later, README.md. later is not a node yet.");
	refused({ action: "link", name: "plain" }, /needs `links` \(node names\), `files` \(paths\), or both/, "a link without anything to link");
	refused({ action: "unlink", name: "plain", links: ["sources"] }, /plain has none of these links/, "unlinking what is not linked");
	const looked = apply({ action: "look", name: "math_helpers" }).line;
	has(looked, "math_helpers (component) · written just now by a task\nadds, the other way round\nDetail:\nPure.\nFiles:\n  src/math.js  (unchanged since this node was written)\nLinks to:\n  entry_point  (no node of this name yet)\nLinked from:\n  plain  a node with no file and no link", "one node in full");
	assert.equal(apply({ action: "look", name: "src/math.js" }).line, "Nodes that link to src/math.js, or to a folder above it:\n  math_helpers  adds, the other way round  [src/math.js]  → entry_point  (+detail)\n  sources  all the code  [src]", "a path shows the nodes about it");
	assert.equal(apply({ action: "look", name: "long.txt" }).line, "No node links to long.txt.");
	refused({ action: "look", name: "nobody" }, /There is no node nobody\. Nodes: math_helpers, plain, sources\./, "a node that does not exist names the ones that do");
	assert.equal(apply({ action: "remove", name: "math_helpers" }).line, "math_helpers removed. 1 link to it went with it.");
	assert.deepEqual(atlas.nodes.find((node) => node.name === "plain").links, ["later"], "links to a removed node are dropped");

	// The tree's anchor and depth belong to the main agent.
	const main = { ...who, by: "main", main: true };
	refused({ action: "tree", anchor: "src" }, /belong to the main agent's view/, "a task cannot move the tree");
	assert.equal(apply({ action: "tree", anchor: "src/", depth: 2 }, main).line, "The tree is now drawn from src/, 2 levels deep: see the state block below.");
	assert.deepEqual(atlas.view, { anchor: "src", depth: 2 });
	refused({ action: "tree", anchor: "README.md" }, /README.md is not a folder of the project with files in it/, "a file is not an anchor", main);
	refused({ action: "tree", anchor: "../.." }, /outside the project/, "nor is a folder outside the project", main);
	refused({ action: "tree", depth: 9 }, /whole number from 1 to 6/, "the depth has a limit", main);
	refused({ action: "tree" }, /needs `anchor`/, "a tree operation says what to change", main);
	assert.equal(apply({ action: "tree", anchor: "." }, main).line, "The tree is now drawn from the project root, 2 levels deep: see the state block below.", "back to the root, the depth stays");

	// The outline, and what changed between two moments.
	assert.equal(renderOutline(atlas), "Other nodes:\n  plain  a node with no file and no link  [README.md]  → later\n  sources  all the code  [src]", "nodes without a kind");
	apply({ action: "add", name: "tried_cache", gist: "A cache was tried and made it slower", kind: "dead_end" });
	apply({ action: "add", name: "roller", gist: "rolls", kind: "component" });
	const outline = renderOutline(atlas);
	has(outline, "Components:\n  roller  rolls\n", "grouped by kind");
	has(outline, "Dead ends (tried and ruled out):\n  tried_cache", "dead ends have their own heading");
	assert.ok(outline.indexOf("Components:") < outline.indexOf("Other nodes:"), "a node without a kind comes after");
	apply({ action: "remove", name: "roller" });
	has(renderOutline(atlas, 120), "By name only, to keep this short (`atlas` look shows one): ", "an outline that is too long lists the oldest nodes by name");
	const before = nodeHashes(atlas);
	apply({ action: "edit", name: "plain", gist: "reworded" });
	apply({ action: "remove", name: "sources" });
	apply({ action: "add", name: "fresh", gist: "new" });
	assert.deepEqual(nodeChanges(before, nodeHashes(atlas)), { written: ["plain", "fresh"], removed: ["sources"] });
	const full = { version: 1, view: { anchor: "." }, nodes: [] };
	for (let index = 0; index < NODES_MAX; index++) applyAtlasOp(full, { action: "add", name: `n${index}`, gist: "g" }, who);
	assert.throws(() => applyAtlasOp(full, { action: "add", name: "one_more", gist: "g" }, who), /200 nodes, which is its limit/, "the graph has a size limit");

	// The file.
	const dir = join(scratch, "atlas-file");
	mkdirSync(dir, { recursive: true });
	assert.deepEqual(loadAtlas(dir).atlas, { version: 1, view: { anchor: "." }, nodes: [] }, "no file is an empty atlas");
	saveAtlas(dir, atlas);
	assert.deepEqual(loadAtlas(dir).atlas.nodes.map((node) => node.name), atlas.nodes.map((node) => node.name), "what is saved is read back");
	const path = join(dir, "carto-atlas.json");
	const broken = (content, pattern, what) => {
		writeFileSync(path, content);
		const { atlas: read, error } = loadAtlas(dir);
		assert.ok(read === undefined && pattern.test(error), `${what}: ${error}`);
		assert.equal(readFileSync(path, "utf8"), content, "a file that cannot be read is left as it is");
	};
	broken("{ not json", /is not valid JSON/, "not JSON");
	broken('{"nodes": {}}', /must hold an object with a "nodes" list/, "no list");
	broken('{"nodes": [{"name": "a", "gist": "x"}, {"name": "A", "gist": "y"}]}', /node 2: the name a is used twice/, "a name used twice");
	broken('{"nodes": [{"name": "a"}]}', /node 1 \(a\): "gist" is missing/, "no gist");
	broken('{"nodes": [{"name": "a", "gist": "x", "kind": "idea"}]}', /"kind" must be one of component, finding, dead_end, or left out/, "an unknown kind");
	writeFileSync(path, '{"nodes": [{"name": "By Hand", "gist": "x", "files": ["./src/"], "mine": true}]}');
	const byHand = loadAtlas(dir).atlas.nodes[0];
	assert.deepEqual([byHand.name, byHand.files, byHand.links, byHand.mine], ["by_hand", ["src"], [], true], "an entry written by hand is tidied, and fields the program does not know are kept");
});

test("atlas: a node linked to a file that is not there creates it once the plan is authorized, and says so", async () => {
	const root = makeProject("atlas-create", { git: false });
	const server = await startStandIn();
	try {
		const node = (name, files) => `atlas: ${JSON.stringify([{ action: "add", name, gist: "planned", files }])}`;
		const result = await carto(root, server, [], { input: lines(node("early", ["src/planned.js"]), planMessage(WRITE_ITEM), "/approve", node("roller", ["src/roll/dice.js", "docs/"]), node("escape", ["../out.js"]), node("brain", [".atlas/x.json"])) });
		ok(result, "a session that maps planned files");
		const results = resultsOf(server, "atlas");
		has(results[0], "there is no file or folder src/planned.js in the project. Check the path against the tree. If the file is planned, write the node without it for now, since a node needs no file: once the user has authorized the plan, linking a missing file creates it, empty.", "before the user has authorized changes nothing is created");
		assert.ok(!existsSync(join(root, "src", "planned.js")), "and the project is as it was");
		has(results[1], "roller written.\nCreated, because they did not exist: src/roll/dice.js, docs/ (empty). Whoever fills them writes over them. If a path was a slip, tell the user.", "once authorized, the file is made and the agent is told");
		assert.equal(readFileSync(join(root, "src", "roll", "dice.js"), "utf8"), "", "an empty file, with its folders");
		assert.ok(statSync(join(root, "docs")).isDirectory(), "a path that ends with a slash is a folder");
		has(result.stdout, "● atlas  created src/roll/dice.js, docs/, empty: a node was linked to them and they did not exist\n", "the user is told on the screen");
		has(results[2], "outside the project", "a path outside the project is refused as ever");
		has(results[3], "and none can be made there", "and so is one in the brain folder");
		assert.deepEqual(loadAtlas(join(root, ".atlas")).atlas.nodes.map((entry) => [entry.name, entry.files]), [["roller", ["src/roll/dice.js", "docs"]]], "the node links to what was made");
	} finally {
		await server.close();
	}
});

test("atlas: a call that is run again after a crash is not applied twice", async () => {
	const root = makeProject("atlas-rerun", { git: false });
	const dir = join(root, ".atlas");
	mkdirSync(dir, { recursive: true });
	const tool = atlasTool({ root, brainDir: dir });
	const api = { taskId: "task-1", now: () => Date.now(), conversationId: "a-task" };
	const ops = [{ action: "add", name: "once", gist: "written once" }, { action: "look", name: "once" }];
	const first = await tool.execute({ ops }, api);
	has(first.output[0].text, "once written.\nonce (node) · written just now by a task\nwritten once", "the first run");
	const again = await tool.execute({ ops }, api);
	has(again.output[0].text, "Op 1 (add once) was already applied, before a restart.\nonce (node)", "the rerun says so, and still answers what only reads");
	assert.equal(loadAtlas(dir).atlas.nodes.length, 1, "and writes nothing twice");
	const batch = await tool.execute({ ops: [{ action: "add", name: "first", gist: "x", links: ["second", "third"] }, { action: "add", name: "second", gist: "y" }] }, { ...api, taskId: "task-1b" });
	assert.equal(batch.output[0].text, "first written. It links to third, which is not a node yet.\nsecond written.", "a node written later in the same call is not reported as missing");
	const none = await tool.execute({ ops: [] }, api);
	assert.ok(none.isError && none.output[0].text.includes("`ops` is empty"), "no operations is an error");
	const bad = await tool.execute({ ops: [{ action: "remove", name: "nobody" }] }, { ...api, taskId: "task-2" });
	assert.ok(bad.isError && bad.output[0].text.includes("Op 1 (remove nobody) not applied: There is no node nobody."), "a call of which nothing could be applied is an error");
});

test("top: the copy is written at its moments and not otherwise, and goes in front of the first message", () => {
	const dir = join(scratch, "top-unit");
	mkdirSync(dir, { recursive: true });
	const at = new Date(2026, 10, 10, 14, 5).getTime();
	assert.deepEqual(pin(dir, { now: at, reason: "the first start" }), { changed: true });
	const text = loadTop(dir).text;
	assert.equal(
		text,
		"<project>\nWritten by Cartographer from your own records of this project, as they stood on Tue 10 Nov 2026, 14:05 (the first start). What was written since is listed in the state block at the end of the request.\n\nYour assessment\nNone written yet.\n\nYour graph (0 nodes)\nThe graph has no nodes yet.\n</project>",
	);
	const file = readFileSync(topPath(dir), "utf8");
	assert.deepEqual(pin(dir, { now: at + 60_000, reason: "goal g1 was closed" }), { changed: false }, "nothing changed, nothing is written");
	assert.equal(readFileSync(topPath(dir), "utf8"), file, "so the copy stays byte for byte, date included");

	saveAssessment(dir, "A demo.\n");
	const atlas = { version: 1, view: { anchor: "." }, nodes: [] };
	applyAtlasOp(atlas, { action: "add", name: "one", gist: "the first node" }, { root: dir, now: new Date(at).toISOString(), by: "main", main: true });
	saveAtlas(dir, atlas);
	assert.deepEqual(sinceTop(dir, atlas, "A demo."), { written: ["one"], removed: [], assessment: true, at: new Date(at).toISOString() }, "what was written since the copy");
	assert.deepEqual(pin(dir, { now: at + 120_000, reason: "goal g1 was closed" }), { changed: true });
	has(loadTop(dir).text, "as they stood on Tue 10 Nov 2026, 14:07 (goal g1 was closed).", "when and why");
	has(loadTop(dir).text, "Your assessment\nA demo.\n\nYour graph (1 node)\nOther nodes:\n  one  the first node\n</project>", "the assessment and the outline");
	assert.deepEqual(sinceTop(dir, atlas, "A demo."), { written: [], removed: [], assessment: false, at: new Date(at + 120_000).toISOString() }, "nothing is newer than a fresh copy");
	writeFileSync(join(dir, "carto-atlas.json"), "{ not json");
	const kept = readFileSync(topPath(dir), "utf8");
	assert.ok(pin(dir, { reason: "the user asked for it" }).error.includes("is not valid JSON"), "a graph that cannot be read is not copied");
	assert.equal(readFileSync(topPath(dir), "utf8"), kept, "and the last good copy stays");

	const messages = [{ role: "system", content: "S" }, { role: "user", content: "hello" }, { role: "assistant", content: [] }];
	assert.deepEqual(withTop(messages, "<project>P</project>")[1], { role: "user", content: "<project>P</project>\n\nhello" }, "in front of the first message after the system prompt");
	assert.deepEqual(messages[1], { role: "user", content: "hello" }, "the input is not changed");
	assert.deepEqual(withTop([{ role: "user", content: [{ type: "text", text: "hi" }] }], "B")[0].content, [{ type: "text", text: "B\n\nhi" }], "joined to the first piece of text");
	assert.equal(withTop(messages, undefined), messages, "no copy, nothing added");
	assert.equal(withoutTop(`${text}\n\nhello`), "hello", "and it comes off again");
});

test("time: each of the user's messages and each task report says when it came, the same way every time", () => {
	const at = new Date(2026, 10, 10, 14, 5).getTime();
	const messages = [
		{ role: "user", content: "hello", timestamp: at },
		{ role: "assistant", content: [], timestamp: at + 1 },
		{ role: "toolResult", toolName: "task", content: [{ type: "text", text: "REPORT" }], timestamp: at + 130_000, durationMs: 130_000 },
		{ role: "toolResult", toolName: "task", content: [{ type: "text", text: "You are now the task" }], timestamp: at },
		{ role: "toolResult", toolName: "ledger", content: [{ type: "text", text: "g1 added." }], timestamp: at, durationMs: 5 },
	];
	const timed = withTimes(messages);
	assert.equal(timed[0].content, "hello\n\n[sent Tue 10 Nov 2026, 14:05]");
	assert.equal(timed[2].content[0].text, "REPORT\n\n[task ended Tue 10 Nov 2026, 14:07, after 2 m 10 s]");
	assert.deepEqual([timed[1], timed[3], timed[4]], [messages[1], messages[3], messages[4]], "an answer, a brief and other tools' results are left alone");
	assert.deepEqual(withTimes(messages), timed, "the same words every time");
	assert.equal(messages[0].content, "hello", "the input is not changed");
	assert.equal(withoutAdditions(timed[0].content), "hello");
	assert.equal(withoutAdditions(timed[2].content[0].text), "REPORT");
	assert.equal(withoutAdditions("the user wrote [sent it] themselves"), "the user wrote [sent it] themselves", "only what Cartographer adds comes off");
});

test("state: the time, the age of what is old, the tree, and what the atlas holds that the top of the context does not", () => {
	const root = makeProject("state-atlas", { git: false });
	const dir = join(root, ".atlas");
	mkdirSync(dir, { recursive: true });
	const now = new Date(2026, 10, 10, 14, 5).getTime();
	const hour = 3_600_000;
	const block = (messages) => stateBlock(dir, undefined, { root, now, messages });

	// Time.
	has(block([{ role: "user", content: "x", timestamp: now - 3 * hour }]), "Now: Tue 10 Nov 2026, 14:05. The user's newest message came 3 h ago.\n", "how long ago the user wrote");
	const steered = [{ role: "user", content: "a", timestamp: now - 2 * hour }, { role: "assistant", content: [] }, { role: "toolResult", content: [] }, { role: "user", content: "b", timestamp: now - 5 * 60_000 }];
	has(block(steered), "The user's newest message came 5 m ago. You have been working since their message of 2 h ago.", "a message that came during the work does not hide when the work began");
	saveLedger(dir, { version: 1, next: 3, items: [{ id: "g1", kind: "goal", text: "Old goal", doneWhen: "x", status: "open", added: new Date(now - 3 * hour).toISOString() }, { id: "n2", kind: "note", text: "New note", status: "open", added: new Date(now - 600_000).toISOString() }] });
	has(block(), "  g1  Old goal (done when: x) · added 3 h ago\n", "an entry that is an hour old says its age");
	has(block(), "  n2  New note\n", "a newer one does not");

	// The tree and the atlas.
	pin(dir, { now, reason: "the first start" });
	has(block(), "\n\nTree\nFrom the project root, 3 levels deep: 5 files in all.\nsrc/\n", "the tree");
	has(block(), "\n\nAtlas\nGraph: no nodes yet. Assessment: none yet. Write one with `book`'s books once you know what the project is and how it is built.\n\nLedger\n", "an empty atlas");
	const atlas = loadAtlas(dir).atlas;
	applyAtlasOp(atlas, { action: "add", name: "adder", gist: "adds", files: ["src/math.js"] }, { root, now: new Date(now).toISOString(), by: "task", main: false });
	saveAtlas(dir, atlas);
	has(block(), "  math.js  [adder]\n", "a node is named on the file it links to");
	has(block(), "Graph: 1 node. Files a node links to: 1 of 5.", "how much of the project the graph touches");
	has(block(), "Nodes written since the copy at the top of your context: adder (`atlas` look shows one).", "what is newer than the copy");
	hasNot(block(), "May be out of date", "nothing is out of date yet");
	writeFileSync(join(root, "src", "math.js"), "export const add = (a, b) => b + a; // changed\n");
	assert.match(block(), /May be out of date: adder \(src\/math\.js changed [^)]+\)\. Have a task check each against its files, then rewrite the node, or confirm it when it still holds\./);

	// The assessment: the agent's own rewrite is in its context already; an edit by hand is not.
	saveAssessment(dir, "By hand.");
	has(block(), "The assessment was edited outside this conversation since that copy, probably by the user. It now reads:\nBy hand.\n", "an edit by hand is shown in full");
	noteAssessed(dir, "By hand.");
	has(block(), "You rewrote the assessment since that copy: your `book` call holds the text that counts.", "the agent's own rewrite is only mentioned");
	hasNot(block(), "It now reads", "and not repeated");
	pin(dir, { now, reason: "goal g1 was closed" });
	hasNot(block(), "since that copy", "after a new copy nothing is newer");
	hasNot(block(), "Nodes written since", "nor any node");

	// What the agent may do when nothing is asked of it.
	const idle = "You need not sit idle meanwhile: in the same reply you may start a look task that maps a part of the project the graph says nothing about";
	hasNot(block(), idle, "with a goal to work on, mapping is not suggested");
	savePlan(dir, { version: 1, next: 2, items: [{ id: "p1", mode: "change", text: "Write it", status: "open" }] });
	has(block(), `Do not start p1 before that. ${idle}`, "while a plan waits for the user");
	rmSync(join(dir, "carto-plan.json"));
	saveLedger(dir, { version: 1, next: 1, items: [] });
	has(block(), `record it as a goal with a done-when line. ${idle}`, "and while there is no goal");
});

test("atlas: a task records what it learned; the main agent gets the record, and the node is there in the next session", async () => {
	const root = makeProject("atlas-task", { git: false });
	const server = await startStandIn();
	try {
		const note = { action: "add", name: "Math Helpers", gist: "add(a, b), used by main.js", kind: "component", files: ["src/math.js"], links: ["entry"] };
		const first = await carto(root, server, ["-p", `task: read: src/math.js\\n${atlasMessage(note, { action: "add", name: "ghost", gist: "no such file", files: ["src/nope.js"] })}`]);
		ok(first, "a task that writes a node");
		has(first.stdout, "│ atlas add Math Helpers · add ghost", "the call on the screen");
		has(first.stdout, "→ + component math_helpers add(a, b), used by main.js [src/math.js] → entry\n", "with what was written");
		has(first.stdout, "◂ atlas  wrote math_helpers  (/atlas shows the graph)", "the record on the screen");

		// A task starts with the tree, in front of its brief.
		const brief = messageText(server.requests.find(isTask).messages.at(-1));
		has(brief, "The project's files as they are now:\nFrom the project root, 3 levels deep: 5 files in all.\nsrc/\n  deep/\n    er/  (1 file)\n  main.js\n  math.js\nREADME.md\nlong.txt\n\nBrief:\nread: src/math.js", "the tree in the brief");
		has(brief, "`atlas` works for you too: before you return, record what you learned that will still matter later as nodes", "a look task is asked to record what it learns");
		const told = server.requests.filter(isTask).map((request) => messageText(request.messages.at(-1)));
		assert.ok(told.some((text) => text.includes("math_helpers written. It links to entry, which is not a node yet.\nOp 2 (add ghost) not applied: `files`: there is no file or folder src/nope.js in the project.")), `the task is told what was applied and what was not: ${JSON.stringify(told.at(-1))}`);

		// The main agent learns of it from the record, and sees it in the tree.
		const last = server.requests.at(-1);
		has(messageText(last.messages.at(-1)), "\n\nCartographer's record of the atlas:\nNodes this task wrote: math_helpers.", "the record follows the report");
		const state = stateOf(last);
		has(state, "src/\n  deep/\n    er/  (1 file)\n  main.js\n  math.js  [math_helpers]\n", "the node is named in the tree");
		has(state, "Graph: 1 node. Files a node links to: 1 of 5. Assessment: none yet.", "the count");
		has(state, "Nodes written since the copy at the top of your context: math_helpers", "and it is listed as newer than the copy at the top");
		has(firstMessage(last), "Your graph (0 nodes)\nThe graph has no nodes yet.\n</project>", "the copy at the top is not touched by a write");
		const node = readAtlas(root).nodes[0];
		assert.deepEqual([node.name, node.kind, node.gist, node.files, node.links, node.by], ["math_helpers", "component", "add(a, b), used by main.js", ["src/math.js"], ["entry"], "task"], "the node in the file");

		const second = await carto(root, server, [], { input: lines("/atlas", "say: hello") });
		ok(second, "the next session");
		has(second.stdout, "atlas: 1 node · no assessment yet · /atlas and /assessment show them", "the start says what the atlas holds");
		has(second.stdout, "Graph: 1 node\nComponents:\n  math_helpers  add(a, b), used by main.js  [src/math.js]  → entry\n", "/atlas shows the nodes");
		has(second.stdout, "Tree\nFrom the project root, 3 levels deep: 5 files in all.", "and the tree");
		has(second.stdout, join(root, ".atlas", "carto-atlas.json"), "and where the file is");
		has(stateOf(server.requests.at(-1)), "math.js  [math_helpers]", "the agent still sees the node");
	} finally {
		await server.close();
	}
});

test("atlas: the main agent moves the tree into a folder, back, and sets its depth; a task cannot", async () => {
	const root = makeProject("atlas-tree", { git: false });
	const server = await startStandIn();
	try {
		const moved = await carto(root, server, ["-p", atlasMessage({ action: "tree", anchor: "src", depth: 1 })]);
		ok(moved, "moving the anchor");
		has(moved.stdout, "● atlas  tree from src/, depth 1", "on the screen");
		const after = server.requests.at(-1);
		has(messageText(after.messages.at(-1)), "The tree is now drawn from src/, 1 level deep: see the state block below.", "the result points to the state block");
		has(stateOf(after), "Tree\nFrom src/ (the anchor you set), 1 level deep: 3 of the project's 5 files are under it. `atlas` with a tree operation and anchor \".\" returns to the project root.\nsrc/\n  deep/  (1 file)\n  main.js\n  math.js\n", "which shows the folder in the same request");

		ok(await carto(root, server, ["-p", "say: hello"]), "the next session");
		has(stateOf(server.requests.at(-1)), "From src/ (the anchor you set), 1 level deep", "the tree stays where the agent put it");

		ok(await carto(root, server, ["-p", atlasMessage({ action: "tree", anchor: "src/math.js" }, { action: "tree", anchor: "../elsewhere" }, { action: "tree", depth: 9 })]), "anchors that cannot be");
		const refused = messageText(server.requests.at(-1).messages.at(-1));
		has(refused, "Op 1 (tree) not applied: `anchor`: src/math.js is not a folder of the project with files in it.", "a file");
		has(refused, "Op 2 (tree) not applied: `anchor`: ../elsewhere is outside the project", "a folder outside the project");
		has(refused, "Op 3 (tree) not applied: `depth` is a whole number from 1 to 6.", "a depth beyond the limit");

		ok(await carto(root, server, ["-p", `task: ${atlasMessage({ action: "tree", anchor: "." })}`]), "a task tries");
		const told = server.requests.filter(isTask).map((request) => messageText(request.messages.at(-1)));
		assert.ok(told.some((text) => text.includes("The tree's anchor and depth belong to the main agent's view. In a task, `list` shows any folder.")), `the task is told: ${JSON.stringify(told.at(-1))}`);
		assert.deepEqual(readAtlas(root).view, { anchor: "src", depth: 1 }, "and the view is as the main agent left it");

		ok(await carto(root, server, ["-p", atlasMessage({ action: "tree", anchor: ".", depth: 3 })]), "back to the root");
		has(stateOf(server.requests.at(-1)), "Tree\nFrom the project root, 3 levels deep: 5 files in all.\nsrc/\n  deep/\n    er/  (1 file)\n", "the whole project again");

		// The depth nobody asked for comes from the settings.
		const other = makeProject("atlas-depth", { git: false });
		mkdirSync(join(other, ".atlas"));
		writeFileSync(join(other, ".atlas", "config.json"), JSON.stringify({ treeDepth: 1 }));
		ok(await carto(other, server, ["-p", "say: hello"]), "a project with its own depth");
		has(stateOf(server.requests.at(-1)), "Tree\nFrom the project root, 1 level deep: 5 files in all.\nsrc/  (3 files)\nREADME.md\nlong.txt\n", "one level");
		writeFileSync(join(other, ".atlas", "config.json"), JSON.stringify({ treeDepth: 9 }));
		const tooDeep = await carto(other, server, ["-p", "say: hello"]);
		assert.notEqual(tooDeep.code, 0, "a depth beyond the limit is a settings error");
		has(tooDeep.stderr, "config: treeDepth must be a whole number from 1 to 6", "which says the limit");
	} finally {
		await server.close();
	}
});

test("atlas: a node whose file a change task changed is reported as possibly out of date, until it is confirmed", async () => {
	const root = makeProject("atlas-stale", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], {
			input: lines(
				atlasMessage({ action: "add", name: "adder", gist: "add(a, b) returns a + b", files: ["src/math.js"] }),
				planMessage(WRITE_ITEM),
				"/approve",
				"task(p1): edit: src/math.js <<< return a + b; >>> return b + a;",
			),
		});
		ok(result, "a change task on a file with a node");
		has(result.stdout, "● atlas  + node adder add(a, b) returns a + b [src/math.js]", "the main agent's own node on the screen");
		assert.equal(readAtlas(root).nodes[0].by, "main", "written by the main agent");
		has(result.stdout, "◂ atlas  may now be out of date: adder", "the screen says which node the task left behind");
		const last = server.requests.at(-1);
		assert.match(messageText(last.messages.at(-1)), /Cartographer's record of the files changed during this task:\n[^\n]*src\/math\.js[^\n]*\n\nCartographer's record of the atlas:\nNodes that may be out of date after this task: adder \(src\/math\.js changed just now\)\.\n\nThis report is kept as t\d+\.$/, "the record under the report names it");
		has(stateOf(last), "May be out of date: adder (src/math.js changed just now). Have a task check each against its files", "and so does the state block");
		const brief = messageText(server.requests.find(isTask).messages.at(-1));
		has(brief, "When a node of the atlas describes something you changed, rewrite the node with `atlas` so that it stays true.", "a change task is told to keep nodes true");

		const confirmed = await carto(root, server, ["-p", atlasMessage({ action: "confirm", names: ["adder"] })]);
		ok(confirmed, "confirming");
		has(confirmed.stdout, "● atlas  ✓ confirmed adder", "on the screen");
		hasNot(stateOf(server.requests.at(-1)), "May be out of date", "the mark is gone");
	} finally {
		await server.close();
	}
});

test("assessment: the main agent writes it and a task cannot; it reaches the top of the context when a goal closes, not before", async () => {
	const root = makeProject("assessment", { git: false });
	const server = await startStandIn();
	const file = join(root, ".atlas", "assessment.md");
	try {
		const first = await carto(root, server, [], { input: lines("say: hello", "assess: A demo project.\\nTwo files, no build step.", ledgerMessage(GOAL), "say: before") });
		ok(first, "writing the assessment");
		assert.equal(readFileSync(file, "utf8"), "A demo project.\nTwo files, no build step.\n", "the file");
		has(first.stdout, "● assessment written, 41 characters  (/assessment shows it)", "on the screen");
		const before = server.requests.at(-1);
		has(firstMessage(before), "Your assessment\nNone written yet.\n", "the copy at the top is not replaced by the write");
		has(stateOf(before), "You rewrote the assessment since that copy: your `book` call holds the text that counts.", "the state block says the copy is behind");
		hasNot(stateOf(before), "Two files, no build step.", "without repeating the text");
		// What makes the write cheap: the start of the conversation is the same in every request.
		assert.equal(new Set(server.requests.map((request) => withoutState(firstMessage(request)))).size, 1, "the first message is the same in every request");
		assert.equal(new Set(server.requests.map((request) => request.messages[0].content)).size, 1, "and so is the system prompt");

		const closed = await carto(root, server, [], { input: lines(ledgerMessage({ action: "done", id: "g1" }), "say: after") });
		ok(closed, "closing the goal");
		has(closed.stdout, "● top of the context rewritten: the assessment and the graph as they are now", "the screen says the top was rewritten");
		const closing = server.requests.find((request) => messageText(request.messages.at(-1)).startsWith("g1 closed."));
		has(messageText(closing.messages.at(-1)), "The copy of your assessment and graph at the top of your context was rewritten to what they are now.", "the agent is told");
		assert.match(firstMessage(closing), /as they stood on [^(]+\(goal g1 was closed\)\.[^\n]*\n\nYour assessment\nA demo project\.\nTwo files, no build step\.\n/, "and the very next request has the new copy");
		const after = server.requests.at(-1);
		assert.equal(withoutState(firstMessage(after)), withoutState(firstMessage(closing)), "which then stays as it is");
		hasNot(stateOf(after), "since that copy", "nothing is newer than it");

		ok(await carto(root, server, ["-p", "task: assess: Mine now.\\nlist:"]), "a task tries");
		const told = server.requests.filter(isTask).map((request) => messageText(request.messages.at(-1)));
		assert.ok(told.some((text) => text.includes("The assessment belongs to the main agent. If it should change, say so in your report.")), `the task is told: ${JSON.stringify(told.slice(-2))}`);
		ok(await carto(root, server, ["-p", `assess: ${"x".repeat(ASSESSMENT_MAX + 1)}`]), "an assessment that is too long");
		has(messageText(server.requests.at(-1).messages.at(-1)), "The assessment is 3001 characters; the limit is 3000.", "is refused with the limit");
		assert.equal(readFileSync(file, "utf8"), "A demo project.\nTwo files, no build step.\n", "and the file is as it was");

		const shown = await carto(root, server, [], { input: lines("/assessment") });
		has(shown.stdout, "A demo project.\nTwo files, no build step.\n", "/assessment shows the text");
		has(shown.stdout, "(goal g1 was closed) and is current.", "says where the copy stands");
		has(shown.stdout, file, "and where the file is");
	} finally {
		await server.close();
	}
});

test("top: /pin and /new rewrite the copy; a task's prompt begins with the same copy as the main agent's", async () => {
	const root = makeProject("pin", { git: false });
	const server = await startStandIn();
	try {
		const first = await carto(root, server, [], {
			input: lines("say: one", atlasMessage({ action: "add", name: "readme", gist: "what the project is", files: ["README.md"] }), "/assessment", "/pin", "/pin", "say: two"),
		});
		ok(first, "/pin");
		has(first.stdout, "  No assessment yet. The agent writes one when it knows the project.", "/assessment without one");
		has(first.stdout, "(the first start); the assessment or the graph changed since. It is rewritten when a goal closes, on /new, or with /pin.", "the copy is behind");
		assert.equal(first.stdout.split("● top of the context rewritten").length - 1, 1, `the first /pin rewrites it once:\n${first.stdout}`);
		has(first.stdout, "  The copy at the top of the context is already current.", "the second finds nothing to do");
		const pinned = server.requests.at(-1);
		assert.match(firstMessage(pinned), /\(the user asked for it\)\.[^\n]*\n\nYour assessment\nNone written yet\.\n\nYour graph \(1 node\)\nOther nodes:\n  readme  what the project is  \[README\.md\]\n<\/project>\n\nsay: one/, "the copy holds the node now");
		hasNot(stateOf(pinned), "Nodes written since", "and nothing is newer than it");

		ok(await carto(root, server, ["-p", "task: list:"]), "a task");
		const task = server.requests.find(isTask);
		const main = server.requests.at(-1);
		assert.equal(firstMessage(task), withoutState(firstMessage(main)), "the task's first message is the main agent's, copy included");
		assert.equal(stateCount(task), 0, "and the task gets no state block");

		const fresh = await carto(root, server, [], { input: lines("assess: Fresh.", "/new", "say: three") });
		ok(fresh, "/new");
		const last = server.requests.at(-1);
		assert.deepEqual(last.messages.map((message) => message.role), ["system", "user"], "the context is fresh");
		assert.match(firstMessage(last), /\(a fresh context\)\.[^\n]*\n\nYour assessment\nFresh\.\n\nYour graph \(1 node\)[\s\S]*<\/project>\n\nsay: three\n\n\[sent /, "and starts with the assessment and the graph as they are now");
	} finally {
		await server.close();
	}
});

test("time: the agent is told the time, when each message came and how long each task took; none of it is stored", async () => {
	const root = makeProject("time", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: lines("say: one", "task: list:", "/report", "say: three") });
		ok(result, "three messages");
		const last = server.requests.at(-1);
		const users = last.messages.filter((message) => message.role === "user").map((message) => withoutState(rawText(message)));
		assert.equal(users.length, 3);
		for (const text of users) assert.match(text, /\n\n\[sent [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}\]$/, "each of the user's messages says when it was sent");
		const report = rawText(last.messages.find((message) => message.role === "tool" && rawText(message).startsWith("REPORT")));
		assert.match(report, /\n\n\[task ended [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}, after \d+ s\]$/, "the report says when it came and how long the task took");
		assert.equal(withoutState(firstMessage(server.requests[0])), firstMessage(last), "a message carries the same words in every request");
		assert.match(stateOf(last), /\n\nNow: [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}\. The user's newest message came just now\.\n\n/, "the state block gives the time");
		hasNot(rawText(server.requests.find(isTask).messages.at(-1)), "[task ended", "a brief is not a report");
		hasNot(result.stdout, "[task ended", "the stored report has no time in it");
		hasNot(result.stdout, "[sent ", "nor has anything else on the screen");
	} finally {
		await server.close();
	}
});

test("atlas: an edit made by hand shows at the next request; a broken file is reported and never overwritten", async () => {
	const root = makeProject("atlas-hand", { git: false });
	const server = await startStandIn();
	const file = join(root, ".atlas", "carto-atlas.json");
	try {
		ok(await carto(root, server, ["-p", "say: hello"]), "a first run");
		writeFileSync(file, JSON.stringify({ nodes: [{ name: "By Hand", gist: "the user wrote this", files: ["README.md"], mine: true }] }));
		writeFileSync(join(root, ".atlas", "assessment.md"), "Written by the user.\n");
		ok(await carto(root, server, ["-p", "say: again"]), "after the edits");
		const state = stateOf(server.requests.at(-1));
		has(state, "README.md  [by_hand]", "the user's node is in the tree");
		has(state, "Nodes written since the copy at the top of your context: by_hand", "and listed as new");
		has(state, "The assessment was edited outside this conversation since that copy, probably by the user. It now reads:\nWritten by the user.\n", "the user's assessment is shown in full");

		ok(await carto(root, server, ["-p", atlasMessage({ action: "link", name: "by hand", links: ["other"] })]), "the agent adds to the user's node");
		assert.deepEqual([readAtlas(root).nodes[0].links, readAtlas(root).nodes[0].mine], [["other"], true], "what the user wrote is kept");

		writeFileSync(file, "{ not json");
		const broken = await carto(root, server, [], { input: lines(atlasMessage({ action: "add", name: "x", gist: "y" }), "/atlas") });
		ok(broken, "a broken file");
		has(broken.stdout, "! The atlas cannot be read: ", "the start says so");
		has(broken.stdout, "! The graph cannot be read: ", "and so does /atlas");
		const requests = server.requests.slice(-2);
		has(stateOf(requests[0]), "Atlas\nThe graph cannot be read: ", "the agent is told in the state block");
		has(stateOf(requests[0]), "Tree\nFrom the project root", "the tree is still drawn");
		has(messageText(requests[1].messages.at(-1)), "The atlas cannot be read: ", "and when it tries to write");
		assert.equal(readFileSync(file, "utf8"), "{ not json", "the file is left as it is");
	} finally {
		await server.close();
	}
});

test("terminal: one line per call to the atlas and the assessment", () => {
	assert.equal(
		describeCall({ name: "atlas", arguments: { ops: [{ action: "add", name: "dice" }, { action: "confirm", names: ["a", "b"] }, { action: "tree", anchor: "src" }, { action: "tree", depth: 2 }] } }),
		"atlas add dice · confirm a, b · tree src · tree depth 2",
	);
	assert.equal(describeCall({ name: "book", arguments: { book: "books", text: "x".repeat(1200) } }), "assess  1.2k characters");
	const result = (details, text) => describeResult({ role: "toolResult", toolName: "atlas", isError: false, details, content: [{ type: "text", text }] });
	assert.equal(result({ shown: ["+ node a  what a is", "✓ confirmed b"] }, "a written.\nb confirmed."), "+ node a what a is · ✓ confirmed b");
	assert.equal(result({ shown: [] }, "a (node) · written just now\nwhat a is"), "a (node) · written just now", "a call that only read shows the first line of what it got");
});

// ─── Wakes, sleep, approval switched off, standing items ────────────────────

/** Shell windows as src/wakes.mjs asks about them, for the tests that need no real shell. */
const fakeWindows = () => {
	const all = new Map();
	return {
		print: (name, ...texts) => all.set(name, [...(all.get(name) ?? []), ...texts]),
		close: (name) => all.delete(name),
		has: (name) => all.has(name),
		position: (name) => all.get(name)?.length,
		linesFrom: (name, from) => (all.get(name) ?? []).slice(from),
	};
};
/** Wake triggers on a clock the test moves; nothing fires by itself. */
function wakesAt(name, more = {}) {
	const root = makeProject(name, { git: false });
	const brainDir = join(root, ".atlas");
	mkdirSync(brainDir, { recursive: true });
	const clock = { now: Date.parse("2026-03-01T10:00:00Z") };
	const windows = fakeWindows();
	const open = () => createWakes({ root, brainDir, windows, tickMs: 3_600_000, clock: () => clock.now, ...more });
	return { root, brainDir, clock, windows, open, pass: (seconds) => (clock.now += seconds * 1000) };
}
const refusedWake = (wakes, wanted, part) => assert.throws(() => wakes.set(wanted), (error) => error instanceof WakeError && error.message.includes(part), `${JSON.stringify(wanted)} should be refused with: ${part}`);

test("wakes: a time wake fires each time its interval passes, as often as it was set for, and is then gone", () => {
	const { brainDir, open, pass } = wakesAt("wakes-time");
	const wakes = open();
	const seen = [];
	wakes.on((event) => seen.push(`${event.id} ${event.what}${event.last ? " (last)" : ""}`));
	const once = wakes.set({ note: "  look at\n the build ", every: 120 });
	assert.deepEqual([once.id, once.kind, once.times, once.note], ["w1", "time", 1, "look at the build"], "without `times` it fires once; the note is one line");
	wakes.set({ note: "check the queue", every: 300, times: 2 });
	wakes.set({ note: "is the server up", every: 60, times: 0 });
	assert.deepEqual(wakes.lines(), [
		"w1 · every 2 m, once · look at the build · not fired yet · next in 2 m",
		"w2 · every 5 m, 2 more times · check the queue · not fired yet · next in 5 m",
		"w3 · every 1 m, until removed · is the server up · not fired yet · next in 1 m",
	]);
	assert.equal(wakes.nextDue(), 60_000, "when the next one is due");
	pass(59);
	wakes.check();
	assert.deepEqual(seen, [], "nothing fires before its time");
	pass(1);
	wakes.check();
	assert.deepEqual(seen, ["w3 its time came"]);
	pass(60);
	wakes.check();
	assert.deepEqual(seen.slice(1), ["w1 its time came (last)", "w3 its time came"], "a wake set for once is over after it");
	assert.deepEqual(wakes.list().map((wake) => wake.id), ["w2", "w3"], "and is removed");
	pass(180);
	wakes.check();
	pass(300);
	wakes.check();
	assert.deepEqual(seen.slice(3), ["w2 its time came", "w3 its time came", "w2 its time came (last)", "w3 its time came"], "two times is two times; one check fires a wake once, however late it is");
	for (let i = 0; i < 200; i++) {
		pass(60);
		wakes.check();
	}
	assert.equal(seen.length, 207, "a wake set with 0 goes on firing");
	assert.deepEqual(wakes.lines(), ["w3 · every 1 m, until removed · is the server up · fired 204 times, last just now · next in 1 m"], "one line says how often and when last");
	assert.deepEqual(JSON.parse(readFileSync(wakesPath(brainDir), "utf8")).wakes.map((wake) => [wake.id, wake.fired]), [["w3", 204]], "the file holds what is set");
	assert.equal(wakes.set({ note: "later", every: 60 }).id, "w4", "ids are not reused");
	assert.deepEqual(wakes.remove("w3").map((wake) => wake.id), ["w3"]);
	assert.deepEqual(wakes.remove("all").map((wake) => wake.id), ["w4"]);
	pass(600);
	wakes.check();
	assert.equal(seen.length, 207, "a removed wake does not fire");
	assert.throws(() => wakes.remove("w3"), (error) => error instanceof WakeError && error.message === "No wake is set.");
});

test("wakes: what cannot be set", () => {
	const { open } = wakesAt("wakes-refused");
	const wakes = open();
	refusedWake(wakes, { note: " ", every: 60 }, "A wake needs a `note`");
	refusedWake(wakes, { note: "x".repeat(NOTE_MAX + 1), every: 60 }, `${NOTE_MAX} is the limit`);
	refusedWake(wakes, { note: "n" }, "Say what wakes you: `every` (seconds) for a time, `path` for a file or folder, or `window` for a shell window.");
	refusedWake(wakes, { note: "n", every: 59 }, "`every` is 59; it is a whole number of seconds from 60 to 604800. A wake costs a whole turn, so 1 m is the least.");
	refusedWake(wakes, { note: "n", every: 90.5 }, "`every` is 90.5");
	refusedWake(wakes, { note: "n", every: 8 * 24 * 3600 }, "from 60 to 604800");
	refusedWake(wakes, { note: "n", path: "a.txt", every: 10 }, "`every` is 10", "the least time between two wakes is bounded the same way");
	refusedWake(wakes, { note: "n", every: 60, times: -1 }, "`times` is -1");
	refusedWake(wakes, { note: "n", every: 60, times: 1.5 }, "`times` is 1.5");
	refusedWake(wakes, { note: "n", path: "a.txt", window: "main" }, "Give `path` or `window`, not both");
	refusedWake(wakes, { note: "n", path: "../elsewhere" }, 'is outside the project');
	refusedWake(wakes, { note: "n", path: "/etc/passwd" }, 'is outside the project');
	refusedWake(wakes, { note: "n", path: ".atlas/carto-plan.json" }, "`.atlas` is Cartographer's own folder and is not watched.");
	refusedWake(wakes, { note: "n", every: 60, match: "ERROR" }, "`match` goes with `window`");
	assert.deepEqual(wakes.list(), [], "a refused wake is not set");
	for (let i = 0; i < WAKES_MAX; i++) wakes.set({ note: `number ${i}`, every: 60 });
	refusedWake(wakes, { note: "one more", every: 60 }, `${WAKES_MAX} wakes are set, which is the limit: w1, w2, w3, w4, w5, w6, w7, w8. Remove one first.`);
	assert.throws(() => wakes.remove("w99"), (error) => error instanceof WakeError && error.message === 'There is no wake "w99". Set: w1, w2, w3, w4, w5, w6, w7, w8.');
	// The least interval is a setting.
	const quick = wakesAt("wakes-refused-quick", { config: { wakeMin: 5, wakesMax: 1 } }).open();
	assert.equal(quick.set({ note: "n", every: 5 }).every, 5);
	refusedWake(quick, { note: "n", every: 5 }, "1 wake are set, which is the limit");
});

test("wakes: a file wake fires when the file or something under the folder changes, and not more often than its interval", () => {
	const { root, open, pass } = wakesAt("wakes-file");
	const wakes = open();
	const seen = [];
	wakes.on((event) => seen.push(`${event.id} ${event.what}${event.last ? " (last)" : ""}`));
	const file = wakes.set({ note: "the report", path: "./out/report.txt", times: 0 });
	assert.deepEqual([file.kind, file.path, file.every], ["file", "out/report.txt", 60], "the path is kept from the project root; the least gap is the default");
	wakes.set({ note: "the sources", path: "src", every: 120, times: 2 });
	assert.deepEqual(wakes.lines(), [
		"w1 · when out/report.txt changes, at most every 1 m, until removed · the report · not fired yet",
		"w2 · when src changes, at most every 2 m, 2 more times · the sources · not fired yet",
	]);
	wakes.check();
	assert.deepEqual(seen, [], "nothing changed, nothing fires");
	mkdirSync(join(root, "out"));
	writeFileSync(join(root, "out", "report.txt"), "one\n");
	wakes.check();
	assert.deepEqual(seen, ["w1 out/report.txt appeared"], "a file that did not exist wakes when it appears");
	// Changes within the interval are held, and told as one when it is over.
	pass(10);
	writeFileSync(join(root, "out", "report.txt"), "one\ntwo\n");
	wakes.check();
	pass(10);
	writeFileSync(join(root, "out", "report.txt"), "one\ntwo\nthree\n");
	wakes.check();
	assert.equal(seen.length, 1, "not again within the interval");
	pass(40);
	wakes.check();
	assert.deepEqual(seen.slice(1), ["w1 out/report.txt changed"], "but when it is over");
	pass(600);
	wakes.check();
	assert.equal(seen.length, 2, "nothing new, nothing fires, however long it is");
	rmSync(join(root, "out", "report.txt"));
	wakes.check();
	assert.deepEqual(seen.slice(2), ["w1 out/report.txt is gone"]);

	// A folder: every file under it, however deep.
	writeFileSync(join(root, "src", "deep", "er", "new.js"), "x\n");
	writeFileSync(join(root, "src", "main.js"), "changed and longer\n");
	wakes.check();
	assert.deepEqual(seen.slice(3), ["w2 src/deep/er/new.js appeared, src/main.js changed"]);
	pass(120);
	for (const name of ["a", "b", "c", "d", "e"]) writeFileSync(join(root, "src", `${name}.js`), "x\n");
	wakes.check();
	assert.equal(seen.length, 5, "many changes are one wake");
	assert.match(seen[4], /^w2 src\/[a-e]\.js appeared, src\/[a-e]\.js appeared, src\/[a-e]\.js appeared, and 2 more under src \(last\)$/);
	assert.deepEqual(wakes.list().map((wake) => wake.id), ["w1"], "after its two times it is removed");
	assert.match(wakes.lines()[0], /^w1 · when out\/report\.txt changes, at most every 1 m, until removed · the report · fired 3 times, last 2 m ago: out\/report\.txt is gone$/);
});

test("wakes: a window wake fires on what a window prints, or only on a line with a given text", () => {
	const { windows, open, pass } = wakesAt("wakes-window");
	const wakes = open();
	const seen = [];
	wakes.on((event) => seen.push(`${event.id} ${event.what}`));
	windows.print("server", "listening on 8080");
	wakes.set({ note: "anything new", window: "server", times: 0 });
	wakes.set({ note: "it failed", window: "server", match: "ERROR", times: 0 });
	wakes.set({ note: "the build", window: "build", times: 0 });
	assert.deepEqual(wakes.lines(), [
		"w1 · when window server prints something, at most every 1 m, until removed · anything new · not fired yet",
		'w2 · when window server prints a line with "ERROR", at most every 1 m, until removed · it failed · not fired yet',
		"w3 · when window build prints something, at most every 1 m, until removed · the build · not fired yet · window build is not open now",
	]);
	wakes.check();
	assert.deepEqual(seen, [], "what was printed before the wake was set does not count");
	windows.print("server", "GET /", "", "GET /favicon.ico");
	wakes.check();
	assert.deepEqual(seen, ["w1 GET /favicon.ico"], "the newest line is told; a line without the text does not wake the other");
	pass(60);
	windows.print("server", "ERROR disk full", "GET /again");
	wakes.check();
	assert.deepEqual(seen.slice(1), ["w1 GET /again", "w2 ERROR disk full"], "the line with the text");
	// A window that opens later, and one that is closed and opened anew, count from their first line.
	windows.print("build", "compiling");
	wakes.check();
	assert.deepEqual(seen.slice(3), ["w3 compiling"]);
	pass(60);
	windows.close("build");
	wakes.check();
	windows.print("build", "again");
	wakes.check();
	assert.deepEqual(seen.slice(4), ["w3 again"]);
	const long = "x".repeat(500);
	pass(60);
	windows.print("build", long);
	wakes.check();
	assert.equal(seen[5], `w3 ${"x".repeat(200)}…`, "a long line is cut");
	// Closed and opened anew between two looks: it has fewer lines than before, and they are new.
	pass(60);
	windows.close("build");
	windows.print("build", "a fresh start");
	wakes.check();
	assert.deepEqual(seen.slice(6), ["w3 a fresh start"]);
});

test("wakes: they outlast a restart; what the agent was not told yet is one firing with a count", () => {
	const { open, pass } = wakesAt("wakes-restart");
	const first = open();
	first.set({ note: "every hour", every: 3600, times: 0 });
	first.set({ note: "in two hours", every: 7200 });
	pass(3600);
	first.check();
	first.shutdown();
	// Five hours without carto: each wake fires once at the next start, and the repeating one counts from there.
	pass(5 * 3600);
	const wakes = open();
	assert.deepEqual(wakes.lines(), ["w1 · every 1 h, until removed · every hour · fired once, last 5 h ago · due now", "w2 · every 2 h, once · in two hours · not fired yet · due now"]);
	wakes.check();
	wakes.check();
	const news = wakes.takeNews();
	assert.deepEqual(news.map((event) => [event.id, event.count, event.last]), [["w1", 1, false], ["w2", 1, true]], "once each");
	assert.deepEqual(wakes.lines(), ["w1 · every 1 h, until removed · every hour · fired 2 times, last just now · next in 1 h"]);
	assert.equal(wakes.hasNews(), false, "what was taken is told");

	// While the agent is not told (a long task runs), firings of one wake are folded into the newest.
	for (let i = 0; i < 4; i++) {
		pass(3600);
		wakes.check();
	}
	const folded = wakes.takeNews();
	assert.deepEqual(folded.map((event) => [event.id, event.count]), [["w1", 4]]);
	assert.equal(wakeNote(folded).split("\n")[3], "Wake w1 (every 1 h): its time came, the last of 4 times since you were told. Your note: every hour");

	// Told in the state block while the agent works: it stays there for the rest of the turn, and no turn is started for it.
	pass(3600);
	wakes.check();
	assert.deepEqual(wakes.noteShown().map((event) => event.id), ["w1"]);
	assert.equal(wakes.hasNews(), false);
	assert.deepEqual(wakes.noteShown().map((event) => event.id), ["w1"], "still shown at the next request of the turn");
	wakes.begin([]);
	assert.deepEqual(wakes.noteShown(), [], "and not in the next turn");

	// Whether the agent did something in a turn the wake started.
	wakes.begin(["w1"]);
	assert.doesNotMatch(wakes.lines()[0], /you last acted/);
	pass(120);
	wakes.acted();
	pass(600);
	assert.equal(wakes.lines()[0], "w1 · every 1 h, until removed · every hour · fired 7 times, last 12 m ago · you last acted on it 10 m ago · next in 48 m");
	wakes.begin(["w1"]);
	wakes.begin([]);
	pass(60);
	wakes.acted();
	assert.match(wakes.lines()[0], /you last acted on it 11 m ago/, "a turn the user started is not the wake's");
});

test("wakes: a quiet turn is left out of the request once the next wake has come", () => {
	const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
	const says = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
	const calls = (...names) => ({ role: "assistant", content: names.map((name, index) => ({ type: "toolCall", id: `c${index}`, name, arguments: {} })) });
	const result = (name) => ({ role: "toolResult", toolName: name, content: [{ type: "text", text: "done" }] });
	const note = (text) => user(wakeNote([{ type: "wake", id: "w1", about: "every 5 m", what: text, note: "look", count: 1 }]));
	const texts = (messages) => messages.map((message) => (message.role === "user" ? (isNote(message) ? `note ${/: (\w+)\./.exec(message.content[0].text)[1]}` : message.content[0].text) : message.role === "assistant" ? (message.content[0].type === "text" ? message.content[0].text : `calls ${message.content.map((part) => part.name).join("+")}`) : "result"));

	const start = [user("watch the server"), calls("wake"), result("wake"), says("set")];
	const quiet = [note("one"), says("nothing new")];
	const slept = [note("two"), calls("sleep"), result("sleep")];
	const acted = [note("three"), calls("task"), result("task"), says("restarted it")];
	const mixed = [note("four"), calls("sleep", "ledger"), result("sleep"), result("ledger")];
	const newest = [note("five")];
	assert.deepEqual(texts(withoutQuietWakes([...start, ...quiet, ...slept, ...acted, ...mixed, ...quiet, ...newest])), [
		"watch the server", "calls wake", "result", "set",
		"note three", "calls task", "result", "restarted it",
		"note four", "calls sleep+ledger", "result", "result",
		"note five",
	], "turns without a call, or with `sleep` alone, go; turns in which something was done stay");
	const last = [...start, ...quiet];
	assert.equal(withoutQuietWakes(last), last, "the newest turn stays, whatever it is: the agent is in it");
	assert.deepEqual(texts(withoutQuietWakes([...start, ...quiet, user("anything?"), says("no"), ...newest])), ["watch the server", "calls wake", "result", "set", "note one", "nothing new", "anything?", "no", "note five"], "a quiet turn the user answered stays");
	assert.deepEqual(texts(withoutQuietWakes([user("hello"), says("hi"), user("again"), says("yes")])), ["hello", "hi", "again", "yes"], "turns the user started are never left out");
});

test("wake: the agent sets a wake, rests, and is woken with its note; quiet turns leave the context", async () => {
	const root = makeProject("wake-time", { git: false });
	mkdirSync(join(root, ".atlas"), { recursive: true });
	writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ wakeMin: 1 }));
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { timeoutMs: 60_000, input: lines('wake: {"action":"set","note":"look at the build","every":1,"times":3}', "/status", "/wait 10", "/wakes", "say: hello") });
		ok(result, "a session with a wake");
		has(result.stdout, "● wake  + w1 every 1 s, 3 more times · look at the build\n", "the screen says what was set");
		assert.match(resultsOf(server, "wake")[0], /^w1 set: every 1 s, 3 more times\. It first fires in 1 s\. You are not waiting for it: go on with other work, or end your turn\. `wake` with remove and w1 takes it back\./, "and the agent is told that it is not waiting");
		assert.match(result.stdout, /\n {2}1 wake set, the next in \d+ s · \/wakes shows them\n/, "/status counts them");
		const fired = result.stdout.split("\n").filter((line) => line.startsWith("◆ Wake w1"));
		assert.deepEqual(fired, [
			"◆ Wake w1 (every 1 s): its time came. Your note: look at the build",
			"◆ Wake w1 (every 1 s): its time came. Your note: look at the build",
			"◆ Wake w1 (every 1 s): its time came. That was its last time, so it is removed. Your note: look at the build",
		], "the screen shows each firing");
		has(result.stdout, "\n  The agent has set no wake.\n", "after its three times it is gone");
		assert.deepEqual(JSON.parse(readFileSync(join(root, ".atlas", "carto-wakes.json"), "utf8")).wakes, []);

		const notes = server.requests.filter((request) => rawText(request.messages.at(-1)).startsWith("<cartographer>"));
		assert.equal(notes.length, 3, "the agent was woken three times");
		has(rawText(notes[0].messages.at(-1)), "<cartographer>\nWritten by Cartographer, not by the user. Nobody typed this. It tells you what happened while you were not working.\n\nWake w1 (every 1 s): its time came. Your note: look at the build\n\nDecide what this means for the goal and act on it. When nothing needs doing, call `sleep` and write nothing: a turn in which you did nothing else is forgotten when the next such note comes.\n</cartographer>", "the note");
		assert.match(stateOf(notes[0]), /\nWakes\n {2}w1 · every 1 s, 2 more times · look at the build · fired once, last just now · next in 1 s\nThese are yours: `wake` removes one\. One that fires while you rest starts a turn for you; call `sleep` when it needs nothing\.\n\n/, `the state block lists it:\n${stateOf(notes[0])}`);
		assert.match(stateOf(notes[1]), /\n {2}w1 · every 1 s, once more · look at the build · fired 2 times, last just now · next in 1 s\n/, "one line, with how often and when last");
		hasNot(stateOf(notes[2]), "\nWakes\n", "and nothing once it is gone");
		// The stand-in answers a note in words and calls nothing: a quiet turn. The next note takes its place.
		for (const [index, request] of notes.entries()) {
			assert.equal(request.messages.filter((message) => rawText(message).startsWith("<cartographer>")).length, 1, `request ${index + 1} holds one note`);
			assert.equal(request.messages.filter((message) => message.role === "assistant" && rawText(message).includes("Woken:")).length, 0, `and no answer to an earlier one`);
		}
		assert.deepEqual(stored(notes[2]).slice(0, -1), stored(notes[0]).slice(0, -1), "what stands before the note is the same each time, so the server reads only the note");
		const hello = server.requests.at(-1);
		assert.deepEqual(hello.messages.filter((message) => message.role !== "system").map((message) => messageText(message).split("\n")[0].slice(0, 40)).slice(-3), ["<cartographer>", "Note to self: Woken: Wake w1 (every 1 s)", "say: hello"], "a quiet turn that the user answers stays, marked as the note to self it was");
	} finally {
		await server.close();
	}
});

test("wake: `sleep` ends the turn at once; a wake that repeats until removed; /wakes", async () => {
	const root = makeProject("wake-sleep", { git: false });
	mkdirSync(join(root, ".atlas"), { recursive: true });
	writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ wakeMin: 1 }));
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], {
			timeoutMs: 60_000,
			input: lines("say: watching. ON EVERY WAKE: sleep", 'wake: {"action":"set","note":"is it up","every":1,"times":0}', "/wait 4", "/wakes", "/wakes remove w1", "/wakes", "/wakes remove w1", "/wakes clear", "say: still here"),
		});
		ok(result, "a session that sleeps");
		has(result.stdout, "● wake  + w1 every 1 s, until removed · is it up\n", "set until removed");
		const notes = server.requests.filter((request) => rawText(request.messages.at(-1)).startsWith("<cartographer>"));
		assert.ok(notes.length >= 3, `it goes on firing: ${notes.length} times in four seconds`);
		assert.equal(server.requests.length, 1 + 2 + notes.length + 1, "after `sleep` no further request is made: one per wake");
		assert.equal(result.stdout.split("\n").filter((line) => /^● resting · next wake in \d+ s$/.test(line)).length, notes.length, `the screen says that it rests, and until when:\n${result.stdout}`);
		for (const request of notes) assert.equal(request.messages.filter((message) => rawText(message).startsWith("<cartographer>")).length, 1, "a turn with `sleep` alone is quiet");
		assert.match(result.stdout, /\n {2}w1 · every 1 s, until removed · is it up · fired \d times, last (?:just now|\d s ago) · (?:next in \d+ s|due now)\n {2}\S+carto-wakes\.json · \/wakes remove ID takes one away\n/, "/wakes shows it, and the file");
		hasNot(result.stdout, "you last acted on it", "it never did anything about it");
		has(result.stdout, "● wake  - w1 every 1 s · removed by you\n  The agent has set no wake.\n", "the user can take it away");
		has(result.stdout, "\n  No wake is set.\n", "what is not there cannot be removed");
		has(result.stdout, "\n  /wakes lists them; /wakes remove ID takes one away, /wakes remove all every one.\n", "anything else gets the usage");
		const last = server.requests.at(-1);
		assert.deepEqual(last.messages.slice(-4).map((message) => message.role), ["user", "assistant", "tool", "user"], "the newest quiet turn stays when the user writes: its call and result are a pair");
		assert.equal(rawText(last.messages.at(-2)).split("\n")[0], "Resting.");
		hasNot(stateOf(last), "\nWakes\n", "a removed wake is gone from the state block");
	} finally {
		await server.close();
	}
});

test("wake: a turn in which the agent acted stays in view, and the wake's line says when that was", async () => {
	const root = makeProject("wake-acted", { git: false });
	mkdirSync(join(root, ".atlas"), { recursive: true });
	writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ wakeMin: 1 }));
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], {
			timeoutMs: 60_000,
			input: lines('say: ok. ON WAKE: ledger: [{"action":"add","kind":"note","text":"the server was down at the first look"}]', 'wake: {"action":"set","note":"is it up","every":1,"times":3}', "/wait 10"),
		});
		ok(result, "a session that acts on a wake");
		const notes = server.requests.filter((request) => rawText(request.messages.at(-1)).startsWith("<cartographer>"));
		assert.equal(notes.length, 3);
		has(result.stdout, "● ledger  + note n1  the server was down at the first look\n", "at the first wake it wrote a note");
		assert.match(stateOf(notes[1]), /\n {2}w1 · every 1 s, once more · is it up · fired 2 times, last just now · you last acted on it (?:just now|\d s ago) · next in 1 s\n/, `the line says when it last acted:\n${stateOf(notes[1])}`);
		assert.deepEqual(notes[2].messages.filter((message) => message.role === "user").map((message) => rawText(message).startsWith("<cartographer>")), [false, false, true, true], "the first wake's turn stays, the second (quiet) is gone");
		assert.equal(notes[2].messages.filter((message) => message.role === "tool" && rawText(message).startsWith("n1 added.")).length, 1, "with what was done in it");
	} finally {
		await server.close();
	}
});

test("wake: a file wake that fires while the agent works is told in the state block, without a turn of its own", async () => {
	const root = makeProject("wake-file");
	mkdirSync(join(root, ".atlas"), { recursive: true });
	writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ wakeMin: 1 }));
	const server = await startStandIn();
	try {
		// The test itself changes the file a second time, while the agent rests.
		const later = (async () => {
			await until(() => existsSync(join(root, "report.txt")), "the task has written the file", 30_000);
			await new Promise((resolve) => setTimeout(resolve, 2500));
			writeFileSync(join(root, "report.txt"), "one\ntwo\n");
		})();
		const result = await carto(root, server, [], {
			timeoutMs: 60_000,
			input: lines(planMessage(WRITE_ITEM), "/approve", 'wake: {"action":"set","note":"read the report","path":"report.txt","times":2}', "task(p1): write: report.txt <<< one", "/wait 12"),
		});
		await later;
		ok(result, "a session with a file wake");
		has(result.stdout, "● wake  + w1 when report.txt changes, 2 more times · read the report\n", "what was set");
		const first = "Wake w1 (when report.txt changes): report.txt appeared. Your note: read the report";
		has(result.stdout, `◆ ${first}  (the agent is working: it reads this at its next step)\n`, "the screen shows the firing, and that no turn is started for it");
		const told = server.requests.find((request) => (stateOf(request) ?? "").includes("Fired during this turn"));
		assert.ok(told, "a request says so");
		has(stateOf(told), `\nWakes\n  w1 · when report.txt changes, once more · read the report · fired once, last just now: report.txt appeared\nThese are yours: \`wake\` removes one. One that fires while you rest starts a turn for you; call \`sleep\` when it needs nothing.\nFired during this turn, while you worked:\n  ${first}\n\n`, "the state block of the request after the task's report");
		assert.equal(told.messages.at(-1).role, "tool", "which is the one that carries the report");
		const notes = server.requests.filter((request) => rawText(request.messages.at(-1)).startsWith("<cartographer>"));
		assert.equal(notes.length, 1, "only the change made while it rested started a turn");
		has(rawText(notes[0].messages.at(-1)), "\n\nWake w1 (when report.txt changes): report.txt changed. That was its last time, so it is removed. Your note: read the report\n\n", "the second firing");
		hasNot(stateOf(notes[0]), "Fired during this turn", "what was told in the turn before is not told again");
	} finally {
		await server.close();
	}
});

test("wake: a window wake ends the main agent's wait on a window, and says why", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("wake-window", { git: false });
	mkdirSync(join(root, ".atlas"), { recursive: true });
	writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ wakeMin: 1 }));
	const server = await startStandIn();
	try {
		// The first line is printed before the wake is set, so it does not count.
		const command = 'echo "ERR""OR at the start"; sleep 2.5; echo all fine; sleep 1.5; echo "ERR""OR disk full"; sleep 30';
		const started = Date.now();
		const result = await carto(root, server, RUNS(), {
			timeoutMs: 90_000,
			input: lines(planMessage(RUN_ITEM), "/approve", `task(p1): shell[window=srv,wait=0]: ${command}`, 'wake: {"action":"set","note":"the server failed","window":"srv","match":"ERROR"} || window[seconds=25]: srv wait', "/kill srv", "/wakes"),
		});
		ok(result, "a session with a window wake");
		assert.ok(Date.now() - started < 20_000, "the wait ended long before its 25 seconds");
		has(result.stdout, '● wake  + w1 when window srv prints a line with "ERROR", once · the server failed\n', "what was set");
		const waited = resultsOf(server, "shell", undefined, "window")[0];
		assert.match(waited, /\[the wait ended after \d(?:\.\d)? s because your wake w1 fired \(when window srv prints a line with "ERROR"\): ERROR disk full; the command is still running in window srv/, `the wait says what ended it:\n${waited}`);
		has(waited, "all fine\n", "a line without the text did not end it");
		const next = server.requests.find((request) => (stateOf(request) ?? "").includes("Fired during this turn"));
		has(stateOf(next ?? {}) ?? "", '\nWakes\nFired during this turn, while you worked:\n  Wake w1 (when window srv prints a line with "ERROR"): ERROR disk full. That was its last time, so it is removed. Your note: the server failed\n\n', "and the state block has the note");
		assert.equal(server.requests.filter((request) => rawText(request.messages.at(-1)).startsWith("<cartographer>") && rawText(request.messages.at(-1)).includes("Wake w1")).length, 0, "no turn of its own");
		has(result.stdout, "\n  The agent has set no wake.\n", "it was set for once");
	} finally {
		await server.close();
	}
});

test("wake: a wake that fires while a task runs is held until the task has reported; the task's own wait goes on", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("wake-task", { git: false });
	mkdirSync(join(root, ".atlas"), { recursive: true });
	writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ wakeMin: 1 }));
	const server = await startStandIn();
	try {
		const result = await carto(root, server, RUNS(), {
			timeoutMs: 90_000,
			input: lines(planMessage(RUN_ITEM), "/approve", 'wake: {"action":"set","note":"look at the queue","every":1} || task(p1): shell[window=bg,wait=0]: sleep 4; echo through\\nwindow[seconds=20]: bg wait'),
		});
		ok(result, "a session with a wake during a task");
		const waited = resultsOf(server, "shell", undefined, "window")[0];
		assert.match(waited, /^through\n\[exit 0 · \d\.\d s · window bg/, `the task waited until its command ended:\n${waited}`);
		const fired = "Wake w1 (every 1 s): its time came. That was its last time, so it is removed. Your note: look at the queue";
		has(result.stdout, `◆ ${fired}  (the agent is working: it reads this at its next step)\n`, "the screen shows the firing when it happens");
		const reported = server.requests.find((request) => request.messages.at(-1).role === "tool" && rawText(request.messages.at(-1)).startsWith("REPORT"));
		has(stateOf(reported), `\nWakes\nFired during this turn, while you worked:\n  ${fired}\n\n`, "the main agent reads it with the task's report");
		assert.equal(server.requests.filter((request) => rawText(request.messages.at(-1)).startsWith("<cartographer>")).length, 0, "and no turn is started for it");
		for (const request of server.requests.filter((entry) => entry.messages.some((message) => rawText(message).includes("This is a change task for plan item p1")))) hasNot(rawText(request.messages.at(-1)), "Fired during this turn", "the task is not told");
	} finally {
		await server.close();
	}
});

test("wake: on a terminal the agent is woken while the prompt waits, and the user can take a wake away", async () => {
	const root = makeProject("wake-terminal", { git: false });
	mkdirSync(join(root, ".atlas"), { recursive: true });
	writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ wakeMin: 1 }));
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "" }), "the brain is set up");
		const result = await cartoOnTerminal(root, server, [], [
			["Type a message", 'wake: {"action":"set","note":"look again","every":1,"times":0}'],
			["Woken: ", "/wakes remove w1"],
			["removed by you", "/wakes"],
			["has set no wake", "/quit"],
		]);
		if (result === undefined) return "python3 is needed for a terminal";
		has(result.screen, "◆ Wake w1 (every 1 s): its time came. Your note: look again\n", "the firing is shown");
		has(result.screen, "Woken: Wake w1 (every 1 s): its time came. Your note: look again\n", "and the agent answers it, with nobody typing");
		has(result.screen, "● wake  - w1 every 1 s · removed by you\n", "the user removes it");
		const after = result.screen.slice(result.screen.indexOf("removed by you"));
		hasNot(after, "◆ Wake w1", "and it does not fire again");
		assert.deepEqual(JSON.parse(readFileSync(join(root, ".atlas", "carto-wakes.json"), "utf8")).wakes, []);
	} finally {
		await server.close();
	}
});

test("wake: a task can neither set a wake nor sleep; what the tool refuses", async () => {
	const root = makeProject("wake-roles", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], {
			timeoutMs: 60_000,
			input: lines('task: wake: {"action":"set","note":"n","every":60} +++ sleep', 'wake: {"action":"set","note":"too soon","every":5}', 'wake: {"action":"remove","id":"w3"}', 'wake: {"action":"set","every":60}', 'wake: {"action":"remove"}', 'wake: {"action":"set","note":"in a minute","every":60} || wake: {"action":"set","note":"the sources","path":"src","times":0}', 'wake: {"action":"remove","id":"all"}'),
		});
		ok(result, "a session with refused wakes");
		has(resultsOf(server, "wake")[0], "Tool call blocked: Wakes belong to the main agent. If something should be watched after this task, say what in your report. To wait for a command inside this task, use `shell` with action wait.");
		has(resultsOf(server, "sleep")[0], "Tool call blocked: A task does not sleep. You are still the task. When its work is finished, call `return` with your report; until then, go on with the brief.");
		has(result.stdout, "● wake  not changed: `every` is 5; it is a whole number of seconds from 60 to 604800. A wake costs a whole turn, so 1 m is the least.\n", "the default least interval is a minute, and the screen shows a refusal");
		has(result.stdout, "● wake  not changed: No wake is set.\n", "removing what is not there");
		has(result.stdout, "● wake  not changed: A wake needs a `note`: what you want to look at or do when it fires, written for yourself.\n", "a wake without a note");
		has(result.stdout, "● wake  not changed: remove needs `id`: the wake to take back, or all. No wake is set.\n", "removing without saying which");
		// What a tool takes is an object with named properties at the top, for every tool: a choice between shapes
		// there is something chat templates and models handle badly.
		for (const tool of server.requests[0].tools) {
			const { parameters } = tool.function;
			assert.ok(parameters.type === "object" && parameters.properties !== undefined && parameters.anyOf === undefined, `${tool.function.name} takes a plain object: ${JSON.stringify(parameters).slice(0, 120)}`);
		}
		assert.deepEqual(server.requests[0].tools.find((tool) => tool.function.name === "wake").function.parameters.required, ["action"], "of `wake`, only the action can be required");
		has(result.stdout, "● wake  + w1 every 1 m, once · in a minute\n● wake  + w2 when src changes, until removed · the sources\n", "two set in one reply");
		has(result.stdout, "● wake  - w1 every 1 m · in a minute\n● wake  - w2 when src changes · the sources\n", "and all removed at once");
		assert.equal(resultsOf(server, "wake").at(-1), "Removed: w1, w2.");
	} finally {
		await server.close();
	}
});

test("plan: a standing item stays open and can be carried out again and again", async () => {
	const now = "2026-01-01T00:00:00.000Z";
	const plan = { next: 1, items: [] };
	const apply = (op, options) => applyPlanOp(plan, op, now, options);
	assert.throws(() => apply({ action: "add", mode: "look", text: "Watch", standing: true }), (error) => error instanceof PlanError && error.message === "`standing` goes with a change item: a look item needs no authorization and can be carried out as often as you like.");
	assert.equal(apply({ action: "add", mode: "change", text: "Keep the server running", standing: true }).shown, "+ p1 [change, standing] Keep the server running");
	apply({ action: "add", mode: "change", text: "Write the health check" });
	authorize(plan, now);
	assert.deepEqual(openOnce(plan).map((item) => item.id), ["p2"], "it is not work that is done once");
	assert.equal(apply({ action: "edit", id: "p2", standing: true }).withdrawn, true, "making an item standing asks for more than the user agreed to");
	authorize(plan, now);
	assert.equal(apply({ action: "edit", id: "p2", standing: false }).withdrawn, false, "ending that asks for less");
	assert.equal(plan.items[1].standing, undefined);
	assert.equal(apply({ action: "edit", id: "p1", mode: "look" }).withdrawn, false, "a look item is not standing");
	assert.equal(plan.items[0].standing, undefined);
	apply({ action: "edit", id: "p1", mode: "change", standing: true });
	authorize(plan, now);
	assert.equal(apply({ action: "done", id: "p1" }).line, "p1 done. The standing duty has ended: no further task can be started for it.");

	// With approval switched off, a change to the plan is not reported as withdrawing anything.
	const other = { next: 1, items: [] };
	applyPlanOp(other, { action: "add", mode: "change", text: "One" }, now);
	authorize(other, now);
	assert.equal(applyPlanOp(other, { action: "add", mode: "change", text: "Two" }, now, { yolo: true }).withdrawn, false);
	assert.equal(other.authorized, undefined, "but the authorization is gone all the same: it covered the plan as it stood");
	assert.equal(renderPlan(other, { yolo: true }).split("\n")[0], "The user has switched approval off: change items may run without /approve.");
	assert.equal(renderPlan(other).split("\n")[0], "Not approved: change items wait for the user. Look items may run.");

	const root = makeProject("standing", { git: false });
	const server = await startStandIn();
	try {
		const duty = { action: "add", mode: "change", text: "Keep the notes file current", standing: true };
		const result = await carto(root, server, [], {
			timeoutMs: 60_000,
			input: lines(
				planMessage(duty),
				"task(p1): write: notes.txt <<< early",
				"/approve",
				"task(p1): write: notes.txt <<< one",
				"task(p1): write: notes.txt <<< two",
				"/plan",
				planMessage({ action: "done", id: "p1" }),
				"task(p1): write: notes.txt <<< three",
			),
		});
		ok(result, "a session with a standing item");
		has(result.stdout, "● plan  + p1 [change, standing] Keep the notes file current\n", "the plan shows the mark");
		has(result.stdout, "plan  1 change item waits for you (1 standing): /plan shows the plan, /approve authorizes it\n", "the line that asks for /approve says so");
		has(result.stdout, "◂ p1 is a change item and the user has not authorized the plan", "it needs the user's word like any change item");
		has(result.stdout, "  p1 Keep the notes file current  · standing: the agent may carry it out again and again\n", "and /approve says what is agreed to");
		assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "two", "two tasks ran for it, and the third did not");
		has(result.stdout, "Authorized by the user: change items may run.\n  p1 [change, standing] Keep the notes file current\n", "it is still open after two tasks");
		has(result.stdout, "◂ p1 is marked done. For further work, add a new item to the plan.", "once it is marked done, no task is started for it");
		const after = server.requests.find((request) => request.messages.at(-1).role === "user" && messageText(request.messages.at(-1)).startsWith("task(p1): write: notes.txt <<< two"));
		has(stateOf(after), "Beyond that, nothing of the plan is left to do once. p1 is a standing duty: start a task for it whenever its text calls for it, as often as that is, and do not mark it done while the duty lasts. A wake set with `wake` brings you back to check on it.", "the state block says what a standing item is for");
		has(resultsOf(server, "book", "plan").at(-1), "The standing duty has ended: no further task can be started for it.", "and what marking it done means");
	} finally {
		await server.close();
	}
});

test("yolo: with --yolo change items run without /approve, also ones with the network; /yolo switches it", async () => {
	const root = makeProject("yolo");
	const server = await startStandIn();
	const port = new URL(server.url).port;
	try {
		// (`undone`: each task returns not done, so its item stays open for the next one.)
		const result = await carto(root, server, [...RUNS(), "--yolo"], {
			timeoutMs: 60_000,
			input: lines(
				planMessage(WRITE_ITEM, NET_ITEM),
				"task(p1): undone\\nwrite: roll.py <<< print(4)",
				`task(p2): undone\\nshell[window=net]: exec 3<>/dev/tcp/127.0.0.1/${port} && echo reached`,
				"/status",
				"/plan",
				"/yolo",
				"/yolo off",
				"/yolo off",
				"task(p1): undone\\nwrite: roll.py <<< print(5)",
				"/yolo maybe",
				"/yolo on",
				"task(p1): undone\\nwrite: roll.py <<< print(6)",
				"/undo",
			),
		});
		ok(result, "a session without approval");
		has(result.stdout, `${YOLO_LINE}\n`, "the header says so");
		assert.equal(YOLO_LINE, "approval: OFF (yolo) · the agent's change items run without /approve, also ones that reach the network · /undo takes a step back, /stop stops the agent");
		hasNot(result.stdout.split("● approval: on")[0], "wait for you", "nothing asks for /approve");
		hasNot(result.stdout.split("● approval: on")[0], "has not authorized", "and nothing is refused");
		if (findScript()) has(resultsOf(server, "shell")[0], "reached\n", "an item marked network reaches the network");
		const first = server.requests.find((request) => (stateOf(request) ?? "").includes("\nApproval\n"));
		has(stateOf(first), "\nApproval\nThe user has switched approval off and is watching what you do. A change item may run without /approve, also one marked network or standing: do not ask for /approve. Every change still needs a plan item: write the item, then start its task. Keep items small, so that the user can follow each step and take one back with /undo.\n\n", "the state block tells the agent");
		const planned = server.requests.find((request) => (stateOf(request) ?? "").includes("\nPlan\n"));
		has(stateOf(planned), "\nPlan\nThe user has switched approval off: change items may run without /approve.\n  p1 [change] Write the roller\n", "and so does the plan");
		has(stateOf(planned), "Beyond that, carry out the plan: p1 is next.", "which it is to carry out, not to ask about");
		has(result.stdout, `busy · /shells shows them\n  ${YOLO_LINE}\n`, "/status says it too");
		has(result.stdout, `\n  ${YOLO_LINE}\n  /yolo off asks for /approve again\n`, "/yolo shows the setting");
		has(result.stdout, "● approval: on · change items wait for /approve again\nplan  2 change items wait for you (1 with network access): /plan shows the plan, /approve authorizes it\n", "/yolo off, and at once the plan waits for the user");
		has(result.stdout, "\n  Approval is already on.\n", "twice changes nothing");
		has(result.stdout, "◂ p1 is a change item and the user has not authorized the plan", "from then on a change item is refused again");
		assert.equal(readFileSync(join(root, "roll.py"), "utf8"), "print(4)", "and nothing was written");
		has(result.stdout, "\n  /yolo shows the setting, /yolo on switches approval off, /yolo off switches it back on.\n", "anything else gets the usage");
		has(result.stdout, `● ${YOLO_LINE}\n  Every change is still a plan item with a checkpoint. The sandbox is a separate switch (/bwrap). Not remembered: the next start asks for approval again.\n`, "/yolo on says what it means");
		const toldOn = server.requests.find((request) => request.messages.some((message) => message.role === "user" && messageText(message).startsWith("I have switched approval off: change items may run without /approve while it stays off. Carry out the plan.")));
		assert.ok(toldOn, "and the agent, which was waiting for /approve, is told to go on");
		has(result.stdout, "│ write roll.py                                    → 1 line, replacing a file of 1 line\n", "then the item runs");
		has(result.stdout, "● undone  p1 · Write the roller\n  changed  roll.py (+1 −1)\n  p1 is open again. Approval is off, so the agent may carry it out again: tell it what you want instead.\n", "/undo takes it back as ever, and says what that means now");
		assert.equal(readFileSync(join(root, "roll.py"), "utf8"), "print(4)");
		assert.equal(loadPlan(join(root, ".atlas")).plan.authorized, undefined, "the plan itself was never authorized");

		// Not remembered.
		const again = await carto(root, server, [], { timeoutMs: 60_000, input: lines("task(p1): undone\\nwrite: roll.py <<< print(7)") });
		ok(again, "the next start");
		hasNot(again.stdout, "approval: OFF", "asks for approval again");
		has(again.stdout, "◂ p1 is a change item and the user has not authorized the plan", "and refuses");
	} finally {
		await server.close();
	}
});

test("yolo: the prompt shows it for as long as it is on", async () => {
	const root = makeProject("yolo-prompt", { git: false });
	const server = await startStandIn();
	try {
		const result = await cartoOnTerminal(root, server, [], [["Set one up in", ""], ["Type a message", "/yolo on"], ["[yolo] › ", "say: hi"], ["context ", "/yolo off"], ["approval: on", "/quit"]]);
		if (result === undefined) return "python3 is needed for a terminal";
		has(result.screen, "\n[yolo] › say: hi", "the prompt after /yolo on");
		assert.match(result.screen, /approval: on · change items wait for \/approve again\n› \/quit/, "and after /yolo off");
	} finally {
		await server.close();
	}
});

// ─── Talking to the user, thinking, and calls that fail again and again ─────

const REMINDER = "<cartographer>\nWritten by Cartographer, not by the user. Your last message had no tool call.\n\nSo it is kept as a note to yourself, and nobody else read it. If it was meant for the user, say it with `chat`. If work is left, go on with it. If nothing is left to do, call `sleep`.\n</cartographer>";
const REMINDED = "◆ That reply had no tool call: it is a note the agent wrote to itself, not an answer to you. The agent goes on.\n";
/** The requests whose newest message is the reminder. */
const reminders = (server) => server.requests.filter((request) => messageText(request.messages.at(-1)).startsWith(REMINDER));

test("chat: what the agent says to the user goes through `chat`; plain text is a note to itself, and the turn goes on after it", async () => {
	const root = makeProject("chat", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], {
			input: lines("say: Hello there.", "think: I keep this to myself.", "think then chat: The answer is 4.", `chat: Starting. || ${ledgerMessage({ action: "add", kind: "note", text: "n" })}`, `${ledgerMessage({ action: "add", kind: "note", text: "m" })} || then think`, "say:", "say: last"),
		});
		ok(result, "a session with chat");
		const chat = server.requests[0].tools.find((tool) => tool.function.name === "chat");
		assert.deepEqual(chat?.function.parameters.required, ["text"], "the model is offered `chat`, which takes a text");
		has(server.requests[0].messages[0].content, "Anything you say to the user must be sent with chat or ask: an answer, the plan in a few lines, what was done.", "and the prompt says what it is for");

		// Said with `chat`: on the screen as it is, and the turn ends with that reply.
		has(result.stdout, "› say: Hello there.\nHello there.\n  context ", "what `chat` says is the answer on the screen");
		assert.equal(server.requests.filter((request) => messageText(request.messages.at(-1)) === "say: Hello there.").length, 1, "a reply whose only call is `chat` ends the turn: no further request");
		const second = server.requests.find((request) => messageText(request.messages.at(-1)) === "think: I keep this to myself.");
		assert.deepEqual(second.messages.at(-3).tool_calls.map((call) => [call.function.name, JSON.parse(call.function.arguments)]), [["chat", { text: "Hello there." }]], "the conversation holds it as a call");
		assert.equal(messageText(second.messages.at(-2)), "Shown to the user.", "and its result");

		// Plain text and no call: a note to self. It is shown as the agent's own, the agent is told what it is, and
		// the turn goes on until the agent ends it, here with `sleep`.
		has(result.stdout, `› think: I keep this to myself.\n┊ I keep this to myself.\n${REMINDED}● resting\n  context `, "plain text is shown as the agent's own; the turn goes on after it and the agent ends it");
		const told = reminders(server);
		assert.equal(messageText(told[0].messages.at(-1)), REMINDER, "the reminder as the model gets it");
		assert.equal(told[0].messages.at(-1).role, "user", "it is sent like a message");
		has(result.stdout, `› think then chat: The answer is 4.\n┊ The answer is 4.\n${REMINDED}The answer is 4.\n  context `, "after the reminder the agent can say it with `chat`");

		// Beside another call, `chat` does not end the turn.
		has(result.stdout, "Starting.\n● ledger  + note n1  n\nReport received: Shown to the user. ++ n1 added.", "`chat` beside another call: the agent goes on working");
		// The same after work.
		has(result.stdout, `● ledger  + note n2  m\n┊ Noted for myself.\n${REMINDED}● resting\n`, "a note after calls is followed up too");
		assert.equal(told.length, 3, "each turn with a note is told what a note is, once");
		assert.equal(result.stdout.split(REMINDED).length - 1, 3, "and the screen says so each time");
		// In the request the note is marked as one, and the stored reply is not changed by that.
		const after = server.requests.at(-1).messages.filter((message) => message.role === "assistant").map(rawText);
		assert.ok(after.includes("Note to self: I keep this to myself.") && after.includes("Note to self: Noted for myself."), `notes are marked as notes in every request:\n${after.join("\n")}`);
		hasNot(JSON.stringify(after), "Note to self: Note to self", "once");

		has(result.stdout, "● chat  not shown: `text` is empty, so nothing was shown to the user.\n", "an empty `chat` is refused and the turn goes on");

		// The times: a message that follows a `chat` came after the turn had ended, not during work.
		has(stateOf(server.requests.at(-1)), "The user's newest message came just now.\n", "the state block does not take the user's next message for one sent during work");
		hasNot(stateOf(server.requests.at(-1)), "You have been working since", "so it does not say the agent has been working");

		// Inside a task, `chat` shows a line to the user and the task carries on.
		const task = await carto(root, server, ["-p", "task: chat: hi there\\nlist:\\nchat: hi again\\nread: a.txt"]);
		ok(task, "a task that talks to the user");
		has(task.stdout, "\nhi there\n", "what it says stands on the screen like any other `chat`");
		assert.match(task.stdout, /\nhi there\n│ list \.\s+→ project: [^\n]*\nhi again\n│ read a\.txt/, `and the task goes on, as often as it likes:\n${task.stdout}`);
		hasNot(task.stdout, "task ended by Cartographer", "nothing ends it");
		assert.equal(resultsOf(server, "chat").at(-1), "Shown to the user. You are still the task: carry on.", "the task is told that it is still the task");
		const kept = contextStore(root).chat.map((entry) => [entry.who, entry.text]);
		assert.deepEqual(kept.filter(([, text]) => text.startsWith("hi ")), [["you", "hi there"], ["you", "hi again"]], "and what it said is kept as talk with the user");
	} finally {
		await server.close();
	}
});

test("notes: the main agent's notes are followed up until it ends the turn; the same note three times, or too many replies, end it", async () => {
	const root = makeProject("notes", { git: false });
	configure(root, { mainTurns: 6 });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: lines("mumble", "babble", "say: still here") });
		ok(result, "a session of notes");
		has(result.stdout, `› mumble\n┊ Mumble.\n${REMINDED}┊ Mumble.\n┊ Mumble.\n! Cartographer ended the turn: the agent wrote the same note 3 times in a row and called nothing.\n  context `, "the same note three times ends the turn, and the user is told once what a note is");
		has(result.stdout, `› babble\n┊ Babble 1.\n${REMINDED}┊ Babble 2.\n┊ Babble 3.\n┊ Babble 4.\n┊ Babble 5.\n┊ Babble 6.\n! The agent made 6 replies in this turn without ending it with \`chat\` or \`sleep\`, so Cartographer ended the turn. Say "continue" to let it go on.\n  context `, "notes count as replies: the turn ends at mainTurns");
		const followed = server.requests.filter((request) => rawText(request.messages.at(-1)).startsWith("<cartographer>\nWritten by Cartographer, not by the user. Your last message had no tool call."));
		assert.equal(followed.filter((request) => messageText(request.messages.at(-1)).startsWith(REMINDER)).length, 2, "each turn explains a note once");
		assert.equal(followed.filter((request) => messageText(request.messages.at(-1)).includes("had no tool call. Noted.\n</cartographer>")).length, 1 + 4, "the later ones are only acknowledged");
		has(result.stdout, "› say: still here\nstill here\n", "and the session goes on");
		// The line after a note begins no turn of its own: the count of the turn's replies goes on over it.
		const last = server.requests.at(-1).messages.filter((message) => message.role === "assistant").map(rawText);
		assert.deepEqual(last.slice(0, 3), ["Note to self: Mumble.", "Note to self: Mumble.", "Note to self: Mumble."], "every request shows a note as one");
	} finally {
		await server.close();
	}
});

test("ask: a question waits for the user's answer, which comes back as the result; a number picks a choice", async () => {
	const root = makeProject("ask", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: lines("ask: Which colour? | red | blue", "2", "ask: What port?", "the usual one", "task: ask: Tabs or spaces? | tabs | spaces\\nread: a.txt", "spaces, please", "ask:", "ask: Anyone there?") });
		ok(result, "a session with questions");
		const ask = server.requests[0].tools.find((tool) => tool.function.name === "ask").function.parameters;
		assert.deepEqual([ask.required, Object.keys(ask.properties).sort(), ask.properties.choices.type], [["text"], ["choices", "text"], "array"], "`ask` takes a text and optional choices");
		has(result.stdout, "? Which colour?\n    1  red\n    2  blue\n  Type a number, or an answer of your own. The agent waits for it.\n› 2\n", "the question stands on the screen with its choices");
		assert.deepEqual(resultsOf(server, "ask").slice(0, 3), ["The user answered: blue", "The user answered: the usual one", "The user answered: spaces, please"], "a number picks a choice, and anything else is the answer as typed");
		has(result.stdout, "? What port?\n  Type your answer. The agent waits for it.\n› the usual one\n", "without choices the user just replies");
		has(result.stdout, "? Tabs or spaces?\n    1  tabs\n    2  spaces\n  Type a number, or an answer of your own. The task waits for it.\n› spaces, please\n│ read a.txt", "a task can ask too, and goes on with the answer");
		has(result.stdout, "refused: `text` is empty, so nothing was asked.", "a question needs words");
		// Nobody left to answer: the agent is told and goes on.
		has(result.stdout, "? Anyone there?\n  Type your answer. The agent waits for it.\n  nobody is at the terminal to answer: the agent is told and goes on\n", "when the input has ended, the question does not wait forever");
		has(resultsOf(server, "ask").at(-1), "No answer: nobody is at the terminal: its input has ended. The question stays on their screen. Go on with what you can decide yourself and say what you assumed, or leave the matter open.", "and the agent is told what to do then");
		// Question and answer are talk with the user: a collapse keeps them.
		const kept = contextStore(root).chat.map((entry) => `${entry.who}: ${entry.text}`);
		for (const line of ["you: Which colour?\n  1  red\n  2  blue", "user: blue", "you: What port?", "user: the usual one", "user: spaces, please"]) assert.ok(kept.includes(line), `kept as talk: ${line}\n${kept.join("\n")}`);
	} finally {
		await server.close();
	}
});

test("ask: on a terminal the next line is the answer, a command is still a command, and askMinutes gives up", async () => {
	const root = makeProject("ask-pty", { git: false });
	configure(root, { askMinutes: 0.04 });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "" }), "set up");
		const result = await cartoOnTerminal(root, server, [], [
			["Type a message", "ask: Which colour? | red | blue"],
			["The agent waits for it", "/status"],
			["stand-in at", "1"],
			["The user answered: red", "ask: Still there?"],
			["no answer within 2 seconds", ""],
			["Report received: No answer", "ask: And now?"],
			[2, "/stop"],
			["stopped", "/quit"],
		]);
		if (result === undefined) return "python3 is needed for a terminal";
		assert.deepEqual(resultsOf(server, "ask").slice(0, 2), ["The user answered: red", "No answer: the user did not answer within 2 seconds. The question stays on their screen. Go on with what you can decide yourself and say what you assumed, or leave the matter open."], "the answer, and what the agent is told when none comes");
		has(result.screen, "  no answer within 2 seconds: the agent is told and goes on\n", "the screen says that the wait was given up");
		hasNot(JSON.stringify(resultsOf(server, "ask")), "/status", "a command typed while a question waits is not the answer");
		// /stop ends the wait; the agent finds the question unanswered when it is next spoken to.
		has(result.screen, "? And now?\n  Type your answer. The agent waits for it.\n", "a third question");
		has(result.screen, "\n  stopped\n", "/stop ends the wait");
	} finally {
		await server.close();
	}
});

test("task: what the user types while a task runs goes to the task with its next result, and the main agent is told with the report", async () => {
	const root = makeProject("tell-task", { git: false });
	const server = await startStandIn({ tokenDelayMs: 120 });
	try {
		ok(await carto(root, server, [], { input: "" }), "set up");
		const result = await cartoOnTerminal(root, server, [], [
			["Type a message", "task: read: a.txt\\nread: README.md\\nread: src/math.js\\nread: src/main.js"],
			["read a.txt  ", "use tabs please"],
			["(sent to the running task", ""],
			["report t1", ""],
			["context ", "/quit"],
		]);
		if (result === undefined) return "python3 is needed for a terminal";
		has(result.screen, "  (sent to the running task: it reads it at its next step, and the main agent is told with the report)\n", "the screen says where the line went");
		const told = server.requests.filter(isTask).find((request) => rawText(request.messages.at(-1)).includes("use tabs please"));
		assert.ok(told, "the task was sent the line");
		assert.match(rawText(told.messages.at(-1)), /^== [^\n]*\n[\s\S]*\n\nCartographer: the user wrote this while you work\. Take it into account, and put into your report what you could not act on\.\n\[user · [^\]]+\] use tabs please/, `after the result of its step:\n${rawText(told.messages.at(-1))}`);
		assert.equal(server.requests.filter(isTask).filter((request) => rawText(request.messages.at(-1)).includes("the user wrote this while you work")).length, 1, "once");
		assert.match(resultsOf(server, "task")[0], /\n\nWhile this task ran, the user wrote to it:\n\[user · [^\]]+\] use tabs please/, "the main agent, which was not there, is told with the report");
		assert.ok(contextStore(root).chat.some((entry) => entry.who === "user" && entry.text === "use tabs please"), "and the line is kept as talk");
		assert.equal(server.requests.filter((request) => !isTask(request) && messageText(request.messages.at(-1)).startsWith("use tabs please")).length, 0, "it is not also a message to the main agent");
	} finally {
		await server.close();
	}
});

test("task: `return` carries the report, marks a plan item done or leaves it open, and its summary is what a collapse keeps", async () => {
	const root = makeProject("return", { git: false });
	const server = await startStandIn();
	try {
		const ret = (args) => `return: ${JSON.stringify(args)}`;
		const result = await carto(root, server, [], {
			input: lines(
				planMessage(LOOK_ITEM, { action: "add", mode: "look", text: "Second look" }),
				`task(p1): read: a.txt\\n${ret({ report: "The file a.txt holds one line. Nothing else was read.", done: true, summary: "a.txt: one line" })}`,
				`task(p2): undone\\nread: a.txt`,
				`task: ${ret({ report: "Half of it.", done: false })}`,
				`task: read: a.txt\\n${ret({ report: "x", done: true, shelf: "nope.txt" })}\\n${ret({ report: "Second try.", done: true })}`,
				"/plan",
			),
		});
		ok(result, "a session of returns");
		const tool = server.requests[0].tools.find((entry) => entry.function.name === "return").function.parameters;
		assert.deepEqual([tool.required.sort(), Object.keys(tool.properties).sort()], [["done", "report"], ["done", "report", "shelf", "summary"]], "`return` requires the report and whether the brief is carried out");
		const reports = resultsOf(server, "task");
		has(reports[0], "The file a.txt holds one line. Nothing else was read.\n\n[Cartographer: the task returned done, so p1 is marked done in the plan. If the report or the record below shows that something is missing, add an item for it.]", "the report is what `return` gave, and done marks the item");
		has(result.stdout, "● plan  ✓ p1 marked done by its task\n", "the screen says so");
		has(reports[1], "[Cartographer: the task returned not done, so p2 stays open in the plan.]", "not done leaves the item open");
		has(result.stdout, "characters · returned not done  (/report shows it)\n● plan  p2 stays open: its task returned not done\n", "and the screen says that too");
		has(reports[2], "Half of it.\n\n[Cartographer: the task returned not done.]", "also without a plan item");
		const plan = loadPlan(join(root, ".atlas")).plan;
		assert.deepEqual(plan.items.map((item) => [item.id, item.status]), [["p1", "done"], ["p2", "open"]], "the plan holds it");
		has(resultsOf(server, "return").find((text) => text.startsWith("Not on your shelf")), "Not on your shelf: nope.txt. Your shelf is empty. The task has not ended: call `return` again without `shelf`, or name files from your shelf.", "a file that is not on the task's shelf cannot be handed on");
		has(reports[3], "Second try.", "and the task ends with the next `return`");
		// What is remembered of each task: its summary, or the start of its report.
		const records = contextStore(root).records;
		assert.deepEqual(records.map((record) => [record.id, record.outcome, record.undone === true]), [["t1", "a.txt: one line", false], ["t2", "== a.txt", true], ["t3", "Half of it.", true], ["t4", "Second try.", false]], "the record line is the summary when one was given");
		has(readFileSync(join(root, ".atlas", "reports", "t1.md"), "utf8"), "Report:\nThe file a.txt holds one line. Nothing else was read.", "the report is stored in full");
	} finally {
		await server.close();
	}
});

test("chat: a turn that a wake started and in which nothing was done is a rest already; one in which the agent acted goes on after a note", async () => {
	const root = makeProject("chat-wake", { git: false });
	mkdirSync(join(root, ".atlas"), { recursive: true });
	writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ wakeMin: 1 }));
	const server = await startStandIn();
	try {
		const quiet = await carto(root, server, [], { timeoutMs: 60_000, input: lines('wake: {"action":"set","note":"look","every":1,"times":1}', "/wait 10", "say: after") });
		ok(quiet, "a wake that finds nothing");
		has(quiet.stdout, "◆ Wake w1 (every 1 s): its time came.", "the wake fired");
		has(quiet.stdout, "┊ Woken: Wake w1", "what the agent wrote on waking is its own");
		assert.equal(reminders(server).length, 0, "a quiet wake turn is a rest already: no reminder");
		hasNot(quiet.stdout, REMINDED, "and none on the screen");

		const other = makeProject("chat-wake-acts", { git: false });
		mkdirSync(join(other, ".atlas"), { recursive: true });
		writeFileSync(join(other, ".atlas", "config.json"), JSON.stringify({ wakeMin: 1 }));
		const acted = await carto(other, server, [], {
			timeoutMs: 60_000,
			input: lines(`ON WAKE: ${ledgerMessage({ action: "add", kind: "note", text: "seen" })} || then think`, 'wake: {"action":"set","note":"look again","every":1,"times":1}', "/wait 10"),
		});
		ok(acted, "a wake on which the agent acts");
		has(acted.stdout, `● ledger  + note n1  seen\n┊ Noted for myself.\n${REMINDED}● resting\n`, "a wake turn with work in it goes on after a note, until the agent rests");
	} finally {
		await server.close();
	}
});

test("thinking: the agent's own text and the model's reasoning are shown behind a gutter; /thinking hides and shows them", async () => {
	const root = makeProject("thinking", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], {
			input: lines(
				"reason: Let me think about this. || say: Done thinking.",
				"/thinking off",
				"reason: hidden reasoning || think then chat: Shown answer.",
				"/thinking on",
				"/thinking off",
				"task: saying task words >> list:",
				"/thinking",
				"task: saying task words >> list:",
				"/thinking maybe",
			),
		});
		ok(result, "a session with reasoning");
		has(result.stdout, "› reason: Let me think about this. || say: Done thinking.\n┊ Let me think about this.\nDone thinking.\n  context ", "reasoning comes first, behind the gutter; the answer follows on its own line");
		has(result.stdout, "┊ thinking is hidden\n", "/thinking off");
		has(result.stdout, `› reason: hidden reasoning || think then chat: Shown answer.\n┊ thinking… (/thinking on shows it)\n${REMINDED}Shown answer.\n  context `, "hidden: one line for a reply that thought, and the answer as ever");
		has(result.stdout, "┊ hidden reasoning\n┊ Shown answer.\n┊ thinking is shown\n", "switching it on shows what the newest turn held back: its reasoning and its plain text");
		assert.equal(result.stdout.split("hidden reasoning").length - 1, 2, "which was nowhere on the screen before: once in what was typed, once now");
		const [hiddenTask, shownTask] = result.stdout.split("› task: saying task words >> list:").slice(1);
		hasNot(hiddenTask.split("›")[0], "│ task words", "a task's own text is hidden with it");
		has(shownTask, "│ task words\n", "and shown with it");
		has(result.stdout, "  /thinking switches it, /thinking on shows what the agent thinks and notes for itself, /thinking off hides it.\n", "anything else is explained");
		// None of this changes what the model is sent.
		hasNot(JSON.stringify(server.requests.at(-1).messages), "thinking is", "the switch is the screen's business");

		// The setting it starts with.
		writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ thinking: false }));
		const hidden = await carto(root, server, ["-p", "reason: quiet thought || say: Answer."]);
		ok(hidden, "started with thinking off");
		has(hidden.stdout, "┊ thinking… (/thinking on shows it)\nAnswer.\n", "config `thinking: false` starts with it hidden");
		hasNot(hidden.stdout, "┊ quiet thought", "so the reasoning is not printed");
		writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ thinking: "no" }));
		const bad = await carto(root, server, ["-p", "say: x"]);
		assert.notEqual(bad.code, 0, "a setting that is neither true nor false is refused");
		has(bad.all, "config: thinking must be true or false", "and named");
	} finally {
		await server.close();
	}
});

test("thinking: Ctrl-T hides and shows it on a terminal, and leaves what is being typed alone", async () => {
	const root = makeProject("thinking-key", { git: false });
	const server = await startStandIn();
	try {
		const result = await cartoOnTerminal(root, server, [], [
			["Set one up", ""],
			["Type a message.", "\x14", false],
			["thinking is hidden", "reason: a secret thought || say: Answer one."],
			["context ", "half typed\x14", false],
			["thinking is shown", "\x15/quit"],
		]);
		if (result === undefined) return "python3 is needed for a terminal";
		has(result.screen, "Ctrl-T hides and shows its thinking.", "the key is named at the start");
		has(result.screen, "┊ thinking is hidden (Ctrl-T switches)", "Ctrl-T hides it");
		has(result.screen, "┊ thinking… (Ctrl-T shows it)\nAnswer one.\n", "a reply that thought says so in one line");
		has(result.screen, "┊ a secret thought\n┊ thinking is shown (Ctrl-T switches)\n", "Ctrl-T again shows what was held back");
		assert.match(result.screen, /thinking is shown \(Ctrl-T switches\)\n(\[no sandbox\] )?› half typed/, `what was being typed is put back on the prompt:\n${result.screen}`);
	} finally {
		await server.close();
	}
});

test("loop: the same call failing three times with no call succeeding in between ends the turn", async () => {
	const root = makeProject("loop", { git: false });
	const server = await startStandIn();
	try {
		const TOLD = "[warn] Cartographer: you sent this exact call 3 times with no call succeeding in between, and it failed each time. Do not send it again unchanged: change the arguments, use another tool, or say what stops you. Cartographer ends a turn in which this is all that happened.";
		const ENDED = "! Cartographer ended the turn: the same call was sent 3 times and failed each time: wake {}\n";
		const result = await carto(root, server, [], {
			input: lines(
				"wake: {} || wake: {} || wake: {}",
				"again: wake: {}",
				"wake: {} || wake: {}",
				'wake: {} || wake: {"action":"remove","id":"w7"} || wake: {"action":"remove","id":"w8"}',
				'wake: {} || wake: {} || wake: {"action":"remove","id":"w9"} || wake: {"action":"remove","id":"w9"} || wake: {"action":"remove","id":"w9"}',
				"say: after",
			),
		});
		ok(result, "a session with failing calls");
		const after = (text) => server.requests.filter((request) => messageText(request.messages.findLast((message) => message.role === "user")) === text);

		// Three in one reply: every result asks for the end, so the turn ends with that reply.
		assert.equal(after("wake: {} || wake: {} || wake: {}").length, 1, "three identical failing calls in one reply: no further request");
		has(result.stdout, `› wake: {} || wake: {} || wake: {}\n● wake  not changed: Validation failed for tool "wake": - action: missing Received arguments: {} [warn] Cartographer: you sent this exact call 3 times`, "the first of them says so already");
		assert.equal(result.stdout.split("› again: wake: {}")[0].split(ENDED).length - 1, 1, `and the screen says once why the turn ended:\n${result.stdout}`);
		const next = after("again: wake: {}")[0];
		const results = next.messages.filter((message) => message.role === "tool").slice(0, 3).map(rawText);
		for (const text of results) has(text, `<harness>\n[error] Validation failed for tool "wake":\n  - action: missing\n\nReceived arguments:\n{}\n${TOLD}\n</harness>`, "the agent finds the error and why its turn ended, in each result");

		// One in each reply: the third ends it. What failed before the user's new message does not count.
		assert.equal(after("again: wake: {}").length, 3, "one failing call per reply: the third reply is the last");
		assert.equal(result.stdout.split("› again: wake: {}")[1].split("› wake: {} || wake: {}")[0].split(ENDED).length - 1, 1, "said once again");

		// Fewer than three, or calls that differ, end nothing.
		has(result.stdout, "› wake: {} || wake: {}\n● wake  not changed: Validation failed for tool \"wake\": - action: missing Received arguments: {}\n● wake  not changed: Validation failed for tool \"wake\": - action: missing Received arguments: {}\nReport received:", "two failing calls: the agent goes on");
		assert.equal(after('wake: {} || wake: {"action":"remove","id":"w7"} || wake: {"action":"remove","id":"w8"}').length, 2, "three failing calls that differ: the agent goes on");

		// A reply with such a run beside other calls: the agent is told, and the turn is not ended for it.
		has(result.stdout, '! The agent is told to stop: the same call was sent 3 times and failed each time: wake {"action":"remove","id":"w9"}\n', "three of one call beside two of another: said, without claiming the turn ended");
		assert.equal(after('wake: {} || wake: {} || wake: {"action":"remove","id":"w9"} || wake: {"action":"remove","id":"w9"} || wake: {"action":"remove","id":"w9"}').length, 2, "since the reply's other calls still get their answer");
		has(result.stdout, "› say: after\nafter\n", "and the session goes on");

		// The same inside a task: the task ends, and the main agent is told what happened.
		const task = await carto(root, server, ["-p", "task: saying I tried to write. >> write: x.txt <<< a\\nwrite: x.txt <<< a\\nwrite: x.txt <<< a\\nread: a.txt"]);
		ok(task, "a task that fails the same way three times");
		has(task.stdout, '│ ! Cartographer ended the task: the same call was sent 3 times and failed each time: write {"path":"x.txt","content":"a"}\n', "the screen says why the task ended");
		hasNot(task.stdout, "│ read a.txt", "what came after was never done");
		const report = resultsOf(server, "task").at(-1);
		has(report, 'Cartographer ended the task: it sent the same call 3 times and it failed each time: `write {"path":"x.txt","content":"a"}`\nThe error was:\nTool call blocked: This is a look task, so it cannot change files.', "the main agent is told the call and the error");
		has(report, "\nWhat it had written for itself:\n- I tried to write.\nIf the work is still needed, start another task whose brief says how to avoid this.", "and what the task last wrote");

		// A call that succeeds in between starts the count again.
		const broken = await carto(root, server, ["-p", "task: write: x.txt <<< a\\nwrite: x.txt <<< a\\nlist:\\nwrite: x.txt <<< a\\nwrite: x.txt <<< a\\nread: a.txt"]);
		ok(broken, "two failures, a success, two failures");
		has(broken.stdout, "│ read a.txt", "the task is not ended");
		hasNot(broken.stdout, "Cartographer ended the task", "and nothing says so");
		assert.ok(!existsSync(join(root, "x.txt")), "the refused writes wrote nothing");
	} finally {
		await server.close();
	}
});

// ─── The context engine ─────────────────────────────────────────────────────

/** The front block a request carries (what a collapse left in view), or undefined. */
const frontOf = (request) => /<context>\nWritten by Cartographer[\s\S]*?\n<\/context>/.exec(request.messages.map(rawText).join("\n"))?.[0];
/** What the context engine keeps on disk. */
const contextStore = (root) => JSON.parse(readFileSync(join(root, ".atlas", "carto-context.json"), "utf8"));
/** A message long enough that the work it causes is worth collapsing: the assessment is refused for its length. */
const BULK = `assess: ${"The project is a small one. ".repeat(300)}`.trim();
const configure = (root, config) => {
	mkdirSync(join(root, ".atlas"), { recursive: true });
	writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify(config));
};
/** The requests the main agent made (a task's begin with its brief somewhere). */
const mainRequests = (server) => server.requests.filter((request) => !request.messages.some((message) => message.role === "tool" && rawText(message).startsWith("You are now the task")));
const taskRequests = (server) => server.requests.filter((request) => request.messages.some((message) => message.role === "tool" && rawText(message).startsWith("You are now the task")));

test("context: what the engine works with: line ranges, what a collapse would free, what a re-read replaces", () => {
	assert.deepEqual(parseLines(undefined), {});
	assert.deepEqual(parseLines("10-80"), { from: 10, to: 80 });
	assert.deepEqual(parseLines(" 3 to 9 "), { from: 3, to: 9 });
	assert.throws(() => parseLines("ten"), ShelfError);
	assert.throws(() => parseLines("9-3"), ShelfError);
	assert.throws(() => parseLines("0-3"), ShelfError);
	assert.equal(shelfLabel({ path: "a.js" }), "a.js");
	assert.equal(shelfLabel({ path: "a.js", from: 2, to: 5 }), "a.js (lines 2-5)");
	assert.equal(KEPT_AS("t7"), "This report is kept as t7.");

	const text = (role, words, more = {}) => ({ role, content: [{ type: "text", text: words }], ...more });
	const call = (name, args) => ({ role: "assistant", content: [{ type: "toolCall", id: "c", name, arguments: args }] });
	// The user's words and what was said with `chat` stay; everything else goes.
	assert.equal(droppable([text("user", "x".repeat(4000))]), 0, "the user's message is talk");
	assert.equal(droppable([call("chat", { text: "y".repeat(4000) })]) < 50, true, "what was said with chat is talk");
	assert.equal(droppable([text("toolResult", "z".repeat(4000), { toolName: "task" })]) >= 1000, true, "a report goes");
	assert.equal(droppable([text("assistant", "n".repeat(4000))]) >= 1000, true, "the agent's own notes go");
	assert.equal(droppable([text("user", "<context>\nWritten by Cartographer, not by the user. Your context was collapsed" + "k".repeat(4000) + "\n</context>")]), 0, "the front block is what was kept already");

	// What Cartographer adds to a request is not part of the stored message.
	assert.equal(withoutAdditions("<context>\nWritten by Cartographer, not by the user. x\n</context>\n\nhello"), "hello");
	assert.equal(withoutAdditions("a result\n\n[s3 · about 2,100 tokens]"), "a result");
	assert.equal(withoutTags("a result\n\n[s12 · about 900 tokens]"), "a result");
	assert.equal(withoutTags("a result [s3 · about 2,100 tokens] in the middle"), "a result [s3 · about 2,100 tokens] in the middle", "only the mark at the end");

	// A task's steps: everything behind the brief, each result with an id.
	const big = `== a.js (lines 1-300 of 300)\n${"line\n".repeat(600)}`;
	const messages = [
		text("user", "do it"),
		call("task", { brief: "b" }),
		text("toolResult", `${TASK_HEADER}\n\nBrief:\nb`, { toolName: "task", toolCallId: "c" }),
		{ role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { paths: ["a.js"] } }] },
		text("toolResult", big, { toolName: "read", toolCallId: "r1" }),
		{ role: "assistant", content: [{ type: "toolCall", id: "r2", name: "read", arguments: { paths: ["b.js"] } }] },
		text("toolResult", "== b.js (lines 1-2 of 2)\n1  x\n2  y", { toolName: "read", toolCallId: "r2" }),
	];
	assert.equal(stepsOf([text("user", "hi")]), undefined, "no brief, no task");
	const steps = stepsOf(messages);
	assert.equal(steps.start, 3);
	assert.equal(steps.replies, 2);
	assert.deepEqual(steps.results.map((result) => result.id), ["s1", "s2"]);
	// A read of the same lines again: the older copy is replaced, when it is large and not much has come since.
	assert.deepEqual(supersededBy(steps, { paths: ["a.js"] }), ["s1"]);
	assert.deepEqual(supersededBy(steps, { paths: ["b.js"] }), [], "a small result is left alone: replacing it saves less than reading the rest again costs");
	assert.deepEqual(supersededBy(steps, { paths: ["a.js"], offset: 5 }), [], "other lines are another read");
	assert.deepEqual(supersededBy(steps, { paths: ["a.js"] }, { s1: "gone" }), [], "what is dropped already is not dropped again");
	// Far back, with much read since: left alone, since everything behind it would be read again.
	const far = [...messages.slice(0, 5), ...Array.from({ length: 12 }, (_, i) => [{ role: "assistant", content: [{ type: "toolCall", id: `m${i}`, name: "read", arguments: { paths: [`f${i}.js`] } }] }, text("toolResult", big, { toolName: "read", toolCallId: `m${i}` })]).flat()];
	assert.deepEqual(supersededBy(stepsOf(far), { paths: ["a.js"] }), [], "far back");
	// Dressed for the request: the mark at the end of a large result, a dropped one as one line.
	const dressed = dressTask(messages, { dropped: {} });
	assert.match(dressed[4].content[0].text, /\n\n\[s1 · about [\d,]+ tokens\]$/);
	assert.equal(dressed[6].content[0].text, "== b.js (lines 1-2 of 2)\n1  x\n2  y", "a small result carries no mark");
	assert.deepEqual(dressed.slice(0, 3), messages.slice(0, 3), "nothing before the brief is touched, nor the brief");
	const dropped = dressTask(messages, { dropped: { s1: "You dropped this result." } });
	assert.match(dropped[4].content[0].text, /^\[s1: You dropped this result\. It was: read a\.js, about [\d,]+ tokens\. Call again if you need it\.\]$/);
	assert.equal(messages[4].content[0].text, big, "the stored messages are not changed");
});

test("context: every report is kept under an id; /report shows it, and the agent can recall it", async () => {
	const root = makeProject("context-reports", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: 'task: read: src/math.js\ntask: list:\n/report t1\n/report t9\n/report\ncontext: {"action":"recall","id":"t1"}\ncontext: {"action":"recall","id":"t9"}\n' });
		ok(result, "run");
		has(result.stdout, "◂ report t1  ", "the report line names the id");
		has(result.stdout, "◂ report t2  ", "and the next one the next");
		const report = readFileSync(join(root, ".atlas", "reports", "t1.md"), "utf8");
		assert.match(report, /^Report t1 · [^\n]* · look task\n\nBrief:\nread: src\/math\.js\n\nReport:\nREPORT\n== src\/math\.js \(lines 1-4 of 4\)\n$/, "the report is on disk, with what was asked");
		hasNot(report, "This report is kept as", "without the line that names it");
		// The main agent's copy ends with the id.
		const after = mainRequests(server)[1];
		assert.match(rawText(after.messages.at(-1)), /^REPORT\n== src\/math\.js \(lines 1-4 of 4\)\n\nThis report is kept as t1\.\n\n\[task ended /, "the report names its id");
		// One line per task in the store.
		const store = contextStore(root);
		assert.deepEqual(store.records.map((record) => [record.id, record.mode, record.brief]), [["t1", "look", "read: src/math.js"], ["t2", "look", "list:"]]);
		assert.equal(store.next, 3);
		// /report with an id shows that report; an unknown id is said.
		assert.match(result.stdout, /\nReport t1 · [^\n]* · look task\n\nBrief:\nread: src\/math\.js\n\nReport:\nREPORT\n== src\/math\.js \(lines 1-4 of 4\)\n  There is no report t9\. \/context lists the kept ones\.\nREPORT\nproject: 5 files\n› /, "/report t1 shows the kept one, an unknown id is said, /report alone shows the last");
		has(result.stdout, "◂ report t1  38 characters", "the size is the report's own");
		// Recall while it is still in view adds nothing; an unknown id lists what there is.
		has(result.stdout, "● context  nothing done: Report t1 is still in your context, further up: nothing was added.", "still in view");
		has(result.stdout, "● context  nothing done: There is no report t9. Kept: t1, t2.", "unknown");
	} finally {
		await server.close();
	}
});

test("context: /collapse puts one block in place of the work so far; the agent is asked first and the server reads the result ahead", async () => {
	const root = makeProject("context-collapse", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: "task: read: src/math.js\nsay: hello there\n/collapse\nsay: after\n" });
		ok(result, "run");
		const requests = mainRequests(server);
		const last = requests.at(-2);
		const next = requests.at(-1);
		assert.equal(server.asides.length, 2, "one question, one read-ahead");
		const [question, ahead] = server.asides;

		// The question goes behind the last request and its answer, so the server has read all but the question.
		assert.equal(question.stream, false);
		assert.equal(question.max_tokens, 16);
		assert.equal(question.temperature, 0);
		assert.equal(question.response_format.type, "json_schema");
		assert.deepEqual(question.response_format.json_schema.schema, { type: "object", properties: { handoff: { type: "boolean" } }, required: ["handoff"], additionalProperties: false });
		assert.deepEqual(question.chat_template_kwargs, { enable_thinking: false }, "no thinking for a one-word answer");
		assert.equal(question.stream_options, undefined);
		assert.deepEqual(question.tools, last.tools, "the same tools, or the server would read everything again");
		assert.deepEqual(question.messages.slice(0, last.messages.length), last.messages, "the last request, unchanged");
		const tail = question.messages.slice(last.messages.length);
		assert.deepEqual(tail.map((message) => message.role), ["assistant", "tool", "user"], "then the reply, its result, and the question");
		assert.equal(tail[0].tool_calls[0].function.name, "chat");
		assert.equal(tail[1].content, "Shown to the user.");
		assert.match(tail[2].content, /^<cartographer>\nWritten by Cartographer, not by the user\. Your context is about to be collapsed \(the user asked for it\)\.\n\nYou keep: /);
		assert.match(tail[2].content, /Answer \{"handoff": true\} to get one turn to write it down first\. Answer \{"handoff": false\} to collapse now\.\n<\/cartographer>$/);
		has(result.stdout, "◆ asked before collapsing (the user asked for it): does it need to write something down first? no · ", "the answer is shown");

		// The next request: the prompt, the block, the new message. Nothing of the work before.
		assert.deepEqual(next.messages.map((message) => message.role), ["system", "user", "user"]);
		assert.deepEqual(next.messages[0], last.messages[0], "the prompt is the same");
		assert.deepEqual(next.tools, last.tools, "and so are the tools");
		const front = frontOf(next);
		assert.match(front, /^<context>\nWritten by Cartographer, not by the user\. Your context was collapsed on [^\n]* \(the user asked for it\)\. What you had in view before is gone except for what stands here: one line for each finished task, your shelf, and the last of your talk with the user\. Your ledger, plan, graph and assessment are as you left them; the state block at the end of the request shows them\.\n\nFinished tasks \(`book` with book context, action recall and the id brings a report back in full\)\nt1 · [^\n]* · look · asked: read: src\/math\.js → == src\/math\.js \(lines 1-4 of 4\)\n\nYour shelf is empty\.\n\nYour talk with the user, word for word; what was said before it is gone\n/);
		assert.match(front, /\n\[user · [^\]]*\] task: read: src\/math\.js\n\[you · [^\]]*\] Report received: REPORT\n== src\/math\.js \(lines 1-4 of 4\)\n\[user · [^\]]*\] say: hello there\n\[you · [^\]]*\] hello there\n<\/context>$/, "the talk, word for word, and nothing after it");
		hasNot(rawText(next.messages[1]), "MARKER-ONLY-IN-FILE", "no file text");
		assert.ok(rawText(next.messages[1]).startsWith("<project>\nWritten by Cartographer"), "the copy of the assessment and graph stands before it");
		assert.equal(messageText(next.messages[2]).trim().split("\n")[0], "say: after");
		assert.equal(stateCount(next), 1, "one state block, at the end");

		// The read-ahead is the start of that next request, to the letter: the prompt, the tools and the block.
		assert.equal(ahead.stream, false);
		assert.equal(ahead.max_tokens, 1);
		assert.equal(ahead.response_format, undefined);
		assert.deepEqual(ahead.tools, next.tools);
		assert.deepEqual(ahead.messages, next.messages.slice(0, 2), "what was read ahead is what the next request begins with");

		has(result.stdout, "◆ context collapsed (the user asked for it): about ", "the collapse is shown");
		has(result.stdout, " tokens · kept 1 task record, 0 shelf items, 4 messages of talk  (/context shows it)\n", "with what was kept");
		assert.match(result.stdout, /\n  read ahead by the server: [\d.,k]+ tokens in [\d.]+ s, so the next answer starts at once\n/);
		// The report can still be recalled, and the answer says it was added.
		const store = contextStore(root);
		assert.equal(store.front.reason, "the user asked for it");
		assert.deepEqual(store.front.kept, { tasks: 1, shelf: 0, talk: 4 });
	} finally {
		await server.close();
	}
});

test("context: the collapse is kept across a restart, and a report recalled after it comes back in full", async () => {
	const root = makeProject("context-restart", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "task: read: src/math.js\n/collapse\n" }), "first run");
		const asides = server.asides.length;
		const result = await carto(root, server, [], { input: 'context: {"action":"recall","id":"t1"}\nsay: and now\n' });
		ok(result, "second run");
		const [recall, shown, later] = server.requests.slice(-3);
		assert.deepEqual(recall.messages.map((message) => message.role), ["system", "user", "user"], "the context begins with the block");
		has(frontOf(recall), "t1 · ", "the record is in it");
		has(result.stdout, "● context  recalled t1 · about ", "the recall is shown");
		const back = rawText(shown.messages.at(-1));
		assert.match(back, /^Report t1 · [^\n]* · look task\n\nBrief:\nread: src\/math\.js\n\nReport:\nREPORT\n== src\/math\.js \(lines 1-4 of 4\)\n\n\[Recalled\. It is in view until your context is next collapsed\.\]/, "the report in full, with what was asked");
		// It now stands in view under its id: a second recall adds nothing.
		ok(await carto(root, server, [], { input: 'context: {"action":"recall","id":"t1"}\n' }), "third run");
		has(rawText(server.requests.at(-1).messages.at(-1)), "Report t1 is still in your context, further up: nothing was added.", "once is enough");
		assert.equal(server.asides.length, asides, "nothing was collapsed in the later runs: too little to gain");
		assert.equal(later.messages.length > 3, true);
	} finally {
		await server.close();
	}
});

test("context: asked before a collapse, the agent can take one turn to write down what would be lost", async () => {
	const root = makeProject("context-handoff", { git: false });
	const server = await startStandIn();
	try {
		const note = 'ON COLLAPSE: ledger: [{"action":"add","kind":"note","text":"the port is 8080"}]';
		const result = await carto(root, server, [], { input: `say: fine ${note}\n/collapse\nsay: after\n` });
		ok(result, "run");
		has(result.stdout, "does it need to write something down first? yes · ", "it said yes");
		// The turn it gets: a note from Cartographer, not a message of the user.
		const turn = server.requests.find((request) => rawText(request.messages.at(-1)).includes("Your context will be collapsed when this turn ends"));
		assert.ok(turn, "it gets a turn");
		assert.match(messageText(turn.messages.at(-1)), /^<cartographer>\nWritten by Cartographer, not by the user\. Nobody typed this\. Your context will be collapsed when this turn ends \(the user asked for it\), and you asked for a turn first\./);
		has(result.stdout, "● ledger  + note n1  the port is 8080\n", "it writes the note");
		assert.equal(loadLedger(join(root, ".atlas")).ledger.items.find((entry) => entry.id === "n1").text, "the port is 8080");
		// Then the collapse, with one question in all.
		assert.equal(server.asides.filter((aside) => aside.response_format !== undefined).length, 1, "it is asked once, not again after its turn");
		const order = [result.stdout.indexOf("does it need to write"), result.stdout.indexOf("● ledger  + note n1"), result.stdout.indexOf("◆ context collapsed (the user asked for it)")];
		assert.ok(order[0] !== -1 && order[0] < order[1] && order[1] < order[2], `asked, written, collapsed, in that order: ${order}`);
		const next = server.requests.at(-1);
		assert.deepEqual(next.messages.map((message) => message.role), ["system", "user", "user"]);
		hasNot(frontOf(next), "Your context will be collapsed when this turn ends", "the note that gave it the turn is not talk");
		has(stateOf(next), "n1  the port is 8080", "what it wrote is in the state block");
	} finally {
		await server.close();
	}
});

test("context: a server that cannot answer the question is said so, and the collapse happens without it", async () => {
	const root = makeProject("context-refused", { git: false });
	const server = await startStandIn({ refuseAsides: true });
	try {
		const result = await carto(root, server, [], { input: "say: fine\n/collapse\nsay: after\n" });
		ok(result, "run");
		has(result.stdout, '! The question before the collapse got no answer (the server answered 400: {"error":{"message":"Cannot use a response format with tools."}}). The context is collapsed without it.', "the reason is shown");
		has(result.stdout, "◆ context collapsed (the user asked for it)", "collapsed all the same");
		has(result.stdout, "  the server could not read the new context ahead (the server answered 400: ", "and the read-ahead that failed is said, too");
		assert.deepEqual(server.requests.at(-1).messages.map((message) => message.role), ["system", "user", "user"]);
		has(result.stdout, "\nafter\n", "the next answer comes");
	} finally {
		await server.close();
	}
});

test("context: with readAhead off nothing is sent ahead; with no request made yet the question is skipped", async () => {
	const root = makeProject("context-no-ahead", { git: false });
	configure(root, { readAhead: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "say: fine\n/collapse\n" }), "run");
		assert.equal(server.asides.length, 1, "the question only");
		assert.notEqual(server.asides[0].response_format, undefined);
		// A second run that collapses before anything was sent: nothing to put the question behind.
		const again = await carto(root, server, [], { input: "/collapse\n" });
		ok(again, "second run");
		has(again.stdout, "◆ not asked before collapsing: carto has only just started", "said");
		has(again.stdout, "◆ context collapsed (the user asked for it)", "collapsed");
		assert.equal(server.asides.length, 1, "nothing more was sent");
	} finally {
		await server.close();
	}
});

test("context: a goal closing collapses the context in the middle of the turn, and the turn goes on", async () => {
	const root = makeProject("context-goal", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: `${ledgerMessage(GOAL)}\n${BULK}\n${ledgerMessage({ action: "done", id: "g1" })} || assess: Small and tidy. AFTER COLLAPSE: chat: Closed g1.\nsay: after\n` });
		ok(result, "run");
		has(result.stdout, "◆ context collapsed (goal g1 was closed): about ", "collapsed when the goal closed");
		// The request after the collapse: the prompt and one message, which ends the block with the calls just made.
		const index = server.requests.findIndex((request) => (frontOf(request) ?? "").includes("goal g1 was closed"));
		const first = server.requests[index];
		assert.deepEqual(first.messages.map((message) => message.role), ["system", "user"], "nothing but the block");
		const front = frontOf(first);
		has(front, "\n\nThis collapse came in the middle of your turn, so the turn goes on.\nThe calls of your last reply, all carried out, and what each returned:\n▸ ledger ", "the block says where the turn stands");
		has(front, "\ng1 closed. ", "with what the ledger returned");
		has(front, "\n▸ assess  15 characters\nAssessment saved (15 characters)", "and the other call of that reply");
		has(front, "\nGo on from here: do what is left of the turn, or end it.\n</context>", "and what to do");
		has(front, `[user · `, "the talk is there");
		has(front, "] ledger: [{\"action\":\"done\",\"id\":\"g1\"}] || assess: Small and tidy.", "with the message that began the turn");
		// The copy at the top was brought up to date by the same collapse.
		has(rawText(first.messages[1]), "Your assessment\nSmall and tidy.\n", "the assessment reaches the top");
		// The turn goes on in the new context: the agent's next reply follows the block.
		has(result.stdout, "\nClosed g1.\n", "the agent goes on and answers");
		const next = server.requests.at(-1);
		assert.deepEqual(next.messages.map((message) => message.role), ["system", "user", "assistant", "tool", "user"], "the block, the reply after it, the next message");
		assert.deepEqual(next.messages[1], stored(first)[1], "the block is sent again unchanged");
		// Asked once, and nothing read ahead: the turn was going on.
		assert.equal(server.asides.length, 1);
		assert.notEqual(server.asides[0].response_format, undefined);
		has(server.asides[0].messages.at(-1).content, "Your context is about to be collapsed (goal g1 was closed).", "the question names the reason");
		// The question came with the results of the reply that closed the goal.
		const asked = server.asides[0].messages.slice(-3);
		assert.deepEqual(asked.map((message) => message.role), ["tool", "tool", "user"]);
		has(asked[0].content, "g1 closed.", "the ledger's answer was in view for the question");
	} finally {
		await server.close();
	}
});

test("context: a goal closing with little in view collapses nothing", async () => {
	const root = makeProject("context-goal-small", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: `${ledgerMessage(GOAL)}\n${ledgerMessage({ action: "done", id: "g1" })}\nsay: after\n` });
		ok(result, "run");
		hasNot(result.stdout, "context collapsed", "nothing to gain");
		assert.equal(server.asides.length, 0, "and no question");
		assert.equal(frontOf(server.requests.at(-1)), undefined);
	} finally {
		await server.close();
	}
});

test("context: in the middle of a turn the agent that says yes gets one more reply before the collapse", async () => {
	const root = makeProject("context-goal-yes", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: `${ledgerMessage(GOAL)}\n${BULK}\n${ledgerMessage({ action: "done", id: "g1" })} ON COLLAPSE: ledger: [{"action":"add","kind":"note","text":"the port is 8080"}]\nsay: after\n` });
		ok(result, "run");
		// The result of the call that closed the goal says what comes.
		const told = server.requests.find((request) => rawText(request.messages.at(-1)).includes("your context will be collapsed after your next reply"));
		assert.ok(told, "it is told in the result");
		assert.match(messageText(told.messages.at(-1)), /^g1 closed\.[\s\S]*\n\nCartographer: your context will be collapsed after your next reply \(goal g1 was closed\), and you asked for a turn first\. /);
		has(result.stdout, "● ledger  + note n2  the port is 8080\n", "it uses the reply");
		const order = [result.stdout.indexOf("✓ goal g1"), result.stdout.indexOf("+ note n2"), result.stdout.indexOf("◆ context collapsed (goal g1 was closed)")];
		assert.ok(order[0] !== -1 && order[0] < order[1] && order[1] < order[2], `closed, written, collapsed: ${order}`);
		assert.equal(server.asides.length, 1, "asked once");
		const first = server.requests.find((request) => (frontOf(request) ?? "").includes("goal g1 was closed"));
		has(frontOf(first), "▸ ledger add note\nn2 added.", "the block ends with the reply it used");
		hasNot(frontOf(first), "your context will be collapsed after your next reply", "and without the notice");
	} finally {
		await server.close();
	}
});

test("context: while the agent works, its context is collapsed when it is nearly full", async () => {
	const root = makeProject("context-full", { git: false });
	// The fixed part of a request is about 8,500 tokens here; the limit is 60% of 16,000.
	configure(root, { contextWindow: 16000, chatWindow: 1000, shelfTokens: 1000, collapseFull: 60 });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: `${BULK}\nsay: after\n` });
		ok(result, "run");
		assert.match(result.stdout, /◆ context collapsed \(it held about \d\d% of what fits\): about [\d.,k]+ → [\d.,k]+ tokens · kept 0 task records, 0 shelf items, /, "collapsed for being full");
		const first = server.requests.find((request) => /it held about \d\d% of what fits/.test(frontOf(request) ?? ""));
		assert.deepEqual(first.messages.map((message) => message.role), ["system", "user"]);
		has(frontOf(first), "This collapse came in the middle of your turn, so the turn goes on.", "the turn goes on");
		has(frontOf(first), "\n▸ assess  8.4k characters", "with the call it had just made");
		has(result.stdout, "\nCollapsed, going on.\n", "and it does");
		// What is left is still more than the limit here, but nearly all of it is what a collapse keeps: no second one.
		assert.equal(result.stdout.split("◆ context collapsed").length - 1, 1, "a collapse that would free next to nothing is not made, however full the context");
		assert.equal(server.asides.filter((aside) => aside.response_format !== undefined).length, 1, "nor is the question asked again");
		has(result.stdout, "\nafter\n", "and the next message is answered");
	} finally {
		await server.close();
	}
});

test("context: a reply that ends the turn is not followed by a collapse in the turn; it comes at the rest after it", async () => {
	const root = makeProject("context-full-rest", { git: false });
	// The limit is 15,000 tokens: the first turn stays under it, the second passes it with a reply that only talks.
	configure(root, { contextWindow: 30000, chatWindow: 4000, shelfTokens: 1000, collapseFull: 50 });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: `${BULK}\nsay: ${"so much to say ".repeat(600).trim()}\nsay: after\n` });
		ok(result, "run");
		assert.equal(result.stdout.split("◆ context collapsed").length - 1, 1, "once");
		assert.match(result.stdout, /◆ asked before collapsing \(it held about \d\d% of what fits\): does it need to write something down first\? no · [\d.]+ s\n◆ context collapsed \(it held about \d\d% of what fits\): [^\n]*\n  read ahead by the server: /, "at rest: asked, collapsed, read ahead");
		const next = server.requests.at(-1);
		assert.deepEqual(next.messages.map((message) => message.role), ["system", "user", "user"]);
		hasNot(frontOf(next), "This collapse came in the middle of your turn", "the block does not claim a turn that is over");
		has(frontOf(next), "so much to say so much to say", "what was said is in the talk");
	} finally {
		await server.close();
	}
});

test("context: at rest the context is collapsed once enough would go, and not before", async () => {
	const root = makeProject("context-rest", { git: false });
	configure(root, { collapseTokens: 1500 });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: `say: one\ntask: list:\n${BULK}\nsay: after\n` });
		ok(result, "run");
		const lines = result.stdout.split("\n");
		const collapsed = lines.filter((line) => line.startsWith("◆ context collapsed"));
		assert.equal(collapsed.length, 1, `once: ${collapsed.join(" / ")}`);
		assert.match(collapsed[0], /^◆ context collapsed \(about [\d.,k]+ tokens of finished work were in view while it rested\): /, "the reason, said for the user");
		assert.ok(result.stdout.indexOf("◆ context collapsed") > result.stdout.indexOf("Report received: The assessment is"), "after the turn that made the work, not after the small ones");
		has(frontOf(server.requests.at(-1)), "tokens of finished work were in view while you rested). What you had in view", "the block says it to the agent");
		assert.deepEqual(server.requests.at(-1).messages.map((message) => message.role), ["system", "user", "user"]);
	} finally {
		await server.close();
	}
});

test("context: the shelf: a marked file changes nothing now, stands in the block from the next collapse, and every task begins with it read", async () => {
	const root = makeProject("context-shelf", { git: false });
	configure(root, { shelfTokens: 1000, chatWindow: 1000 });
	const server = await startStandIn();
	try {
		const shelve = (path, lines) => `context: ${JSON.stringify({ action: "shelve", path, ...(lines ? { lines } : {}) })}`;
		const result = await carto(root, server, [], {
			input: [
				shelve("src/math.js"),
				shelve("long.txt", "10-12"),
				shelve("long.txt"),
				shelve("nothing.js"),
				shelve("../outside.txt"),
				shelve("src"),
				shelve("long.txt", "ten"),
				"say: marked",
				"/collapse",
				"task: list:",
				'context: {"action":"unshelve","path":"long.txt"}',
				'context: {"action":"unshelve","path":"README.md"}',
				"say: after",
				"/context",
				"",
			].join("\n"),
		});
		ok(result, "run");
		has(result.stdout, "● context  shelved src/math.js · about ", "marked");
		has(result.stdout, "● context  shelved long.txt (lines 10-12) · about ", "a range of lines");
		// What is refused, and why.
		const tooLarge = server.requests.map((request) => messageText(request.messages.at(-1))).find((text) => text.startsWith("long.txt is about "));
		assert.match(tooLarge, /^long\.txt is about [\d,]+ tokens, and the shelf would then hold [\d,]+ of at most 1,000\. Shelve a range of lines instead, or take something off first: src\/math\.js\.$/, "too large for the shelf; a file has one place on it, so the range of the same file does not count");
		has(result.stdout, "● context  nothing done: long.txt is about ", "and shown as refused");
		has(result.stdout, "● context  nothing done: nothing.js does not exist. The tree in the state block shows the files.", "no such file");
		has(result.stdout, "● context  nothing done: ../outside.txt is outside the project", "outside the project");
		has(result.stdout, "● context  nothing done: src is a directory: the shelf holds files, or line ranges of files.", "a directory");
		has(result.stdout, '● context  nothing done: `lines` is a range like "10-80"; leave it out for the whole file.', "a bad range");

		// Marking changed nothing in view: the request after it holds the answer and no file text.
		const marked = server.requests.find((request) => messageText(request.messages.at(-1)).startsWith("say: marked"));
		assert.equal(frontOf(marked), undefined, "no block yet");
		hasNot(marked.messages.slice(0, -1).map(rawText).join("\n"), "MARKER-ONLY-IN-FILE", "the file is not in view yet");
		has(stateOf(marked), "\nContext\n", "the state block has a part on the context");
		has(stateOf(marked), "\nMarked for your shelf, in view from the next collapse on: src/math.js, long.txt (lines 10-12).\n", "which says what waits");
		assert.match(stateOf(marked), /\nYour context holds about [\d,]+ of 100,000 tokens\.\n/, "and how full it is");

		// From the collapse on the files stand in the block, with their line numbers.
		const task = taskRequests(server)[0];
		const front = frontOf(task);
		has(front, "\n\nYour shelf: 2 items, as the files were at the collapse\n== src/math.js (lines 1-4 of 4)\n1  export function add(a, b) {\n2    // MARKER-ONLY-IN-FILE\n3    return a + b;\n4  }\n== long.txt (lines 10-12 of 700)\n10  line 10\n11  line 11\n12  line 12\n", "the shelf, in the order it was filled");
		// The task began with it: its context is the main agent's, block included.
		assert.equal(task.messages[1].role, "user");
		assert.ok(rawText(task.messages[1]).includes(front), "the task's context begins with the same block");
		hasNot(stateOf(server.requests.at(-1)) ?? "", "Marked for your shelf", "nothing waits any more");

		// Taking something off: gone at the next collapse, and said until then.
		has(result.stdout, "● context  unshelved long.txt (lines 10-12)\n", "taken off");
		has(result.stdout, "● context  nothing done: README.md is not on your shelf. On it: src/math.js.", "what is not on it");
		has(stateOf(server.requests.at(-1)), "\nTaken off your shelf, gone from view at the next collapse: long.txt (lines 10-12).\n", "the state block says it");
		assert.deepEqual(contextStore(root).shelf, [{ path: "src/math.js" }]);
		// /context shows the shelf.
		assert.match(result.stdout, /\n    shelf +\d+   src\/math\.js, long\.txt \(lines 10-12\)\n/, "/context names what stands on it now");
		has(result.stdout, "\n  taken off the shelf, gone at the next collapse: long.txt (lines 10-12)\n", "and what leaves");
	} finally {
		await server.close();
	}
});

test("context: a shelved file that changed is said in the state block, and one that is gone leaves the shelf", async () => {
	const root = makeProject("context-shelf-changed", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: 'context: {"action":"shelve","path":"src/math.js"}\ncontext: {"action":"shelve","path":"src/main.js"}\n/collapse\n' }), "first run");
		writeFileSync(join(root, "src", "math.js"), "export const add = (a, b) => a + b;\n");
		const changed = await carto(root, server, [], { input: "say: one\n" });
		ok(changed, "second run");
		has(stateOf(server.requests.at(-1)), "\nChanged since your shelf was written, so the copy on the shelf is old: src/math.js.\n", "the change is said");
		has(frontOf(server.requests.at(-1)), "2    // MARKER-ONLY-IN-FILE", "the block itself is not rewritten: that would be read again in full");
		rmSync(join(root, "src", "main.js"));
		const gone = await carto(root, server, [], { input: "/collapse\nsay: two\n" });
		ok(gone, "third run");
		has(gone.stdout, "  taken off the shelf: src/main.js (the file is gone)\n", "the user is told");
		const front = frontOf(server.requests.at(-1));
		has(front, "\nYour shelf: 1 item, as the files were at the collapse\n== src/math.js (lines 1-1 of 1)\n1  export const add = (a, b) => a + b;\n(src/main.js was taken off the shelf: the file is gone.)\n", "the new block has the file as it is now, and says what left");
		hasNot(stateOf(server.requests.at(-1)) ?? "", "Changed since your shelf was written", "nothing is old now");
		assert.deepEqual(contextStore(root).shelf, [{ path: "src/math.js" }]);
	} finally {
		await server.close();
	}
});

test("context: the main agent can drop a report from view and get it back; notes of its own belong in the brain", async () => {
	const root = makeProject("context-drop", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], {
			input: ['task: read: src/math.js', 'context: {"action":"fold","id":"t1"}', "say: dropped", 'context: {"action":"fold","id":"t1"}', 'context: {"action":"recall","id":"t1"}', "say: back", 'context: {"action":"note","text":"remember"}', 'context: {"action":"fold"}', 'context: {"action":"fly"}', ""].join("\n"),
		});
		ok(result, "run");
		assert.match(result.stdout, /● context  dropped t1 · about \d+ tokens freed\n/);
		// In the request after the drop the report is one line; before it, it was there in full.
		const report = (request) => rawText(request.messages.find((message) => message.role === "tool" && /REPORT|dropped report/.test(rawText(message))));
		const dropped = server.requests.find((request) => messageText(request.messages.at(-1)).startsWith("say: dropped"));
		assert.match(report(dropped), /^\[You dropped report t1 from view\. Its record: t1 · [^\n]* · look · asked: read: src\/math\.js → == src\/math\.js \(lines 1-4 of 4\)\. `context` with action recall and t1 brings it back\.\]\n\n\[task ended /, "one line in its place");
		const answer = server.requests.find((request) => rawText(request.messages.at(-1)).startsWith("Dropped from view: t1, about "));
		assert.match(messageText(answer.messages.at(-1)), /^Dropped from view: t1, about \d+ tokens\. In its place stands the record line\. The server reads what follows again, about \d+ tokens\. Its record: t1 · /, "the answer says what it cost");
		has(result.stdout, "● context  nothing done: t1 is not in your context in full, so there is nothing to drop. No report is.", "twice is refused");
		// Recalled, it stands where it stood.
		has(result.stdout, "● context  recalled t1 · back in its place\n", "back");
		const back = server.requests.find((request) => messageText(request.messages.at(-1)).startsWith("say: back"));
		assert.match(report(back), /^REPORT\n== src\/math\.js \(lines 1-4 of 4\)\n\nThis report is kept as t1\./, "in full again, in the same place");
		assert.deepEqual(contextStore(root).dropped, []);
		// What the tool refuses.
		has(result.stdout, "● context  nothing done: A note of this kind is for a task's own steps. What you need after a collapse belongs in the ledger", "the main agent's notes go to the brain");
		has(result.stdout, "● context  nothing done: fold needs `id`: the report to drop from view, like t12.", "no id");
		has(result.stdout, 'refused: Validation failed for tool "book": - ops.0.action: expected one of ["add","edit","done","remove","before","cl…', "an unknown action is refused by the tool's schema");
	} finally {
		await server.close();
	}
});

test("context: the agent can collapse its own context; it is not asked first, since it chose the moment", async () => {
	const root = makeProject("context-own", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: 'say: one\ncontext: {"action":"collapse","text":"starting on the parser"} AFTER COLLAPSE: chat: Fresh.\nsay: after\n' });
		ok(result, "run");
		has(result.stdout, "● context  collapse asked for\n", "the call is shown");
		has(result.stdout, "◆ context collapsed (the agent asked for it: starting on the parser): about ", "and the collapse, in the user's words");
		assert.equal(server.asides.length, 0, "no question: it asked for this itself");
		const first = server.requests.find((request) => frontOf(request) !== undefined);
		has(frontOf(first), "Your context was collapsed on ", "collapsed");
		has(frontOf(first), " (you asked for it: starting on the parser). What you had in view", "the block says it in the agent's words");
		has(frontOf(first), '▸ context collapse starting on the parser\nYour context is collapsed when the calls of this reply are done. Your next request begins with what was kept.\nGo on from here', "with the call that asked");
		has(result.stdout, "\nFresh.\n", "the turn goes on");
	} finally {
		await server.close();
	}
});

test("context: a task tidies its own steps: marks on large results, a re-read replaces the older copy, drops, notes, and what the tool refuses", async () => {
	const root = makeProject("context-task", { git: false });
	const server = await startStandIn();
	try {
		const brief = ["read: long.txt @1+250", "read: src/math.js", "read: long.txt @1+250", 'context: {"action":"fold","id":"s1"}', 'context: {"action":"fold","id":"s3"}', 'context: {"action":"note","text":"line 7 is the one"}', 'context: {"action":"recall","id":"t1"}', 'context: {"action":"fold","id":"t1"}', "list:"].join("\\n");
		const result = await carto(root, server, [], { input: `say: before\ntask: ${brief}\n` });
		ok(result, "run");
		const requests = taskRequests(server);
		const main = mainRequests(server);
		const resultsIn = (request) => request.messages.slice(request.messages.findIndex((message) => rawText(message).startsWith("You are now the task")) + 1).filter((message) => message.role === "tool").map(rawText);
		// After the first read: the large result ends with its mark; the small one after it has none.
		assert.match(resultsIn(requests[1])[0], /^== long\.txt \(lines 1-250 of 700\)\n[\s\S]*\n250  line 250\n[^\n]*\n\n\[s1 · about [\d,]+ tokens\]/, "a large result names its id and size");
		assert.equal(withoutTail(resultsIn(requests[2])[1]), "== src/math.js (lines 1-4 of 4)\n1  export function add(a, b) {\n2    // MARKER-ONLY-IN-FILE\n3    return a + b;\n4  }", "a small one is as it was");
		// After the same lines were read again: the older copy is one line, the newer one stands in full.
		const again = resultsIn(requests[3]);
		assert.match(again[0], /^\[s1: An earlier read of the same lines stood here; the newer one is further down\. It was: read long\.txt from line 1, about [\d,]+ tokens\. Call again if you need it\.\]$/, "the older copy is replaced");
		assert.match(again[2], /^== long\.txt \(lines 1-250 of 700\)\n[\s\S]*\n\n\[s3 · about [\d,]+ tokens\]/, "the newer one is in full, under its own id");
		assert.match(result.stdout, /│ context fold s1 +→ refused: s1 is not a result in your view\. Your larger results: s3 \(read long\.txt from line 1, about [\d,]+ tokens\)\./, "what is gone already cannot be dropped");
		// Dropped by the task itself.
		assert.match(result.stdout, /│ context fold s3 +→ dropped s3 · about [\d,]+ tokens freed\n/);
		const after = resultsIn(requests.at(-1));
		assert.match(after[2], /^\[s3: You dropped this result\. It was: read long\.txt from line 1, about [\d,]+ tokens\. Call again if you need it\.\]$/, "one line in its place");
		assert.match(after[4], /^Dropped: s3, about [\d,]+ tokens\. The server reads what follows again, about [\d,]+ tokens\.$/, "and the answer says what it cost");
		assert.match(result.stdout, /│ context note line 7 is the one +→ noted · 17 characters\n/);
		// A task has no reports to recall or drop.
		assert.match(result.stdout, /│ context recall t1 +→ refused: There is no report t1\. No report is kept yet\./);
		assert.match(result.stdout, /│ context fold t1 +→ refused: t1 is not a result in your view\./);
		// Nothing before the brief was touched: the task's requests begin with the main agent's, to the letter.
		const before = stored(main[1]).slice(0, -1);
		for (const request of requests) assert.deepEqual(request.messages.slice(0, before.length), before, "what precedes the brief is the main agent's context, unchanged");
		// When the task ends, what it kept for itself is forgotten.
		assert.deepEqual(contextStore(root).tasks, {});
	} finally {
		await server.close();
	}
});

test("context: a task's steps are collapsed when its context is nearly full, after it was asked; its notes, shelf and calls stay", async () => {
	const root = makeProject("context-task-full", { git: false });
	configure(root, { contextWindow: 12000, chatWindow: 2000, shelfTokens: 2000, collapseFull: 60 });
	const server = await startStandIn();
	try {
		const reads = [1, 201, 401, 101, 301, 151, 351].map((from) => `read: long.txt @${from}+200`);
		const brief = ['context: {"action":"shelve","path":"src/math.js"}', 'context: {"action":"note","text":"the answer is in long.txt"}', ...reads, "list:"].join("\\n");
		const result = await carto(root, server, [], { input: `task: ${brief}\n` });
		ok(result, "run");
		assert.match(result.stdout, /│ ◆ asked before collapsing \(its context held about \d\d% of what fits\): does it need to write something down first\? no · [\d.]+ s\n│ ◆ the task's steps collapsed \(its context held about \d\d% of what fits\): \d+ replies with \d+ calls, now one block of notes\n/, "asked, then collapsed");
		const requests = taskRequests(server);
		const at = requests.findIndex((request) => request.messages.some((message) => message.role === "user" && rawText(message).includes("so your steps up to here")));
		assert.ok(at > 0, "a request carries the block");
		const collapsed = requests[at];
		const briefAt = collapsed.messages.findIndex((message) => rawText(message).startsWith("You are now the task"));
		assert.deepEqual(collapsed.messages.slice(0, briefAt + 1), stored(requests[at - 1]).slice(0, briefAt + 1), "everything up to the brief is unchanged");
		assert.deepEqual(collapsed.messages.slice(briefAt + 1).map((message) => message.role), ["user"], "after the brief: the block, and nothing else");
		const block = rawText(collapsed.messages.at(-1));
		assert.match(block, /^<cartographer>\nWritten by Cartographer, not by the user\. Your context held about \d\d% of what fits, so your steps up to here \(\d+ replies, \d+ calls\) were collapsed: their results are no longer in view\. You are still the task, and the brief above still holds\. What you kept:\n\nYour notes\n- the answer is in long\.txt\n\nYour calls so far \(call again for a result you need\)\ns1 context shelve src\/math\.js → /, "the block: why, the notes, the calls");
		has(block, "\ns3 read long.txt from line 1 → == long.txt (lines 1-200 of 700)\n", "one line per call");
		has(block, "\n\nYour shelf: 1 item, as the files are now\n== src/math.js (lines 1-4 of 4)\n1  export function add(a, b) {\n", "the shelf, in full");
		has(block, "\n\nGo on with the brief from here. Your final message is still the report.\n</cartographer>", "and what to do");
		hasNot(block, "line 150\n", "no result text");
		// The task goes on with the brief, and reports.
		has(result.stdout, "→ project: 5 files\n", "the last step of the brief is done");
		has(result.stdout, "◂ report t1  ", "and it reports");
		// The question was put behind the task's own last request.
		const question = server.asides.find((aside) => aside.response_format !== undefined);
		has(question.messages.at(-1).content, "so your steps since the brief are about to be collapsed", "the task's question");
		assert.deepEqual(question.messages.slice(0, requests[at - 1].messages.length), requests[at - 1].messages, "behind the request the server has read");
		// The main agent's shelf got nothing: the task did not hand it on.
		assert.deepEqual(contextStore(root).shelf, []);
		hasNot(result.stdout, "◂ shelf", "nothing is said about the shelf");
	} finally {
		await server.close();
	}
});

test("context: a task that says yes before its steps collapse gets one reply to note what it needs", async () => {
	const root = makeProject("context-task-yes", { git: false });
	configure(root, { contextWindow: 19000, chatWindow: 2000, shelfTokens: 2000, collapseFull: 60 });
	const server = await startStandIn();
	try {
		const reads = [1, 201, 401, 101, 301, 151, 351].map((from) => `read: long.txt @${from}+200`);
		// (The stand-in counts the reply in which it notes as a line of the brief, so one line is passed over at the
		// collapse: `list:` stands twice.)
		const result = await carto(root, server, [], { input: `task: ${[...reads, "list:", "list:", "ON COLLAPSE"].join("\\n")}\n` });
		ok(result, "run");
		has(result.stdout, "does it need to write something down first? yes · ", "it says yes");
		const requests = taskRequests(server);
		const told = requests.find((request) => rawText(request.messages.at(-1)).includes("Your steps will be collapsed after this reply"));
		assert.ok(told, "it is told, at the end of one request");
		assert.equal(requests.filter((request) => request.messages.some((message) => rawText(message).includes("Your steps will be collapsed after this reply"))).length, 1, "and only that one");
		assert.match(result.stdout, /│ context note NOTED [^\n]*→ noted · \d+ characters\n│ ◆ the task's steps collapsed /, "it notes, then the collapse");
		const collapsed = requests.find((request) => request.messages.some((message) => message.role === "user" && rawText(message).includes("so your steps up to here")));
		has(rawText(collapsed.messages.at(-1)), "\nYour notes\n- NOTED == long.txt (lines ", "the note is in the block");
		assert.equal(server.asides.filter((aside) => aside.response_format !== undefined).length, 1, "asked once");
		has(result.stdout, "→ project: 5 files\n", "the brief is finished");
	} finally {
		await server.close();
	}
});

test("context: a task can collapse its own steps, and can hand a shelved file on to the main agent", async () => {
	const root = makeProject("context-task-own", { git: false });
	const server = await startStandIn();
	try {
		const brief = ["read: long.txt @1+250", 'context: {"action":"shelve","path":"src/math.js","hand_on":true}', 'context: {"action":"shelve","path":"src/main.js"}', 'context: {"action":"collapse","text":"done reading"}', "list:"].join("\\n");
		const result = await carto(root, server, [], { input: `task: ${brief}\nsay: next\n/collapse\nsay: after\n` });
		ok(result, "run");
		assert.match(result.stdout, /│ context shelve src\/math\.js +→ shelved src\/math\.js · about \d+ tokens · handed on to the main agent at the end\n/);
		has(result.stdout, "│ ◆ the task's steps collapsed (it asked for it (done reading)): 4 replies with 4 calls, now one block of notes\n", "collapsed at its own word");
		assert.equal(server.asides.filter((aside) => aside.response_format !== undefined && /steps since the brief/.test(aside.messages.at(-1).content)).length, 0, "it is not asked: it chose the moment");
		const block = rawText(taskRequests(server).at(-1).messages.find((message) => message.role === "user" && rawText(message).includes("steps up to here")));
		has(block, "You asked for it (done reading), so your steps up to here (4 replies, 4 calls) were collapsed", "the block says why");
		has(block, "Your shelf: 2 items, as the files are now\n== src/math.js (lines 1-4 of 4)", "both shelved files stay in the task's view");
		has(block, "== src/main.js (lines 1-2 of 2)", "also the one it keeps to itself");
		// At the end: only what it handed on goes to the main agent's shelf, and the report says so.
		has(result.stdout, "◂ shelf  the task added src/math.js  (/context shows the shelf)\n", "the user is told");
		const main = mainRequests(server);
		const report = main.find((request) => rawText(request.messages.at(-1)).startsWith("REPORT"));
		has(messageText(report.messages.at(-1)), "\n\nThe task put on your shelf: src/math.js. In view from the next collapse on.\n\nThis report is kept as t1.", "the agent is told under the report");
		assert.deepEqual(contextStore(root).shelf, [{ path: "src/math.js" }], "handed on: one of the two");
		// And from the next collapse on it is in view.
		has(frontOf(server.requests.at(-1)), "Your shelf: 1 item, as the files were at the collapse\n== src/math.js (lines 1-4 of 4)\n", "in the block");
		hasNot(frontOf(server.requests.at(-1)), "== src/main.js", "the other is not");
	} finally {
		await server.close();
	}
});

test("context: the talk a collapse keeps is held to chatWindow; what the agent wrote for itself is never in it", async () => {
	const root = makeProject("context-talk", { git: false });
	configure(root, { chatWindow: 500 });
	const server = await startStandIn();
	try {
		const long = (word) => `say: ${`${word} `.repeat(160)}`.trim();
		const result = await carto(root, server, [], { input: `${long("first")}\nthink then chat: a private thought\n${long("second")}\n/collapse\nsay: after\n` });
		ok(result, "run");
		const front = frontOf(server.requests.at(-1));
		hasNot(front, "first first", "the oldest talk is gone");
		has(front, "second second", "the newest is kept");
		has(front, "Your talk with the user, word for word; what was said before it is gone\n", "and the block says that there was more");
		// The note that follows a reply without a call, and the agent's plain text, are not talk.
		hasNot(front, "Your last message had no tool call", "Cartographer's notes are not talk");
		const talk = contextStore(root).chat;
		assert.ok(talk.every((entry) => entry.who === "user" || entry.who === "you"));
		assert.ok(talk.reduce((sum, entry) => sum + Math.ceil(entry.text.length / 4), 0) <= 500, "within the window");
		assert.equal(talk.at(-1).who, "you");
	} finally {
		await server.close();
	}
});

test("context: the question is asked with tool_choice none; a server that refuses the form of the answer is asked without it from then on", async () => {
	const root = makeProject("context-fallback", { git: false });
	configure(root, { collapseTokens: 500 });
	const server = await startStandIn({ refuseSchema: true });
	try {
		const work = `task: read: long.txt @1+200`;
		const result = await carto(root, server, [], { input: lines(ledgerMessage(GOAL), work, "/collapse", work, "/collapse") });
		ok(result, "a session on a server that refuses the schema");
		assert.ok(server.asides.length >= 3, `the question was sent: ${server.asides.length} requests on the side`);
		const questions = server.asides.filter((aside) => aside.max_tokens === 16);
		for (const aside of questions) assert.equal(aside.tool_choice, "none", "every question says that no tool can be the answer");
		for (const aside of questions) assert.ok(aside.tools.length === 14 && aside.return_progress === undefined, "and carries the tools as the prompt had them, and nothing else");
		assert.deepEqual(questions.map((aside) => aside.response_format !== undefined), [true, false, false], `the form of the answer is tried once, then left out:\n${JSON.stringify(questions.map((aside) => Object.keys(aside)))}`);
		assert.equal(result.stdout.split("the model server refused the form the answer must have").length - 1, 1, `the user is told once:\n${result.stdout}`);
		has(result.stdout, "does it need to write something down first? no · ", "and the question is answered all the same");
	} finally {
		await server.close();
	}
});

test("context: /context shows the parts and their sizes, /new starts with nothing in view, and the tools are fifteen flat objects", async () => {
	const root = makeProject("context-view", { git: false });
	const server = await startStandIn();
	try {
		const result = await carto(root, server, [], { input: "/context\ntask: list:\n/context\n/collapse\n/context\n/new\nsay: fresh\n/context\n" });
		ok(result, "run");
		const views = result.stdout.split("  The agent's context: ").slice(1);
		assert.equal(views.length, 4);
		assert.match(views[0], /^of 100k tokens, not measured yet \(nothing has been sent in this run of carto yet; the parts below are estimates, without the prompt and the tools\)\n    fixed +\?   the prompt and the tools; never changes\n/, "before anything was sent");
		has(views[0], "    work          0   nothing since the start\n", "nothing yet");
		assert.match(views[1], /^about [\d.,k]+ of 100k tokens \(the server's count for the last answer; the parts below are estimates\)\n    fixed +[\d.,k]+   the prompt and the tools; never changes\n    top +\d+   the assessment and the graph, as copied at the last collapse\n    kept +0   nothing yet: the context has not been collapsed\n    work +\d+   \d+ messages since the start; a collapse frees about \d+\n    state +\d+   the state block, written anew for every request\n  kept reports: 1 \(t1 to t1\); the newest:\n    t1 · [^\n]* · look · asked: list: → project: 5 files\n  next: while the agent rests, once 10k tokens would go or you have been away 5 m; when a goal closes; while it works, at 80k tokens\. \/collapse does it now\.\n/, "before a collapse");
		assert.match(views[2], /\n    record +\d+   1 finished task, one line each\n    shelf +0   empty\n    talk +\d+   2 messages between you and the agent, of at most 8\.0k tokens\n    work +0   nothing since the last collapse\n/, "after it");
		assert.match(views[2], /\n  last collapse: [^\n]* \(the user asked for it\), about [\d.,k]+ → [\d.,k]+ tokens\n/);
		// /new: nothing in view, the reports stay on disk.
		const fresh = server.requests.at(-1);
		assert.deepEqual(fresh.messages.map((message) => message.role), ["system", "user"], "a fresh context");
		assert.equal(frontOf(fresh), undefined, "without a block");
		const store = contextStore(root);
		assert.deepEqual([store.records.length, store.chat.length, store.shelf.length, store.front], [0, 2, 0, undefined], "the record and the shelf are empty; the talk begins again");
		assert.ok(existsSync(join(root, ".atlas", "reports", "t1.md")), "the report is still on disk");
		assert.equal(store.next, 2, "and ids are not reused");
		// The tools: one more, and each a flat object (a schema with a choice at its root breaks tool calls on llama.cpp with Qwen).
		assert.deepEqual(fresh.tools.map((tool) => tool.function.name).sort(), ["ask", "atlas", "book", "chat", "edit", "list", "read", "return", "search", "shell", "sleep", "task", "wake", "write"]);
		for (const tool of fresh.tools) assert.equal(tool.function.parameters.anyOf ?? tool.function.parameters.oneOf, undefined, `${tool.function.name} is a flat object`);
		const book = fresh.tools.find((tool) => tool.function.name === "book").function.parameters;
		assert.equal(book.type, "object");
		assert.equal(book.anyOf ?? book.oneOf, undefined);
		assert.deepEqual(book.required, ["book"]);
		assert.deepEqual(Object.keys(book.properties).sort(), ["book", "ops", "text"]);
		assert.deepEqual(book.properties.book.enum, ["ledger", "plan", "prompt", "books", "context"]);
	} finally {
		await server.close();
	}
});

test("context: on a terminal the context is collapsed while the prompt waits, and typing stops the read-ahead", async () => {
	const root = makeProject("context-terminal", { git: false });
	// 0.02 minutes away is enough; a slow read-ahead, so that typing can interrupt it.
	configure(root, { collapseMinutes: 0.02 });
	const server = await startStandIn({ asideDelayMs: 1500 });
	try {
		ok(await carto(root, server, [], { input: "" }), "the brain is set up");
		const result = await cartoOnTerminal(root, server, [], [
			["Type a message", BULK],
			["context collapsed (the user had been away for 1 s)", "say: here again"],
			[2, "/quit"],
		]);
		if (result === undefined) return "python3 is needed for a terminal";
		assert.match(result.screen, /◆ asked before collapsing \(the user had been away for 1 s\): does it need to write something down first\? no · [\d.]+ s\n◆ context collapsed \(the user had been away for 1 s\): about /, "collapsed with nobody typing");
		hasNot(result.screen, "read ahead by the server", "the read-ahead was stopped by the message, and nothing is said about it");
		hasNot(result.screen, "could not read the new context ahead", "nor is it called a failure");
		const next = mainRequests(server).at(-1);
		assert.deepEqual(next.messages.map((message) => message.role), ["system", "user", "user"], "the message goes out in the collapsed context");
		has(frontOf(next), "(the user had been away for 1 s)", "which says why");
		assert.equal(server.asides.filter((aside) => aside.max_tokens === 1).length, 1, "one read-ahead was begun");
	} finally {
		await server.close();
	}
});

test("context: on a terminal the read-ahead is said when it is done, and the prompt comes back", async () => {
	const root = makeProject("context-terminal-ahead", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "" }), "the brain is set up");
		const result = await cartoOnTerminal(root, server, [], [
			["Type a message", "say: one"],
			["read for this answer", "/collapse"],
			["so the next answer starts at once", "say: two"],
			[2, "/quit"],
		]);
		if (result === undefined) return "python3 is needed for a terminal";
		assert.match(result.screen, /◆ context collapsed \(the user asked for it\)[^\n]*\n[^\n]*read ahead by the server: [\d.,k]+ tokens in [\d.]+ s, so the next answer starts at once\n/, "said when done");
		const ahead = server.asides.find((aside) => aside.max_tokens === 1);
		const next = mainRequests(server).at(-1);
		assert.deepEqual(ahead.messages, next.messages.slice(0, 2), "and what was read is what the next request begins with");
	} finally {
		await server.close();
	}
});

// ─── Runner ──────────────────────────────────────────────────────────────────

// ─── The full screen ────────────────────────────────────────────────────────

test("screen: text is measured in cells, wrapped and painted to the width; a repeating tail is told from ordinary text", async () => {
	const { cut, fit, paint, repeats, short, span, width, wrap } = await import("../src/screen/text.mjs");
	assert.deepEqual([width("abc"), width("日本"), width("e\u0301"), width("│ ✓")], [3, 4, 1, 3], "wide characters take two cells, a combining mark none");
	assert.equal(fit("日本語", 5), "日本", "a wide character is not cut in half");
	assert.equal(cut("abcdefgh", 5), "abcd…");
	assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"], "breaks at spaces");
	assert.deepEqual(wrap("  indented text that is long", 14), ["  indented", "  text that is", "  long"], "keeps the indent");
	assert.deepEqual(wrap("abcdefghijkl", 5), ["abcde", "fghij", "kl"], "a word longer than a row is cut");
	assert.deepEqual(wrap("a\n\nb", 10), ["a", "", "b"], "line breaks stay");
	assert.equal(paint([["ab", "bold"], ["cdef", ""]], 4), "\x1b[1mab\x1b[0mcd", "a line is cut to the width");
	assert.equal(paint([["ab", ""]], 5), "ab   ", "and padded to it");
	assert.equal(paint([["a\x1b[31mb\tc\n", ""]], 8), "ab    c ", "what a terminal would act on is taken out");
	assert.deepEqual([short(950), short(1234), short(27_300)], ["950", "1.2k", "27k"]);
	assert.deepEqual([span(4000), span(75_000), span(3_700_000)], ["4s", "1m 15s", "1h 01m"]);

	assert.deepEqual(repeats(`fine ${"a".repeat(90)}`), { unit: "a", times: 90 }, "one character about eighty times");
	assert.equal(repeats(`fine ${"a".repeat(40)}`), undefined, "forty is not enough");
	assert.equal(repeats(`heading\n${"-".repeat(120)}`), undefined, "a rule is made of one character and is no fault");
	assert.equal(repeats(`${" ".repeat(200)}`), undefined, "nor is white space");
	assert.deepEqual(repeats("ha ".repeat(30)), { unit: "ha ", times: 27 }, "a short phrase, eighty characters of it");
	assert.deepEqual([repeats("I will now read the file. ".repeat(9))?.unit.length, repeats("I will now read the file. ".repeat(9))?.times], [26, 8], "a longer phrase eight times");
	assert.equal(repeats("ha ".repeat(20)), undefined, "twenty times a short one is not enough");
	assert.equal(repeats(`const row = [${"0, ".repeat(24)}0];`), undefined, "a row of zeros in code is no fault");
	assert.equal(repeats(`x ${"0".repeat(40)}`), undefined, "nor a long number");
	assert.equal(repeats(`${"| --- ".repeat(12)}|`), undefined, "the rule of a table is no fault");
	assert.equal(repeats("The plan has three items. The first reads the file. The second writes the roller. The third runs it."), undefined, "ordinary text");
	assert.equal(repeats("x".repeat(30) + "the same the same "), undefined);
});

test("screen: keys are named for the commands mode, and several lines that arrive at once are taken as pasted", async () => {
	const { createPasteWatch, isPaste, keyOf } = await import("../src/screen/keys.mjs");
	// A key that types a character is that character, however the terminal sent it; any other key has pi-tui's name.
	assert.deepEqual(["j", "G", "+", " ", "?", "é"].map(keyOf), ["j", "G", "+", " ", "?", "é"], "typed characters, as the older terminals send them");
	assert.deepEqual(["\x1b[106u", "\x1b[103:71;2u", "\x1b[61:43;2u", "\x1b[32u"].map(keyOf), ["j", "G", "+", " "], "and as the Kitty keyboard protocol does, with the shifted character it reports");
	assert.deepEqual(["\x1b", "\r", "\t", "\x1b[Z", "\x04", "\x15", "\x1b[5~", "\x1b[A", "\x7f", "\x1bOP", "\x1b5", "\x1bj", "\x1b[27u", "\x1b[13;2u"].map(keyOf), ["escape", "enter", "tab", "shift+tab", "ctrl+d", "ctrl+u", "pageUp", "up", "backspace", "f1", "alt+5", "alt+j", "escape", "shift+enter"], "the other keys by name");
	assert.deepEqual([isPaste("\x1b[200~two\nlines\x1b[201~"), isPaste("two")], [true, false], "text the terminal marks as pasted");

	// A terminal that does not mark what it pastes: the lines come as if typed, all in one read.
	const watch = createPasteWatch();
	const through = (chunk) => {
		watch.read(chunk);
		// pi-tui hands the read over key by key.
		return [...chunk].map((key) => watch.lineEnd(key) ?? key).join("|");
	};
	assert.equal(through("one\rtwo\rthree"), "o|n|e|break|t|w|o|break|t|h|r|e|e", "line ends inside one read break the line, and send nothing");
	assert.equal(through("say: hi\r"), "s|a|y|:| |h|i|\r", "one line and its end is typing: the Enter is an Enter");
	assert.equal(through("one\r\ntwo\r\n"), "o|n|e|break|skip|t|w|o|\r|\n", "a line end of two characters is one; the end of the read is left alone");
	assert.equal(through("\r"), "\r", "Enter alone");
	assert.equal(through("\x1b[200~a\rb\x1b[201~").includes("break"), false, "what is marked as pasted is pi-tui's to handle");
	assert.equal(through("x"), "x");
	watch.read("a\rb");
	watch.read("c");
	assert.equal(watch.lineEnd("\r"), undefined, "a later read forgets the earlier one");
});

test("screen: the Chat tab folds the agent's work into one line, opens it to a line per call, and shows what is being written", async () => {
	const { createChat, homeOf } = await import("../src/screen/chat.mjs");
	let clock = 1000;
	const chat = createChat({ now: () => clock });
	const text = (cols = 80) => chat.lines(cols).map((line) => line.spans.map(([part]) => part).join("")).join("\n");
	const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
	const reply = (content, stamp) => ({ model: [{ role: "assistant", content, timestamp: stamp }] });
	const result = (id, name, body, extra = {}) => ({ model: [{ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: body }], ...extra }] });

	chat.user("Look at the roller");
	chat.entry(0, reply([{ type: "text", text: "I should look first." }, call("c1", "task", { brief: "Read the roller" })], 1));
	chat.entry(1, reply([call("c2", "read", { paths: ["roll.py"] }), call("c3", "search", { pattern: "seed" })], 2));
	clock += 3000;
	// The run that is going on is open by itself.
	has(text(), "▾ 3 calls · task · 3s\n  ┊ I should look first.\n  … task  Read the roller  3s\n  │ … read roll.py  3s\n  │ … search /seed/", "while it runs, the run is open");
	assert.deepEqual(chat.doing(), { what: "search /seed/", depth: 1, task: "task" }, "and the strip can say what runs now");
	chat.entry(1, result("c2", "read", "== roll.py (lines 1-2 of 2)\n1  import random\n2  print(1)"));
	chat.entry(1, result("c3", "search", "no match for seed", { isError: true }));
	chat.entry(1, reply([call("c4", "return", { report: "It rolls one die.", done: true })], 3));
	chat.entry(1, result("c4", "return", "Returned. The task has ended."));
	chat.entry(0, result("c1", "task", "It rolls one die.", { details: { report: "t1" } }), "◂ report t1  17 characters  (/report shows it)\n");
	chat.entry(0, reply([call("c5", "chat", { text: "It rolls one die." })], 4));
	clock += 60_000;
	has(text(), "› Look at the roller\n\n▸ 3 calls · t1 · 3s · 1 failed\n◂ report t1  17 characters  (/report shows it)\n\nIt rolls one die.", "once something is said, the run is one line, with how many calls, which task and how long");
	hasNot(text(), "read roll.py", "its calls are folded away");
	hasNot(text(), "return", "`return` is not a call to show: the report line stands for it");

	// Opened: a line per call, and a call opens to what it returned.
	const run = chat.lines(80).find((line) => line.kind === "group");
	chat.toggle(run.item);
	has(text(), "▾ 3 calls · t1 · 3s · 1 failed\n  ┊ I should look first.\n  ✓ task  Read the roller  → report t1\n  │ ✓ read roll.py  → 3 lines\n  │ ✗ search /seed/  → refused: no match for seed", "opened, each call is a line with how it ended");
	const read = chat.lines(80).find((line) => line.kind === "call" && line.spans.some(([part]) => part.includes("read roll.py")));
	chat.toggleRow(read.item, read.row);
	has(text(), "│ ✓ read roll.py  → 3 lines\n  │   == roll.py (lines 1-2 of 2)\n  │   1  import random\n  │   2  print(1)", "a call opens to its result, in place");
	assert.deepEqual([homeOf("write"), homeOf("shell"), homeOf("plan"), homeOf("read")], [{ tab: "diff" }, { tab: "shells" }, { tab: "carto", view: "plan" }, undefined], "a write lives in Diff, a command in Shells, the plan in Carto; a read opens where it stands");

	// With the notes hidden, the note rows are gone and the calls stay.
	chat.setThinking(false);
	hasNot(text(), "I should look first.", "Ctrl-T hides the notes");
	has(text(), "✓ task  Read the roller", "and nothing else");
	chat.setThinking(true);

	// What is being written now is shown as it grows: notes, a message, the arguments of a call.
	chat.user("Write it");
	chat.live(0, { timestamp: 9, content: [{ type: "thinking", thinking: "The file needs a seed." }, call("c9", "task", { brief: "Add a seed\nto the roller" })] });
	has(text(), "┊ The file needs a seed.\n✎ task  Add a seed to the roller\n  │ Add a seed\n  │ to the roller", "the call being written is open, with what it holds so far");
	assert.equal(chat.doing().what, "writing task Add a seed to the roller");
	chat.live(0, { timestamp: 9, content: [call("c9", "chat", { text: "Half a sen" })] });
	has(text(), "› Write it\n\nHalf a sen", "a message to the user appears as it is written");
	assert.equal(chat.doing().what, "writing to you");
	chat.live(0, { timestamp: 9, content: [{ type: "text", text: "no ".repeat(30) }] });
	assert.equal(chat.stuck()?.unit, "no ", "a reply that repeats itself is noticed while it is written");
	chat.live(0, undefined);
	hasNot(text(), "Half a sen", "and gone when the reply is done");

	// What Cartographer prints is one block until something else comes.
	chat.print("● plan  authorized by you\n");
	chat.print("  p1 Write it\n");
	has(text(), "● plan  authorized by you\n  p1 Write it", "printed text stands as printed");

	const transcript = chat.transcript({ title: "T" });
	has(transcript, "# T\n\n## You\n\nLook at the roller\n\n- _note:_ I should look first.\n- `task  Read the roller` → report t1\n  - `read roll.py` → 3 lines\n  - `search /seed/` → refused: no match for seed (failed)\n\n```text\n◂ report t1  17 characters  (/report shows it)\n```\n\n## Cartographer\n\nIt rolls one die.\n", "the session as Markdown: what was said in full, a line for each call");
	assert.equal(chat.lastAgent(), "It rolls one die.");
});

test("screen: the palette is made for the terminal's background: levels of text, one strength for every hue, blocks a step away", async () => {
	const { colorMode, makeTheme, markdownTheme, parseColorReply, schemeFromEnv, schemeOf, to256, HUES } = await import("../src/screen/theme.mjs");
	const { colorToOklch, rgbColor } = await import("@earendil-works/pi-tui");
	const light = ([r, g, b]) => (r * 299 + g * 587 + b * 114) / 1000;
	const far = (a, b) => Math.abs(light(a) - light(b));
	for (const given of [{}, { scheme: "light" }, { background: [0, 43, 54], foreground: [131, 148, 150] }, { background: [253, 246, 227], foreground: [101, 123, 131] }]) {
		const theme = makeTheme({ mode: "truecolor", ...given });
		const { rgb } = theme;
		const what = JSON.stringify(given);
		assert.equal(theme.scheme, given.background ? schemeOf(given.background) : (given.scheme ?? "dark"), `dark or light as the background is: ${what}`);
		// How much it matters: plain text is furthest from the background, then muted, then faint.
		assert.ok(far(rgb.fg, rgb.bg) > far(rgb.muted, rgb.bg) && far(rgb.muted, rgb.bg) > far(rgb.faint, rgb.bg) && far(rgb.faint, rgb.bg) > 25, `three levels of text, each nearer the background and none lost in it: ${what}`);
		// Whose it is: the hues differ, their lightness and strength do not.
		const hues = ["user", "tool", "ok", "warn", "err"].map((name) => colorToOklch(rgbColor(...rgb[name])));
		const lightness = hues.map((hue) => hue.l);
		assert.ok(Math.max(...lightness) - Math.min(...lightness) < 0.06, `every hue has the same lightness, so none is louder by accident: ${what} ${lightness.map((value) => value.toFixed(2))}`);
		assert.ok(hues.every((hue) => hue.c > 0.07), `and each is a colour, not a grey: ${what}`);
		assert.ok(Math.abs(hues[0].h - HUES.user) < 12 && Math.abs(hues[1].h - HUES.tool) < 12, `the hues are the ones named: ${what}`);
		// Where it is: every block is near the background, in its own direction, and all of them tell apart.
		const blocks = ["bgUser", "bgTool", "bgPanel", "bgInput", "bgBar", "bgSel"];
		for (const name of blocks) assert.ok(far(rgb[name], rgb.bg) < 70, `${name} stays near the background: ${what}`);
		assert.equal(new Set(blocks.map((name) => rgb[name].join())).size, blocks.length, `each block has a background of its own: ${what}`);
		assert.ok(far(rgb.bgSel, rgb.bg) > far(rgb.bgUser, rgb.bg) && far(rgb.bgUser, rgb.bg) > far(rgb.bgTool, rgb.bg), `what is selected stands out most, what you said more than what the tools did: ${what}`);
		assert.ok(far(rgb.bgBar, rgb.bg) > far(rgb.bgPanel, rgb.bg) && far(rgb.bgPanel, rgb.bg) > far(rgb.bgInput, rgb.bg), `the more a thing is chrome, the further from the background: ${what}`);
		// Text stays readable on every block.
		for (const name of blocks) assert.ok(far(rgb.fg, rgb[name]) > 0.65 * far(rgb.fg, rgb.bg), `plain text stands out on ${name} nearly as it does on the background: ${what}`);
		const blue = (color) => color[2] - (color[0] + color[1]) / 2;
		assert.ok(blue(rgb.bgUser) > blue(rgb.bg) && blue(rgb.bgUser) > blue(rgb.bgBar), `a block has the tint of its hue (yours is blue): ${what}`);
	}
	const exact = makeTheme({ mode: "truecolor" }).styles;
	assert.match(exact.bgTool, /^48;2;\d+;\d+;\d+$/, "a background, in exact colour");
	assert.match(exact.muted, /^38;2;\d+;\d+;\d+$/, "a text colour");
	assert.match(exact.chip, /^48;2;[\d;]+;38;2;[\d;]+;1$/, "the mode's name is filled and bold: the one saturated shape");
	const near = makeTheme({ mode: "256" }).styles;
	assert.match(near.bgTool, /^48;5;\d+$/, "with 256 colours, the nearest of them");
	assert.notEqual(near.bgSel, near.bgTool, "which still tells what is selected from a block");
	assert.equal(makeTheme({ mode: "none" }).styles, undefined, "without colours there is no palette: the terminal's sixteen are used");
	assert.deepEqual([to256(0, 0, 0), to256(255, 255, 255), to256(128, 128, 128), to256(255, 0, 0)], [16, 231, 244, 196]);
	assert.deepEqual(parseColorReply("11;rgb:1e1e/1e1e/2e2e"), { target: "background", rgb: [30, 30, 46] }, "what the terminal answers about its background");
	assert.deepEqual(parseColorReply("10;rgb:ff/80/00"), { target: "foreground", rgb: [255, 128, 0] });
	assert.equal(parseColorReply("52;c;abc"), undefined);
	assert.deepEqual([colorMode("auto", { COLORTERM: "truecolor" }), colorMode("auto", { TERM: "xterm-256color" }), colorMode("auto", { TERM: "xterm" }), colorMode("auto", { COLORTERM: "truecolor", NO_COLOR: "1" }), colorMode("256", { COLORTERM: "truecolor" })], ["truecolor", "256", "none", "none", "256"], "how many colours: what the terminal says, NO_COLOR, or the setting");
	assert.deepEqual([schemeFromEnv({ COLORFGBG: "0;15" }), schemeFromEnv({ COLORFGBG: "15;0" }), schemeFromEnv({})], ["light", "dark", undefined]);
	const md = markdownTheme(exact);
	assert.match(md.code("x"), /^\x1b\[38;2;[\d;]+mx\x1b\[39m$/, "Markdown's styles switch off only what they switched on, so a background holds under them");
	hasNot(md.heading("x") + md.bold("x") + md.italic("x") + md.link("x"), "\x1b[0m", "none resets everything");
});

test("screen: lines are painted on their block's background, and text says by its style what it is", async () => {
	const { applyTheme, paint, paintStyled, sgr, STYLES } = await import("../src/screen/text.mjs");
	const { createChat } = await import("../src/screen/chat.mjs");
	try {
		applyTheme({ bgTool: "48;5;235", bgSel: "48;5;239", muted: "38;5;246", ok: "38;5;115" });
		assert.equal(paint([["✓ ", "ok"], ["read", ""]], 8, "bgTool"), "\x1b[48;5;235;38;5;115m✓ \x1b[0m\x1b[48;5;235mread\x1b[0m\x1b[48;5;235m  \x1b[0m", "the block's background lies under every piece of the line and its padding");
		assert.equal(paintStyled("a\x1b[1mb\x1b[22m", 2, 4, "bgSel"), "\x1b[48;5;239ma\x1b[1mb\x1b[22m  \x1b[0m", "and under a line that came styled");
		assert.equal(sgr("bgNothing"), "", "a style the palette does not have is no style");
		applyTheme(undefined);
		assert.deepEqual([STYLES.bgTool, STYLES.muted, STYLES.bgSel, STYLES.ok], [undefined, "2", "7", "32"], "without a palette: no backgrounds, dim for muted, inverse for what is selected, the terminal's own green");
		assert.equal(paint([["x", "muted"]], 3, "bgTool"), "\x1b[2mx\x1b[0m  ");
	} finally {
		applyTheme(undefined);
	}

	let palette = "a";
	const markdown = (text, cols) => text.split("\n").map((line) => ({ styled: `<${palette}:${line}>`, cells: line.length + 4, text: line.padEnd(cols).trimEnd() }));
	const chat = createChat({ now: () => 1000, markdown });
	chat.print("Cartographer · /p\n");
	chat.user("Look at it");
	chat.entry(0, { model: [{ role: "assistant", content: [{ type: "text", text: "A thought." }], timestamp: 1 }] });
	chat.entry(0, { model: [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "task", arguments: { brief: "Read" } }], timestamp: 2 }] });
	chat.entry(0, { model: [{ role: "toolResult", toolCallId: "c1", toolName: "task", content: [{ type: "text", text: "Done." }], details: { report: "t1" } }] }, "◂ report t1  5 characters\n! something to see\n");
	chat.entry(0, { model: [{ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "chat", arguments: { text: "It is **fine**.\nReally." } }], timestamp: 3 }] });
	const lines = chat.lines(60);
	const rows = lines.map((line) => `${line.bg ?? "-"} | ${line.spans.map(([text, style]) => `${text}{${style}}`).join("")}${line.styled !== undefined ? ` | ${line.styled}` : ""}`);
	assert.deepEqual(rows, [
		"- | Cartographer · /p{muted}",
		"- | ",
		"bgUser | › {user bold}Look at it{bold}",
		"- | ",
		"- | ┊ {faint}A thought.{note italic}",
		"- | ",
		"bgTool | ▸ {tool}1 call · t1 · 0s{muted}{err}",
		"- | ◂ {carto}report t1  5 characters{muted}",
		"- | ! something to see{warn}",
		"- | ",
		"- | It is **fine**.{} | <a:It is **fine**.>",
		"- | Really.{} | <a:Really.>",
	], "each kind of line has its place: your block, the tools' block, Cartographer's lines muted with their mark picked out, a warning, notes faint, and the agent's words plain, as Markdown");
	assert.ok(lines.filter((line) => line.bg !== undefined).every((line) => line.pad === 1), "a block's text stands a cell in from its edge");
	// What was rendered is kept: a line that did not change is the same line the next time, painted once.
	assert.equal(chat.lines(60).at(-1), lines.at(-1), "an item that did not change gives the lines it gave before");
	palette = "b";
	assert.equal(chat.lines(60).at(-1).styled, "<a:Really.>", "and is not rendered again");
	// New colours: everything is rendered again with them.
	chat.restyle();
	const recoloured = chat.lines(60);
	assert.equal(recoloured.at(-1).styled, "<b:Really.>", "until the colours change");
	// An item that changes gives new lines; the others keep theirs.
	const run = chat.lines(60).find((line) => line.kind === "group");
	chat.toggle(run.item);
	const opened = chat.lines(60);
	assert.ok(opened.some((line) => line.kind === "call"), "a run that is opened shows its calls");
	assert.equal(opened.at(-1).styled, "<b:Really.>");
	assert.equal(opened.find((line) => line.kind === "user"), recoloured.find((line) => line.kind === "user"), "what stands beside it is as it was");
	const call = opened.find((line) => line.kind === "call");
	chat.toggleRow(call.item, call.row);
	assert.ok(chat.lines(60).some((line) => line.kind === "detail"), "and a call that is opened inside it shows what it returned");
});

test("screen: a list of items that fold: the selection, opening one and all, folders, what is in view, and what e and y act on", async () => {
	const { createList } = await import("../src/screen/list.mjs");
	const list = createList();
	const build = () => ({
		header: [[["Three things", "bold"]]],
		items: [
			{ key: "h", plain: true, head: [["Heading", "bold"]] },
			{ key: "a", head: [["alpha", ""]], body: "first line\nsecond line", target: { file: "/x/a", line: 3 } },
			{ key: "d", folder: true, head: [["dir/", ""]] },
			...(list.isOpen("d") ? [{ key: "d/b", depth: 1, head: [["beta", ""]], copy: "dir/beta" }] : []),
			{ key: "c", head: [["gamma", ""]], body: () => "g\n".repeat(30).trim() },
		],
	});
	// All the rows, with the selected item's own line marked: the list does not scroll, the screen around it does.
	const show = () => list.lines(40).map((line) => `${line.key === list.selected()?.key && line.head ? ">" : " "}${line.spans.map(([text]) => text).join("")}`.trimEnd()).join("\n");
	list.set(build());
	assert.equal(show(), " Three things\n Heading\n>▸ alpha\n ▸ dir/\n ▸ gamma", "the first item that can be chosen is selected; a heading cannot be");
	list.move(-1);
	assert.equal(list.selected().key, "a", "the selection stops at the first item");
	assert.equal(list.toggle(), true);
	has(show(), ">▾ alpha\n     first line\n     second line\n ▸ dir/", "opening shows the body below the line");
	assert.deepEqual(list.selected().target, { file: "/x/a", line: 3 }, "the selected item says what the editor opens");
	assert.equal(list.copyOf(), "alpha\n\nfirst line\nsecond line", "and what is copied: its line and its body");
	list.move(1);
	list.toggle();
	list.set(build());
	has(show(), ">▾ dir/\n     beta\n ▸ gamma", "a folder opens to the items below it, which the builder adds");
	list.move(1);
	assert.equal(list.selected().key, "d/b");
	assert.equal(list.toggle(), false, "an item with nothing more to show does not open");
	assert.equal(list.copyOf(), "dir/beta", "an item can say itself what is copied");
	list.toggle("d", false);
	list.set(build());
	assert.equal(list.selected().key, "a", "when the selected item is gone, the first one is selected");
	list.openAll();
	list.set(build());
	has(show(), "▾ alpha\n     first line", "opening everything opens the bodies");
	has(show(), "▾ dir/\n     beta", "and the folders");
	assert.equal(show().split("\n").filter((line) => line.trim() === "g").length, 30, "every row of every body");
	// What the screen needs to scroll with the selection: on which row the selected item stands, and which item
	// a row belongs to.
	list.last();
	assert.equal(list.selected().key, "c", "G selects the last item");
	const row = list.selectedRow(40);
	assert.equal(show().split("\n")[row], ">▾ gamma", "the list says on which row the selected item stands");
	assert.deepEqual([list.keyAtRow(40, row + 3), list.keyAtRow(40, 0), list.headerRows()], ["c", undefined, 1], "and which item a row belongs to; the top lines belong to none");
	// Scrolled away from the selection, the keys act on what is in view.
	assert.equal(list.selectVisible(40, 0, 5), true, "a window that does not show the selection moves it");
	assert.equal(list.selected().key, "a", "to the first item in view");
	assert.equal(list.selectVisible(40, 0, 5), false, "and leaves it when it is in view");
	list.foldAll();
	list.set(build());
	assert.equal(show(), " Three things\n Heading\n>▸ alpha\n ▸ dir/\n ▸ gamma", "folding everything");
	assert.equal(list.text(40), "Three things\nHeading\n▸ alpha\n▸ dir/\n▸ gamma", "the tab as text, for copying");
});

test("screen: the views read the brain: nodes, entries and items with the line they stand on, the tree, a patch by file, the editor's command", async () => {
	const { atlasView, booksView, diffView, editorCommand, ledgerView, planView, treeView } = await import("../src/screen/views.mjs");
	const root = makeProject("views", { git: false });
	const brainDir = setUpBrain(root).brainDir;
	const server = await startStandIn();
	try {
		const node = { action: "add", name: "Math Helpers", gist: "add(a, b)", kind: "component", files: ["src/math.js"], links: ["entry"], detail: "Used by main.js." };
		const result = await carto(root, server, ["--yolo", "--no-bwrap"], {
			input: lines(ledgerMessage(GOAL, { action: "add", kind: "note", text: "Prefer tabs" }), planMessage(WRITE_ITEM, LOOK_ITEM), `atlas: ${JSON.stringify([node])}`, "assess: A small demo.\\n\\nTwo source files.", "task(p1): write: roll.py <<< print(4)\\\\n\\nedit: src/math.js <<< return a + b; >>> return b + a;"),
		});
		ok(result, "a session that fills the brain");
		const text = (view) => [...view.header, ...view.items.map((item) => item.head)].map((spans) => spans.map(([part]) => part).join("")).join("\n");
		const lineIn = (file, target) => readFileSync(file, "utf8").split("\n")[target.line - 1];

		const atlas = atlasView({ root, brainDir });
		has(text(atlas), "Graph: 1 node", "the graph's summary on top");
		has(text(atlas), "component math_helpers  add(a, b)  [src/math.js]  → entry  (may be out of date)", "a node is one line; a task changed its file since, so it may be out of date");
		has(atlas.items[0].body, "Used by main.js.\nfiles: src/math.js\nlinks: entry\nwritten ", "opened, it shows its detail and when it was written");
		has(lineIn(atlas.items[0].target.file, atlas.items[0].target), '"name": "math_helpers"', "and e opens the atlas file at the node");

		const ledger = ledgerView({ brainDir });
		assert.match(text(ledger), /^Goals\ng1 {2}Make the dashboard multi-player {2}\(done when: Two players can log in at once\)\nNotes\nn2 {2}Prefer tabs$/, `the ledger by kind:\n${text(ledger)}`);
		const goal = ledger.items.find((item) => item.key === "entry:g1");
		has(lineIn(goal.target.file, goal.target), '"id": "g1"', "an entry knows its line in the ledger file");

		const plan = planView({ brainDir, yolo: true });
		has(text(plan), "✓ p1 [change] Write the roller", "a plan item that is done");
		has(text(plan), "○ p2 [look] See what is in the project", "and one that is open");
		has(lineIn(plan.items[1].target.file, plan.items[1].target), '"id": "p2"', "with its line in the plan file");

		const folded = treeView({ root, brainDir }, () => false);
		assert.deepEqual(folded.items.map((item) => item.key), ["dir:src", "file:README.md", "file:long.txt", "file:roll.py"], "the tree, folded: the root's folders and files, without the brain");
		const open = treeView({ root, brainDir }, (key) => key === "dir:src");
		assert.deepEqual(open.items.slice(0, 4).map((item) => [item.key, item.depth]), [["dir:src", 0], ["dir:src/deep", 1], ["file:src/main.js", 1], ["file:src/math.js", 1]], "an open folder shows what is in it, one step in");
		has(text(open), "math.js  71 B  ← math_helpers", "a file names the graph's nodes about it");
		assert.deepEqual(open.items.find((item) => item.key === "file:src/math.js").target, { file: join(root, "src/math.js") }, "and e opens the file itself");

		const books = booksView({ brainDir });
		has(text(books), "a1  A small demo.", "the assessment, one entry to an item (migrated from assessment.md)");
		has(text(books), "a2  Two source files.", "and the second");
		has(books.items[1].target.file, join(root, ".atlas", "assessment.md"), "until the agent edits the books, e opens the assessment they were split from");

		const diff = diffView({ root, brainDir, started: 0 }, "last");
		has(text(diff), "p1 · Write the roller", "the last step");
		assert.deepEqual(diff.items.map((item) => [item.key, item.target.line]), [["change:roll.py", 1], ["change:src/math.js", 1]], "one item for each changed file, with the line of its first change");
		const math = diff.items[1];
		has(math.body, "-  return a + b;\n+  return b + a;", "opened, a file shows its own part of the patch");
		hasNot(math.body, "roll.py", "and no other file's");
		assert.deepEqual(["+x", "-x", "@@ -1 +1 @@", " x"].map(math.bodyStyle), ["ok", "err", "tool", ""], "added lines in the colour of done, removed lines in the colour of failed");
		has(text(diffView({ root, brainDir, started: 0 }, "session")), "Since carto started: 1 step", "everything since a moment");
		has(text(diffView({ root, brainDir, started: 0 }, "git")), "not a git repository", "and the project's own git, when it has one");

		assert.equal(editorCommand("vim", "/p/a b.js", 12), "vim +12 '/p/a b.js'", "most editors take +LINE");
		assert.equal(editorCommand("code --wait", "/p/a.js", 12), "code --wait --goto '/p/a.js:12'", "some take file:line");
		assert.equal(editorCommand("hx", "/p/a.js", 12), "hx '/p/a.js:12'");
		assert.equal(editorCommand("nano", "/p/it's.js", undefined), "nano '/p/it'\\''s.js'", "without a line, the file alone; a quote in a name is safe");
	} finally {
		await server.close();
	}
});

test("screen: the Context tab shows the request the agent was sent, part by part in the order the model reads it, and what came since", async () => {
	const { contextBar, contextView } = await import("../src/screen/views.mjs");
	const big = "word ".repeat(4000); // about 5,000 tokens
	const payload = {
		tools: [{ type: "function", function: { name: "read", description: "Read files.", parameters: { type: "object", properties: { paths: { type: "array" } } } } }],
		messages: [
			{ role: "system", content: "You are Cartographer." },
			{ role: "user", content: `<project>\nWritten by Cartographer from your own records.\nYour assessment\nA demo.\n</project>\n\n<context>\nWritten by Cartographer, not by the user. Kept.\nt1 · look · asked: x → y\n</context>\n\nWhere is the config?\n\n[sent Thu 12 Nov 2026, 14:02]` },
			{ role: "assistant", content: "I should look.", tool_calls: [{ id: "c1", type: "function", function: { name: "task", arguments: JSON.stringify({ brief: "Find the config\nand say where" }) } }] },
			{ role: "tool", tool_call_id: "c1", content: `${big}\n\n<state>\nWritten by Cartographer, not by the user.\nNow: Thu 12 Nov 2026, 14:03\n</state>\n\n<windows>\nWritten by Cartographer as this request is sent.\n  main · free\n</windows>` },
		],
	};
	const reply = { role: "assistant", content: [{ type: "thinking", thinking: "Say it." }, { type: "toolCall", id: "c2", name: "chat", arguments: { text: "It is in src/config.js." } }] };
	const sent = { task: false, payload, reply, results: new Map([["c2", "Shown to the user."]]), at: Date.now() - 5000, count: 7, used: 6100, collapsedSince: false };
	const view = contextView(sent, { windowSize: 20_000, cols: 40 });
	const titles = view.items.map((item) => (item.plain ? item.head[0][0] : item.head[2][0].trim()));
	assert.deepEqual(titles, ["System prompt", "Tools · 1: read", "Assessment and graph, as copied at the last collapse", "What the last collapse kept", "Chat · You", "Chat · Agent · note and call: task", "Result of task", "State block: the time, the tree, the ledger, the plan", "Windows block: the shell windows as they are", "── since that request: what the next one will hold as well ──", "The reply · call: chat", "Result of chat"], "the parts in the order the model reads them, the chat told from the rest");
	assert.deepEqual(view.items.slice(0, 2).map((item) => item.head.map(([part]) => part).join("")), ["■     6  System prompt  You are Cartographer.", "■    37  Tools · 1: read  "], "each is one line: its colour, its size, what it is, how it begins");
	const byKey = (title) => view.items.find((item) => !item.plain && item.head[2][0].trim().startsWith(title));
	assert.equal(byKey("System prompt").body, "You are Cartographer.", "opened, a part is its text exactly");
	has(byKey("Tools · 1").body, '── read ──\nRead files.\nparameters: {\n  "type": "object"', "the tools as they are sent");
	assert.deepEqual(view.items.filter((item) => item.key?.startsWith("tool:")).map((item) => item.key), [], "folded, the tools are one part; a view that opens them is asked with isOpen");
	assert.match(byKey("Assessment and graph").body, /^<project>\n[\s\S]*\n<\/project>$/, "the block Cartographer puts in front is a part of its own");
	assert.match(byKey("What the last collapse kept").body, /^<context>\n[\s\S]*\n<\/context>$/, "so is what a collapse kept");
	const you = byKey("Chat · You");
	assert.equal(you.body, "Where is the config?\n\n[sent Thu 12 Nov 2026, 14:02]", "and the user's message is what is left");
	assert.equal(you.editKind, "chat-you", "a message of the user says what e does on it");
	const agent = byKey("Chat · Agent · note and call: task");
	assert.equal(agent.body, "I should look.\n\ncall task\n  brief:\n    Find the config\n    and say where", "a call reads as a call: its arguments one by one, long text as text");
	assert.equal(agent.editKind, "chat-agent", "a message of the agent is editable as well");
	assert.match(byKey("State block").body, /^<state>\n[\s\S]*\n<\/state>$/, "the state block is cut off the result it was added to");
	assert.match(byKey("Windows block").body, /^<windows>\n[\s\S]*\n<\/windows>$/, "and the windows block");
	hasNot(byKey("Result of task").body, "<state>", "which is then only the result");
	assert.equal(byKey("The reply").body, "(thinking, not kept in the context)\nSay it.\n\ncall chat\n  text: It is in src/config.js.", "after the request: the reply");
	assert.equal(byKey("Result of chat").body, "Shown to the user.", "and what its call returned");

	// e on the tab: each part says what it opens, and what the user has said anew stands where the original stood.
	assert.deepEqual(view.items.map((item) => item.editKind).filter(Boolean), ["prompt", "tools", "assessment", "store", "chat-you", "chat-agent", "result", "state", "windows", "chat-agent", "result"], "every part says what e does on it");
	const touched = contextView(sent, { windowSize: 20_000, cols: 40, edits: new Map([["Where is the config?\n\n[sent Thu 12 Nov 2026, 14:02]", "Where is the config, exactly?\n\n[sent Thu 12 Nov 2026, 14:02]"]]) });
	assert.equal(touched.items.find((item) => item.editKind === "chat-you").body, "Where is the config, exactly?\n\n[sent Thu 12 Nov 2026, 14:02]", "what was said anew stands where the original stood, its stamp with it");
	assert.equal(touched.items.find((item) => item.editKind === "chat-you").head[2][0], "  Chat · You", "and the title is the chat's, not the part's kind");
	const said = contextView({ ...sent, reply: { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "chat", arguments: { text: "Here you are, said anew." } }] }, results: new Map([["c3", "Shown."]]) }, { windowSize: 20_000, cols: 40 });
	const saidPart = said.items.find((item) => item.editKind === "chat-agent" && item.chat !== undefined);
	assert.ok(saidPart, "a message whose only work is to speak carries its words for e");
	assert.equal(saidPart.chat, "Here you are, said anew.", "so that the saying is edited, and not the rendering of the call");

	// Opened, the tools part gives a line to each tool, so that one description can be read and edited.
	const opened = contextView(sent, { windowSize: 20_000, cols: 40, isOpen: (key) => key === "tools" });
	const tool = opened.items.find((item) => item.key === "tool:read");
	assert.ok(tool, "the tools part unfolds to a line per tool");
	assert.equal(tool.depth, 1, "a tool of the block stands one step in");
	assert.equal(tool.body, "Read files.\n\nparameters: {\n  \"type\": \"object\",\n  \"properties\": {\n    \"paths\": {\n      \"type\": \"array\"\n    }\n  }\n}", "a tool's body is its description and its parameters, as the server got them");
	assert.equal(opened.items.filter((item) => item.key?.startsWith("tool:")).length, 1, "just the tools of this request");

	// The top: whose window, the bar, the legend.
	const top = view.header.map((line) => line.map(([part]) => part).join(""));
	assert.match(top[0], /^What the main agent sees {2}· {2}about [\d.]+k of 20k tokens \(\d+%\) {2}· {2}the server counted 6\.1k$/);
	assert.match(top[1], /^request 7 of this run, sent \d\d:\d\d \(/);
	assert.equal(top[2].length, 40, "the bar is as wide as the screen");
	assert.match(top[2], /^■+□+$/, "used cells, then free ones");
	// A quarter of the window is the big result: about ten of forty cells are its colour.
	const resultCells = view.header[2].filter(([, style]) => style === "catResult").reduce((sum, [cells]) => sum + cells.length, 0);
	assert.ok(resultCells >= 9 && resultCells <= 11, `a part takes as much of the bar as of the window: ${resultCells} of 40 cells for about 5k of 20k tokens`);
	has(top.join("\n"), "■ Tool results ", "what each colour is");
	has(top.join("\n"), "□ Free ", "and how much is free");
	assert.deepEqual(contextBar([{ cat: "system", tokens: 50 }, { cat: "tools", tokens: 25 }], 100, 20).map(([cells, style]) => [cells.length, style]), [[10, "catSystem"], [5, "catTools"], [5, "faint"]], "the bar is the window in order: half, a quarter, a quarter free");

	const task = contextView({ ...sent, task: true, reply: undefined, results: new Map() }, { windowSize: 20_000, cols: 40, writing: { content: [{ type: "text", text: "Half a tho" }] } });
	has(task.header[0][0][0], "What the running task sees", "while a task runs, the window is the task's");
	const writing = task.items.at(-1);
	assert.deepEqual([writing.head.map(([part]) => part).join("").includes("The reply, as it is being written"), writing.body], [true, "Half a tho"], "and the reply shows as far as it is written");
	has(contextView({ ...sent, collapsedSince: true }, { windowSize: 20_000, cols: 40 }).header.map((line) => line.map(([part]) => part).join("")).join("\n"), "The context was collapsed after this request was sent", "a collapse since then is said");
	has(contextView(undefined, { windowSize: 20_000, cols: 40 }).items[0].head[0][0], "Nothing has been sent to the model in this run of carto yet", "before the first request there is nothing to show");
});

test("screen: on a terminal carto takes the whole screen: two modes, tabs, items that open, the editor, copying, and the screen given back", async () => {
	const root = makeProject("screen", { git: false });
	const server = await startStandIn();
	const editor = join(scratch, "fake-editor.sh");
	const opened = join(scratch, "editor-args.txt");
	writeFileSync(editor, `#!/bin/sh\necho "$@" >> ${opened}\n`);
	chmodSync(editor, 0o755);
	try {
		ok(await carto(root, server, ["--yolo"], { input: lines(planMessage(WRITE_ITEM)) }), "a plan");
		const result = await cartoOnScreen(root, server, ["--yolo", "--no-bwrap"], [
			["Type a message", "task(p1): read: a.txt\\nwrite: roll.py <<< print(4)\\\\n"],
			["report t1", ""],
			// Esc: from typing to commands. k three times: the agent's message, what the task left, the run of calls.
			["resting", "<ESC>", false],
			["COMMANDS", "kkk", false],
			[0.4, "<ENTER>", false],
			// Down to the write, and Enter goes to where that work lives.
			["✓ write roll.py", "jjj", false],
			[0.3, "<ENTER>", false],
			["Last step", "l", false],
			["+print(4)", "e", false],
			[0.8, "]", false],
			["Since carto started", "2", false],
			["Graph:", "]]", false],
			// A click on the plan's item opens it; e then opens the plan's file where the item stands.
			["[change] Write the roller", "\x1b[<0;6;5M\x1b[<0;6;5m", false],
			["▾ ✓ p1", "e", false],
			[0.8, "]", false],
			// One more ] than before: Requests stands between Plan and Tree.
			[0.4, "]", false],
			[" files in ", "5", false],
			["What the main agent sees", "+", false],
			["You are in one of two roles at any time.", "G", false],
			["since that request", "i", false],
			["type a message", "/copy session"],
			["Copied the session", "\x1b[<0;30;1M\x1b[<0;30;1m", false],
			["No shell window is open", "/quit"],
			[1.5, "", false],
		], { rows: 32, env: { EDITOR: editor } });
		if (result === undefined) return "python3 is needed for a terminal";
		const at = (text) => result.shots.find((shot) => shot.includes(text)) ?? assert.fail(`no screen shows ${JSON.stringify(text)}:\n${result.shots.join("\n────\n")}`);
		const first = result.shots[0];
		assert.match(first, /^ 1 Chat {2}2 Carto {2}3 Diff {2}4 Shells {2}5 Context +Esc: commands · F1: keys\n/, `the tabs stand on the first row:\n${first}`);
		has(first, "approval: OFF (yolo)", "what was said before the screen opened is said again inside it");
		has(first, "○ resting · ", "the strip says the agent rests");
		assert.match(first, /\nctx ▮?▯+ [\d.?k]+\/100k · no goal · plan 0\/1 · yolo · no sandbox\n› {2}type a message, or \/help · Esc for commands\n*$/, `the second row of the strip and the place to type:\n${first}`);

		const folded = at("report t1");
		assert.match(folded, /\n ▸ 3 calls · t1 · \d+s\n◂ report t1 {2}\d+ characters {2}\(\/report shows it\)\n● plan {2}✓ p1 marked done by its task\n◂ changed 1 file \(\+1\)/, `the task's work is one line, and what it left behind is said in full:\n${folded}`);
		const commands = at(" COMMANDS ");
		assert.match(commands, /\n COMMANDS {3}Esc or i to type\n*$/, `Esc changes the mode, and the place to type says so:\n${commands}`);
		assert.match(commands, /^ 1 Chat [^\n]* j k move · Enter open · y copy · \? keys\n/, "and the first row says what the keys do now");
		const openedRun = at("✓ write roll.py");
		assert.match(openedRun, /\n ▾ 3 calls · t1 · \d+s\n {3}✓ task p1 {2}read: a\.txt write: roll\.py[^\n]*→ report t1\n {3}│ ✓ read a\.txt {2}→ 2 lines\n {3}│ ✓ write roll\.py {2}→ 1 line, a new file\n/, `k and Enter open the run to a line per call:\n${openedRun}`);

		// Enter on the write leads to the Diff tab, where the changed file is an item that opens.
		const diff = at("+print(4)");
		assert.match(diff, /\n {2}Last step {2}This session {2}git HEAD {4}\[ \] change view · e opens roll\.py\n/, `Diff has its views on a row, and names what e opens:\n${diff}`);
		has(diff, "p1 · Write the roller  1 file (+1)\n▾ new      roll.py (+1)\n    --- /dev/null\n    +++ b/roll.py\n    @@ -0,0 +1 @@\n    +print(4)\n", "l opens the changed file to its patch");
		has(at("Since carto started"), "Since carto started: 1 step  1 file (+1)\n▸ new      roll.py (+1)\n", "] goes to the next view: this session");
		const plan = at("[change] Write the roller");
		assert.match(plan, /\n {2}Atlas {2}Ledger {2}Plan {2}Requests {2}Tree {2}Books {4}\[ \] change view · e opens \.atlas\/carto-plan\.json\n/, `Carto has its views on a row:\n${plan}`);
		has(plan, "▸ ✓ p1 [change] Write the roller", "the plan's items are lines that can be selected");
		assert.match(at("▾ ✓ p1"), /\n▾ ✓ p1 \[change\] Write the roller[^\n]*\n {4}Write the roller\n {4}done /, "a click on one opens it");
		has(at(" files in "), "▸ src/  ", "the tree is a view of folders that open");
		// e opened the changed file at its first changed line, and the plan's file at the item.
		const calls = readFileSync(opened, "utf8").trim().split("\n");
		assert.equal(calls[0], `+1 ${join(root, "roll.py")}`, "e in Diff opens the changed file, at the line of its first change");
		assert.match(calls[1], new RegExp(`^\\+\\d+ ${join(root, ".atlas", "carto-plan.json").replace(/[.]/g, "\\.")}$`), "e on a plan item opens the plan's file at that item");
		const planLines = readFileSync(join(root, ".atlas", "carto-plan.json"), "utf8").split("\n");
		has(planLines[Number(/^\+(\d+)/.exec(calls[1])[1]) - 1], '"id": "p1"', "the line is the item's");

		// Context: what the agent was sent, folded; + opens all of it.
		const context = at("What the main agent sees");
		assert.match(context, /\nWhat the main agent sees {2}· {2}about [\d.]+k of 100k tokens \(\d+%\) {2}· {2}the server counted [\d.]+k\nrequest \d+ of this run, sent \d\d:\d\d \([^)]*\), as the server got it · part sizes are estimates\n/, `the Context tab says whose window it is, how full, and which request it shows:\n${context}`);
		assert.match(context, /\n■+□+\n■ System prompt \.+ +[\d.]+k +[\d.]+% +■ Tools \.+ +[\d.]+k +[\d.]+%/, `then the window as one row, and what each part of it is:\n${context}`);
		assert.match(context, /\n▸ ■ +[\d.]+k {2}System prompt {2}You are Cartographer[^\n]*\n▸ ■ +[\d.]+k {2}Tools · 14: /, `then every part as one line, folded:\n${context}`);
		assert.match(at("You are in one of two roles at any time."), /\n▾ ■ +[\d.]+k {2}System prompt/, "+ opens every part: the tab is then the whole window, word for word");
		const end = at("since that request");
		has(end, "── since that request: what the next one will hold as well ──", "the reply and what its calls returned follow what was sent");
		has(end, "Shown to the user.", "in full");

		const copied = at("Copied the session");
		assert.match(copied, /Copied the session \([\d,]+ characters\) to the clipboard by way of the terminal \(OSC 52\)/, "/copy session says where it went");
		const exported = readdirSync(join(root, ".atlas", "export")).filter((name) => name.startsWith("session-"));
		assert.equal(exported.length, 1, "and writes a file as well");
		const transcript = readFileSync(join(root, ".atlas", "export", exported[0]), "utf8");
		has(transcript, "## You\n\ntask(p1): read: a.txt", "the transcript holds what the user typed");
		has(transcript, "  - `write roll.py` → 1 line, a new file\n", "and a line for each call");
		assert.ok(result.osc.some((sequence) => sequence.startsWith("52;c;")), "the clipboard is set through the terminal");
		has(at("No shell window is open"), " 4 Shells ", "a click on a tab's name goes there");
		assert.equal(result.alt, false, "leaving gives the screen back");
		assert.deepEqual(result.modes.filter((mode) => ["1000", "1002", "1003", "1004", "1006", "2004", "2031", "1049"].includes(mode)), [], `and switches the mouse and the paste marks off again: ${result.modes}`);
		// What stays on the terminal is the conversation, as it stood.
		const left = result.after.replace(/\r/g, "");
		assert.match(left, /▎› task\(p1\): read: a\.txt[^\n]*\n\s*\n {3}▾ 3 calls · t1 · \d+s\s*\n/, `leaving leaves the conversation on the terminal:\n${left.slice(-1500)}`);
		has(left, "Copied the session", "to its end");
		hasNot(left, "1 Chat  2 Carto", "without the screen around it");
	} finally {
		await server.close();
	}
});

test("screen: e says a message anew, Hands folds and recalls, and a shell window shows its output as a terminal does", async () => {
	const root = makeProject("screen-hands");
	const server = await startStandIn();
	const editor = join(scratch, "hands-editor.sh");
	const opened = join(scratch, "hands-editor-args.txt");
	writeFileSync(editor, `#!/bin/sh\necho "$@" >> ${opened}\nprintf ' (said anew)' >> "$1"\n`);
	chmodSync(editor, 0o755);
	try {
		ok(await carto(root, server, ["--yolo"], { input: lines(planMessage(RUN_ITEM)) }), "a plan");
		const result = await cartoOnScreen(root, server, ["--yolo", "--no-bwrap"], [
			["Type a message", "task(p1): shell[window=run,wait=0]: while :; do echo beat; sleep 0.2; done\\nshell: echo from run\\n"],
			["report t1", ""],
			// e on the user's message: g selects the first stop (what Cartographer printed at the start),
			// and j moves to the next: what the user typed.
			["resting", "<ESC>", false],
			["COMMANDS", "gjj", false],
			[0.4, "e", false],
			[0.8, "5", false],
			// The Hands view of the Context tab: fold the report, bring it back, shelve a file.
			["What the main agent sees", "]]]", false],
			["Your hands on what the agent keeps", "f", false],
			["· folded", "", false],
			["COMMANDS", "f", false],
			[0.4, "a", false],
			["/shelve", " README.md"],
			[0.8, "<ESC>", false],
			// e from the Context tab itself: the first Chat · You part of the request, edited where it shows.
			["COMMANDS", "5[[[", false],
			["What the main agent sees", "j", false],
			[0.3, "j", false],
			[0.3, "j", false],
			[0.3, "e", false],
			[0.8, "", false],
			// Hands again: v archives the report out of the record, and d, twice, deletes it for good.
			["What the main agent sees", "]]]", false],
			["Your hands on what the agent keeps", "j", false],
			[0.4, "v", false],
			["· archived", "", false],
			[0.4, "d", false],
			["d again", "d", false],
			[4.5, "", false],
			// The Shells tab: the window's output as a terminal emulator sees it, the newest at the bottom.
			["COMMANDS", "4", false],
			["shell window", "<ENTER>", false],
			["Output of run", "i", false],
			["type a message", "/quit"],
			[1.5, "", false],
		], { rows: 34, env: { EDITOR: editor } });
		if (result === undefined) return "python3 is needed for a terminal";
		const at = (text) => result.shots.find((shot) => shot.includes(text)) ?? assert.fail(`no screen shows ${JSON.stringify(text)}:\n${result.shots.join("\n────\n")}`);
		const edited = at("your message is edited");
		has(edited, "said anew", "e opened the user's message in the editor, and the tab says it anew");
		const calls = readFileSync(opened, "utf8").trim().split("\n");
		assert.match(calls.at(-1), /\.atlas\/scratch\/message\.md$/, "the editor was handed the message's scratch file");
		const store = JSON.parse(readFileSync(join(root, ".atlas", "carto-context.json"), "utf8"));
		const said = store.chat.filter((entry) => entry.who === "user").at(-1);
		has(said.text, "(said anew)", "the talk the context keeps was rewritten to match");
		const hands = at("Your hands on what the agent keeps");
		has(hands, "t1  · in view", "Hands lists the report");
		has(at("· folded"), "t1  · folded", "f folds it, and says so on its line");
		has(at("README.md"), "README.md", "a put /shelve in the prompt, and the file stands on the shelf");
		// The edit from the Context tab: the Chat · You part says the new words where the original stood.
		const again = result.shots.find((shot) => shot.includes("Chat · You") && shot.includes("(said anew)"));
		assert.ok(again, "e works on the messages of the context as well:\n" + result.shots.join("\n────\n"));
		const saidStore = JSON.parse(readFileSync(join(root, ".atlas", "carto-context.json"), "utf8"));
		has(saidStore.chat.filter((entry) => entry.who === "user").at(-1).text, "said anew", "the talk says the new words");
		has(at("· archived"), "t1  · archived", "v archives the report out of the record");
		assert.ok(result.shots.some((shot) => shot.includes("d again")), "the first d asks before it deletes");
		const empty = result.shots.find((shot) => shot.includes("No work has been finished yet"));
		assert.ok(empty, "the second d deletes it:\n" + result.shots.join("\n────\n"));
		assert.ok(!empty.includes("t1  ·"), "and the list no longer holds the report:\n" + empty);
		assert.ok(!existsSync(join(root, ".atlas", "reports", "t1.md")), "the report's file is gone with it");
		const out = at("Output of run");
		has(out, "beat", "the window's output, as it was printed");
		assert.match(out, /Enter goes back to the list; \/send run line types into it/, "and the view says how to type into the window");
	} finally {
		await server.close();
	}
});

test("screen: blocks have backgrounds of their own inside an empty margin, and hiding the notes leaves no line behind", async () => {
	const root = makeProject("screen-look", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "" }), "set up");
		// The greys are pinned below in the 256 palette, so the colour mode is pinned too: a COLORTERM of the
		// shell this suite runs in would otherwise make the theme truecolor.
		const result = await cartoOnScreen(root, server, [], [
			["Type a message", "think: Thinking it over."],
			["┊ Thinking it over.", "task: read: a.txt"],
			["report t1", "<PASTE>say: It is **done**.\n\n- one\n- two</PASTE>", false],
			["4 lines", "<ENTER>", false],
			// Ctrl-T four times: hidden, shown, hidden, shown.
			["\n  - two\n", "<CTRLT>", false],
			["notes and thinking are hidden", "<CTRLT>", false],
			["notes and thinking are shown", "<CTRLT><CTRLT>", false],
			[0.6, "<ESC>", false],
			["COMMANDS", "kkk", false],
			[0.5, "", false],
		], { rows: 34, env: { COLORTERM: "" } });
		if (result === undefined) return "python3 is needed for a terminal";
		const rows = result.painted;
		const row = (text) => rows.find((entry) => entry.text.includes(text)) ?? assert.fail(`no row shows ${JSON.stringify(text)}:\n${rows.map((entry) => entry.text).join("\n")}`);
		// The margin: two empty cells at the left of every row of content.
		for (const entry of rows.slice(1, -3)) assert.ok(entry.text === "" || entry.text.startsWith("  "), `every row keeps the margin: ${JSON.stringify(entry.text)}`);
		// Whose block it is.
		const [mine, run, said, reported, tabs, strip, typing] = [row("› task: read"), row("calls · t1"), row("It is done."), row("◂ report t1"), rows[0], row("ctx "), rows.at(-1)];
		assert.ok(mine.bg !== null && mine.edge === null, `what you said is a block, set in from the edge: ${JSON.stringify(mine)}`);
		assert.match(mine.text, /^ {2}▎› task: read/, "with its edge drawn");
		assert.ok(run.bg !== null && run.bg !== mine.bg, `what the agent did is a block of another colour: ${JSON.stringify(run)}`);
		assert.deepEqual([said.bg, reported.bg], [null, null], "what the agent says, and what Cartographer reports, stand on the screen's own background");
		assert.ok(tabs.edge !== null && strip.edge !== null && tabs.edge === strip.edge, "the row of tabs and the strip run from edge to edge, in one colour");
		assert.ok(typing.edge !== null && typing.edge !== strip.edge, "the place to type has its own");
		assert.equal(new Set([mine.bg, run.bg, tabs.edge, typing.edge]).size, 4, "four areas, four backgrounds");
		// What is selected is marked by its background, not by swapping the colours.
		const chosen = rows.filter((entry) => entry.bg !== null && ![mine.bg, run.bg, tabs.edge, typing.edge].includes(entry.bg));
		assert.ok(chosen.length >= 1 && chosen.every((entry) => entry.bg !== "inverse"), `the selected rows have the selection's background: ${JSON.stringify(chosen)}`);
		// The agent's words are Markdown: the marks are gone, the list stays.
		has(result.last, "It is done.\n\n- one\n- two", "what the agent says is rendered as Markdown");
		hasNot(result.last.split("- two").at(-2).split("\n").at(-4), "**", "its marks are not shown");
		// Ctrl-T: said in passing on the first row, and nothing is left in the conversation.
		const hidden = result.shots.find((shot) => shot.includes("notes and thinking are hidden"));
		assert.match(hidden.split("\n")[0], /5 Context +notes and thinking are hidden$/, "hiding the notes is said in passing, on the first row");
		hasNot(hidden, "┊ Thinking it over.", "and the notes are gone from view");
		has(result.last, "┊ Thinking it over.", "shown again, they are back where they stood");
		for (const shot of result.shots) hasNot(shot, "thinking is ", "no line about it is added to the conversation, however often it is pressed");
		assert.ok(result.osc.includes("11;?") && result.osc.includes("10;?"), "the terminal is asked for its background and text colours");

		// A terminal that answers with a light background gets light blocks.
		const light = await cartoOnScreen(root, server, [], [["Type a message", "say: hi"], ["\n  hi\n", "", false], [0.5, "", false]], { rows: 20, env: { VT_BACKGROUND: "faf9f6", COLORTERM: "" } });
		const grey = (code) => Number(/^5;(\d+)$/.exec(code ?? "")?.[1]);
		const [darkBar, lightBar] = [grey(tabs.edge), grey(light.painted[0].edge)];
		assert.ok(darkBar >= 232 && darkBar < 242, `on a dark background the row of tabs is a dark grey: ${tabs.edge}`);
		assert.ok(lightBar > 248, `on a light one it is a light grey, made from the colour the terminal answered: ${light.painted[0].edge}`);
		const lightMine = light.painted.find((entry) => entry.text.includes("› say: hi"));
		assert.ok(lightMine.bg !== null && lightMine.bg !== mine.bg, "and so are the blocks");
	} finally {
		await server.close();
	}
});

test("screen: what is opened above the end of the conversation stays where it is, and the conversation does not slide", async () => {
	const root = makeProject("screen-open", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "" }), "set up");
		// A screen too small for the conversation: Chat stands at its end, and the run of calls is above it.
		const result = await cartoOnScreen(root, server, [], [
			["Type a message", "task: read: a.txt\\nread: README.md\\nread: src/math.js\\nread: src/main.js"],
			["== src/main.js", "<ESC>", false],
			["COMMANDS", "kkk", false],
			[0.4, "<ENTER>", false],
			["│ ✓ read README.md", "", false],
			[0.3, "", false],
		], { rows: 16 });
		if (result === undefined) return "python3 is needed for a terminal";
		const [before, after] = [result.shots[3], result.last];
		const rowOf = (shot) => shot.split("\n").findIndex((line) => / [▸▾] 5 calls · t1/.test(line));
		assert.ok(rowOf(before) > 0, `the run of calls is in view, folded:\n${before}`);
		assert.equal(rowOf(after), rowOf(before), `opened, it stands on the row it stood on:\n${after}`);
		assert.match(after, / ▾ 5 calls · t1 · \d+s\n {3}✓ task {2}read: a\.txt[^\n]*\n {3}│ ✓ read a\.txt {2}→ 2 lines\n {3}│ ✓ read README\.md/, "and its calls show below it");
		has(after, "↓ the newest · G or End", "the end of the conversation is a key away, and the screen says so");
	} finally {
		await server.close();
	}
});

test("screen: on a terminal that speaks the Kitty keyboard protocol the keys mean the same, and a key let go is no key", async () => {
	const root = makeProject("screen-kitty", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "" }), "set up");
		// Each key as such a terminal sends it: pressed, and let go (the ":3" at its end).
		const [escape, five, enter] = ["\x1b[27u\x1b[27;1:3u", "5\x1b[53;1:3u", "\x1b[13u\x1b[13;1:3u"];
		const result = await cartoOnScreen(root, server, [], [
			["Type a message", `say: hi${enter}`, false],
			["\n  hi\n", escape, false],
			["COMMANDS", five, false],
			["What the main agent sees", "\x1b[106u\x1b[106;1:3u", false],
			[0.3, "i\x1b[105;1:3u", false],
			["Esc for commands", "\x1b[105;5u\x1b[105;5:3u", false],
			[0.3, "", false],
		], { rows: 20, env: { VT_KITTY: "1" } });
		if (result === undefined) return "python3 is needed for a terminal";
		assert.ok(result.osc !== undefined && result.shots.some((shot) => shot.includes(" COMMANDS ")), `Escape, as this terminal sends it, changes the mode once: letting the key go does not change it back\n${result.shots.join("\n────\n")}`);
		has(result.shots[3], "5 Context", "a digit goes to its tab");
		has(result.shots[3], " COMMANDS ", "and the mode is still the commands mode");
		const last = result.last;
		has(last, "›  type a message", "i goes back to typing");
		hasNot(last.split("\n").at(-2) ?? "", "i", "and the key that was let go typed nothing");
		assert.equal(server.requests.filter((request) => messageText(request.messages.at(-1)).startsWith("say: hi")).length, 1, "Enter sent the message once");
	} finally {
		await server.close();
	}
});

test("screen: pasted text keeps its lines and is not sent by itself; in the commands mode a letter is a command and not text", async () => {
	const root = makeProject("screen-paste", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "" }), "set up");
		const result = await cartoOnScreen(root, server, [], [
			// Marked as pasted by the terminal.
			["Type a message", "<PASTE>say: first line\nsecond line\n\tthird, indented</PASTE>", false],
			["3 lines · Enter sends them as one message", "<ENTER>", false],
			// Not marked: the lines arrive as if typed, all at once.
			// (Waiting for the agent's answer: typed right behind the Enter, in one read with it, the lines would be
			// taken as pasted together with it.)
			["\n  first line\n", "say: alpha<NL>beta<NL>gamma", false],
			["3 lines · Enter sends them as one message", "<CTRLJ>", false],
			["4 lines", "delta", false],
			["delta", "<ENTER>", false],
			// In the commands mode, e is a command; pasting there is still typing.
			["\n  alpha\n", "<ESC>", false],
			["COMMANDS", "eyj", false],
			[0.4, "<PASTE>say: pasted in the other mode</PASTE>", false],
			["say: pasted in the other mode", "<ENTER>", false],
			["\n  pasted in the other mode\n", "/quit"],
			[1, "", false],
		], { rows: 30 });
		if (result === undefined) return "python3 is needed for a terminal";
		const typed = result.shots[1];
		assert.match(typed, /\n› say: first line\n {2}second line\n {6}third, indented\n {2}3 lines · Enter sends them as one message · Alt-Enter adds a line$/, `what is pasted stands in the place to type, line by line, and is not sent:\n${typed}`);
		const sent = server.requests.map((request) => messageText(request.messages.findLast((message) => message.role === "user") ?? {}));
		assert.ok(sent.some((text) => text.startsWith("say: first line\nsecond line\n    third, indented")), `Enter sends it as one message with its lines (the editor makes a tab four spaces):\n${JSON.stringify(sent)}`);
		assert.ok(sent.some((text) => text.startsWith("say: alpha\nbeta\ngamma\ndelta")), `lines that came at once without the marks are kept together too, and Ctrl-J adds one:\n${JSON.stringify(sent)}`);
		assert.equal(server.requests.filter((request) => /^say: alpha\n\n\[sent/.test(messageText(request.messages.at(-1)))).length, 0, "no line of it was sent on its own");
		const commands = result.shots[8];
		hasNot(commands, "eyj", "in the commands mode the letters are not typed");
		has(result.shots[9], "› say: pasted in the other mode", "pasting goes to typing, whatever the mode was");
		assert.ok(sent.some((text) => text.startsWith("say: pasted in the other mode")), "and can be sent");
	} finally {
		await server.close();
	}
});

test("screen: the editor completes commands, a sheet shows the keys, a slash searches, and dragging copies what is selected", async () => {
	const root = makeProject("screen-tui", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "" }), "set up");
		const result = await cartoOnScreen(root, server, [], [
			// A slash lists the commands; typing narrows the list.
			["Type a message", "/co", false],
			["collapse the context now", "py session", false],
			// One Enter takes the completion and sends the command.
			["→ session", "<ENTER>", false],
			["Copied the session", "say: canary bird"],
			// What was sent comes back with Up.
			["\n  canary bird\n", "<UP>", false],
			["\n  › say: canary bird", "\x01\x0b", false],
			// Tab goes to the next tab while nothing is typed, and completes once something is.
			[0.3, "<TAB>", false],
			["Graph:", "\x1b[Z", false],
			[0.3, "/pl", false],
			["the plan, whether it is authorized", "<TAB>", false],
			["› /plan", "\x01\x0b", false],
			// F1: the keys, on a sheet that scrolls and closes.
			[0.3, "\x1bOP", false],
			["Two modes", "G", false],
			["Each goes to the clipboard", "q", false],
			// Esc, then a slash: the search of the tab.
			[0.4, "<ESC>", false],
			["COMMANDS", "/", false],
			["Find in transcript", "canary", false],
			["│ canary", "<ESC>", false],
			// Escape and a digit so close together that the terminal takes them for Alt and the digit.
			[0.4, "i", false],
			["Esc for commands", "\x1b4", false],
			["No shell window is open", "1G", false],
			// Dragging over the message that was sent selects it, and letting go copies it. (With Chat at its end
			// on a screen of 30 rows, the message stands on row 23: under it an empty row and the answer, then the
			// empty row above the strip, the strip's two rows, and the two rows of the place to type.)
			["\n  ▎› say: canary bird\n\n  canary bird\n\n", "\x1b[<0;1;23M\x1b[<32;40;23M\x1b[<0;40;23m", false],
			["Copied!", "i", false],
			[0.3, "/quit"],
			[1.5, "", false],
		], { rows: 30 });
		if (result === undefined) return "python3 is needed for a terminal";
		const at = (text) => result.shots.find((shot) => shot.includes(text)) ?? assert.fail(`no screen shows ${JSON.stringify(text)}:\n${result.shots.join("\n────\n")}`);
		const list = at("collapse the context now");
		assert.match(list, /\n› \/co\n\n {2}→ copy +the agent's last message; or: session, report, tab\n {4}context +what the agent's context holds[^\n]*\n {4}collapse +collapse the context now/, `a slash lists the commands with what they do, under what is typed:\n${list}`);
		has(at("→ session"), "› /copy session\n", "a command's own words are completed too");
		assert.equal(readdirSync(join(root, ".atlas", "export")).filter((name) => name.startsWith("session-")).length, 1, "one Enter takes the completion and sends the command");
		assert.ok(result.shots.some((shot) => /\n› say: canary bird\n/.test(shot)), `Up brings back what was sent, into the place to type:\n${result.shots.slice(4, 6).join("\n────\n")}`);
		has(at("Graph:"), "Atlas  Ledger  Plan  Requests", "with nothing typed, Tab goes to the next tab");
		has(at("› /plan"), " 1 Chat ", "with something typed, Tab completes it");
		const sheet = at("Two modes");
		assert.match(sheet, /\n {3}Keys {3}1–\d+ of \d+ · j k scroll {3}Esc closes\n\n {3}Two modes\n/, `F1 lays a sheet with the keys over the screen:\n${sheet}`);
		has(at("Each goes to the clipboard"), "Copying whole things", "which scrolls");
		hasNot(result.shots.at(-1), "Two modes", "and closes; nothing of it is left in the conversation");
		const search = at("Find in transcript");
		has(search, "┌──", "a slash in the commands mode opens the search of the tab");
		assert.match(at("│ canary"), /│ canary +1\/\d+ +│/, `which counts its matches as the word is typed:\n${at("│ canary")}`);
		has(at("No shell window is open"), " COMMANDS ", "Escape and a digit as one key is the two keys: the commands mode, and that tab");
		const copied = result.osc.filter((sequence) => sequence.startsWith("52;c;")).map((sequence) => Buffer.from(sequence.slice(5), "base64").toString("utf8"));
		assert.ok(copied.some((text) => text.length > 200), "/copy session went to the clipboard");
		assert.equal(copied.at(-1), "› say: canary bird", `what was dragged over is copied, without the margin and the edge of its block: ${JSON.stringify(copied.at(-1))}`);
	} finally {
		await server.close();
	}
});

test("screen: a question waits in the strip and is answered on the line; the reading of a long prompt is shown as it goes", async () => {
	const root = makeProject("screen-ask", { git: false });
	const server = await startStandIn({ progress: { total: 30_000, cache: 2000, steps: 8, stepMs: 250 } });
	try {
		ok(await carto(root, server, [], { input: "" }), "set up");
		const result = await cartoOnScreen(root, server, [], [
			["Type a message", "ask: Which colour? | red | blue"],
			[" tok/s · writing in", "", false],
			["waiting for your answer", "2"],
			// While a task works, the Context tab shows what the task sees.
			["The user answered: blue", "task: read: a.txt\\nread: README.md"],
			["→ task ›", "<ESC>", false],
			["COMMANDS", "5", false],
			["What the running task sees", "", false],
			["What the main agent sees", "i", false],
			["Esc for commands", "/quit"],
			[1, "", false],
		], { rows: 34 });
		if (result === undefined) return "python3 is needed for a terminal";
		const reading = result.shots.find((shot) => shot.includes(" tok/s · writing in"));
		assert.match(reading, /\n[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] working · reading [\d.]+k of 28k new [▮▯]{8} \d+% · \d+ tok\/s · writing in ~\d+ s · \d+s\n/, `while the server reads a long prompt, the strip says how far it is:\n${reading}`);
		const asked = result.shots.find((shot) => shot.includes("waiting for your answer"));
		has(asked, "? Which colour?\n    1  red\n    2  blue\n", "the question stands in Chat");
		assert.match(asked, /\n\? waiting for your answer since \d\d:\d\d · type it below\n/, `and the strip says that the agent waits:\n${asked}`);
		assert.match(asked, /\n\? {2}your answer\n*$/, "the place to type is for the answer");
		assert.deepEqual(resultsOf(server, "ask"), ["The user answered: blue"], "the answer reaches the agent");
		const tasks = result.shots.find((shot) => shot.includes("What the running task sees"));
		assert.ok(tasks, `while a task runs, the Context tab shows the task's window:\n${result.shots.join("\n────\n")}`);
		has(tasks, "The task's brief  You are now the task", "with the brief where the main agent's context ends");
		assert.ok(result.shots.some((shot) => shot.includes("What the main agent sees")), "and the main agent's again when the task is over");
		assert.ok(server.requests.every((request) => request.return_progress === true), "every request asks the server to say how far it is");
	} finally {
		await server.close();
	}
});

test("repeat: a reply that writes the same thing over and over is cut off; the agent gets one more try, then is stopped", async () => {
	const root = makeProject("repeat", { git: false });
	const server = await startStandIn({ tokenDelayMs: 3 });
	try {
		const result = await carto(root, server, [], { input: lines("spam: ha", "spam always: la", "task: read: a.txt\\nspam: zz", "say: after") });
		ok(result, "a session with a model that loses its way");
		has(result.stdout, `› spam: ha\n! The agent's reply was repeating itself ("ha", 27 times over). Cartographer cut it off and lets the agent try once more.\n`, "the reply is cut off and the user is told");
		const told = server.requests.find((request) => rawText(request.messages.at(-1)).startsWith("<cartographer>\nWritten by Cartographer, not by the user. Nobody typed this. Your last reply was cut off, because it was writing the same text over and over (\"ha\", 27 times over). What it held is lost.\n\nGo on from where you were, with a short reply: one call, or a few sentences.\n</cartographer>"));
		assert.ok(told, "the agent is told, and gets one more try");
		hasNot(JSON.stringify(told.messages), "ha ha ha", "what was cut off is not in its context");
		has(result.stdout, "\nRecovered.\n", "which it uses");
		assert.match(result.stdout, /› spam always: la\n! The agent's reply was repeating itself \("la", 27 times over\)\. Cartographer cut it off and lets the agent try once more\.\n[^\n]*\n! The agent's reply was repeating itself \("la", 27 times over\)\. Cartographer cut it off again, and stopped the agent: say how it should go on\. If this keeps happening, look at the model's sampling settings\.\n/, `the second time in a row, the agent is stopped:\n${result.stdout}`);
		has(result.stdout, `! The task's reply was repeating itself ("zz", 27 times over). Cartographer cut it off and lets the agent try once more.\n`, "a task's reply is watched the same way");
		has(result.stdout, "◂ task stopped\n", "its task is stopped with it");
		assert.ok(server.requests.some((request) => rawText(request.messages.at(-1)).includes("The reply of the task that was running was cut off") && rawText(request.messages.at(-1)).includes("If the task's work is still needed, start it again with a narrower brief.")), "and the main agent is told what happened to it");
		has(result.stdout, "› say: after\nafter\n", "the session goes on");

		configure(root, { repeatCut: false });
		const off = await carto(root, server, [], { input: lines("spam: ho") });
		hasNot(off.stdout, "repeating itself", "repeatCut false switches it off");
	} finally {
		await server.close();
	}
});

test("model: /model lists what the server serves, switches by name or by number, and a stored model never bricks the session", async () => {
	const root = makeProject("model");
	const server = await startStandIn({ models: ["model-a", "model-b"] });
	try {
		const first = await carto(root, server, ["--model", "model-a"], { input: lines("say: hi", "/model", "/model 2", "/status") });
		ok(first, "the first run");
		has(first.stdout, "  Models  on model-a  ·  the server serves:\n    1  model-a  ← on\n    2  model-b\n", "/model lists the models the server serves, and which is on");
		has(first.stdout, "● model  model-a → model-b\n", "/model 2 switches by number");
		has(first.stdout, "· model model-b · idle\n", "/status says which model the session is on");
		const under = await carto(root, server, ["--model", "model-b"], { input: lines("/status") });
		ok(under, "resumed under the model the settings now name");
		has(under.stdout, "· model model-b · idle\n", "the model stored in the session does not brick it");
		const back = await carto(root, server, ["--model", "model-a"], { input: lines("/status") });
		ok(back, "resumed under the first model again");
		has(back.stdout, "· model model-a · idle\n", "the settings decide which model the session is on at each start");
		const wrong = await carto(root, server, ["--model", "model-c"], { input: lines("/status") });
		assert.notEqual(wrong.code, 0, "a model the server does not serve is refused at the start");
		has(wrong.stderr, 'The model server has no model named "model-c"', "and says what is served");
		const bad = await carto(root, server, ["--model", "model-a"], { input: lines("/model 9") });
		ok(bad, "a number off the list");
		has(bad.stdout, 'The server has no model "9". It serves: model-a, model-b. /model lists them.', "and says what is served");
	} finally {
		await server.close();
	}
});

test("the user's hands: /shelve, /unshelve, /fold, /recall and /send do for the user what the agent's calls do", async () => {
	const root = makeProject("hands");
	writeFileSync(join(root, "notes.txt"), "alpha\nbeta\ngamma\n");
	const server = await startStandIn();
	try {
		const result = await carto(root, server, ["--no-bwrap"], { input: lines(
			planMessage(RUN_ITEM),
			"/approve",
			`task(p1): shell[window=run,wait=0]: while :; do echo beat; sleep 0.2; done\nshell: echo from run`,
			"/shelve notes.txt",
			"/unshelve notes.txt",
			"/unshelve notes.txt",
			"/fold t1",
			"/fold t1",
			"/recall t1",
			"/recall nope",
			"/send run echo typed by the user",
			"/send gone hi",
			"/archive t1",
			"/unarchive t1",
			"/delete t1",
			"/delete t1",
		) });
		ok(result, "the run");
		has(result.stdout, "notes.txt is marked for the shelf (about ", "/shelve marks a file for the shelf");
		has(result.stdout, "Taken off the shelf: notes.txt.", "/unshelve takes it off again");
		has(result.stdout, "notes.txt is not on the shelf. The shelf is empty.", "and says so when there is nothing to take");
		has(result.stdout, "out of view, the record line stands in its place", "/fold takes a report out of view");
		has(result.stdout, "t1 stands in its place again, in view.", "/recall brings it back");
		has(result.stdout, "There is no report nope. /context lists the kept ones.", "/recall of an unknown id says so");
		has(result.stdout, "typed into run: echo typed by the user", "/send types a line into a window that runs");
		has(result.stdout, 'There is no window "gone"', "/send to a window there is not says so");
		has(result.stdout, "t1 archived: the record line leaves the kept block, the report stays on disk, recall by id still finds it.", "/archive hides the line and keeps the report");
		has(result.stdout, "t1 back in the record", "/unarchive brings it back");
		has(result.stdout, "t1 deleted: the record line is gone and its file is gone from", "/delete removes record and file");
		has(result.stdout, "There is no report t1. /context lists the kept ones.", "deleting what is gone says so");
	} finally {
		await server.close();
	}
});

test("settings: yolo and bwrap start from the settings, and a switch while running is not remembered", async () => {
	const root = makeProject("switches");
	const server = await startStandIn();
	try {
		const plain = await carto(root, server, [], { input: lines("/status") });
		ok(plain, "a run with no settings of its own");
		hasNot(plain.stdout, YOLO_LINE, "yolo is off by default");
		hasNot(plain.stdout, "sandbox: OFF", "and the sandbox is whatever this machine can do");
		writeFileSync(join(root, ".atlas", "config.json"), JSON.stringify({ yolo: true, bwrap: false }));
		const set = await carto(root, server, [], { input: lines("/status") });
		ok(set, "the settings say yolo on and bwrap off");
		has(set.stdout, YOLO_LINE, "yolo comes from the settings");
		has(set.stdout, "sandbox: OFF · tasks run commands directly on this machine", "bwrap false starts with the sandbox off");
		const off = await carto(root, server, [], { input: lines("/yolo off", "/status") });
		ok(off, "/yolo off during the run");
		has(off.stdout, "approval: on · change items wait for /approve again", "and ends it for the run");
		const again = await carto(root, server, [], { input: lines("/status") });
		ok(again, "the next run");
		has(again.stdout, YOLO_LINE, "reads the settings again: the switch was never remembered");
	} finally {
		await server.close();
	}
});

test("screen: Hands lists the shelf and the reports with the agent's operations, and Shells has an Output view", async () => {
	const { handsView, shellsOutView } = await import("../src/screen/views.mjs");
	const { createChat } = await import("../src/screen/chat.mjs");
	const root = makeProject("hands-view");
	writeFileSync(join(root, "keep.txt"), "kept line\n");
	const brainDir = join(root, ".atlas");
	addRecord(brainDir, { id: "t1", at: Date.now(), mode: "look", brief: "Read the tree", report: "The tree has 5 files.", changed: 0 });
	updateContext(brainDir, (store) => {
		store.shelf.push({ path: "keep.txt" });
		store.dropped.push("t1");
	});
	const view = handsView({ root, brainDir });
	const titles = view.items.filter((item) => !item.plain).map((item) => item.key);
	assert.deepEqual(titles, ["shelf:keep.txt", "report:t1"], "the shelf, then the reports, each selectable");
	const report = view.items.find((item) => item.key === "report:t1");
	assert.equal(report.folded, true, "a report that is folded says so");
	has(report.head.map(([part]) => part).join(""), "t1", "with its record line");
	const shelf = view.items.find((item) => item.key === "shelf:keep.txt");
	assert.match(shelf.body(), /^== keep\.txt .{0,20}\n1  kept line$/, "opened, a shelved file is its text, numbered as the shelf keeps it");
	assert.deepEqual(view.items.filter((item) => item.plain && item.head[0][0].includes("The reports of finished work")).length, 1, "and a heading stands over each kind");

	// The operations behind the keys, as the terminal commands call them.
	assert.match(shelveForUser(root, brainDir, { shelfTokens: 1000 }, "keep.txt"), /marked for the shelf/, "shelving marks a file, again for one that is on it");
	assert.match(foldReports(brainDir, ["t1"]), /already out of view/, "a report that is folded folds no further");
	const said = recallReport(brainDir, "t1");
	assert.match(said, /stands in its place again/, "recall brings a folded report back into view");
	assert.match(unshelveForUser(brainDir, "keep.txt"), /Taken off the shelf/, "unshelve takes a file off");
	assert.throws(() => unshelveForUser(brainDir, "keep.txt"), /not on the shelf/, "and says so when it is not there");

	// Archive: the record line leaves what the collapse keeps, the report stays, recall still finds it.
	assert.match(archiveReports(brainDir, ["t1"]), /t1 archived/, "v archives a report out of the record");
	const front = writeFront(brainDir, root, { shelfTokens: 12_000, chatWindow: 8_000 }, { now: Date.now(), reason: "a test" });
	assert.ok(!front.text.includes("Read the tree"), "the kept block no longer lists the archived line:\n" + front.text);
	assert.match(unarchiveReports(brainDir, ["t1"]), /back in the record/, "v brings it back");
	const back = writeFront(brainDir, root, { shelfTokens: 12_000, chatWindow: 8_000 }, { now: Date.now(), reason: "a test" });
	has(back.text, "Read the tree", "and the record lists it again");
	const archived = handsView({ root, brainDir }).items.find((item) => item.key === "report:t1");
	assert.equal(archived.archived, false, "the view says it stands again");
	assert.match(deleteReports(brainDir, ["t1"]), /t1 deleted/, "d deletes a report for good");
	assert.ok(!existsSync(join(brainDir, "reports", "t1.md")), "and the file is gone with it");
	assert.equal(loadContext(brainDir).records.length, 0, "and the record holds it no more");
	assert.match(deleteReports(brainDir, ["t1"]), /There is no report t1/, "deleting what is gone says so");

	// The chat tab's messages: the user's and the agent's words can be said anew, tool work cannot.
	const chat = createChat({});
	chat.user("hello");
	chat.print("  A notice.\n");
	chat.seal();
	chat.entry(0, { model: [{ role: "assistant", content: [{ type: "text", text: "Here you are." }], stopReason: "end-turn", usage: {}, provider: "x", model: "x", api: "x", timestamp: 1 }] });
	const mine = chat.items[0];
	const printed = chat.items[1];
	const agent = chat.items.at(-1);
	assert.deepEqual([chat.editable(mine.key), chat.editable(printed.key), chat.editable(agent.key)], [true, false, true], "the user's words and the agent's are editable, what Cartographer printed is not");
	assert.equal(chat.revise(mine.key, "hello, said anew"), true, "a message is said anew");
	assert.equal(mine.text, "hello, said anew", "and the tab shows the new words");
	updateContext(brainDir, (store) => {
		store.chat.push({ who: "user", at: 1, text: "hello" });
	});
	assert.equal(reviseNote(brainDir, "hello", "hello, said anew"), true, "the talk the context keeps is rewritten to match an edit");
	assert.equal(loadContext(brainDir).chat.at(-1).text, "hello, said anew", "and the edited words are what it holds");
	assert.equal(chat.revise(mine.key, ""), false, "an empty message is not taken");
	assert.equal(chat.revise(printed.key, "nope"), false, "what cannot be edited is not");
	assert.equal(chat.revise(999, "nope"), false, "nor one that is not there");

	// The shells' Output view: a window's kept lines, the newest at the bottom, as a terminal emulator sees them.
	const { createWindows } = await import("../src/windows.mjs");
	const windows = createWindows({ root, brainDir, config: { shellRead: [], treeDepth: 1, windowTail: 10 }, runner: { off: true } });
	await windows.run("term", "echo from the window", { waitMs: 3000 });
	const out = shellsOutView({ session: { windows } }, "term");
	has(out.header[0].map(([part]) => part).join(""), "Output of term", "the view says which window it shows");
	has(out.items[0].head.map(([part]) => part).join(""), "from the window", "and shows what it printed");
	const nothing = shellsOutView({ session: { windows } }, "nope");
	has(nothing.header[0].map(([part]) => part).join(""), "Output of term", "a window there is not falls back to the newest");
	windows.shutdown();
});

test("pause: /pause and Ctrl-V hold everything new back from the agent, and let it go on", async () => {
	const root = makeProject("pause", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "" }), "set up");
		const first = await cartoOnTerminal(root, server, [], [
			["› ", "/pause"],
			["paused", "say: held while paused"],
			[1.2, "/pause"],
			["on again: what you wrote is sent now", ""],
			[1.5, ""],
		]);
		ok(first, "a session with a pause");
		has(first.screen, "[paused", "the prompt says the pause");
		has(first.screen, "(held: the agent is paused, 1 line waits · /pause or Ctrl-V lets them go)", "a line written while it is paused is held, and said to be");
		has(first.screen, "on again: what you wrote is sent now (1 line)", "and is sent when the pause is lifted");
		has(first.screen, "held while paused", "the agent answers it");
		assert.equal(server.requests.length, 1, "the held line reached the agent only when the pause was lifted");
		has(rawText(server.requests[0].messages.at(-1)), "held while paused", "as itself, not as a note");
		// Ctrl-V does the same, and lifts the pause while the agent works.
		const second = await cartoOnTerminal(root, server, [], [
			["› ", "\u0016"],
			["paused", "say: held by the key"],
			[1.2, "\u0016"],
			["on again", ""],
			[1.5, ""],
		]);
		ok(second, "a session with Ctrl-V");
		has(second.screen, "[paused", "Ctrl-V pauses");
		has(second.screen, "on again: what you wrote is sent now (1 line)", "and Ctrl-V again lets the held line go");
		assert.equal(server.requests.length, 2, "one request more, for the line the second pause held");
	} finally {
		await server.close();
	}
});

test("the books: /archive, /unarchive and /delete reach every book the agent keeps, and deleting says nothing to the agent", async () => {
	const root = makeProject("books-ops", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "" }), "set up");
		const brainDir = join(root, ".atlas");
		addRecord(brainDir, { id: "t1", at: Date.now(), mode: "look", brief: "Read the tree", report: "The tree has 5 files.", changed: 0 });
		writeFileSync(join(brainDir, "carto-ledger.json"), `${JSON.stringify({ version: 1, next: 2, items: [{ id: "g1", kind: "goal", text: "Keep the lights on", doneWhen: "they stay on", status: "open", added: "2026-01-01T00:00:00.000Z" }] }, null, "\t")}\n`);
		writeFileSync(join(brainDir, "carto-plan.json"), `${JSON.stringify({ version: 1, next: 2, items: [{ id: "p1", mode: "change", text: "Run things" }] }, null, "\t")}\n`);
		writeFileSync(join(brainDir, "carto-atlas.json"), `${JSON.stringify({ nodes: [{ name: "alpha", gist: "First.", links: ["beta"] }, { name: "beta", gist: "Second." }] }, null, "\t")}\n`);
		writeFileSync(join(brainDir, "carto-proposals.json"), `${JSON.stringify({ next: 2, items: [{ id: "x1", action: "edit", target: "approach", text: "Be brief.", why: "shorter replies", at: Date.now() }] }, null, "\t")}\n`);
		const result = await carto(root, server, [], { input: lines("/archive g1 p1", "/ledger", "/plan", "/unarchive p1", "/delete g1", "/delete beta", "/atlas", "/delete alpha x1 zz", "/delete t1") });
		ok(result, "the commands run");
		has(result.stdout, "g1 archived: the goal leaves the ledger as the agent reads it", "/archive archives a ledger entry");
		has(result.stdout, "p1 archived: the item leaves the plan as the agent reads it", "and a plan item");
		has(result.stdout, "(1 archived entry not shown; /unarchive ID brings one back)", "/ledger hides the archived one and says how many");
		hasNot(result.stdout, "Keep the lights on", "the archived entry is not shown");
		has(result.stdout, "(1 archived item not shown; /unarchive ID brings one back)", "/plan hides the archived one too");
		hasNot(result.stdout, "Run things", "the archived item is not shown");
		has(result.stdout, "p1 is back in the plan as the agent reads it.", "/unarchive brings a row back");
		has(result.stdout, "g1 is gone for good: the goal is out of the ledger, and nothing of it is said to the agent.", "/delete takes a ledger entry away for good");
		has(result.stdout, "beta is gone for good: the node is out of the graph, and 1 link to it went with it", "/delete takes a node away, and its links with it");
		has(result.stdout, "alpha is gone for good: the node is out of the graph", "and another");
		has(result.stdout, "x1 is forgotten: the proposal is out of the book, and nothing of it is said to the agent.", "/delete forgets a prompt proposal");
		has(result.stdout, "There is no zz. a report is t1", "an id that names nothing is refused, with the books named");
		has(result.stdout, "t1 deleted: the record line is gone", "a report goes by the words of the context store");
		assert.ok(!existsSync(join(brainDir, "reports", "t1.md")), "and the report's file is gone with it");
		const atlas = JSON.parse(readFileSync(join(brainDir, "carto-atlas.json"), "utf8"));
		assert.deepEqual([atlas.nodes.map((node) => node.name), atlas.nodes.flatMap((node) => node.links)], [[], []], "the graph holds neither node nor link");
		assert.equal(JSON.parse(readFileSync(join(brainDir, "carto-ledger.json"), "utf8")).items.length, 0, "the ledger holds neither");
		// Not one word to the agent: archiving and deleting are the user's hands on what the agent keeps.
		assert.equal(server.requests.length, 0, "the agent is sent nothing through all of it");
	} finally {
		await server.close();
	}
});

test("screen: Ctrl-C clears what is typed; twice on the empty line leaves; Ctrl-X says nothing runs", async () => {
	const root = makeProject("screen-keys", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "" }), "set up");
		const result = await cartoOnScreen(root, server, [], [
			// Typed but not sent: the Enter that would send it is held back.
			["Type a message", "hello there", false],
			["hello there", "<CTRLC>", false],
			["type a message, or /help", "", false],
			[0.3, "<CTRLX>", false],
			["nothing runs: the agent rests", "", false],
			// With the line standing empty, the first Ctrl-C asks, the second, soon after, leaves.
			[0.3, "<CTRLC>", false],
			["Ctrl-C again to leave", "<CTRLC>", false],
			[1, "", false],
		], { rows: 24 });
		if (result === undefined) return "python3 is needed for a terminal";
		const cleared = result.shots.find((shot) => shot.includes("type a message, or /help"));
		assert.ok(cleared, `the line is cleared:\n${result.shots.join("\n────\n")}`);
		hasNot(cleared, "hello there", "and what was typed is gone");
		assert.ok(result.shots.some((shot) => shot.includes("nothing runs: the agent rests")), "Ctrl-X at rest says so, and says nothing to the agent");
		assert.ok(result.shots.some((shot) => shot.includes("Ctrl-C again to leave")), "the first Ctrl-C on the empty line asks");
		has(result.shots.at(-1), "Ctrl-C again to leave", "the second leaves, and the conversation stands on the screen");
		assert.equal(server.requests.length, 0, "what was cleared never reached the agent");
	} finally {
		await server.close();
	}
});

test("screen: in Requests, a approves, n turns down, and d forgets a request without a word to the agent", async () => {
	const root = makeProject("screen-requests", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "" }), "set up");
		const brainDir = join(root, ".atlas");
		writeFileSync(join(brainDir, "carto-ledger.json"), `${JSON.stringify({ version: 1, next: 2, items: [{ id: "q1", kind: "question", text: "Blue or red?", status: "open", added: "2026-01-01T00:00:00.000Z" }] }, null, "\t")}\n`);
		writeFileSync(join(brainDir, "carto-plan.json"), `${JSON.stringify({ version: 1, next: 2, items: [{ id: "p1", mode: "change", text: "Run things" }] }, null, "\t")}\n`);
		writeFileSync(join(brainDir, "carto-proposals.json"), `${JSON.stringify({ next: 2, items: [{ id: "x1", action: "edit", target: "approach", text: "Be brief.", why: "shorter replies", at: Date.now() }] }, null, "\t")}\n`);
		const result = await cartoOnScreen(root, server, [], [
			[0.5, "<ESC>", false],
			["COMMANDS", "2", false],
			["Atlas", "]", false],
			["Ledger", "]", false],
			["Plan", "]", false],
			// A refresh selects the first row by itself: a approves p1 where it stands.
			["3 requests wait for you", "a", false],
			["approved p1", "", false],
			// The approve left the session on the Chat tab, typing; go back to the rows.
			[2.2, "<ESC>", false],
			["COMMANDS", "2", false],
			["2 requests wait for you", "n", false],
			["q1 turned down", "", false],
			[2.2, "<ESC>", false],
			["COMMANDS", "2", false],
			["1 request waits for you", "d", false],
			["Press d again: x1 is forgotten", "d", false],
			["Nothing waits for you", "<ESC>", false],
			[0.4, "/quit"],
		], { rows: 30 });
		if (result === undefined) return "python3 is needed for a terminal";
		const asked = result.shots.find((shot) => shot.includes("3 requests wait for you"));
		assert.ok(asked, `the requests view shows:\n${result.shots.join("\n────\n")}`);
		has(asked, "a approves it · n turns it down (the agent is told) · d forgets it without a word to the agent", "the view says what the keys do");
		assert.ok(result.shots.some((shot) => shot.includes("Press d again: x1 is forgotten")), `the first d asks, in the words of a forget:\n${result.shots.join("\n────\n")}`);
		const gone = result.shots.find((shot) => shot.includes("Nothing waits for you"));
		assert.ok(gone, `the forgotten request leaves the view:\n${result.shots.join("\n────\n")}`);
		has(gone, "Nothing waits for you. The agent goes on with whatever does not depend on an answer.", "the view says what is left");
		// The approve and the deny were sent; the forget was not.
		const said = server.requests.map((request) => rawText(request.messages.at(-1)));
		assert.equal(said.filter((text) => text.includes("I approved p1")).length, 1, "a approved the change item, and the agent is told");
		assert.equal(said.filter((text) => text.includes("I turned down q1")).length, 1, "n turned the question down, and the agent is told");
		assert.equal(server.requests.length, 2, "and the forget says nothing to the agent");
		const ledger = JSON.parse(readFileSync(join(brainDir, "carto-ledger.json"), "utf8"));
		assert.equal(ledger.items[0].status, "done", "the question was closed by the deny");
		assert.equal(JSON.parse(readFileSync(join(brainDir, "carto-proposals.json"), "utf8")).items.length, 0, "the proposal is out of the book");
	} finally {
		await server.close();
	}
});

test("screen: d in the Context window takes a message of yours out of the talk the collapse keeps, and out of view", async () => {
	const root = makeProject("screen-delete", { git: false });
	const server = await startStandIn();
	try {
		ok(await carto(root, server, [], { input: "" }), "set up");
		const result = await cartoOnScreen(root, server, [], [
			["Type a message", "say: hello there"],
			["hello there", "", false],
			[0.8, "<ESC>", false],
			["COMMANDS", "5", false],
			["What the main agent sees", "j", false],
			[0.2, "j", false],
			// The front block rides inside the first message of the user: three j's from the system prompt reach your words.
			[0.2, "j", false],
			[0.2, "d", false],
			["Press d again: the message goes for good", "d", false],
			["deleted from the talk", "", false],
			[2.2, "/quit"],
		], { rows: 30 });
		if (result === undefined) return "python3 is needed for a terminal";
		assert.ok(result.shots.some((shot) => shot.includes("Press d again: the message goes for good")), `the first d asks:\n${result.shots.join("\n────\n")}`);
		assert.ok(result.shots.some((shot) => shot.includes("deleted from the talk the collapse keeps")), `the second carries it out:\n${result.shots.join("\n────\n")}`);
		const store = JSON.parse(readFileSync(join(root, ".atlas", "carto-context.json"), "utf8"));
		assert.ok(!store.chat.some((entry) => entry.text.includes("say: hello there")), `the talk the collapse keeps holds neither:\n${JSON.stringify(store.chat)}`);
		assert.ok(store.chat.some((entry) => entry.text.includes("hello there")), "what the agent said to you stays");
		hasNot(result.shots.at(-1), "say: hello there", "the part stands out of the window, and out of the conversation");
	} finally {
		await server.close();
	}
});

async function until(condition, what, timeoutMs = 15_000) {
	const limit = timeoutMs * SLOW;
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > limit) throw new Error(`timed out waiting until ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

// ─── The run ────────────────────────────────────────────────────────────────
// Tests are independent: each makes its own project and its own stand-in server, so they run several at a
// time — `--jobs N` (or CARTO_TEST_JOBS, or `-j N`) says how many, `npm test` lets the defaults decide:
// one per core to a cap of 8. A test marked `alone` runs with none beside it, so batches keep the order.
// One line per test, whatever the moment it ended on, so the log reads the same as ever: ok, skip, FAIL.
let passed = 0;
let failed = 0;
let skipped = 0;
const strays = []; // rejections no test awaited: counted, so the run still ends, and red
process.on("unhandledRejection", (error) => strays.push(error));

const write = (text) => process.stdout.write(`${text}\n`);
const secs = (ms) => (ms >= 1000 ? `  (${(ms / 1000).toFixed(1)} s)` : "");
const chosen = tests.filter((t) => only === undefined || t.name.includes(only));
const batches = [];
for (const t of chosen) {
	const last = batches.at(-1);
	if (t.alone) batches.push({ alone: true, tests: [t] });
	else if (last !== undefined && !last.alone) last.tests.push(t);
	else batches.push({ alone: false, tests: [t] });
}
for (const batch of batches) {
	const list = batch.tests;
	let at = 0;
	const runOne = async ({ name, run: body }) => {
		const start = Date.now();
		try {
			const note = await body();
			if (typeof note === "string") {
				skipped++;
				write(`skip  ${name}  (${note})`);
			} else {
				passed++;
				write(`ok    ${name}${secs(Date.now() - start)}`);
			}
		} catch (error) {
			failed++;
			write(`FAIL  ${name}\n      ${String(error?.message ?? error).split("\n").join("\n      ")}`);
		}
	};
	// One worker pulls the next test as soon as it is free; a batch of one runs by itself, as it asked.
	await Promise.all(Array.from({ length: Math.min(JOBS, list.length) }, async () => {
		while (at < list.length) await runOne(list[at++]);
	}));
}
for (const error of strays) {
	failed++;
	write(`FAIL  (a rejection no test awaited)\n      ${String(error?.message ?? error).split("\n").join("\n      ")}`);
}
rmSync(scratch, { recursive: true, force: true });
write(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
await new Promise((resolve) => setImmediate(resolve));
process.exit(failed === 0 ? 0 : 1);
