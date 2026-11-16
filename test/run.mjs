// Integration tests: the ledger, the plan, checkpoints, shell windows, wakes, time, the atlas, the
// assessment, the screen's pieces, and a launch through a symlink.
// They run the real `carto` command in throwaway project folders against the stand-in
// server (test/stand-in.mjs), so no model is needed. Fast: all of these run in about a minute.
//
//   npm test -- kill    only tests whose name contains "kill"
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { droppable, dressTask, KEPT_AS, parseLines, ShelfError, shelfLabel, stepsOf, supersededBy, withoutTags } from "../src/context.mjs";
import { bookTool } from "../src/tools/book.mjs";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { TASK_HEADER } from "../src/prompt.mjs";
import { changeRecord, changesBetween, checkpoint, isIgnored, lastChange, undo } from "../src/checkpoints.mjs";
import { ASSESSMENT_MAX, saveAssessment } from "../src/assessment.mjs";
import { applyAtlasOp, AtlasError, DETAIL_MAX, GIST_MAX, loadAtlas, nodeChanges, nodeHashes, NODES_MAX, renderOutline, saveAtlas, staleNodes } from "../src/atlas.mjs";
import { applyOp, LedgerError, loadLedger, OPEN_MAX, renderLedger, saveLedger, TEXT_MAX } from "../src/ledger.mjs";
import { applyAdd } from "../src/ops.mjs";
import { applyPlanOp, authorize, ITEM_MAX, loadPlan, openOnce, PlanError, planSummary, renderPlan, savePlan, YOLO_LINE } from "../src/plan.mjs";
import { withoutAdditions, withTimes } from "../src/request.mjs";
import { stateBlock, windowsBlock, withoutState, withoutWindows, withState } from "../src/state.mjs";
import { ago, clock, STAMP, stamp, took } from "../src/time.mjs";
import { loadTop, noteAssessed, pin, sinceTop, topPath, withoutTop, withTop } from "../src/top.mjs";
import { drawTree, treeSection } from "../src/tree.mjs";
import { ChangeError, confineWrite, editOne, writeOne } from "../src/tools/change.mjs";
import { confine, listProject, LookError, projectFiles, readOne, searchProject } from "../src/tools/look.mjs";
import { findProject, setUpBrain } from "../src/project.mjs";
import { findSandbox, HEAD_LINES, HEAD_MAX, LINE_MAX, Output, TAIL_LINES, TAIL_MAX } from "../src/sandbox.mjs";
import { describeCall, describeResult, WAKE_BURST } from "../src/terminal.mjs";
import { isNote, wakeNote, withoutQuietWakes } from "../src/wake.mjs";
import { createWakes, NOTE_MAX, WakeError, wakesPath, WAKES_MAX } from "../src/wakes.mjs";
import { createWindows, findScript, KEEP_LINES, WindowError } from "../src/windows.mjs";
import { startStandIn } from "./stand-in.mjs";
import { RECORD } from "../src/voice.mjs";
import { USER_NAME } from "../src/user.mjs";

/** The first line of every block the harness writes; the anchor the strip patterns match. */
const ESC = RECORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CORE = dirname(dirname(fileURLToPath(import.meta.url)));
const CARTO = join(CORE, "bin", "carto");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "carto-test-")));
const only = process.argv[2];

const tests = [];
const test = (name, run) => tests.push({ name, run });
/** Write the project's config by hand (tests use it to switch features off). */
const configure = (root, config) => {
	mkdirSync(join(root, ".brain"), { recursive: true });
	writeFileSync(join(root, ".brain", "config.json"), JSON.stringify(config));
};
const NO_WINDOWS = () => (findScript() ? undefined : "the script program (util-linux) is needed for a shell window");
const NO_SANDBOX = () => (findSandbox().ok ? undefined : `no sandbox on this machine: ${findSandbox().why}`);
/** The windows manager for one project, as carto builds it. */
const windowsOf = (root, brainDir, { mode = "sandbox", read = [] } = {}) => createWindows({ root, brainDir, config: { shellRead: read }, runner: { mode, available: findSandbox() } });
const LOOP = (file) => `while :; do echo $(date +%s%N) > ${file}; sleep 0.05; done`;
async function beating(file) {
	const before = readFileSync(file, "utf8");
	await new Promise((resolve) => setTimeout(resolve, 400))
	return readFileSync(file, "utf8") !== before;
}

/** A throwaway project with a few files. `git: true` makes it a repository. */
function makeProject(name, { git = true } = {}) {
	const root = join(scratch, name);
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
		const child = spawn(command, args, { cwd, env: { ...process.env, CARTO_SERVER: "", CARTO_MODEL: "", CARTO_CONFIG: join(scratch, "no-such-config.json"), ...env }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
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

const ok = (result, what) => assert.equal(result.code, 0, `${what}: carto should exit 0, got ${result.code} ${result.signal ?? ""}\n${result.all}`);
const has = (text, part, what) => assert.ok(text.includes(part), `${what}: expected to find ${JSON.stringify(part)} in:\n${text}`);
const hasNot = (text, part, what) => assert.ok(!text.includes(part), `${what}: did not expect ${JSON.stringify(part)} in:\n${text}`);
/** A message's text as the server received it, state block included. */
const rawText = (message) => (typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join(""));
/** A message's text as it is stored in the conversation: without what Cartographer adds to a request on its way out. */
const messageText = (message) => withoutAdditions(rawText(message));
/** The state block a request carried, or undefined. */
const stateOf = (request) => new RegExp(`<state>\n${ESC}[\\s\\S]*\n</state>`).exec(rawText(request.messages.at(-1)))?.[0];
/** The windows block a request carried at its very end, or undefined. */
const windowsIn = (request) => new RegExp(`<windows>\n${ESC}[\\s\\S]*\n</windows>$`).exec(rawText(request.messages.at(-1)))?.[0];
/** How many windows blocks a request holds in all its messages. */
const windowsCount = (request) => request.messages.map(rawText).join("\n").split(`<windows>\n${RECORD}`).length - 1;
/** The state block without its "Commands" paragraph, which is there only when commands do not run in the sandbox. */
const ledgerState = (request) => stateOf(request)?.replace(/\nCommands\n[^\n]*\n\n/, "\n");
/** How many state blocks a request holds in all its messages. */
const stateCount = (request) => request.messages.map(rawText).join("\n").split(`<state>\n${RECORD}`).length - 1;
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
		const result = await run(CARTO, ["--url", server.url, "--model", "anything", "-p", "say: hi || sleep"], { cwd: root });
		ok(result, "a name the lone server does not list");
		has(result.stdout, "context 8192 tokens (the server's limit; the settings say 100000)", "the smaller context size is used and stated");
		has(result.stdout, "of 8.2k tokens", "and shown in the context line");
	} finally {
		await server.close();
	}
});

