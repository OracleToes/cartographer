// The `assess` tool: the main agent writes its assessment of the project (src/assessment.mjs).
import { defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { ASSESSMENT_MAX, assessmentPath, saveAssessment } from "../assessment.mjs";
import { noteAssessed } from "../top.mjs";

/** @param {{ brainDir: string }} input */
export function assessTool({ brainDir }) {
	return defineTool({
		name: "assess",
		description: [
			"Write your assessment of this project: your own summary, addressed to yourself. What the project is, how it is built and run, what state it is in, and what matters most when changing it.",
			"It is shown to you at the top of your context in every session, so it is the first thing you know about the project when everything else is gone. This call replaces it whole.",
			"Rewrite it when your picture of the project changes, and before you close a goal whose work changed it.",
		].join(" "),
		parameters: obj({
			text: str({ description: `The whole assessment: a few short paragraphs, at most ${ASSESSMENT_MAX} characters.` }),
		}),
		executionMode: "sequential",
		// Safe to run again after a crash: writing the same text twice changes nothing.
		replay: "safe",
		execute: async (args) => {
			const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
			const text = typeof args.text === "string" ? args.text.trim() : "";
			if (text === "") return fail("`text` is empty. Write the assessment: what the project is, how it is built and run, its state, and what matters when changing it.");
			if (text.length > ASSESSMENT_MAX) return fail(`The assessment is ${text.length} characters; the limit is ${ASSESSMENT_MAX}. Keep what you would need first with an empty context; details belong in nodes of the atlas.`);
			saveAssessment(brainDir, text);
			noteAssessed(brainDir, text);
			return {
				output: [
					{
						type: "text",
						text: `Assessment saved (${text.length} characters) to ${assessmentPath(brainDir)}. The copy at the top of your context is replaced when a goal closes or a fresh context starts; until then this call is the text that counts.`,
					},
				],
				details: { shown: [`assessment written, ${text.length} characters`] },
			};
		},
	});
}
