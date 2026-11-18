// Presentation-safe semantics for Chat.
//
// The screen owns event-feed state and rendering. This narrow adapter owns the old domain-shaped details that make a
// model event legible: activity labels, the context-collapse marker, and the fixed consultation roster. Keeping
// them here lets Chat consume injected presentation data without reaching into domain books while it paints.
import { describeCall, describeResult } from "./activity.mjs";
import { CONSULT_ROSTER } from "../conference.mjs";
import { isFront } from "../context.mjs";
import { splitTop } from "../top.mjs";

const roster = Object.freeze(CONSULT_ROSTER.map((member) => Object.freeze({ id: member.id, name: member.name })));
const collapsedContext = (text) => isFront({ role: "user", content: [{ type: "text", text: splitTop(String(text ?? "")).text }] });

/**
 * The small presentation contract Chat needs from application/domain state.
 * `describeRef` remains deferred and cache-backed in the screen composition; this adapter only gives its current
 * answer to the shared activity formatter.
 */
export function createChatPresentation({ describeRef } = {}) {
	return Object.freeze({
		describeCall: (call) => describeCall(call, describeRef),
		describeResult,
		isCollapsedContext: collapsedContext,
		consultRoster: roster,
	});
}
