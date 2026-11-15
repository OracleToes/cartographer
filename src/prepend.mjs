// The user's own words, kept in a file and read before the system prompt.
//
// PREPEND.md may sit in two places, and both are read when they exist, the installation first and the brain second
// (the closer one is said last, so it wins where the two disagree):
//   <installation>/PREPEND.md        the core: every project started from this copy of carto
//   <project>/.brain/PREPEND.md      this project alone
// Cartographer never writes this file; it is the user's. Nothing changes when it is absent. It is read fresh for
// every request, so editing it takes effect on the next one; and because it stands before the prompt, changing it
// means the server reads the prompt again from the top.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_DIR } from "./config.mjs";

/**
 * One text before the system prompt, or undefined when there is no PREPEND.md to read.
 * The files' own contents are kept verbatim (CRLF and a byte order mark are taken off); each part says where it
 * came from, so the model can say what it read.
 * @param {string} brainDir
 * @param {string} [core]  the core's PREPEND.md; a parameter so a test can point at a scratch file
 */
export function loadPrepend(brainDir, core = join(CORE_DIR, "PREPEND.md")) {
	const parts = [];
	for (const [label, path] of [
		["the installation", core],
		["this project's brain", join(brainDir, "PREPEND.md")],
	]) {
		let text;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			// Absent, unreadable, or a folder: nothing to add.
			continue;
		}
		const body = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
		if (body.trim() === "") continue;
		parts.push(`PREPEND.md (${label}, ${path}), written by the user, read before the rest of this prompt.\n\n${body}`);
	}
	return parts.length === 0 ? undefined : parts.join("\n\n");
}
