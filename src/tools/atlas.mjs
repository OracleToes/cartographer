// The `atlas` tool: how the agent and its tasks write the graph (src/atlas.mjs),
// and how the main agent moves the tree it is shown (src/tree.mjs).
import { isAuthorized, loadPlan } from "../plan.mjs";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { arr, int, lit, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import { applyAtlasOp, AtlasError, DETAIL_MAX, GIST_MAX, KINDS, loadAtlas, saveAtlas } from "../atlas.mjs";
import { DEPTH_MAX } from "../tree.mjs";
import { projectFiles } from "./look.mjs";

const name = () => str({ description: "The node's name: short and stable, such as dice_roll." });
const links = (what) => opt(arr(str(), { description: `Names of other nodes ${what}.` }));
const files = (what) => opt(arr(str(), { description: `Paths of files or folders in the project ${what}.` }));

// One object shape per action, told apart by `action`; the fields an action cannot work without are required, so
// a grammar-constrained server cannot leave them out. Keep `action` first, then the required fields, then the
// optional ones: such a server writes properties in this order.
const Op = union([
	obj(
		{
			action: lit("add"),
			name: name(),
			gist: str({ description: `One line that says what this is, at most ${GIST_MAX} characters.` }),
			kind: opt(oneOf(KINDS, { description: "component: a part of the project and what it does. finding: something established. dead_end: something tried and ruled out, kept so it is not tried again. Leave out for a plain node." })),
			detail: opt(str({ description: `Anything longer worth keeping, at most ${DETAIL_MAX} characters. Shown only by look.` })),
			links: links("this one relates to; added to the links it has"),
			files: files("this node is about; added to the ones it has"),
		},
		{ description: "Write a new node by that name. A node needs no file and no link." },
	),
	obj(
		{
			action: lit("edit"),
			name: name(),
			gist: str({ description: `One line that says what this is, at most ${GIST_MAX} characters.` }),
			kind: opt(oneOf(KINDS, { description: "component: a part of the project and what it does. finding: something established. dead_end: something tried and ruled out, kept so it is not tried again. Leave out for a plain node." })),
			detail: opt(str({ description: `Anything longer worth keeping, at most ${DETAIL_MAX} characters. Shown only by look.` })),
			links: links("this one relates to; added to the links it has"),
			files: files("this node is about; added to the ones it has"),
		},
		{ description: "Rewrite the node of that name: the gist is replaced, links and files are added to the ones it has." },
	),
	obj({ action: lit("link"), name: name(), links: links("to link to"), files: files("to link to") }, { description: "Add links to a node, without rewriting it." }),
	obj({ action: lit("unlink"), name: name(), links: links("to stop linking to"), files: files("to stop linking to") }, { description: "Take links off a node." }),
	obj(
		{ action: lit("confirm"), names: arr(str(), { description: "Nodes that were checked against their files and still hold." }) },
		{ description: "Say that nodes marked as possibly out of date are still true, after their files were looked at." },
	),
	obj({ action: lit("remove"), name: name() }, { description: "Delete a node and every link to it." }),
	obj({ action: lit("look"), name: str({ description: "A node's name, or a path: for a path, the nodes that link to it." }) }, { description: "Read one node in full: gist, detail, its files and whether they changed, links both ways." }),
	obj(
		{
			action: lit("tree"),
			anchor: opt(str({ description: 'The folder the tree is drawn from. "." is the project root.' })),
			depth: opt(int({ description: `How many levels are drawn below the anchor, 1 to ${DEPTH_MAX}.` })),
		},
		{ description: "Main agent only. Move the tree shown in the state block into a folder, back to the project root, or change how deep it is drawn. It stays that way until you change it." },
	),
]);

const opLabel = (op) => `${op?.action ?? "?"}${op?.name ? ` ${op.name}` : ""}`;

/** @param {{ root: string, brainDir: string }} input */
export function atlasTool({ root, brainDir, gate }) {
	return defineTool({
		name: "atlas",
		description: [
			"Your map of this project, kept across sessions. Its graph holds what you have understood: a node says what a part does, what was found out, or what was tried and ruled out, and links to the files it is about and to other nodes.",
			"Write a node for what you would want to know when you come back to this project with an empty context; not every file needs one. Tasks write nodes too.",
			"When a file a node links to changes, the node is marked as possibly out of date until it is rewritten or confirmed.",
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
			const { atlas, error } = loadAtlas(brainDir);
			if (atlas === undefined) return fail(`The atlas cannot be read: ${error}. It was probably edited by hand. Nothing was changed. Say so in your answer; the user has to repair the file.`);
			// This call ran before and was cut off after saving (a crash, then a restart): do not apply it twice.
			const rerun = atlas.lastCall === api.taskId;

			const main = api.conversationId === ROOT_CONVERSATION_ID;
			// A file link that names nothing yet makes the file, when the project may be changed at all.
			const { plan } = loadPlan(brainDir);
			const mayCreate = gate?.yolo === true || (plan !== undefined && isAuthorized(plan));
			const who = { root, now: new Date(api.now()).toISOString(), by: main ? "main" : "task", main, files: () => projectFiles(root), created: [], mayCreate };
			const lines = [];
			const settle = [];
			const shown = [];
			let applied = 0;
			let changed = false;
			for (const [index, op] of ops.entries()) {
				// What only reads is answered again; what writes was done before the restart.
				if (rerun && op?.action !== "look") {
					lines.push(`Op ${index + 1} (${opLabel(op)}) was already applied, before a restart.`);
					applied++;
					continue;
				}
				try {
					const result = applyAtlasOp(atlas, op, who);
					lines.push(result.line);
					if (result.settle !== undefined) settle.push([lines.length - 1, result.settle]);
					if (result.shown !== undefined) shown.push(result.shown);
					changed ||= result.changed;
					applied++;
				} catch (problem) {
					if (!(problem instanceof AtlasError)) throw problem;
					lines.push(`Op ${index + 1} (${opLabel(op)}) not applied: ${problem.message}`);
				}
			}
			// A link to a node that a later operation of this call wrote is not a link to nothing.
			for (const [at, again] of settle) lines[at] = again(atlas);
			// A file link that named nothing was made into an empty file, so that the map and the project agree.
			const created = [...new Set(who.created)];
			if (created.length > 0) lines.push(`Created, because ${created.length === 1 ? "it" : "they"} did not exist: ${created.join(", ")} (empty). Whoever fills ${created.length === 1 ? "it" : "them"} writes over ${created.length === 1 ? "it" : "them"}. If a path was a slip, tell the user.`);
			if (applied === 0) return fail(lines.join("\n"));
			if (applied < ops.length) lines.push(`${applied} of ${ops.length} applied and saved; send only the ones not applied again.`);
			if (changed) {
				atlas.lastCall = api.taskId;
				saveAtlas(brainDir, atlas);
			}
			return { output: [{ type: "text", text: lines.join("\n") }], details: { shown, ...(created.length > 0 ? { created } : {}) } };
		},
	});
}
