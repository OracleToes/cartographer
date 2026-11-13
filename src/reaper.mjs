// Ending everything a shell window started, when the window runs without the sandbox.
//
// Inside the sandbox this is not needed: the sandbox's processes end with it. Outside,
// a window's processes are in sessions of their own (a terminal makes one), so ending
// a process group does not reach them. This file finds them through /proc.
//
// Run as a program it is the watcher of one window: `node reaper.mjs <carto pid> <window pid>`
// waits for Cartographer to disappear and then ends what the window started. That
// covers the case in which Cartographer itself is killed and cannot clean up.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Every process on this machine: its id, its parent and its session. */
function processes() {
	const found = [];
	let names = [];
	try {
		names = readdirSync("/proc");
	} catch {
		return found;
	}
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		try {
			// "pid (name) state parent group session …": the name may hold spaces and brackets, so read after the last one.
			const stat = readFileSync(`/proc/${name}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			found.push({ pid: Number(name), parent: Number(fields[1]), session: Number(fields[3]) });
		} catch {
			// Gone between the listing and the read.
		}
	}
	return found;
}

/**
 * The processes that belong to `pid`: its descendants, and every process in a session that one of them leads.
 * The second part finds a process whose parent has already ended. A session that was not started under `pid`
 * is never included, so this cannot reach the user's own terminal.
 * @param {number} pid
 * @returns {number[]}
 */
export function family(pid) {
	const all = processes();
	const found = new Set([pid]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const entry of all) {
			if (!found.has(entry.pid) && found.has(entry.parent)) {
				found.add(entry.pid);
				grew = true;
			}
		}
	}
	const sessions = new Set(all.filter((entry) => found.has(entry.pid) && entry.session === entry.pid).map((entry) => entry.pid));
	for (const entry of all) if (sessions.has(entry.session)) found.add(entry.pid);
	return [...found];
}

/** End `pid` and everything that belongs to it. `known`: processes seen earlier that may have lost their parent since. */
export function killFamily(pid, known = []) {
	for (const each of new Set([...family(pid), ...known])) {
		if (each === process.pid || each <= 1) continue;
		try {
			process.kill(each, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const watched = Number(process.argv[2]);
	const root = Number(process.argv[3]);
	let known = [];
	setInterval(() => {
		if (!alive(root)) process.exit(0);
		if (alive(watched)) {
			known = family(root);
			return;
		}
		killFamily(root, known);
		process.exit(0);
	}, 400);
}
