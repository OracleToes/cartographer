// Promise-based filesystem seams for interactive presentation code.
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Write an editor scratch file under the brain without blocking keyboard/render handling. */
export async function writeScratch(brainDir, name, text) {
	const dir = join(brainDir, "scratch");
	await mkdir(dir, { recursive: true });
	const file = join(dir, name);
	await writeFile(file, `${text}\n`);
	return file;
}

/** Read text selected by an external editor without blocking keyboard/render handling. */
export const readText = (file) => readFile(file, "utf8");

/** Whether a target still exists. Failed access is an ordinary false rather than a render-time exception. */
export async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Find the first matching text position in sorted source files without scanning them from a key handler. */
export async function findTextSource(dir, needle, { suffix } = {}) {
	try {
		for (const entry of (await readdir(dir)).sort()) {
			if (suffix !== undefined && !entry.endsWith(suffix)) continue;
			const file = join(dir, entry);
			let text;
			try {
				text = await readFile(file, "utf8");
			} catch {
				continue;
			}
			const at = text.indexOf(needle);
			if (at >= 0) return { file, line: text.slice(0, at).split("\n").length };
		}
	} catch {
		// The source folder is not present or readable.
	}
	return undefined;
}

/** Find the first executable named in `names` on PATH without probing it synchronously in the screen. */
export async function findExecutable(names, { path = process.env.PATH ?? "" } = {}) {
	for (const name of names) {
		if (typeof name !== "string" || name.trim() === "") continue;
		for (const dir of path.split(delimiter)) {
			if (dir === "") continue;
			const candidate = join(dir, name);
			try {
				await access(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Not here.
			}
		}
	}
	return undefined;
}
