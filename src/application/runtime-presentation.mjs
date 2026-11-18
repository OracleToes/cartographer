// Presentation-safe formatting for Runtime projections.
//
// Mutable shell managers stay behind application queries and actions. Screen renderers receive settled snapshots plus
// this narrow vocabulary, so they never import a manager's domain rules merely to make a shell row legible.
import { POLICY } from "../config.mjs";
import { flat } from "../rows.mjs";
import { ago, took } from "../time.mjs";

const commandSummary = (text) => (text.length > POLICY.limits.screen.viewSummaryChars ? `${text.slice(0, POLICY.limits.screen.viewSummaryChars)}…` : text).replace(/\s+/g, " ");

const shell = (window) => {
	const shown = window.state === POLICY.enums.windowStates.busy ? window.command ?? "" : window.last?.command ?? "";
	const summary = commandSummary(shown);
	const marks = window.sandbox === false ? " · no sandbox" : window.network ? " · network" : "";
	const state = window.state === POLICY.enums.windowStates.gone
		? [["gone", "err"], [`  ${window.why}`, "muted"]]
		: window.state === POLICY.enums.windowStates.busy
			? [["busy", "warn"], [` ${took(window.running)}`, ""], [`  $ ${summary}`, "bold"], [window.asks ? "  may be waiting for input" : "", "warn"]]
			: [["free", "ok"], [window.last ? `  last: $ ${summary} → exit ${window.last.exit}, ${ago(window.last.ago)}` : "  nothing was run in it yet", "muted"]];
	return {
		shown,
		summary,
		wholeCommand: shown === "" ? undefined : `$ ${flat(shown)}`,
		truncated: shown !== "" && summary !== shown,
		state,
		location: `${window.cwd && window.cwd !== "." ? `  in ${window.cwd}/` : ""}${marks}`,
	};
};

const shellOutput = (window) => ({
	state: window.state === POLICY.enums.windowStates.busy
		? [["busy", "warn"], [`  $ ${window.command ?? ""}`, "bold"], [window.asks ? "  · may be waiting for input" : "", "warn"]]
		: window.state === POLICY.enums.windowStates.gone
			? [["gone", "err"], [`  ${window.why ?? ""}`, "muted"]]
			: [["free", "ok"]],
	location: `${window.cwd && window.cwd !== "." ? `  in ${window.cwd}/` : ""}${window.sandbox === false ? "  · no sandbox" : window.network ? "  · network" : ""}`,
});

/** The vocabulary migrated Runtime shell renderers need. Other Runtime views join this adapter as they migrate. */
export function createRuntimePresentation() {
	return Object.freeze({
		shells: Object.freeze({ shell, shellOutput }),
	});
}
