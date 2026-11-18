// Presentation-safe formatting for Workspace projections.
//
// Durable Workspace readers stay behind application queries. Screen renderers receive their settled projection plus
// this narrow vocabulary, so they never import a domain book merely to describe a Workspace snapshot.
import { atlasSummary, renderAttention } from "../atlas.mjs";
import { POLICY } from "../config.mjs";
import { entryLine } from "../ledger.mjs";
import { stamp } from "../time.mjs";

const when = (value) => {
	const ms = typeof value === "number" ? value : Date.parse(value ?? "");
	return Number.isFinite(ms) ? stamp(ms) : undefined;
};

const ledgerGroups = Object.freeze([
	Object.freeze({ title: "Goals", matches: (item) => item.kind === POLICY.enums.ledgerKind.goal }),
	Object.freeze({ title: "Questions for you", matches: (item) => item.kind === POLICY.enums.ledgerKind.question }),
	Object.freeze({ title: "Notes", matches: (item) => item.kind === POLICY.enums.ledgerKind.note }),
]);

/** The presentation vocabulary migrated Workspace renderers need. Other views join this adapter as they migrate. */
export function createWorkspacePresentation() {
	return Object.freeze({
		atlas: Object.freeze({
			summary: atlasSummary,
			attention: (snapshot) => renderAttention(snapshot, { idle: (snapshot?.active ?? []).length === 0 }),
			when,
		}),
		ledger: Object.freeze({
			when,
			entryLine,
			groups: ledgerGroups,
			isOpen: (item) => item.status === POLICY.enums.entryStatus.open,
			isDone: (item) => item.status === POLICY.enums.entryStatus.done,
			isGoal: (item) => item.kind === POLICY.enums.ledgerKind.goal,
			isNote: (item) => item.kind === POLICY.enums.ledgerKind.note,
		}),
	});
}
