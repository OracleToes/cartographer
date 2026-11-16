// The `wake` and `sleep` tools: how the main agent comes back to something (src/wakes.mjs), and how it rests.
import { POLICY } from "../config.mjs";
import { defineTool } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { took } from "../time.mjs";
import { EVERY_MAX, NOTE_MAX, wakeAbout, WakeError, wakeRepeats } from "../wakes.mjs";
import { takeWarnings } from "../warnings.mjs";
import { USER_NAME } from "../user.mjs";

/** @param {{ wakes: ReturnType<typeof import("../wakes.mjs").createWakes>, config: { wakeMin: number, wakesMax: number } }} input */
export function wakeTool({ wakes, config }) {
	const least = took(config.wakeMin * 1000);
	// Keep one flat object at the root for chat templates, but use `if`/`then` constraints to require each
	// action's fields and reject fields that belong to the other action. The root never branches between shapes.
	const Parameters = obj(
		{
			action: oneOf(POLICY.enums.wakeActions, { description: "set: set a wake, with `note` and exactly one trigger. remove: take one back, with `id`." }),
			note: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: "\\S", description: `For set, required: what to look at or do when it fires, written for myself. One line, at most ${NOTE_MAX} characters (an over-long note is clipped, and the result says so).` })),
			every: opt(int({ minimum: config.wakeMin, maximum: EVERY_MAX, description: `For set: a number of seconds, ${config.wakeMin} or more. Alone: wake after this long, and again each time it passes. With path or window: the least time between two wakes, default ${config.wakeMin}.` })),
			times: opt(int({ minimum: POLICY.limits.wake.timesMin, description: `For set: how often it fires before it is removed. Default ${POLICY.limits.wake.timesDefault}. ${POLICY.limits.wake.timesMin}: until I remove it.` })),
			path: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, description: "For set: wake when this file changes, or any file under this folder. A path inside the project; one that does not exist yet wakes me when it appears." })),
			window: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, description: "For set: wake when this shell window prints something." })),
			match: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, description: "For set, with window: only a line that contains this text counts, such as ERROR." })),
			id: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, pattern: POLICY.patterns.wakeIdOrAll, description: "For remove, required: the wake (w2), or all." })),
		},
		{
			allOf: [
				{
					if: { properties: { action: { const: POLICY.enums.actions.set } }, required: ["action"] },
					then: {
						required: ["note"],
						anyOf: [
							{ required: ["every"], not: { anyOf: [{ required: ["path"] }, { required: ["window"] }] } },
							{ required: ["path"], not: { required: ["window"] } },
							{ required: ["window"], not: { required: ["path"] } },
						],
						not: { required: ["id"] },
					},
				},
				{
					if: { properties: { action: { const: POLICY.enums.actions.set }, match: {} }, required: ["action", "match"] },
					then: { required: ["window"] },
				},
				{
					if: { properties: { action: { const: POLICY.enums.actions.remove } }, required: ["action"] },
					then: { required: ["id"], not: { anyOf: [{ required: ["note"] }, { required: ["every"] }, { required: ["times"] }, { required: ["path"] }, { required: ["window"] }, { required: ["match"] }] } },
				},
			],
		},
	);
	return defineTool({
		name: "wake",
		description: [
			"Be woken later: after a time, when a file changes, or when a shell window prints something.",
			'For example {"action":"set","note":"see whether the build is through","every":300} wakes me once in five minutes, and with "times":0 every five minutes.',
			"A wake does not make me wait. I set it and go on working, or end my turn: when it fires while I rest, a turn starts for me with my note; when it fires while I work, the state block shows it.",
			`My wakes are listed in the state block. Each firing costs a whole turn, so long intervals are better: ${least} is the least. Several wakes can be set at once, ${config.wakesMax} at most.`,
			"With `times` 0 a wake repeats until I remove it, which is how I watch over something that keeps running. When a wake finds nothing to do, I call `sleep`.",
		].join(" "),
		parameters: Parameters,
		executionMode: "sequential",
		// Not run a second time after a crash: the wake is in the file by then, and a second call would set another.
		replay: POLICY.enums.toolReplay.never,
		execute: async (args) => {
			const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
			try {
				if (args.action === POLICY.enums.actions.set) {
					takeWarnings(); // drop anything raised before this call started
					const wake = wakes.set(args);
					const about = `${wakeAbout(wake)}, ${wakeRepeats(wake)}`;
					const first = wake.kind === POLICY.enums.wakeKinds.time ? ` It first fires in ${took(wake.every * 1000)}.` : "";
					const notes = takeWarnings();
					const said = `${wake.id} set: ${about}.${first} I am not waiting for it: I go on with other work, or end my turn. \`wake\` with remove and ${wake.id} takes it back.${notes.length > 0 ? `\n\n${notes.map((note) => `note: ${note}`).join("\n")}` : ""}`;
					return {
						output: [{ type: "text", text: said }],
						details: { shown: [`+ ${wake.id} ${about} · ${wake.note}`] },
					};
				}
				if (args.action === POLICY.enums.actions.remove) {
					const id = typeof args.id === "string" ? args.id.trim() : "";
					if (id === "") return fail(`remove needs \`id\`: the wake to take back, or all. ${wakes.list().length === 0 ? "No wake is set." : `Set: ${wakes.list().map((wake) => wake.id).join(", ")}.`}`);
					const gone = wakes.remove(id);
					return { output: [{ type: "text", text: `Removed: ${gone.map((wake) => wake.id).join(", ")}.` }], details: { shown: gone.map((wake) => `- ${wake.id} ${wakeAbout(wake)} · ${wake.note}`) } };
				}
				return fail("`action` is set or remove.");
			} catch (problem) {
				if (!(problem instanceof WakeError)) throw problem;
				return fail(problem.message);
			}
		},
	});
}

/** What `sleep` answers. The run ends with it, so the model does not read this; it stands in the stored conversation. */
export const RESTING = POLICY.control.restingMessage;

/** @param {{ wakes: ReturnType<typeof import("../wakes.mjs").createWakes> }} input */
export function sleepTool({ wakes }) {
	return defineTool({
		name: "sleep",
		description: [
			`End my turn and rest. I am woken by ${USER_NAME}'s next message, by a wake I set, and when a command ends or asks for input in a shell window.`,
			"Call it alone, with no text, when a wake found nothing that needs me. A turn in which I called nothing but `sleep` is taken out of my context when the next wake comes, so a hundred quiet wakes cost no context.",
			"So when such a turn found something worth keeping, I record it in the ledger before I sleep: a turn in which I used another tool stays.",
		].join(" "),
		parameters: obj({}),
		executionMode: "sequential",
		replay: POLICY.enums.toolReplay.safe,
		execute: async () => {
			const due = wakes.nextDue();
			return {
				output: [{ type: "text", text: RESTING }],
				details: { shown: [`resting${due === undefined ? "" : ` · next wake in ${took(due)}`}`] },
				// No further request: the turn is over.
				control: { ...POLICY.control.terminate },
			};
		},
	});
}
