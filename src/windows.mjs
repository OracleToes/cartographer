// Shell windows: the terminals a session keeps open.
//
// A window is a bash that stays alive behind a terminal of its own, with a name. A
// command is typed into a window and the call that typed it waits a while; when the
// command has not ended by then, the call returns and the command keeps running.
// The folder and the environment of a window stay from one command to the next.
//
// Cartographer keeps the newest lines of every window, shows them to the main agent
// in the state block (src/state.mjs), and tells whoever listens when a command ends
// with nobody waiting for it, so that the agent can be woken (src/terminal.mjs).
//
// The windows belong to the session, not to the task that opened them, and they end
// with Cartographer: in the sandbox because the sandbox ends with its parent, outside
// it through src/reaper.mjs.
//
// How a window is built: `script` (util-linux) gives bash a terminal, so programs
// print as they go and ask their questions; bash prints a mark with the exit status
// and the folder before each prompt, which is how the end of a command is known.
import { DEFAULTS, POLICY } from "./config.mjs";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { killFamily } from "./reaper.mjs";
import { HEAD_LINES, LINE_MAX, Output, QUIET, sandboxArgs, SandboxError } from "./sandbox.mjs";

/** Windows open at one time. */
export const WINDOWS_MAX = POLICY.limits.windows.open;
/** The longest one call may wait for a window, in seconds. */
export const WAIT_MAX = POLICY.limits.windows.waitSeconds;
/** Lines of output a window keeps. */
export const KEEP_LINES = POLICY.limits.windows.keptLines;
/** A busy window whose last line has no line end and that printed nothing for this long may be waiting for input. */
export const ASKS_AFTER_MS = POLICY.timing.windows.promptAfterSilenceMs;
/** The same, before the agent is woken for it. */
export const ASKS_WAKE_MS = POLICY.timing.windows.wakeAfterSilenceMs;
/** After input was sent: how long the program must be silent, having answered, before the call returns. */
export const QUIET_AFTER_MS = POLICY.timing.windows.returnAfterInputSilenceMs;

/** A request the window cannot carry out; the message is written for the agent. */
export class WindowError extends Error {}
const WHY_GONE = POLICY.control.windowGoneReason;

const NAME = new RegExp(POLICY.patterns.windowName);
const MARK = POLICY.sentinels.windowMark;
const SEP = POLICY.sentinels.windowSeparator;
const REAPER = fileURLToPath(new URL("./reaper.mjs", import.meta.url));

