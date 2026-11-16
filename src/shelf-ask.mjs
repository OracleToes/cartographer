// The read gate: one read comes back per reply, in every turn. Whatever else the agent asked to read in the same
// reply is refused inside beforeTool — the model never sees the file's content — and a question rides the round's
// results: should the files it did not get (and the one it did) be shelved? The shelf is where several files stay
// in view at once (src/context.mjs), so asking is the honest alternative to handing everything to the model.
//
// The question is one-shot: once the agent has answered (its next reply), the stored question is dressed out of
// what it sees (dressShelfAsk, called from src/request.mjs); the conversation record keeps it, as it keeps the notes.
//
// A yes is carried out by Cartographer, not by the agent making more calls: for one file, "yes" shelves it; for
// several, the agent gives the numbers of the ones to shelf ("yes" shelves them all; "1 3" shelves those; "no"
// shelves none). Shelving outcomes are told with a note on the agent's next tool result.
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { resolveFile } from "./catalog.mjs";
import { loadContext, persistShelfSnapshot, shelfItem, taskState, updateContext } from "./context.mjs";
import { warn } from "./warnings.mjs";

export const SHELF_ASK_OPEN = "<shelf-ask>";
export const SHELF_ASK_CLOSE = "</shelf-ask>";

/** In-flight state, per conversation and per reply: what was planned, what ran, what was declined. */
const gates = new Map();
/** The question a conversation has been asked and has not answered yet: { files }. */
const pending = new Map();

const textOf = (message) => (typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.map((part) => part.text ?? "").join("") : "");
const callsOf = (message) => (Array.isArray(message?.content) ? message.content.filter((part) => part.type === "toolCall") : []);
const isFileRead = (call) => call?.name === "book" && call.arguments?.action === "read" && call.arguments?.target === "file";

/** What the entry looks like in the question: the path if it was given one, the stable id otherwise. */
const entryOf = (args) => {
	if (typeof args?.path === "string" && args.path.trim() !== "") return { path: args.path.trim(), display: args.path.trim() };
	const id = args?.ref?.id;
	return { path: undefined, ref: args?.ref, display: typeof id === "string" ? `file ${id}` : "a file" };
};

/**
 * A new reply is about to have its calls run. The reads it called are counted, so the gate can return the first
 * and refuse the rest whatever the order the harness runs the calls in. A reply without a file read clears the gate.
 * @param {string} conversationId
 * @param {object} message  the assistant message whose calls are next
 */
export function beginShelfGate(conversationId, message) {
	const planned = callsOf(message).filter(isFileRead).length;
	if (planned === 0) { gates.delete(conversationId); return; }
	gates.set(conversationId, { planned, entered: 0, ran: undefined, declined: [], ready: false, asked: false });
}

/**
 * The decision for one file-read call of the reply in flight. The first to arrive is the one that is returned;
 * the others are refused with no content. Called from beforeTool; anything not a file read passes.
 * @returns {string | undefined} the refusal text, or undefined to let the call through
 */
export function readGateCheck(conversationId, call) {
	if (!isFileRead(call)) return undefined;
	const gate = gates.get(conversationId);
	if (gate === undefined) return undefined; // a read outside a planned reply (not an assistant message we saw) — not gated
	gate.entered += 1;
	const entry = entryOf(call.arguments);
	let refused;
	if (gate.ran === undefined) {
		gate.ran = { ...entry, returned: true };
	} else {
		gate.declined.push({ ...entry, returned: false });
		refused = `${entry.display} was not returned. Only one read comes back per reply — the question at the end of the round asks whether to shelf it. Read it next reply instead, or shelf it.`;
	}
	if (gate.entered >= gate.planned) gate.ready = true;
	return refused;
}

/** The question for a set of files of one reply. One file: yes or no. Several: pick by number. */
export function shelfAskText(files) {
	if (files.length === 0) return undefined;
	if (files.length === 1) {
		return `${SHELF_ASK_OPEN}\nShould I shelf ${files[0].display}? Yes or no — if yes, it is shelved for me and stays in view; if no, the read stands as a read.\n${SHELF_ASK_CLOSE}`;
	}
	const lines = files.map((file, index) => `  ${index + 1}  ${file.display}${file.returned === false ? "  (not returned)" : ""}`);
	return `${SHELF_ASK_OPEN}\nShould I shelf them? Yes or no — if yes, which, by number (for example "1 3"); yes alone shelves them all; no shelves none.\n${lines.join("\n")}\n${SHELF_ASK_CLOSE}`;
}

/**
 * The question for the reply in flight, once every read it planned has been decided: the returned file and the
 * declined ones, in the order they were called. Called from afterTool; the question rides the result once.
 * @returns {string | undefined} the question block, or undefined when there is nothing to ask about
 */
export function takeShelfAsk(conversationId) {
	const gate = gates.get(conversationId);
	if (gate === undefined || !gate.ready || gate.asked) return undefined;
	const files = [gate.ran, ...gate.declined].filter(Boolean);
	if (files.length === 0) return undefined;
	gate.asked = true;
	pending.set(conversationId, { files });
	return shelfAskText(files);
}

