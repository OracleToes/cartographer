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

/**
 * Render the Plan projection as foldable collection rows.
 * @param {{
 *   file?: string,
 *   yolo?: boolean,
 *   plan?: { items?: object[], moves?: object[] },
 *   lines?: Record<string, number | undefined>,
 *   error?: string,
 *   presentation: {
 *     when: (value: number | string | undefined) => string | undefined,
 *     itemLine: (item: object) => string,
 *     movesOf: (plan: object, id: string) => object[],
 *     waiting: (plan: object) => object[],
 *     authorizationLine: (plan: object, options: { yolo?: boolean }) => string,
 *     isDone: (item: object) => boolean,
 *     moveState: (move: object) => { done: boolean, reported: boolean, blocked: boolean, icon: string, style: string },
 *   },
 * }} input
 */
export function planView({ file, yolo = false, plan, lines, error, presentation } = {}) {
	if (presentation === undefined || typeof presentation.when !== "function" || typeof presentation.itemLine !== "function" || typeof presentation.movesOf !== "function" || typeof presentation.waiting !== "function" || typeof presentation.authorizationLine !== "function" || typeof presentation.isDone !== "function" || typeof presentation.moveState !== "function") throw new TypeError("Plan needs its Workspace presentation adapter.");
	const path = file ?? "the Plan file";
	if (plan === undefined) {
		if (error !== undefined) return { header: [[[`! The plan cannot be read: ${error}`, "warn"]]], items: [{ key: "file", head: [[path, ""]], target: file === undefined ? undefined : { file } }] };
		return { header: [[["Plan is loading…", "muted"]]], items: [] };
	}
	if ((plan.items ?? []).length === 0) return { header: [], items: [note("  There is no plan. The agent writes an envelope when a goal needs changes.")] };
	const items = [];
	for (const envelope of plan.items ?? []) {
		const done = presentation.isDone(envelope);
		const muted = done || envelope.archived === true;
		items.push({
			key: `envelope:${envelope.id}`,
			archived: envelope.archived === true,
			head: [
				[done ? "✓ " : "○ ", done ? "ok" : "warn"],
				[`${envelope.id} `, "tool"],
				[`[envelope · ${envelope.mode}${envelope.network ? ", network" : ""}] `, "muted"],
				[envelope.text, muted ? "muted" : ""],
				[done && envelope.outcome ? `  → ${envelope.outcome}` : "", "muted"],
				[envelope.archived === true ? "  · archived: the agent does not read it (v brings it back)" : "", "warn"],
			],
			body: [
				envelope.text,
				`intent envelope · ${done ? `done${presentation.when(envelope.closed) ? ` ${presentation.when(envelope.closed)}` : ""}` : "open; it cannot run itself"}`,
				envelope.doneWhen ? `envelope complete when: ${envelope.doneWhen}` : "legacy envelope: add a done-when line and declared moves",
				done && envelope.outcome ? `outcome: ${envelope.outcome}` : undefined,
				envelope.undone ? "undone by you: accepted moves may need review" : undefined,
			]
				.filter((line) => line !== undefined)
				.join("\n"),
			copy: presentation.itemLine(envelope),
			target: file === undefined ? undefined : { file, line: lines?.[envelope.id] },
		});
		for (const move of presentation.movesOf(plan, envelope.id)) {
			const state = presentation.moveState(move);
			const mutedMove = state.done || move.archived === true;
			const budget = move.budget ?? { replies: move.turns, fileOps: undefined, commandStarts: undefined };
			items.push({
				key: `move:${move.id}`,
				archived: move.archived === true,
				head: [
					[`  ${state.icon} `, state.style],
					[`${move.id} `, "tool"],
					[`[move · ${move.status} · r${move.revision}] `, "muted"],
					[move.action ?? move.text, mutedMove ? "muted" : ""],
					[move.archived === true ? "  · archived" : "", "warn"],
				],
				body: [
					`parent: ${move.parent} revision ${move.parentRevision}`,
					`action: ${move.action ?? move.text}`,
					`targets: ${(move.targets ?? []).join(", ") || "none"}`,
					`done when: ${move.doneWhen}`,
					`required proof: ${move.proof ?? "none"}`,
					`capabilities: files ${move.capabilities?.files ? "yes" : "no"}; commands ${move.capabilities?.commands ? "yes" : "no"}; network ${move.capabilities?.network ? "yes" : "no"}`,
					`budget: ${budget.replies} replies${budget.fileOps === undefined ? "" : `; ${budget.fileOps} file operations`}${budget.commandStarts === undefined ? "" : `; ${budget.commandStarts} command starts`}`,
					state.reported ? `reported: ${move.reported?.id ?? "no report id"}; inspect the report and checkpoints, then press t and write why its proof witnesses this move's done-when` : undefined,
					state.reported && move.reported?.checkpoints ? `checkpoints: ${move.reported.checkpoints.before} → ${move.reported.checkpoints.after}` : undefined,
					state.reported && Array.isArray(move.reported?.changes) ? `changed paths: ${move.reported.changes.map((change) => change.path).join(", ") || "none"}` : undefined,
					state.reported && move.reported?.proof ? `reported proof: ${move.reported.proof}` : undefined,
					state.reported && move.reported?.closureGap ? `closure gap: ${move.reported.closureGap}` : undefined,
					state.blocked ? `blocked: ${move.blocked ?? "no reason recorded"}` : undefined,
					state.blocked && move.reported?.closureGap ? `closure gap: ${move.reported.closureGap}` : undefined,
					state.done ? `accepted${presentation.when(move.closed) ? ` ${presentation.when(move.closed)}` : ""}${move.outcome ? `: ${move.outcome}` : ""}` : undefined,
					state.done && move.acceptedReview ? `acceptance review: ${move.acceptedReview}` : undefined,
				]
					.filter((line) => line !== undefined)
					.join("\n"),
				copy: presentation.itemLine(move),
				target: file === undefined ? undefined : { file, line: lines?.[move.id] },
			});
		}
	}
	const waits = !yolo && presentation.waiting(plan).length > 0;
	return { header: [[[presentation.authorizationLine(plan, { yolo }), waits ? "warn" : "muted"], [waits ? "  Type /approve to snapshot the current move revisions." : "", "warn"]]], items };
}

