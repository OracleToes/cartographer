// The sandbox a shell window runs in: bubblewrap (the `bwrap` command). The windows
// themselves are in windows.mjs; this file says what a window can reach, and bounds
// what a command's output costs.
//
// A window sees the machine like this:
//
//   the system (/usr, /etc, ...)   read-only
//   the project directory          writable
//   <project>/.atlas               read-only: the brain is Cartographer's
//   <project>/.git                 read-only: commits are the user's
//   the user's home folder         not there. In its place is a home of the sandbox's own,
//                                  <project>/.atlas/home, which keeps what tools store there
//                                  (package caches, settings) from one window to the next
//   /tmp, /var/tmp                 empty, gone when the window closes
//   /run, /mnt, /media             empty: no sockets of the user's session, no other drives
//   toolchains in the home folder  read-only: the PATH entries that lie there, and the
//                                  folders named in TOOLCHAINS
//   the network                    off, unless the plan item is marked `network`
//   processes                      only its own; every one of them ends with the window
//   the environment                a short fixed list: no variable of the user's shell
//
// Nothing is run outside the sandbox unless the user says so. On a machine where
// bubblewrap does not work, tasks cannot run commands at all, until the user switches
// the sandbox off (--no-bwrap at launch, /bwrap off while running). Commands then run
// on the machine itself, as the user.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";

export class SandboxError extends Error {}

/** The sandbox's own home folder, inside the brain. */
export const SANDBOX_HOME = "home";

/** Places that hold other people's business: each is covered by an empty folder. */
const HIDDEN = ["/tmp", "/var/tmp", "/run", "/mnt", "/media"];

/**
 * Folders in the home directory where language toolchains keep their programs. Bound read-only when they exist.
 * None of them holds credentials. ~/.cargo is not here for that reason: its bin folder comes in through PATH.
 */
const TOOLCHAINS = [
	".nvm",
	".volta",
	".bun",
	".deno",
	".rustup",
	".pyenv",
	".rbenv",
	".asdf",
	".sdkman",
	".juliaup",
	".ghcup",
	".dotnet",
	".local/lib",
	".local/share/mise",
	".local/share/uv",
	".local/share/pnpm",
	".local/share/fnm",
];

/**
 * What one result may hold: the start of the output and, when it is longer, its end, each bounded in characters
 * and in lines. The end gets the larger share, because that is where a failure is reported.
 */
export const HEAD_MAX = 2000;
export const TAIL_MAX = 8000;
export const HEAD_LINES = 40;
export const TAIL_LINES = 160;
export const LINE_MAX = 1000;

const inside = (path, dir) => path === dir || path.startsWith(dir + sep);
/** A real folder, not a symlink to one: bubblewrap mounts over the path as given. */
const isFolder = (path) => {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
};
const real = (path) => {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
};

let found;
/**
 * Whether commands can be sandboxed on this machine. Tried once per run of the program, with a real sandbox.
 * @returns {{ ok: true, version: string, shell: "bash" | "sh" } | { ok: false, why: string }}
 */
export function findSandbox() {
	if (found !== undefined) return found;
	const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 };
	let version;
	try {
		version = execFileSync("bwrap", ["--version"], options).trim().replace(/^bubblewrap\s+/, "");
	} catch (error) {
		found = { ok: false, why: error.code === "ENOENT" ? "bubblewrap (the bwrap command) is not installed" : `bwrap --version failed: ${firstLine(error.stderr) || error.message}` };
		return found;
	}
	try {
		const trial = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--unshare-pid", "--unshare-net", "--die-with-parent", "--new-session"];
		const shell = execFileSync("bwrap", [...trial, "sh", "-c", "command -v bash || true"], options).trim();
		found = { ok: true, version, shell: shell === "" ? "sh" : "bash" };
	} catch (error) {
		found = { ok: false, why: `bubblewrap ${version} is installed but cannot start a sandbox here (${firstLine(error.stderr) || error.message})` };
	}
	return found;
}

const firstLine = (text) =>
	String(text ?? "")
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line !== "") ?? "";

/**
 * The bubblewrap arguments and the environment for one command.
 * @param {{ root: string, brainDir: string, cwd?: string, network?: boolean, read?: string[], env?: NodeJS.ProcessEnv }} input
 *   root: real path of the project; cwd: a folder inside it; read: more folders to show read-only (settings)
 * @returns {{ args: string[], env: Record<string, string>, home: string }}
 */
