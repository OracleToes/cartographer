// Wake triggers: what brings the main agent back to something.
//
// The agent works only while it answers. A trigger does not make it wait: it is
// set, the agent goes on working or ends its turn, and when the trigger fires
// the agent is told. Resting, it gets a turn of its own (src/wake.mjs writes the
// note, src/terminal.mjs sends it). Working, it finds the firing in the state
// block of its next request. Three kinds:
//
//   time     every so many seconds
//   file     when a file or a folder of the project changes
//   window   when a shell window prints something, or a line with a given text
//
// Each fires `times` times; 0 means until it is removed. The triggers are kept
// in <brain>/carto-wakes.json, so they outlast a restart. Nothing fires while
// carto is not running: a time that came due meanwhile fires once at the start,
// and a file trigger compares with the files as they are at the start.
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ago, took } from "./time.mjs";

/** Seconds between two firings of one trigger, at least. A wake costs a whole turn; reading alone can take that long. */
export const WAKE_MIN = 60;
/** Triggers that can be set at a time. */
export const WAKES_MAX = 8;
export const NOTE_MAX = 300;
const EVERY_MAX = 7 * 24 * 3600;
/** Files of a watched folder that are compared; a larger folder is watched by its first files only. */
const FILES_MAX = 2000;
const SKIP = new Set([".git", ".atlas", "node_modules"]);

export class WakeError extends Error {}

export const wakesPath = (brainDir) => join(brainDir, "carto-wakes.json");

const flat = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What is stored, or an empty list when there is no file or it cannot be read. */
function load(brainDir) {
	try {
		const raw = JSON.parse(readFileSync(wakesPath(brainDir), "utf8"));
		const wakes = (Array.isArray(raw?.wakes) ? raw.wakes : []).filter(
			(wake) => typeof wake?.id === "string" && ["time", "file", "window"].includes(wake.kind) && Number.isFinite(wake.every) && Number.isInteger(wake.times),
		);
		// A time trigger without its next time is due at once.
		for (const wake of wakes) if (wake.kind === "time" && !Number.isFinite(wake.due)) wake.due = 0;
		return { next: Number.isInteger(raw?.next) ? raw.next : wakes.length + 1, wakes };
	} catch {
		return { next: 1, wakes: [] };
	}
}

/** The files under a path of the project with their time and size; empty when nothing is there. */
function filesAt(root, rel) {
	const found = new Map();
	let stat;
	try {
		stat = statSync(join(root, rel));
	} catch {
		return found;
	}
	if (!stat.isDirectory()) {
		found.set(rel, `${stat.mtimeMs}:${stat.size}`);
		return found;
	}
	const stack = [rel];
	while (stack.length > 0 && found.size < FILES_MAX) {
		const dir = stack.pop();
		let entries;
		try {
			entries = readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? 1 : -1));
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (SKIP.has(entry.name)) continue;
			const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
			if (entry.isDirectory()) stack.push(path);
			else {
				try {
					const one = statSync(join(root, path));
					found.set(path, `${one.mtimeMs}:${one.size}`);
				} catch {
					// Gone between the listing and the look.
				}
				if (found.size >= FILES_MAX) break;
			}
		}
	}
	return found;
}

/** What differs between two looks at the same path, as words; undefined when nothing does. */
function difference(rel, before, after) {
	const found = [];
	for (const [path, mark] of after) if (before.get(path) !== mark) found.push([path, before.has(path) ? "changed" : "appeared"]);
	for (const path of before.keys()) if (!after.has(path)) found.push([path, "is gone"]);
	if (found.length === 0) return undefined;
	const names = found.sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, how]) => `${path} ${how}`);
	return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")}, and ${names.length - 3} more under ${rel}`;
}

/** "every 5 m", "when src/app.js changes", 'when window server prints a line with "ERROR"' */
export function wakeAbout(wake) {
	if (wake.kind === "time") return `every ${took(wake.every * 1000)}`;
	if (wake.kind === "file") return `when ${wake.path === "." ? "a file of the project" : wake.path} changes`;
	return wake.match ? `when window ${wake.window} prints a line with ${JSON.stringify(wake.match)}` : `when window ${wake.window} prints something`;
}

/** How often it still fires: "until removed", "once", "3 more times". */
export function wakeRepeats(wake) {
	if (wake.times === 0) return "until removed";
	const left = wake.left ?? wake.times;
	if (left === 1) return wake.fired > 0 ? "once more" : "once";
	return `${left} more times`;
}

/**
 * One line for a trigger, as the agent sees it in the state block and the user with /wakes.
 * @param {{ windowOpen?: (name: string) => boolean }} [see]
 */
