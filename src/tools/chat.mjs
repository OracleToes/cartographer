// The `chat` tool: how the agent tells the user something.
//
// What the model writes as plain text is its own: a note to self, shown to the user dimmed and free to be dropped
// when the context is collapsed. What it says through `chat` is the conversation with the user: it is noted as it
// is said, and a collapse keeps the last of it word for word (src/context.mjs). `chat` never waits for an answer;
// `ask` does (src/tools/ask.mjs). `chat` never ends the turn; only `sleep` rests the main agent. A task that
// calls it carries on: a task ends with `return` alone.
import { POLICY } from "../config.mjs";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { noteChat } from "../context.mjs";
import { USER_NAME } from "../user.mjs";

/** @param {{ brainDir?: string }} input */
export function chatTool({ brainDir } = {}) {
	return defineTool({
		name: "chat",
		description: [
			`Say something to ${USER_NAME}. This is the only way they read anything from me: plain text outside this call is a note to myself.`,
			`It does not wait for an answer and never ends the turn. I keep working after sending a message; only \`sleep\` rests the main agent. I use \`ask\` when I need ${USER_NAME}'s answer before I can continue. A task that calls it carries on too.`,
		].join(" "),
		parameters: obj({ text: str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: `What ${USER_NAME} reads. Plain sentences; no program text, which belongs in files.` }) }),
		executionMode: "sequential",
		replay: POLICY.enums.toolReplay.safe,
		execute: async (args, api) => {
			if (String(args.text ?? "").trim() === "") return { isError: true, output: [{ type: "text", text: `\`text\` is empty, so nothing was shown to ${USER_NAME}.` }] };
			if (brainDir !== undefined) noteChat(brainDir, "you", api.now(), args.text);
			// A task goes on working: it ends with `return` and nothing else.
			if (api.conversationId !== ROOT_CONVERSATION_ID) return { output: [{ type: "text", text: `Shown to ${USER_NAME}. I am still the task: I carry on.` }], details: { chat: true, task: true } };
			return {
				output: [{ type: "text", text: `Shown to ${USER_NAME}. I continue working; I call \`sleep\` only when I am ready to end my turn.` }],
				details: { chat: true },
			};
		},
	});
}
