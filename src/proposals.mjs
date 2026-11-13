// The agent's proposals for its own prompt, and the wording the user has approved.
//
// The agent can propose to reword a section of its system prompt or a tool's description, to add a section, or
// to drop one (src/tools/prompt.mjs). A proposal changes nothing. It waits in the project's brain as a request to
// the user (src/requests.mjs); when the user approves it, the wording goes into one file in the core folder,
// prompt.json, and is laid over the built-in wording (src/prompt.mjs) the next time carto starts, in every
// project. The start is the moment because the prompt is the first thing in the agent's context: a change there
// makes the server read everything again, and a session that is under way keeps the prompt it began with.
//
// Every section and description has a budget (src/prompt.mjs). A proposal that does not fit is refused when it is
// made, so what is read in front of every request cannot grow back by small steps.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { budgetOf, SECTIONS, TOOLS, wordingOf } from "./prompt.mjs";

export class ProposalError extends Error {}

/** Where the approved wording is kept. CARTO_PROMPT names another file, for the tests. */
export const overlayPath = (coreDir) => process.env.CARTO_PROMPT || join(coreDir, "prompt.json");
export const proposalsPath = (brainDir) => join(brainDir, "carto-proposals.json");

const flat = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const write = (path, value) => {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`);
	renameSync(temp, path);
};

/** The approved wording: { sections: { name: text | null }, added: [[name, text, before]], tools: { name: text } }. A file that cannot be read counts as none. */
export function loadOverlay(path) {
	const none = { sections: {}, added: [], tools: {} };
	if (!existsSync(path)) return none;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (raw === null || typeof raw !== "object") return none;
		return {
			sections: raw.sections !== null && typeof raw.sections === "object" ? raw.sections : {},
			added: Array.isArray(raw.added) ? raw.added.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") : [],
			tools: raw.tools !== null && typeof raw.tools === "object" ? raw.tools : {},
		};
	} catch {
		return none;
	}
}

/** @returns {{ next: number, items: { id: string, action: "edit" | "add" | "remove", target: string, text?: string, before?: string, why: string, at: number }[] }} */
export function loadProposals(brainDir) {
	const path = proposalsPath(brainDir);
	if (!existsSync(path)) return { next: 1, items: [] };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		const items = Array.isArray(raw?.items) ? raw.items.filter((item) => item !== null && typeof item === "object" && typeof item.id === "string" && typeof item.target === "string") : [];
		return { next: Math.max(Number.isInteger(raw?.next) ? raw.next : 1, 1 + Math.max(0, ...items.map((item) => Number(item.id.slice(1)) || 0))), items };
	} catch {
		return { next: 1, items: [] };
	}
}

/** The names a proposal can aim at: the sections as they are now, and "tool." with a tool's name. */
export const targets = () => ({ sections: SECTIONS.map(([name]) => name), tools: Object.keys(TOOLS).map((name) => `tool.${name}`) });

/** A proposal in one line, for the agent and for the user. */
export function proposalLine(item) {
	const what = item.action === "remove" ? `drop the section ${item.target}` : item.action === "add" ? `add a section ${item.target}${item.before ? ` in front of ${item.before}` : ""}` : `reword ${item.target.startsWith("tool.") ? `the description of \`${item.target.slice(5)}\`` : `the section ${item.target}`}`;
	return `${item.id}  ${what}: ${item.why}`;
}

/** What a proposal would change, as lines: the wording now with "- " in front, the proposed wording with "+ ". */
export function proposalDiff(item) {
	const now = wordingOf(item.target);
	return [...(now !== undefined ? [`- ${now}`] : []), ...(item.text !== undefined ? [`+ ${item.text}`] : [])];
}

/**
 * Record one proposal of the agent. Nothing but the list of proposals changes.
 * @param {{ action: string, target?: string, name?: string, text?: string, before?: string, why?: string }} op
 * @returns {{ line: string, shown: string }}
 */
export function propose(brainDir, op, now) {
	const why = flat(op.why);
	if (why === "") throw new ProposalError("`why` is required: what misled you, or what you observed, in a line. The user decides from it.");
	if (why.length > 300) throw new ProposalError(`\`why\` is ${why.length} characters; one line of at most 300 is enough.`);
	const known = targets();
	let item;
	if (op.action === "edit") {
		const target = flat(op.target);
		if (wordingOf(target) === undefined) throw new ProposalError(`There is no section or tool description ${JSON.stringify(target)}. Sections: ${known.sections.join(", ")}. Tool descriptions: ${known.tools.join(", ")}.`);
		item = { action: "edit", target, text: fitting(target, op.text) };
		if (item.text === wordingOf(target)) throw new ProposalError("That is the wording as it stands: nothing would change.");
	} else if (op.action === "add") {
		const name = flat(op.name ?? op.target);
		if (!/^[a-z][a-z0-9-]{1,23}$/.test(name)) throw new ProposalError("`name` for a new section is a short word in small letters, such as testing.");
		if (wordingOf(name) !== undefined) throw new ProposalError(`There is a section ${name} already; reword it with action edit.`);
		const before = flat(op.before);
		if (before !== "" && (before.startsWith("tool.") || wordingOf(before) === undefined)) throw new ProposalError(`\`before\` names no section: ${JSON.stringify(before)}. Sections: ${known.sections.join(", ")}.`);
		item = { action: "add", target: name, text: fitting(name, op.text), ...(before !== "" ? { before } : {}) };
	} else if (op.action === "remove") {
		const target = flat(op.target);
		if (target.startsWith("tool.")) throw new ProposalError("A tool's description can be reworded, not dropped.");
		if (wordingOf(target) === undefined) throw new ProposalError(`There is no section ${JSON.stringify(target)}. Sections: ${known.sections.join(", ")}.`);
		item = { action: "remove", target };
	} else throw new ProposalError(`Unknown action ${JSON.stringify(op?.action)}; the actions are edit, add, remove.`);
	const book = loadProposals(brainDir);
	if (book.items.length >= 12) throw new ProposalError("Twelve proposals wait for the user already. Let them decide those first.");
	Object.assign(item, { id: `x${book.next}`, why, at: now });
	book.next++;
	// A newer proposal for the same thing takes the place of the older one.
	book.items = [...book.items.filter((entry) => entry.target !== item.target), item];
	write(proposalsPath(brainDir), book);
	return { line: `${item.id} proposed. Nothing has changed: it waits for the user among their requests, and holds from the next start of carto once they approve it.`, shown: `? ${proposalLine(item)}` };
}

