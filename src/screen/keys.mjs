// Keys by name, and text that was pasted without being marked as pasted.
//
// pi-tui reads the terminal: it knows the Kitty keyboard protocol and the older encodings, and hands over one key
// at a time as the bytes the terminal sent. `keyOf` gives such a key the name the commands mode works with: the
// character for a key that types one ("j", "G", "+", " "), and pi-tui's name for any other ("escape", "enter",
// "ctrl+d", "shift+tab", "pageUp", "alt+j").
import { decodeKittyPrintable, isKeyRelease, parseKey } from "@earendil-works/pi-tui";

export { isKeyRelease };

/** @returns {string | undefined} */
export function keyOf(data) {
	const typed = decodeKittyPrintable(data);
	if (typed !== undefined) return typed;
	if ([...data].length === 1 && data >= " " && data !== "\x7f") return data;
	return parseKey(data);
}

/** Whether what the terminal sent is text marked as pasted. */
export const isPaste = (data) => data.startsWith("\x1b[200~");

/**
 * A terminal that does not mark what it pastes sends the lines as if they were typed, and each line end would send
 * the message as far as it has come. Such text arrives all at once, which typing never does: several lines in one
 * read are taken as pasted, and their line ends break the line. The line end that ends the read is left as it is,
 * so that one typed line and its Enter, arriving together, is still a line that is sent.
 *
 * `read(chunk)` is told every read of the terminal's input, before pi-tui cuts it into keys; `lineEnd(data)` is
 * then asked for each key: "break" when this Enter belongs to pasted text and breaks the line, "skip" for the
 * line feed of a line end that came as two characters, undefined for a key that is none of this.
 */
export function createPasteWatch() {
	let left = 0;
	let afterReturn = false;
	return {
		read(chunk) {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			left = 0;
			afterReturn = false;
			// Keys, the mouse and marked pastes come as escape sequences, and are none of this.
			if (text.includes("\x1b")) return;
			const body = text.replace(/[\r\n]+$/, "");
			if (!/[\r\n]/.test(body) || !/[^\s]/.test(body)) return;
			// "\r\n" is one line end.
			left = body.split(/\r\n|\r|\n/).length - 1;
		},
		lineEnd(data) {
			if (data === "\n" && afterReturn) {
				afterReturn = false;
				return "skip";
			}
			afterReturn = false;
			if (left <= 0 || (data !== "\r" && data !== "\n")) return undefined;
			left--;
			afterReturn = data === "\r";
			return "break";
		},
	};
}
