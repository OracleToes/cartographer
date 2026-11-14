// A stand-in for the model server, for the tests. It is NOT a model: it does what
// the newest message tells it in a small fixed language, so a test decides exactly
// what "the model" does and the result does not depend on a model behaving.
//
// As the main agent it obeys the newest user message. Parts are separated by " || ";
// tool calls among them are made together in one turn:
//   say: TEXT            answer TEXT
//   task: BRIEF          call `task` with BRIEF; when the report is back, answer "Report received: <report>"
//   task(p2): BRIEF      the same for plan item p2
//   look: DIRECTIVE      call a look or change tool itself (the harness should refuse it)
//   ledger: [OPS]        call `ledger` with these operations, written as JSON; then answer as after a task
//   plan: [OPS]          the same with `plan`
//   atlas: [OPS]         the same with `atlas`
//   assess: TEXT         call `assess` with TEXT
//   cut                  start a `task` call and run into the output limit in the middle of it
//   context: {JSON}      call `context` with these arguments (a task can, too)
//   ON COLLAPSE: DIRECTIVE   planted: asked before a collapse, it answers that it wants a turn first, and in that
//                        turn it does DIRECTIVE. Without it the answer is no.
//   AFTER COLLAPSE: DIRECTIVE  planted: what it does when a collapse came in the middle of its turn
//
// A request that is not streamed is one of Cartographer's own (src/engine.mjs): the question before a collapse,
// or the read-ahead after one. Those are kept in `asides`, not in `requests`.
//
// As a task (the newest message begins "You are now the task") it obeys the brief,
// one line per turn:
//   read: a.js, b.js   |  read: a.js @40+20   (from line 40, 20 lines)
//   search: PATTERN    |  search: PATTERN in src
//   list: PATH
//   write: PATH <<< TEXT           (a \n in TEXT, OLD and NEW stands for a line break)
//   shell: COMMAND                 or shell[cwd=src,timeout=2]: COMMAND
//   edit: PATH <<< OLD >>> NEW
//   atlas: [OPS]         calls `atlas` with these operations, written as JSON
//   assess: TEXT         tries to write the assessment (the harness should refuse it)
//   plan: [OPS]          tries to write the plan (the harness should refuse it)
//   task: BRIEF          tries to start a task (the harness should refuse it)
//   ledger: [OPS]        tries to write the ledger (the harness should refuse it)
//   cut                  starts a `write` call and runs into the output limit in the middle of it
//   loop                 calls `list` forever
//   note: WORDS          writes WORDS as plain text and calls nothing (a note to self)
//   chat: WORDS          says WORDS to the user with `chat`
//   ask: QUESTION | A | B   puts QUESTION to the user with `ask`, with the choices A and B when given
//   return: {JSON}       calls `return` with these arguments
//   spam: WORD           writes WORD four hundred times (as the main agent too; `spam always: WORD` does it again
//                        after being cut off)
//   babble               writes a different note in every reply and never calls anything
//   mumble               writes the same note in every reply
//   silent               writes nothing at all in every reply
//   undone               (a line of its own) the automatic `return` at the end says done false
// and then calls `return` with done true and the report "REPORT" plus the first line of every result it got.
//
// As the main agent, `babble` and `mumble` do the same; `ask: QUESTION | A | B` puts a question.
//
// Every request is kept in `requests`, so a test can check what the server was sent.
import { createServer } from "node:http";

/**
 * A message's text as it was written, without what Cartographer adds to a request (src/request.mjs): the state block
 * at the end, the copy of the assessment and the graph in front, and the times in square brackets.
 */
const rawOf = (message) => (typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => part.text ?? "").join("") : "");
const textOf = (message) => {
	const text = rawOf(message);
	return text
		.replace(/<context>\nWritten by Cartographer[\s\S]*?\n<\/context>\n*/g, "")
		.replace(/\n\n\[s\d+ · about [\d,]+ tokens\]$/g, "")
		.replace(/\n\nThis report is kept as t\d+\./g, "")
		.replace(/\n*<windows>\nWritten by Cartographer[\s\S]*?\n<\/windows>/g, "")
		.replace(/\n*<state>\nWritten by Cartographer[\s\S]*?\n<\/state>/g, "")
		.replace(/<project>\nWritten by Cartographer[\s\S]*?\n<\/project>\n*/g, "")
		.replace(/\n\n\[(sent|noted|task ended) [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}[^\]\n]*\]/g, "");
};