// Words that carry no choice, so that a reply made of them and numbers ("yes, 1 and 3") is a list of picks.
const DECISION_STOPWORDS = new Set("yes,yep,yeah,sure,ok,okay,no,nope,nah,and,or,the,to,a,an,of,for,in,on,them,it,all,please,numbers,number,pick,with,that,shelf,shelve,shelves,i,want,would,like,keep,take,go".split(","));
/**
 * What the agent's reply says about the question. A reply whose words are nothing but digits and words that carry
 * no choice ("yes, 1 and 3", "1 3", "ok") is a decision: the numbers are picks (out-of-range ones ignored), or a
 * yes shelves them all. A reply with real words in it ("the renderer has 18 faces") is not a decision at all and
 * shelves nothing. An explicit no vetoes the picks.
 * @returns {number[]} the indices (0-based, into the asked files) to shelf
 */
export function parseShelfDecision(text, count) {
	const t = String(text ?? "");
	const no = /\b(no|nope|nah)\b/i.test(t);
	const yes = /\b(yes|yep|yeah|sure|ok|okay)\b/i.test(t);
	const tokens = [...t.toLowerCase().matchAll(/[a-z0-9]+/g)].map((match) => match[0]);
	const digits = tokens.filter((token) => /^[0-9]+$/.test(token)).map(Number).filter((n) => n >= 1 && n <= count);
	const listLike = tokens.every((token) => /^[0-9]+$/.test(token) || DECISION_STOPWORDS.has(token));
	if (listLike) {
		if (digits.length > 0 && !no) return [...new Set(digits)].sort((a, b) => a - b).map((n) => n - 1);
		if (yes && !no) return Array.from({ length: count }, (_, index) => index);
		return [];
	}
	if (yes && !no) return Array.from({ length: count }, (_, index) => index);
	return [];
}

/**
 * The agent has replied. If a question is waiting, this is its answer: shelve what it picked, if anything. A file
 * the agent shelved this way did not come through a shelf call, so a failure is a note on its next tool result,
 * not an error the reply knows about. Called from afterResponse, before the next reply's gate is planned.
 * @param {string} conversationId
 * @param {object} message  the assistant message that just came in
 * @param {{ root: string, brainDir: string }} input
 */
export function settleShelfAsk(conversationId, message, { root, brainDir }) {
	const ask = pending.get(conversationId);
	if (ask === undefined) return;
	pending.delete(conversationId);
	const picks = parseShelfDecision(textOf(message), ask.files.length);
	if (picks.length === 0) return;
	const main = conversationId === ROOT_CONVERSATION_ID;
	const store = loadContext(brainDir);
	const mine = () => (main ? loadContext(brainDir).shelf : (taskState(loadContext(brainDir), conversationId)?.shelf ?? []));
	const shelved = [];
	for (const index of picks) {
		const file = ask.files[index];
		let path = file.path;
		if (path === undefined && file.ref !== undefined) {
			try { path = resolveFile(root, brainDir, file.ref)?.record?.path; } catch { path = undefined; }
		}
		if (typeof path !== "string" || path.trim() === "") {
			warn(`The shelf did not take the file asked for (\`${file.display}\`): its path could not be resolved.`);
			continue;
		}
		try {
			const existing = mine();
			const picked = shelfItem(root, path, undefined, brainDir, existing);
			const item = { ...picked.item, ...(file.ref ? { target: file.ref } : {}) };
			persistShelfSnapshot(brainDir, item, picked.backing);
			updateContext(brainDir, (next) => {
				const list = main ? next.shelf : (taskState(next, conversationId).shelf ??= []);
				const at = list.findIndex((entry) => entry.id === item.id);
				if (at < 0) list.push(item);
				else list[at] = item;
			});
			shelved.push(path);
		} catch (error) {
			warn(`The shelf did not take ${path}: ${error.message}`);
		}
	}
	if (shelved.length > 0) warn(`Shelved: ${shelved.join(", ")} — in view from the next collapse on.`);
}

/** The question, without anything around it, as the dressing strips it: matched across text is enough. */
const ASK_BLOCK = new RegExp(`\\n*${SHELF_ASK_OPEN}[\\s\\S]*?${SHELF_ASK_CLOSE}\\n?`, "g");

/**
 * The question, dressed out of the request: every question whose answer has come (an assistant message stands
 * after it) is removed from what the model sees. The stored messages are not changed, as for everything the
 * request dresses.
 * @param {readonly any[]} messages
 */
export function dressShelfAsk(messages) {
	const out = [...messages];
	let assistantAfter = false;
	for (let index = out.length - 1; index >= 0; index--) {
		const message = out[index];
		if (message.role === "toolResult" && assistantAfter) {
			const next = stripAsk(message);
			if (next !== message) out[index] = next;
		}
		if (message.role === "assistant") assistantAfter = true;
	}
	return out;
}

/** The message without the question block. Returns the same message when it holds none. */
function stripAsk(message) {
	const strip = (text) => text.replace(ASK_BLOCK, "").replace(/\n{3,}/g, "\n\n");
	if (typeof message.content === "string") {
		const stripped = strip(message.content);
		return stripped === message.content ? message : { ...message, content: stripped };
	}
	if (!Array.isArray(message.content)) return message;
	let changed = false;
	const content = message.content.map((part) => {
		if (part?.type !== "text") return part;
		const stripped = strip(part.text ?? "");
		if (stripped === part.text) return part;
		changed = true;
		return { ...part, text: stripped };
	});
	return changed ? { ...message, content } : message;
}
