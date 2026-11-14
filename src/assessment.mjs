// The assessment: the agent's own summary of the project, written to itself.
//
// What the project is, how it is built and run, what state it is in, what matters
// when changing it. The agent replaces it whole when its picture changes. It lives
// in <project>/.atlas/assessment.md as plain text, so the user can read and edit it.
import { POLICY } from "./config.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ASSESSMENT_MAX = POLICY.limits.assessment.textChars;

export const assessmentPath = (brainDir) => join(brainDir, "assessment.md");

/** @returns {{ text: string, written?: number }}  text is "" when there is none; written: when the file last changed (ms) */
export function loadAssessment(brainDir) {
	const path = assessmentPath(brainDir);
	if (!existsSync(path)) return { text: "" };
	try {
		return { text: readFileSync(path, "utf8").trim(), written: statSync(path).mtimeMs };
	} catch {
		return { text: "" };
	}
}

export function saveAssessment(brainDir, text) {
	const path = assessmentPath(brainDir);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${text.trim()}\n`);
	renameSync(temp, path);
}

export const textHash = (text) => createHash("sha1").update(text).digest("hex").slice(0, 12);
