// Promise-based filesystem seams for interactive presentation code.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