function lookCall(directive) {
	// shell: COMMAND, or shell[window=server,wait=0]: COMMAND
	const shell = /^shell(?:\[([^\]]*)\])?:\s*(.*)$/s.exec(directive.trim());
	if (shell) {
		const options = Object.fromEntries((shell[1] ?? "").split(",").filter(Boolean).map((pair) => pair.split("=")));
		return { name: "shell", args: { command: shell[2].replaceAll("\\n", "\n"), ...(options.window ? { window: options.window } : {}), ...(options.wait ? { wait: Number(options.wait) } : {}) } };
	}
	// window: NAME ACTION, window: repl send some text, window[seconds=5]: server wait ready, window[lines=3]: main read
	const window = /^window(?:\[([^\]]*)\])?:\s*(\S+)\s+(\S+)\s?(.*)$/s.exec(directive.trim());
	if (window) {
		const options = Object.fromEntries((window[1] ?? "").split(",").filter(Boolean).map((pair) => pair.split("=")));
		const [, , name, action, rest] = window;
		return {
			name: "shell",
			args: {
				window: name,
				action,
				...(action === "send" ? { text: rest } : {}),
				...(action === "wait" && rest !== "" ? { until: rest } : {}),
				...(options.seconds ? { seconds: Number(options.seconds) } : {}),
				...(options.lines ? { lines: Number(options.lines) } : {}),
			},
		};
	}
	const [, name, rest] = /^(read|search|list|write|edit|task|ledger|plan|atlas|assess|wake|sleep|chat|ask|return|context|prompt|loop|silent)\b:?\s*(.*)$/s.exec(directive.trim()) ?? [];
	const breaks = (text) => text.replaceAll("\\n", "\n");
	if (name === "write") {
		const [path, content = ""] = rest.split(" <<< ");
		return { name: "write", args: { path: path.trim(), content: breaks(content) } };
	}
	if (name === "edit") {
		const [path, change = ""] = rest.split(" <<< ");
		const [oldText, newText = ""] = change.split(" >>> ");
		return { name: "edit", args: { path: path.trim(), old_text: breaks(oldText), new_text: breaks(newText) } };
	}
	// The book tools of old keep their test-facing directive spellings; they go out as the one `book` tool.
	if (name === "plan" || name === "atlas") return name === "atlas" ? { name, args: { ops: JSON.parse(rest) } } : { name: "book", args: { book: "plan", ops: JSON.parse(rest) } };
	if (name === "assess") return { name: "book", args: { book: "books", text: breaks(rest) } };
	// wake: {"action":"set","note":"look at the log","every":60}
	if (name === "wake") return { name: "wake", args: JSON.parse(rest) };
	// context: {"action":"shelve","path":"a.txt"}
	if (name === "context") return { name: "book", args: { book: "context", ops: [JSON.parse(rest)] } };
	if (name === "sleep") return { name: "sleep", args: {} };
	if (name === "chat") return { name: "chat", args: { text: rest } };
	if (name === "ask") {
		const [text, ...choices] = rest.split(" | ").map((part) => part.trim());
		return { name: "ask", args: { text, ...(choices.length > 0 ? { choices } : {}) } };
	}
	if (name === "return") return { name: "return", args: JSON.parse(rest) };
	if (name === "read") {
		const [, paths, offset, limit] = /^(.*?)(?:\s+@(\d+)(?:\+(\d+))?)?$/.exec(rest);
		return {
			name: "read",
			args: { paths: paths.split(",").map((path) => path.trim()), ...(offset ? { offset: Number(offset) } : {}), ...(limit ? { limit: Number(limit) } : {}) },
		};
	}
	if (name === "search") {
		const [, pattern, path] = /^(.*?)(?:\s+in\s+(\S+))?$/.exec(rest);
		return { name: "search", args: { pattern, ...(path ? { path } : {}) } };
	}
	if (name === "list") return { name: "list", args: rest === "" ? {} : { path: rest } };
	if (name === "task") return { name: "task", args: { brief: rest } };
	if (name === "ledger") return { name: "book", args: { book: "ledger", ops: JSON.parse(rest) } };
	if (name === "loop") return { name: "list", args: {} };
	return undefined;
}

