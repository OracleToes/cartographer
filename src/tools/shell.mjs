// The `shell` tool: commands in shell windows (src/windows.mjs).
//
// `shell` types a command into a named window and waits a while for it (action run,
// the default). Its other actions deal with a window that is open: read it, wait for
// it, send its program a line, stop what runs there, close it.
//
// Typing into a window, a command or input, is for a task that carries out a change
// item of the authorized plan; src/harness.mjs refuses everyone else before this code
// runs. Reading, waiting, stopping and closing are open to the main agent and to every
// task: none of them starts anything. Whether a window reaches the network is the
// plan item's `network` mark at the moment the window is opened.
//
// When the user has switched the sandbox off, a new window runs on the machine itself.
import { POLICY } from "../config.mjs";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { describe, REFUSALS } from "../prompt.mjs";
import { SandboxError } from "../sandbox.mjs";
import { ago, took } from "../time.mjs";
import { WAIT_MAX, WindowError } from "../windows.mjs";

export const SHELL_ACTIONS = POLICY.enums.shellActions;
/** The actions that only deal with a window that is open. */
export const WINDOW_ACTIONS = SHELL_ACTIONS.filter((action) => action !== POLICY.enums.shellAction.run);
/** The window a command goes to when none is named. */
export const MAIN_WINDOW = POLICY.sentinels.mainWindow;

const refuse = (text) => ({ isError: true, output: [{ type: "text", text: `Refused: ${text}` }] });
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
			return `still running after ${after} in window ${name}: the command keeps going there, and you can go on with other work. The windows block at the end of each request shows how it is doing. The same tool's actions wait for it, send it input, stop it or close it. A run with another window name runs something beside it.`;
		case POLICY.enums.windowWaitReasons.asks:
			return `still running after ${after} in window ${name}. Its last line has no line end, so the program may be waiting for input: action send types a line into it.`;
		case POLICY.enums.windowWaitReasons.quiet:
			return `this is what the program in window ${name} printed, and it has been quiet for a second since; it is still running`;
		case POLICY.enums.windowWaitReasons.until:
			return `the line appeared after ${after}; the command is still running in window ${name}`;
		case POLICY.enums.windowWaitReasons.nudged:
			return `the wait ended after ${after} because ${result.nudgedBy ?? "the user wrote a message"}; the command is still running in window ${name}`;
		case POLICY.enums.windowWaitReasons.stopped:
			return result.state === POLICY.enums.windowStates.busy ? `stopped by the user after ${after}, but the command did not end on Ctrl-C and is still running in window ${name}` : `stopped by the user after ${after} · window ${name}`;
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

/**
 * @param {{ config: { shellWait: number }, runner: ReturnType<typeof import("../sandbox.mjs").createRunner>, windows: ReturnType<typeof import("../windows.mjs").createWindows>, runOf: (conversationId: string) => { mode: string, network?: boolean } | undefined }} input
 *   runner: how commands run in this session, read at each call because the user can change it
 *   runOf: what kind of task a conversation is, as the harness last found it
 */
