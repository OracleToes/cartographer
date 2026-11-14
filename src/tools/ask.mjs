// The `ask` tool: a question to the user that the agent waits on.
//
// `chat` tells the user something and never waits. `ask` is for the moment the agent cannot go on without an
// answer: the call returns when the user has typed one, and their words are its result. With `choices` the user
// can answer with a number; they can always type something else instead. The main agent and a task both have it.
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { noteChat } from "../context.mjs";

const fail = (text, details) => ({ isError: true, output: [{ type: "text", text }], ...(details ? { details } : {}) });

/** A span of minutes in words; part of a minute in seconds. */
export const spanOf = (minutes) => (minutes < 1 ? `${Math.round(minutes * 60)} seconds` : minutes === 1 ? "a minute" : `${minutes} minutes`);

/** The question as the user reads it and as the kept talk holds it. */
export const questionText = (text, choices = []) => [String(text).trim(), ...choices.map((choice, index) => `  ${index + 1}  ${choice}`)].join("\n");

/** @param {{ brainDir?: string, asks: ReturnType<typeof import("../asks.mjs").createAsks> }} input */
export function askTool({ brainDir, asks }) {
	return defineTool({
		name: "ask",
		description: [
			"Put a question to the user and wait for their answer, which comes back as the result. Use it when you cannot go on without it; to tell the user something, use `chat`, which does not wait.",
			"With `choices`, the user can pick one by its number; they can also type an answer of their own.",
		].join(" "),
		parameters: obj({
			text: str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: "The question, as the user reads it. One question, in plain sentences." }),
			choices: opt(arr(str({ minLength: POLICY.validation.nonEmptyStringMinLength }), { minItems: POLICY.limits.askChoices.min, maxItems: POLICY.limits.askChoices.max, description: "A few short answers to pick from. Leave out when the answer is open." })),
		}),
		executionMode: "sequential",
		// After a restart the question is put again, unless it was answered before.
		replay: POLICY.enums.toolReplay.safe,
		execute: async (args, api, callContext) => {
			const text = String(args.text ?? "").trim();
			if (text === "") return fail("`text` is empty, so nothing was asked.");
			const choices = (Array.isArray(args.choices) ? args.choices : []).map((choice) => String(choice).trim()).filter((choice) => choice !== "").slice(0, POLICY.limits.askChoices.max);
			const task = api.conversationId !== ROOT_CONVERSATION_ID;
			let outcome = await api.memo("answer", callContext);
			if (outcome === undefined) {
				if (brainDir !== undefined) noteChat(brainDir, "you", api.now(), questionText(text, choices));
				outcome = await asks.put({ text, choices, task }, callContext.abortSignal);
				if (outcome.kind === "stopped") return fail("The user stopped this before answering.", { ask: { text, choices, outcome } });
				await api.memo("answer", outcome, callContext);
				if (outcome.kind === "answer" && brainDir !== undefined) noteChat(brainDir, "user", Date.now(), outcome.text, { seen: false });
			}
			const details = { ask: { text, choices, outcome } };
			if (outcome.kind === "answer") return { output: [{ type: "text", text: `The user answered: ${outcome.text}` }], details };
			const why = outcome.kind === "timeout" ? `the user did not answer within ${spanOf(outcome.minutes)}` : "nobody is at the terminal: its input has ended";
			return {
				output: [{ type: "text", text: `No answer: ${why}. The question stays on their screen. Go on with what you can decide yourself and say what you assumed${task ? " in your report" : ""}, or leave the matter open.` }],
				details,
			};
		},
	});
}
