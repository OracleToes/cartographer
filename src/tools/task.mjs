// The `task` tool: one agent entering a bounded focus context.
//
//   1. The orchestrating context starts a focus with a brief or one declared move; a project change carries one approved move revision.
//   2. Durable forks the stored conversation. Request dressing adds fresh shared state and a one-line purpose.
//   3. The focus uses the same agent tools, shared books and atlas; only plan changes stay orchestrator-owned.
//   4. Its working conversation is temporary. `return` hands back the remaining report and shelf items; shared-memory
//      updates persist independently of that report.
//
// Focuses run one at a time. A project-change focus is bracketed by checkpoints (src/checkpoints.mjs); the recorded
// diff and atlas changes supplement its report so durable memory is based on observable results too.
import { configure, defineTool } from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import { POLICY } from "../config.mjs";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { loadAtlas, nodeChanges, nodeHashes, staleNodes } from "../atlas.mjs";
import { changeRecord, changesBetween, checkpoint, CheckpointError, windowStep } from "../checkpoints.mjs";
import { addRecord, KEPT_AS, loadContext, reserveId, shelfFreshness, shelfLabel, shelfText, taskState, updateContext } from "../context.mjs";
import { endTaskContext } from "../context.mjs";
import { blockMove, loadPlan, reportMove, savePlan, startMove } from "../plan.mjs";
import { CHANGE_NOTE, LOOK_NOTE, REFUSALS, SIBLING_AFTER, SIBLING_BEFORE, TASK_EXAMPLE, TASK_HEADER } from "../prompt.mjs";
import { stamp, took } from "../time.mjs";
import { USER_NAME } from "../user.mjs";

