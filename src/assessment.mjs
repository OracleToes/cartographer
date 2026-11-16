// The assessment: the agent's own summary of the project, written to itself.
//
// What the project is, how it is built and run, what state it is in, what matters
// when changing it. The agent replaces it whole when its picture changes. It lives
// in <project>/.brain/assessment.md as plain text, so the user can read and edit it.
//
// One legacy door: a project that used the old books (carto-books.json, entries of
// kind "assessment") gets those entries folded into the assessment on the first read
// after the books were retired — the two copies were one text twice. The books file
// is left on disk untouched; the assessment becomes the one copy that counts.
import { POLICY } from "./config.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ASSESSMENT_MAX = POLICY.limits.assessment.textChars;

export const assessmentPath = (brainDir) => join(brainDir, "assessment.md");
const booksPath = (brainDir) => join(brainDir, "carto-books.json");

/** The assessment entries of a retired books file, or undefined when there is no such file or none. */
const legacyAssessmentText = (brainDir) => {
	const path = booksPath(brainDir);
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		const items = Array.isArray(raw?.items) ? raw.items : [];
		const text = items.filter((item) => item?.kind === "assessment" && item?.status !== "done" && typeof item?.text === "string" && item.text.trim() !== "").map((item) => item.text.trim()).join("\n\n");
		return text === "" ? undefined : text;
	} catch {
		return undefined;
	}
};

/** @returns {{ text: string, written?: number }}  text is "" when there is none; written: when the file last changed (ms) */
export function loadAssessment(brainDir) {
	const path = assessmentPath(brainDir);
	if (existsSync(path)) {
		try {
			return { text: readFileSync(path, "utf8").trim(), written: statSync(path).mtimeMs };
		} catch {
			return { text: "" };
		}
	}
	// The retired books, folded in whole the first time the assessment is read: the entries were the assessment.
	const folded = legacyAssessmentText(brainDir);
	if (folded !== undefined) {
		// The books file is left on disk; the assessment becomes the one copy that counts from here on.
		try { saveAssessment(brainDir, folded); return { text: folded, written: Date.now() }; } catch { return { text: folded }; }
	}
	return { text: "" };
}

export function saveAssessment(brainDir, text) {
	const path = assessmentPath(brainDir);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${text.trim()}\n`);
	renameSync(temp, path);
}

export const textHash = (text) => createHash("sha1").update(text).digest("hex").slice(0, 12);
