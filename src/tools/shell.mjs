// The `shell` tool: commands in shell windows (src/windows.mjs).
//
// `shell` types a command into a named window and waits a while for it (action run,
// the default). Its other actions deal with a window that is open: read it, wait for
// it, send its program a line, stop what runs there, close it.
//
// Typing into a window, a command or input, is for a task that carries out a change
// move of the authorized plan; src/harness.mjs refuses everyone else before this code
// runs. The main conversation may run a command without a task, on its own authority,
// but only in a read-only window (src/windows.mjs): the project, the brain and .git are
// mounted read-only and the window never reaches the network. A read-only window needs
// bubblewrap — with the sandbox switched off it is still what the main agent's commands
// run in, when bubblewrap works; when it does not, nothing holds a command to read-only,
// and the main agent runs none. Good for tests, lints, typechecks and git status.
// Reading, waiting, stopping and closing are open to the main agent and to every task:
// none of them starts anything. Whether a window reaches the network is the move's
// `network` capability at the moment the window is opened.
//
// When the user has switched the sandbox off, a new window runs on the machine itself.
import { POLICY } from "../config.mjs";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { describe, REFUSALS } from "../prompt.mjs";
import { SandboxError } from "../sandbox.mjs";
import { createStage, loadStage, StageError } from "../stage.mjs";
import { ago, took } from "../time.mjs";
import { WAIT_MAX, WindowError } from "../windows.mjs";
import { USER_NAME } from "../user.mjs";
import { loadContext, taskState, updateContext } from "../context.mjs";
import { liveMove, loadPlan } from "../plan.mjs";

export const SHELL_ACTIONS = POLICY.enums.shellActions;
/** The actions that only deal with a window that is open. */
export const WINDOW_ACTIONS = SHELL_ACTIONS.filter((action) => action !== POLICY.enums.shellAction.run);
/** The window a command goes to when none is named. */
export const MAIN_WINDOW = POLICY.sentinels.mainWindow;

const refuse = (text) => ({ isError: true, output: [{ type: "text", text: `Refused: ${text}` }] });
/** Which arguments each action consumes; anything else is said, not swallowed. */
const ACTION_PARAMS = {
	run: ["command", "window", "seconds"],
	read: ["window", "lines"],
	wait: ["window", "seconds", "until"],
	send: ["window", "text", "seconds"],
	stop: ["window"],
	close: ["window"],
};
const PARAM_HINT = { command: "run", window: "read, wait, send, stop and close", seconds: "run, wait and send", text: "send", until: "wait", lines: "read" };
/** One line naming the arguments that mean nothing for this action, when there are any. */
export const ignoredLine = (args, action) => {
	const ok = new Set(ACTION_PARAMS[action] ?? []);
	const ignored = Object.keys(args ?? {}).filter((key) => key !== "action" && !ok.has(key));
	return ignored.length === 0 ? "" : `\nIgnored as not for \`${action}\`: ${ignored.map((key) => `\`${key}\` (${PARAM_HINT[key] ?? "no action"} only)`).join(", ")}.`;
};
const seconds = (ms) => (ms < POLICY.limits.format.durationCompactAtMs ? `${(ms / 1000).toFixed(POLICY.limits.format.durationDecimals)} s` : took(ms));
const firstLine = (command) => {
	const line = String(command ?? "").split("\n")[0];
	return line.length > POLICY.limits.windows.commandSummaryChars ? `${line.slice(0, POLICY.limits.windows.commandSummaryChars)}…` : line;
};

/** The line under a result that says how things stand in the window. */
export function statusLine(result, { noNetwork = false } = {}) {
	const name = result.window;
	const place = result.cwd !== "." ? `, in ${result.cwd}/` : "";
	const after = seconds(result.ms);
	switch (result.reason) {
		case POLICY.enums.windowWaitReasons.done:
			return `exit ${result.exit} · ${after} · window ${name}${place}${result.exit !== 0 && noNetwork ? " · this window has no network" : ""}`;
		case POLICY.enums.windowWaitReasons.time:
			return `still running after ${after} in window ${name}: the command keeps going there, and I go on with other work. The windows block at the end of each request shows how it is doing. The same tool's actions wait for it, send it input, stop it or close it. A run with another window name runs something beside it.`;
		case POLICY.enums.windowWaitReasons.asks:
			return `still running after ${after} in window ${name}. Its last line has no line end, so the program may be waiting for input: action send types a line into it.`;
		case POLICY.enums.windowWaitReasons.quiet:
			return `this is what the program in window ${name} printed, and it has been quiet for a second since; it is still running`;
		case POLICY.enums.windowWaitReasons.until:
			return `the line appeared after ${after}; the command is still running in window ${name}`;
		case POLICY.enums.windowWaitReasons.nudged:
			return `the wait ended after ${after} because ${result.nudgedBy ?? `${USER_NAME} wrote a message`}; the command is still running in window ${name}`;
		case POLICY.enums.windowWaitReasons.stopped:
			return result.state === POLICY.enums.windowStates.busy ? `stopped by ${USER_NAME} after ${after}, but the command did not end on Ctrl-C and is still running in window ${name}` : `stopped by ${USER_NAME} after ${after} · window ${name}`;
		case POLICY.enums.windowWaitReasons.closed:
			return result.exit === undefined
				? `window ${name} is closed: its shell ended`
				: `exit ${result.exit} · the command ended the window's own shell (\`exit\` does that), so window ${name} is closed, and its folder and environment are gone. The next \`shell\` call opens it anew, in the project directory.`;
		default:
			return `window ${name}${place}`;
	}
}