/**
 * Render requests that wait for a user decision.
 * @param {{
 *   requests?: { id: string, kind: string, text: string, detail?: string[], file?: string, line?: number }[],
 *   error?: string,
 *   presentation: { flat: (text: string) => string, isApproval: (request: object) => boolean, isQuestion: (request: object) => boolean },
 * }} input
 */
export function requestsView({ requests: provided, error, presentation } = {}) {
	if (presentation === undefined || typeof presentation.flat !== "function" || typeof presentation.isApproval !== "function" || typeof presentation.isQuestion !== "function") throw new TypeError("Requests need their Workspace presentation adapter.");
	if (error !== undefined) return { header: [[[`! ${error}`, "warn"]]], items: [note("  Requests will be retried automatically.", "muted")] };
	if (provided === undefined) return { header: [[["Loading requests…", "muted"]]], items: [] };
	const all = provided;
	if (all.length === 0) return { header: [], items: [note("  Nothing waits for you. The agent goes on with whatever does not depend on an answer.")] };
	const items = all.map((request) => {
		const approval = presentation.isApproval(request);
		const question = presentation.isQuestion(request);
		return {
			key: `request:${request.id}`,
			head: [
				[approval ? "● " : "? ", approval ? "warn" : "tool"],
				[`${request.id}  `, "tool"],
				[`[${request.kind}] `, "muted"],
				[request.text, ""],
			],
			body: [
				presentation.flat(request.text),
				...(request.detail ?? []),
				question ? `answer with /answer ${request.id} words · d forgets the question` : `a approves it · n turns it down · d forgets it, and the agent is not told`,
			].join("\n"),
			copy: `${request.id} [${request.kind}] ${request.text}`,
			target: request.file === undefined ? undefined : { file: request.file, line: request.line },
		};
	});
	const approvals = all.some((request) => presentation.isApproval(request));
	return {
		header: [
			[[all.length === 1 ? "1 request waits for you" : `${all.length} requests wait for you`, "warn"]],
			[["  a approves it · n turns it down (the agent is told) · d forgets it without a word to the agent", "muted"]],
			[[approvals ? "  /approve ID ... · /deny ID [why] · /delete ID --yes · /answer ID words" : "  /answer ID words · /deny ID [why] · /delete ID --yes", "muted"]],
		],
		items,
	};
}