const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/** One line as it is kept: without colour codes, a redrawn line in its last state, bounded. */
function tidy(raw) {
	let line = raw.replace(/\r+$/, "");
	if (line.includes("\r")) line = line.slice(line.lastIndexOf("\r") + 1);
	line = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
	return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)} [line cut: ${line.length} characters]` : line;
}

let scriptFound;
/** Whether the `script` program is there, which gives a window its terminal. */
export function findScript() {
	if (scriptFound === undefined) {
		try {
			execFileSync("script", ["--version"], { stdio: "ignore", timeout: POLICY.timing.windows.versionProbeMs });
			scriptFound = true;
		} catch {
			scriptFound = false;
		}
	}
	return scriptFound;
}

/** What bash is told when a window opens. */
const RC = [
	"# Written by Cartographer for its shell windows. Changes are overwritten.",
	"set +H",
	"unset HISTFILE",
	"PS1=''; PS2=''",
	// A program sees what is typed into it, as in any terminal; bash's own prompt does not echo the line Cartographer types.
	"PS0='$(stty echo 2>/dev/null)'",
	`PROMPT_COMMAND='__carto=$?; stty -echo 2>/dev/null; printf "\\036%s\\037%s\\036" "$__carto" "$PWD"'`,
	`stty -echo cols ${POLICY.limits.windows.ptyColumns} rows ${POLICY.limits.windows.ptyRows} 2>/dev/null`,
	"",
].join("\n");

/**
 * @param {{ root: string, brainDir: string, config: { shellRead?: string[] }, runner: { mode: "sandbox" | "direct" | "none", available?: { why?: string, shell?: string } } }} input
 */
export function createWindows({ root, brainDir, config, runner }) {
	const dir = join(brainDir, "shells");
	const recordPath = join(brainDir, "carto-windows.json");
	/** What ended the waits that were last ended from outside, when it was not a message of the user. */
	let nudgedBy;
	/** @type {Map<string, any>} */
	const windows = new Map();
	const listeners = new Set();
	let news = [];
	let active = new Set();

	// Windows of an earlier run of the program ended with it. Of each that was running something, the agent is told
	// until it deals with it. A window that stood free lost only its folder and its environment.
	let gone = [];
	try {
		const kept = JSON.parse(readFileSync(recordPath, "utf8"));
		gone = [...(Array.isArray(kept.gone) ? kept.gone : []), ...(Array.isArray(kept.open) ? kept.open.filter((entry) => typeof entry?.command === "string") : [])].filter((entry) => typeof entry?.name === "string");
		gone = gone.filter((entry, index) => gone.findIndex((other) => other.name === entry.name) === index);
	} catch {
		// No record, or one that cannot be read: nothing to tell.
	}
	const record = () => {
		const open = [...windows.values()].filter((win) => win.state !== POLICY.enums.windowStates.closed).map((win) => ({ name: win.name, ...(win.state === POLICY.enums.windowStates.busy ? { command: win.command } : {}) }));
		try {
			mkdirSync(brainDir, { recursive: true });
			const temp = `${recordPath}.${process.pid}.tmp`;
			writeFileSync(temp, `${JSON.stringify({ open, gone }, null, "\t")}\n`);
			renameSync(temp, recordPath);
		} catch {
			// The record only serves the next start.
		}
	};
	if (gone.length > 0 || existsSync(recordPath)) record();

	const emit = (event) => {
		news.push(event);
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				// A listener's trouble is not the window's.
			}
		}
	};

	const where = (cwd, stageWork, stageCwd) => {
		if (typeof cwd !== "string" || cwd === "") return ".";
		const stagedRoot = typeof stageCwd === "string" ? stageCwd : stageWork;
		if (typeof stagedRoot === "string" && (cwd === stagedRoot || cwd.startsWith(stagedRoot + sep))) return cwd === stagedRoot ? "(staged work)" : `(staged work)/${relative(stagedRoot, cwd)}`;
		if (cwd === root) return ".";
		return cwd.startsWith(root + sep) ? relative(root, cwd) : cwd;
	};
	const end = (win) => win.dropped + win.lines.length;
	const push = (win, line) => {
		// The first lines of what a command prints are kept apart: they outlast the window's own memory.
		if (win.state === POLICY.enums.windowStates.busy && win.head.length < HEAD_LINES) win.head.push({ at: end(win), text: line });
		win.lines.push(line);
		if (win.lines.length > KEEP_LINES) {
			win.lines.shift();
			win.dropped++;
		}
	};
	/**
	 * The lines from position `from` on, the unfinished last line included.
	 * The window's own record always holds whole lines; what an earlier report has already shown is taken off the
	 * report here and only here, so that the Shells tab and `shell read` see the full lines as they are.
	 */
	const since = (win, from, { raw = false } = {}) => {
		const lines = win.lines.slice(Math.max(0, from - win.dropped));
		if (raw) return win.partial === "" ? lines : [...lines, tidy(win.partial)];
		// The first line at `from` had a prefix shown by an earlier report: only what came after it is new.
		// `seenSuffix` is tidied characters, measured on that line as it was pushed.
		if ((win.seenSuffix ?? 0) > 0 && from === win.seen && from >= win.dropped && lines.length > 0) {
			lines[0] = lines[0].slice(win.seenSuffix);
			if (lines[0] === "") lines.shift();
		}
		if (from === win.seen) win.seenSuffix = 0;
		// The unfinished line was shown, whole or in part, by an earlier report: only what came after it is new.
		// The count is in raw characters, so where the report happened inside an escape sequence makes no difference.
		let partial = tidy(win.partial);
		if (from === win.seen && (win.seenRaw ?? 0) > 0) partial = tidy(win.partial.slice(Math.min(win.partial.length, win.seenRaw)));
		return partial === "" ? lines : [...lines, partial];
	};
	const settle = (win, reason) => {
		for (const waiter of [...win.waiters]) waiter.done(reason);
	};
	/**
	 * A line that ends, or a line that is stood down, is kept whole. If an earlier report already showed part of it,
	 * the next report is told how much of its beginning was shown, so that it shows only the rest. If the tidied
	 * prefix is not a prefix of the tidied line, nothing at all is held back: a line shown twice is better than a
	 * line lost.
	 */
	const pushCompleted = (win, part) => {
		const line = tidy(part);
		push(win, line);
		if ((win.seenRaw ?? 0) > 0) {
			const prefix = tidy(part.slice(0, win.seenRaw));
			win.seenSuffix = line.startsWith(prefix) ? prefix.length : 0;
			win.seenRaw = 0;
		}
	};

	const text = (win, data) => {
		if (data === "") return;
		win.lastOutputAt = Date.now();
		win.outputs++;
		const parts = (win.partial + data).split("\n");
		win.partial = parts.pop();
		for (const [index, part] of parts.entries()) {
			if (index === 0 && (win.seenRaw ?? 0) > 0) {
				pushCompleted(win, part);
				continue;
			}
			push(win, tidy(part));
		}
		if (win.partial.length > POLICY.limits.windows.partialChars) {
			pushCompleted(win, win.partial);
			win.partial = "";
		}
		for (const waiter of [...win.waiters]) waiter.output?.();
	};
	const prompt = (win, exit, cwd) => {
		if (win.partial !== "") {
			pushCompleted(win, win.partial);
			win.partial = "";
		}
		win.cwd = cwd;
		if (win.state === POLICY.enums.windowStates.starting) {
			win.state = POLICY.enums.windowStates.idle;
			win.ready?.();
			return;
		}
		if (win.state !== POLICY.enums.windowStates.busy) return;
		const now = Date.now();
		win.last = { command: win.command, exit, ms: now - win.since, endedAt: now };
		win.state = POLICY.enums.windowStates.idle;
		win.asked = undefined;
		record();
		const watched = win.waiters.size > 0;
		settle(win, POLICY.enums.windowWaitReasons.done);
		if (!watched) emit({ type: "ended", name: win.name, command: win.last.command, exit, ms: win.last.ms, at: now });
	};
	const feed = (win, chunk) => {
		let data = win.pending + chunk;
		win.pending = "";
		for (;;) {
			const at = data.indexOf(MARK);
			if (at < 0) {
				text(win, data);
				return;
			}
			text(win, data.slice(0, at));
			const close = data.indexOf(MARK, at + 1);
			if (close < 0) {
				// Half a mark: the rest comes with the next piece. Something that only looks like one is passed on.
				if (data.length - at > POLICY.limits.windows.markerChars) text(win, data.slice(at + 1));
				else win.pending = data.slice(at);
				return;
			}
			const [exit, cwd] = data.slice(at + 1, close).split(SEP);
			prompt(win, Number(exit), cwd);
			data = data.slice(close + 1);
		}
	};

	const kill = (win) => {
		if (win.child?.pid === undefined) return;
		if (!win.sandbox) killFamily(win.child.pid);
		try {
			// In the sandbox this ends bwrap, and the sandbox's processes end with it.
			process.kill(-win.child.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	};
	const closed = (win, why) => {
		if (win.state === POLICY.enums.windowStates.closed) return;
		const was = win.state;
		win.state = POLICY.enums.windowStates.closed;
		win.closedBecause = why;
		if (windows.get(win.name) === win) windows.delete(win.name);
		record();
		const watched = win.waiters.size > 0;
		settle(win, POLICY.enums.windowWaitReasons.closed);
		win.fail?.(new SandboxError(`the window could not be opened: ${since(win, 0, { raw: true }).slice(-POLICY.limits.windows.startupErrorLines).join(" ").trim() || why}`));
		if (was === "busy" && !watched && why === "its shell ended") emit({ type: "closed", name: win.name, command: win.command, ms: Date.now() - win.since, at: Date.now() });
	};

	const open = async (name, network, readOnly = false, stage) => {
		const mode = runner.mode;
		const staged = stage !== undefined;
		// A read-only window is a promise the sandbox keeps; bwrap being present is what makes it possible, even with the sandbox switched off.
		const canSandbox = mode === "sandbox" || (mode === "direct" && runner.available?.ok === true);
		if (mode === "none") throw new SandboxError(runner.available?.why ?? "no sandbox");
		if (staged && (mode !== "sandbox" || readOnly === true)) throw new SandboxError("a normal command stage needs the active bubblewrap sandbox; direct and read-only windows are not staged");
		if (readOnly === true && !canSandbox) throw new SandboxError(mode === "direct" ? "a read-only window needs bubblewrap, and it is not working here: without it nothing holds a command to read-only" : "a read-only window needs the sandbox: it mounts the project read-only and blocks the network, and without the sandbox nothing holds a command to either");
		if (!findScript()) throw new SandboxError("the `script` program (part of util-linux) was not found, and a shell window needs it for its terminal");
		const confined = readOnly === true && canSandbox;
		if ((mode === "sandbox" || confined) && runner.available?.shell !== undefined && runner.available.shell !== "bash") throw new SandboxError("bash was not found, and a shell window needs it");
		if (staged && (![stage.root, stage.work, stage.home].every((path) => typeof path === "string" && path.startsWith("/")))) throw new SandboxError("the command-stage paths are invalid");
		mkdirSync(staged ? stage.home : dir, { recursive: true, mode: 0o700 });
		const win = {
			name,
			network: confined ? false : mode === "direct" ? true : network,
			sandbox: mode === "sandbox" || confined,
			readOnly: confined,
			...(staged ? { stage: stage.id, stageWork: stage.work, stageCwd: "/work" } : {}),
			state: POLICY.enums.windowStates.starting,
			lines: [],
			dropped: 0,
			partial: "",
			pending: "",
			waiters: new Set(),
			cwd: staged ? stage.work : root,
			outputs: 0,
			lastOutputAt: 0,
			head: [],
		};
		let child;
		if (mode === "sandbox" || confined) {
			const mounted = staged
				? (stage.mounts ?? []).map((mount) => ({ source: mount.source, target: join("/work", mount.target) }))
				: [];
			const sandbox = sandboxArgs(staged
				? {
					root: stage.work,
					target: "/work",
					cwd: "/work",
					brainDir,
					network,
					read: [],
					sandboxHome: stage.home,
					bindBrain: false,
					hide: [brainDir, join(root, ".brain"), join(root, ".git")],
					readOnlyBinds: mounted,
				}
				: { root, brainDir, network: confined ? false : network, read: config.shellRead, readOnly: confined });
			const rc = staged ? join(sandbox.home, ".cartographer-stage-rc") : join(dir, "rc");
			const fileLimit = Math.max(1, Math.floor(POLICY.limits.stage.storageBytes / 512));
			writeFileSync(rc, staged ? `${RC}\nulimit -f ${fileLimit} 2>/dev/null || true\n` : RC);
			const inner = ["script", "-qfec", `bash --noprofile --rcfile ${quote(rc)} --noediting -i`, "/dev/null"];
			win.commandHome = staged ? sandbox.home : undefined;
			child = spawn("bwrap", [...sandbox.args, "--", ...inner], { env: sandbox.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
		} else {
			const rc = join(dir, "rc");
			writeFileSync(rc, RC);
			const inner = ["script", "-qfec", `bash --noprofile --rcfile ${quote(rc)} --noediting -i`, "/dev/null"];
			child = spawn(inner[0], inner.slice(1), { cwd: root, env: { ...process.env, ...QUIET }, stdio: ["pipe", "pipe", "pipe"], detached: true });
		}
		win.child = child;
		const started = new Promise((resolve, reject) => {
			win.ready = resolve;
			win.fail = reject;
		});
		child.on("error", (error) => {
			win.fail?.(new SandboxError(error.code === "ENOENT" ? `${mode === "sandbox" ? "bwrap" : "script"} was not found` : `the window could not be opened: ${error.message}`));
			closed(win, "it could not be started");
		});
		for (const stream of [child.stdout, child.stderr]) {
			const decoder = new StringDecoder("utf8");
			stream.on("data", (chunk) => feed(win, decoder.write(chunk)));
		}
		child.stdin.on("error", () => {});
		// "close" comes when the last output has been read; "exit" may come before it.
		const ended = (code) => {
			win.exitCode ??= code;
			closed(win, "its shell ended");
		};
		child.on("close", ended);
		child.on("exit", (code) => {
			win.exitCode = code;
			setTimeout(() => ended(code), POLICY.timing.windows.exitGraceMs).unref();
		});
		if (mode === "direct" && !confined && child.pid !== undefined) {
			// Outside the sandbox nothing ends the window when Cartographer itself is killed. This does.
			const reaper = spawn(process.execPath, [REAPER, String(process.pid), String(child.pid)], { stdio: "ignore", detached: true });
			reaper.on("error", () => {});
			reaper.unref();
		}
		const timer = setTimeout(() => win.fail?.(new SandboxError(`the window did not start within ${POLICY.timing.windows.startupTimeoutMs / 1000} s`)), POLICY.timing.windows.startupTimeoutMs);
		try {
			await started;
		} catch (error) {
			kill(win);
			closed(win, "it could not be started");
			throw error;
		} finally {
			clearTimeout(timer);
			win.ready = undefined;
			win.fail = undefined;
		}
		windows.set(name, win);
		gone = gone.filter((entry) => entry.name !== name);
		record();
		return win;
	};

	/**
	 * Wait for something to happen in a window.
	 * @returns {Promise<"done" | "time" | "asks" | "until" | "quiet" | "stopped" | "closed" | "nudged">}
	 */
	const watch = (win, { from, waitMs, until, signal, nudgeable = false, main = false, quietMs, outputs = win.outputs }) =>
		new Promise((resolve) => {
			if (win.state === POLICY.enums.windowStates.closed) return resolve(POLICY.enums.windowWaitReasons.closed);
			const waiter = { nudgeable, main };
			let timer;
			let poll;
			const onAbort = () => waiter.done(POLICY.enums.windowWaitReasons.stopped);
			waiter.done = (reason) => {
				if (!win.waiters.delete(waiter)) return;
				clearTimeout(timer);
				clearInterval(poll);
				signal?.removeEventListener("abort", onAbort);
				resolve(reason);
			};
			if (until !== undefined) {
				waiter.output = () => {
					if (since(win, from).some((line) => line.includes(until))) waiter.done(POLICY.enums.windowWaitReasons.until);
				};
			}
			win.waiters.add(waiter);
			timer = setTimeout(() => waiter.done(POLICY.enums.windowWaitReasons.time), Math.max(0, waitMs));
			// A program that printed something since this call began and now sits at a line without an end.
			poll = setInterval(() => {
				if (win.state === POLICY.enums.windowStates.busy && win.outputs > outputs && tidy(win.partial).trim() !== "" && Date.now() - win.lastOutputAt >= ASKS_AFTER_MS) {
					// The caller is told, so nobody needs to be woken for it.
					win.asked = Date.now();
					waiter.done(POLICY.enums.windowWaitReasons.asks);
				}
				// An answer has come and nothing followed it.
				else if (quietMs !== undefined && win.state === POLICY.enums.windowStates.busy && win.outputs > outputs && tidy(win.partial).trim() === "" && Date.now() - win.lastOutputAt >= quietMs) waiter.done(POLICY.enums.windowWaitReasons.quiet);
			}, POLICY.timing.windows.pollMs);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			waiter.output?.();
		});

	/** Press Ctrl-C in a window and see whether its command ends. */
	const interrupt = async (win) => {
		if (win.state !== POLICY.enums.windowStates.busy) return true;
		const from = end(win);
		win.child.stdin.write("\x03");
		if ((await watch(win, { from, waitMs: POLICY.timing.windows.interruptWaitMs[0] })) === POLICY.enums.windowWaitReasons.done || win.state !== POLICY.enums.windowStates.busy) return true;
		win.child.stdin.write("\x03\x1c");
		await watch(win, { from, waitMs: POLICY.timing.windows.interruptWaitMs[1] });
		return win.state !== POLICY.enums.windowStates.busy;
	};

	/** What a call reports about a window, with the output since `from`. */
	const report = (win, reason, from, began) => {
		const output = new Output();
		// Lines the window no longer keeps leave a gap. The running command's first lines are still there.
		const kept = Math.max(from, win.dropped);
		if (kept > from) {
			const head = win.head.filter((entry) => entry.at >= from && entry.at < kept);
			for (const entry of head) output.add(`${entry.text}\n`);
			output.skip(kept - from - head.length);
		}
		for (const line of since(win, kept)) output.add(`${line}\n`);
		const done = reason === POLICY.enums.windowWaitReasons.done && win.last !== undefined;
		// What a call has returned is not returned again. What is printed between two calls goes to the next one.
		if (reason !== POLICY.enums.windowWaitReasons.read && reason !== POLICY.enums.windowWaitReasons.idle) {
			win.seen = end(win);
			// How much of the unfinished last line was shown, in raw characters.
			win.seenRaw = win.partial.length;
		}
		return {
			window: win.name,
			reason,
			state: win.state,
			// A command that ended the window's own shell: the status the shell left with.
			...(done ? { exit: win.last.exit } : reason === POLICY.enums.windowWaitReasons.closed && Number.isInteger(win.exitCode) ? { exit: win.exitCode } : {}),
			ms: done ? win.last.ms : Date.now() - began,
			text: output.text(),
			lines: output.lines,
			last: output.last,
			cwd: where(win.cwd, win.stageWork, win.stageCwd),
			network: win.network,
			sandbox: win.sandbox,
			readOnly: win.readOnly === true,
			...(win.stage ? { stage: win.stage } : {}),
			...(win.state === POLICY.enums.windowStates.busy ? { command: win.command, running: Date.now() - win.since } : {}),
		};
	};

	const find = (name) => {
		const win = windows.get(name);
		if (win !== undefined) return win;
		const lost = gone.find((entry) => entry.name === name);
		if (lost !== undefined) throw new WindowError(`Window ${name} is gone: ${lost.why ?? WHY_GONE}${lost.command ? `, and with it \`${lost.command.split("\n")[0].slice(0, POLICY.limits.windows.commandSummaryChars)}\`` : ""}. \`shell\` with this window name opens a new one.`);
		const names = [...windows.keys()];
		throw new WindowError(`There is no window ${JSON.stringify(name)}. ${names.length === 0 ? "No window is open: `shell` opens one when it runs a command." : `Open: ${names.join(", ")}.`}`);
	};
	const checkName = (name) => {
		if (typeof name !== "string" || !NAME.test(name)) throw new WindowError(`A window name is a short word in lower case, such as main, server or tests; ${JSON.stringify(name)} is not.`);
	};
	const busyLine = (win) => `\`${win.command.split("\n")[0].slice(0, POLICY.limits.windows.commandSummaryChars)}\` (running ${Math.max(0, Math.round((Date.now() - win.since) / 1000))} s)`;

	const manager = {
	/**
	 * Type a command into a window, opening the window when it is not there, and wait for it at most `waitMs`.
	 * @param {string} name
	 * @param {string} command
	 * @param {{ network?: boolean, waitMs: number, signal?: AbortSignal, readOnly?: boolean, stage?: { id: string, root: string, work: string, home: string, mounts?: { source: string, target: string }[] } }} options
	 */
	async run(name, command, { network = false, waitMs, signal, readOnly = false, stage }) {
		checkName(name);
		// "Read-only" is a promise the sandbox keeps; bubblewrap being available is what makes it possible, even with the sandbox switched off.
		const spawnsSandbox = runner.mode === "sandbox" || (runner.mode === "direct" && runner.available?.ok === true);
		const confined = readOnly === true && spawnsSandbox;
		const staged = stage !== undefined;
		if (staged && (readOnly === true || runner.mode !== "sandbox")) throw new WindowError("A normal command stage is available only to a writable change move while bubblewrap is active.");
		let win = windows.get(name);
		if (win === undefined) {
			if (windows.size >= WINDOWS_MAX) throw new WindowError(`${WINDOWS_MAX} windows are open, which is the limit: ${[...windows.keys()].join(", ")}. Close one with \`window\` first, or run this in one of them.`);
			win = await open(name, network === true, confined, stage);
		} else {
			if (win.state === POLICY.enums.windowStates.busy) {
				throw new WindowError(`Window ${name} is busy with ${busyLine(win)}. To run this beside it, give \`shell\` another \`window\` name. To deal with what is running, use this tool's other actions: wait for it, stop it, or send it a line of input.`);
			}
			if ((win.readOnly === true) !== confined) {
				throw new WindowError(win.readOnly
					? `Window ${name} is a read-only window: commands there cannot write anything, and cannot reach the network. Close it with \`window\`, then run this in a window of another name.`
					: `Window ${name} may change files. A read-only command runs in a window of another name.`);
			}
			if ((win.stage ?? undefined) !== (stage?.id ?? undefined)) {
				throw new WindowError(win.stage ? `Window ${name} belongs to a disposable command stage. Close it before using this name outside that stage.` : `Window ${name} is not in this move's disposable command stage. Close it before reusing the name.`);
			}
			// The terminal closes every window when the user switches the sandbox; this is for a switch it did not see.
			// A window opened read-only rides bwrap either way, so its provenance survives the switch only that far.
			const spawnedSandboxed = (runner.mode === "sandbox" || (runner.mode === "direct" && runner.available?.ok === true)) && (win.readOnly === true || runner.mode === "sandbox");
			if (win.sandbox !== spawnedSandboxed) {
					throw new WindowError(`Window ${name} was opened ${win.sandbox ? "in the sandbox" : "with the sandbox off"}, and that has changed since. Close it with \`window\`, then run this again: the window opens anew.`);
				}
				if (win.sandbox && win.network !== (network === true)) {
					throw new WindowError(
						win.network
							? `Window ${name} was opened by a move whose capability allows network, and this move does not. Run this in a window of another name.`
							: `Window ${name} was opened without network access, and it keeps it that way. This task may use the network: run this in a window of another name.`,
					);
				}
			}
			const began = Date.now();
			const file = win.commandHome ? join(win.commandHome, `.cartographer-stage-${name}.cmd`) : join(dir, `${name}.cmd`);
			writeFileSync(file, `${command}\n`);
			const shown = command.split("\n");
			push(win, `$ ${shown[0]}`);
			for (const more of shown.slice(1, 1 + POLICY.limits.windows.commandPreviewLines)) push(win, `  ${more}`);
			const from = end(win);
			Object.assign(win, { command, since: began, state: POLICY.enums.windowStates.busy, asked: undefined, lastOutputAt: 0, head: [] });
			active.add(name);
			record();
			// Read from a file, so that a command with a mistake in it cannot leave bash waiting for the rest of a line.
			win.child.stdin.write(` source ${quote(file)}\n`);
			const reason = await watch(win, { from, waitMs, signal });
			if (reason === POLICY.enums.windowWaitReasons.stopped) await interrupt(win);
			return report(win, reason, from, began);
		},

		/** Type a line into the program that is running in a window. */
		async send(name, line, { waitMs, signal }) {
			const win = find(name);
			if (win.state !== POLICY.enums.windowStates.busy) throw new WindowError(`Nothing is running in window ${name}, so there is nothing to send input to. \`shell\` runs a command there.`);
			const began = Date.now();
			const from = win.seen ?? end(win);
			active.add(name);
			win.asked = undefined;
			const outputs = win.outputs;
			win.child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
			const reason = await watch(win, { from, waitMs, signal, quietMs: QUIET_AFTER_MS, outputs });
			return report(win, reason, from, began);
		},

		/** Wait until the command in a window ends, a line with `until` in it appears, or the time is up. */
		async wait(name, { waitMs, until, signal, main = false }) {
			const win = find(name);
			const began = Date.now();
			const from = win.seen ?? end(win);
			// A command that ended since the last call: its end is what the caller waits for.
			if (win.state !== POLICY.enums.windowStates.busy) return report(win, win.last !== undefined && from < end(win) ? POLICY.enums.windowWaitReasons.done : POLICY.enums.windowWaitReasons.idle, from, began);
			const reason = await watch(win, { from, waitMs, until, signal, nudgeable: true, main });
			return { ...report(win, reason, from, began), ...(reason === POLICY.enums.windowWaitReasons.nudged && nudgedBy !== undefined ? { nudgedBy } : {}) };
		},

		/** The newest `count` lines of a window. */
		read(name, count = POLICY.limits.windows.outputReadDefaultLines) {
			const win = find(name);
			const lines = since(win, 0, { raw: true });
			return { ...report(win, POLICY.enums.windowWaitReasons.read, end(win), Date.now()), text: lines.slice(-Math.max(1, Math.min(count, POLICY.limits.windows.outputReadMaxLines))).join("\n"), lines: lines.length, kept: end(win) };
		},

		/** Ctrl-C. @returns whether the command ended */
		async stop(name) {
			const win = find(name);
			if (win.state !== POLICY.enums.windowStates.busy) return { ...report(win, POLICY.enums.windowWaitReasons.idle, end(win), Date.now()), ended: true, wasBusy: false };
			const began = Date.now();
			const from = win.seen ?? end(win);
			const ended = await interrupt(win);
			return { ...report(win, ended ? POLICY.enums.windowWaitReasons.done : POLICY.enums.windowWaitReasons.time, from, began), ended, wasBusy: true };
		},

		/** End a window and everything in it. @returns what was running, if anything */
		close(name, { why } = {}) {
			const lost = gone.find((entry) => entry.name === name);
			if (!windows.has(name) && lost !== undefined) {
				gone = gone.filter((entry) => entry.name !== name);
				record();
				return { name, wasGone: true };
			}
			const win = find(name);
			const running = win.state === POLICY.enums.windowStates.busy ? win.command : undefined;
			kill(win);
			closed(win, "it was closed");
			// The agent did not do this, so it is told, in the state block, until it clears the line or reuses the name.
			if (why !== undefined) {
				gone.push({ name, ...(running ? { command: running } : {}), why });
				record();
			}
			return { name, ...(running ? { running } : {}) };
		},

		/** End every window. @returns their names */
		closeAll({ why } = {}) {
			const names = [...windows.keys()];
			for (const name of names) manager.close(name, { why });
			return names;
		},

		/** Every window as it stands, for the windows block and the screen. `tail`: how many of its newest lines. */
		list(tail = DEFAULTS.windowTail) {
			const now = Date.now();
			const open = [...windows.values()].map((win) => {
				const lines = since(win, 0, { raw: true });
				const partial = tidy(win.partial);
				return {
					name: win.name,
					state: win.state,
					cwd: where(win.cwd, win.stageWork, win.stageCwd),
					network: win.network,
					sandbox: win.sandbox,
					readOnly: win.readOnly === true,
					...(win.stage ? { stage: win.stage } : {}),
					...(win.state === POLICY.enums.windowStates.busy ? { command: win.command, running: now - win.since, quiet: win.lastOutputAt > 0 ? now - win.lastOutputAt : now - win.since, asks: partial.trim() !== "" && now - win.lastOutputAt >= ASKS_AFTER_MS } : {}),
					...(win.last ? { last: { ...win.last, ago: now - win.last.endedAt } } : {}),
					tail: lines.slice(-tail),
				};
			});
			return [...open, ...gone.map((entry) => ({ name: entry.name, state: POLICY.enums.windowStates.gone, why: entry.why ?? WHY_GONE, ...(entry.command ? { command: entry.command } : {}), tail: [] }))];
		},

		/** Whether a window of this name is open. */
		has: (name) => windows.has(name),
		/** How many lines a window has printed in all; undefined when it is not open. For those who watch it (src/wakes.mjs). */
		position: (name) => (windows.has(name) ? end(windows.get(name)) : undefined),
		/** Its finished lines from position `from` on, as far as they are still kept; with `partial`, the unfinished line as it stands. */
		linesFrom(name, from, { partial = false } = {}) {
			const win = windows.get(name);
			if (win === undefined) return [];
			const lines = win.lines.slice(Math.max(0, from - win.dropped));
			if (!partial) return lines;
			const last = tidy(win.partial);
			return last === "" ? lines : [...lines, last];
		},

		/** Be told when a command ends, or a program asks for input, while no call waits for the window. */
		on(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** What happened in the windows that the main agent has not been shown. */
		takeNews() {
			const taken = news;
			news = [];
			return taken;
		},
		hasNews: () => news.length > 0,
		/** The main agent is being shown the windows now: nothing is news to it any more. */
		noteShown() {
			news = [];
		},
		/** The windows that ran something since this was last asked. Those still busy count again next time. */
		takeActive() {
			const taken = [...active];
			active = new Set([...windows.values()].filter((win) => win.state === POLICY.enums.windowStates.busy).map((win) => win.name));
			return taken;
		},
		/** The user wrote: a call that only waits should return, so that the agent reads the message. */
		/**
		 * @param {string} [why]  what happened, when it was not a message of the user: the wait's result says it
		 * @param {{ mainOnly?: boolean }} [whose]  mainOnly: only a wait of the main agent ends; a task goes on waiting
		 */
		nudge(why, { mainOnly = false } = {}) {
			nudgedBy = why;
			for (const win of windows.values()) for (const waiter of [...win.waiters]) if (waiter.nudgeable && (!mainOnly || waiter.main)) waiter.done(POLICY.enums.windowWaitReasons.nudged);
		},
		/** End everything, for good. */
		shutdown() {
			clearInterval(ticker);
			process.removeListener("exit", atExit);
			manager.closeAll();
		},
	};

	// A busy window nobody waits for, whose program seems to ask for input: said once per silence.
	const ticker = setInterval(() => {
		const now = Date.now();
		for (const win of windows.values()) {
			if (win.state !== POLICY.enums.windowStates.busy || win.waiters.size > 0 || win.lastOutputAt === 0) continue;
			if (win.asked !== undefined && win.asked >= win.lastOutputAt) continue;
			if (tidy(win.partial).trim() === "" || now - win.lastOutputAt < ASKS_WAKE_MS) continue;
			win.asked = now;
			emit({ type: "asks", name: win.name, command: win.command, line: tidy(win.partial).slice(0, POLICY.limits.windows.askLineChars), at: now });
		}
	}, POLICY.timing.windows.tickerMs);
	ticker.unref();
	const atExit = () => {
		for (const win of windows.values()) kill(win);
	};
	process.on("exit", atExit);

	return manager;
}
