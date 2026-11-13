// The terminal itself: the alternate screen, keys and the mouse as events, and frames written with as little as
// has changed.
//
// Nothing here knows what is on the screen. `createTerm` takes the two streams, puts the terminal into raw mode
// on `start`, and gives every key and click to a listener. `draw` takes a whole frame, one string per row, already
// fitted to the width (src/screen/text.mjs), and writes only the rows that differ from the frame before.

const ESC = "\x1b";

/** The names of the keys that arrive as escape sequences. */
const SEQUENCES = new Map([
	["[A", "up"], ["[B", "down"], ["[C", "right"], ["[D", "left"],
	["OA", "up"], ["OB", "down"], ["OC", "right"], ["OD", "left"],
	["[H", "home"], ["[F", "end"], ["OH", "home"], ["OF", "end"], ["[1~", "home"], ["[4~", "end"], ["[7~", "home"], ["[8~", "end"],
	["[2~", "insert"], ["[3~", "delete"], ["[5~", "pageup"], ["[6~", "pagedown"],
	["[Z", "shift-tab"],
	["OP", "f1"], ["OQ", "f2"], ["OR", "f3"], ["OS", "f4"], ["[11~", "f1"], ["[12~", "f2"], ["[13~", "f3"], ["[14~", "f4"], ["[15~", "f5"],
	["[1;3A", "alt-up"], ["[1;3B", "alt-down"], ["[1;5A", "ctrl-up"], ["[1;5B", "ctrl-down"], ["[1;2A", "shift-up"], ["[1;2B", "shift-down"],
	["[1;5C", "ctrl-right"], ["[1;5D", "ctrl-left"], ["[1;3C", "alt-right"], ["[1;3D", "alt-left"],
]);

/**
 * Turn what the terminal sent into events. Returns the events and what is left over, which is the start of a
 * sequence whose end has not arrived yet.
 * @param {string} data
 * @returns {{ events: ({ type: "key", name: string } | { type: "text", text: string } | { type: "paste", text: string } | { type: "reply", text: string } | { type: "mouse", button: "left" | "middle" | "right" | "up" | "down", x: number, y: number, release: boolean })[], rest: string }}
 */
