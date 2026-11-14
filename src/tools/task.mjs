// The `task` tool: the one way the main agent gets anything done in the project.
//
//   1. The main agent calls `task` with a brief.
//   2. The tool forks the main conversation at that call. The fork's prompt is the
//      main agent's prompt up to the call, so the model server reuses all of it.
//   3. In the fork, the call's result is the brief: the model becomes the task.
//   4. The task works in the fork with read, search and list. A task that runs a
//      change item of an authorized plan may also use write, edit and shell.
//   5. The task ends by calling `return` (src/tools/return.mjs). The report it gives there comes back as the
//      call's result in the main conversation.
//
// The main conversation never holds the task's working steps, only its report.
// Tasks run one at a time: there is one model and one context.
//
// A change task is bracketed by two checkpoints (src/checkpoints.mjs). The files
// that differ between them are added to the report by Cartographer, so the main
// agent learns what was changed from the record, not from the task's own account.
//
// A task starts with the tree of the project's files as the main agent sees it, and
// may write nodes of the atlas. Which nodes it wrote or removed, and which became
// possibly out of date through its changes, is added to the report the same way.
import { configure, defineTool } from "@earendil-works/pi-durable";
import { POLICY } from "../config.mjs";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { fileMarks, loadAtlas, nodeChanges, nodeHashes, staleNodes } from "../atlas.mjs";
import { changeRecord, changesBetween, checkpoint, CheckpointError, windowStep } from "../checkpoints.mjs";
import { addRecord, KEPT_AS, loadContext, reserveId } from "../context.mjs";
import { endTaskContext } from "../context.mjs";
import { applyPlanOp, loadPlan, mayRun, savePlan } from "../plan.mjs";
import { CHANGE_NOTE, LOOK_NOTE, REFUSALS, SIBLING_AFTER, SIBLING_BEFORE, TASK_EXAMPLE, TASK_HEADER } from "../prompt.mjs";
import { stamp, took } from "../time.mjs";
import { treeSection } from "../tree.mjs";

const textOf = (message) => (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
const fail = (text, details) => ({ isError: true, output: [{ type: "text", text }], ...(details ? { details } : {}) });
const listed = (names, max = POLICY.limits.taskDisplay.listedNodes) => `${names.slice(0, max).join(", ")}${names.length > max ? `, and ${names.length - max} more` : ""}`;

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
	return { text: `\n\nCartographer's record of the atlas:\n${lines.join("\n")}`, atlas: { written, removed, stale: stale.map((node) => node.name) } };
}

/** The project's files as the main agent sees them now, for the start of a task. */
function treeNow(root, brainDir, config) {
	try {
		const { atlas } = loadAtlas(brainDir);
		return `The project's files as they are now:\n${treeSection(root, atlas?.view, { marks: atlas ? fileMarks(atlas) : undefined, depth: config.treeDepth }).text.replace(/ `atlas` with a tree operation[^\n]*/, "")}`;
	} catch {
		return "";
	}
}


/**
 * What kind of task a call asks for, or why it cannot run.
 * @returns {{ run?: { mode: "look" | "change", item?: string, text?: string, network?: boolean }, refusal?: string }}
 */
function kindOf(brainDir, item, gate) {
	if (item === undefined || item === null || String(item).trim() === "") return { run: { mode: POLICY.enums.planMode.look } };
	const { plan, error } = loadPlan(brainDir);
	if (plan === undefined) return { refusal: `The plan cannot be read: ${error}. It was probably edited by hand. Tell the user; they have to repair the file. A task without \`item\` can still look.` };
	const found = plan.items.find((entry) => entry.id === String(item).trim());
	if (found === undefined) {
		const ids = plan.items.map((entry) => entry.id).join(", ");
		return { refusal: `There is no plan item ${JSON.stringify(item)}. ${ids === "" ? "The plan is empty: write it with `plan` first, or leave `item` out for a task that only looks." : `The plan has ${ids}.`}` };
	}
	if (found.status === POLICY.enums.entryStatus.done) return { refusal: `${found.id} is marked done. For further work, add a new item to the plan.` };
	// Approval is per item: a change item runs once the user has approved it (requests), once the
	// whole plan was authorized with /approve, or while approval is switched off. Adding another
	// item never cancels what was already agreed.
	if (found.mode === POLICY.enums.planMode.change && !mayRun(plan, found, gate?.yolo === true)) return { refusal: REFUSALS.notAuthorized(found.id) };
	// Whether the task's commands reach the network is settled here, with the item as the user authorized it.
	return { run: { mode: found.mode, item: found.id, text: found.text, ...(found.mode === POLICY.enums.planMode.change && found.network === true ? { network: true } : {}) } };
}

