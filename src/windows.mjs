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
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { killFamily } from "./reaper.mjs";
import { HEAD_LINES, LINE_MAX, Output, QUIET, sandboxArgs, SandboxError } from "./sandbox.mjs";

/** Windows open at one time. */
export const WINDOWS_MAX = 4;
/** The longest one call may wait for a window, in seconds. */
export const WAIT_MAX = 300;
/** Lines of output a window keeps. */
export const KEEP_LINES = 2000;
/** A busy window whose last line has no line end and that printed nothing for this long may be waiting for input. */
export const ASKS_AFTER_MS = 1500;
/** The same, before the agent is woken for it. */
export const ASKS_WAKE_MS = 5000;
/** After input was sent: how long the program must be silent, having answered, before the call returns. */
export const QUIET_AFTER_MS = 1000;

/** A request the window cannot carry out; the message is written for the agent. */
export class WindowError extends Error {}
const WHY_GONE = "it ended when Cartographer last exited";

const NAME = /^[a-z][a-z0-9_-]{0,19}$/;
const MARK = "\x1e";
const SEP = "\x1f";
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
			execFileSync("script", ["--version"], { stdio: "ignore", timeout: 5000 });
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
	"stty -echo cols 120 rows 40 2>/dev/null",
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
		const open = [...windows.values()].filter((win) => win.state !== "closed").map((win) => ({ name: win.name, ...(win.state === "busy" ? { command: win.command } : {}) }));
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

	const where = (cwd) => {
		if (typeof cwd !== "string" || cwd === "") return ".";
		if (cwd === root) return ".";
		return cwd.startsWith(root + sep) ? relative(root, cwd) : cwd;
	};
	const end = (win) => win.dropped + win.lines.length;
	const push = (win, line) => {
		// The first lines of what a command prints are kept apart: they outlast the window's own memory.
		if (win.state === "busy" && win.head.length < HEAD_LINES) win.head.push({ at: end(win), text: line });
		win.lines.push(line);
		if (win.lines.length > KEEP_LINES) {
			win.lines.shift();
			win.dropped++;
		}
	};
	/** The lines from position `from` on, the unfinished last line included. */
	const since = (win, from) => {
		const lines = win.lines.slice(Math.max(0, from - win.dropped));
		const partial = tidy(win.partial);
		return partial === "" ? lines : [...lines, partial];
	};
	const settle = (win, reason) => {
		for (const waiter of [...win.waiters]) waiter.done(reason);
	};

	const text = (win, data) => {
		if (data === "") return;
		win.lastOutputAt = Date.now();
		win.outputs++;
		const parts = (win.partial + data).split("\n");
		win.partial = parts.pop();
		for (const part of parts) push(win, tidy(part));
		if (win.partial.length > 64_000) {
			push(win, tidy(win.partial));
			win.partial = "";
		}
		for (const waiter of [...win.waiters]) waiter.output?.();
	};
	const prompt = (win, exit, cwd) => {
		if (win.partial !== "") {
			push(win, tidy(win.partial));
			win.partial = "";
		}
		win.cwd = cwd;
		if (win.state === "starting") {
			win.state = "idle";
			win.ready?.();
			return;
		}
		if (win.state !== "busy") return;
		const now = Date.now();
		win.last = { command: win.command, exit, ms: now - win.since, endedAt: now };
		win.state = "idle";
		win.asked = undefined;
		record();
		const watched = win.waiters.size > 0;
		settle(win, "done");
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
				if (data.length - at > 4200) text(win, data.slice(at + 1));
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
		if (win.state === "closed") return;
		const was = win.state;
		win.state = "closed";
		win.closedBecause = why;
		if (windows.get(win.name) === win) windows.delete(win.name);
		record();
		const watched = win.waiters.size > 0;
		settle(win, "closed");
		win.fail?.(new SandboxError(`the window could not be opened: ${since(win, 0).slice(-3).join(" ").trim() || why}`));
		if (was === "busy" && !watched && why === "its shell ended") emit({ type: "closed", name: win.name, command: win.command, ms: Date.now() - win.since, at: Date.now() });
	};

	const open = async (name, network) => {
		const mode = runner.mode;
		if (mode === "none") throw new SandboxError(runner.available?.why ?? "no sandbox");
		if (!findScript()) throw new SandboxError("the `script` program (part of util-linux) was not found, and a shell window needs it for its terminal");
		if (mode === "sandbox" && runner.available?.shell !== undefined && runner.available.shell !== "bash") throw new SandboxError("bash was not found, and a shell window needs it");
		mkdirSync(dir, { recursive: true });
		const rc = join(dir, "rc");
		writeFileSync(rc, RC);
		const inner = ["script", "-qfec", `bash --noprofile --rcfile ${quote(rc)} --noediting -i`, "/dev/null"];
		const win = {
			name,
			network: mode === "direct" ? true : network,
			sandbox: mode === "sandbox",
			state: "starting",
			lines: [],
			dropped: 0,
			partial: "",
			pending: "",
			waiters: new Set(),
			cwd: root,
			outputs: 0,
			lastOutputAt: 0,
			head: [],
		};
		let child;
		if (mode === "sandbox") {
			const { args, env } = sandboxArgs({ root, brainDir, network, read: config.shellRead });
			child = spawn("bwrap", [...args, "--", ...inner], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
		} else {
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
			setTimeout(() => ended(code), 500).unref();
		});
		if (mode === "direct" && child.pid !== undefined) {
			// Outside the sandbox nothing ends the window when Cartographer itself is killed. This does.
			const reaper = spawn(process.execPath, [REAPER, String(process.pid), String(child.pid)], { stdio: "ignore", detached: true });
			reaper.on("error", () => {});
			reaper.unref();
		}
		const timer = setTimeout(() => win.fail?.(new SandboxError("the window did not start within 15 s")), 15_000);
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
			if (win.state === "closed") return resolve("closed");
			const waiter = { nudgeable, main };
			let timer;
			let poll;
			const onAbort = () => waiter.done("stopped");
			waiter.done = (reason) => {
				if (!win.waiters.delete(waiter)) return;
				clearTimeout(timer);
				clearInterval(poll);
				signal?.removeEventListener("abort", onAbort);
				resolve(reason);
			};
			if (until !== undefined) {
				waiter.output = () => {
					if (since(win, from).some((line) => line.includes(until))) waiter.done("until");
				};
			}
			win.waiters.add(waiter);
			timer = setTimeout(() => waiter.done("time"), Math.max(0, waitMs));
			// A program that printed something since this call began and now sits at a line without an end.
			poll = setInterval(() => {
				if (win.state === "busy" && win.outputs > outputs && tidy(win.partial).trim() !== "" && Date.now() - win.lastOutputAt >= ASKS_AFTER_MS) {
					// The caller is told, so nobody needs to be woken for it.
					win.asked = Date.now();
					waiter.done("asks");
				}
				// An answer has come and nothing followed it.
				else if (quietMs !== undefined && win.state === "busy" && win.outputs > outputs && tidy(win.partial).trim() === "" && Date.now() - win.lastOutputAt >= quietMs) waiter.done("quiet");
			}, 200);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			waiter.output?.();
		});

	/** Press Ctrl-C in a window and see whether its command ends. */
	const interrupt = async (win) => {
		if (win.state !== "busy") return true;
		const from = end(win);
		win.child.stdin.write("\x03");
		if ((await watch(win, { from, waitMs: 3000 })) === "done" || win.state !== "busy") return true;
		win.child.stdin.write("\x03\x1c");
		await watch(win, { from, waitMs: 2000 });
		return win.state !== "busy";
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
		const done = reason === "done" && win.last !== undefined;
		// What a call has returned is not returned again. What is printed between two calls goes to the next one.
		if (reason !== "read" && reason !== "idle") win.seen = end(win);
		return {
			window: win.name,
			reason,
			state: win.state,
			// A command that ended the window's own shell: the status the shell left with.
			...(done ? { exit: win.last.exit } : reason === "closed" && Number.isInteger(win.exitCode) ? { exit: win.exitCode } : {}),
			ms: done ? win.last.ms : Date.now() - began,
			text: output.text(),
			lines: output.lines,
			last: output.last,
			cwd: where(win.cwd),
			network: win.network,
			sandbox: win.sandbox,
			...(win.state === "busy" ? { command: win.command, running: Date.now() - win.since } : {}),
		};
	};

	const find = (name) => {
		const win = windows.get(name);
		if (win !== undefined) return win;
		const lost = gone.find((entry) => entry.name === name);
		if (lost !== undefined) throw new WindowError(`Window ${name} is gone: ${lost.why ?? WHY_GONE}${lost.command ? `, and with it \`${lost.command.split("\n")[0].slice(0, 80)}\`` : ""}. \`shell\` with this window name opens a new one.`);
		const names = [...windows.keys()];
		throw new WindowError(`There is no window ${JSON.stringify(name)}. ${names.length === 0 ? "No window is open: `shell` opens one when it runs a command." : `Open: ${names.join(", ")}.`}`);
	};
	const checkName = (name) => {
		if (typeof name !== "string" || !NAME.test(name)) throw new WindowError(`A window name is a short word in lower case, such as main, server or tests; ${JSON.stringify(name)} is not.`);
	};
	const busyLine = (win) => `\`${win.command.split("\n")[0].slice(0, 80)}\` (running ${Math.max(0, Math.round((Date.now() - win.since) / 1000))} s)`;

	const manager = {
		/**
		 * Type a command into a window, opening the window when it is not there, and wait for it at most `waitMs`.
		 * @param {string} name
		 * @param {string} command
		 * @param {{ network?: boolean, waitMs: number, signal?: AbortSignal }} options
		 */
		async run(name, command, { network = false, waitMs, signal }) {
			checkName(name);
			let win = windows.get(name);
			if (win === undefined) {
				if (windows.size >= WINDOWS_MAX) throw new WindowError(`${WINDOWS_MAX} windows are open, which is the limit: ${[...windows.keys()].join(", ")}. Close one with \`window\` first, or run this in one of them.`);
				win = await open(name, network === true);
			} else {
				if (win.state === "busy") {
					throw new WindowError(`Window ${name} is busy with ${busyLine(win)}. To run this beside it, give \`shell\` another \`window\` name. To deal with what is running, use \`window\`: wait for it, stop it, or send it a line of input.`);
				}
				// The terminal closes every window when the user switches the sandbox; this is for a switch it did not see.
				if (win.sandbox !== (runner.mode === "sandbox")) {
					throw new WindowError(`Window ${name} was opened ${win.sandbox ? "in the sandbox" : "with the sandbox off"}, and that has changed since. Close it with \`window\`, then run this again: the window opens anew.`);
				}
				if (win.sandbox && win.network !== (network === true)) {
					throw new WindowError(
						win.network
							? `Window ${name} was opened by a task whose plan item is marked network, and this task's item is not. Run this in a window of another name.`
							: `Window ${name} was opened without network access, and it keeps it that way. This task may use the network: run this in a window of another name.`,
					);
				}
			}
			const began = Date.now();
			const file = join(dir, `${name}.cmd`);
			writeFileSync(file, `${command}\n`);
			const shown = command.split("\n");
			push(win, `$ ${shown[0]}`);
			for (const more of shown.slice(1, 6)) push(win, `  ${more}`);
			const from = end(win);
			Object.assign(win, { command, since: began, state: "busy", asked: undefined, lastOutputAt: 0, head: [] });
			active.add(name);
			record();
			// Read from a file, so that a command with a mistake in it cannot leave bash waiting for the rest of a line.
			win.child.stdin.write(` source ${quote(file)}\n`);
			const reason = await watch(win, { from, waitMs, signal });
			if (reason === "stopped") await interrupt(win);
			return report(win, reason, from, began);
		},

		/** Type a line into the program that is running in a window. */
		async send(name, line, { waitMs, signal }) {
			const win = find(name);
			if (win.state !== "busy") throw new WindowError(`Nothing is running in window ${name}, so there is nothing to send input to. \`shell\` runs a command there.`);
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
			if (win.state !== "busy") return report(win, win.last !== undefined && from < end(win) ? "done" : "idle", from, began);
			const reason = await watch(win, { from, waitMs, until, signal, nudgeable: true, main });
			return { ...report(win, reason, from, began), ...(reason === "nudged" && nudgedBy !== undefined ? { nudgedBy } : {}) };
		},

		/** The newest `count` lines of a window. */
		read(name, count = 40) {
			const win = find(name);
			const lines = since(win, 0);
			return { ...report(win, "read", end(win), Date.now()), text: lines.slice(-Math.max(1, Math.min(count, 400))).join("\n"), lines: lines.length, kept: end(win) };
		},

		/** Ctrl-C. @returns whether the command ended */
		async stop(name) {
			const win = find(name);
			if (win.state !== "busy") return { ...report(win, "idle", end(win), Date.now()), ended: true, wasBusy: false };
			const began = Date.now();
			const from = win.seen ?? end(win);
			const ended = await interrupt(win);
			return { ...report(win, ended ? "done" : "time", from, began), ended, wasBusy: true };
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
			const running = win.state === "busy" ? win.command : undefined;
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
		list(tail = 10) {
			const now = Date.now();
			const open = [...windows.values()].map((win) => {
				const lines = since(win, 0);
				const partial = tidy(win.partial);
				return {
					name: win.name,
					state: win.state,
					cwd: where(win.cwd),
					network: win.network,
					sandbox: win.sandbox,
					...(win.state === "busy" ? { command: win.command, running: now - win.since, quiet: win.lastOutputAt > 0 ? now - win.lastOutputAt : now - win.since, asks: partial.trim() !== "" && now - win.lastOutputAt >= ASKS_AFTER_MS } : {}),
					...(win.last ? { last: { ...win.last, ago: now - win.last.endedAt } } : {}),
					tail: lines.slice(-tail),
				};
			});
			return [...open, ...gone.map((entry) => ({ name: entry.name, state: "gone", why: entry.why ?? WHY_GONE, ...(entry.command ? { command: entry.command } : {}), tail: [] }))];
		},

		/** Whether a window of this name is open. */
		has: (name) => windows.has(name),
		/** How many lines a window has printed in all; undefined when it is not open. For those who watch it (src/wakes.mjs). */
		position: (name) => (windows.has(name) ? end(windows.get(name)) : undefined),
		/** Its finished lines from position `from` on, as far as they are still kept. */
		linesFrom(name, from) {
			const win = windows.get(name);
			return win === undefined ? [] : win.lines.slice(Math.max(0, from - win.dropped));
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
			active = new Set([...windows.values()].filter((win) => win.state === "busy").map((win) => win.name));
			return taken;
		},
		/** The user wrote: a call that only waits should return, so that the agent reads the message. */
		/**
		 * @param {string} [why]  what happened, when it was not a message of the user: the wait's result says it
		 * @param {{ mainOnly?: boolean }} [whose]  mainOnly: only a wait of the main agent ends; a task goes on waiting
		 */
		nudge(why, { mainOnly = false } = {}) {
			nudgedBy = why;
			for (const win of windows.values()) for (const waiter of [...win.waiters]) if (waiter.nudgeable && (!mainOnly || waiter.main)) waiter.done("nudged");
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
			if (win.state !== "busy" || win.waiters.size > 0 || win.lastOutputAt === 0) continue;
			if (win.asked !== undefined && win.asked >= win.lastOutputAt) continue;
			if (tidy(win.partial).trim() === "" || now - win.lastOutputAt < ASKS_WAKE_MS) continue;
			win.asked = now;
			emit({ type: "asks", name: win.name, command: win.command, line: tidy(win.partial).slice(0, 200), at: now });
		}
	}, 1000);
	ticker.unref();
	const atExit = () => {
		for (const win of windows.values()) kill(win);
	};
	process.on("exit", atExit);

	return manager;
}