export function wakeLine(wake, now, see = {}) {
	const gap = wake.kind !== "time" && (wake.times === 0 || (wake.left ?? wake.times) > 1) ? `, at most every ${took(wake.every * 1000)}` : "";
	const parts = [`${wake.id} · ${wakeAbout(wake)}${gap}, ${wakeRepeats(wake)}`, wake.note];
	if (wake.fired > 0) {
		parts.push(`fired ${wake.fired === 1 ? "once" : `${wake.fired} times`}, last ${ago(now - wake.lastFired)}${wake.kind !== "time" && wake.lastWhat ? `: ${wake.lastWhat}` : ""}`);
		if (wake.lastActed !== undefined) parts.push(`you last acted on it ${ago(now - wake.lastActed)}`);
	} else parts.push("not fired yet");
	if (wake.kind === "time" && Number.isFinite(wake.due)) parts.push(wake.due <= now ? "due now" : `next in ${took(wake.due - now)}`);
	if (wake.kind === "window" && see.windowOpen !== undefined && !see.windowOpen(wake.window)) parts.push(`window ${wake.window} is not open now`);
	return parts.join(" · ");
}

/**
 * The triggers of one session.
 * @param {{ root: string, brainDir: string, config?: { wakeMin?: number, wakesMax?: number }, windows?: any, tickMs?: number, clock?: () => number }} input
 *   windows: the session's shell windows (src/windows.mjs), for the window triggers; clock: the time, for the tests
 */