const textOf = (message) => (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
const fail = (text, details) => ({ isError: true, output: [{ type: "text", text }], ...(details ? { details } : {}) });
const listed = (names, max = POLICY.limits.taskDisplay.listedNodes) => `${names.slice(0, max).join(", ")}${names.length > max ? `, and ${names.length - max} more` : ""}`;
const hash = (text) => createHash("sha256").update(String(text)).digest("hex");
const compact = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/** The graph as it stands: what each node says, and which nodes may be out of date. Undefined when it cannot be read. */
function atlasMark(root, brainDir) {
	const { atlas } = loadAtlas(brainDir);
	if (atlas === undefined) return undefined;
	return { nodes: nodeHashes(atlas), stale: staleNodes(root, atlas).map((node) => node.name) };
}

/**
 * What a task did to the graph, for its report.
 * @returns {{ text: string, atlas?: { written: string[], removed: string[], stale: string[] } }}
 */
function atlasRecord(root, brainDir, before) {
	const { atlas } = loadAtlas(brainDir);
	if (atlas === undefined || before === undefined || before === null) return { text: "" };
	const { written, removed } = nodeChanges(before.nodes, nodeHashes(atlas));
	// Nodes that were fine when the task began and are not now: its changes to their files did that.
	const stale = staleNodes(root, atlas).filter((node) => !before.stale.includes(node.name));
	if (written.length === 0 && removed.length === 0 && stale.length === 0) return { text: "" };
	const lines = [];
	if (written.length > 0) lines.push(`Nodes this task wrote: ${listed(written)}.`);
	if (removed.length > 0) lines.push(`Nodes this task removed: ${listed(removed)}.`);
	if (stale.length > 0) lines.push(`Nodes that may be out of date after this task: ${stale.slice(0, POLICY.limits.taskDisplay.staleNodes).map((node) => `${node.name} (${node.why.join(", ")})`).join("; ")}${stale.length > POLICY.limits.taskDisplay.staleNodes ? `; and ${stale.length - POLICY.limits.taskDisplay.staleNodes} more` : ""}.`);
	return { text: `\n\nMy record of the atlas:\n${lines.join("\n")}`, atlas: { written, removed, stale: stale.map((node) => node.name) } };
}

/** Capture explicitly selected main-shelf evidence before the move starts. The capture, not a later live shelf,
 * is what the focus and a replay receive. */
function selectedEvidence(root, brainDir, selected) {
	if (selected === undefined) return { evidence: [] };
	if (!Array.isArray(selected) || selected.length === 0) return { evidence: [] };
	const ids = selected.map((id) => String(id).trim());
	if (ids.some((id) => id === "")) return { refusal: "Each `shelf` entry must be an existing main-shelf placement ID." };
	if (new Set(ids).size !== ids.length) return { refusal: "Select each main-shelf placement at most once." };
	const mainShelf = loadContext(brainDir).shelf ?? [];
	const evidence = [];
	let snapshotChars = 0;
	for (const id of ids) {
		const placement = mainShelf.find((item) => item?.id === id);
		if (placement === undefined) return { refusal: `${id} is not an existing main-shelf placement. Select IDs from the main shelf; task-local placements cannot be handed on.` };
		const snapshot = shelfText(root, placement, brainDir);
		snapshotChars += snapshot.length;
		if (snapshotChars > POLICY.limits.task.evidenceChars) return { refusal: `The selected shelf snapshots exceed the focus capsule's ${POLICY.limits.task.evidenceChars.toLocaleString("en-US")} character evidence limit. Select fewer placements or narrower shelf ranges; no move was started.` };
		const source = placement.ref === undefined
			? { path: placement.path, ...(placement.from === undefined ? {} : { from: placement.from }), ...(placement.to === undefined ? {} : { to: placement.to }) }
			: { ref: { ...placement.ref } };
		evidence.push({
			placement: placement.id,
			label: shelfLabel(placement),
			source,
			digest: hash(snapshot),
			freshness: shelfFreshness(root, placement, brainDir).state,
			item: { ...placement, snapshot },
		});
	}
	return { evidence };
}

/**
 * What kind of task a call asks for, or why it cannot run.
 * @returns {{ run?: { mode: "look" | "change", item?: string, text?: string, network?: boolean }, refusal?: string }}
 */
function kindOf(root, brainDir, args, gate, now) {
	const moveId = typeof args.move === "string" ? args.move.trim() : "";
	if (moveId === "") {
		if (typeof args.brief !== "string" || args.brief.trim() === "") return { refusal: "A focus without `move` is an inspect focus: give `brief` as one narrow question and `done_when` as the report it must return." };
		if (typeof args.done_when !== "string" || args.done_when.trim() === "") return { refusal: "An inspect focus needs `done_when`: name the observation its report must contain." };
		if (args.context !== undefined || args.shelf !== undefined) return { refusal: "`context` and `shelf` belong to a declared move. Put an inspect focus's facts in its brief." };
		return {
			run: {
				mode: POLICY.enums.planMode.look,
				text: args.brief.replace(/\s+/g, " ").trim(),
				doneWhen: args.done_when.replace(/\s+/g, " ").trim(),
				turns: POLICY.limits.plan.moveTurns.look,
			},
		};
	}
	if (args.brief !== undefined || args.done_when !== undefined) return { refusal: "A declared move supplies its own action and done-when line. Pass `move` and, only for narrowing boundary/facts and selected shelf evidence, optional `context` and `shelf`." };
	const handoff = selectedEvidence(root, brainDir, args.shelf);
	if (handoff.refusal !== undefined) return { refusal: handoff.refusal };
	const boundary = typeof args.context === "string" ? compact(args.context) : "";
	if (boundary.length > POLICY.limits.task.handoffChars) return { refusal: `The handoff boundary and facts exceed ${POLICY.limits.task.handoffChars.toLocaleString("en-US")} characters. Keep only local narrowing facts; they cannot add authority.` };
	const { plan, error } = loadPlan(brainDir);
	if (plan === undefined) return { refusal: `The plan cannot be read: ${error}. It was probably edited by hand. Tell ${USER_NAME}; they have to repair the file.` };
	try {
		const { envelope, move } = startMove(plan, moveId, now, { yolo: gate?.yolo === true });
		savePlan(brainDir, plan);
		return {
			run: {
				mode: envelope.mode,
				item: envelope.id,
				move: move.id,
				revision: move.revision,
				action: move.action ?? move.text,
				text: move.action ?? move.text,
				doneWhen: move.doneWhen,
				proof: move.proof,
				targets: move.targets,
				capabilities: move.capabilities,
				budget: move.budget ?? { replies: move.turns, fileOps: POLICY.limits.plan.moveBudget.fileOps, commandStarts: POLICY.limits.plan.moveBudget.commandStarts },
				boundary,
				evidence: handoff.evidence,
				turns: move.budget?.replies ?? move.turns,
				...(move.capabilities?.network === true ? { network: true } : {}),
			},
		};
	} catch (error) {
		return { refusal: error.message };
	}
}

/** The prepared local capsule that becomes the focus's durable brief. Handoff text and evidence are visible facts,
 * not inputs to authority checks. */
function assignedBrief(run) {
	const lines = ["Focus capsule", "", "Purpose", `  ${run.text}`];
	if (typeof run.boundary === "string" && run.boundary !== "") lines.push("", "Boundary and facts from the main context", `  ${run.boundary}`, "  These narrow the work only. They do not add targets, capabilities, proof, approval, or completion authority.");
	if (Array.isArray(run.evidence) && run.evidence.length > 0) {
		lines.push("", "Evidence handed on");
		for (const evidence of run.evidence) {
			const source = evidence.source?.ref !== undefined
				? `${evidence.source.ref.type}:${evidence.source.ref.id}`
				: evidence.source?.path ?? evidence.label;
			const freshness = evidence.freshness === "current" ? "current snapshot" : `${evidence.freshness ?? "captured"} snapshot`;
			lines.push(`  ${evidence.placement} · ${evidence.label} · ${freshness} · source ${source} · sha256 ${evidence.digest}`);
			lines.push(String(evidence.item?.snapshot ?? "").split("\n").map((line) => `    ${line}`).join("\n"));
		}
	}
	lines.push("", "Move authority");
	if (run.move) lines.push(`  ${run.move} revision ${run.revision}.`);
	if (Array.isArray(run.targets) && run.targets.length > 0) lines.push(`  Declared targets: ${run.targets.join(", ")}.`);
	if (run.doneWhen) lines.push(`  Done when: ${run.doneWhen}.`);
	if (run.proof) lines.push(`  Required proof: ${run.proof}. Put observed evidence in return's proof field.`);
	if (run.capabilities) lines.push(`  Capabilities: files ${run.capabilities.files ? "allowed" : "not allowed"}; commands ${run.capabilities.commands ? "allowed" : "not allowed"}; network ${run.capabilities.network ? "allowed" : "not allowed"}.`);
	if (run.budget) lines.push(`  Hard ceiling: ${run.budget.replies} replies, ${run.budget.fileOps} direct file operations, ${run.budget.commandStarts} command starts. The operation count is a stop, not a quota and not a measure of scope.`);
	return lines.join("\n");
}

/**
 * @param {{ root: string, brainDir: string, config: { taskTurns: number, maxTokens: number }, runner?: { mode: "sandbox" | "direct" | "none" } }} input
 *   runner: how commands run in this session (src/sandbox.mjs)
 */
export function taskTool({ root, brainDir, config, runner = { mode: "none" }, windows, gate, loops, ends, active = { id: undefined, said: [], heard: [] } }) {
	return defineTool({
		name: "task",
			description:
				"Enter one small focused execution context. A change focus carries exactly one approved plan move (`move`, such as m2); its action, targets, evidence and reply limit come from that stored move, not from a free-form brief. Without `move`, this is a read-only inspect focus and needs one narrow `brief` plus `done_when`. The focus shares the ledger and atlas, but its working conversation is temporary; keep lasting findings before returning a report.",
			parameters: obj({
				move: opt(str({ minLength: POLICY.validation.planIdMinLength, pattern: POLICY.patterns.moveId, description: "One declared plan move to execute (m2). Its current approved revision supplies all change authority." })),
				brief: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "Only for an inspect focus without move: one narrow question to answer." })),
				done_when: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "Only for an inspect focus without move: the observation its report must contain." })),
				context: opt(str({ maxLength: POLICY.limits.task.handoffChars, description: "Optional short boundary and facts from the orchestrator for a declared move. It only narrows where to start and what to leave alone; it never adds targets, capabilities, proof, approval, or completion authority." })),
				shelf: opt(arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S" }), { maxItems: POLICY.limits.task.evidenceItems, description: "Existing main-shelf placement IDs to hand to this declared move as frozen evidence. Omit for no inherited main-shelf material." })),
			}),
		// One model, one context: when a turn asks for several tasks they run in order, not at once.
		executionMode: "sequential",
		// Safe to run again after a crash: a rerun finds the fork and the submission it already made.
		replay: POLICY.enums.toolReplay.safe,
		execute: async (args, api, callContext) => {
			const result = await run(args, api, callContext);
			// A call that never started a task (an empty brief, a refused item) leaves nothing to keep.
			const child = result.details?.conversationId;
			if (child === undefined) return result;
			// What the task shelved for the main agent goes onto its shelf, and the task's own context state ends.
			const handed = endTaskContext(root, brainDir, config, child);
			let text = textOf({ content: result.output });
			if (handed.added.length > 0) text += `\n\nThe task put on my shelf; these snapshots are in view now and will stand at the next collapse: ${handed.added.join(", ")}.\n\n${handed.snapshots.join("\n\n")}`;
			if (handed.refused.length > 0) text += `\n\nThe task wanted on my shelf, but it would not fit: ${handed.refused.join(", ")}.`;
			// The report is kept under an id, and one line of it goes into the record a collapse keeps
			// (src/context.mjs). The id is taken once, also when this call runs again after a restart.
			const id = (await api.memo("record", callContext)) ?? (await api.memo("record", reserveId(brainDir), callContext));
			const details = result.details ?? {};
			if (typeof details.move === "string" && Number.isInteger(details.revision)) {
				const { plan } = loadPlan(brainDir);
				if (plan !== undefined) {
					const recorded = reportMove(plan, details.move, details.revision, {
						done: result.isError !== true && details.done === true,
						report: id,
						changes: details.changes,
						commands: details.commands,
						checkpoints: details.checkpoints,
						proof: details.proof,
						reason: details.scopeBreach ? `Changed outside declared targets: ${details.scopeBreach.join(", ")}.` : details.checkpointError ? `Checkpoint evidence failed: ${details.checkpointError}` : details.proofError ?? (details.done === false ? "The focus returned not done." : result.isError === true ? "The focus ended before a successful return." : undefined),
					}, api.now());
					if (recorded.changed) savePlan(brainDir, plan);
					text += `\n\n[My record: ${recorded.line}]`;
				}
			}
			addRecord(brainDir, { id, at: api.now(), mode: details.mode ?? POLICY.enums.planMode.look, item: details.item, ...(typeof details.move === "string" ? { move: details.move, revision: details.revision } : {}), brief: details.brief ?? args.brief ?? "focused work", report: text, summary: details.summary, failed: result.isError === true, undone: details.done === false, changed: details.changes?.length });
			text += `\n\n${KEPT_AS(id)}`;
			return { ...result, output: [{ type: "text", text }], details: { ...details, report: id, ...(handed.added.length > 0 ? { shelved: handed.added } : {}) } };
		},
	});

	async function run(args, api, callContext) {
		{
			// A rerun after a restart finds the task it already started, whatever happened to the plan since.
			const started = await api.commit(async (tx) => {
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, POLICY.limits.taskHistory.startLookupEntries)).items[0];
				if (existing === undefined) return undefined;
				// The fork's own entries come right after the entry it was forked at; the brief is among the first.
				const entries = await tx.scanEntries({ conversationId: existing.id, order: "ascending", minEntryId: existing.parent?.at }, POLICY.limits.taskHistory.contextEntries);
				const brief = entries.items.find((entry) => entry.conversationId === existing.id && entry.kind === "carto.brief");
				return { id: existing.id, run: brief?.data ?? { mode: POLICY.enums.planMode.look } };
			}, callContext);

			// The graph as it is before the task writes to it. Taken once, also when this call runs again.
			const atlasBefore = (await api.memo("atlas", callContext)) ?? (await api.memo("atlas", atlasMark(root, brainDir) ?? null, callContext));

			let run = started?.run;
			let outside;
			if (run === undefined) {
				const kind = kindOf(root, brainDir, args, gate, api.now());
				if (kind.run === undefined) return fail(kind.refusal);
				run = kind.run;
				run.brief = assignedBrief(run);
				// How commands run as the task starts. Kept with the task: its note and its record say it.
				if (run.mode === POLICY.enums.planMode.change && runner.mode === "direct") run.direct = true;
				if (run.mode === POLICY.enums.planMode.change) {
					// The files as they are before the task touches anything. Taken once, also when this call runs again.
					try {
						run.before = await api.memo("before", callContext);
						if (run.before === undefined) {
							// What shell windows changed since the last checkpoint, with no task around them, is a step of its
							// own and not this task's doing.
							outside = windowStep(root, brainDir, windows?.takeActive() ?? []);
							run.before = await api.memo("before", checkpoint(root, brainDir, `before ${run.move ?? run.item}: ${run.text}`), callContext);
						}
					} catch (error) {
						if (!(error instanceof CheckpointError)) throw error;
						if (run.move !== undefined && Number.isInteger(run.revision)) {
							const { plan } = loadPlan(brainDir);
							if (plan !== undefined && blockMove(plan, run.move, run.revision, `No checkpoint could be taken: ${error.message}`, api.now())) savePlan(brainDir, plan);
						}
						return fail(`No checkpoint could be taken, so the move was blocked and nothing was changed: ${error.message}. Tell ${USER_NAME}.`);
					}
				}
			}
			if (!Number.isInteger(run.turns)) run.turns = run.mode === POLICY.enums.planMode.change ? Math.min(config.taskTurns, POLICY.limits.plan.moveTurns.max) : POLICY.limits.plan.moveTurns.look;
			if (typeof run.text !== "string") run.text = typeof args.brief === "string" ? args.brief.replace(/\s+/g, " ").trim() : "the assigned work";
			if (typeof run.brief !== "string") run.brief = assignedBrief(run);

			const child =
				started?.id ??
				(await api.commit(async (tx) => {
					// The entry that carries this call is the fork point.
					const recent = await tx.scanEntries({ conversationId: api.conversationId }, POLICY.limits.taskHistory.recentEntries);
					let calls;
					const at = recent.items.find((entry) =>
						(entry.model ?? []).some((message) => {
							if (message.role !== "assistant") return false;
							const found = message.content.filter((part) => part.type === "toolCall");
							if (!found.some((part) => part.id === api.callId)) return false;
							calls = found;
							return true;
						}),
					);
					if (at === undefined) throw new Error("task: the entry of this call was not found");
					const fork = await tx.forkConversation(api.conversationId, at.id, { ownership: { kind: "task", taskId: api.taskId } });
					// The focus's replies are capped by the move itself; the Durable ceiling is only the safety net beneath the harness cap.
					await configure(tx, fork.id, { maxTurns: run.turns + 2 });
					// Every call of the turn gets a result in the fork: the move contract for this one, a note for the others.
					// The harness sends results in the order of the calls, so a note may come after the contract.
					const note = run.mode === POLICY.enums.planMode.change ? CHANGE_NOTE(run, { commands: run.direct ? "direct" : runner.mode === "none" ? "none" : "sandbox", network: run.network === true }) : LOOK_NOTE;
					let briefGiven = false;
					for (const call of calls) {
						const mine = call.id === api.callId;
							const text = mine ? `${TASK_HEADER}\n${note}\n\n${TASK_EXAMPLE[run.mode === POLICY.enums.planMode.change ? "change" : "look"]}\n\n${run.brief}` : briefGiven ? SIBLING_AFTER : SIBLING_BEFORE;
						if (mine) briefGiven = true;
						await tx.appendEntry(fork.id, {
							kind: mine ? "carto.brief" : "carto.sibling",
							model: [{ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: false, timestamp: api.now() }],
							// What kind of task this is. The rule of who may call what reads it from here (src/harness.mjs),
							// so it holds after a restart too.
							...(mine ? { data: run } : {}),
						});
					}
					return fork.id;
				}, callContext));
			// A viewer of the main conversation finds the task's own conversation through this.
			const details = {
				conversationId: child,
				brief: run.brief,
				mode: run.mode,
				turns: run.turns,
				...(run.item ? { item: run.item } : {}),
				...(run.move ? { move: run.move, revision: run.revision, targets: run.targets, capabilities: run.capabilities, budget: run.budget, ...(run.boundary ? { boundary: run.boundary } : {}), ...(Array.isArray(run.evidence) && run.evidence.length > 0 ? { evidence: run.evidence.map(({ placement, source, digest, freshness }) => ({ placement, source, digest, freshness })) } : {}) } : {}),
				...(run.network ? { network: true } : {}),
				...(run.direct ? { direct: true } : {}),
			};
			await api.details(details, callContext);
			const purpose = run.text.replace(/\s+/g, " ").trim().slice(0, POLICY.limits.context.briefChars);
			updateContext(brainDir, (store) => {
				Object.assign(taskState(store, child), {
					purpose,
					...(run.item ? { item: run.item } : {}),
					...(run.move ? { move: run.move, revision: run.revision, targets: run.targets, capabilities: run.capabilities, budget: run.budget, ...(run.boundary ? { boundary: run.boundary } : {}), ...(Array.isArray(run.evidence) ? { evidence: run.evidence } : {}), fileOps: 0, changedSurface: { bytes: 0, lines: 0 }, commandUses: 0, commands: [], windows: [] } : {}),
					mode: run.mode,
					turns: run.turns,
				});
			});

			const handle = await api.conversation(child, callContext);
			// While the task runs, what the user types is for it (src/harness.mjs).
			active.id = child;
			active.said = [];
			active.heard = [];
			let settled;
			try {
				const submission = await handle.submit({ type: "continue", requestId: `task:${api.taskId}` }, callContext);
				settled = await submission.wait(callContext);
			} finally {
				active.id = undefined;
			}
			const heard = active.heard.splice(0);
			const unread = active.said.splice(0);

			// What the task returned (src/tools/return.mjs), its recorded command evidence, and what ended it when it did not return.
			const taskRecord = loadContext(brainDir).tasks[child];
			const returned = taskRecord?.returned;
			if (Array.isArray(taskRecord?.commands) && taskRecord.commands.length > 0) details.commands = taskRecord.commands;
			const ended = ends?.get(child);
			ends?.delete(child);
			// The task's own words, newest last: what it leaves behind when it did not return.
			const { lastMessage, notes, round } = await api.commit(async (tx) => {
				const page = await tx.scanEntries({ conversationId: child }, POLICY.limits.task.historyPageEntries);
				const own = page.items.filter((entry) => entry.conversationId === child).flatMap((entry) => (entry.model ?? []).filter((message) => message.role === "assistant"));
				const newest = own[0];
				const calls = (newest?.content ?? []).filter((part) => part.type === "toolCall");
				return { lastMessage: newest, notes: own.map((message) => textOf(message).trim()).filter((text) => text !== "").reverse(), round: newest?.stopReason !== "length" && calls.length > 0 };
			}, callContext);
			let left = "";
			for (const note of [...notes].reverse()) {
				if (left.length + note.length > POLICY.limits.task.noteChars && left !== "") break;
				left = `- ${note.length > POLICY.limits.task.noteChars ? `${note.slice(0, POLICY.limits.task.noteChars)}…` : note}\n${left}`;
			}
			left = left.trimEnd();
			const said = returned?.report ?? "";
			if (returned !== undefined) {
				details.done = returned.done;
				if (returned.summary !== undefined) details.summary = returned.summary;
				// The required proof is a distinct durable claim, not an implication of a
				// general report. The orchestrator still judges whether it satisfies the
				// declared condition before accepting the move.
				const evidence = String(returned.proof ?? "").replace(/\s+/g, " ").trim();
				if (evidence !== "") details.proof = evidence.length > POLICY.limits.plan.proofChars ? `${evidence.slice(0, POLICY.limits.plan.proofChars - 1).trimEnd()}…` : evidence;
				else if (run.move !== undefined && run.mode === POLICY.enums.planMode.change) {
					details.done = false;
					details.proofError = "The focus returned no stated proof for its declared evidence.";
				}
			}
			// What the user typed while the task ran: the main agent was not there to read it.
			let spoken = "";
			if (heard.length > 0) {
				details.heard = heard.length;
				const missed = unread.length > 0 ? ` The task did not get to read ${unread.length === heard.length ? "it" : `the last ${unread.length === 1 ? "one" : unread.length}`}.` : "";
				spoken = `\n\nWhile this task ran, ${USER_NAME} wrote to it:${missed}\n${heard.map((entry) => `[${USER_NAME} · ${stamp(entry.at)}] ${entry.text}`).join("\n")}`;
			}

				// What the task changed, from the record. A program this move started cannot continue
				// writing after its checkpoint closes, so busy windows owned by the move are closed first.
				let record = spoken;
				if (run.mode === POLICY.enums.planMode.change && run.before !== undefined) {
					const owned = new Set(Array.isArray(taskRecord?.windows) ? taskRecord.windows : []);
					const stoppedWindows = [];
					for (const window of (windows?.list(0) ?? [])) {
						if (!owned.has(window.name) || window.state !== POLICY.enums.windowStates.busy) continue;
						try { windows.close(window.name); stoppedWindows.push(window.name); } catch { /* the checkpoint below still records what reached disk */ }
					}
					if (stoppedWindows.length > 0) {
						details.closedWindows = stoppedWindows;
						record += `\n\nClosed move-owned running ${stoppedWindows.length === 1 ? "window" : "windows"} before checkpointing: ${stoppedWindows.join(", ")}.`;
					}
				try {
					const after = (await api.memo("after", callContext)) ?? (await api.memo("after", checkpoint(root, brainDir, `after ${run.move ?? run.item}`), callContext));
					details.checkpoints = { before: run.before, after };
					details.changes = changesBetween(root, brainDir, run.before, after);
					const outside = details.changes.filter((change) => !Array.isArray(run.targets) || !run.targets.includes(change.path));
					if (outside.length > 0) {
						details.scopeBreach = outside.map((change) => change.path);
						details.done = false;
						record += `\n\nMove scope breach: ${outside.map((change) => change.path).join(", ")} ${outside.length === 1 ? "is" : "are"} outside ${run.move}'s declared targets. The move is blocked and cannot be accepted.`;
					}
					// What windows did during the task is in that record. From here on they count for themselves again.
					windows?.takeActive();
					record +=
						details.changes.length === 0
							? `\n\nMy record: no file ${run.direct ? "of the project " : ""}was changed during this task.`
							: `\n\nMy record of the files changed during this task:\n${changeRecord(details.changes).join("\n")}`;
					// Without the sandbox a command can change what the checkpoints do not hold.
					if (run.direct) record += "\nThe sandbox was off for this task. The record covers the project directory only: what a command changed outside it is not listed here and cannot be undone.";
					} catch (error) {
						if (!(error instanceof CheckpointError)) throw error;
						details.done = false;
						details.checkpointError = error.message;
						record += `\n\nMy record could not keep what this task changed: ${error.message}. The move is blocked and cannot be accepted.`;
					}
			}

			if (details.proofError !== undefined) record += `\n\nMove evidence missing: ${details.proofError} The move is blocked and cannot be accepted.`;

			if (outside !== undefined) {
				details.outside = { names: outside.names, changes: outside.changes };
				record += `\n\nBefore this task started, my record kept what changed while ${outside.names.length === 1 ? `window ${outside.names[0]}` : `windows ${outside.names.join(", ")}`} ran with no task around, as a step of its own:\n${changeRecord(outside.changes).join("\n")}`;
			}
			// The windows that are still at work: they outlive the task.
			const busy = (windows?.list(0) ?? []).filter((win) => win.state === POLICY.enums.windowStates.busy);
			if (busy.length > 0) {
				details.windows = busy.map((win) => win.name);
				record += `\n\nWindows still running after this task: ${busy.map((win) => `${win.name} (\`${win.command.split("\n")[0].slice(0, POLICY.limits.windows.commandSummaryChars)}\`, for ${took(win.running)})`).join("; ")}. The windows block at the end of the request shows how they are doing.`;
			}

			// What the task did to the graph, the same way.
			const mapped = atlasRecord(root, brainDir, atlasBefore);
			if (mapped.atlas !== undefined) details.atlas = mapped.atlas;
			record += mapped.text;

			const wrote = left === "" ? "It had written nothing." : `What it had written for itself:\n${left}`;
			if (returned === undefined && run.move !== undefined && Number.isInteger(run.revision)) {
				const { plan } = loadPlan(brainDir);
				if (plan !== undefined && blockMove(plan, run.move, run.revision, "Focus ended without a report.", api.now())) savePlan(brainDir, plan);
			}
			if (returned === undefined && settled.status !== POLICY.enums.entryStatus.done) {
				const why =
					settled.reason === "turn_limit"
						? `it used all its turns without calling \`return\``
						: `${settled.reason ?? settled.status}${settled.detail ? ` (${String(settled.detail).slice(0, POLICY.limits.task.settledDetailChars)})` : ""}`;
				return fail(`The task did not finish: ${why}.\n${wrote}\nGive a narrower brief, or split the work.${record}`, details);
			}
			// A reply that hits the output limit ends there. If it was in the middle of a tool call, the call is lost.
			if (returned === undefined && lastMessage?.stopReason === "length") {
				const text = `The task's reply was cut off at the output limit (${config.maxTokens} tokens for one reply), so the task ended there. If it was writing a file, that call was lost and the file was not written. One \`write\` call cannot hold more than one reply: have it write a long file in parts, the first part with \`write\` and each further part added with \`edit\`, or split the work.${record}`;
				return fail(text, details);
			}
			if (returned === undefined && ended?.why === "limit") {
				details.limit = ended.replies;
				return fail(`I ended the focus: it used all ${run.turns} of its replies without calling \`return\`, so there is no report and its move is blocked.\n${wrote}\nPlan a narrower successor move.${record}`, details);
			}
			if (returned === undefined && ended?.why === "same-note") {
				details.looped = true;
				return fail(`I ended the task: it wrote ${ended.empty ? `nothing and called nothing, ${ended.times} times in a row` : `the same note ${ended.times} times in a row and called nothing`}, so there is no report.\n${wrote}\nIf the work is still needed, start another task with a brief that says what to do first.${record}`, details);
			}
			if (returned === undefined && round) {
				const loop = loops?.get(child);
				details.looped = loop ?? true;
				const what = loop === undefined ? "it sent the same failing call again and again." : `it sent the same call ${loop.total} times and it failed each time: \`${loop.call}\`\nThe error was:\n${loop.error}`;
				return fail(`I ended the task: ${what}\n${wrote}\nIf the work is still needed, start another task whose brief says how to avoid this.${record}`, details);
			}
			if (returned === undefined) return fail(`The focus ended without calling \`return\`, so there is no report and its move is blocked.\n${wrote}\nPlan a narrower successor move.${record}`, details);
			const completed = details.done === true && details.scopeBreach === undefined && details.checkpointError === undefined && details.proofError === undefined;
			const state = run.move === undefined
				? (completed ? "\n\n[My record: the inspect focus returned done.]" : "\n\n[My record: the inspect focus returned not done.]")
				: (completed
					? `\n\n[My record: ${run.move} claimed completion. The orchestrator must review its checkpoint, required proof and report, then accept the move.]`
					: `\n\n[My record: ${run.move} did not complete within its contract and is blocked. Plan a successor move rather than rerunning it.]`);
			return { output: [{ type: "text", text: `${said}${state}${record}` }], details };
		}
	}
}