export function sandboxArgs({ root, brainDir, cwd = root, network = false, read = [], env = process.env }) {
	const home = real(homedir());
	if (home === undefined) throw new SandboxError("the home folder cannot be found");
	// The project is bound writable after the home folder is covered; a project that contains the home folder
	// would bring it back, writable.
	if (inside(home, root)) throw new SandboxError(`the project directory ${root} contains your home folder, so a sandbox there would not protect it`);
	const sandboxHome = join(brainDir, SANDBOX_HOME);
	mkdirSync(sandboxHome, { recursive: true });

	const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
	const hidden = HIDDEN.filter(isFolder);
	for (const path of hidden) args.push("--tmpfs", path);
	args.push("--bind", sandboxHome, home);

	// Shown again, read-only: programs that live in a hidden place.
	const keep = new Set();
	const covered = (path) => inside(path, home) || hidden.some((dir) => dir !== "/tmp" && dir !== "/var/tmp" && inside(path, dir));
	for (const entry of (env.PATH ?? "").split(delimiter)) {
		// An entry that is the home folder itself, or above it, would bring the home folder back.
		if (entry.startsWith("/") && covered(entry) && !inside(home, entry) && existsSync(entry)) keep.add(entry);
	}
	for (const name of TOOLCHAINS) if (existsSync(join(home, name))) keep.add(join(home, name));
	// Name resolution: /etc/resolv.conf is often a link into /run.
	const resolv = real("/etc/resolv.conf");
	if (resolv !== undefined && inside(resolv, "/run") && dirname(resolv) !== "/run") keep.add(dirname(resolv));
	for (const given of read) {
		if (typeof given !== "string" || given.trim() === "") continue;
		const path = given.trim().replace(/^~(?=$|\/)/, home);
		if (!path.startsWith("/")) throw new SandboxError(`shellRead: ${given} must be a full path, or start with ~/`);
		if (existsSync(path)) keep.add(path);
	}
	for (const path of keep) args.push("--ro-bind", path, path);

	args.push("--bind", root, root);
	args.push("--ro-bind", brainDir, brainDir);
	// The sandbox home lies inside the brain, which was just made read-only there; at the home path it stays writable.
	const dotGit = join(root, ".git");
	if (existsSync(dotGit)) args.push("--ro-bind", dotGit, dotGit);
	args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try");
	if (!network) args.push("--unshare-net");
	args.push("--die-with-parent", "--new-session", "--chdir", cwd);

	let user = "user";
	try {
		user = userInfo().username;
	} catch {
		// No name for this user id; the fallback is fine.
	}
	return {
		args,
		home,
		env: {
			PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			HOME: home,
			USER: user,
			LOGNAME: user,
			LANG: env.LANG ?? "C.UTF-8",
			...(env.LC_ALL ? { LC_ALL: env.LC_ALL } : {}),
			...QUIET,
		},
	};
}

/**
 * Keeps the start and the end of a command's output, by whole lines. Colour codes are removed, a line redrawn with
 * carriage returns (a progress bar) keeps its last state, and a very long line is shortened.
 */
export class Output {
	#head = [];
	#headChars = 0;
	#tail = [];
	#tailChars = 0;
	#overflow = false;
	#pending = "";
	lines = 0;
	omittedLines = 0;
	last = "";

	/** @param {string} text */
	add(text) {
		const parts = (this.#pending + text).split("\n");
		this.#pending = parts.pop();
		for (const part of parts) this.#line(part);
		// A line that never ends must not grow without bound.
		if (this.#pending.length > 64_000) {
			this.#line(this.#pending);
			this.#pending = "";
		}
	}

	#line(raw) {
		let line = raw.replace(/\r+$/, "");
		if (line.includes("\r")) line = line.slice(line.lastIndexOf("\r") + 1);
		// Colour and cursor codes, then whatever control characters are left.
		line = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
		if (line.length > LINE_MAX) line = `${line.slice(0, LINE_MAX)} [line cut: ${line.length} characters]`;
		this.lines++;
		if (line.trim() !== "") this.last = line;
		if (!this.#overflow && this.#headChars + line.length + 1 <= HEAD_MAX && this.#head.length < HEAD_LINES) {
			this.#head.push(line);
			this.#headChars += line.length + 1;
			return;
		}
		this.#overflow = true;
		this.#tail.push(line);
		this.#tailChars += line.length + 1;
		while ((this.#tailChars > TAIL_MAX || this.#tail.length > TAIL_LINES) && this.#tail.length > 1) {
			this.#tailChars -= this.#tail.shift().length + 1;
			this.omittedLines++;
		}
	}

	/** Count lines that were printed and are no longer there to be shown. They leave a gap like any other. */
	skip(count) {
		if (count <= 0) return;
		this.lines += count;
		this.omittedLines += count;
		this.#overflow = true;
	}

	/** The output as the task gets it. */
	text() {
		if (this.#pending !== "") {
			this.#line(this.#pending);
			this.#pending = "";
		}
		if (this.omittedLines === 0) return [...this.#head, ...this.#tail].join("\n");
		const gap = `[${this.omittedLines} lines left out here: the output was ${this.lines} lines. To see them, run the command again through grep, head or tail, or send its output to a file and read the part you need.]`;
		return [...this.#head, gap, ...this.#tail].join("\n");
	}
}

/** What every command gets, sandboxed or not: no colours, no pager, no questions. */
export const QUIET = {
	TERM: "dumb",
	NO_COLOR: "1",
	PAGER: "cat",
	GIT_PAGER: "cat",
	// Passwords and tokens are the user's to type, not the agent's.
	GIT_TERMINAL_PROMPT: "0",
	// Output arrives as it is printed, so a command that is stopped still shows how far it got.
	PYTHONUNBUFFERED: "1",
	// No __pycache__ folders among the files a task is recorded as having changed.
	PYTHONDONTWRITEBYTECODE: "1",
};

/**
 * How commands run in this session, which the user can change while it runs (/bwrap).
 *   "sandbox"  inside bubblewrap
 *   "direct"   on the machine itself, as the user: the user switched the sandbox off
 *   "none"     not at all: bubblewrap does not work here, and the user has not switched it off
 * @param {{ off?: boolean }} options  off: the user asked for no sandbox at launch
 */
export function createRunner({ off = false } = {}) {
	return {
		off,
		get available() {
			return findSandbox();
		},
		get mode() {
			if (this.off) return "direct";
			return this.available.ok ? "sandbox" : "none";
		},
	};
}

/** One line for the user on how commands run now. */
export function sandboxLine(runner) {
	if (runner.mode === "direct") return "sandbox: OFF · tasks run commands directly on this machine, as you: they reach whatever you can, and the network";
	if (runner.mode === "sandbox") return `sandbox: bubblewrap ${runner.available.version} · tasks run commands inside the project only, without network`;
	return `no sandbox: ${runner.available.why} · tasks cannot run commands (carto --no-bwrap, or /bwrap off, runs them without one)`;
}
