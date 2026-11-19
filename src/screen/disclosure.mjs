// A text disclosure is one part of an existing Screen view, never a viewport of its own. Callers keep their
// identity, open state, wrapping, and visual treatment; this pure helper only chooses the rows their outer
// ScrollView receives.

/**
 * Choose the rows a folded or open disclosure contributes to its parent view.
 *
 * `rows` have already been wrapped by the caller. `preview: "head"` is for settled material that reads from its
 * beginning; `preview: "tail"` is for a live stream whose newest progress must remain visible while folded.
 *
 * @param {{ rows: unknown[], open?: boolean, previewRows: number, preview?: "head" | "tail", retained?: { clipped?: boolean, originalChars?: number, reason?: string } }} options
 * @returns {{ visibleRows: unknown[], totalRows: number, omittedRows: number, expandable: boolean, mode: "folded" | "open", retainedNotice?: { clipped: true, originalChars?: number, reason?: string } }}
 */
export function disclosureRows({ rows, open = false, previewRows, preview = "head", retained } = {}) {
	if (!Array.isArray(rows)) throw new TypeError("A disclosure needs wrapped rows.");
	if (!Number.isInteger(previewRows) || previewRows < 0) throw new TypeError("A disclosure preview needs a non-negative whole row count.");
	if (preview !== "head" && preview !== "tail") throw new TypeError('A disclosure preview is "head" or "tail".');
	if (retained !== undefined && (retained === null || typeof retained !== "object" || Array.isArray(retained))) throw new TypeError("A disclosure retention notice is an object.");
	const mode = open === true ? "open" : "folded";
	const visibleRows = mode === "open"
		? rows.slice()
		: preview === "head"
			? rows.slice(0, previewRows)
			: rows.slice(Math.max(0, rows.length - previewRows));
	const omittedRows = rows.length - visibleRows.length;
	const retainedNotice = retained?.clipped === true
		? {
			clipped: true,
			...(Number.isSafeInteger(retained.originalChars) && retained.originalChars >= 0 ? { originalChars: retained.originalChars } : {}),
			...(typeof retained.reason === "string" && retained.reason.trim() !== "" ? { reason: retained.reason } : {}),
		}
		: undefined;
	return {
		visibleRows,
		totalRows: rows.length,
		omittedRows,
		expandable: rows.length > previewRows,
		mode,
		...(retainedNotice === undefined ? {} : { retainedNotice }),
	};
}
