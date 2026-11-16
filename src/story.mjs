// The storyteller's stories, one file per story under .brain/storyteller/.
//
// A story is the whole exchange between the agent and the storyteller: round after round of
// question and answer, kept whole in one file so a follow-up carries everything that was said.
// The agent never sees the path — only the `thread` marker (st-…); the file is provenance and
// backing, and the shelf carries the exchange itself. The format is strict on purpose: the
// writer and the reader below are the same code path, and a file that does not parse is a story
// that cannot be continued, said as such — never guessed at.
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The marker the agent passes as `thread`. It carries no path and no meaning beyond identity. */
export const STORY_ID = /^st-\d{8}-\d{6}-[a-z0-9]{4}$/;
const SCHEMA_LINE = "<!-- storyteller v1 -->";
const TITLE = "The storyteller — one long problem, kept whole";

export class StoryError extends Error {}

const pad = (value, width = 2) => String(value).padStart(width, "0");
const stampFor = (at) => {
	const date = new Date(at);
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
};

/** A fresh thread marker for a new story, e.g. st-20261115-143022-k7q2. */
export const newStoryId = (at) => `st-${stampFor(at)}-${randomInt(0, 36 ** 4).toString(36).padStart(4, "0")}`;

/** Where the story lives. Never handed to the agent: the thread is the address. */
export const storyPath = (brainDir, id) => {
	if (!STORY_ID.test(String(id ?? ""))) throw new StoryError(`Not a thread the storyteller minted: ${String(id ?? "")}`);
	return join(brainDir, "storyteller", `${id}.md`);
};

/** The stored file as text, or undefined when no story stands under the thread. */
export const readStory = (brainDir, id) => {
	let path;
	try {
		path = storyPath(brainDir, id);
	} catch {
		return undefined;
	}
	if (!existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
};

// ─── The fenced blocks the exchange is written in ────────────────────────────
// A payload may hold any run of backticks; its fence is always one longer (at least three), so
// no payload can close or counterfeit its own block.
const fenceFor = (payload) => {
	let longest = 0;
	for (const match of String(payload).matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
	return "`".repeat(Math.max(3, longest + 1));
};
const fenceBlock = (label, payload) => {
	const body = String(payload ?? "").replace(/\s+$/, "");
	const fence = fenceFor(body);
	return `${label}:\n${fence}text\n${body}\n${fence}`;
};
const FENCE = /^(`{3,})text$/;
const readFence = (lines, from) => {
	const match = FENCE.exec(lines[from] ?? "");
	if (match === null) throw new StoryError(`expected a fenced block after ${lines[from - 1] ?? "a label"}`);
	const fence = match[1];
	const body = [];
	for (let i = from + 1; i < lines.length; i += 1) {
		if (lines[i] === fence) return { text: body.join("\n"), next: i + 1 };
		body.push(lines[i]);
	}
	throw new StoryError(`unterminated fence after ${lines[from - 1] ?? "a label"}`);
};

const ROUND_HEADER = /^## Round (\d+) — (.+)$/;

/**
 * Parse a story file back into rounds, in order. Throws StoryError on anything that does not
 * read as a story — a hand-edited or broken file is refused, never guessed at.
 * @returns {{ rounds: { at: string, context: string, question: string, answer: string }[] }}
 */
export function parseStory(raw) {
	const lines = String(raw ?? "").split("\n");
	if (lines[0]?.trim() !== SCHEMA_LINE) throw new StoryError("the file is not a storyteller story (no v1 marker)");
	const rounds = [];
	let i = 1;
	while (i < lines.length) {
		const header = ROUND_HEADER.exec(lines[i]);
		if (header !== null) {
			const number = Number(header[1]);
			if (number !== rounds.length + 1) throw new StoryError(`round ${number} does not follow round ${rounds.length}`);
			rounds.push({ at: header[2], context: "", question: "", answer: "" });
			i += 1;
			continue;
		}
		const current = rounds.at(-1) ?? null;
		if (lines[i] === "Context:" && current !== null) {
			const value = readFence(lines, i + 1);
			current.context = value.text;
			i = value.next;
			continue;
		}
		if (lines[i] === "Question:" && current !== null) {
			const value = readFence(lines, i + 1);
			current.question = value.text;
			i = value.next;
			continue;
		}
		if (lines[i] === "Answer:" && current !== null) {
			const value = readFence(lines, i + 1);
			current.answer = value.text;
			i = value.next;
			continue;
		}
		// Provenance and decorative lines are carried, not read.
		i += 1;
	}
	for (const [index, round] of rounds.entries()) {
		if (round.question.trim() === "") throw new StoryError(`round ${index + 1} holds no question`);
		if (round.answer.trim() === "") throw new StoryError(`round ${index + 1} holds no answer`);
	}
	return { rounds };
}

/** The exchange, round by round, as both the file (minus its provenance header) and the shelf snapshot render it. */
export const renderRounds = (rounds, startAt = 1) => rounds.map((round, index) => [
	`## Round ${startAt + index} — ${round.at}`,
	...(round.cutOff ? [`The round broke off mid-answer: ${round.cutOff}`] : []),
	...(round.meta ? round.meta : []),
	"",
	...(round.context === "" ? [] : [fenceBlock("Context", round.context), ""]),
	fenceBlock("Question", round.question),
	"",
	fenceBlock("Answer", round.answer),
].join("\n")).join("\n\n");

/** The clean text the shelf carries: the exchange itself, with no thread to a path and no names. */
export const renderStory = (rounds) => `The storyteller\n\n${renderRounds(rounds.map(({ meta, ...round }) => round))}`;

const atomicWrite = (path, content) => {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, content, { encoding: "utf8" });
	renameSync(temp, path);
};

/**
 * Begin a story file holding its first round. Returns { id, path }. Fails loudly when no id is free.
 */
export function createStory(brainDir, { model, at, round }) {
	const dir = join(brainDir, "storyteller");
	mkdirSync(dir, { recursive: true });
	const full = (id) => [
		SCHEMA_LINE,
		TITLE,
		"",
		`Model: ${model}`,
		`Started: ${new Date(at).toISOString()}`,
		"",
		renderRounds([round]),
		"",
	].join("\n");
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const id = newStoryId(at);
		const path = storyPath(brainDir, id);
		try {
			writeFileSync(path, full(id), { encoding: "utf8", flag: "wx" });
			return { id, path };
		} catch (error) {
			if (error?.code === "EEXIST") continue;
			throw error;
		}
	}
	throw new StoryError("no free thread marker could be minted");
}

/**
 * Append a round to an existing story, atomically. Returns the round number. The file is parsed
 * first, so a broken story is refused rather than grown.
 */
export function appendRound(brainDir, id, round) {
	const path = storyPath(brainDir, id);
	const raw = readStory(brainDir, id);
	if (raw === undefined) throw new StoryError(`no story stands under thread ${id}`);
	const { rounds } = parseStory(raw);
	const number = rounds.length + 1;
	const head = raw.replace(/\s+$/, "\n\n");
	atomicWrite(path, `${head}${renderRounds([round], number)}\n`);
	return number;
}
