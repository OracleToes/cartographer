// Shared semantic labels for model activity. Both terminal adapters consume these compact descriptions, so the screen
// does not have to import the plain-terminal renderer just to name a call or result.
import { POLICY } from "../config.mjs";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
const oneLine = (text, max) => {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const count = (n) => (n >= POLICY.limits.format.countTenThousands ? `${Math.round(n / POLICY.limits.format.countThousands)}k` : n >= POLICY.limits.format.countThousands ? `${(n / POLICY.limits.format.countThousands).toFixed(1)}k` : String(n));
const plain = (text) => text.replace(/<\/?harness>/g, "").replace(/\[error\] (Tool call blocked: )?|^Tool call blocked: /, "").trim();

/** One line that says what a tool call is doing. `describeRef`, when given, names a ref instead of showing its bare id. */
export function describeCall(call, describeRef) {
	const args = call.arguments ?? {};
	switch (call.name) {
		case "task":
			return `task${typeof args.item === "string" && args.item !== "" ? ` ${args.item}` : ""}  ${oneLine(args.brief, POLICY.limits.terminal.callSummary.taskBrief)}`;
		case "shell": {
			// A command typed into a window, or one of the window actions; run is the default and needs no name of its own.
			if (args.action !== undefined && args.action !== POLICY.enums.shellAction.run) {
				const more = args.action === POLICY.enums.shellAction.send ? `  ${oneLine(JSON.stringify(args.text ?? ""), POLICY.limits.terminal.callSummary.sendText)}` : args.action === POLICY.enums.shellAction.wait && typeof args.until === "string" && args.until !== "" ? `  until ${oneLine(JSON.stringify(args.until), POLICY.limits.terminal.callSummary.waitUntil)}` : "";
				return `window ${oneLine(args.window, POLICY.limits.terminal.callSummary.windowName)}  ${args.action}${more}`;
			}
			return `$ ${oneLine(args.command, POLICY.limits.terminal.callSummary.shellCommand)}${typeof args.window === "string" && args.window !== "" && args.window !== POLICY.sentinels.mainWindow ? `  (window ${oneLine(args.window, POLICY.limits.terminal.callSummary.windowName)})` : ""}`;
		}
		case "write":
			return `write ${oneLine(args.path, POLICY.limits.terminal.callSummary.writePath)}`;
		case "edit":
			return `edit ${oneLine(args.path, POLICY.limits.terminal.callSummary.writePath)}`;
		case "book": {
			const target = typeof args.target === "string" && args.target !== "" ? args.target : "";
			const action = typeof args.action === "string" && args.action !== "" ? args.action : "?";
			const rawRef = args.ref && typeof args.ref === "object" && typeof args.ref.id === "string" && args.ref.id !== "" ? args.ref : (typeof args.id === "string" && args.id !== "" ? { ...(target !== "" && target !== "shelf" ? { kind: target } : {}), id: args.id } : undefined);
			const refText = rawRef !== undefined ? (describeRef?.(rawRef) ?? rawRef.id) : undefined;
			const what = refText ?? args.path ?? args.name ?? args.kind ?? args.mode ?? args.text ?? args.gist ?? "";
			return `book ${[target, action, oneLine(String(what), POLICY.limits.terminal.callSummary.contextOp)].filter((piece) => piece !== "").join(" ")}`.trim();
		}
		case "read": {
			// Older stored calls can have plural `paths`; new public reads are one-file `path` calls.
			if (args.paths !== undefined) {
				const paths = Array.isArray(args.paths) ? args.paths : [args.paths];
				const range = args.offset !== undefined || args.limit !== undefined ? ` (from line ${args.offset ?? 1}${args.limit !== undefined ? `, ${args.limit} lines` : ""})` : "";
				return `read ${oneLine(paths.join(", "), POLICY.limits.terminal.callSummary.readPaths)}${range}`;
			}
			const rawRef = args.ref && typeof args.ref === "object" && typeof args.ref.id === "string" && args.ref.id !== ""
				? args.ref
				: (typeof args.id === "string" && args.id !== "" ? { kind: "file", id: args.id } : undefined);
			const target = rawRef !== undefined ? (describeRef?.(rawRef) ?? rawRef.id) : (args.path ?? "");
			const range = typeof args.range === "string" && args.range !== "" ? ` (lines ${args.range})` : "";
			return `read ${oneLine(String(target), POLICY.limits.terminal.callSummary.readPaths)}${range}`.trim();
		}
		case "shelf": {
			const action = typeof args.action === "string" && args.action !== "" ? args.action : "?";
			const rawRef = args.ref && typeof args.ref === "object" && typeof args.ref.id === "string" && args.ref.id !== ""
				? args.ref
				: (typeof args.id === "string" && args.id !== "" ? { ...(/^f\d+$/.test(args.id) ? { kind: "file" } : /^c\d+$/.test(args.id) ? { kind: "atlas" } : {}), id: args.id } : undefined);
			const target = rawRef !== undefined ? (describeRef?.(rawRef) ?? rawRef.id) : (args.path ?? "");
			const range = typeof args.range === "string" && args.range !== "" ? ` (lines ${args.range})` : "";
			return `shelf ${[action, oneLine(String(target), POLICY.limits.terminal.callSummary.contextOp)].filter((piece) => piece !== "").join(" ")}${range}`.trim();
		}
		case "search":
			return `search /${oneLine(args.pattern, POLICY.limits.terminal.callSummary.searchPattern)}/${args.path ? ` in ${args.path}` : ""}${args.glob ? ` (${args.glob})` : ""}`;
		case "list":
			return `list ${args.path ?? "."}${args.depth !== undefined ? ` (depth ${args.depth})` : ""}`;

		case "consult":
			return `consult conference  ${oneLine(args.question, POLICY.limits.terminal.callSummary.consultQuestion)}`;
		case "wake":
			return `wake ${args.action ?? "?"} ${oneLine(args.id ?? args.note ?? "", POLICY.limits.terminal.callSummary.wakeCall)}`.trim();
		case "sleep":
			return "sleep";
		default:
			return `${call.name} ${oneLine(JSON.stringify(args), POLICY.limits.terminal.callSummary.genericCall)}`;
	}
}

/** A few words on what a tool result holds. */
export function describeResult(message) {
	const text = textOf(message);
	// A command that ran: how it ended, how long it took, and the last thing it printed.
	if (message.toolName === "shell" && message.details?.seconds !== undefined) {
		const { exit, running, asks, stopped, closed, seconds, last, sandbox, action, lines } = message.details;
		const time = `${seconds < POLICY.limits.format.elapsedSecondPrecisionBelow ? seconds.toFixed(1) : Math.round(seconds)} s`;
		const how = closed
			? `${exit !== undefined ? `exit ${exit} · ` : ""}the window closed`
			: action === "read"
				? `${count(lines)} lines${running ? " · still running" : ""}`
				: running
					? `${asks ? "may be waiting for input" : stopped ? "did not stop" : "still running"} after ${time}`
					: exit !== undefined
						? `${stopped ? "stopped · " : ""}exit ${exit} · ${time}`
						: stopped
							? "stopped"
							: "nothing is running there";
		return `${how}${sandbox === false ? " · no sandbox" : ""}${last ? ` · ${oneLine(last, POLICY.limits.terminal.resultSummary.shellLast)}` : ""}`;
	}
	if (message.details?.window !== undefined && message.details?.closed) return "closed";
	// What a task did about its own context, in the tool's own words.
	if (message.toolName === "book" && (message.details?.target === "context" || message.details?.book === "context") && !message.isError && Array.isArray(message.details?.shown)) return oneLine(message.details.shown.join(" · "), POLICY.limits.terminal.resultSummary.context);
	// The harness's own words for a call the user stopped, or one that a restart cut off.
	if (message.isError && /^Tool \w+ was aborted/.test(plain(text))) return "stopped";
	if (message.isError && /^Tool \w+ was interrupted/.test(plain(text))) return "cut off by a restart, and not run again";
	if (message.isError) return `refused: ${oneLine(plain(text).replace(/^Refused: /, ""), POLICY.limits.terminal.resultSummary.refusal)}`;
	// What was written to the graph (through `book` with target=atlas); for a call that only read, the first line of what it got.
	if (message.toolName === "book" && message.details?.target === "atlas") return oneLine(Array.isArray(message.details?.shown) && message.details.shown.length > 0 ? message.details.shown.join(" · ") : text.split("\n")[0], POLICY.limits.terminal.resultSummary.atlas);
	if (message.toolName === "search") return oneLine(text.split("\n")[0], POLICY.limits.terminal.resultSummary.search);
	if (message.toolName === "list") return oneLine(text.split("\n")[0], POLICY.limits.terminal.resultSummary.list);
	if (message.toolName === "shelf") return oneLine(text.split("\n")[0], POLICY.limits.terminal.resultSummary.context);
	// A same-model conference has a compact parent receipt; its detailed notebook stays private under /consult co<N>.
	if (message.toolName === "consult" && !message.isError && typeof message.details?.conference === "string") {
		return oneLine(text, POLICY.limits.terminal.resultSummary.refusal);
	}
	// "Wrote roll.py: 34 lines, a new file." / "Edited roll.py: …" / "Removed roll.py."
	if (message.toolName === "write" || message.toolName === "edit" || (message.toolName === "book" && message.details?.target === "file" && message.details?.change === true)) {
		// A direct-file result may follow its receipt with the focus-local surface accounting. The terminal's one-line
		// summary names the mutation; the full result still carries the visible allowance facts.
		const first = text.split("\n")[0];
		const colon = first.indexOf(": ");
		const summary = colon >= 0 ? first.slice(colon + 2).replace(/\s+File id:.*$/, "").replace(/\.$/, "") : first.replace(/\.$/, "");
		return oneLine(summary, POLICY.limits.terminal.resultSummary.write);
	}
	const lines = text.split("\n").length;
	return `${count(lines)} lines`;
}
