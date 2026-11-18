// Async clipboard and export adapters. OSC 52 is a terminal write, while helper programs and durable export files
// are deliberately awaited away from input/render work.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { POLICY } from "../config.mjs";
import { runProcess } from "./process.mjs";

/** The most that is sent through OSC 52; terminals drop longer ones. */
const OSC_MAX = POLICY.limits.screen.oscChars;

const stamp = (date = new Date()) => {
	const two = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
};

/**
 * Put text on the clipboard, every way there is, without blocking the interface on helper processes.
 * @param {string} text
 * @param {{ write?: (sequence: string) => void, env?: Record<string, string | undefined>, run?: typeof runProcess }} options
 * @returns {Promise<string[]>} how the clipboard was reached; empty when no way was found
 */
export async function toClipboard(text, { write, env = process.env, run = runProcess } = {}) {
	const ways = [];
	if (write !== undefined && text.length <= OSC_MAX) {
		const data = Buffer.from(text, "utf8").toString("base64");
		// Inside tmux the sequence is wrapped so that it passes through to the terminal when tmux allows it.
		write(env.TMUX ? `\x1bPtmux;\x1b\x1b]52;c;${data}\x07\x1b\\` : `\x1b]52;c;${data}\x07`);
		ways.push("the terminal (OSC 52)");
	}
	const copyWith = async (command, args) => {
		try {
			const done = await run(command, args, {
				input: text,
				stdio: ["pipe", "ignore", "ignore"],
				timeoutMs: POLICY.limits.screen.copyTimeoutMs,
				env,
			});
			return done.status === 0;
		} catch {
			return false;
		}
	};
	if (env.TMUX && await copyWith("tmux", ["load-buffer", "-w", "-"])) ways.push("tmux's buffer");
	else if (env.TMUX && await copyWith("tmux", ["load-buffer", "-"])) ways.push("tmux's buffer");
	const tools = env.WAYLAND_DISPLAY ? [["wl-copy", []]] : env.DISPLAY ? [["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]] : process.platform === "darwin" ? [["pbcopy", []]] : [];
	for (const [command, args] of tools) {
		if (await copyWith(command, args)) {
			ways.push(command);
			break;
		}
	}
	return ways;
}

/** Copy one intentional export to the clipboard and the durable brain export folder. */
export async function copyOut(text, { brainDir, name, extension = "md", write, env = process.env, now } = {}) {
	const dir = join(brainDir, "export");
	await mkdir(dir, { recursive: true });
	const file = join(dir, `${name}-${stamp(now === undefined ? new Date() : new Date(now))}.${extension}`);
	await writeFile(file, text.endsWith("\n") ? text : `${text}\n`);
	return { file, ways: await toClipboard(text, { write, env }), chars: text.length };
}

/** Text selected on screen, without the presentation-only margins and block edges around it. */
export const selectionText = (text) =>
	String(text)
		.split("\n")
		.map((line) => line.replace(/^ {1,2}/, "").replace(/^▎/, "").trimEnd())
		.join("\n");
