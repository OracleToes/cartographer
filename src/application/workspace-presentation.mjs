// Presentation-safe formatting for Workspace projections.
//
// Durable Workspace readers stay behind application queries. Screen renderers receive their settled projection plus
// this narrow vocabulary, so they never import a domain book merely to describe an Atlas snapshot.
import { atlasSummary, renderAttention } from "../atlas.mjs";
import { stamp } from "../time.mjs";

const when = (value) => {
	const ms = typeof value === "number" ? value : Date.parse(value ?? "");
	return Number.isFinite(ms) ? stamp(ms) : undefined;
};

/** The vocabulary needed by the migrated Atlas renderer. Other Workspace views join this adapter as they migrate. */
export function createWorkspacePresentation() {
	return Object.freeze({
		atlas: Object.freeze({
			summary: atlasSummary,
			attention: (snapshot) => renderAttention(snapshot, { idle: (snapshot?.active ?? []).length === 0 }),
			when,
		}),
	});
}