test("prepend: the user's markdown in the brain is read before the system prompt", async () => {
	const root = makeProject("prepend", { git: false });
	configure(root, { initiate: false });
	writeFileSync(join(root, ".brain", "PREPEND.md"), "FROM THE USER: never say the word banana.\n");
	const server = await startStandIn();
	try {
		const result = await run(CARTO, ["--url", server.url, "--model", "stand-in", "-p", "say: hi || sleep"], { cwd: root });
		ok(result, "one shot");
		const system = rawText(server.requests[0].messages[0]);
		has(system, "FROM THE USER: never say the word banana.", "the prepend is in the request");
		const at = system.indexOf("FROM THE USER");
		const prompt = system.indexOf("I am Cartographer, one agent");
		assert.ok(at >= 0 && prompt > at, `the prepend stands before the prompt:\n${system.slice(0, 400)}`);
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
	assert.deepEqual(findProject(join(top, "src", "deep")), { root: join(top, "src", "deep"), why: "here" }, "a brain folder without a session is not a brain");
	writeFileSync(join(top, ".brain", "session.sqlite"), "");
	assert.deepEqual(findProject(join(top, "src", "deep")), { root: top, why: "brain" }, "a brain above");
	assert.deepEqual(findProject(join(top, "vendor", "lib", "src")), { root: join(top, "vendor", "lib"), why: "git" }, "a repository nearer than the brain wins");

	// What setUpBrain does to a .gitignore that is already there.
	assert.equal(readFileSync(join(top, ".brain", ".gitignore"), "utf8"), "session.sqlite*\ncarto.lock\ncheckpoints.git/\nhome/\ncarto-context.json\nreports/\nshelf/\ncarto-wakes.json\nexport/\n", "a new one");
	writeFileSync(join(top, ".brain", ".gitignore"), "notes.txt");
	setUpBrain(top);
	assert.equal(readFileSync(join(top, ".brain", ".gitignore"), "utf8"), "notes.txt\nsession.sqlite*\ncarto.lock\ncheckpoints.git/\nhome/\ncarto-context.json\nreports/\nshelf/\ncarto-wakes.json\nexport/\n", "missing lines are added to an existing one");
	setUpBrain(top);
	assert.equal(readFileSync(join(top, ".brain", ".gitignore"), "utf8"), "notes.txt\nsession.sqlite*\ncarto.lock\ncheckpoints.git/\nhome/\ncarto-context.json\nreports/\nshelf/\ncarto-wakes.json\nexport/\n", "and not twice");
});

test("launch: a legacy .atlas brain is renamed to .brain, and its checkpoints exclusion follows", () => {
	const top = join(scratch, "legacy");
	mkdirSync(join(top, ".atlas", "checkpoints.git", "info"), { recursive: true });
	writeFileSync(join(top, ".atlas", "session.sqlite"), "");
	writeFileSync(join(top, ".atlas", "carto-ledger.json"), "{}\n");
	writeFileSync(join(top, ".atlas", "checkpoints.git", "info", "exclude"), "/.atlas/\nnode_modules/\n");
	assert.deepEqual(findProject(top), { root: top, why: "brain" }, "the legacy folder still counts as a brain");
	const setup = setUpBrain(top);
	assert.equal(setup.migrated, true, "the folder is renamed");
	assert.equal(setup.created, false, "and it is the same brain, not a new one");
	assert.ok(!existsSync(join(top, ".atlas")), "the old folder is gone");
	assert.ok(existsSync(join(top, ".brain", "session.sqlite")), "the brain stands at the new path");
	assert.ok(existsSync(join(top, ".brain", "carto-ledger.json")), "with its files");
	assert.equal(readFileSync(join(top, ".brain", "checkpoints.git", "info", "exclude"), "utf8"), "/.brain/\nnode_modules/\n", "the checkpoint exclusion carries over");
	assert.equal(setUpBrain(top).migrated, false, "and the migration happens once");
});

test("ledger: a call that is run again after a crash is not applied twice", async () => {
	const dir = join(scratch, "ledger-rerun");
	mkdirSync(dir, { recursive: true });
	const tool = bookTool({ root: dir, brainDir: dir, config: {}, engine: undefined, gate: undefined });
	const api = { taskId: "task-1", conversationId: ROOT_CONVERSATION_ID, now: () => 0 };
	const first = await tool.execute({ target: "ledger", action: "add", operation: { kind: "note", text: "once" } }, api);
	assert.equal(first.output[0].text, "n1 added.\nOpen: no goals, no questions, 1 note.");
	const again = await tool.execute({ target: "ledger", action: "add", operation: { kind: "note", text: "once" } }, api);
	has(again.output[0].text, "These operations were already applied, before a restart.", "the rerun says so");
	assert.equal(loadLedger(dir).ledger.items.length, 1, "and adds nothing");
	await tool.execute({ target: "ledger", action: "add", operation: { kind: "note", text: "twice" } }, { ...api, taskId: "task-2" });
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
		"<state>\n" + RECORD + " This is the current state; it supersedes any earlier copy I carry.\n\nNow: Thu 1 Jan 2026, 09:05.\n\nLedger\nQuestions for " + USER_NAME + ":\n  q1  Which port?\n\nNo goal is set. Looking and answering questions is fine without one. I find out what " + USER_NAME + " wants to achieve. When we agree on it, I record it as a goal with a done-when line. I need not sit idle meanwhile: in the same reply I may start a task (no item, only reading) that maps a part of the project the graph says nothing about, and have what it finds recorded as nodes. What deserves a node, and when the graph is good enough to stop and wait, is mine to decide.\n</state>",
	);
});

// ─── The plan, change tasks, checkpoints ─────────────────────────────────────

const readPlan = (root) => JSON.parse(readFileSync(join(root, ".brain", "carto-plan.json"), "utf8"));
const planMessage = (...ops) => `plan: ${JSON.stringify(ops)}`;
const LOOK_ITEM = { action: "add", mode: "look", text: "See what is in the project" };
const WRITE_ITEM = { action: "add", mode: "change", text: "Write the roller" };
const README_ITEM = { action: "add", mode: "change", text: "Mention it in the README" };
/** Piped input: one message or command per line. */
const lines = (...parts) => `${parts.join("\n")}\n`;

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
	refuse(".brain/carto-plan.json", "is in .brain/, which is Cartographer's own folder");
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

	assert.match(writeOne(root, brain, "notes/a.txt", "one\ntwo\n"), /^Wrote notes\/a\.txt: 2 lines, a new file\. File id: f\d+ \(to read or change it: \{ "id": "f\d+" \}\)\.$/);
	assert.match(writeOne(root, brain, "notes/a.txt", "one\ntwo\nthree"), /^Wrote notes\/a\.txt: 3 lines, replacing a file of 2 lines\. File id: f\d+ /);
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
	assert.deepEqual([isIgnored(root, brain, "ignored.log"), isIgnored(root, brain, "src/math.js"), isIgnored(root, brain, ".brain/x"), isIgnored(root, brain, "a/node_modules/b.js")], [true, false, true, true], "what a checkpoint leaves out");

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

		result = await sh("echo kept > ~/cache.txt; touch .brain/x; echo x > .brain/home/y; touch .git/x; git status --short | head -1");
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

