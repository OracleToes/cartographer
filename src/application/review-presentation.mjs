// Presentation-safe formatting for Review projections.
//
// Checkpoint and Git readers stay behind application queries. The Review screen receives settled data plus this small
// vocabulary, so it never imports checkpoint helpers or turns a project-relative diff path into an editor target.
import { changeSummary } from "../checkpoints.mjs";
import { join } from "node:path";

const target = (root, path, line) => ({ file: join(root, path), line });

/** The vocabulary migrated Review renderers need. */
export function createReviewPresentation() {
	return Object.freeze({
		changeSummary,
		target,
	});
}