const details = (result, extra = {}) => ({
	window: result.window,
	...(result.exit !== undefined && (result.reason === POLICY.enums.windowWaitReasons.done || result.reason === POLICY.enums.windowWaitReasons.closed) ? { exit: result.exit } : {}),
	...(result.state === POLICY.enums.windowStates.busy ? { running: true } : {}),
	...(result.reason === POLICY.enums.windowWaitReasons.asks ? { asks: true } : {}),
	...(result.reason === POLICY.enums.windowWaitReasons.stopped ? { stopped: true } : {}),
	...(result.reason === POLICY.enums.windowWaitReasons.closed ? { closed: true } : {}),
	...(result.sandbox === false ? { sandbox: false } : {}),
	seconds: Math.round(result.ms / POLICY.limits.format.durationRoundMs) / POLICY.limits.format.durationTenthsPerSecond,
	lines: result.lines,
	last: (result.last ?? "").slice(0, POLICY.limits.terminal.messageSummaryChars),
	...extra,
});

const waitOf = (given, fallback) => Math.min(Number.isFinite(given) && given >= 0 ? given : fallback, WAIT_MAX);

/** Re-read the move at command time. A cached task brief is never continuing authority. */
function commandAuthority(brainDir, api, run, gate, { start = false, window } = {}) {
	const task = loadContext(brainDir).tasks[api.conversationId];
	if (run?.mode !== POLICY.enums.planMode.change || typeof run?.move !== "string" || !Number.isInteger(run.revision) || task?.move !== run.move || task?.revision !== run.revision) {
		return { error: "this focus has no live move token, so it cannot type into a shell window" };
	}
	const { plan, error } = loadPlan(brainDir);
	if (plan === undefined) return { error: `the plan cannot be read (${error})` };
	const live = liveMove(plan, run.move, run.revision, { yolo: gate?.yolo === true });
	if (live.error !== undefined) return { error: live.error };
	if (live.move.capabilities?.commands !== true) return { error: `${live.move.id} does not allow commands` };
	if (start) {
		const ceiling = live.move.budget?.commandStarts ?? POLICY.limits.plan.moveBudget.commandStarts;
		if ((task.commandUses ?? 0) >= ceiling) return { error: `${live.move.id} already started all ${ceiling} commands; return blocked and plan a successor move` };
	}
	if (window !== undefined && !(task.windows ?? []).includes(window)) return { error: `window ${window} was not started by this move; do not type into another move's program` };
	return { task, live };
}

function recordCommand(brainDir, conversationId, entry, { started = false, window } = {}) {
	updateContext(brainDir, (store) => {
		const task = taskState(store, conversationId);
		if (started) task.commandUses = (task.commandUses ?? 0) + 1;
		if (window !== undefined && !(task.windows ?? []).includes(window)) (task.windows ??= []).push(window);
		const commands = (task.commands ??= []);
		commands.push(entry);
		if (commands.length > POLICY.limits.task.commandRecords) commands.splice(0, commands.length - POLICY.limits.task.commandRecords);
	});
}

