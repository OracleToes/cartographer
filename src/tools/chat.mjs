// The `chat` tool: how the agent tells the user something.
//
// What the model writes as plain text is its own: a note to self, shown to the user dimmed and free to be dropped
// when the context is collapsed. What it says through `chat` is the conversation with the user: it is noted as it
// is said, and a collapse keeps the last of it word for word (src/context.mjs). `chat` never waits for an answer;
// `ask` does (src/tools/ask.mjs). For the main agent a reply whose only call is `chat` ends the turn. A task that
// calls it carries on: a task ends with `return` alone.
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { noteChat } from "../context.mjs";

/** @param {{ brainDir?: string }} input */
export function chatTool({ brainDir } = {}) {
	return defineTool({
		name: "chat",
		description: [
			"Say something to the user. This is the only way they read anything from you: plain text outside this call is a note to yourself.",
			"It does not wait for an answer; to wait for one, use `ask`. For the main agent, called alone it ends the turn and the user speaks next; together with another call in the same reply, you go on working. A task that calls it carries on.",
		].join(" "),
		parameters: obj({ text: str({ description: "What the user reads. Plain sentences; no program text, which belongs in files." }) }),
		executionMode: "sequential",
		replay: "safe",
		execute: async (args, api) => {
			if (String(args.text ?? "").trim() === "") return { isError: true, output: [{ type: "text", text: "`text` is empty, so nothing was shown to the user." }] };
			if (brainDir !== undefined) noteChat(brainDir, "you", api.now(), args.text);
			// A task goes on working: it ends with `return` and nothing else.
			if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: [{ type: "text", text: "Shown to the user. You are still the task: carry on." }], details: { chat: true, task: true } };
			return {
				output: [{ type: "text", text: "Shown to the user." }],
				details: { chat: true },
				// Alone in a reply, this ends the turn: the user speaks next.
				control: { terminate: true },
			};
		},
	});
}