export function createWakes({ root, brainDir, config = {}, windows, tickMs = 500, clock = Date.now }) {
	const least = config.wakeMin ?? WAKE_MIN;
	const most = config.wakesMax ?? WAKES_MAX;
	let { next, wakes } = load(brainDir);
	/** What a file trigger last saw, and where a window trigger has read to. Not stored: taken anew at each start. */
	const looks = new Map();
	const listeners = new Set();
	/** Firings the agent has not been told of. One per trigger: a later firing replaces the earlier one and counts it. */
	let news = [];
	/** Firings the agent was told of in the state block of the turn it is in. They stay there until the turn ends. */
	let during = [];
	/** The triggers whose firing started the turn the agent is in. */
	let current = [];

	const save = () => {
		const path = wakesPath(brainDir);
		writeFileSync(`${path}.tmp`, `${JSON.stringify({ next, wakes }, null, 2)}\n`);
		renameSync(`${path}.tmp`, path);
	};
	const find = (id) => wakes.find((wake) => wake.id === id);
	const look = (wake) => {
		if (wake.kind === "file") looks.set(wake.id, { files: filesAt(root, wake.path) });
		else if (wake.kind === "window") looks.set(wake.id, { at: windows?.position?.(wake.window) });
	};
	for (const wake of wakes) look(wake);

	const fire = (wake, what, now) => {
		wake.fired = (wake.fired ?? 0) + 1;
		wake.lastFired = now;
		wake.lastWhat = what;
		delete wake.pending;
		if (wake.kind === "time") wake.due = now + wake.every * 1000;
		let last = false;
		if (wake.times > 0) {
			wake.left = (wake.left ?? wake.times) - 1;
			if (wake.left <= 0) {
				last = true;
				wakes = wakes.filter((other) => other !== wake);
				looks.delete(wake.id);
			}
		}
		save();
		const earlier = news.find((event) => event.id === wake.id);
		const event = { type: "wake", id: wake.id, kind: wake.kind, about: wakeAbout(wake), note: wake.note, what, last, at: now, count: (earlier?.count ?? 0) + 1 };
		news = [...news.filter((other) => other !== earlier), event];
		for (const listener of listeners) listener(event);
	};

	const check = () => {
		const now = clock();
		for (const wake of [...wakes]) {
			if (wake.kind === "time") {
				if (now >= wake.due) fire(wake, "its time came", now);
				continue;
			}
			const seen = looks.get(wake.id) ?? {};
			if (wake.kind === "file") {
				const files = filesAt(root, wake.path);
				const what = difference(wake.path, seen.files ?? new Map(), files);
				if (what !== undefined) wake.pending = what;
				looks.set(wake.id, { files });
			} else {
				const at = windows?.position?.(wake.window);
				if (at !== undefined) {
					// A window opened anew under the same name counts from its start.
					const from = seen.at === undefined || seen.at > at ? 0 : seen.at;
					if (at > from) {
						const lines = windows.linesFrom(wake.window, from).filter((line) => line.trim() !== "");
						const hit = wake.match ? lines.findLast((line) => line.includes(wake.match)) : lines.at(-1);
						if (hit !== undefined) wake.pending = hit.length > 200 ? `${hit.slice(0, 200)}…` : hit;
					}
				}
				looks.set(wake.id, { at });
			}
			// Not more often than its interval: what happened meanwhile is told when the interval is over.
			if (wake.pending !== undefined && now >= (wake.lastFired ?? 0) + wake.every * 1000) fire(wake, wake.pending, now);
		}
	};
	const ticker = setInterval(() => {
		try {
			check();
		} catch {
			// A look that failed is taken again at the next tick.
		}
	}, tickMs);
	ticker.unref();

	const manager = {
		/**
		 * Set a trigger.
		 * @param {{ note: string, every?: number, times?: number, path?: string, window?: string, match?: string }} wanted
		 */
		set(wanted) {
			const note = flat(wanted.note);
			if (note === "") throw new WakeError("A wake needs a `note`: what you want to look at or do when it fires, written for yourself.");
			if (note.length > NOTE_MAX) throw new WakeError(`\`note\` is ${note.length} characters; ${NOTE_MAX} is the limit.`);
			if (wakes.length >= most) throw new WakeError(`${plural(most, "wake")} are set, which is the limit: ${wakes.map((wake) => wake.id).join(", ")}. Remove one first.`);
			const hasPath = typeof wanted.path === "string" && wanted.path.trim() !== "";
			const hasWindow = typeof wanted.window === "string" && wanted.window.trim() !== "";
			if (hasPath && hasWindow) throw new WakeError("Give `path` or `window`, not both: one wake watches one thing. Set a second wake for the other.");
			const kind = hasPath ? "file" : hasWindow ? "window" : "time";
			if (kind === "time" && wanted.every === undefined) throw new WakeError("Say what wakes you: `every` (seconds) for a time, `path` for a file or folder, or `window` for a shell window.");
			if (wanted.match !== undefined && wanted.match !== "" && kind !== "window") throw new WakeError("`match` goes with `window`: it is the text a printed line must contain.");
			const every = wanted.every === undefined ? least : wanted.every;
			if (!Number.isInteger(every) || every < least || every > EVERY_MAX) {
				throw new WakeError(`\`every\` is ${JSON.stringify(wanted.every)}; it is a whole number of seconds from ${least} to ${EVERY_MAX}. A wake costs a whole turn, so ${took(least * 1000)} is the least.`);
			}
			const times = wanted.times === undefined ? 1 : wanted.times;
			if (!Number.isInteger(times) || times < 0) throw new WakeError(`\`times\` is ${JSON.stringify(wanted.times)}; it is how often the wake fires: 1, 2, 3, …, or 0 for until you remove it.`);
			const now = clock();
			const wake = { id: `w${next}`, kind, every, times, ...(times > 0 ? { left: times } : {}), note, created: now, fired: 0 };
			if (kind === "time") wake.due = now + every * 1000;
			if (kind === "file") {
				const full = resolve(root, wanted.path.trim());
				const rel = relative(root, full).split(sep).join("/");
				if (rel.startsWith("..") || isAbsolute(rel)) throw new WakeError(`${JSON.stringify(wanted.path)} is outside the project. A wake watches a file or a folder of the project.`);
				if (rel === ".atlas" || rel.startsWith(".atlas/")) throw new WakeError("`.atlas` is Cartographer's own folder and is not watched.");
				wake.path = rel === "" ? "." : rel;
			}
			if (kind === "window") {
				wake.window = wanted.window.trim();
				if (typeof wanted.match === "string" && wanted.match !== "") wake.match = wanted.match;
			}
			next++;
			wakes.push(wake);
			look(wake);
			save();
			return { ...wake };
		},
		/** Remove one trigger, or every one with "all". @returns the removed ones */
		remove(id) {
			const gone = id === "all" ? wakes : wakes.filter((wake) => wake.id === id);
			if (gone.length === 0) throw new WakeError(wakes.length === 0 ? "No wake is set." : `There is no wake ${JSON.stringify(id)}. Set: ${wakes.map((wake) => wake.id).join(", ")}.`);
			wakes = wakes.filter((wake) => !gone.includes(wake));
			for (const wake of gone) looks.delete(wake.id);
			save();
			return gone.map((wake) => ({ ...wake }));
		},
		/** The triggers as they stand. */
		list: () => wakes.map((wake) => ({ ...wake })),
		/** One line each (see wakeLine). */
		lines: (now = clock()) => wakes.map((wake) => wakeLine(wake, now, { windowOpen: windows?.has ? (name) => windows.has(name) : undefined })),
		/** How long until the next time trigger is due, in ms; undefined when none is set. */
		nextDue(now = clock()) {
			const dues = wakes.filter((wake) => wake.kind === "time").map((wake) => Math.max(0, wake.due - now));
			return dues.length === 0 ? undefined : Math.min(...dues);
		},
		/** Be told when a trigger fires. */
		on(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		hasNews: () => news.length > 0,
		/** The firings the agent was not told of yet. */
		takeNews() {
			const taken = news;
			news = [];
			return taken;
		},
		/**
		 * The main agent is being sent a request: what fired up to here is in its state block and needs no turn of
		 * its own. @returns every firing of the turn that was told this way, this request's included
		 */
		noteShown() {
			for (const event of news) during = [...during.filter((other) => other.id !== event.id), event];
			news = [];
			return during;
		},
		/** A turn begins that these triggers started; none for a turn the user started. */
		begin(ids = []) {
			current = [...ids];
			during = [];
		},
		/** The agent did something in the turn the triggers started. */
		acted(now = clock()) {
			let changed = false;
			for (const id of current) {
				const wake = find(id);
				if (wake !== undefined) {
					wake.lastActed = now;
					changed = true;
				}
			}
			current = [];
			if (changed) save();
		},
		/** Look now, without waiting for the next tick (for the tests, and before the agent is shown the state). */
		check,
		shutdown() {
			clearInterval(ticker);
		},
	};
	return manager;
}
