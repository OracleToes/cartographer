// Migrated Workspace renderers.
//
// Each renderer receives an already-settled application projection and a small presentation vocabulary assembled by
// screen composition. It owns no domain import and starts no durable read while it makes list rows.

/** A passive line in a Workspace collection. */
const note = (text, style = "muted") => ({ key: `note:${text}`, plain: true, head: [[text, style]] });
const heading = (text) => ({ key: `heading:${text}`, plain: true, head: [[text, "heading"]] });

/**
 * Render the Atlas projection as foldable collection rows.
 * @param {{
 *   file?: string,
 *   atlas?: { nodes?: object[] },
 *   attention?: object,
 *   lines?: Record<string, number | undefined>,
 *   error?: string,
 *   presentation: { summary: (atlas: object) => string, attention: (snapshot: object) => string, when: (value: number | string | undefined) => string | undefined },
 * }} input
 */
export function atlasView({ file, atlas, attention, lines, error, presentation } = {}) {
	if (presentation === undefined || typeof presentation.summary !== "function" || typeof presentation.attention !== "function" || typeof presentation.when !== "function") throw new TypeError("Atlas needs its Workspace presentation adapter.");
	const path = file ?? "the Atlas file";
	if (atlas === undefined) return { header: [[[`! The graph cannot be read: ${error ?? "its projection is not available"}`, "warn"]], [[`  ${path} · e opens it`, "muted"]]], items: [{ key: "file", head: [[path, ""]], target: file === undefined ? undefined : { file } }] };
	const care = new Map((attention?.care ?? []).map(({ node, why }) => [node.id, why]));
	const local = attention === undefined ? "" : presentation.attention(attention);
	const items = [];
	if (local !== "") items.push({ key: "atlas:attention", plain: true, head: [["Local map", "heading"]], body: local });
	items.push(...(atlas.nodes ?? []).map((node) => {
		const checking = care.get(node.id);
		const body = [
			`gist: ${node.gist}`,
			node.detail,
			node.files.length > 0 ? `files: ${node.files.join(", ")}` : undefined,
			node.links.length > 0 ? `links: ${node.links.join(", ")}` : undefined,
			`written ${presentation.when(node.written) ?? "at an unknown time"} by ${node.by === "task" ? "a task" : "the main agent"}`,
			checking?.length > 0 ? `needs checking: ${checking.join(", ")}` : undefined,
		].filter((line) => line !== undefined && line !== "");
		return {
			key: `node:${node.name}`,
			archived: node.archived === true,
			head: [
				[node.name, "bold"],
				[`  ${node.gist}`, ""],
				[node.files.length > 0 ? `  [${node.files.join(", ")}]` : "", "tool"],
				[node.links.length > 0 ? `  → ${node.links.join(", ")}` : "", "muted"],
				[checking?.length > 0 ? "  (needs checking)" : "", "warn"],
				[node.archived === true ? "  · archived: the agent does not read it (v brings it back)" : "", "warn"],
			],
			body: body.join("\n"),
			target: file === undefined ? undefined : { file, line: lines?.[node.name] },
		};
	}));
	const header = [[[`Graph: ${presentation.summary(atlas)}`, "bold"], [care.size > 0 ? ` · ${care.size} need checking` : "", "warn"]]];
	if ((atlas.nodes ?? []).length === 0) items.push(note("  No nodes yet. The agent and its tasks write them as they learn the project."));
	return { header, items };
}

/**
 * Render the Ledger projection as foldable collection rows.
 * @param {{
 *   file?: string,
 *   ledger?: { items?: object[] },
 *   lines?: Record<string, number | undefined>,
 *   error?: string,
 *   presentation: {
 *     when: (value: number | string | undefined) => string | undefined,
 *     entryLine: (item: object, now: number) => string,
 *     groups: { title: string, matches: (item: object) => boolean }[],
 *     isOpen: (item: object) => boolean,
 *     isDone: (item: object) => boolean,
 *     isGoal: (item: object) => boolean,
 *     isNote: (item: object) => boolean,
 *   },
 * }} input
 */
export function ledgerView({ file, ledger, lines, error, presentation } = {}) {
	if (presentation === undefined || typeof presentation.when !== "function" || typeof presentation.entryLine !== "function" || !Array.isArray(presentation.groups) || typeof presentation.isOpen !== "function" || typeof presentation.isDone !== "function" || typeof presentation.isGoal !== "function" || typeof presentation.isNote !== "function") throw new TypeError("Ledger needs its Workspace presentation adapter.");
	const path = file ?? "the Ledger file";
	if (ledger === undefined) return { header: [[[`! The ledger cannot be read: ${error ?? "its projection is not available"}`, "warn"]]], items: [{ key: "file", head: [[path, ""]], target: file === undefined ? undefined : { file } }] };
	const now = Date.now();
	const items = [];
	const entry = (item) => {
		const done = presentation.isDone(item);
		const open = presentation.isOpen(item);
		const muted = done || item.archived === true;
		return {
			key: `entry:${item.id}`,
			archived: item.archived === true,
			head: [
				[`${item.salient === true && open && presentation.isNote(item) ? "● " : ""}${item.id}  `, muted ? "muted" : "tool"],
				[item.text, muted ? "muted" : ""],
				[presentation.isGoal(item) && item.doneWhen ? `  (done when: ${item.doneWhen})` : "", "muted"],
				[item.salient === true && open ? "  · salient" : "", "ok"],
				[item.archived === true ? "  · archived: the agent does not read it (v brings it back)" : "", "warn"],
			],
			body: [
				item.text,
				item.salient === true && presentation.isNote(item) ? "salient: stands in every request, including the block a collapse keeps (edit the entry to drop it)" : undefined,
				presentation.isGoal(item) && item.doneWhen ? `done when: ${item.doneWhen}` : undefined,
				done && item.outcome ? `outcome: ${item.outcome}` : undefined,
				`${item.by === "user" ? "written by you" : "written by the agent"}${presentation.when(item.added) ? ` · added ${presentation.when(item.added)}` : ""}${done && presentation.when(item.closed) ? ` · closed ${presentation.when(item.closed)}` : ""}`,
			]
				.filter((line) => line !== undefined)
				.join("\n"),
			copy: presentation.entryLine(item, now),
			target: file === undefined ? undefined : { file, line: lines?.[item.id] },
		};
	};
	for (const group of presentation.groups) {
		const open = (ledger.items ?? []).filter((item) => group.matches(item) && presentation.isOpen(item));
		if (open.length === 0) continue;
		items.push(heading(group.title));
		items.push(...open.map(entry));
	}
	const done = (ledger.items ?? []).filter((item) => presentation.isDone(item));
	if (done.length > 0) {
		items.push(heading("Closed"));
		items.push(...done.map(entry));
	}
	if (items.length === 0) items.push(note("  The ledger is empty: no goal yet. Say what you want to achieve."));
	return { header: [], items };
}