/**
 * Render the project tree with query-owned root and mark projection.
 * @param {{
 *   tree?: { root?: string, files?: ({ path: string, bytes?: number } | string)[], marks?: Record<string, string[]> },
 *   presentation: { size: (bytes: number) => string, target: (root: string, path: string, folder?: boolean) => object },
 * }} input
 * @param {(key: string) => boolean} isOpen
 */
export function treeView({ tree: provided, presentation } = {}, isOpen = () => false) {
	if (presentation === undefined || typeof presentation.size !== "function" || typeof presentation.target !== "function") throw new TypeError("Project tree needs its Workspace presentation adapter.");
	if (provided === undefined) return { header: [[["Project tree is loading…", "muted"]]], items: [] };
	const root = typeof provided.root === "string" ? provided.root : undefined;
	const files = (provided.files ?? []).map((entry) => (typeof entry === "string" ? { path: entry } : entry));
	const marks = new Map(Object.entries(provided.marks ?? {}));
	/** @type {{ dirs: Map<string, any>, files: Array<{ name: string, bytes?: number }>, count: number }} */
	const top = { dirs: new Map(), files: [], count: 0 };
	for (const file of files) {
		const parts = file.path.split("/");
		let dir = top;
		dir.count++;
		for (const part of parts.slice(0, -1)) {
			if (!dir.dirs.has(part)) dir.dirs.set(part, { dirs: new Map(), files: [], count: 0 });
			dir = dir.dirs.get(part);
			dir.count++;
		}
		dir.files.push({ name: parts.at(-1), ...(Number.isFinite(file.bytes) ? { bytes: file.bytes } : {}) });
	}
	const items = [];
	const target = (path, folder = false) => (root === undefined ? undefined : presentation.target(root, path, folder));
	const walk = (dir, prefix, depth) => {
		for (const name of [...dir.dirs.keys()].sort()) {
			const path = `${prefix}${name}`;
			const child = dir.dirs.get(name);
			const nodes = marks.get(path);
			items.push({
				key: `dir:${path}`,
				folder: true,
				depth,
				head: [[`${name}/`, "bold"], [`  ${child.count === 1 ? "1 file" : `${child.count} files`}`, "muted"], [nodes ? `  ← ${nodes.join(", ")}` : "", "tool"]],
				copy: path,
				target: target(path, true),
			});
			if (isOpen(`dir:${path}`)) walk(child, `${path}/`, depth + 1);
		}
		for (const file of [...dir.files].sort((a, b) => a.name.localeCompare(b.name))) {
			const path = `${prefix}${file.name}`;
			const nodes = marks.get(path);
			const size = file.bytes === undefined ? "gone" : presentation.size(file.bytes);
			items.push({ key: `file:${path}`, depth, head: [[file.name, ""], [`  ${size}`, "muted"], [nodes ? `  ← ${nodes.join(", ")}` : "", "tool"]], copy: path, target: target(path) });
		}
	};
	walk(top, "", 0);
	if (items.length === 0) items.push(note("  The project folder is empty."));
	return { header: [[[`${files.length === 1 ? "1 file" : `${files.length} files`} in ${root ?? "the project"}`, "bold"], ["  (without what git ignores and the brain folder; ← names the graph's nodes about a file)", "muted"]]], items };
}
