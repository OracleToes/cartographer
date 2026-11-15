// Which name the agent uses for the person it works with.
//
// The name comes from the `user` key in the settings (the install's config.json, or the project's
// .brain/config.json for one project), "CARTO_USER" in the environment, or the OS user that launched
// the process — in that order, like every other setting: the more specific wins. The install's
// config.json sits next to the code (CARTO_CONFIG names another file instead).
//
// Resolved once, at import, so module-level wording can use it. src/config.mjs checks the same files
// again at load and refuses a `user` that is not one name on one line; the two use the same precedence.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, userInfo } from "node:os";

/** The core folder: where Cartographer is installed. Every project runs this one copy. */
const CORE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The brain folders to look for, newest first: the current one and the name before 2026-11-15. */
const BRAIN_NAMES = [".brain", ".atlas"];
/** The file that makes a brain folder a Cartographer brain. */
const SESSION = "session.sqlite";

const clean = (value) => {
	if (typeof value !== "string") return undefined;
	if (/[\r\n]/.test(value)) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
};
const readJson = (path) => {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
};
const fromConfig = (path) => clean(readJson(path).user);

/** The `user` of the nearest brain above `cwd` (stopping below the home folder, like the project search), or undefined. */
const fromProject = (cwd, env) => {
	const home = (() => { try { return homedir(); } catch { return undefined; } })();
	let dir = cwd;
	for (;;) {
		if (dir === "/" || dir === home) return undefined;
		for (const name of BRAIN_NAMES) {
			if (existsSync(join(dir, name, SESSION))) return fromConfig(join(dir, name, "config.json"));
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
};

const osUser = (env) => {
	try {
		return clean(userInfo().username);
	} catch {
		return clean(env.USER) ?? clean(env.LOGNAME);
	}
};

/**
 * The name to use. Precedence, the more specific winning: CARTO_USER in the environment, then the
 * project's .brain/config.json, then the install's config.json (CARTO_CONFIG names another file),
 * then the OS user that launched the process. "the user" is the last resort there is none.
 * @param {NodeJS.ProcessEnv} [env]
 */
export const resolveUser = (env = process.env, cwd = process.cwd()) => {
	const corePath = env.CARTO_CONFIG ? env.CARTO_CONFIG : join(CORE_DIR, "config.json");
	return clean(env.CARTO_USER) ?? fromProject(cwd, env) ?? fromConfig(corePath) ?? osUser(env) ?? "the user";
};

/** The name, as it was resolved at import. */
export const USER_NAME = resolveUser();
/** The name with its first letter upper-cased, for the start of a sentence. */
export const USER_HEAD = USER_NAME.charAt(0).toUpperCase() + USER_NAME.slice(1);