export function shellTool({ config, runner, windows, runOf }) {
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
			command: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "run: the command line, as you would type it in bash" })),
			window: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, description: `Name of the window, a short word such as server or tests. A name that is not open yet opens a new window. Default: ${MAIN_WINDOW}.` })),
			wait: opt(int({ minimum: POLICY.validation.nonNegativeMin, maximum: WAIT_MAX, description: `run: seconds to wait for the command to end before returning. Default ${config.shellWait}, at most ${WAIT_MAX}. ${POLICY.validation.nonNegativeMin} returns at once.` })),
			text: opt(str({ description: "send: the line to type. The line end is added." })),
			seconds: opt(int({ minimum: POLICY.validation.nonNegativeMin, maximum: WAIT_MAX, description: `wait: the longest to wait. Default ${config.shellWait}, at most ${WAIT_MAX}. send: how long to wait for the program's answer, default ${POLICY.timing.windows.sendWaitSeconds}.` })),
			until: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, description: "wait: return as soon as a new line of output contains this text, such as the line a server prints when it is ready." })),
			lines: opt(int({ minimum: POLICY.validation.positiveIntegerMin, maximum: POLICY.limits.windows.outputReadMaxLines, description: `read: how many lines, counted from the end. Default ${POLICY.limits.windows.outputReadDefaultLines}, at most ${POLICY.limits.windows.outputReadMaxLines}.` })),
		}, {
			allOf: [
				...[
					[POLICY.enums.shellAction.run, ["command"], ["text", "seconds", "until", "lines"]],
					[POLICY.enums.shellAction.read, ["window"], ["command", "wait", "text", "seconds", "until"]],
					[POLICY.enums.shellAction.wait, ["window"], ["command", "wait", "text", "lines"]],
					[POLICY.enums.shellAction.send, ["window", "text"], ["command", "wait", "until", "lines"]],
					[POLICY.enums.shellAction.stop, ["window"], ["command", "wait", "text", "seconds", "until", "lines"]],
					[POLICY.enums.shellAction.close, ["window"], ["command", "wait", "text", "seconds", "until", "lines"]],
				].map(([action, required, forbidden]) => ({
					if: { properties: { action: { const: action } }, required: ["action"] },
					then: { required, not: { anyOf: forbidden.map((key) => ({ required: [key] })) } },
				})),
				{
					if: { not: { required: ["action"] } },
					then: { required: ["command"], not: { anyOf: ["text", "seconds", "until", "lines"].map((key) => ({ required: [key] })) } },
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
				if (run?.mode !== POLICY.enums.planMode.change) return refuse(REFUSALS.lookTaskRuns);
				if (runner.mode === "none") return refuse(REFUSALS.noSandbox(runner.available.why));
				if (typeof args.command !== "string" || args.command.trim() === "") return refuse("`command` is empty: give the command line to run.");
				const name = typeof args.window === "string" && args.window.trim() !== "" ? args.window.trim() : MAIN_WINDOW;
				let result;
				try {
					result = await windows.run(name, args.command, { network: run.network === true, waitMs: waitOf(args.wait, config.shellWait) * 1000, signal: callContext.abortSignal });
				} catch (error) {
					if (error instanceof WindowError) return refuse(error.message);
					if (error instanceof SandboxError) return refuse(REFUSALS.noSandbox(error.message));
					throw error;
				}
				const failed = ((result.reason === POLICY.enums.windowWaitReasons.done || result.reason === POLICY.enums.windowWaitReasons.closed) && result.exit !== 0) || result.reason === POLICY.enums.windowWaitReasons.stopped;
				return {
					isError: failed,
					output: [{ type: "text", text: `${result.text === "" ? "(no output)" : result.text}\n[${statusLine(result, { noNetwork: result.sandbox && !result.network })}]` }],
					details: details(result),
				};
			}
			const name = typeof args.window === "string" && args.window.trim() !== "" ? args.window.trim() : "";
			if (name === "") return refuse("`window` is missing: name the window to deal with.");
			const out = (result, isError = false, extra = {}) => ({
				isError,
				output: [{ type: "text", text: `${result.text === "" ? "(no new output)" : result.text}\n[${statusLine(result)}]` }],
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
					if (typeof args.text !== "string") return refuse("`text` is missing: give the line to type into the program.");
					const found = windows.list(0).find((entry) => entry.name === name);
					if (found?.sandbox && found.network && run.network !== true) return refuse(`Window ${name} was opened by a task whose plan item is marked network, and this task's item is not.`);
					const result = await windows.send(name, args.text, { waitMs: waitOf(args.seconds, POLICY.timing.windows.sendWaitSeconds) * 1000, signal: callContext.abortSignal });
					return out(result, result.reason === POLICY.enums.windowWaitReasons.done && result.exit !== 0);
				}
				if (action === POLICY.enums.shellAction.stop) {
					const result = await windows.stop(name);
					if (!result.wasBusy) return { output: [{ type: "text", text: `[nothing is running in window ${name}, so there was nothing to stop${lastOf(windows, name)}]` }], details: details(result, { action }) };
					if (!result.ended) {
						return {
							isError: true,
							output: [{ type: "text", text: `${result.text === "" ? "(no new output)" : result.text}\n[the command in window ${name} did not end on Ctrl-C. \`shell\` with action close ends the window and everything in it.]` }],
							details: details(result, { action }),
						};
					}
					return { output: [{ type: "text", text: `${result.text === "" ? "(no new output)" : result.text}\n[stopped with Ctrl-C: exit ${result.exit} · window ${name} is free]` }], details: details(result, { action, stopped: true }) };
				}
				const result = windows.close(name);
				const text = result.wasGone
					? `Window ${name} is noted as gone.`
					: `Window ${name} is closed${result.running ? `, and \`${firstLine(result.running)}\` ended with it` : ""}.`;
				return { output: [{ type: "text", text }], details: { window: name, action, closed: true } };
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
