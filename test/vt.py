import json, os, pty, select, sys, time, re, fcntl, termios, struct, codecs
# usage: vt.py ROWS COLS STEPS_JSON command...
# A step is [wait, keys] or [wait, keys, false]: wait is text that must stand on the screen (or seconds), keys are
# typed then, followed by Enter unless the third entry is false. Prints JSON: the screen after each wait, and the end.
rows, cols = int(sys.argv[1]), int(sys.argv[2])
steps = json.loads(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ.pop("TMUX", None)
    os.execv(sys.argv[4], sys.argv[4:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
# A stateful decoder: a multi-byte character the pty delivers across two reads is not mangled into the screen.
dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
grid = [[" "] * cols for _ in range(rows)]
# The background each cell was painted with: None for the terminal's own.
back = [[None] * cols for _ in range(rows)]
pen = None
cur = [0, 0]
raw = b""
pending = ""
alt = False
after = ""
osc = []
modes = set()
sync = False
# CSI with its parameters, OSC up to its end, DCS, and APC (which pi-tui uses for marks of its own).
SEQ = re.compile(r"\x1b(?:\[([0-9;:?<>=]*)([A-Za-z~])|\](.*?)(?:\x07|\x1b\\)|P(.*?)\x1b\\|_(.*?)(?:\x07|\x1b\\))", re.S)
def background(args, now):
    # The background a colour sequence leaves the pen with: 48;5;N or 48;2;R;G;B sets it, 0 and 49 take it away.
    parts = args.split(";") if args else ["0"]
    i = 0
    while i < len(parts):
        p = parts[i]
        if p in ("", "0", "49"): now = None
        elif p == "38": i += 2 if parts[i + 1:i + 2] == ["5"] else 4
        elif p == "48":
            n = 2 if parts[i + 1:i + 2] == ["5"] else 4
            now = ";".join(parts[i + 1:i + 1 + n]); i += n
        elif p == "7": now = "inverse"
        i += 1
    return now

def feed(text):
    global pending, alt, after, sync, pen
    text = pending + text
    pending = ""
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\x1b":
            m = SEQ.match(text, i)
            if not m:
                # A sequence whose end has not arrived: short for a key or a colour, long for the clipboard.
                if (len(text) - i < 64 or text[i:i+2] in ("\x1b]", "\x1bP", "\x1b_")) and not re.match(r"\x1b[^\[\]P_]", text[i:i+2]):
                    pending = text[i:]
                    return
                i += 1
                continue
            i = m.end()
            if m.group(5) is not None:
                continue
            if m.group(3) is not None or m.group(4) is not None:
                osc.append(m.group(3) if m.group(3) is not None else m.group(4))
                # Asked for its background colour, this terminal answers when the test gave it one (VT_BACKGROUND=rrggbb).
                if m.group(3) == "11;?" and os.environ.get("VT_BACKGROUND"):
                    c = os.environ["VT_BACKGROUND"]
                    os.write(fd, ("\x1b]11;rgb:%s%s/%s%s/%s%s\x1b\\" % (c[0:2], c[0:2], c[2:4], c[2:4], c[4:6], c[4:6])).encode())
                continue
            args, final = m.group(1), m.group(2)
            # Asked whether it speaks the Kitty keyboard protocol, this terminal says yes when the test wants it to
            # (VT_KITTY=1): the keys the test sends are then in that encoding.
            if final == "u" and args == "?" and os.environ.get("VT_KITTY"):
                os.write(fd, b"\x1b[?7u")
            if final == "H":
                parts = [int(p) if p else 1 for p in (args.split(";") if args else [])]
                cur[0] = min(rows - 1, (parts[0] if len(parts) > 0 else 1) - 1)
                cur[1] = min(cols - 1, (parts[1] if len(parts) > 1 else 1) - 1)
            elif final == "m":
                pen = background(args, pen)
            elif final == "J":
                for r in range(rows): grid[r] = [" "] * cols; back[r] = [None] * cols
            elif final == "K":
                start = 0 if args == "2" else cur[1]
                for c in range(start, cols): grid[cur[0]][c] = " "
            elif final in "hl" and args.startswith("?"):
                if args == "?1049": alt = final == "h"
                # A frame is written between these two marks; the screen is looked at only when one is complete.
                if args == "?2026": sync = final == "h"
                # Which of the terminal's modes are switched on: the mouse, pasted text between marks.
                if final == "h": modes.add(args[1:])
                else: modes.discard(args[1:])
            continue
        if not alt:
            after += ch
            i += 1
            continue
        if ch == "\r": cur[1] = 0
        elif ch == "\n": cur[0] = min(rows - 1, cur[0] + 1)
        elif ch >= " ":
            if cur[1] < cols:
                grid[cur[0]][cur[1]] = ch
                back[cur[0]][cur[1]] = pen
                cur[1] += 1
        i += 1
def screen(): return "\n".join("".join(r).rstrip() for r in grid)
def pump(until, limit):
    global raw
    end = time.time() + limit
    while time.time() < end:
        if until is not None and not sync and (until in screen() or until in after): return True
        if select.select([fd], [], [], 0.05)[0]:
            try: data = os.read(fd, 65536)
            except OSError: return until is None
            feed(dec.decode(data))
    return until is None
shots = []
for step in steps:
    wait, keys = step[0], step[1]
    ok = pump(None, wait) if isinstance(wait, (int, float)) else pump(wait, 20)
    shots.append(screen())
    if not ok:
        shots.append("TIMEOUT waiting for: " + str(wait))
        break
    try:
        os.write(fd, keys.replace("<UP>", "\x1b[A").replace("<DOWN>", "\x1b[B").replace("<ENTER>", "\r").replace("<TAB>", "\t").replace("<ESC>", "\x1b").replace("<PGUP>", "\x1b[5~").replace("<CTRLT>", "\x14").replace("<CTRLC>", "\x03").replace("<CTRLX>", "\x18").replace("<CTRLV>", "\x16").replace("<CTRLD>", "\x04").replace("<CTRLJ>", "\n").replace("<PASTE>", "\x1b[200~").replace("</PASTE>", "\x1b[201~").replace("<NL>", "\r").encode())
    except OSError:
        pass  # the program left; the keys have nowhere to go
    if not (len(step) > 2 and not step[2]):
        try: os.write(fd, b"\r")
        except OSError: pass
pump(None, 3)
shots.append(screen())
try: os.kill(pid, 15)
except OSError: pass
# The last screen once more, row by row, with the background at the row's left edge, inside the margin, and at its middle.
painted = [{"text": "".join(grid[r]).rstrip(), "edge": back[r][0], "bg": back[r][3], "mid": back[r][cols // 2]} for r in range(rows)]
print(json.dumps({"shots": shots, "after": after, "osc": [o[:60000] if o.startswith("52;") else o[:60] for o in osc if not o.startswith("8;")], "alt": alt, "modes": sorted(modes), "painted": painted}))
