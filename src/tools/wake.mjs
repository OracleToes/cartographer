// The `wake` and `sleep` tools: how the main agent comes back to something (src/wakes.mjs), and how it rests.
import { POLICY } from "../config.mjs";
import { defineTool } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { took } from "../time.mjs";
import { EVERY_MAX, NOTE_MAX, wakeAbout, WakeError, wakeRepeats } from "../wakes.mjs";

/** @param {{ wakes: ReturnType<typeof import("../wakes.mjs").createWakes>, config: { wakeMin: number, wakesMax: number } }} input */
export function wakeTool({ wakes, config }) {
	const least = took(config.wakeMin * 1000);
	// Keep one flat object at the root for chat templates, but use `if`/`then` constraints to require each
	// action's fields and reject fields that belong to the other action. The root never branches between shapes.
	const Parameters = obj(
		{
			action: oneOf(POLICY.enums.wakeActions, { description: "set: set a wake, with `note` and exactly one trigger. remove: take one back, with `id`." }),
			note: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, maxLength: NOTE_MAX, pattern: "\\S", description: `For set, required: what to look at or do when it fires, written for yourself. One line, at most ${NOTE_MAX} characters.` })),
			every: opt(int({ minimum: config.wakeMin, maximum: EVERY_MAX, description: `For set: a number of seconds, ${config.wakeMin} or more. Alone: wake after this long, and again each time it passes. With path or window: the least time between two wakes, default ${config.wakeMin}.` })),
			times: opt(int({ minimum: POLICY.limits.wake.timesMin, description: `For set: how often it fires before it is removed. Default ${POLICY.limits.wake.timesDefault}. ${POLICY.limits.wake.timesMin}: until you remove it.` })),
			path: opt(str({ minLength: POLICY.validation.nonEmptyStringMinLength, description: "For set: wake when this file changes, or any file under this folder. A path inside the project; one that does not exist yet wakes you when it appears." })),
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
			"Have yourself woken later: after a time, when a file changes, or when a shell window prints something.",
			'For example {"action":"set","note":"see whether the build is through","every":300} wakes you once in five minutes, and with "times":0 every five minutes.',
			"A wake does not make you wait. Set it and go on working, or end your turn: when it fires while you rest, Cartographer starts a turn for you with your note; when it fires while you work, the state block shows it.",
			`Your wakes are listed in the state block. Each firing costs a whole turn, so choose long intervals: ${least} is the least. Several wakes can be set at once, ${config.wakesMax} at most.`,
			"With `times` 0 a wake repeats until you remove it, which is how you watch over something that keeps running. When a wake finds nothing to do, call `sleep`.",
		].join(" "),
		parameters: Parameters,
		executionMode: "sequential",
		// Not run a second time after a crash: the wake is in the file by then, and a second call would set another.
		replay: POLICY.enums.toolReplay.never,
		execute: async (args) => {
			const fail = (text) => ({ isError: true, output: [{ type: "text", text }] });
			try {
				if (args.action === POLICY.enums.actions.set) {
					const wake = wakes.set(args);
					const about = `${wakeAbout(wake)}, ${wakeRepeats(wake)}`;
					const first = wake.kind === POLICY.enums.wakeKinds.time ? ` It first fires in ${took(wake.every * 1000)}.` : "";
					return {
						output: [{ type: "text", text: `${wake.id} set: ${about}.${first} You are not waiting for it: go on with other work, or end your turn. \`wake\` with remove and ${wake.id} takes it back.` }],
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
			"End your turn and rest. You are woken by the user's next message, by a wake you set, and when a command ends or asks for input in a shell window.",
			"Call it alone, with no text, when a wake found nothing that needs you. A turn in which you called nothing but `sleep` is taken out of your context when the next wake comes, so a hundred quiet wakes cost no context.",
			"So when such a turn found something worth keeping, record it in the ledger before you sleep: a turn in which you used another tool stays.",
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