/**
 * @param {{ root?: string, config: { shellWait: number }, brainDir: string, gate?: { yolo: boolean }, runner: ReturnType<typeof import("../sandbox.mjs").createRunner>, windows: ReturnType<typeof import("../windows.mjs").createWindows>, runOf: (conversationId: string) => { mode: string, network?: boolean, move?: string, revision?: number } | undefined }} input
 *   runner: how commands run in this session, read at each call because the user can change it
 *   runOf: what kind of task a conversation is, as the harness last found it
 */
export function shellTool({ root, config, brainDir, gate, runner, windows, runOf }) {
	return defineTool({
		name: "shell",
		description: describe("shell"),
		parameters: obj({
			action: opt(
				oneOf(SHELL_ACTIONS, {
					description:
						"run (the default): type `command` into the window. read: more of its output. wait: return when its command ends, prints `until`, or after `seconds`. send: type `text` as a line into the program that runs there. stop: press Ctrl-C. close: end the window and everything in it.",
				}),
			),
			command: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "run: the command line, as I would type it in bash" })),
			window: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, description: `Name of the window, a short word such as server or tests. A name that is not open yet opens a new window. Default: ${MAIN_WINDOW}.` })),
			text: opt(str({ description: "send: the line to type. The line end is added." })),
			seconds: opt(int({ minimum: POLICY.validation.nonNegativeMin, maximum: WAIT_MAX, description: `run: seconds to wait before returning. wait: the longest to wait. send: how long to wait for the program's answer. Default ${config.shellWait}, at most ${WAIT_MAX}. ${POLICY.validation.nonNegativeMin} returns at once.` })),
			until: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, description: "wait: return as soon as a new line of output contains this text, such as the line a server prints when it is ready." })),
			lines: opt(int({ minimum: POLICY.validation.positiveIntegerMin, maximum: POLICY.limits.windows.outputReadMaxLines, description: `read: how many lines, counted from the end. Default ${POLICY.limits.windows.outputReadDefaultLines}, at most ${POLICY.limits.windows.outputReadMaxLines}.` })),
		}, {
			allOf: [
				...[
					[POLICY.enums.shellAction.run, ["command"]],
					[POLICY.enums.shellAction.read, ["window"]],
					[POLICY.enums.shellAction.wait, ["window"]],
					[POLICY.enums.shellAction.send, ["window", "text"]],
					[POLICY.enums.shellAction.stop, ["window"]],
					[POLICY.enums.shellAction.close, ["window"]],
				].map(([action, required]) => ({
					if: { properties: { action: { const: action } }, required: ["action"] },
					then: { required },
				})),
				{
					if: { not: { required: ["action"] } },
					then: { required: ["command"] },
				},
			],
		}),
		// The output is bounded by src/sandbox.mjs, which keeps its end. These limits are above that bound, so the
		// harness never cuts a result, and with it the line that says how the command ended.
		outputLimits: { ...POLICY.limits.shellOutput },
		executionMode: "sequential",
		// Not run a second time after a crash: the command may have done half its work. For the window actions a
		// re-run would find no window after a restart and say so, but one setting covers both.
		replay: POLICY.enums.toolReplay.unsafe,
		execute: async (args, api, callContext) => {
			const action = SHELL_ACTIONS.includes(args.action) ? args.action : POLICY.enums.shellAction.run;
			if (action === POLICY.enums.shellAction.run) {
				const run = runOf(api.conversationId);
				// The main conversation may run a command on its own authority, as a read: the window is confined
				// (the project, the brain and .git mounted read-only, no network). Typing into a running program is not a read.
				const confined = api.conversationId === ROOT_CONVERSATION_ID && run?.mode !== POLICY.enums.planMode.change;
				if (run?.mode !== POLICY.enums.planMode.change && !confined) return refuse(REFUSALS.lookTaskRuns);
					const name = typeof args.window === "string" && args.window.trim() !== "" ? args.window.trim() : MAIN_WINDOW;
					// A free window still carries another move's shell state. A change move may open
					// a fresh name or reuse only a name it already opened; it cannot inherit a peer's
					// directory, environment, network lane, or future process control.
					const existing = windows.list(0).some((window) => window.name === name);
					const authority = confined ? undefined : commandAuthority(brainDir, api, run, gate, { start: true, ...(existing ? { window: name } : {}) });
				if (authority?.error !== undefined) return refuse(authority.error);
				// A direct change move deliberately runs without bubblewrap. Only the main agent's
				// read-only lane needs bubblewrap, because it is the mechanism that keeps that lane read-only.
				const canReadOnly = runner.mode === "sandbox" || (runner.mode === "direct" && runner.available?.ok === true);
				if (runner.mode === "none") return refuse(REFUSALS.noSandbox(runner.available?.why ?? "no sandbox"));
				if (confined && !canReadOnly) return refuse(REFUSALS.mainReadOnlyOff(runner.available?.why));
				if (typeof args.command !== "string" || args.command.trim() === "") return refuse("`command` is empty: give the command line to run.");
				let stage;
				// A normal change command receives one disposable candidate tree while bubblewrap is active. The task
				// record holds only its receipt; direct mode intentionally retains the old detection-only lane.
				if (!confined && runner.mode === "sandbox" && typeof root === "string") {
					try {
						stage = authority.task.stage === undefined ? createStage({ root }) : loadStage(authority.task.stage);
						if (authority.task.stage === undefined) {
							updateContext(brainDir, (store) => {
								const task = taskState(store, api.conversationId);
								task.stage = { id: stage.id, root: stage.root, work: stage.work, home: stage.home, tmp: stage.tmp, source: stage.source, mounts: stage.mounts };
							});
						}
					} catch (error) {
						if (error instanceof StageError) return refuse(`A disposable command stage could not be prepared: ${error.message}`);
						throw error;
					}
				}
				let result;
				try {
					result = await windows.run(name, args.command, {
						network: confined ? false : authority.live.move.capabilities.network === true,
						waitMs: waitOf(args.seconds, config.shellWait) * 1000,
						signal: callContext.abortSignal,
						readOnly: confined,
						...(stage === undefined ? {} : { stage }),
					});
				} catch (error) {
					if (error instanceof WindowError) return refuse(error.message);
					if (error instanceof SandboxError) return refuse(REFUSALS.noSandbox(error.message));
					throw error;
				}
				if (!confined) {
					recordCommand(brainDir, api.conversationId, {
						move: authority.live.move.id,
						command: firstLine(args.command),
						window: name,
						reason: result.reason,
						...(stage === undefined ? {} : { stage: stage.id }),
						...(result.exit !== undefined ? { exit: result.exit } : {}),
					}, { started: true, window: name });
				}
				const failed = ((result.reason === POLICY.enums.windowWaitReasons.done || result.reason === POLICY.enums.windowWaitReasons.closed) && result.exit !== 0) || result.reason === POLICY.enums.windowWaitReasons.stopped;
				// A read-only window mounts the project read-only, so a command that must write there ends with an error; say so.
				const hint = confined && failed ? "\n[this window is read-only: the project and the brain are mounted read-only, and it has no network. A command that must write runs in a declared change move.]" : "";
				const stagedHint = stage === undefined ? "" : "\n[this command changed only a disposable candidate workspace. Its diff is checked and may be promoted only when this move closes through the ordinary approved checkpoint path.]";
				return {
					isError: failed,
					output: [{ type: "text", text: `${result.text === "" ? "(no output)" : result.text}${ignoredLine(args, action)}\n[${statusLine(result, { noNetwork: result.sandbox && !result.network })}]${hint}${stagedHint}` }],
					details: details(result, confined ? { readOnly: true } : { move: authority.live.move.id, ...(stage === undefined ? {} : { stage: stage.id }) }),
				};
			}
			const name = typeof args.window === "string" && args.window.trim() !== "" ? args.window.trim() : "";
			if (name === "") return refuse("`window` is missing: name the window to deal with.");
			const out = (result, isError = false, extra = {}) => ({
				isError,
				output: [{ type: "text", text: `${result.text === "" ? "(no new output)" : result.text}${ignoredLine(args, action)}\n[${statusLine(result)}]` }],
				details: details(result, { action, ...extra }),
			});
			try {
				if (action === POLICY.enums.shellAction.read) {
					const result = windows.read(name, Number.isFinite(args.lines) && args.lines > 0 ? args.lines : POLICY.limits.windows.outputReadDefaultLines);
					const now = result.state === POLICY.enums.windowStates.busy ? `busy with \`${firstLine(result.command)}\` for ${took(result.running)}` : "nothing is running";
					return {
						output: [{ type: "text", text: `${result.text === "" ? "(the window has printed nothing)" : result.text}\n[window ${name}: ${now}${result.cwd !== "." ? ` · in ${result.cwd}/` : ""} · ${result.kept} ${result.kept === 1 ? "line" : "lines"} in all]` }],
						details: details(result, { action }),
					};
				}
				if (action === POLICY.enums.shellAction.wait) {
					const until = typeof args.until === "string" && args.until !== "" ? args.until : undefined;
					const result = await windows.wait(name, { waitMs: waitOf(args.seconds, config.shellWait) * 1000, until, signal: callContext.abortSignal, main: api.conversationId === ROOT_CONVERSATION_ID });
					if (result.reason === POLICY.enums.windowWaitReasons.idle) return { output: [{ type: "text", text: `[nothing is running in window ${name}${lastOf(windows, name)}]` }], details: details(result, { action }) };
					if (result.reason === POLICY.enums.windowWaitReasons.stopped) return out({ ...result, reason: POLICY.enums.windowWaitReasons.time });
					return out(result, result.reason === POLICY.enums.windowWaitReasons.done && result.exit !== 0);
				}
				if (action === POLICY.enums.shellAction.send) {
					const run = runOf(api.conversationId);
					if (run?.mode !== POLICY.enums.planMode.change) return refuse(REFUSALS.lookTaskRuns);
					const authority = commandAuthority(brainDir, api, run, gate, { window: name });
					if (authority.error !== undefined) return refuse(authority.error);
					if (typeof args.text !== "string") return refuse("`text` is missing: give the line to type into the program.");
					const result = await windows.send(name, args.text, { waitMs: waitOf(args.seconds, POLICY.timing.windows.sendWaitSeconds) * 1000, signal: callContext.abortSignal });
					recordCommand(brainDir, api.conversationId, { move: authority.live.move.id, window: name, input: firstLine(args.text), reason: result.reason, ...(result.exit !== undefined ? { exit: result.exit } : {}) });
					return out(result, result.reason === POLICY.enums.windowWaitReasons.done && result.exit !== 0, { move: authority.live.move.id });
				}
					if (action === POLICY.enums.shellAction.stop) {
						const run = api.conversationId === ROOT_CONVERSATION_ID ? undefined : runOf(api.conversationId);
						const authority = run === undefined ? undefined : commandAuthority(brainDir, api, run, gate, { window: name });
						if (authority?.error !== undefined) return refuse(authority.error);
						const result = await windows.stop(name);
						if (authority !== undefined) recordCommand(brainDir, api.conversationId, { move: authority.live.move.id, window: name, action: "stop", reason: result.ended ? "stopped" : "still-running" });
						if (!result.wasBusy) return { output: [{ type: "text", text: `[nothing is running in window ${name}, so there was nothing to stop${lastOf(windows, name)}]` }], details: details(result, { action, ...(authority ? { move: authority.live.move.id } : {}) }) };
						if (!result.ended) {
							return {
								isError: true,
								output: [{ type: "text", text: `${result.text === "" ? "(no new output)" : result.text}\n[the command in window ${name} did not end on Ctrl-C. \`shell\` with action close ends the window and everything in it.]` }],
								details: details(result, { action, ...(authority ? { move: authority.live.move.id } : {}) }),
							};
						}
						return { output: [{ type: "text", text: `${result.text === "" ? "(no new output)" : result.text}\n[stopped with Ctrl-C: exit ${result.exit} · window ${name} is free]` }], details: details(result, { action, stopped: true, ...(authority ? { move: authority.live.move.id } : {}) }) };
					}
					const run = api.conversationId === ROOT_CONVERSATION_ID ? undefined : runOf(api.conversationId);
					const authority = run === undefined ? undefined : commandAuthority(brainDir, api, run, gate, { window: name });
					if (authority?.error !== undefined) return refuse(authority.error);
					const result = windows.close(name);
					if (authority !== undefined) recordCommand(brainDir, api.conversationId, { move: authority.live.move.id, window: name, action: "close", reason: result.wasGone ? "gone" : "closed" });
					const text = result.wasGone
						? `Window ${name} is noted as gone.`
						: `Window ${name} is closed${result.running ? `, and \`${firstLine(result.running)}\` ended with it` : ""}.`;
					return { output: [{ type: "text", text }], details: { window: name, action, closed: true, ...(authority ? { move: authority.live.move.id } : {}) } };
			} catch (error) {
				if (error instanceof WindowError) return refuse(error.message);
				throw error;
			}
		},
	});
}

/** ". Its last command, `x`, ended with exit 0, 3 m ago" */
function lastOf(windows, name) {
	const last = windows.list(0).find((entry) => entry.name === name)?.last;
	return last === undefined ? "" : `. Its last command, \`${firstLine(last.command)}\`, ended with exit ${last.exit}, ${ago(last.ago)}`;
}
