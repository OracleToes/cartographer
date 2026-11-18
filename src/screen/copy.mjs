// Copying out of the full screen. Text is selected with the mouse as anywhere, and what is selected is copied when
// the button is let go (pi-tui does the selecting; this file reaches the clipboard). Whole things, a message, a
// tab, the session, are copied with a command or a key, and those are also written to a file, because the
// clipboard is the part that can fail without saying so.
//
// The clipboard is tried three ways, all of them: OSC 52 (the terminal sets the clipboard itself; inside tmux it
// needs `set -g set-clipboard on`), tmux's own buffer when carto runs in tmux, and the desktop's tool when one is
// installed (wl-copy, xclip, xsel, pbcopy).
import { POLICY } from "../config.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The most that is sent through OSC 52; terminals drop longer ones. */
const OSC_MAX = POLICY.limits.screen.oscChars;

const stamp = (date = new Date()) => {
	const two = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
};

/**
 * Put text on the clipboard, every way there is.
 * @param {string} text
 * @param {{ write?: (sequence: string) => void, env?: Record<string, string | undefined> }} options  write: sends a sequence to the terminal
 * @returns {string[]} how the clipboard was reached; empty when no way was found
 */
export function toClipboard(text, { write, env = process.env } = {}) {
	const ways = [];
	if (write !== undefined && text.length <= OSC_MAX) {
		const data = Buffer.from(text, "utf8").toString("base64");
		// Inside tmux the sequence is wrapped so that it passes through to the terminal when tmux allows it.
		write(env.TMUX ? `\x1bPtmux;\x1b\x1b]52;c;${data}\x07\x1b\\` : `\x1b]52;c;${data}\x07`);
		ways.push("the terminal (OSC 52)");
	}
	const run = (command, args) => {
		try {
			const done = spawnSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: POLICY.limits.screen.copyTimeoutMs });
			return done.status === 0;
		} catch {
			return false;
		}
	};
	if (env.TMUX && run("tmux", ["load-buffer", "-w", "-"])) ways.push("tmux's buffer");
	else if (env.TMUX && run("tmux", ["load-buffer", "-"])) ways.push("tmux's buffer");
	const tools = env.WAYLAND_DISPLAY ? [["wl-copy", []]] : env.DISPLAY ? [["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]] : process.platform === "darwin" ? [["pbcopy", []]] : [];
	for (const [command, args] of tools) {
		if (run(command, args)) {
			ways.push(command);
			break;
		}
	}
	return ways;
}

/**
 * Text that was selected on the screen, without what the screen put around it: the margin at the left of every
 * row, the drawn edge of a block, and the spaces a row is filled up with.
 */
export const selectionText = (text) =>
	String(text)
		.split("\n")
		.map((line) => line.replace(/^ {1,2}/, "").replace(/^▎/, "").trimEnd())
		.join("\n");

/**
 * Copy text on purpose: to the clipboard, and to a file under the brain's export folder.
 * @param {string} text
 * @param {{ brainDir: string, name: string, extension?: string, write?: (sequence: string) => void, env?: Record<string, string | undefined> }} options
 *   name: what the file is called, before the time; write: sends a sequence to the terminal
 * @returns {{ file: string, ways: string[], chars: number }}  ways: how the clipboard was reached
 */
export function copyOut(text, { brainDir, name, extension = "md", write, env = process.env }) {
	const dir = join(brainDir, "export");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${name}-${stamp()}.${extension}`);
	writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
	return { file, ways: toClipboard(text, { write, env }), chars: text.length };
}
