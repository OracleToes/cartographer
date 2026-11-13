// The block at the top of the context: the assessment and the outline of the graph.
//
// The model server keeps what it has read and reads again only from the first
// token that differs. So what stands at the start of the conversation must stay
// byte for byte the same from one request to the next, or every request reads the
// whole context again. The assessment and the graph change while the agent works;
// what is shown at the top therefore is a copy, written at moments when reading
// everything again is acceptable:
//
//   - the first start in a project
//   - a goal is closed
//   - a fresh context (/new)
//   - the user asks for it (/pin)
//
// Between those moments the copy stays as it is, and the state block at the end
// of each request (src/state.mjs) lists what was written since.
//
// The copy is kept in <project>/.atlas/carto-top.json and added to the first
// message of every request, for the main agent and for tasks alike: a task's
// prompt must begin exactly as the main agent's does. It is never stored in the
// conversation.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAssessment, textHash } from "./assessment.mjs";
import { loadAtlas, nodeChanges, nodeHashes, renderOutline } from "./atlas.mjs";
import { stamp } from "./time.mjs";

const OPEN = "<project>";
const CLOSE = "</project>";
const HEAD = "Written by Cartographer from your own records of this project";

export const topPath = (brainDir) => join(brainDir, "carto-top.json");

/** The copy as it was last written, or undefined when there is none that can be read. */
export function loadTop(brainDir) {
	const path = topPath(brainDir);
	if (!existsSync(path)) return undefined;
	try {
		const top = JSON.parse(readFileSync(path, "utf8"));
		if (top === null || typeof top !== "object" || typeof top.text !== "string" || top.nodes === null || typeof top.nodes !== "object") return undefined;
		return top;
	} catch {
		return undefined;
	}
}

/**
 * Write the copy from the assessment and the graph as they are now.
 * Nothing is written when neither differs from the copy that is there: the context then stays as the server knows it.
 * @param {string} brainDir
 * @param {{ now?: number, reason: string }} input  reason: what the moment is, in a few words ("goal g1 was closed")
 * @returns {{ changed: boolean, error?: string }}
 */
export function pin(brainDir, { now = Date.now(), reason }) {
	const { atlas, error } = loadAtlas(brainDir);
	// A graph that cannot be read is not copied: the last good copy stays.
	if (atlas === undefined) return { changed: false, error };
	const assessment = loadAssessment(brainDir).text;
	const nodes = nodeHashes(atlas);
	const old = loadTop(brainDir);
	if (old !== undefined && old.assessment === textHash(assessment) && JSON.stringify(old.nodes) === JSON.stringify(nodes)) return { changed: false };
	const text = [
		OPEN,
		`${HEAD}, as they stood on ${stamp(now)} (${reason}). What was written since is listed in the state block at the end of the request.`,
		"",
		"Your assessment",
		assessment === "" ? "None written yet." : assessment,
		"",
		`Your graph (${atlas.nodes.length === 1 ? "1 node" : `${atlas.nodes.length} nodes`})`,
		renderOutline(atlas),
		CLOSE,
	].join("\n");
	const path = topPath(brainDir);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify({ version: 1, at: new Date(now).toISOString(), reason, assessment: textHash(assessment), nodes, text }, null, "\t")}\n`);
	renameSync(temp, path);
	return { changed: true };
}

/** Remember that the agent itself wrote this assessment, so the state block need not show it the text again. */
export function noteAssessed(brainDir, text) {
	const top = loadTop(brainDir);
	if (top === undefined) return;
	const path = topPath(brainDir);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify({ ...top, assessed: textHash(text.trim()) }, null, "\t")}\n`);
	renameSync(temp, path);
}

/**
 * What was written after the copy was made.
 * @returns {{ written: string[], removed: string[], assessment: boolean, at?: string }}
 */
export function sinceTop(brainDir, atlas, assessmentText) {
	const top = loadTop(brainDir);
	if (top === undefined) return { written: atlas.nodes.map((node) => node.name), removed: [], assessment: assessmentText !== "" };
	return { ...nodeChanges(top.nodes, nodeHashes(atlas)), assessment: top.assessment !== textHash(assessmentText), at: top.at };
}

/**
 * The messages of one request with the copy in front of the first message, when that is a user message.
 * The input is not changed.
 */
export function withTop(messages, block) {
	const at = messages.findIndex((message) => message.role !== "system");
	const first = messages[at];
	if (block === undefined || block === "" || first === undefined || first.role !== "user") return messages;
	const addition = `${block}\n\n`;
	let content;
	if (typeof first.content === "string") content = addition + first.content;
	else {
		const head = first.content[0];
		content = head?.type === "text" ? [{ ...head, text: addition + head.text }, ...first.content.slice(1)] : [{ type: "text", text: block }, ...first.content];
	}
	return [...messages.slice(0, at), { ...first, content }, ...messages.slice(at + 1)];
}

/** Text with the copy removed (for the tests' stand-in, which obeys what the user wrote). */
export function withoutTop(text) {
	return text.replace(/<project>\nWritten by Cartographer[\s\S]*?\n<\/project>\n*/g, "");
}
