// The question the agent has put to the user with `ask` (src/tools/ask.mjs) and is waiting on.
//
// There is one at a time: tasks run one after the other, and a call of `ask` does not return before it is
// answered. The screen shows the question and hands over what the user types; a number picks a choice.

/** @param {{ config?: { askMinutes?: number } }} input */
export function createAsks({ config = {} } = {}) {
	const listeners = new Set();
	let pending;
	let serial = 0;
	const emit = (event) => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				// The screen's trouble is not the question's.
			}
		}
	};
	const settle = (outcome) => {
		if (pending === undefined) return false;
		const { resolve, timer, question, unbind } = pending;
		pending = undefined;
		clearTimeout(timer);
		unbind?.();
		resolve(outcome);
		emit({ type: "settled", question, outcome });
		return true;
	};
	return {
		/** `listener` hears { type: "asked", question } and { type: "settled", question, outcome }. */
		on(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** The question that waits: { id, text, choices, task, since }, or undefined. */
		pending: () => pending?.question,
		/**
		 * Put a question and wait for what becomes of it.
		 * @param {{ text: string, choices?: string[], task?: boolean }} input
		 * @param {AbortSignal} [signal]  the run was stopped
		 * @returns {Promise<{ kind: "answer", text: string, choice?: number } | { kind: "absent" } | { kind: "timeout", minutes: number } | { kind: "stopped" }>}
		 */
		put({ text, choices = [], task = false }, signal) {
			// A question that was still waiting has lost its asker.
			settle({ kind: "stopped" });
			return new Promise((resolve) => {
				const question = { id: ++serial, text, choices, task, since: Date.now() };
				const minutes = Number(config.askMinutes) > 0 ? Number(config.askMinutes) : 0;
				const timer = minutes > 0 ? setTimeout(() => settle({ kind: "timeout", minutes }), minutes * 60_000) : undefined;
				timer?.unref?.();
				const onAbort = () => settle({ kind: "stopped" });
				signal?.addEventListener?.("abort", onAbort, { once: true });
				pending = { resolve, timer, question, unbind: () => signal?.removeEventListener?.("abort", onAbort) };
				if (signal?.aborted) return void settle({ kind: "stopped" });
				emit({ type: "asked", question });
			});
		},
		/**
		 * What the user typed. A number that names a choice stands for that choice; anything else is the answer as typed.
		 * @returns {boolean} whether a question was waiting
		 */
		answer(typed) {
			if (pending === undefined) return false;
			const said = String(typed ?? "").trim();
			if (said === "") return false;
			const { choices } = pending.question;
			const pick = /^\d+$/.test(said) ? Number(said) : 0;
			if (pick >= 1 && pick <= choices.length) return settle({ kind: "answer", text: choices[pick - 1], choice: pick });
			return settle({ kind: "answer", text: said });
		},
		/** Nobody can answer: the input has ended. */
		absent: () => settle({ kind: "absent" }),
		/** The asker is gone. */
		drop: () => settle({ kind: "stopped" }),
	};
}
