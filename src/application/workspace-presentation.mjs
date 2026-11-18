// Presentation-safe formatting for Workspace projections.
//
// Durable Workspace readers stay behind application queries. Screen renderers receive their settled projection plus
// this narrow vocabulary, so they never import a domain book merely to describe a Workspace snapshot.
import { atlasSummary, renderAttention } from "../atlas.mjs";
import { POLICY } from "../config.mjs";
import { join } from "node:path";
import { entryLine } from "../ledger.mjs";
import { authorizationLine, itemLine, movesOf, waiting } from "../plan.mjs";
import { flat } from "../rows.mjs";
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

const planMoveState = (move) => {
	const done = move.status === "done";
	const reported = move.status === "reported";
	const blocked = move.status === "blocked";
	return {
		done,
		reported,
		blocked,
		icon: done ? "✓" : reported ? "!" : move.status === "running" ? "▶" : blocked ? "×" : move.approvedRevision === move.revision ? "●" : "○",
		style: done ? "ok" : reported || blocked ? "warn" : "tool",
	};
};

const treeSize = (bytes) => bytes < POLICY.limits.format.kibibyte ? `${bytes} B` : bytes < POLICY.limits.format.mebibyte ? `${(bytes / POLICY.limits.format.kibibyte).toFixed(1)} KB` : `${(bytes / POLICY.limits.format.mebibyte).toFixed(1)} MB`;
const treeTarget = (root, path, folder = false) => ({ file: join(root, path), ...(folder ? { folder: true } : {}) });

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
		plan: Object.freeze({
			when,
			itemLine,
			movesOf,
			waiting,
			authorizationLine,
			isDone: (item) => item.status === POLICY.enums.entryStatus.done,
			moveState: planMoveState,
		}),
		requests: Object.freeze({
			flat,
			isApproval: (request) => request.kind === "approval",
			isQuestion: (request) => request.kind === POLICY.enums.ledgerKind.question,
		}),
		tree: Object.freeze({
			size: treeSize,
			target: treeTarget,
		}),
	});
}
