// The `plan` tool: how the main agent writes its plan (src/plan.mjs).
import { defineTool } from "@earendil-works/pi-durable";
import { arr, bool, lit, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import { applyPlanOp, authorizationLine, loadPlan, MODES, PlanError, savePlan } from "../plan.mjs";

const id = () => str({ description: "The item (p1, p4)." });
const mode = () => oneOf(MODES, { description: "look: the task only reads. change: the task writes files and runs commands, which needs the user's authorization." });
const network = () => bool({ description: "true: this change item's commands can reach the network, to install packages for instance. Leave out otherwise: commands then run without network." });

const standing = () =>
	bool({ description: "true: a duty that stays open, such as keeping a server running. Once the plan is authorized, tasks may be started for it again and again, until it is marked done. Leave out for work that is done once." });

// One object shape per action, told apart by `action`, required fields before optional ones: see src/tools/ledger.mjs.
const Op = union([
	obj(
		{
			action: lit("add"),
			mode: mode(),
			text: str({ description: "What this item covers, in one line: one piece of work a single task can do." }),
			network: opt(network()),
			standing: opt(standing()),
			before: opt(str({ description: "Put the new item in front of this one (p3). Default: at the end." })),
		},
		{ description: "Add an item." },
	),
	obj({ action: lit("done"), id: id(), text: opt(str({ description: "What came of it, one line." })) }, { description: "Mark an item finished." }),
	obj({ action: lit("edit"), id: id(), text: opt(str({ description: "The new wording, one line." })), mode: opt(mode()), network: opt(network()), standing: opt(bool({ description: "true or false: make the item a standing duty, or end that." })) }, { description: "Reword an item, change its mode, give or take the network, or make it standing or not." }),
	obj({ action: lit("remove"), id: id() }, { description: "Drop an item." }),
	obj({ action: lit("clear") }, { description: "Drop the whole plan, when its goals are reached or given up." }),
]);

const opLabel = (op) => `${op?.action ?? "?"}${op?.id || op?.mode ? ` ${op.id || op.mode}` : ""}`;

/**
 * @param {{ brainDir: string, gate?: { yolo: boolean } }} input
 *   gate: whether the user has switched approval off (yolo); the terminal changes it
 */
export function planTool({ brainDir, gate }) {
	return defineTool({
		name: "plan",
		description: [
			"Your plan for the open goals: a short list of items in the order they should happen, each one piece of work for a single task.",
			"The plan is shown to you in the state block of every request, and the user reads and edits it too.",
			"Arrange it as you see fit. Only one thing needs the user: change items run after the user has authorized the plan with /approve, and adding a change item, rewording one, giving one the network or making one standing asks them again.",
			"A standing item is a duty rather than a piece of work: it stays open, and a task may be started for it whenever its text calls for it.",
		].join(" "),
		parameters: obj({
			ops: arr(Op, { description: "Operations, applied in order. Each stands on its own: one that cannot be applied is reported, and the others are saved." }),
		}),
		executionMode: "sequential",
		// Safe to run again after a crash: the file remembers the last call it applied.
		replay: "safe",
		execute: async (args, api) => {
			const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
			const ops = Array.isArray(args.ops) ? args.ops : [];
			if (ops.length === 0) return fail("`ops` is empty: give at least one operation.");
			const { plan, error } = loadPlan(brainDir);
			if (plan === undefined) return fail(`The plan cannot be read: ${error}. It was probably edited by hand. Nothing was changed. Tell the user; they have to repair the file.`);
			if (plan.lastCall === api.taskId) {
				return { output: [{ type: "text", text: `These operations were already applied, before a restart.\n${authorizationLine(plan)}` }], details: { shown: ["(applied before the restart)"] } };
			}

			const lines = [];
			const shown = [];
			let applied = 0;
			let withdrawn = false;
			const now = new Date(api.now()).toISOString();
			for (const [index, op] of ops.entries()) {
				try {
					const result = applyPlanOp(plan, op, now, { yolo: gate?.yolo === true });
					lines.push(result.line);
					shown.push(result.shown);
					withdrawn ||= result.withdrawn === true;
					applied++;
				} catch (problem) {
					if (!(problem instanceof PlanError)) throw problem;
					lines.push(`Op ${index + 1} (${opLabel(op)}) not applied: ${problem.message}`);
				}
			}
			if (applied === 0) return fail(lines.join("\n"));
			if (applied < ops.length) lines.push(`${applied} of ${ops.length} applied and saved; send only the ones not applied again.`);
			if (plan.items.length > 0) lines.push(authorizationLine(plan, { yolo: gate?.yolo === true }));
			if (withdrawn) shown.push("authorization withdrawn: a change item was added or changed");
			plan.lastCall = api.taskId;
			savePlan(brainDir, plan);
			return { output: [{ type: "text", text: lines.join("\n") }], details: { shown } };
		},
	});
}