test("windows: a line reported before it had its newline is kept whole by the window", async () => {
	const skip = NO_WINDOWS();
	if (skip) return skip;
	const root = makeProject("windows-partial-line");
	const { brainDir } = setUpBrain(root);
	const mode = findSandbox().ok ? "sandbox" : "direct";
	const first = windowsOf(root, brainDir, { mode });
	try {
		const command = "printf 'aaaaa-bbbbb '; sleep 1; printf 'ccccc\\nnext\\n'";
		const report = await first.run("partial", command, { waitMs: 300 });
		assert.match(report.text, /aaaaa-bbbbb $/, "the call reported the unfinished line as far as it had come");
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const stored = first.read("partial", 20);
		assert.match(stored.text, /aaaaa-bbbbb ccccc/, "the window's own record keeps the whole line, not only the part that was not shown yet");
		const second = await first.wait("partial", { waitMs: 5_000 });
		assert.equal(second.text, "ccccc\nnext", "the follow-up report shows only what was not shown before");
	} finally {
		first.shutdown();
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
			"" + RECORD + " The shell windows as they are at this moment:",
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
			"A window keeps running what was started in it until it is stopped or closed. I close the ones nobody needs any more.",
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
			"" + RECORD + " Nobody typed this. It tells me what happened while I was not working.",
			"",
			"Window build: `make all` ended with exit 2 after 1 m 15 s.",
			"Window repl: `python` has printed nothing for a while and its last line has no line end, so it may be waiting for input. The line: >>> ",
			"",
			"I decide what this means for the goal and act on it. When nothing needs doing, I call `sleep` and write nothing: a turn in which I did nothing else is forgotten when the next such note comes.",
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

test("look: read gives the exact bytes, ranges, and says how to continue", () => {
	const root = makeProject("read-unit", { git: false });
	const whole = readOne(root, "src/math.js");
	assert.equal(whole, "== src/math.js (lines 1-4 of 4)\nexport function add(a, b) {\n  // MARKER-ONLY-IN-FILE\n  return a + b;\n}");
	// The default window is 1024 lines (2026-11-15): a fixture longer than the window exercises it.
	writeFileSync(join(root, "long2.txt"), Array.from({ length: 1500 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
	const start = readOne(root, "long2.txt");
	has(start, "== long2.txt (lines 1-1024 of 1500)", "the default is 1024 lines");
	has(start, "(476 more lines; continue with offset 1025)", "it says how to go on");
	const middle = readOne(root, "long.txt", 698, 50);
	assert.equal(middle, "== long.txt (lines 698-700 of 700)\nline 698\nline 699\nline 700");
	has(readOne(root, "long.txt", 900), "The file has 700 lines; line 900 does not exist.", "past the end");
	has(readOne(root, "src"), "This is a directory. Use `list`", "a directory");
	has(readOne(root, "nope.js"), "Not found. Use `list` or `search`", "a missing file");
	writeFileSync(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3]));
	has(readOne(root, "blob.bin"), "A binary file (4 B)", "a binary file");
	writeFileSync(join(root, "wide.txt"), `${"x".repeat(2500)}\n`);
	has(readOne(root, "wide.txt"), "…[line cut, 2500 characters]", "a very long line is cut and says so");
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

test("time: stamps, durations and ages are written one way", () => {
	const at = new Date(2026, 10, 10, 14, 5).getTime();
	assert.equal(stamp(at), "Tue 10 Nov 2026, 14:05");
	assert.match(stamp(new Date(2026, 0, 1, 0, 0).getTime()), new RegExp(`^${STAMP}$`), "the pattern matches what is written");
	assert.deepEqual([new Date(2026, 10, 10, 14, 5).getTime(), new Date(2026, 10, 10, 9, 0).getTime(), NaN].map(clock), ["14:05", "09:00", "--:--"], "hour and minute, as the collapsed block is stamped");
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
	mkdirSync(join(root, ".brain"));
	writeFileSync(join(root, ".brain", "note.txt"), "brain\n");
	const whole = treeSection(root).text;
	has(whole, "From the project root, 3 levels deep: 5 files in all.\nsrc/\n  deep/\n    er/  (1 file)\n  main.js\n  math.js\nREADME.md\nlong.txt", "the whole project");
	hasNot(whole, ".brain", "the brain is not part of the project");
	has(treeSection(root, { anchor: "src/", depth: 1 }).text, 'From src/ (the anchor I set), 1 level deep: 3 of the project\'s 5 files are under it. `atlas` with a tree operation and anchor "." returns to the project root.\nsrc/\n  deep/  (1 file)\n  main.js\n  math.js', "anchored");
	const lost = treeSection(root, { anchor: "gone" });
	has(lost.text, "The anchor was gone, which is no longer a folder with files in it.", "a folder that is gone is said");
	has(lost.text, "From the project root", "and the tree falls back to the root");
	has(treeSection(root, {}, { depth: 1 }).text, "From the project root, 1 level deep", "the default depth comes from the settings");
});

test("top: the copy is written at its moments and not otherwise, and goes in front of the first message", () => {
	const dir = join(scratch, "top-unit");
	mkdirSync(dir, { recursive: true });
	const at = new Date(2026, 10, 10, 14, 5).getTime();
	assert.deepEqual(pin(dir, { now: at, reason: "the first start" }), { changed: true });
	const text = loadTop(dir).text;
	assert.equal(
		text,
		"<project>\n" + RECORD + " My own records of this project, as they stood on Tue 10 Nov 2026, 14:05 (the first start). What was written since is listed in the state block at the end of the request.\n\nMy assessment\nNone written yet.\n\nMy graph (0 nodes)\nThe graph has no nodes yet.\n</project>",
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
	has(loadTop(dir).text, "My assessment\nA demo.\n\nMy graph (1 node)\n  c1  one  the first node\n</project>", "the assessment and the outline");
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

test("terminal: one line per call to the atlas and the assessment", () => {
	assert.equal(describeCall({ name: "book", arguments: { target: "atlas", action: "add", operation: { name: "dice" } } }), "book atlas add dice");
	assert.equal(describeCall({ name: "book", arguments: { target: "atlas", action: "confirm", ref: { namespace: "n-0123456789abcdef", kind: "atlas", id: "a" } } }), "book atlas confirm a");
	assert.equal(describeCall({ name: "book", arguments: { target: "assessment", action: "write", operation: { text: "x".repeat(1200) } } }), `book assessment write ${"x".repeat(69)}…`);
	const result = (details, text) => describeResult({ role: "toolResult", toolName: "book", isError: false, details: { target: "atlas", ...details }, content: [{ type: "text", text }] });
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
	const brainDir = join(root, ".brain");
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
	refusedWake(wakes, { note: "n" }, "Say what wakes me: `every` (seconds) for a time, `path` for a file or folder, or `window` for a shell window.");
	refusedWake(wakes, { note: "n", every: 59 }, "`every` is 59; it is a whole number of seconds from 60 to 604800. A wake costs a whole turn, so 1 m is the least.");
	refusedWake(wakes, { note: "n", every: 90.5 }, "`every` is 90.5");
	refusedWake(wakes, { note: "n", every: 8 * 24 * 3600 }, "from 60 to 604800");
	refusedWake(wakes, { note: "n", path: "a.txt", every: 10 }, "`every` is 10", "the least time between two wakes is bounded the same way");
	refusedWake(wakes, { note: "n", every: 60, times: -1 }, "`times` is -1");
	refusedWake(wakes, { note: "n", every: 60, times: 1.5 }, "`times` is 1.5");
	refusedWake(wakes, { note: "n", path: "a.txt", window: "main" }, "Give `path` or `window`, not both");
	refusedWake(wakes, { note: "n", path: "../elsewhere" }, 'is outside the project');
	refusedWake(wakes, { note: "n", path: "/etc/passwd" }, 'is outside the project');
	refusedWake(wakes, { note: "n", path: ".brain/carto-plan.json" }, "`.brain` is Cartographer's own folder and is not watched (the old `.atlas` folder is none either).");
	refusedWake(wakes, { note: "n", path: ".atlas/carto-plan.json" }, "`.brain` is Cartographer's own folder and is not watched (the old `.atlas` folder is none either).");
	refusedWake(wakes, { note: "n", every: 60, match: "ERROR" }, "`match` goes with `window`");
	assert.deepEqual(wakes.list(), [], "a refused wake is not set");
	for (let i = 0; i < WAKES_MAX; i++) wakes.set({ note: `number ${i}`, every: 60 });
	refusedWake(wakes, { note: "one more", every: 60 }, `${WAKES_MAX} wakes are set, which is the limit: w1, w2, w3, w4, w5, w6, w7, w8. Remove one first.`);
	assert.throws(() => wakes.remove("w99"), (error) => error instanceof WakeError && error.message === 'There is no wake "w99". Set: w1, w2, w3, w4, w5, w6, w7, w8.');
	// The note is clipped to the limit when it is too long, and the wake is set all the same.
	const clip = wakesAt("wakes-clip").open();
	assert.equal(clip.set({ note: "x".repeat(NOTE_MAX + 50), every: 60 }).note.length, NOTE_MAX, "the note clipped to the limit; the wake is set");
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
	assert.equal(wakeNote(folded).split("\n")[3], "Wake w1 (every 1 h): its time came, the last of 4 times since I was told. My note: every hour");

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
	assert.doesNotMatch(wakes.lines()[0], /last acted/);
	pass(120);
	wakes.acted();
	pass(600);
	assert.equal(wakes.lines()[0], "w1 · every 1 h, until removed · every hour · fired 7 times, last 12 m ago · last acted on 10 m ago · next in 48 m");
	wakes.begin(["w1"]);
	wakes.begin([]);
	pass(60);
	wakes.acted();
	assert.match(wakes.lines()[0], /last acted on 11 m ago/, "a turn the user started is not the wake's");
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

test("yolo: the prompt shows it for as long as it is on", async () => {
	const root = makeProject("yolo-prompt", { git: false });
	configure(root, { initiate: false });
	const server = await startStandIn();
	try {
		const result = await cartoOnTerminal(root, server, [], [["Set one up in", ""], ["Type a message", "/yolo on"], ["[yolo, waits] › ", "say: hi || sleep"], ["context ", "/yolo off"], ["approval: on", "/quit"]]);
		if (result === undefined) return "python3 is needed for a terminal";
		has(result.screen, "[yolo, waits] › say: hi", "the prompt after /yolo on");
		has(result.screen, "● approval: on · change items wait for /approve again", "and after /yolo off");
		has(result.screen, "[waits] › /quit", "the prompt is back to waiting for you");
	} finally {
		await server.close();
	}
});

// ─── Talking to the user, thinking, and calls that fail again and again ─────

const REMINDER = "<cartographer>\n" + RECORD + " My last message had no tool call.\n\nSo it is kept as a note to myself, and nobody else read it. If it was meant for " + USER_NAME + ", I say it with `chat`. If work is left, I go on with it. If nothing is left to do, I call `sleep`.\n</cartographer>";
const REMINDED = "◆ That reply had no tool call: it is a note the agent wrote to itself, not an answer to you. The agent goes on.\n";
/** The requests whose newest message is the reminder. */
const reminders = (server) => server.requests.filter((request) => messageText(request.messages.at(-1)).startsWith(REMINDER));

test("thinking: Ctrl-T hides and shows it on a terminal, and leaves what is being typed alone", async () => {
	const root = makeProject("thinking-key", { git: false });
	configure(root, { initiate: false });
	const server = await startStandIn();
	try {
		const result = await cartoOnTerminal(root, server, [], [
			["Set one up", ""],
			["Type a message.", "\x14", false],
			["thinking is hidden", "reason: a secret thought || say: Answer one. || sleep"],
			["context ", "half typed\x14", false],
			["thinking is shown", "\x15/quit"],
		]);
		if (result === undefined) return "python3 is needed for a terminal";
		has(result.screen, "Ctrl-T hides and shows its thinking.", "the key is named at the start");
		has(result.screen, "┊ thinking is hidden (Ctrl-T switches)", "Ctrl-T hides it");
		has(result.screen, "┊ thinking… (Ctrl-T shows it)\n", "a reply that thought says so in one line");
		has(result.screen, "┊ a secret thought\n┊ thinking is shown (Ctrl-T switches)\n", "Ctrl-T again shows what was held back");
		assert.match(result.screen, /thinking is shown \(Ctrl-T switches\)\n\[waits\] › half typed/, `what was being typed is put back on the prompt:\n${result.screen}`);
	} finally {
		await server.close();
	}
});

test("pause: a line written while the agent is held in its stream interrupts it, and is the next thing", async () => {
	const root = makeProject("pause-key", { git: false });
	configure(root, { initiate: false });
	// The stand-in holds the held reply open (after the role chunk); the freeze lands on that live stream. A line
	// written while paused lets the held stream go and starts fresh — only the newest message decides the hold,
	// so the fresh turn ("say: answered…") flows.
	const server = await startStandIn({ holdWhen: (body) => JSON.stringify(body.messages.at(-1)).includes("hold this please") });
	try {
		const result = await cartoOnTerminal(root, server, [], [
			["Set one up in", ""],
			["Type a message", "hold this please || say: gone || sleep"],
			[1, "\x16", false],
			["paused: the agent is held in its stream", "say: answered || sleep"],
			["read for this answer", "/quit"],
		]);
		if (result === undefined) return "python3 is needed for a terminal";
		has(result.screen, "paused: the agent is held in its stream, mid-sentence", "Ctrl-V holds the stream");
		const sent = server.requests.map((request) => JSON.stringify(request.messages));
		assert.ok(sent.some((entry) => entry.includes("hold this please")), "the first message started a turn");
		assert.ok(sent.some((entry) => entry.includes("say: answered")), "the line written while paused reached the agent as the next thing");
		assert.equal(server.requests.length, 2, "the held stream was let go, and the line started a fresh request");
	} finally {
		await server.close();
	}
});

test("pause: Ctrl-V again lets the very same reply go on — no second request is made", async () => {
	const root = makeProject("pause-resume", { git: false });
	configure(root, { initiate: false });
	// The held reply lets itself go 0.8 s in, while the stream is still frozen, so whether the release lands
	// before or after the unpause, the one same HTTP response must carry the whole reply to its end.
	const server = await startStandIn({ holdWhen: (body) => JSON.stringify(body.messages.at(-1)).includes("hold this please"), releaseAfterMs: 800 });
	try {
		const result = await cartoOnTerminal(root, server, [], [
			["Set one up in", ""],
			["Type a message", "hold this please || say: answered || sleep"],
			[0.8, "\x16", false],
			["paused: the agent is held in its stream", ""],
			[0.6, "\x16", false],
			["on again — the agent goes on with its stream", ""],
			["read for this answer", "/quit"],
		]);
		if (result === undefined) return "python3 is needed for a terminal";
		has(result.screen, "paused: the agent is held in its stream, mid-sentence", "Ctrl-V holds the stream");
		has(result.screen, "on again — the agent goes on with its stream", "Ctrl-V again lets the same stream go on");
		assert.equal(server.requests.length, 1, "the same HTTP response carried the whole reply; the freeze did not re-request");
		assert.ok(result.screen.includes("answered"), "the reply reached the screen after the resume");
	} finally {
		await server.close();
	}
});

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
	assert.equal(droppable([text("user", "<context>\n" + RECORD + " My context was collapsed" + "k".repeat(4000) + "\n</context>")]), 0, "the front block is what was kept already");

	// What Cartographer adds to a request is not part of the stored message.
	assert.equal(withoutAdditions("<context>\n" + RECORD + " x\n</context>\n\nhello"), "hello");
	assert.equal(withoutAdditions(`${USER_NAME}: hello\n\n[sent Thu 12 Nov 2026, 14:02]`), "hello", "the request-only speaker label and time come off");
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
	const dropped = dressTask(messages, { dropped: { s1: "I dropped this result." } });
	assert.match(dropped[4].content[0].text, /^\[s1: I dropped this result\. It was: read a\.js, about [\d,]+ tokens\. Call again if I need it\.\]$/);
	assert.equal(messages[4].content[0].text, big, "the stored messages are not changed");
});

test("context: read results are ephemeral — all but the newest leave one line, and the newest stands at the end of the request", async () => {
	const { dressReads, splitReadTail, withReadTail, withoutReadTail } = await import("../src/context.mjs");
	const { withoutAdditions } = await import("../src/request.mjs");
	const rawText = (message) => message.content[0].text;
	const text = (role, words, more = {}) => ({ role, content: [{ type: "text", text: words }], ...more });
	const convo = [
		text("user", "read two files"),
		{ role: "assistant", content: [{ type: "toolCall", id: "r1", name: "book", arguments: { target: "file", action: "read", path: "a.js" } }] },
		text("toolResult", "== a.js (lines 1-2 of 2)\n1  alpha\n2  beta", { toolName: "book", toolCallId: "r1" }),
		{ role: "assistant", content: [{ type: "toolCall", id: "r2", name: "book", arguments: { target: "ledger", action: "read" } }] },
		text("toolResult", "{ \"entries\": [] }", { toolName: "book", toolCallId: "r2" }),
		{ role: "assistant", content: [{ type: "toolCall", id: "r3", name: "book", arguments: { target: "file", action: "read", ref: { id: "f9" }, range: "1-40" } }] },
		text("toolResult", "== c.js (lines 1-40 of 300)\n1  gamma", { toolName: "book", toolCallId: "r3" }),
	];
	const { messages, tail } = dressReads(convo);
	// The earlier reads of any target are one line each; the newest one leaves its content for the tail.
	assert.match(rawText(messages[2]), /no longer in view — file read a\.js/);
	assert.match(rawText(messages[4]), /no longer in view — ledger read/);
	assert.match(rawText(messages[6]), /stands at the end of the request[^\n]*file read f9/);
	assert.equal(tail, "== c.js (lines 1-40 of 300)\n1  gamma");
	assert.equal(convo[2].content[0].text, "== a.js (lines 1-2 of 2)\n1  alpha\n2  beta", "the stored messages are not changed");
	// Deterministic: the same request is dressed the same way.
	assert.equal(dressReads(convo).tail, tail);
	// A non-read action is not a read.
	const noReads = [text("assistant", "thinking", {}), text("toolResult", "done", { toolName: "book", toolCallId: "x" })];
	assert.equal(dressReads(noReads).tail, undefined, "no reads, no tail");
	// A result already folded keeps the line it was folded under (it carries the id).
	const folded = [
		{ role: "assistant", content: [{ type: "toolCall", id: "r9", name: "read", arguments: { paths: ["d.js"] } }] },
		text("toolResult", "[s9: I dropped this result. It was: read d.js, about 40 tokens. Call again if I need it.]", { toolName: "read", toolCallId: "r9" }),
	];
	const dressedFolded = dressReads(folded);
	assert.equal(dressedFolded.messages[1].content[0].text, folded[1].content[0].text, "a folded result is left alone");
	assert.equal(dressedFolded.tail, undefined, "and there is nothing to move");
	// The tail is glued at the very end of the request, after everything else.
	const ended = withReadTail(messages, tail);
	const lastText = ended.at(-1).content.at(-1).text;
	assert.match(lastText, /<read-tail>\n== c\.js/);
	assert.deepEqual(splitReadTail(lastText), { text: rawText(messages.at(-1)), tail: `<read-tail>\n${tail}` });
	assert.equal(withoutReadTail(lastText), rawText(messages.at(-1)));
	assert.equal(withoutAdditions(lastText), withoutAdditions(rawText(messages.at(-1))), "and it comes off again like the other additions");
	// With an assistant at the end (no place to glue to), a message of its own carries the tail.
	const endedAssistant = withReadTail([...messages, text("assistant", "a note to myself")], tail);
	assert.equal(endedAssistant.at(-1).role, "user");
	assert.match(endedAssistant.at(-1).content[0].text, /<read-tail>/);
});

test("screen: a collapse of the main context leaves only the marker, and the agent's blocks fold open", async () => {
	const { createChat } = await import("../src/screen/chat.mjs");
	let clock = 1000;
	const chat = createChat({ now: () => clock });
	const out = (cols = 80) => chat.lines(cols).map((line) => line.spans.map(([part]) => part).join("")).join("\n");
	const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
	const reply = (content, stamp) => ({ model: [{ role: "assistant", content, timestamp: stamp }] });
	chat.print("Cartographer · /project\nbrain /project/.brain · model at server\n", { keep: true });
	chat.user("hello before");
	chat.entry(0, reply([call("c1", "chat", { text: "Hi." })], 1));
	chat.block("the state block — the time, the atlas, the ledger, the plan", "Ledger\n- g1 finish the roller\n\nPlan\np1 open");
	assert.match(out(), /the state block/, "a block folds to one line");
	assert.equal(out().includes("g1 finish the roller"), false, "and its content is not in view until it is opened");
	const before = chat.lines(80).find((line) => line.kind === "block");
	chat.toggle(before.item);
	assert.match(out(), /g1 finish the roller/, "opened, the content stands as the agent sees it");
	assert.equal(chat.textOf(before.item), "Ledger\n- g1 finish the roller\n\nPlan\np1 open", "and copies as it stands");
	// The collapse: everything of the conversation is out, the marker stands, the intro survives.
	chat.entry(0, { model: [{ role: "user", content: [{ type: "text", text: `<context>\n${RECORD} My context was collapsed\n</context>` }] }] }, "◆ context collapsed (you rested): about 9,000 → 800 tokens · kept 1 task record, 0 shelf items, 2 messages of talk  (/context shows it)\n");
	const after = out();
	assert.equal(after.includes("hello before"), false, "the messages the collapse dropped are out of the tab");
	assert.equal(after.includes("the state block"), false, "the blocks of the request as well");
	assert.match(after, /Cartographer · /, "the intro stays");
	assert.match(after, /context collapsed \(you rested\)/);
	assert.equal(after.includes("Hi."), false, "and what was said with `chat`");
});

test("screen: text is measured in cells, wrapped and painted to the width; a repeating tail is told from ordinary text", async () => {
	const { cut, fit, paint, repeats, short, span, width, wrap } = await import("../src/screen/text.mjs");
	assert.deepEqual([width("abc"), width("日本"), width("e\u0301"), width("│ ✓")], [3, 4, 1, 3], "wide characters take two cells, a combining mark none");
	assert.equal(fit("日本語", 5), "日本", "a wide character is not cut in half");
	assert.equal(cut("abcdefgh", 5), "abcd…");
	assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"], "breaks at spaces");
	assert.deepEqual(wrap("  indented text that is long", 14), ["  indented", "  text that is", "  long"], "keeps the indent");
	assert.deepEqual(wrap("abcdefghijkl", 5), ["abcde", "fghij", "kl"], "a word longer than a row is cut");
	assert.deepEqual(wrap("a\n\nb", 10), ["a", "", "b"], "line breaks stay");
	assert.equal(paint([["ab", "bold"], ["cdef", ""]], 4), "\x1b[1mab\x1b[0mc\x1b[2m…\x1b[0m", "a cut line ends with a mark, never in silence");
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
	assert.deepEqual([homeOf("write"), homeOf("book", { target: "file", action: "edit" }), homeOf("book", { target: "file", action: "read" }), homeOf("shell"), homeOf("plan"), homeOf("read")], [{ tab: "diff" }, { tab: "diff" }, undefined, { tab: "shells" }, { tab: "carto", view: "plan" }, undefined], "a write or file edit lives in Diff, a command in Shells, the plan in Carto; a read opens where it stands");

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
	// `book file edit` streams `oldText` and then `newText`; both show as they are written, and `newText` wins at equal length.
	chat.live(1, { timestamp: 9, content: [call("c9", "book", { target: "file", action: "edit", ref: { id: "f1" }, oldText: "print(1)" })] });
	has(text(), "  │ ✎ book file edit f1\n  │   │ print(1)", "book file edit shows oldText while newText has not started yet");
	chat.live(1, { timestamp: 9, content: [call("c9", "book", { target: "file", action: "edit", ref: { id: "f1" }, oldText: "print(1)", newText: "random.seed(7)\nprint(1)" })] });
	has(text(), "  │ ✎ book file edit f1\n  │   │ random.seed(7)\n  │   │ print(1)", "book file edit streams newText as it grows");
	chat.live(1, { timestamp: 9, content: [call("c9", "book", { target: "file", action: "edit", ref: { id: "f1" }, oldText: "print(1)", newText: "print(2)" })] });
	has(text(), "  │ ✎ book file edit f1\n  │   │ print(2)", "at equal length, newText is shown over oldText");
	chat.live(1, undefined);
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

test("screen: a consult call folds to one line, and opens to the whole story — the context, the question, and the answer under its thread", async () => {
	const { createChat } = await import("../src/screen/chat.mjs");
	let clock = 1000;
	const thread = "st-20261116-053946-a1b2";
	const roundOne = [
		"<!-- storyteller v1 -->",
		"The storyteller — one long problem, kept whole",
		"",
		"Model: MythosNano",
		"Started: 2026-11-16T05:39:46.000Z",
		"",
		"## Round 1 — 2026-11-16T05:39:46.000Z",
		"Elapsed: 1 m 12 s · 9,001 output tokens · finish: stop",
		"",
		"Context:",
		"```text",
		"The roller rolls one die.",
		"The user suspects it is unfair.",
		"```",
		"",
		"Question:",
		"```text",
		"Is the roller sound?",
		"```",
		"",
		"Answer:",
		"```text",
		"It is not. Roll twice, not once, or the die never lands on six.",
		"```",
		"",
	].join("\n");
	const stories = { [thread]: roundOne };
	const chat = createChat({ now: () => clock, readStory: (id) => stories[id] });
	const text = (cols = 80) => chat.lines(cols).map((line) => line.spans.map(([part]) => part).join("")).join("\n");
	const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
	const reply = (content, stamp) => ({ model: [{ role: "assistant", content, timestamp: stamp }] });
	const result = (id, name, body, extra = {}) => ({ model: [{ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: body }], ...extra }] });

	chat.user("Is the roller sound?");
	chat.entry(0, reply([call("c1", "consult", { question: "Is the roller sound?", context: "The roller rolls one die.\nThe user suspects it is unfair." })], 1));
	clock += 72_000;
	chat.entry(0, result("c1", "consult", `The storyteller took 1 m 12 s (9,001 output tokens). The story stands under thread ${thread}; shelved as placement sh1 (12,340 rendered tokens); over what the shelf renders, the story stands in the brain and the state block says so. A story is not a record: check the work against a test or a proof, and apply it yourself. I can ask on with \`thread: "${thread}"\` — the storyteller sees the original question and its answer — for as long as the work needs.`, { details: { consult: true, thread, rounds: 1, placement: "sh1", tokens: 9001, finish: "stop", seconds: 72.4 } }));
	chat.entry(0, reply([call("c2", "chat", { text: "It rolls once; ask the storyteller, and it says twice." })], 2));

	// Folded: one line for the run, and the line says whose work it was; nothing of the answer stands until it is opened.
	has(text(), "▸ 1 call · Is the roller sound? · 1m 12s", "once something is said, the run is one line, and the line says what the storyteller was asked");
	hasNot(text(), "the storyteller  Is the roller sound?", "the call's own line is folded away with the run");
	hasNot(text(), "Roll twice", "the answer is not shown until the call is opened");
	hasNot(text(), "It is not.", "and the receipt never carried it either");

	// The run opened: the call is one line — who was asked, what, how long it took, how much it wrote, where the story stands.
	chat.toggle(chat.lines(80).find((line) => line.kind === "group").item);
	has(text(), "the storyteller  Is the roller sound?  → 1 m 12 s · 9,001 tokens", "opened, the call line says who was asked, what, how long it took and how much it wrote");
	hasNot(text(), "Roll twice", "the answer stands behind the call");

	// Opened: the whole story stands in the row, read from the brain under its thread, never from the session.
	const consultRow = chat.lines(80).find((line) => line.kind === "call");
	chat.toggleRow(consultRow.item, consultRow.row);
	const opened = text();
	has(opened, `the story stands under thread ${thread} · 1 round`, "the opened row names the thread, never a path");
	has(opened, "round 1 · 2026-11-16 05:39 UTC", "the round is labelled");
	has(opened, "what I sent — the context", "the ask says what was sent");
	has(opened, "The roller rolls one die.", "the context of the call");
	has(opened, "The user suspects it is unfair.", "all of it");
	has(opened, "what I asked — the question", "and what was asked");
	has(opened, "Is the roller sound?", "the question in full");
	has(opened, "what the storyteller answered", "and what came back");
	has(opened, "It is not. Roll twice, not once, or the die never lands on six.", "the answer, from the story it stands in");
	hasNot(opened, "Shelved as placement", "the receipt is not repeated inside the opened row");

	// y copies the whole story: the context, the question and the answer, not just the one line.
	const copied = chat.textOf(consultRow.item, consultRow.row);
	has(copied, `The story stands under thread ${thread}`, "the copied text carries the thread");
	has(copied, "The roller rolls one die.", "the copied text carries the context");
	has(copied, "Is the roller sound?", "the question");
	has(copied, "Roll twice, not once", "and the answer");

	// A follow-up is its own call; the story grew under the same thread, and its row reads the whole of it.
	stories[thread] = roundOne.replace(/\s+$/, "\n\n") + [
		"## Round 2 — 2026-11-16T06:10:02.000Z",
		"Elapsed: 0 m 41 s · 640 output tokens · finish: stop",
		"",
		"Question:",
		"```text",
		"Why twice?",
		"```",
		"",
		"Answer:",
		"```text",
		"Once lands on six only half the time.",
		"```",
		"",
	].join("\n");
	chat.entry(0, reply([call("c3", "consult", { question: "Why twice?", thread })], 3));
	clock += 41_000;
	chat.entry(0, result("c3", "consult", `Round 2. The storyteller took 0 m 41 s (640 output tokens). The story (2 rounds) stands under thread ${thread}; shelved as placement sh1 (12,410 rendered tokens); over what the shelf renders, the story stands in the brain and the state block says so. A story is not a record: check it against a test or a proof. Ask on with \`thread: "${thread}"\` while a refutable doubt remains — the storyteller sees the whole exchange — or let it rest.`, { details: { consult: true, thread, rounds: 2, placement: "sh1", tokens: 640, finish: "stop", seconds: 41 } }));
	const consultLines = chat.lines(80).filter((line) => line.kind === "call" && line.spans.some(([part]) => String(part).includes("Why twice?")));
	const secondRow = consultLines.at(-1);
	chat.toggleRow(secondRow.item, secondRow.row);
	const opened2 = text();
	has(opened2, `the story stands under thread ${thread} · 2 rounds`, "the follow-up row reads the story, both rounds");
	has(opened2, "round 1 · 2026-11-16 05:39 UTC", "the first round stands in it");
	has(opened2, "round 2 · 2026-11-16 06:10 UTC", "and so does the second");
	has(opened2, "Why twice?", "the follow-up question");
	has(opened2, "Once lands on six only half the time.", "the follow-up answer");

	// A missing story is said as such, not as an empty answer: a fresh chat cannot read a thread the brain no longer holds.
	delete stories[thread];
	const gone = createChat({ now: () => clock, readStory: (id) => stories[id] });
	gone.entry(0, reply([call("c9", "consult", { question: "Is the roller sound?", context: "" })], 1));
	gone.entry(0, result("c9", "consult", `The storyteller took 1 m 12 s. The story stands under thread ${thread}.`, { details: { consult: true, thread, rounds: 1, placement: "sh1", tokens: 9001, finish: "stop", seconds: 72.4 } }));
	gone.toggle(gone.lines(80).find((line) => line.kind === "group").item);
	const goneRow = gone.lines(80).find((line) => line.kind === "call");
	gone.toggleRow(goneRow.item, goneRow.row);
	has(gone.lines(80).map((line) => line.spans.map(([part]) => part).join("")).join("\n"), "is gone from the brain", "a story that is gone is said as gone");

	// A failed consult shows why it failed, once, where the answer would stand.
	const failed = createChat({ now: () => clock, readStory: (id) => stories[id] });
	failed.entry(0, reply([call("c8", "consult", { question: "Is the roller sound?", context: "" })], 1));
	failed.entry(0, result("c8", "consult", "The storyteller refused the call: HTTP 500. boom", { isError: true }));
	failed.toggle(failed.lines(80).find((line) => line.kind === "group").item);
	const failedRow = failed.lines(80).find((line) => line.kind === "call");
	failed.toggleRow(failedRow.item, failedRow.row);
	const failedText = failed.lines(80).map((line) => line.spans.map(([part]) => part).join("")).join("\n");
	has(failedText, "why it failed", "a failed consult says why");
	has(failedText, "HTTP 500", "with what the endpoint said");
	hasNot(failedText, "what the storyteller answered", "and no empty answer section under it");

	// A consult that fails carries no answer section and no story; the harness line stands alone.
	hasNot(text(), "why it failed", "the successful exchange stands without the failure block");
});

test("screen: while the storyteller writes, the Chat tab shows the tail of its draft, and wipes it when the answer lands", async () => {
	const { createChat } = await import("../src/screen/chat.mjs");
	let clock = 1000;
	const thread = "st-20261116-053946-a1b2";
	const stories = { [thread]: "<!-- storyteller v1 -->\nThe storyteller — one long problem, kept whole\n\nModel: Mythos-nano\nStarted: 2026-11-16T05:39:46.000Z\n\n## Round 1 — 2026-11-16T05:39:46.000Z\nElapsed: 0 m 12 s · finish: stop\n\nQuestion:\n```text\nq?\n```\n\nAnswer:\n```text\nIt is not. Roll twice.\n```\n" };
	const chat = createChat({ now: () => clock, readStory: (id) => stories[id] });
	const text = (cols = 80) => chat.lines(cols).map((line) => line.spans.map(([part]) => part).join("")).join("\n");
	const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
	const reply = (content, stamp) => ({ model: [{ role: "assistant", content, timestamp: stamp }] });
	const result = (id, name, body, extra = {}) => ({ model: [{ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: body }], ...extra }] });

	chat.user("q?");
	chat.entry(0, reply([call("c1", "consult", { question: "q?", context: "" })], 1));
	// The draft streams in through the harness's live slot, a bounded tail — nothing from the session.
	chat.liveTools(0, [{ callId: "c1", name: "consult", status: "running", output: "No. The uniform() call modulo six" }]);
	has(text(), "… the storyteller", "while it runs, the call line shows the waiting mark");
	has(text(), "No. The uniform() call modulo six", "and the draft as far as it has come");
	clock += 3000;
	chat.liveTools(0, [{ callId: "c1", name: "consult", status: "running", output: "No. The uniform() call modulo six biases toward 1 and 2. Draw with rejection." }]);
	has(text(), "biases toward 1 and 2. Draw with", "the tail grows as it writes");
	has(text(), "rejection.", "wrapped onto the next row like everything else");
	assert.equal(chat.doing().what, "the storyteller is writing", "the strip says whose words those are");
	// The answer lands: the tool result stands, the tail is gone.
	clock += 2000;
	chat.entry(0, result("c1", "consult", `The storyteller took 0 m 05 s (40 output tokens). The story stands under thread ${thread}; shelved as placement sh1.`, { details: { consult: true, thread, rounds: 1, tokens: 40, finish: "stop", seconds: 5 } }));
	chat.liveTools(0, []);
	hasNot(text(), "modulo six", "once the answer lands, the draft leaves the tab — the story holds it");
	has(text(), "→ 0 m 05 s · 40 tokens", "and the call line keeps how long it took and how much it wrote");
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

test("screen: the Context tab shows the request the agent was sent, part by part in the order the model reads it, and what came since", async () => {
	const { contextBar, contextView } = await import("../src/screen/views.mjs");
	const big = "word ".repeat(4000); // about 5,000 tokens
	const payload = {
		tools: [{ type: "function", function: { name: "read", description: "Read files.", parameters: { type: "object", properties: { paths: { type: "array" } } } } }],
		messages: [
			{ role: "system", content: "You are Cartographer." },
			{ role: "user", content: `<project>\n${RECORD} My own records of this project.\nMy assessment\nA demo.\n</project>\n\n<context>\n${RECORD} Kept.\nt1 · look · asked: x → y\n</context>\n\n${USER_NAME}: Where is the config?\n\n[sent Thu 12 Nov 2026, 14:02]` },
			{ role: "assistant", content: "I should look.", tool_calls: [{ id: "c1", type: "function", function: { name: "task", arguments: JSON.stringify({ brief: "Find the config\nand say where" }) } }] },
			{ role: "tool", tool_call_id: "c1", content: `${big}\n\n<state>\n${RECORD} This is the current state.\nNow: Thu 12 Nov 2026, 14:03\n</state>\n\n<windows>\n${RECORD} The shell windows as they are at this moment:\n  main · free\n</windows>` },
		],
	};
	const reply = { role: "assistant", content: [{ type: "thinking", thinking: "Say it." }, { type: "toolCall", id: "c2", name: "chat", arguments: { text: "It is in src/config.js." } }] };
	const sent = { task: false, payload, reply, results: new Map([["c2", "Shown to the user."]]), at: Date.now() - 5000, count: 7, used: 6100, collapsedSince: false };
	const view = contextView(sent, { windowSize: 20_000, cols: 40 });
	const titles = view.items.map((item) => (item.plain ? item.head[0][0] : item.head[2][0].trim()));
	assert.deepEqual(titles, ["System prompt", "Tools · 1: read", "Assessment and graph, as copied at the last collapse", "What the last collapse kept", "Chat · You", "Chat · Agent · note and call: task", "Result of task", "State block: the time, the tree, the ledger, the plan", "Windows block: the shell windows as they are", "── since that request: what the next one will hold as well ──", "The reply · call: chat", "Result of chat"], "the parts in the order the model reads them");
	assert.deepEqual(view.items.slice(0, 2).map((item) => item.head.map(([part]) => part).join("")), ["■     6  System prompt  You are Cartographer.", "■    37  Tools · 1: read  "], "each is one line: its colour, its size, what it is, how it begins");
	const byKey = (title) => view.items.find((item) => !item.plain && item.head[2][0].trim().startsWith(title));
	assert.equal(byKey("System prompt").body, "You are Cartographer.", "opened, a part is its text exactly");
	has(byKey("Tools · 1").body, '── read ──\nRead files.\nparameters: {\n  "type": "object"', "the tools as they are sent");
	assert.match(byKey("Assessment and graph").body, /^<project>\n[\s\S]*\n<\/project>$/, "the block Cartographer puts in front is a part of its own");
	assert.match(byKey("What the last collapse kept").body, /^<context>\n[\s\S]*\n<\/context>$/, "so is what a collapse kept");
	assert.equal(byKey("Chat · You").body, `${USER_NAME}: Where is the config?\n\n[sent Thu 12 Nov 2026, 14:02]`, "and the user's message is what is left");
	assert.equal(byKey("Chat · Agent · note and call: task").body, "I should look.\n\ncall task\n  brief:\n    Find the config\n    and say where", "a call reads as a call: its arguments one by one, long text as text");
	assert.match(byKey("State block").body, /^<state>\n[\s\S]*\n<\/state>$/, "the state block is cut off the result it was added to");
	assert.match(byKey("Windows block").body, /^<windows>\n[\s\S]*\n<\/windows>$/, "and the windows block");
	hasNot(byKey("Result of task").body, "<state>", "which is then only the result");
	assert.equal(byKey("The reply").body, "(thinking, not kept in the context)\nSay it.\n\ncall chat\n  text: It is in src/config.js.", "after the request: the reply");
	assert.equal(byKey("Result of chat").body, "Shown to the user.", "and what its call returned");

	// The top: whose window, the bar, the legend.
	const top = view.header.map((line) => line.map(([part]) => part).join(""));
	assert.match(top[0], /^What the main agent sees {2}· {2}about [\d.]+k of 20k tokens \(\d+%\) — estimated {2}· {2}the server counted 6\.1k \(measured\)$/);
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

test("screen: a windows block followed by an ephemeral read tail is still a part of its own, and a request without a state block says so", async () => {
	const { contextView } = await import("../src/screen/views.mjs");
	// Exactly what dressRequest produces after a read: the blocks are glued to the result, and the newest read stands at the very end.
	const payload = {
		messages: [
			{ role: "system", content: "You are Cartographer." },
			{ role: "tool", tool_call_id: "c1", content: `== a.js (lines 1-2 of 2)\n1  alpha\n2  beta\n\n<state>\n${RECORD} This is the current state.\nNow: Thu 12 Nov 2026, 14:03\n\nLedger\nThe ledger is empty.\n</state>\n\n<windows>\n${RECORD} The shell windows as they are at this moment:\n  main · free\n</windows>\n\n<read-tail>\n== c.js (lines 1-40 of 300)\n1  gamma` },
		],
	};
	const sent = { task: false, payload, reply: undefined, results: new Map(), at: Date.now(), count: 1, used: undefined, collapsedSince: false };
	const view = contextView(sent, { windowSize: 20_000, cols: 40 });
	const keys = view.items.map((item) => String(item.key ?? ""));
	const byKey = (key) => view.items.find((item) => item.key === key);
	assert.ok(keys.some((key) => key.endsWith(".windows")), "the windows block stands as its own part even with the read tail after it");
	assert.ok(keys.some((key) => key.endsWith(".state")), "and so does the state block");
	hasNot(byKey("m0.0.result").body, "<windows>", "the result keeps only the result and the tail");
	// A request with no state block at all: a loud, visible marker, not silence.
	const bare = { ...sent, payload: { messages: [{ role: "system", content: "You are Cartographer." }, { role: "tool", tool_call_id: "c1", content: "== a.js" }] } };
	const bareView = contextView(bare, { windowSize: 20_000, cols: 40 });
	assert.ok(bareView.items.some((item) => item.key === "state:missing"), "the absence of the state block is said out loud");
	has(bareView.items.find((item) => item.key === "state:missing").head.map(([part]) => part).join(""), "No state block in this request", "and the marker tells the user what one should always carry");
});

test("screen: the Context tab unfolds the collapse block into one row per kept object, with the same verbs", async () => {
	const { contextView } = await import("../src/screen/views.mjs");
	const { writeFront, noteChat, shelfItem, updateContext } = await import("../src/context.mjs");
	const root = mkdtempSync(join(tmpdir(), "carto-kept-"));
	const brainDir = join(root, ".brain");
	mkdirSync(brainDir, { recursive: true });
	const at = (h, m) => new Date(2026, 10, 15, h, m).getTime();
	try {
		writeFileSync(join(root, "shelf.txt"), "the shelf keeps this\n");
		noteChat(brainDir, "user", at(13, 10), "please add the wrist throw");
		noteChat(brainDir, "you", at(13, 12), "on it");
		applyAdd(brainDir, "ledger", JSON.stringify({ kind: "note", text: "Keep quotes in English." }), null);
		mkdirSync(join(brainDir, "reports"), { recursive: true });
		writeFileSync(join(brainDir, "reports", "s3.md"), "# Report s3\n\nIt throws now.\n");
		updateContext(brainDir, (store) => {
			store.rows.push({ id: "s3", species: "composed", at: at(13, 5), mode: "look", brief: "Add the wrist throw", outcome: "It throws.", changed: 2, ref: { type: "report", id: "s3" } });
		});
		const shelved = shelfItem(root, "shelf.txt", undefined, brainDir, []);
		updateContext(brainDir, (store) => { store.shelf.push(shelved.item); });
		// The salient mark, through the same op the agent edits with.
		const ledger = loadLedger(brainDir).ledger;
		applyOp(ledger, { action: "edit", id: "n1", salient: true }, new Date().toISOString());
		saveLedger(brainDir, ledger);
		const front = writeFront(brainDir, root, { chatWindow: 2_000, contextWindow: 100_000 }, { now: at(14, 32), reason: "a test collapse", calls: [
			{ at: at(13, 20), text: "read shelf.txt", outcome: "12 lines" },
			{ at: at(13, 25), text: "edit src/dice.mjs", outcome: "34 lines changed" },
		] });
		const payload = { messages: [{ role: "user", content: `${front.text}\n\nWhere are we?` }] };
		const sent = { task: false, payload, reply: undefined, results: new Map(), at: Date.now(), count: 3, used: 4000, collapsedSince: false };
		const view = contextView(sent, { windowSize: 100_000, cols: 80, isOpen: (key) => key === "kept", root, brainDir, edits: new Map(), deleted: new Set() });
		const keys = view.items.map((item) => item.key);
		const keptAt = keys.indexOf("kept");
		assert.ok(keptAt >= 0, "the kept block stands as one folder");
		assert.equal(view.items[keptAt].folder, true);
		assert.equal(view.items[keptAt].editKind, "store", "e on the folder still opens the raw store");
		assert.ok(keys.join(" ").includes("kept:meta"), "the preamble is the first row inside");
		assert.deepEqual(keys.slice(keptAt + 1, keptAt + 5), ["kept:meta", "report:s3", "entry:n1", "shelf:sh1"], "the shelf row keys by the id, not the label");
		// The talk rows are the chat objects: e and d work on them as elsewhere.
		const talk = view.items.filter((item) => typeof item.key === "string" && item.key.startsWith("talk:"));
		assert.equal(talk.length, 2, "both sayings stand inside the block");
		assert.deepEqual([talk[0].editKind, talk[1].editKind], ["chat-you", "chat-agent"]);
		assert.equal(talk[0].chat, "please add the wrist throw", "the row carries the words, for the edit machinery");
		assert.equal(talk[0].head[1][0], USER_NAME, "the kept-talk row uses the configured speaker");
		// The calls rows are the block's history: visible, copyable, not editable.
		const calls = view.items.filter((item) => typeof item.key === "string" && item.key.startsWith("call:"));
		assert.equal(calls.length, 2);
		assert.ok(calls.every((item) => item.editKind === undefined), "history is not editable");
		// The parent says what it holds.
		assert.match(view.items[keptAt].head.map(([part]) => part).join(""), /1 task.*1 note.*1 shelf item.*2 talk.*2 calls/);
		// A saying the user has deleted stands out of the block's rows as well.
		const gone = contextView(sent, { windowSize: 100_000, cols: 80, isOpen: (key) => key === "kept", root, brainDir, edits: new Map(), deleted: new Set(["please add the wrist throw"]) });
		const left = gone.items.filter((item) => typeof item.key === "string" && item.key.startsWith("talk:"));
		assert.deepEqual(left.map((item) => item.chat), ["on it"], "the deleted saying is out of the rows, the rest stands");
		assert.deepEqual(left.map((item) => item.key), ["talk:1:" + at(13, 12)], "deleting the middle saying does not renumber the rest");
		// A store that cannot be read still renders the kept folder instead of blanking the tab.
		const noStore = join(root, "no-store");
		mkdirSync(noStore, { recursive: true });
		const bare = contextView(sent, { windowSize: 100_000, cols: 80, isOpen: (key) => key === "kept", root, brainDir: join(noStore, ".brain"), edits: new Map(), deleted: new Set() });
		assert.ok(bare.items.some((item) => item.key === "kept"), "the folder renders even with no store at all");
		assert.match(bare.items.find((item) => item.key === "kept").head.map(([part]) => part).join(""), /not readable|empty|calls/, "and it carries a summary instead of throwing");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ─── Outcomes of settled entries, the atlas rename, the audit of cuts, and the small box ───────────────

test("brain: an outcome of a settled entry is editable; the lists refuse what makes no sense", () => {
	const root = makeProject("outcome-edits");
	const brainDir = join(root, ".brain");
	mkdirSync(brainDir, { recursive: true });
	const now = "2026-11-15T00:00:00.000Z";
	// The ledger: the same rule, on a goal with a done-when line.
	saveLedger(brainDir, { version: 1, next: 2, items: [{ id: "g1", kind: "goal", text: "Ship the thing", doneWhen: "It is live", status: "done", outcome: "shipped", closed: 1 }] });
	const ledger = loadLedger(brainDir).ledger;
	const edited = applyOp(ledger, { action: "edit", id: "g1", outcome: "shipped and documented", done_when: "It is live and documented" }, now);
	assert.equal(edited.line.includes("reworded"), true);
	assert.equal(ledger.items[0].outcome, "shipped and documented");
	assert.equal(ledger.items[0].doneWhen, "It is live and documented");
	applyOp(ledger, { action: "edit", id: "g1", text: "Ship the thing, documented" }, now);
	assert.equal(ledger.items[0].text, "Ship the thing, documented", "a closed entry's text is still editable");
	saveLedger(brainDir, { version: 1, next: 3, items: [{ id: "g2", kind: "goal", text: "Open goal", doneWhen: "It is done", status: "open" }] });
	const ledgerOpen = loadLedger(brainDir).ledger;
	assert.throws(() => applyOp(ledgerOpen, { action: "edit", id: "g2", outcome: "not closed" }, now), LedgerError, "an outcome on an open goal is refused");
	// The plan: the same again.
	savePlan(brainDir, { version: 1, next: 2, items: [{ id: "p1", mode: "look", text: "Map the thing", status: "done", outcome: "mapped" }] });
	const { plan } = loadPlan(brainDir);
	const planEdited = applyPlanOp(plan, { action: "edit", id: "p1", outcome: "mapped, with a diagram" }, now);
	assert.equal(planEdited.line.includes("changed"), true);
	assert.equal(plan.items[0].outcome, "mapped, with a diagram");
});

test("atlas: a node can be renamed, and what links to it is rewritten", () => {
	const root = makeProject("atlas-rename");
	const brainDir = join(root, ".brain");
	mkdirSync(brainDir, { recursive: true });
	const now = "2026-11-15T00:00:00.000Z";
	const who = { root, now, by: "main", main: true, files: () => [] };
	const atlas = { version: 1, next: 0, view: { anchor: ".", depth: 2 }, nodes: [
		{ name: "dice_roll", gist: "How the die is rolled", links: [], files: [], seen: {}, written: 1, by: "main" },
		{ name: "casino_floor", gist: "The floor the die lands on", links: ["dice_roll"], files: [], seen: {}, written: 1, by: "main" },
	] };
	saveAtlas(brainDir, atlas);
	const renamed = applyAtlasOp(atlas, { action: "rename", name: "dice_roll", to: "die_roll" }, who);
	assert.equal(renamed.line.includes("die_roll"), true);
	assert.equal(atlas.nodes[0].name, "die_roll", "the node carries the new name");
	assert.deepEqual(atlas.nodes[1].links, ["die_roll"], "what links to it points at the new name");
	assert.equal(atlas.nodes[0].written, 1, "a rename is not a claim that the node is true now");
	assert.throws(() => applyAtlasOp(atlas, { action: "rename", name: "die_roll", to: "casino_floor" }, who), AtlasError, "a name that is taken is refused");
	assert.throws(() => applyAtlasOp(atlas, { action: "rename", name: "die_roll", to: "???" }, who), AtlasError, "a name with nothing in it is refused");
	assert.equal(applyAtlasOp(atlas, { action: "rename", name: "die_roll", to: "die-roll" }, who).line.includes("die_roll"), true, "a name is normalized the way every name is");
});

test("screen: nothing that a head cuts off is unreachable — the full text is in the body or the copy", async () => {
	const root = makeProject("cut-audit");
	const brainDir = join(root, ".brain");
	mkdirSync(brainDir, { recursive: true });
	const { ledgerView, planView, atlasView, requestsView, shellsView } = await import("../src/screen/views.mjs");
	const flatStr = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
	const exposed = (item) => flatStr([item.body, typeof item.copy === "function" ? item.copy() : item.copy].filter((part) => part !== undefined).join("\n"));
	const expectReachable = (name, view, needle) => {
		const flatNeedle = flatStr(needle);
		for (const item of view.items) {
			if (item.plain === true) continue;
			exposed(item); // eslint: compute once per item below instead
			if (flatStr(JSON.stringify(item.head)).includes(flatNeedle.slice(0, 40))) {
				assert.ok(exposed(item).includes(flatNeedle), `${name}: ${JSON.stringify(needle).slice(0, 50)} is cut from the head and not reachable from the body or the copy`);
				return;
			}
		}
		assert.ok(view.items.some((item) => item.plain !== true && exposed(item).includes(flatNeedle)), `${name}: the text is nowhere to be found`);
	};
	const LONG = "word ".repeat(70).trim(); // about 350 characters, longer than any head row at a usual width
	saveLedger(brainDir, { version: 1, next: 3, items: [
		{ id: "q1", kind: "question", text: LONG, status: "open", added: 1 },
		{ id: "g1", kind: "goal", text: "Ship the thing", doneWhen: LONG, status: "open", added: 1 },
	] });
	expectReachable("ledger question", ledgerView({ brainDir }), LONG);
	expectReachable("ledger goal done-when", ledgerView({ brainDir }), LONG);
	saveLedger(brainDir, { version: 1, next: 2, items: [] });
	savePlan(brainDir, { version: 1, next: 2, items: [{ id: "p1", mode: "look", text: LONG, status: "open", added: 1 }] });
	expectReachable("plan item", planView({ brainDir, yolo: false }), LONG);
	saveAtlas(brainDir, { version: 1, next: 0, view: { anchor: ".", depth: 2 }, nodes: [{ name: "dice_roll", gist: LONG.slice(0, 200), detail: LONG, files: [], links: [], seen: {}, written: 1, by: "main" }] });
	expectReachable("atlas gist", atlasView({ root, brainDir }), LONG.slice(0, 200));
	expectReachable("atlas detail", atlasView({ root, brainDir }), LONG);
	savePlan(brainDir, { version: 1, next: 2, items: [{ id: "p2", mode: "change", text: LONG, status: "open", added: 1 }] });
	expectReachable("approval request", requestsView({ brainDir, yolo: false }), LONG);
	savePlan(brainDir, { version: 1, next: 2, items: [] });
	const session = { windows: { list: () => [{ name: "main", state: "busy", command: LONG, running: 9000, cwd: ".", network: false, sandbox: true, asks: false, tail: [] }] } };
	expectReachable("shell command", shellsView({ session }), LONG);
});

test("screen: the small box caps what goes in, counts it live, and saves through the operations", async () => {
	const { Box } = await import("../src/screen/parts.mjs");
	const caps = [];
	const flashes = [];
	const saved = [];
	let closed = 0;
	const fields = [
		{ id: "text", label: "Text", limit: 5, value: "abc" },
		{ id: "detail", label: "Detail", limit: 12, multiline: true, value: "" },
	];
	const box = new Box({
		title: "x",
		fields,
		keyOf: (data) => data,
		flash: (text) => flashes.push(text),
		close: () => closed++,
		save: (drafts) => {
			saved.push(new Map(drafts));
			return true;
		},
	});
	const painted = () => box.render(50).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
	assert.ok(painted().includes("3 / 5"), "the counter shows how much of the field is used");
	box.handleInput("d");
	box.handleInput("e");
	assert.equal(box.text, "abcde");
	box.handleInput("f");
	assert.equal(box.text, "abcde", "nothing past the limit goes in");
	assert.ok(flashes.some((text) => text.includes("limit")), "and the limit says so");
	box.handleInput("backspace");
	assert.equal(box.text, "abcd");
	box.handleInput("tab");
	assert.equal(box.field.id, "detail", "Tab moves to the next field of the row");
	box.handleInput("\n");
	assert.equal(box.text, "\n", "a bare newline is Enter, which in a long field ends a line");
	box.handleInput("ctrl+enter");
	assert.equal(saved.length, 1, "Ctrl-Enter saves the long field");
	assert.equal(saved[0].get("detail"), "\n");
	assert.equal(closed, 1);
	// A paste is cut to what fits, and says so.
	const box2 = new Box({
		title: "y",
		fields: [{ id: "text", label: "Text", limit: 6, value: "" }],
		keyOf: (data) => data,
		flash: (text) => flashes.push(text),
		close: () => closed++,
		save: () => true,
	});
	box2.handleInput("abcdefghij");
	assert.equal(box2.text, "abcdef", "a paste is cut to the limit");
	assert.ok(flashes.some((text) => text.includes("left out")), "and what was left out is said");
	// Enter on a one-line field saves it.
	box2.handleInput("enter");
	assert.equal(closed, 2, "Enter saves a one-line field");
});


let passed = 0;
let failed = 0;
let skipped = 0;
// Tests are independent: separate throwaway projects and their own stand-in server. A small pool keeps the
// suite inside its wall-clock budget without changing what any case asserts.
const queue = tests.filter(({ name }) => only === undefined || name.includes(only));
const CONCURRENCY = 4;
await Promise.all(
	Array.from({ length: CONCURRENCY }, async () => {
		for (;;) {
			const next = queue.shift();
			if (next === undefined) return;
			const { name, run: body } = next;
			const start = Date.now();
			try {
				const note = await body();
				if (typeof note === "string") {
					skipped++;
					console.log(`skip  ${name}  (${note}, ${Date.now() - start} ms)`);
				} else {
					passed++;
					console.log(`ok    ${name}  (${Date.now() - start} ms)`);
				}
			} catch (error) {
				failed++;
				console.log(`FAIL  ${name}  (${Date.now() - start} ms)\n      ${String(error?.message ?? error).split("\n").join("\n      ")}`);
			}
		}
	}),
);
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed === 0 ? 0 : 1);
