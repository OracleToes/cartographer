// Stable Durable origins for the active messages that request.mjs dresses.
//
// A ContextView carries active entries beside their active contributions. Provider request order may move tool
// results beside calls, so this projection records an entry id and contribution position before request dressing
// changes messages. It never identifies an editable row from its visible text.

/** A stable source record for one Durable contribution. */
export function durableMessageSource(entry, position) {
	return {
		id: `durable:${entry.conversationId}:${entry.id}:${position}`,
		kind: "durable-message",
		conversationId: String(entry.conversationId),
		entryId: String(entry.id),
		position,
	};
}

/**
 * The active, editable-message projection of a Durable ContextView. `entries` and `contributions` are aligned by
 * Durable after omissions, replacements, and excluded assistant stops. A contribution may be empty or contain more
 * than one message. Flattening later may settle/reorder tool results or synthesize a missing result, so consumers
 * must carry this projection rather than infer identity from `entry.model` or a flattened array index.
 */
export function activeContextProjection(view) {
	return (view?.entries ?? []).map((entry, entryIndex) => ({
		entry,
		entryId: String(entry.id),
		conversationId: String(entry.conversationId),
		contributions: (view?.contributions?.[entryIndex] ?? []).map((message, position) => ({ message, source: durableMessageSource(entry, position) })),
	}));
}

/** A non-text bridge key. These are immutable Durable message facts, not visible wording. */
function keyOf(message) {
	if (message?.role === "user" && Number.isFinite(message.timestamp)) return `user:${message.timestamp}`;
	if (message?.role === "assistant" && Number.isFinite(message.timestamp)) {
		const calls = Array.isArray(message.content) ? message.content.filter((part) => part?.type === "toolCall").map((call) => call.id).join(",") : "";
		return `assistant:${message.timestamp}:${calls}`;
	}
	if (message?.role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId !== "") return `result:${message.toolCallId}`;
	return undefined;
}

/**
 * Map `messages` to the exact Durable contribution from `view`. Direct object identity is preferred. A separate
 * ContextView read gets the same immutable request ordering, so remaining user/assistant/result rows use only
 * timestamps and call ids. Synthesized result rows and any ambiguous/non-Durable row stay unmapped rather than
 * being attributed by equal words or a flattened-message position.
 * @param {readonly any[]} messages
 * @param {{ entries?: readonly any[], contributions?: readonly (readonly any[])[], messages?: readonly any[] }} view
 * @returns {(ReturnType<typeof durableMessageSource> | undefined)[]}
 */
export function bridgeRequestSources(messages, view) {
	const direct = new Map();
	for (const event of activeContextProjection(view)) for (const contribution of event.contributions) direct.set(contribution.message, contribution.source);
	const byKey = new Map();
	for (const message of view?.messages ?? []) {
		const source = direct.get(message);
		const key = keyOf(message);
		if (source === undefined || key === undefined) continue;
		const rows = byKey.get(key) ?? [];
		rows.push(source);
		byKey.set(key, rows);
	}
	return messages.map((message) => {
		const exact = direct.get(message);
		if (exact !== undefined) return exact;
		const key = keyOf(message);
		if (key === undefined) return undefined;
		const matches = byKey.get(key);
		// A copied ContextView may have two rows with the same timestamp/call signature. Do not turn their order
		// into an identity: only a unique immutable bridge is safe when object identity did not survive.
		if (matches?.length !== 1) return undefined;
		return matches[0];
	});
}
