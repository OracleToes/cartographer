// Migrated Runtime shell renderers.
//
// Each renderer receives an already-settled application projection and the small presentation vocabulary assembled by
// screen composition. It owns no runtime-manager import and starts no live read while it makes list rows.

/** A passive line in a Runtime collection. */
const note = (text, style = "muted") => ({ key: `note:${text}`, plain: true, head: [[text, style]] });

/** Render the deferred Runtime shell-list projection; this renderer never touches a live window manager. */
export function shellsView({ windows: all = [], presentation } = {}) {
	if (presentation === undefined || typeof presentation.shell !== "function") throw new TypeError("Shell windows need their Runtime presentation adapter.");
	if (all.length === 0) return { header: [], items: [note("  No shell window is open. A change task opens one when it runs a command.")] };
	const items = all.map((window) => {
		const described = presentation.shell(window);
		const body = [described.truncated ? described.wholeCommand : undefined, ...window.tail].filter((line) => line !== undefined).join("\n");
		return {
			key: `window:${window.name}`,
			head: [[`${window.name}  `, "bold"], ...described.state, [described.location, "muted"]],
			...(body !== "" ? { body, bodyStyle: (line) => (line.startsWith("$ ") ? "bold" : "") } : {}),
			copy: () => [described.wholeCommand, ...window.tail].filter((line) => line !== undefined).join("\n"),
		};
	});
	return { header: [[[`${all.length === 1 ? "1 shell window" : `${all.length} shell windows`}`, "bold"], ["  · opened, a window shows its newest lines, live · /kill NAME ends one", "muted"]]], items };
}

/** The selected deferred shell-output projection, as a terminal emulator sees its newest lines. */
export function shellsOutView({ window, lines = [], presentation } = {}) {
	if (presentation === undefined || typeof presentation.shellOutput !== "function") throw new TypeError("Shell output needs its Runtime presentation adapter.");
	if (window === undefined) return { header: [], items: [note("  No shell window is open. A change task opens one when it runs a command.")] };
	const described = presentation.shellOutput(window);
	const header = [
		[["Output of ", "bold"], [window.name, "bold"], ["  ·  ", "muted"], ...described.state, [described.location, "muted"]],
		[["The newest lines, as the window keeps them; the view follows on its own.", "faint"]],
		[["/send " + window.name + " line types into it from the prompt.", "faint"]],
	];
	const items = [
		{ key: "term", plain: true, head: lines.length === 0 ? [["  (nothing has been printed yet)", "muted"]] : lines.map((line) => [line || " ", ""]) },
	];
	return { header, items };
}
