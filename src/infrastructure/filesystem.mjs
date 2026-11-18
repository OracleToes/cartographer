// Promise-based filesystem seams for interactive presentation code.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