function fitting(target, value) {
	const text = String(value ?? "").trim();
	if (text === "") throw new ProposalError("`text` is required: the whole new wording.");
	const budget = budgetOf(target);
	if (text.length > budget) throw new ProposalError(`\`text\` is ${text.length} characters; ${target} may hold ${budget}. Say it more shortly: a section says when and why, a tool's description what the tool does.`);
	return text;
}

/**
 * The user decides a proposal. Approved, its wording goes into the file of approved wording.
 * @returns {undefined | { item: any, approved: boolean }} undefined when there is no such proposal
 */
export function decide(brainDir, coreDir, id, approved) {
	const book = loadProposals(brainDir);
	const item = book.items.find((entry) => entry.id === id);
	if (item === undefined) return undefined;
	if (approved) {
		const path = overlayPath(coreDir);
		const overlay = loadOverlay(path);
		if (item.target.startsWith("tool.")) overlay.tools[item.target.slice(5)] = item.text;
		else if (item.action === "remove") {
			overlay.added = overlay.added.filter(([name]) => name !== item.target);
			if (SECTIONS.some(([name]) => name === item.target)) overlay.sections[item.target] = null;
			else delete overlay.sections[item.target];
		} else if (item.action === "add") overlay.added = [...overlay.added.filter(([name]) => name !== item.target), [item.target, item.text, item.before ?? ""]];
		else if (overlay.added.some(([name]) => name === item.target)) overlay.added = overlay.added.map((entry) => (entry[0] === item.target ? [entry[0], item.text, entry[2]] : entry));
		else overlay.sections[item.target] = item.text;
		write(path, overlay);
	}
	book.items = book.items.filter((entry) => entry.id !== id);
	write(proposalsPath(brainDir), book);
	return { item, approved };
}

/** Take approved wording back: one section or description goes back to how it is built in. Returns whether there was any. */
export function resetWording(coreDir, target) {
	const path = overlayPath(coreDir);
	const overlay = loadOverlay(path);
	const had = target.startsWith("tool.") ? overlay.tools[target.slice(5)] !== undefined : overlay.sections[target] !== undefined || overlay.added.some(([name]) => name === target);
	if (!had) return false;
	if (target.startsWith("tool.")) delete overlay.tools[target.slice(5)];
	else {
		delete overlay.sections[target];
		overlay.added = overlay.added.filter(([name]) => name !== target);
	}
	write(path, overlay);
	return true;
}