/** The calls a message of the user asks the main agent for: its directives, joined by ` || `. */
function mainCalls(text) {
	const calls = [];
	for (const part of text.split(" || ").map((entry) => entry.trim())) {
		const task = /^task(?:\((\w+)\))?:(.*)$/s.exec(part);
		// A \n in the brief is a line break, a \\n stays a \n for the task's own directives.
		if (task) calls.push({ name: "task", args: { brief: task[2].trim().replaceAll(/(?<!\\)\\n/g, "\n").replaceAll("\\\\n", "\\n"), ...(task[1] ? { item: task[1] } : {}) } });
		else if (part.startsWith("look:")) calls.push(lookCall(part.slice(5)));
		else if (/^(ledger|plan|atlas|assess|window|wake|context|ask|return)[:[]/.test(part)) calls.push(lookCall(part));
		else if (part === "sleep") calls.push({ name: "sleep", args: {} });
	}
	return calls.filter((call) => call !== undefined);
}

/** How the line begins that follows a reply without a tool call (src/wake.mjs). */
const NOTED = "<cartographer>\nWritten by Cartographer, not by the user. Your last message had no tool call.";

/** What the stand-in does next, from the messages it was sent. */
export function decide(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const text = textOf(message);
		const later = messages.slice(i + 1);
		const raw = rawOf(message);
		// A task that said yes to the question before its steps collapse: it notes what its results began with.
		if (message.role === "user" && raw.includes("Your steps will be collapsed after this reply")) {
			const found = messages.slice(0, i).filter((entry) => entry.role === "tool").map((entry) => textOf(entry).split("\n")[0]);
			return { calls: [{ name: "book", args: { book: "context", ops: [{ action: "note", text: `NOTED ${found.slice(-3).join(" | ")}` }] } }] };
		}
		// What follows a note inside a task is not a message to obey: the brief goes on.
		if (message.role === "user" && text.startsWith(NOTED) && messages.some((entry) => entry.role === "tool" && textOf(entry).startsWith("You are now the task"))) continue;
		// The block that stands for a task's collapsed steps is not a message to obey.
		if (message.role === "user" && /steps up to here \(\d+ repl/.test(raw)) continue;
		if (message.role === "tool" && text.startsWith("You are now the task")) {
			const given = text
				.slice(text.indexOf("Brief:\n") + 7)
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "" && !line.startsWith("ON COLLAPSE"));
			const undone = given.includes("undone");
			const lines = given.filter((line) => line !== "undone");
			// Replies that a collapse took out of view still count: the brief goes on where it was.
			const collapsed = later.map((entry) => /steps up to here \((\d+) repl/.exec(entry.role === "user" ? rawOf(entry) : "")?.[1]).find((found) => found !== undefined);
			const turns = later.filter((entry) => entry.role === "assistant").length + Number(collapsed ?? 0);
			if (lines.includes("loop")) return { calls: [lookCall("loop")] };
			if (lines.includes("silent")) return { text: "" };
			if (lines.includes("babble")) return { text: `Babble ${turns + 1}.` };
			if (lines.includes("mumble")) return { text: "Mumble." };
			if (turns < lines.length && lines[turns].startsWith("spam:")) return { text: `${lines[turns].slice(5).trim()} `.repeat(400) };
			if (turns < lines.length && lines[turns].startsWith("note:")) return { text: lines[turns].slice(5).trim() };
			if (lines[turns] === "cut") return { calls: [{ name: "write", args: { path: "cut-off.txt", content: "text ".repeat(60) } }], cut: true };
			if (turns < lines.length) {
				// `saying WORDS >> directive`: text and a call in one reply. Several directives joined by ` +++ ` are several calls.
				const [, words, rest] = /^saying (.*?) >> (.*)$/.exec(lines[turns]) ?? [undefined, undefined, lines[turns]];
				const calls = rest.split(" +++ ").map(lookCall).filter((call) => call !== undefined);
				if (calls.length > 0) return { calls, ...(words !== undefined ? { say: words } : {}) };
			}
			const results = later.filter((entry) => entry.role === "tool").map((entry) => textOf(entry).split("\n")[0]);
			return { calls: [{ name: "return", args: { report: `REPORT\n${results.join("\n")}`, done: !undone } }] };
		}
		if (message.role === "user") {
			// The main agent speaks to the user with `chat`; plain text is its own.
			const chat = (said) => ({ calls: [{ name: "chat", args: { text: said } }] });
			const results = later.filter((entry) => entry.role === "tool");
			// A collapse in the middle of the turn: the context begins with the front block and nothing follows it yet.
			if (raw.includes("<context>\nWritten by Cartographer") && text.trim() === "" && results.length === 0) {
				const [, after] = /AFTER COLLAPSE: (.*?)(?:\s+ON COLLAPSE:|$)/m.exec(raw) ?? [];
				if (after?.startsWith("chat:")) return chat(after.slice(5).trim());
				const calls = after === undefined ? [] : mainCalls(after);
				return calls.length > 0 ? { calls } : chat("Collapsed, going on.");
			}
			// Told in a tool result that the collapse comes after the next reply: do what was planted for it.
			const newest = later.slice(later.findLastIndex((entry) => entry.role === "assistant") + 1).filter((entry) => entry.role === "tool");
			if (newest.some((entry) => rawOf(entry).includes("your context will be collapsed after your next reply"))) {
				const [, planted] = /ON COLLAPSE: (.*?)(?:\s+AFTER COLLAPSE:|$)/m.exec(text) ?? [];
				const calls = planted === undefined ? [] : mainCalls(planted);
				if (calls.length > 0) return { calls };
			}
			// `again: directives`: the same calls in every reply, whatever came back.
			if (text.startsWith("again: ")) return { calls: mainCalls(text.slice(7)) };
			// `|| then think` beside directives, also planted ones: after their results, plain text and no call.
			const thinkAfter = text.startsWith("<cartographer>")
				? /ON (EVERY )?WAKE: .*\|\| then think\b/m.test(messages.slice(0, i).filter((entry) => entry.role === "user").map(textOf).join("\n"))
				: /\|\| then think\b/.test(text);
			if (results.length > 0 && thinkAfter) return { text: "Noted for myself." };
			if (results.length > 0) return chat(`Report received: ${results.map(textOf).join(" ++ ")}`);
			// The note that follows a reply without a call. `think then chat: WORDS` in the message before it: say them now.
			if (text.startsWith(NOTED)) {
				const before = messages.slice(0, i).filter((entry) => entry.role === "user" && !textOf(entry).startsWith(NOTED)).map(textOf).at(-1) ?? "";
				const [, words] = /think then chat: (.*)$/m.exec(before) ?? [];
				if (words !== undefined) return chat(words);
				const replies = messages.slice(messages.findLastIndex((entry) => entry.role === "user" && !textOf(entry).startsWith(NOTED))).filter((entry) => entry.role === "assistant").length;
				if (/^babble\b/m.test(before)) return { text: `Babble ${replies + 1}.` };
				if (/^mumble\b/m.test(before)) return { text: "Mumble." };
				// A note was written and nothing is left to do: rest.
				return { calls: [{ name: "sleep", args: {} }] };
			}
			// A note Cartographer wrote to wake the agent: say what it said, or do what the test planted for this moment.
			// `ON WAKE: directive` in an earlier message of the user is carried out at the first note, `ON EVERY WAKE:` at each.
			// The turn it asked for before a collapse while resting: do what was planted for it.
			if (text.startsWith("<cartographer>") && text.includes("Your context will be collapsed when this turn ends")) {
				const [, planted] = /ON COLLAPSE: (.*?)(?:\s+AFTER COLLAPSE:|$)/m.exec(messages.slice(0, i).filter((entry) => entry.role === "user").map(textOf).join("\n")) ?? [];
				const calls = planted === undefined ? [] : mainCalls(planted);
				return calls.length > 0 ? { calls } : { text: "Nothing to write down." };
			}
			// A reply was cut off because it repeated itself: `spam always:` does it again, anything else recovers.
			if (text.startsWith("<cartographer>") && text.includes("was cut off, because it was writing the same text over and over")) {
				const before = messages.slice(0, i).filter((entry) => entry.role === "user" && !textOf(entry).startsWith("<cartographer>")).map(textOf).at(-1) ?? "";
				const [, word] = /^spam always: (.*)$/m.exec(before) ?? [];
				return word !== undefined ? { text: `${word} `.repeat(400) } : chat("Recovered.");
			}
			if (text.startsWith("<cartographer>")) {
				const told = text.split("\n").slice(3, -3).join(" / ");
				const earlier = messages.slice(0, i).filter((entry) => entry.role === "user").map(textOf);
				const [, every, planted] = /ON (EVERY )?WAKE: (.*)$/m.exec(earlier.join("\n")) ?? [];
				if (planted !== undefined && (every !== undefined || !earlier.some((entry) => entry.startsWith("<cartographer>")))) {
					const calls = mainCalls(planted);
					if (calls.length > 0) return { calls };
				}
				return { text: `Woken: ${told}` };
			}
			// What a test planted for a collapse is not part of what to do now.
			const now = text.replace(/\s*(?:ON|AFTER) COLLAPSE: .*$/gm, "");
			// `spam: WORD` and `spam always: WORD`: the same word over and over, as a model that has lost its way writes.
			const spam = /^spam(?: always)?: (.*)$/.exec(now.trim());
			if (spam) return { text: `${spam[1]} `.repeat(400) };
			if (text.trim() === "cut") return { calls: [{ name: "task", args: { brief: "a brief that is never finished ".repeat(20) } }], cut: true };
			const parts = now.split(" || ").map((part) => part.trim());
			// `reason: WORDS`: the model's reasoning, sent in front of whatever else the reply holds.
			const reason = parts.find((part) => part.startsWith("reason:"))?.slice(7).trim();
			const also = reason === undefined ? {} : { reason };
			const calls = mainCalls(now);
			// `chat: WORDS` beside other directives: said in the same reply as their calls.
			const beside = parts.find((part) => part.startsWith("chat:"));
			if (calls.length > 0) return { calls: [...(beside ? chat(beside.slice(5).trim()).calls : []), ...calls], ...also };
			// `think: WORDS` and `think then chat: WORDS`: plain text and no call.
			if (now.trim() === "babble") return { text: "Babble 1." };
			if (now.trim() === "mumble") return { text: "Mumble." };
			const think = parts.find((part) => /^think(?: then chat)?:/.test(part));
			if (think !== undefined) return { text: think.slice(think.indexOf(":") + 1).trim(), ...also };
			const say = parts.find((part) => part.startsWith("say:"));
			return { ...chat(say ? say.slice(4).trim() : "OK"), ...also };
		}
	}
	return { text: "OK" };
}

/**
 * @param {{ tokenDelayMs?: number, models?: (string | object)[], holdWhen?: (body: any) => boolean, refuseAsides?: boolean, refuseSchema?: boolean, asideDelayMs?: number }} options
 *   progress: { total, cache, steps, stepMs }: before each reply, say in `steps` steps how far the prompt is read.
 *   refuseSchema: answer 400 to a request that names the shape of its answer, as llama.cpp does with some chat templates.
 *   refuseAsides: answer Cartographer's own requests with an error, as a server would that cannot take them.
 *   models: what GET /models lists; a name, or a whole entry as the server would give it.
 *   holdWhen: a request for which it returns true gets its first token and then nothing more, until `release()`.
 */
export async function startStandIn(options = {}) {
	const tokenDelayMs = options.tokenDelayMs ?? 1;
	const requests = [];
	const asides = [];
	const held = [];
	let counter = 0;
	const server = createServer(async (request, response) => {
		if (request.method === "GET" && request.url?.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ object: "list", data: (options.models ?? ["stand-in"]).map((entry) => (typeof entry === "string" ? { id: entry, object: "model" } : entry)) }));
			return;
		}
		if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		// One of Cartographer's own requests: the question before a collapse (it names the reply's shape), or the
		// read-ahead after one (a single token of answer).
		if (body.stream !== true) {
			asides.push(body);
			// A server that cannot build the grammar for an answer of a given shape while tools are offered.
			if (options.refuseSchema && body.response_format !== undefined) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { code: 400, message: "Failed to initialize samplers: failed to parse grammar", type: "invalid_request_error" } }));
				return;
			}
			if (options.refuseAsides) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "Cannot use a response format with tools." } }));
				return;
			}
			if (options.asideDelayMs) await new Promise((resolve) => setTimeout(resolve, options.asideDelayMs));
			const texts = (body.messages ?? []).filter((entry) => entry.role === "user" || entry.role === "tool").map(textOf);
			// Yes when the test planted something to do before a collapse, and it stands in view.
			const wants = texts.some((entry) => /ON COLLAPSE/.test(entry));
			const content = body.response_format !== undefined || /"handoff"/.test(texts.at(-1) ?? "") ? JSON.stringify({ handoff: wants }) : "";
			const prompt = Math.ceil(JSON.stringify([body.tools, body.messages]).length / 4);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: `chatcmpl-aside-${asides.length}`, object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: prompt, completion_tokens: 1, total_tokens: prompt + 1 } }));
			return;
		}
		requests.push(body);
		const decision = decide(body.messages ?? []);
		const promptTokens = Math.ceil(JSON.stringify([body.tools, body.messages]).length / 4);

		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const id = `chatcmpl-standin-${++counter}`;
		const send = (delta, finish = null) =>
			response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
		const pause = () => new Promise((resolve) => setTimeout(resolve, tokenDelayMs));
		// A server that says how far it is with reading the prompt, as llama.cpp does when asked with return_progress.
		if (options.progress !== undefined && body.return_progress === true) {
			const { total, cache, steps = 4, stepMs = 100 } = options.progress;
			for (let step = 0; step <= steps; step++) {
				const processed = cache + Math.round(((total - cache) * step) / steps);
				response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [], prompt_progress: { total, cache, processed, time_ms: step * stepMs } })}\n\n`);
				if (step < steps) await new Promise((resolve) => setTimeout(resolve, stepMs));
			}
		}
		send({ role: "assistant", content: null });
		if (options.holdWhen?.(body)) await new Promise((resolve) => held.push(resolve));
		let generated = 0;
		for (const piece of decision.reason?.match(/\S+\s*/g) ?? []) {
			await pause();
			send({ reasoning_content: piece });
			generated += 1;
		}
		if (decision.calls !== undefined) {
			for (const piece of decision.say?.match(/\S+\s*/g) ?? []) {
				await pause();
				send({ content: piece });
				generated += 1;
			}
			for (const [index, call] of decision.calls.entries()) {
				send({ tool_calls: [{ index, id: `call_${counter}_${index}`, type: "function", function: { name: call.name, arguments: "" } }] });
				const pieces = JSON.stringify(call.args).match(/.{1,12}/gs) ?? [];
				for (const piece of decision.cut ? pieces.slice(0, pieces.length / 2) : pieces) {
					if (response.destroyed) return;
					await pause();
					send({ tool_calls: [{ index, function: { arguments: piece } }] });
					generated += 3;
				}
			}
		} else {
			for (const piece of decision.text.match(/\S+\s*/g) ?? []) {
				if (response.destroyed) return;
				await pause();
				send({ content: piece });
				generated += 1;
			}
		}
		send({}, decision.cut ? "length" : decision.calls !== undefined ? "tool_calls" : "stop");
		const usage = { prompt_tokens: promptTokens, completion_tokens: generated, total_tokens: promptTokens + generated };
		response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [], usage })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}/v1`,
		requests,
		asides,
		heldCount: () => held.length,
		release: () => {
			for (const resolve of held.splice(0)) resolve();
		},
		close: () =>
			new Promise((resolve) => {
				for (const release of held.splice(0)) release();
				server.closeAllConnections();
				server.close(resolve);
			}),
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const standIn = await startStandIn({ tokenDelayMs: Number(process.env.STANDIN_DELAY_MS ?? 15) });
	console.log(`stand-in model server at ${standIn.url} (model name "stand-in")`);
}