export function parseInput(data) {
	const events = [];
	let i = 0;
	let text = "";
	const flush = () => {
		if (text !== "") events.push({ type: "text", text });
		text = "";
	};
	while (i < data.length) {
		const char = data[i];
		if (char === ESC) {
			const rest = data.slice(i + 1);
			// Text pasted by the terminal, between its own marks.
			if (rest.startsWith("[200~")) {
				const end = rest.indexOf(`${ESC}[201~`);
				if (end === -1) {
					flush();
					return { events, rest: data.slice(i) };
				}
				flush();
				events.push({ type: "paste", text: rest.slice(5, end).replace(/\r\n?/g, "\n") });
				i += 1 + end + 6;
				continue;
			}
			// The mouse, as "<button;column;row" and M for a press, m for a release.
			const mouse = /^\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
			if (mouse) {
				flush();
				const code = Number(mouse[1]);
				const button = code & 64 ? (code & 1 ? "down" : "up") : ["left", "middle", "right"][code & 3];
				// A move with a button held is not a click.
				if (button !== undefined && !(code & 32)) events.push({ type: "mouse", button, x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1, release: mouse[4] === "m" });
				i += 1 + mouse[0].length;
				continue;
			}
			if (/^\[<[\d;]*$/.test(rest)) {
				flush();
				return { events, rest: data.slice(i) };
			}
			// What the terminal answers when it is asked something (its colours): "]…" up to a bell or ESC \.
			if (rest.startsWith("]") || rest.startsWith("P")) {
				const end = /\x07|\x1b\\/.exec(rest);
				flush();
				if (end === null) return { events, rest: data.slice(i) };
				if (rest.startsWith("]")) events.push({ type: "reply", text: rest.slice(1, end.index) });
				i += 1 + end.index + end[0].length;
				continue;
			}
			const sequence = /^(\[[\d;?>=]*[A-Za-z~]|O[A-Za-z])/.exec(rest);
			if (sequence) {
				flush();
				const name = SEQUENCES.get(sequence[0]);
				if (name !== undefined) events.push({ type: "key", name });
				i += 1 + sequence[0].length;
				continue;
			}
			// The start of a sequence, cut off by the end of this read.
			if (rest === "" || /^(\[[\d;?>=]*|O)$/.test(rest)) {
				flush();
				// A lone escape at the end of a read is the Escape key.
				if (rest === "") events.push({ type: "key", name: "escape" });
				else return { events, rest: data.slice(i) };
				i = data.length;
				continue;
			}
			// Escape and then a character: Alt with that key.
			flush();
			const next = rest[0];
			if (next === "\r" || next === "\n") events.push({ type: "key", name: "alt-enter" });
			else if (next === "\x7f") events.push({ type: "key", name: "alt-backspace" });
			else if (next >= " ") events.push({ type: "key", name: `alt-${next}` });
			else events.push({ type: "key", name: "escape" });
			i += 2;
			continue;
		}
		const code = char.charCodeAt(0);
		if (code === 13 || code === 10) {
			// A line end with more text behind it in the same read was not typed: it is text pasted by a terminal
			// that does not mark what it pastes. The whole run is taken as one piece, and nothing is sent.
			let next = i + 1;
			while (next < data.length && (data[next] === "\r" || data[next] === "\n")) next++;
			if (next < data.length && data[next] !== ESC && (data.charCodeAt(next) >= 32 || data[next] === "\t")) {
				let end = next;
				while (end < data.length && data[end] !== ESC && (data.charCodeAt(end) >= 32 || data[end] === "\t" || data[end] === "\r" || data[end] === "\n")) end++;
				const pasted = (text + data.slice(i, end)).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
				text = "";
				events.push({ type: "paste", text: pasted });
				i = end;
				continue;
			}
			flush();
			// Enter sends a carriage return; a line feed alone is Ctrl-J.
			events.push({ type: "key", name: code === 13 ? "enter" : "ctrl-j" });
		} else if (code === 9) {
			flush();
			events.push({ type: "key", name: "tab" });
		} else if (code === 127 || code === 8) {
			flush();
			events.push({ type: "key", name: "backspace" });
		} else if (code < 32) {
			flush();
			events.push({ type: "key", name: `ctrl-${String.fromCharCode(code + 96)}` });
		} else text += char;
		i++;
	}
	flush();
	return { events, rest: "" };
}

/**
 * @param {{ input: NodeJS.ReadStream, output: NodeJS.WriteStream }} streams
 */
export function createTerm({ input, output }) {
	let listener = () => {};
	let resized = () => {};
	let frame = [];
	let started = false;
	let pending = "";
	let escapeTimer;
	const write = (text) => output.write(text);
	const onData = (chunk) => {
		clearTimeout(escapeTimer);
		const { events, rest } = parseInput(pending + chunk.toString("utf8"));
		pending = rest;
		for (const event of events) listener(event);
		// What looked like the start of a sequence and got no end was the Escape key. Pasted text whose end has
		// not arrived is waited for, however long it takes.
		if (pending !== "" && !pending.startsWith(`${ESC}[200~`)) {
			escapeTimer = setTimeout(() => {
				const left = pending;
				pending = "";
				if (left === ESC) listener({ type: "key", name: "escape" });
			}, 40);
		}
	};
	const onResize = () => {
		frame = [];
		resized();
	};
	const enter = () => {
		// The alternate screen, no wrapping, mouse clicks and the wheel as SGR reports, pasted text between marks.
		write(`${ESC}[?1049h${ESC}[?7l${ESC}[?1000h${ESC}[?1006h${ESC}[?2004h${ESC}[2J${ESC}[H`);
		frame = [];
		// Ask the terminal for its background and text colours; the answers come in as replies (src/screen/theme.mjs).
		write(`${ESC}]11;?${ESC}\\${ESC}]10;?${ESC}\\`);
	};
	const leaveScreen = () => write(`${ESC}[?2004l${ESC}[?1006l${ESC}[?1000l${ESC}[?7h${ESC}[?25h${ESC}[0m${ESC}[?1049l`);
	return {
		get cols() {
			return Math.max(20, output.columns ?? 80);
		},
		get rows() {
			return Math.max(6, output.rows ?? 24);
		},
		on(handler) {
			listener = handler;
		},
		onResize(handler) {
			resized = handler;
		},
		start() {
			if (started) return;
			started = true;
			input.setRawMode?.(true);
			input.resume();
			input.on("data", onData);
			output.on("resize", onResize);
			enter();
		},
		stop() {
			if (!started) return;
			started = false;
			clearTimeout(escapeTimer);
			input.off("data", onData);
			output.off("resize", onResize);
			leaveScreen();
			input.setRawMode?.(false);
			input.pause();
		},
		/** Give the terminal back for a while (an editor), then take it again. */
		async away(work) {
			input.off("data", onData);
			leaveScreen();
			input.setRawMode?.(false);
			try {
				return await work();
			} finally {
				input.setRawMode?.(true);
				input.resume();
				input.on("data", onData);
				enter();
				resized();
			}
		},
		/**
		 * Write a frame: one string per row, each fitted and padded to the width. Rows that are as they were are
		 * not written again. `cursor` is where the cursor is left, or undefined to hide it.
		 */
		draw(rows, cursor) {
			let out = "";
			for (let y = 0; y < rows.length; y++) {
				if (frame[y] === rows[y]) continue;
				out += `${ESC}[${y + 1};1H${rows[y]}`;
			}
			frame = rows.slice();
			out += cursor === undefined ? `${ESC}[?25l` : `${ESC}[${cursor.y + 1};${cursor.x + 1}H${ESC}[?25h`;
			// The whole frame at once, on terminals that know how (others ignore the two marks): no half-drawn rows.
			write(`${ESC}[?2026h${out}${ESC}[?2026l`);
		},
		/** Forget what is on the screen, so that the next frame is written whole. */
		reset() {
			frame = [];
			write(`${ESC}[2J`);
		},
		/** A sequence for the terminal that is not part of a frame (the clipboard). */
		raw: write,
	};
}