/**
 * @param {{ root: string, brainDir: string, config: { taskTurns: number, maxTokens: number }, runner?: { mode: "sandbox" | "direct" | "none" } }} input
 *   runner: how commands run in this session (src/sandbox.mjs)
 */
export function taskTool({ root, brainDir, config, runner = { mode: "none" }, windows, gate, loops, ends, active = { id: undefined, said: [], heard: [] } }) {
	return defineTool({
		name: "task",
		description:
			"Hand one self-contained piece of work to a task. The task continues from your context and ends by returning a report; only the report comes back to you. Without `item` the task only looks: read, search, list. With `item`, it carries out that item of the plan, and for a change item it can also write and edit files and run commands.",
		parameters: obj({
			brief: str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "What the task must do, and what its report must contain" }),
			item: opt(str({ minLength: POLICY.validation.planIdMinLength, pattern: POLICY.patterns.planId, description: "The plan item this task carries out (p2). Leave out for a task that only looks." })),
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
			if (handed.added.length > 0) text += `\n\nThe task put on your shelf; these snapshots are in view now and will stand at the next collapse: ${handed.added.join(", ")}.\n\n${handed.snapshots.join("\n\n")}`;
			if (handed.refused.length > 0) text += `\n\nThe task wanted on your shelf, but it would not fit: ${handed.refused.join(", ")}.`;
			// The report is kept under an id, and one line of it goes into the record a collapse keeps
			// (src/context.mjs). The id is taken once, also when this call runs again after a restart.
			const id = (await api.memo("record", callContext)) ?? (await api.memo("record", reserveId(brainDir), callContext));
			addRecord(brainDir, { id, at: api.now(), mode: result.details.mode ?? POLICY.enums.planMode.look, item: result.details.item, brief: args.brief, report: text, summary: result.details.summary, failed: result.isError === true, undone: result.details.done === false, changed: result.details.changes?.length });
			text += `\n\n${KEPT_AS(id)}`;
			return { ...result, output: [{ type: "text", text }], details: { ...result.details, report: id, ...(handed.added.length > 0 ? { shelved: handed.added } : {}) } };
		},
	});

	async function run(args, api, callContext) {
		{
			if (typeof args.brief !== "string" || args.brief.trim() === "") return fail("`brief` is empty. Say what the task must do and what it must report.");

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
				const kind = kindOf(brainDir, args.item, gate);
				if (kind.run === undefined) return fail(kind.refusal);
				run = kind.run;
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
							run.before = await api.memo("before", checkpoint(root, brainDir, `before ${run.item}: ${run.text}`), callContext);
						}
					} catch (error) {
						if (!(error instanceof CheckpointError)) throw error;
						return fail(`No checkpoint could be taken, so the task was not started and nothing was changed: ${error.message}. Tell the user.`);
					}
				}
			}

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
					// The task's replies are counted in src/harness.mjs, which ends it at taskTurns; this is the net below that.
					await configure(tx, fork.id, { maxTurns: config.taskTurns + 2 });
					// Every call of the turn gets a result in the fork: the brief for this one, a note for the others.
					// The harness sends results in the order of the calls, so a note may come after the brief.
					const note = run.mode === POLICY.enums.planMode.change ? CHANGE_NOTE(run.item, run.text, { commands: run.direct ? "direct" : runner.mode === "none" ? "none" : "sandbox", network: run.network === true }) : LOOK_NOTE;
					let briefGiven = false;
					const tree = treeNow(root, brainDir, config);
					for (const call of calls) {
						const mine = call.id === api.callId;
						const text = mine ? `${TASK_HEADER}\n${note}\n\n${TASK_EXAMPLE[run.mode === POLICY.enums.planMode.change ? "change" : "look"]}\n\n${tree === "" ? "" : `${tree}\n\n`}Brief:\n${args.brief}` : briefGiven ? SIBLING_AFTER : SIBLING_BEFORE;
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
			const details = { conversationId: child, brief: args.brief, mode: run.mode, ...(run.item ? { item: run.item } : {}), ...(run.network ? { network: true } : {}), ...(run.direct ? { direct: true } : {}) };
			await api.details(details, callContext);

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

			// What the task returned (src/tools/return.mjs), and what ended it when it did not return.
			const returned = loadContext(brainDir).tasks[child]?.returned;
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
			}
			// What the user typed while the task ran: the main agent was not there to read it.
			let spoken = "";
			if (heard.length > 0) {
				details.heard = heard.length;
				const missed = unread.length > 0 ? ` The task did not get to read ${unread.length === heard.length ? "it" : `the last ${unread.length === 1 ? "one" : unread.length}`}.` : "";
				spoken = `\n\nWhile this task ran, the user wrote to it:${missed}\n${heard.map((entry) => `[user · ${stamp(entry.at)}] ${entry.text}`).join("\n")}`;
			}

			// What the task changed, from the record. Told to the main agent whether or not the task finished.
			let record = spoken;
			if (run.mode === POLICY.enums.planMode.change && run.before !== undefined) {
				try {
					const after = (await api.memo("after", callContext)) ?? (await api.memo("after", checkpoint(root, brainDir, `after ${run.item}`), callContext));
					details.changes = changesBetween(root, brainDir, run.before, after);
					// What windows did during the task is in that record. From here on they count for themselves again.
					windows?.takeActive();
					record +=
						details.changes.length === 0
							? `\n\nCartographer's record: no file ${run.direct ? "of the project " : ""}was changed during this task.`
							: `\n\nCartographer's record of the files changed during this task:\n${changeRecord(details.changes).join("\n")}`;
					// Without the sandbox a command can change what the checkpoints do not hold.
					if (run.direct) record += "\nThe sandbox was off for this task. The record covers the project directory only: what a command changed outside it is not listed here and cannot be undone.";
				} catch (error) {
					if (!(error instanceof CheckpointError)) throw error;
					record += `\n\nCartographer could not record what this task changed: ${error.message}.`;
				}
			}

			if (outside !== undefined) {
				details.outside = { names: outside.names, changes: outside.changes };
				record += `\n\nBefore this task started, Cartographer recorded what changed while ${outside.names.length === 1 ? `window ${outside.names[0]}` : `windows ${outside.names.join(", ")}`} ran with no task around, as a step of its own:\n${changeRecord(outside.changes).join("\n")}`;
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
				return fail(`Cartographer ended the task: it used all ${config.taskTurns} of its replies without calling \`return\`, so there is no report and nothing says the work is done.\n${wrote}\nGive a narrower brief, or split the work.${record}`, details);
			}
			if (returned === undefined && ended?.why === "same-note") {
				details.looped = true;
				return fail(`Cartographer ended the task: it wrote ${ended.empty ? `nothing and called nothing, ${ended.times} times in a row` : `the same note ${ended.times} times in a row and called nothing`}, so there is no report.\n${wrote}\nIf the work is still needed, start another task with a brief that says what to do first.${record}`, details);
			}
			if (returned === undefined && round) {
				const loop = loops?.get(child);
				details.looped = loop ?? true;
				const what = loop === undefined ? "it sent the same failing call again and again." : `it sent the same call ${loop.total} times and it failed each time: \`${loop.call}\`\nThe error was:\n${loop.error}`;
				return fail(`Cartographer ended the task: ${what}\n${wrote}\nIf the work is still needed, start another task whose brief says how to avoid this.${record}`, details);
			}
			if (returned === undefined) return fail(`The task ended without calling \`return\`, so there is no report.\n${wrote}\nRun it again with a brief that says what the report must contain.${record}`, details);
			// A plan item's task says itself whether the item is done.
			let marked = "";
			if (run.item !== undefined) {
				if (returned.done) {
					try {
						const { plan } = loadPlan(brainDir);
						const item = plan?.items.find((entry) => entry.id === run.item);
						if (item !== undefined && item.standing === true) marked = `\n\n[Cartographer: ${run.item} is a standing item, so it stays open.]`;
						else if (item !== undefined && item.status !== POLICY.enums.entryStatus.done) {
							applyPlanOp(plan, { action: POLICY.enums.actions.done, id: run.item }, api.now(), { yolo: gate?.yolo === true });
							savePlan(brainDir, plan);
							details.marked = run.item;
							marked = `\n\n[Cartographer: the task returned done, so ${run.item} is marked done in the plan. If the report or the record below shows that something is missing, add an item for it.]`;
						}
					} catch (error) {
						marked = `\n\n[Cartographer: ${run.item} could not be marked done (${error.message}); mark it with \`plan\`.]`;
					}
				} else marked = `\n\n[Cartographer: the task returned not done, so ${run.item} stays open in the plan.]`;
			} else if (!returned.done) marked = "\n\n[Cartographer: the task returned not done.]";
			return { output: [{ type: "text", text: `${said}${marked}${record}` }], details };
		}
	}
}
