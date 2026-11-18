// Migrated Review renderers.
//
// Each renderer receives an already-settled application projection and a small presentation vocabulary assembled by
// screen composition. It owns no checkpoint or Git import and starts no durable read while it makes list rows.

/** A passive line in a Review collection. */
const note = (text, style = "muted") => ({ key: `note:${text}`, plain: true, head: [[text, style]] });

/** A patch cut into its files: path -> the lines about that file, without git's own first lines. */
function patchByFile(patch) {
	const byFile = new Map();
	let current;
	for (const line of String(patch ?? "").split("\n")) {
		const start = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
		if (start) {
			current = [];
			byFile.set(start[2], current);
			continue;
		}
		if (current === undefined || /^(index |new file mode|deleted file mode|old mode|new mode|similarity index)/.test(line)) continue;
		current.push(line);
	}
	return byFile;
}

const patchStyle = (line) => (/^\+(?!\+\+)/.test(line) ? "ok" : /^-(?!--)/.test(line) ? "err" : /^@@/.test(line) ? "tool" : /^(\+\+\+|---) /.test(line) ? "bold" : "");
const target = (presentation, root, path, line) => (root === undefined ? undefined : presentation.target(root, path, line));
const task = (key, text) => ({ key, head: [["Task  ", "tool"], [text, ""]], body: text, copy: text });

/** One item for each changed file: its line, and the patch inside. */
function changeItems(presentation, root, changes, patch) {
	const byFile = patchByFile(patch);
	return changes.map((change) => {
		const lines = byFile.get(change.path) ?? [];
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(lines.find((line) => line.startsWith("@@")) ?? "");
		const counts = change.added === undefined ? "" : ` (${[change.added > 0 ? `+${change.added}` : "", change.removed > 0 ? `−${change.removed}` : ""].filter((part) => part !== "").join(" ")})`;
		return {
			key: `change:${change.path}`,
			head: [[change.status.padEnd(8), change.status === "new" ? "ok" : change.status === "deleted" ? "err" : "warn"], [` ${change.path}`, "bold"], [counts === " ()" ? "" : counts, "muted"]],
			body: lines.length > 0 ? lines.join("\n") : change.added === undefined ? "(not a text file)" : "(no lines changed)",
			bodyStyle: patchStyle,
			copy: () => lines.join("\n"),
			target: change.status === "deleted" ? undefined : target(presentation, root, change.path, hunk ? Number(hunk[1]) : undefined),
		};
	});
}

/**
 * Render one settled Review projection.
 * @param {{
 *   review?: { root?: string, last?: object, change?: object, own?: { status?: string, patch?: string } },
 *   presentation: { changeSummary: (changes: object[]) => string, target: (root: string, path: string, line?: number) => object },
 * }} input
 * @param {"last" | "session" | "git"} which
 */
export function diffView({ review: provided, presentation } = {}, which) {
	if (presentation === undefined || typeof presentation.changeSummary !== "function" || typeof presentation.target !== "function") throw new TypeError("Review needs its presentation adapter.");
	if (provided === undefined) return { header: [[["Review is loading…", "muted"]]], items: [] };
	const root = typeof provided.root === "string" ? provided.root : undefined;
	if (which === "last") {
		const last = provided.last;
		if (last === undefined) return { header: [], items: [note("  No change task has run that is still in effect.")] };
		const what = last.item ?? (last.windows ? `window ${last.windows.join(", ")}` : "change task");
		const header = [[[what, "bold"], [`  ${presentation.changeSummary(last.changes)}${last.finished ? "" : " · cut off before it finished; compared with the files as they are now"}`, "muted"]]];
		return { header, items: [task("last:task", last.text), ...(last.changes.length === 0 ? [note("  It changed no file.")] : changeItems(presentation, root, last.changes, last.patch))] };
	}
	if (which === "session") {
		const change = provided.change;
		if (change === undefined) return { header: [], items: [note("  No change task has run since carto started here.")] };
		return { header: [[[`Since carto started: ${change.steps === 1 ? "1 step" : `${change.steps} steps`}`, "bold"], [`  ${presentation.changeSummary(change.changes)}`, "muted"]]], items: change.changes.length === 0 ? [note("  The files are as they were.")] : changeItems(presentation, root, change.changes, change.patch) };
	}
	const own = provided.own;
	if (own === undefined) return { header: [], items: [note("  This project is not a git repository, so there is no HEAD to compare with."), note("  The other two views do not need one: they come from Cartographer's own checkpoints.")] };
	if (own.status.trim() === "") return { header: [], items: [note("  Nothing uncommitted: the project is as its git HEAD has it.")] };
	const byFile = patchByFile(own.patch);
	const items = own.status
		.replace(/\n$/, "")
		.split("\n")
		.map((row) => {
			const mark = row.slice(0, 2);
			const path = row.slice(3).replace(/^"(.*)"$/, "$1");
			const lines = byFile.get(path) ?? [];
			const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(lines.find((line) => line.startsWith("@@")) ?? "");
			return {
				key: `git:${path}`,
				head: [[mark.padEnd(3), mark.includes("?") ? "ok" : mark.includes("D") ? "err" : "warn"], [path, "bold"], [mark.includes("?") ? "  (not known to git yet)" : "", "muted"]],
				...(lines.length > 0 ? { body: lines.join("\n"), bodyStyle: patchStyle } : {}),
				copy: () => lines.join("\n") || path,
				target: mark.includes("D") ? undefined : target(presentation, root, path, hunk ? Number(hunk[1]) : undefined),
			};
		});
	return { header: [[["Uncommitted in the project's own repository", "bold"], ["  (git status --short, and git diff HEAD inside each file)", "muted"]]], items };
}
