# Cartographer

A durable agent you start from a project folder. The program lives in one place, this folder, and is installed once. Each project gets only a brain folder, `.atlas/`, which holds the agent's memory of that project.

So far it has: install, launch from a project, the brain folder, chat, the ledger with goals, a plan that you authorize, and tasks that look at the project or, under an authorized plan, write and edit its files and run commands in sandboxed shell windows that keep running, with a checkpoint around each task and an undo. The agent keeps an atlas of the project (a tree of the files and a graph of what it has understood) and an assessment, it is told the time, and it manages its own context. On a terminal it runs in a full screen with tabs for the chat, the brain, the changes, the shell windows and the context. Plugins are not built yet (see [What is not here yet](#what-is-not-here-yet)).

## Install

Needs Node 22.19 or newer, git (for the checkpoints around change tasks), bubblewrap (the `bwrap` command) and `script` from util-linux, which every Linux has (both for running commands; without them everything else still works), and your model server (llama.cpp behind llama-swap, or any OpenAI-compatible server).

```sh
# Put this folder at ~/cartographer, then:
cd ~/cartographer
bash install.sh --server http://127.0.0.1:8888/v1 --model ByteShape
```

`install.sh` fetches the packages into `node_modules/`, marks `bin/carto` executable, links `~/.local/bin/carto` to it, and writes `config.json`. If `~/.local/bin` is not on your PATH it prints the line to add. Nothing is copied anywhere: to update, replace the files in this folder and run `bash install.sh` again.

Start it with `bash` as shown. A downloaded copy of this folder has lost its executable marks, so `./install.sh` and `carto` would both answer "Permission denied" until the script has run once.

Check the install without a model (about three and a half minutes):

```sh
npm test
```

## Use

```sh
cd ~/some/project
carto
```

The first run in a project names the folder it is about to use and asks before it creates anything:

```
No brain for this project yet. Set one up in /home/momo/some/project/.atlas? [Y/n]
```

Enter or `y` sets up the brain and starts a session. Anything else leaves the folder untouched. Later runs continue the session, from the project folder or any folder below it, and do not ask again. With `-p` or piped input there is nobody to ask, so the brain is set up without the question.

### The full screen

On a terminal `carto` takes the whole screen. `carto --plain` gives the line-by-line terminal described further down instead, and so does `"screen": false` in the settings; with `-p` or piped input it is always the plain one.

```
 1 Chat  2 Carto  3 Diff  4 Shells  5 Context                           Esc: commands · F1: keys

▎› add a seed option to the roller

 ▸ 14 calls · t3 · 1m 12s
◂ report t3  1,204 characters  (/report shows it)
● plan  ✓ p2 marked done by its task
◂ changed 2 files (+18 −3)  (/diff shows the changes, /undo takes them back)

The roller takes --seed now. Two tests cover it; both pass.

⠹ task p3 · edit src/roll.py · 38s · 31 tok/s
ctx ▮▮▮▯▯▯▯▯ 41k/100k · 1 goal · plan 2/5 · approved · 1 window, 1 busy · 2 wakes
→ task ›  type to speak to the agent while it works · Esc for commands
```

(An illustration of the layout, not a recorded run.)

| Tab | What it shows |
|---|---|
| **1 Chat** | What you and the agent say to each other, in full. What the agent does in between is folded: a run of calls is one line, `▸ 14 calls · t3 · 1m 12s`. The run that is going on is open by itself and shows its newest calls, and the reply that is being written is shown as it grows, whatever it holds: a note, a message to you, or the arguments of a call, such as the file a `write` is about to create |
| **2 Carto** | The agent's brain, one view at a time: Atlas (the graph, a node to a line), Ledger, Plan, Tree (the project's files, with folders that open), Assessment |
| **3 Diff** | What was changed, a file to a line, each opening to its own part of the patch: by the last step, in this session, or against the project's own git `HEAD` |
| **4 Shells** | The shell windows, live: what runs in each and for how long. Opened, a window shows its newest lines as they come |
| **5 Context** | What the agent sees: the request it was last sent, part by part. See [The Context tab](#the-context-tab) |

Tabs 2 to 5 are lists of items that fold. One item is selected, and the keys act on it: open it, fold it, open it in your editor, copy it. They are read again while they show: the brain every two seconds, Diff every five, Shells and Context more often.

**Two modes.** As in vi, and **Esc** goes from one to the other. The place to type, at the bottom, shows which you are in.

- **Typing** (how carto starts): every key is text for the agent. Enter sends. Alt-Enter, Shift-Enter or Ctrl-J breaks the line, and so does a backslash before Enter. Pasted text keeps its lines and is never sent by itself; a paste of more than ten lines shows as `[paste #1 +40 lines]` and is sent in full, and a tab in pasted text becomes four spaces. A slash at the start of a line lists the commands with what they do, and Tab completes a command, a command's own word (`/copy session`, `/kill` and a window's name), or a path in the project.
- **Commands**: every key is a command, and nothing is typed. The mode does not depend on the tab: you can type with the plan in view, and move through Chat with the keys.

Pasting always goes to typing, whatever the mode was. A terminal that does not mark what it pastes sends the lines as if they were typed; several lines arriving at once are taken as pasted for that reason, and stay together.

| In the commands mode | |
|---|---|
| `1` to `5` | Go to a tab |
| `[` and `]` | The previous and the next view inside Carto, Diff and Context (`H` and `L` do the same) |
| `j`, `k` | Move down and up over the items. `g` and `G` go to the first and the last |
| Enter, Space, `o` | Open what is selected, or fold it. `l` opens, `h` folds. In Chat, Enter on a call goes to the tab where that work lives (`write` and `edit` to Diff, `shell` and `window` to Shells, `plan`, `ledger`, `atlas` and `assess` to Carto, `context` to Context); a `read`, `search`, `list` or `task` opens in place to what it returned |
| `+` and `-` | Open everything, fold everything (`zR` and `zM` do the same) |
| Ctrl-D, Ctrl-U | Scroll half a page. Ctrl-F and Ctrl-B a page, Ctrl-E and Ctrl-Y a row |
| `/` | Search the tab that shows. Enter or Down goes to the next match, Up to the one before, Esc closes the search |
| `e` | Open what is selected in `$EDITOR` (or `$VISUAL`; `vi` when neither is set): a file of the Tree, a changed file at its first changed line, and a ledger entry, a plan item, a node or a paragraph of the assessment at the line where it stands in its file. The row under the tabs names the file |
| `y`, `Y` | Copy what is selected; copy the whole tab |
| `r` | Read the tab again |
| `:` | Type a command |
| `i`, `a`, Esc | Type |
| `?` | The keys, on a sheet over the screen |

| While typing | |
|---|---|
| Up, Down | Move in what you typed. On its first line, Up brings back what you sent before |
| Ctrl-P, Ctrl-N | Earlier and later lines you sent |
| Ctrl-A, Ctrl-E | Start and end of the line. Alt-B and Alt-F go a word back and forward |
| Ctrl-W, Ctrl-U, Ctrl-K | Delete a word, to the start of the line, to its end. Ctrl-Y brings back what was deleted, Ctrl-- undoes |

| In both modes | |
|---|---|
| Tab, Shift-Tab | The next and the previous tab. While you type, Tab completes instead once there is text |
| PgUp, PgDn, the wheel | Scroll. Ctrl-Home and Ctrl-End go to the top and the end. A bar shows at the right edge while a tab scrolls, and can be dragged |
| A click | On a line: select it, and open or fold it. On a tab's or a view's name: go there. In what you typed: put the cursor there. On the place to type, in the commands mode: type |
| Dragging | Selects text, and letting go copies it. A double click selects a word, a triple click a line |
| Ctrl-Shift-F | Search the tab that shows, on a terminal that can send that key; anywhere else, Esc and then `/` |
| Ctrl-T | Show or hide the agent's notes and the model's reasoning, where they stand. The first row says which, in passing; nothing is added to the conversation |
| Ctrl-C | Copy what is selected with the mouse. With nothing selected: stop the agent; with the agent at rest, leave |
| Ctrl-L | Draw the screen again |
| F1 | The keys, on a sheet over the screen |

**In tmux**, Esc is held back for a moment to see whether a sequence follows, by default for half a second. `set -sg escape-time 10` in `~/.tmux.conf` makes it immediate. A key pressed within that moment arrives together with the Esc, as Alt and that key; for the keys of the commands mode it is taken as Esc and then the key, so `Esc` `5` goes to the Context tab however fast you press it. (The exceptions are the letters the editor uses with Alt: `b`, `f`, `d` and `y`.)

Every command of the plain terminal works when typed and sent, from any tab, and prints into Chat.

**Leaving.** When carto leaves, the terminal gets its screen back, and the conversation is printed there as it stood, runs folded as they were, so that it is in the terminal's own scrollback.


**The strip** above the place to type is always there. Its first row begins with a mark that turns while the agent works and stands still while it rests, and says what the agent is doing and where: the task and its plan item, the call that runs or is being written, how long this has been going on, and how fast the model writes. While the server reads a long prompt, the row shows that instead (see [Reading the prompt](#reading-the-prompt)). When the agent waits for your answer, the row says so and since when. The second row shows how full the context is, the open goals, the plan's progress and whether it waits for `/approve`, the shell windows, the wakes, and what is switched off (approval, the sandbox, the notes).

#### How it looks

The screen has an empty margin of two cells at its left and right, and on a screen of sixteen rows or more an empty row under the tabs, above the strip, and under what you type. On a screen narrower than thirty cells the margin is left out. Kinds of text are told apart in three ways, and no colour is chosen by itself:

| | |
|---|---|
| How much it matters | Three levels of text. Plain: what you and the agent say. Muted: what Cartographer reports (a task's report line, the files it changed). Faint: notes, hints, what is folded away. The levels are the text colour moved toward the background |
| Whose it is | One hue each for you (blue), the agent's tools (teal), its notes (violet), and the three signals: done (green), attention (amber), failed (red). All hues have the same lightness and strength, so none is louder than another by accident. A hue is used at full strength for a mark or an edge and faintly as the background of the whole block |
| Where it is | The row of tabs and the strip, the place to type, and an opened item each have a background a step away from the screen's own. The more a thing is chrome and the less it is content, the further |

So what you said is a block in your hue with its left edge drawn; a run of calls is a block in the tools' hue; what the agent says stands on the screen's own background in plain text, which makes it the easiest thing to read; a warning is in the colour of attention. Blocks of different kinds stand an empty row apart, and what a task left behind stands directly under its run. The only filled, saturated shapes are the name of the mode and the tab that shows. What is selected has a background of its own instead of swapped colours.

What the agent says is rendered as Markdown: headings, lists, bold, code, tables.

The colours are computed for your terminal. carto asks it for its background and text colours and builds the palette from them, so the blocks sit on your theme and are not a theme of their own. A terminal that does not answer gets a dark palette, or a light one when `COLORFGBG` says so. On a theme whose text is not far from its background, the blocks are fainter, so that text on them stays readable.

| Setting | |
|---|---|
| `"colors": "auto"` | Exact colours when the terminal says it has them (`COLORTERM=truecolor`), else the nearest of 256, which keeps the steps of lightness and loses the tints. `"truecolor"` and `"256"` say it yourself. `"none"`, or `NO_COLOR` in the environment: the terminal's own sixteen colours and no backgrounds |
| `"theme": "auto"` | `"dark"` or `"light"` says which palette, and the terminal is not asked |

In tmux, exact colours need tmux to know that the terminal outside has them: `set -as terminal-features ",*:RGB"` in `~/.tmux.conf` (older versions: `terminal-overrides ",*:Tc"`). None of this has been run inside tmux here. If the blocks look banded or wrong there, `"colors": "256"` is the safe setting, and `"theme"` says the background when tmux does not pass the question on.

#### The Context tab

```
 Window  Main agent  Parts    [ ] change view
What the main agent sees  ·  about 41k of 100k tokens (41%)  ·  the server counted 41k
request 23 of this run, sent 14:02 (just now), as the server got it · part sizes are estimates
■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□
■ System prompt ...........  2.8k  2.8%   ■ Tools ...................  6.3k  6.3%
■ Kept by a collapse ......  4.1k  4.1%   ■ Tool results ............   26k   26%
■ State block .............   1.2k 1.2%   □ Free ....................   59k   59%
▸ ■  2.8k  System prompt  You are Cartographer, an agent working in one project directory …
▸ ■  6.3k  Tools · 18: chat, ask, task, return, ledger, plan, atlas, assess, read, search, …
▸ ■  4.1k  What the last collapse kept  <context> Written by Cartographer, not by the user …
▸ ■    31  You  add a seed option to the roller [sent Thu 12 Nov 2026, 14:01]
▸ ■    58  Agent · note and call: task  The roller needs a look first.
▸ ■  1.9k  Result of task  The roller is src/roll.py; it reads no arguments yet …
```

(An illustration of the layout, not a recorded run.)

The **Window** view is the request the agent was last sent, exactly as the server got it, in the order the model reads it. While a task runs it is the task's request, because the task is then the one that is working; **Main agent** always shows the main agent's. Each part is one line: its colour, about how many tokens it is, what it is, and how it begins. Enter opens a part to its full text, and `+` opens all of them, which makes the tab the whole context window, word for word, to scroll through; `-` folds it again. What is open stays open as new requests come in, so you can watch a part change.

The parts are the system prompt, the tools with their descriptions and schemas, and then every message. The blocks that Cartographer adds to messages are parts of their own, cut off the message they ride on: the copy of the assessment and the graph, what the last collapse kept, the state block, the windows block. Below a rule follows what has come since that request and will be in the next one: the reply, as far as it is written while it is being written, and what its calls returned.

The row of squares is the whole window from its first token to its last, each square the same number of tokens, coloured by the part that lies there, with the free space at the end. It is a row and not a grid because the context is a row. The list under it says what each colour is, how many tokens, and what share of the window.

The sizes of the parts are estimates, four characters to a token; the first line also gives the server's own count after its last reply. After a collapse at rest the view still shows the last request, which was sent before the collapse, and says so: nothing has been sent since.

**Parts** is what `/context` prints: the sizes as the context engine counts them, the kept reports, and when the next collapse is due.


**Copying.** Drag over text to select it, and it is copied when you let go: the margin, the edge of a block and the spaces a row is filled with are left out. Whole things are copied with a command or a key:

| | |
|---|---|
| `/copy` | The agent's last message |
| `/copy session` | The whole session as Markdown: what was said in full, one line for each call |
| `/copy report` | The last task's report |
| `/copy tab` | The tab that is showing |
| `y`, `Y` | In the commands mode: what is selected (a message, a run of calls, one call with what it returned, an item of tabs 2 to 5), and the whole tab |

Those also write a file under `.atlas/export/`, and the line they print names it. The clipboard is reached through the terminal (OSC 52), through tmux's own buffer when carto runs in tmux, and through `wl-copy`, `xclip`, `xsel` or `pbcopy` when one is installed. In tmux, OSC 52 needs `set -g set-clipboard on` in `~/.tmux.conf`; without it, paste from tmux's buffer (prefix, then `]`) or take the file.

**What you send while the agent works** goes to whoever is working. If a task is running, the task reads it with the result of its current step, and the main agent is told about it with the task's report. Otherwise the main agent reads it after its current step. When the agent has put a question to you with `ask`, the next thing you send is the answer.

What the full screen does not do yet: it does not replay earlier sessions (Chat starts with this run of carto), and the Shells tab cannot type into a window.

### The plain terminal

With `--plain` the screen looks like this (an illustration of the layout, not a recorded run):

```
Cartographer · /home/momo/some/project
new brain /home/momo/some/project/.atlas · ByteShape at http://127.0.0.1:8888/v1
Type a message. /help lists commands. Ctrl-C stops the agent; again leaves. Ctrl-T hides and shows its thinking.
› where is the config loaded?
┊ The user wants the place where configuration is read. I have no node for it yet, so a look task.
▸ task  Find where configuration is loaded. Report the file, the function and the line numbers…
│ search /config/ in src                           → 14 matches in 5 files of src.
│ read src/config.ts, src/main.ts                  → 212 lines
◂ report  1.3k characters  (/report shows it)
Configuration is loaded in src/config.ts by loadConfig() (lines 20-58) …
  context 3.4k of 100k tokens · 412 read for this answer
›
```

| You see | Meaning |
|---|---|
| `▸ task …` | The main agent handed a piece of work to a task; the text is the start of its brief. `▸ task p2 …` carries out plan item p2 |
| `│ …` | One step of the task: what it looked at or wrote, and what came back |
| `│ $ …` then `│   → exit 0 · 0.4 s · …` | A command a task types into a shell window: shown when it starts, then how it ended, how long it took and the last line it printed. `(window server)` after the command names a window other than `main` |
| `│   → still running after 30 s · …` | The call returned and the command goes on in its window |
| `│ window server  wait` | A task, or the main agent, deals with a window: read, wait, send, stop, close |
| `◂ still running: window server` | Under a task's report: the windows it left at work |
| `◆ Window build: … ended with exit 0 after 2 m` | A command ended, or a program asks for input, while the agent was resting. The agent is woken with this line |
| `◆ Wake w1 (every 5 m): its time came. Your note: …` | A wake the agent set has fired. Resting, the agent gets a turn for it; with `(the agent is working: …)` behind the line, it reads the firing at its next step instead |
| `● wake  + w1 every 5 m, until removed · …` | The agent set a wake (`+`) or removed one (`-`) |
| `● resting · next wake in 4 m` | The agent called `sleep`: it found nothing to do and ended its turn |
| `◂ window build changed 2 files … with no task running` | What a window did to the files after its task was over, recorded as a step of its own |
| `┊ …` | The agent's own text: the model's reasoning and whatever it writes outside a `chat` call. Dim, and not an answer to you. Ctrl-T or `/thinking` hides and shows it; hidden, a reply that thought prints one line, `┊ thinking…` |
| text with no mark | What the agent says to you, with its `chat` tool |
| `◆ That reply had no tool call …` | The agent wrote text without a call: a note to itself. Said once in a turn; the turn goes on |
| `? Which port?` with numbered choices | The agent called `ask` and waits. Type a number or an answer of your own |
| `! The agent's reply was repeating itself …` | The reply was cut off; see [A reply that repeats itself](#a-reply-that-repeats-itself) |
| `! The agent made 40 replies in this turn …` | The turn was ended at `mainTurns`. Say "continue" to let it go on |
| `● atlas  created src/roll/dice.py, empty …` | A node was linked to a file that did not exist, and the plan is authorized, so the file was made |
| `● plan  ✓ p2 marked done by its task` | The task returned with `done` true. `● plan  p2 stays open …` when it returned not done |
| `! Cartographer ended the turn: the same call was sent 3 times …` | The agent sent the same call three times and it failed each time. Its turn is ended; inside a task, the task is ended and the main agent is told why |
| `◂ report t3 …` | The task reported, and the report is kept as `t3`. `/report` prints the last one in full, `/report t3` that one |
| `◂ shelf  the task added src/roll.py` | A task put a file on the main agent's shelf; see [The context](#the-context) |
| `◆ context collapsed (goal g1 was closed): about 41k → 12k tokens · kept …` | The agent's context was replaced by what a collapse keeps. The reason is in the brackets |
| `◆ asked before collapsing (…): does it need to write something down first? no · 1.2 s` | The one question before a collapse, the agent's answer, and how long the server took for it |
| `read ahead by the server: 12k tokens in 16 s, so the next answer starts at once` | After a collapse at rest the server has read the new context already |
| `│ ◆ the task's steps collapsed (…)` | A task's own steps became one block of notes, because its context was nearly full or because it asked |
| `● context  shelved src/roll.py · about 310 tokens` | The agent used its `context` tool: recalled a report, marked a file for its shelf, dropped a result, or asked for a collapse |
| `◂ Cartographer ended the task: …` | The task used all its replies without calling `return`, wrote the same note three times, or sent the same failing call three times. The main agent gets what the task had noted, and nothing is marked done |
| `◂ changed 2 files (+37 −1)` | What a change task did to the files, taken from the checkpoints and not from its report. The files are listed below it |
| `● ledger  + goal g1 …` | The agent changed its ledger: `+` added, `✓` closed, `~` reworded, `-` removed |
| `● plan  + p2 [change] …` | The agent changed its plan, with the same signs. `[change, network]`: the item's commands may reach the network. `[change, standing]`: a duty that stays open and may be carried out again and again |
| `◂ atlas  wrote roller, cli` | What a task did to the graph: nodes it wrote or removed, and nodes its changes left possibly out of date |
| `● atlas  + component roller …` | The main agent changed the graph itself: `+` written, `~` rewritten, `-` removed, `✓` confirmed. Also where it moved the tree |
| `● assessment written, 310 characters` | The main agent replaced its assessment |
| `● top of the context rewritten` | The copy of the assessment and the graph at the start of the agent's context was replaced with the current ones. The next answer reads the whole context again |
| `atlas: 3 nodes · assessment written 2 h ago` | At the start: what the atlas holds |
| `plan  2 change items wait for you` | The plan needs your `/approve` before those items can run |
| `approval: OFF (yolo) · …` and the prompt `[yolo] ›` | You have switched approval off: change items run without `/approve` |
| `context … · … read for this answer` | How full the context is, and how many tokens the server had to read rather than reuse for the last answer |

| Command | |
|---|---|
| `/thinking`, `/thinking on`, `/thinking off`, Ctrl-T | Hide or show the agent's own text. Switching it on prints what the newest turn held back |
| `/report`, `/report t12` | The last task's report in full, or the kept report with that id |
| `/context` | What the agent's context holds, part by part with sizes; the kept reports; when it was last collapsed and when it will be next |
| `/collapse` | Collapse the agent's context now. Works while the agent is idle |
| `/ledger` | Goals, questions and notes, open and closed, and where the file is |
| `/plan` | The plan, whether it is authorized, and where the file is |
| `/atlas` | The tree as the agent sees it, the graph, which nodes may be out of date, and where the file is |
| `/assessment` | The agent's assessment of the project, and whether the copy in its context is current |
| `/pin` | Replace the copy of the assessment and the graph at the start of the agent's context with the current ones now. Works while the agent is idle |
| `/approve` | Authorize the plan as it stands. Its change items may then run, and the agent is told to start |
| `/yolo`, `/yolo on`, `/yolo off` | Show, switch off or switch back on the need for `/approve`. For when you are watching; see [Without approval](#without-approval-yolo) |
| `/wakes`, `/wakes remove ID`, `/wakes remove all` | What the agent has set to wake itself, and taking one or all of them away |
| `/diff` | What the last change task did to the files, as a patch; or a shell window, when that is the newest step. `/diff all` shows a long patch in full |
| `/undo` | Take the last step back: a change task, or what a shell window changed with no task around. Again for the one before it |
| `/bwrap` | How the tasks' commands run. `/bwrap off` runs them without the sandbox, `/bwrap on` with it again |
| `/shells` | The shell windows: what runs in each, for how long, and its newest lines |
| `/kill NAME`, `/kill all` | Close a shell window, or all of them, and end what runs there |
| `/stop`, Ctrl-C | Stop what the agent is doing. A command it was waiting for is interrupted; other shell windows keep running |
| `/new` | Start a fresh context: the current assessment and graph, and nothing else in view. The record of finished tasks, the shelf and the talk start empty; the reports stay in `.atlas/reports/` |
| `/status` | Messages in view, context size, working or idle, how many shell windows are open, how many wakes are set, whether approval is off |
| `/quit`, Ctrl-C when idle | Leave |

### How the agent talks to you

The agent has three kinds of output.

- **A note to itself.** Text without a tool call. You see it dim behind `┊`, together with the model's reasoning; nobody answers it. In the agent's own context it stands as "Note to self: …", and Cartographer follows it with one line so that the agent goes on. Notes are how a model without reasoning thinks in words. They are dropped when the context is collapsed.
- **`chat`**: what it wants you to read. It does not wait for you. A reply whose only call is `chat` ends the main agent's turn, and you speak next; `chat` beside another call tells you something and goes on working. A task can use `chat` too and carries on after it.
- **`ask`**: a question it cannot go on without. The call waits until you answer, and your answer is its result. With `choices` you can answer with a number; you can always type something else. In the full screen the strip says that the agent waits and since when. `askMinutes` in the settings makes it give up after that many minutes and tell the agent to go on without an answer; the default is to wait without limit. `/stop` ends the wait. With piped input, the next line is the answer.

What is said with `chat` and `ask`, and what you answer, is kept as the conversation with you: a collapse keeps the last of it word for word.

The main agent ends its turn with a lone `chat` or with `sleep`. Since a note never ends a turn, two limits stand behind it: a turn ends after `mainTurns` replies, notes included, and at once when the agent writes the same note three times in a row. A turn that a wake started and in which the agent did nothing but write is a rest already.

### A reply that repeats itself

A local model sometimes loses its way and writes the same character or phrase until it is stopped. Cartographer watches every reply as it grows, the main agent's and a task's, including the text inside a call's arguments. When the end of it is one character about 80 times, or one phrase of up to 40 characters eight times and at least 80 characters of it, the reply is cut off and thrown away, and the agent is told what happened and gets one more try. The second time in a row, the agent is stopped and you decide. Rules, indents and rows of zeros in code do not count. `"repeatCut": false` switches this off.

### Calls that fail again and again

When the agent sends the same call, with the same arguments, three times and it fails each time, with no call succeeding in between, Cartographer ends the turn and says so on the screen. The agent finds the reason in the call's result when it works next. A new message from you starts the count again. Three such calls in one reply end the turn with that reply. Inside a task the task ends, and the main agent is told the call, the error, and the last thing the task wrote.

A reply that repeats one character or one line without end is not caught yet; that needs the live stream and comes with the interface work.

You can type while the agent works. The message reaches the main agent after its current step, which means after a running task has reported.

If you leave, or the program is killed, while the agent is working, the work is not lost: the next `carto` in that project continues it.

Other ways to run it:

```sh
carto -p "what does this project do?"    # one message, print the answer, leave
carto --where                            # show the core, project and brain folders; do nothing
carto --no-bwrap                         # run the tasks' commands without the sandbox
carto --here                             # use the current folder as the project, whatever is above it
carto --url URL --model NAME             # another server or model for this run
```

### Which folder is the project

Going up from the folder you are in, the first folder that has a Cartographer brain or is the top of a git repository. If there is none, the folder you are in.

- The search stops before your home folder and before `/`. A brain or a repository there never becomes the project of the folders below it.
- A brain is an `.atlas/` folder that holds `session.sqlite`. An `.atlas/` folder with other contents does not count (see the next section).
- Your home folder and `/` are refused as projects unless you pass `--here`.
- `carto --here` uses the folder you are in, whatever is above it.
- `carto --where` shows which folder would be used and why, and creates nothing.

## How it works

One main agent talks with you. It sees the file tree and its own notes about the project, and it cannot read or change a file itself. To get anything done there it calls `task` with a brief.

A task is a fork of the main conversation at the `task` call. Its prompt is the main agent's prompt up to that point, then the brief, so the server reuses everything it has already read and a task starts for the cost of its brief. The task works in the fork with its tools and ends by calling `return`; the report it gives there goes back to the main agent as the result of the call. The task's working steps, including the text of every file it reads or writes, never enter the main agent's context.

| Tool | Who | What |
|---|---|---|
| `task` | main agent | Hand one piece of work to a task. Tasks run one at a time |
| `ledger` | main agent | Add, close, reword or remove ledger entries |
| `plan` | main agent | Add, reword, finish or remove plan items; clear the plan |
| `assess` | main agent | Replace the assessment of the project |
| `atlas` | main agent, any task | Write, link, confirm, remove and read nodes of the graph. The main agent also moves the tree with it |
| `read` | any task | Text files with line numbers, up to 8 per call, 300 lines each unless a range is given |
| `search` | any task | A regular expression over the project's files; returns `path:line: text` |
| `list` | any task | The files as a tree with sizes |
| `write` | change task | Create a file, or replace one completely |
| `edit` | change task | Replace one passage of a text file; the passage must match exactly one place |
| `shell` | change task | Type a command into a shell window; returns what it printed and its exit status, or that it is still running |
| `window` | main agent, any task | Read a window, wait for its command, stop it, close it. Typing a line into a running program (`send`) is for a change task |
| `wake` | main agent | Set or remove a wake: after a time, when a file changes, when a shell window prints something |
| `sleep` | main agent | End the turn and rest until something wakes it |
| `chat` | main agent, any task | Say something to you. Does not wait |
| `ask` | main agent, any task | Put a question to you, with optional choices, and wait for the answer |
| `return` | any task | End the task: the report, whether the brief is carried out, and optionally one or two lines to remember the task by |
| `context` | main agent, any task | Recall a kept report, keep a file on the shelf, drop a large result, collapse now. A task reaches only its own steps with it |

`read`, `search` and `list` refuse any path outside the project, including through a symlink, and leave out `.atlas/` and files that git ignores. `write` and `edit` have the stricter rules described under [The plan and changing the project](#the-plan-and-changing-the-project), and `shell` those under [Running commands](#running-commands).

All eighteen tools are in every request, the main agent's and a task's alike, and a call that is not the caller's is refused with a line that says whose it is. They are not split into two lists, because of where the chat template puts them: at the very top of the prompt. A task with a different list would begin with different text than the conversation it forks from, so the server would read the whole context again when a task starts and again when it ends, which on a full context is minutes each time. One list keeps a task's start at the cost of its brief.

### How a task goes

A task's brief begins with how a task goes, then says which kind it is, then shows one short example of that kind of task on a plainly different project, from the first step to `return`. After that:

- Text without a call is a note to itself, as for the main agent, and never ends the task.
- `chat` and `ask` reach you from inside the task.
- `task`, `ledger`, `plan`, `assess`, `wake` and `sleep` are the main agent's. A task that calls one is told so and goes on, however often it tries. (The same call failing three times in a row ends it, like any other failing call.)
- **`return` ends it**, and nothing else does. `report` is required and is all the main agent gets. `done` says whether the brief is carried out: for a plan item, `true` marks the item done and `false` leaves it open, and the main agent is told which. `summary` is the line that is kept of the task after the main agent's context is collapsed; without it, the start of the report is used. `shelf` names files on the task's shelf to put on the main agent's shelf as well. A `return` in a reply with other calls ends the task after they are carried out.
- A task has `taskTurns` replies, notes included. From three before the end, each result says how many are left and asks for `return`. A task that uses them all is ended; the main agent then gets the notes the task wrote, marked as not a report, and nothing is marked done.
- What you type while a task runs goes to the task with its next result, and the main agent is told with the report.

The session is stored by [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) in one SQLite file.

The full screen is built on [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui), the terminal library pi itself uses. pi-tui owns the terminal: it reads the keys in whatever way the terminal speaks (the Kitty keyboard protocol where there is one), lays the parts of the screen out, scrolls them, selects and copies text with the mouse, searches, lays sheets over the screen, edits what you type, renders the agent's Markdown, and writes only the rows that changed. Cartographer's own is what the tabs hold, the two modes, and the colours (`src/screen/`). pi-durable itself does not use pi-tui.

## The ledger and goals

The ledger is the agent's memory of the project across sessions. The conversation is disposable; the ledger is what stays. It holds three kinds of entry:

| Kind | | |
|---|---|---|
| goal | `g1` | Something you want achieved, with a "done when" line saying how you will both know it is reached |
| question | `q2` | Something the agent needs to ask you |
| note | `n3` | Anything else worth keeping: a decision, a preference, a finding |

It is a notebook, not a gate. Nothing in it stops the agent from working, and the agent needs no permission to write to it. The agent is told to record a goal once you have agreed to its wording, to change that wording only when you ask, and to write down what you say that should outlast the conversation. Every change it makes is printed as a `● ledger` line, so you see what it understood.

When there is no open goal, `carto` says so at the start, and the agent is told to answer what you ask and to find out what you want to achieve. When it closes a goal, it is told to say what was achieved against the done-when line and to ask whether that is what you wanted.

**Editing it yourself.** The ledger is `<project>/.atlas/carto-ledger.json`. Change it in any editor, or tell the agent what to change. The file is read again at every step, so an edit takes effect at the agent's next request. An entry needs only `id` (like `g1`, `q2`, `n3`), `kind` and `text`; a goal also takes `doneWhen`, and `"status": "done"` closes an entry. If the file cannot be read after an edit, `carto` and the agent both say what is wrong, and nothing writes to the file until it is repaired.

Limits: 400 characters per entry, 40 open entries, and the newest 50 closed entries are kept.

## The plan and changing the project

Nothing in the project is changed, and no command is run, without a plan that you have authorized. This is the one gate in Cartographer.

**The plan** is a short list the agent writes for the open goals. Each item is one piece of work for a single task, marked `look` or `change`:

```
● plan  + p1 [look] See how arguments are parsed today
● plan  + p2 [change] Write roll.py with the roller and its argument check
● plan  + p3 [change] Describe the command in the README
plan  2 change items wait for you: /plan shows the plan, /approve authorizes it
```

Look items, and tasks that belong to no item, can run at any time. A change item can run only after you type `/approve`. Saying yes in the chat does not authorize; the agent is told to ask you for the command. The agent cannot authorize its own plan: no tool does that. If you type `/approve` while the plan holds no open change item, nothing is authorized and the agent is told so in a message sent for you: a model sometimes describes its plan in the chat without writing it, and this gives it the turn to write it.

Your authorization covers the change items as they stood when you gave it. When the agent adds a change item, rewords one, turns a look item into a change item, or gives an item the network, the authorization is withdrawn, the screen says so, and the agent is told to explain the change and ask you again. Finishing or removing items, and anything done to look items, leaves it in place.

**A standing item** is a change item for a duty rather than a piece of work: "keep the server running", "restart the worker when it stops". The agent marks it `standing`, and it shows as `[change, standing]`. It needs your `/approve` like any change item, and the line that asks says how many items are standing. Once the plan is authorized, the agent may start a task for a standing item as often as its text calls for it, until it marks the item done, which ends the duty. An ordinary item is for work that is done once. Making an item standing withdraws the authorization, like any change that asks for more than you agreed to. One thing to know: the authorization covers the plan as a whole, so when the agent adds another change item, the standing item also waits until you have typed `/approve` again. Together with a wake (see [Waking up](#waking-up)), a standing item is how the agent looks after something while you are away, without approval being switched off.

**A change task** is a task started for a change item of an authorized plan. It has `write`, `edit` and `shell` besides the three look tools, and may type into a shell window with `window`. Who may write is decided when the call is made, by the program:

- The main agent never writes. Neither does a task without an item, or a task for a look item.
- A path outside the project is refused, also through a symlinked folder, and so is a symlink itself.
- `.atlas/` and any `.git/` folder are refused.
- A file that git ignores is refused, because a checkpoint would not hold it and the change could not be undone. `node_modules/` counts as ignored. For the same reason, so is a file inside a folder that is a git repository of its own.

**Checkpoints.** Before a change task starts, Cartographer records every file of the project, and again when the task ends. The difference between the two is added to the task's report as "Cartographer's record of the files changed", so the main agent learns what was changed from the record and not from the task's own account, and the screen shows the same list. A task that claims a change it did not make is contradicted by the record.

The checkpoints are kept in a git repository of Cartographer's own, `.atlas/checkpoints.git`, with the project folder as its work tree. It works whether or not the project is a git repository, and your own repository is never touched: no commit, no ref, no change to its index. There a change task's work shows up as ordinary uncommitted changes, yours to commit. Files are stored and restored byte for byte, whatever the project's `.gitattributes` says about line endings.

**Undo.** `/undo` takes the last change task back: every file it changed becomes what it was before, and files it created are removed, along with folders that leaves empty. Files the task did not touch stay as they are, including your own edits made since. `/undo` again takes back the task before it. An undo:

- records the files as they are first, so nothing is lost by it;
- reopens the plan item and marks it "undone by the user", which the agent sees at its next step. An item the agent had already cleared from its plan is put back;
- withdraws the authorization, so the agent changes nothing more until you have said what you want and typed `/approve` again.

A task that you stopped, or that was cut off by a kill, has no checkpoint after it. `/diff` then compares with the files as they are now, and `/undo` puts the whole project back to the checkpoint before that task, which also takes back edits you made since.

The checkpoint history only grows, so every recorded state can be reached with git: `git --git-dir .atlas/checkpoints.git log`.

**Editing the plan yourself.** The plan is `<project>/.atlas/carto-plan.json`, read again at every step. An item needs `id` (like `p3`), `mode` and `text`; `"status": "done"` finishes it, `"network": true` on a change item lets its commands reach the network, and `"standing": true` makes it a standing item. The `authorized` field is the authorization: you can set or delete it by hand. Limits: 300 characters per item, 30 items.

Limits of this version:

- One `write` call must fit in one reply of the model (`maxTokens`, 8192 by default, thinking included). A task whose reply is cut off there ends, and the main agent is told the cause and to have the file written in parts. How the model handles this in practice is untested.
- The first checkpoint copies every file that is not ignored. In a project with large files that are not ignored, it takes time and space.

### Without approval (yolo)

`carto --yolo`, or `/yolo on` in a session, switches the gate off: the agent's change items run without `/approve`. It is meant for when you are present and watching the screen. `/yolo off` switches it back on, and `/yolo` shows the setting.

What it changes:

- A change item runs as soon as the agent starts its task. That includes items marked `network`, whose commands reach the internet, and standing items.
- The agent is told in its state block that approval is off and that it should not ask for `/approve`. If it was resting in front of a plan that waited for you, `/yolo on` tells it to go on.
- The prompt reads `[yolo] ›`, the header and `/status` say `approval: OFF (yolo)`, and no line asks you for `/approve`.

What it does not change:

- Every change is still a plan item carried out by a task. So there is still a checkpoint before and after each one, `/diff` shows what it did, and `/undo` takes it back. After an undo the item is open again and the agent may carry it out again, so say what you want instead.
- The main agent still cannot read, write or run anything itself.
- The sandbox is a separate switch (`/bwrap`). With both off, commands run directly on your machine and nothing asks you first; `/yolo on` says so when that is the case.
- The plan's own authorization is not set by it. When you type `/yolo off`, change items that you never approved wait for `/approve`; a task that is running at that moment finishes.

Only you can switch it: no tool does, and it is not remembered. The next `carto` asks for approval again.

## Running commands

A change task runs commands with `shell`: to try what it wrote, to run tests, to install what a plan item calls for, to start a server, and to move or delete files.

```
▸ task p2  Write roll.py and run it with 2d6 and with a wrong argument…
│ write roll.py                                    → 12 lines, a new file
│ $ python roll.py 2d6
│   → exit 0 · 0.1 s · 7
```

### Shell windows

A command is typed into a **shell window**: a bash that stays open under a name, like a terminal tab. `shell` takes the command, the window's name (`main` when none is given; a name that is not open yet opens a window) and how long to wait.

- **The window keeps its state.** The folder and the environment stay from one command to the next, so `cd` and `export` last. The line under each result says where the window stands: `[exit 0 · 0.4 s · window main, in src/]`.
- **A command is not tied to the call that started it.** The call waits for the command to end, 30 seconds unless the task names another time (the `shellWait` setting, at most 300). A command that has not ended by then keeps running in its window, and the call returns what it printed so far with `still running`. The task goes on with other work, in other windows too. So a server, a watcher or a long build is started in a window of its own with a short wait.
- **`window` reaches a window later.** `read` shows its newest lines. `wait` returns when the command ends, when a line containing a given text appears (`until`, for "server ready"), or after a time. `send` types a line into the program that is running, for one that asks a question or reads commands. `stop` presses Ctrl-C. `close` ends the window and everything in it. Each call returns what was printed since the last call on that window, so nothing is shown twice and nothing is lost between calls.
- **A program that asks.** A window is a real terminal, so a program can ask a question. When a program prints a line without a line end and then goes silent, the call returns after a second and a half and says that it may be waiting for input.
- **A window that is busy takes no second command.** The refusal says what to do: another window name to run beside it, or `window` to wait for it or stop it.
- **`exit` closes the window**, because it ends the window's own bash. The result says so, and the next `shell` call opens the window anew at the project root. `false` or `(exit 3)` gives a status without that.
- **At most 4 windows** are open at a time. Each keeps its newest 2,000 lines.

**What the agent sees.** While a window is open, every request ends with the windows as they are at that moment. That holds for the main agent and for every task, so whoever started a command sees how it is doing each time it thinks, without a call to ask:

```
<windows>
Written by Cartographer, not by the user. The shell windows as they are at this moment:
  main · free, in src/ · last: `npm test` ended with exit 1, 2 m ago
    | 2 failed, 14 passed
  server · busy for 4 m 10 s with `python -m http.server 8000` · network
    | Serving HTTP on 0.0.0.0 port 8000 ...
    | 127.0.0.1 - - "GET / HTTP/1.1" 200 -
A window keeps running what was started in it until it is stopped or closed. Close the ones nobody needs any more.
</windows>
```

A busy window shows its newest 10 lines (the `windowTail` setting), a free one its last 3. For more than that there is `window` read.

The block is the very last thing in the request, after the main agent's state block, because it is what changes most: the server re-reads a prompt from the first changed character on, so a window that printed a line costs the block and nothing before it. It is built as the request is sent and never stored, so there is always one copy, the current one, and old output does not pile up in the conversation. By a rough count the block is about 260 tokens for one busy window with ten long lines and about 900 for four of them; that is read again with every request while the windows are open, and it is the price of the live view. With no window open there is no block, so a task that runs nothing costs what it did before.

The block shows the state when a request is sent. The agent does not see a window between two requests: during a long `shell` or `window` wait it sees nothing new until the call returns, and while it rests it is woken as described next.

**Waking up by itself.** The agent works only while it answers a message. When a command ends, a window closes, or a program asks for input while the agent is resting, Cartographer prints a `◆` line and sends the agent a note of its own, marked as written by Cartographer and not by you. The agent then acts on it or goes back to rest. So "start the build and go on when it is done" works without you. While the agent is already working nothing wakes it; the windows block of its next request shows the same news. Wakes the agent sets itself are described under [Waking up](#waking-up).

With piped input (`echo … | carto`) nobody is there to wait, and `carto` leaves after the last line, which ends the windows. A line `/wait 60` waits up to that many seconds for the windows' commands and for the wakes the agent has set, and lets the agent react to each.

**Who may do what.** Typing into a window, a command or a line of input, is for a task that carries out a change item of the authorized plan, as before. Reading, waiting, stopping and closing are open to the main agent and to every task, because none of them starts anything: the main agent can wait for a build itself, and stop or close what it no longer needs.

**You and the windows.** `/shells` lists them with their newest lines. `/kill NAME` closes one and ends what runs there, `/kill all` every one; the agent finds a line in its windows block saying that you closed it. `/stop` and Ctrl-C stop the agent and interrupt the command it was waiting for at that moment; commands in other windows keep running, and a line names them. Windows do not outlive `carto`: they end when you leave and when it is killed, and at the next start the agent is told which windows were running something and are gone.

**A window after its task.** A window that is still running when its task ends can go on changing files. Those changes belong to no task, so Cartographer records them as a step of their own, named after the window, when the command ends, before the next change task starts, and when you leave. `/diff` shows such a step and `/undo` takes it back like a task's, without touching the plan. Only windows that were running something count: what you edit yourself while every window stands free is never recorded as a window's doing. What you edit while a window is at work does land in that window's step, since Cartographer cannot tell who wrote a file. A process that a command left in the background of a free window (`… &`) is not noticed this way; its changes go unrecorded until the next task's checkpoint takes them as given.

**Who may run a command.** The rule is the same as for writing: only a task that carries out a change item of the plan you authorized. That holds for a command that changes nothing too, so "run the tests and report" is a plan item, and it waits for `/approve` like any other.

### Waking up

Besides the automatic wakes above, the agent can set its own with the `wake` tool. A wake does not make the agent wait: it sets one and goes on working, or ends its turn, and is told when the wake fires. Three kinds:

| The agent gives | It is woken |
|---|---|
| `every` (seconds) | each time that long has passed |
| `path` | when that file changes, appears or disappears; for a folder, any file under it. Inside the project only, and not `.atlas/` |
| `window`, optionally `match` | when that shell window prints something, or a line containing the given text. What was printed before the wake was set does not count |

Each wake has an id (`w1`), a note the agent writes to itself and gets back when it fires, and a number of times: 1 unless the agent says otherwise, and 0 for "until removed". With 0 the agent watches over something for as long as `carto` runs, without ever having to set the wake again. The agent removes a wake with the same tool; you list them with `/wakes` and remove one with `/wakes remove w1`, or all with `/wakes remove all`. At most 8 are set at a time (`wakesMax`).

**The least interval is one minute** (`wakeMin`), for a time wake and between two firings of a file or window wake. Every firing costs a whole turn of the model, and on a full context reading alone can take longer than that. A file or window that changes more often is not missed: what happened is held and told once the minute is over, with the newest change.

**How a firing reaches the agent** depends on what the agent is doing:

- Resting: Cartographer sends it a note, as for a command that ended. The note carries the wake, what happened and the agent's own note.
- Working: no turn is started. The state block of its next request has the firing under "Fired during this turn", and the screen shows the `◆` line with `(the agent is working: …)`.
- Waiting for a shell window with `window` wait: the wait ends early and its result names the wake, as it does for a message from you.
- While a task runs: the task is not disturbed, its own waits included. The main agent reads the firing with the task's report.
- Several firings of one wake before the agent could be told are one entry: "the last of 4 times since you were told".

**The `sleep` tool** ends the agent's turn at once, with no further request to the server. The agent is told to call it, and to write nothing, when a wake finds nothing to do.

**Quiet turns leave the context.** A turn that a note started and in which the agent did nothing (it called no tool, or only `sleep`) is quiet. When the next note arrives, the quiet turn is left out of what the model is sent. So twenty wakes that found nothing do not leave twenty exchanges behind: the context holds the wake's line in the state block, which says how often it fired, when last, and when the agent last acted on it, plus the newest note. A turn in which the agent did something stays, and so does a quiet turn that you answered. Only the request is shortened; the stored session keeps every turn. Leaving a turn out costs nothing extra: it was the last thing in the context, so the server re-reads only what replaces it.

```
Wakes
  w1 · every 5 m, until removed · check that the server answers · fired 37 times, last just now · you last acted on it 2 h ago · next in 5 m
  w2 · when window server prints a line with "ERROR", at most every 1 m, until removed · read the error and decide · not fired yet
```

**When it wakes too often.** An agent that reacts to every wake by starting something that wakes it again could run in circles. It is slowed down, never stopped: the first 12 wakes in quick succession go through at once, and after that one more is let through per minute (`wakeMin`), with everything that happened meanwhile told together. A line on the screen says when that begins, `/wakes` shows how long the next wake is held, and a message from you lifts it. A wake that fires every few minutes never reaches this.

**Between runs.** Wakes are kept in `.atlas/carto-wakes.json` and are there again at the next start. Nothing fires while `carto` is not running: a time that came due meanwhile fires once at the start, and a file wake compares with the files as they are then.

What this does not do yet:

- It saves context, not inference: each firing is still one request, and with a context that changed far back, a slow one.
- A wake turn in which the agent acts stays in the context like any other turn. An agent that acts on every wake fills its context until the context engine exists.
- Wakes belong to the main agent. A task cannot set one.
- With approval on and no standing item, a woken agent can look and report but cannot change anything until you are back. See [standing items](#the-plan-and-changing-the-project) and [Without approval](#without-approval-yolo).
- On the plain terminal a `◆` line that arrives while you are typing lands in the middle of your line. What you typed is still there and is sent when you press Enter.

### The sandbox

Every window is a [bubblewrap](https://github.com/containers/bubblewrap) sandbox of its own, unless you switch the sandbox off (below). Inside it, a command sees the machine like this:

| | |
|---|---|
| The project folder | Writable |
| `.atlas/` and `.git/` in it | Read-only. `git status`, `diff` and `log` work; committing, resetting and stashing do not, so your repository stays yours |
| The system (`/usr`, `/etc`, …) | Read-only |
| Your home folder | Not there. In its place is a home of the sandbox's own, `<project>/.atlas/home/`, which keeps what tools store there (package caches, settings) and is the same in every window |
| Toolchains in your home folder | Read-only: every `PATH` entry that lies in your home folder, and these folders when they exist: `.nvm` `.volta` `.bun` `.deno` `.rustup` `.pyenv` `.rbenv` `.asdf` `.sdkman` `.juliaup` `.ghcup` `.dotnet` `.local/lib` `.local/share/{mise,uv,pnpm,fnm}` |
| `/tmp`, `/var/tmp` | The window's own: empty when it opens, gone when it closes |
| `/run`, `/mnt`, `/media` | Empty: no sockets of your session, no other drives |
| The network | Off, unless the window was opened by a task whose plan item is marked `network` |
| Processes | Only the window's own. They end when the window is closed, and when Cartographer exits or is killed. What a command leaves in the background stays until then, as in any terminal |
| The environment | A short fixed list (`PATH`, `HOME`, `LANG`, …). No variable of your shell is passed on |
| Input | A terminal. A program can ask, and a change task can answer with `window` send. Programs that notice a terminal behave as they do for you: `ls` prints in columns. Colours and pagers are switched off |

If a program that works in your terminal is "not found" in the sandbox, it probably lives in a part of your home folder that is not in the list above. Name its folder in the `shellRead` setting.

**The network.** A plan item can be marked `network`, which the agent is told to do for steps such as installing packages:

```
● plan  + p2 [change, network] Install the dependencies with npm
plan  1 change item waits for you (1 with network access): /plan shows the plan, /approve authorizes it
```

You see the mark before you authorize, and giving an item the network withdraws an authorization already given. The commands of that item's task then share the machine's network, which includes services on localhost such as the model server. Tasks of every other item have no network at all; a command that fails there is told so.

The network is decided when a window opens and stays with the window. A task whose item has no mark cannot type into a window that has the network, and a task with the mark does not get the network in a window opened without it: each is told to use a window of another name.

**Output.** No command is stopped for taking long; it is left running, as described above. A call returns the first 40 lines and the last 160 of what was printed (at most 2,000 and 8,000 characters), with a line in between that says how many were left out. Colour codes are removed and a progress bar is reduced to its last state.

**What undo covers.** What commands do to files is in the checkpoints like any other change: the record after the task lists it, `/diff` shows it, `/undo` takes it back. The exception is files that git ignores, such as build output, installed dependencies, an `.env` file or a local database. They are not in the checkpoints, so if a command deletes or overwrites one, `/undo` cannot bring it back. The same goes for a folder that is a git repository of its own. The agent is told this in the tool's description.

When a command creates more than 40 files, the record names folders instead of files (`folder   .venv/ 931 files: 931 new`), so that it does not fill the agent's context.

**After a kill.** A window that was open when Cartographer was killed ends with it, and so does what ran there. At the next start the command is not run again; the task is told that it was interrupted and may have run in part, and goes on from there, in a window opened anew. The agent's windows block says which windows are gone and what they were running.

**Switching the sandbox off.** When the work has to reach beyond the project folder, you can let commands run without the sandbox:

```
carto --no-bwrap        for the whole session
/bwrap off              from now on; /bwrap on switches back; /bwrap shows which it is
```

Commands then run directly on the machine, as you, with your environment and the network. They can read, change and delete whatever you can, anywhere. What stays the same:

- A plan still needs `/approve` before any command runs, and only a change task runs one.
- `write`, `edit`, `read`, `search` and `list` still reach the project folder only. The way out of it is `shell`.
- The windows work the same, with bounded output, and every process of a window ends with it: on `/kill`, when you leave, and within about a second of Cartographer being killed. A process that detaches itself into a session of its own escapes this.

What you give up:

- `/undo` and the record of changed files cover the project folder only. What a command changes outside it is neither listed nor reversible. The task's record says so.
- The plan's `network` mark means nothing: every command has the network.
- A command can also change the project's `.git` folder and the brain in `.atlas/`, checkpoints included. In the sandbox both are read-only.

The switch is not stored. Every start is sandboxed again unless you pass `--no-bwrap`, and that includes a task that was cut off by a kill and is resumed: its remaining commands run in the sandbox. `/bwrap` waits until the agent has stopped, because a running task was told how its commands run when it started. A window keeps the way it was opened, so a switch in either direction closes every open window, with what runs there; the same name is a new window afterwards.

While the sandbox is off, the prompt reads `[no sandbox] ›`, each command's result line says `no sandbox`, and `/approve` repeats it. The agent is told in the state block and each change task in its brief; both are asked to stay inside the project folder unless you asked for something outside it. That is a request to the model, not a barrier.

**Without bubblewrap.** When `bwrap` is missing, or cannot start a sandbox on the machine, the header says so (`no sandbox: … · tasks cannot run commands`), `shell` is refused, and the agent is told to say how to run what it wrote. Looking, writing and editing work as before. `--no-bwrap` or `/bwrap off` runs commands on such a machine, without a sandbox.

Limits:

- The sandbox guards against accidents: a command that deletes the wrong folder, kills the wrong process or writes where it should not. It is as strong as bubblewrap and the kernel, and it was not examined as a defence against a program written to break out.
- In a project without a `.gitignore`, everything a command creates is checkpointed, a virtual environment or a build folder included. That costs time and space; a `.gitignore` avoids it.
- `.atlas/home/` grows with the caches tools keep there. It can be deleted at any time.
- A command's output appears on the screen only as its last line, when the call returns. `/shells` shows more of it while it runs.
- A window is line-based. A program that draws the whole screen (an editor, `top`, `less`) cannot be used in it.
- The guess that a program waits for input rests on a line without a line end followed by silence. A progress display that stops moving looks the same.
- Windows do not survive a restart of `carto`. A server the agent needs again has to be started again; the agent is told that it is gone.

## The atlas, the assessment and time

The atlas is the agent's map of the project. It has two parts, and they are kept apart on purpose: one is what the folder holds, the other is what the agent has understood.

**The tree** is drawn by Cartographer from the files as they are, so it cannot be wrong or out of date. It respects `.gitignore` and leaves out `.atlas/`. It is drawn three levels below an anchor, which starts at the project root; a folder below the last level is one line with a file count. A drawing longer than 60 lines is made smaller, first by showing fewer entries of each folder, then fewer levels, and the first line says so. The agent sees the tree in every request and can move it: an `atlas` call with a `tree` operation sets the anchor to a folder, sets it back with anchor `.`, or changes the depth from 1 to 6. The view stays as the agent left it, across sessions. A task gets the tree in its brief and looks further with `list`.

**The graph** is written by the agent and its tasks as nodes. A node has a name, one line that says what it is, and optionally a longer detail, links to other nodes, links to files or folders, and a kind: `component`, `finding`, or `dead_end` for something tried and ruled out. A node needs no file and no link, and no file needs a node: what gets a node is the agent's decision. Each file line of the tree names the nodes that link to it.

When a node links to a file, Cartographer keeps a fingerprint of that file from the moment the node was written. If the file later changes or disappears, the node is reported as "may be out of date", to the agent in every request and under the report of the task that changed the file. It stays so until the node is rewritten or the agent confirms that it still holds. A folder link notices files added to or removed from that folder, not changes inside them.

**A node for a file that is not there yet.** While the project may be changed, that is, once you have authorized the plan or switched approval off, linking a node to a path that does not exist creates it: an empty file, or a folder when the path ends with a slash. The agent is told what was created, and so are you. Before that, nothing is created and the agent is told to write the node without the link for now. Such a file is not part of a task's checkpoint when the main agent made it, so `/undo` does not remove it.

**The assessment** is the agent's summary of the whole project, addressed to itself: what the project is, how it is built and run, what state it is in. The main agent replaces it whole with `assess`; a task cannot.

**Who writes.** A look task is asked to record what it learned that will still matter later, and a change task to rewrite the nodes about what it changed. Both write directly, so the knowledge does not have to pass through a report and be written down a second time. Under the task's report the main agent gets Cartographer's own record: which nodes the task wrote, removed, or left possibly out of date. The main agent can write, correct and remove nodes too.

**Mapping without a goal.** When no goal is set, or a plan waits for your `/approve`, the agent is told it may start a look task that maps a part of the project the graph says nothing about. Whether to do that and when to stop is left to it. Nothing in the project changes; type a message or `/stop` at any time.

**Editing them yourself.** The graph is `<project>/.atlas/carto-atlas.json`, the assessment is `<project>/.atlas/assessment.md`. Both are read again at every step. A node needs `name` and `gist`; everything else is optional, and fields Cartographer does not know are kept. The agent is shown an assessment you edited in full, and a node you added is listed as new. A graph file that cannot be read is reported to you and to the agent and is never overwritten; the tree is still drawn.

```
› /atlas
Tree
From the project root, 3 levels deep: 4 files in all.
src/
  cli.py  [cli]
  roll.py  [roller]
tests/
  test_roll.py
README.md
Graph: 3 nodes
Components:
  cli  Prints one roll; takes no arguments yet  [src/cli.py]
  roller  roll(sides) returns a random whole number from 1 to sides  [src/roll.py]  → cli
Findings:
  tests_are_empty  tests/test_roll.py holds one test that checks nothing
  /home/momo/Projects/simpledice/.atlas/carto-atlas.json · edit it by hand, or tell the agent what to change
```

### Time

The model has no clock, so Cartographer tells it the time in three places, always written the same way:

- after each of your messages: `[sent Tue 10 Nov 2026, 14:05]`;
- after each task report: `[task ended Tue 10 Nov 2026, 14:07, after 2 m 10 s]`;
- at the head of the state block: the time now, how long ago your newest message came, and since when the agent has been working.

Ledger entries older than an hour say their age, and so does a node when the agent looks at it. The stamps are worked out from the stored time of each message at the moment a request is sent. They are not stored, and a message carries the same words in every request, so they cost nothing to re-read. Times are in the time zone of the machine `carto` runs on.

Shell windows use the same clock: how long a command has been running, and how long ago the last one ended.

## How the agent sees its brain

None of the brain is stored in the conversation. Cartographer adds it to each request as the request is sent, in two places chosen by how often the content changes. The server re-reads a prompt from the first changed character on, so what changes rarely goes to the front and what changes often goes to the very end.

**At the front: the assessment and the outline of the graph.** They stand before your first message, in every request of the main agent and of every task:

```
<project>
Written by Cartographer from your own records of this project, as they stood on Tue 10 Nov 2026, 14:05 (goal g1 was closed). What was written since is listed in the state block at the end of the request.

Your assessment
A small Python dice roller. roll.py holds the roller, cli.py prints one roll. The tests check nothing yet.

Your graph (3 nodes)
Components:
  cli  Prints one roll; takes no arguments yet  [src/cli.py]
  roller  roll(sides) returns a random whole number from 1 to sides  [src/roll.py]  → cli
Findings:
  tests_are_empty  tests/test_roll.py holds one test that checks nothing
</project>
```

This is a copy, kept in `.atlas/carto-top.json`, and it is replaced at four moments only: the first start in a project, when the context is collapsed (a closed goal is the usual cause), on `/new`, and on `/pin`. Writing a node or the assessment does not touch it, because a change here makes the server read the whole context again; at a collapse the whole context is read again anyway, so the new copy costs nothing more. Between those moments the state block lists the nodes written since the copy, and the agent's own `assess` call holds its newest assessment. An outline over 6,000 characters lists its oldest nodes by name only.

**At the end: the state block.** Each request of the main agent ends with a block, built at that moment and added to that request only:

```
<state>
Written by Cartographer, not by the user. This is the current state; it replaces any state you saw before.

Now: Tue 10 Nov 2026, 16:40. The user's newest message came 12 m ago.

Tree
From the project root, 3 levels deep: 4 files in all.
src/
  cli.py  [cli]
  roll.py  [roller]
tests/
  test_roll.py
README.md

Atlas
Graph: 4 nodes. Files a node links to: 2 of 4. Assessment: written 2 h ago.
Nodes written since the copy at the top of your context: argument_check (`atlas` look shows one).
May be out of date: cli (src/cli.py changed 3 m ago). Have a task check each against its files, then rewrite the node, or confirm it when it still holds.

Ledger
Goals:
  g2  Let the roller take the number of sides as an argument (done when: `python src/cli.py 20` prints a number from 1 to 20) · added 2 h ago
Questions for the user:
  q3  Should a wrong argument print the usage text or an error?

Plan
Not authorized: change items wait until the user types /approve. Look items may run.
  p2 [change] Write roll.py with the roller and its argument check
  (done: p1)

Answer the user's newest message first. Change items wait for the user: show them the plan in a few lines and ask them to type /approve. Do not start p2 before that.
</state>
```

The last paragraph is one instruction for the situation at hand: no goal, a goal without a plan, a plan waiting for you, an authorized plan with its next item, or a finished plan.

So the agent always sees exactly one copy of the state, the current one, also after `/new` and after an edit by hand. The block does not depend on what the conversation holds, so a collapse of the context does not lose it. Because the block is at the very end of the prompt, the server re-reads only the block and what follows the previous request, not what comes before. Measured on llama.cpp with a goal and a note in the ledger: 130 to 230 tokens read per main-agent request. A task does not get the state block, and starting a task cost 119 tokens there, the same as without it. (The windows block, which a task does get while a window is open, is described under [Shell windows](#shell-windows).) Those figures are from before the tree and the atlas lines were part of the block; it is longer now by those lines, and none of this slice has been measured on a real server yet.

The fixed part of the prompt, system text plus tool descriptions, grew with the plan, the change tools, the atlas, the shell windows, the wakes, the context engine and the task flow (`ask`, `return`). It was about 2,100 tokens before them. It is now about 9,100 tokens by a rough count of four characters per token, of which the `atlas` tool's description is about 1,100, `shell` and `window` together about 900, `wake` and `sleep` together about 650 and `context` about 500, and the first request of an empty project comes to about 9,400; that is an estimate, and `/context` after the first answer shows the real number on your server. The fixed part is read once per server start and reused after that. The figures in the paragraph above were measured before the plan was part of the block; with a plan in it the block is longer by the plan's lines.

## The context

The model reads one context of at most `contextWindow` tokens, and a long piece of work produces more than that. Cartographer keeps the context small by **collapsing** it: everything the agent had in view is replaced by one block that holds what is worth keeping. pi-durable's own compaction, which would have the model write a summary, is switched off.

A collapse writes no summary and asks the model for nothing but one word. What it keeps was collected while the work happened:

- **One line for each finished task**, with an id: when, which kind, what was asked, how it ended. The report itself is kept in `.atlas/reports/t12.md`, and the agent gets it back in full with `context` and the id. You read it with `/report t12`.
- **The shelf**: files, or line ranges of files, that the agent chose to keep in view. See below.
- **The talk**: what you wrote and what the agent said to you with `chat`, word for word, the newest `chatWindow` tokens of it (8,000 unless you change it). The agent's own notes and reasoning are not talk and are not kept, which is the reason `chat` is a tool of its own.

The ledger, the plan, the graph and the assessment are not in the conversation at all, so a collapse cannot touch them. The agent is told this in its prompt: what it will need later belongs there.

After a collapse a request is laid out like this, from what changes least to what changes most:

```
the prompt and the tools          never change
<project> … </project>            the copy of the assessment and the graph, renewed at each collapse
<context> … </context>            the block: task lines, shelf, talk. Unchanged until the next collapse
the work since the collapse       grows at its end only
<state> … </state>                written anew for every request
<windows> … </windows>            written anew for every request
```

The block as the agent reads it:

```
<context>
Written by Cartographer, not by the user. Your context was collapsed on Tue 10 Nov 2026, 14:05 (goal g1 was closed). What you had in view before is gone except for what stands here: …

Finished tasks (`context` with action recall and the id brings a report back in full)
t1 · Tue 10 Nov 2026, 13:20 · look · asked: Map src/ and record what each file does → Three files; roll.py holds the roller …
t2 · Tue 10 Nov 2026, 13:41 · change p1 · asked: Add a --sides option to cli.py → Added; 2 files changed, tests pass

Your shelf: 1 item, as the files were at the collapse
== src/roll.py (lines 1-18 of 18)
 1  import random
 …

Your talk with the user, word for word; what was said before it is gone
[user · Tue 10 Nov 2026, 13:18] make the dice roller take the number of sides
[you · Tue 10 Nov 2026, 13:19] Then the goal is: …
</context>
```

### When it collapses

| When | What happens |
|---|---|
| A goal is closed | In the middle of the agent's turn, once the calls of that reply are done. The block ends with those calls and what they returned, and the turn goes on. Skipped when less than about 1,500 tokens would go |
| The agent rests and at least `collapseTokens` (10,000) of finished work are in view | While the prompt waits for you |
| The agent rests and you have been away `collapseMinutes` (5) | The same, whatever the amount above 1,500 tokens |
| The agent works and the context is `collapseFull` (80) percent full | In the middle of the turn, as at a closed goal. A reply that ends the turn is left alone, and the collapse follows at the rest |
| `/collapse` | Now. Works while the agent is idle |
| The agent calls `context` with `collapse` | When the calls of that reply are done |

A collapse that would free next to nothing is not made, however full the context is. That case means the shelf, the talk and the fixed part fill the window by themselves; lower `shelfTokens` or `chatWindow`.

**The question.** Before a collapse that the agent did not ask for itself, Cartographer asks it whether something in view is written down nowhere and will be needed. The request is the last one again with the question added at its end, so the server has read all of it but the question; the reply is limited by a schema to `{"handoff": true}` or `{"handoff": false}`, with thinking switched off for that one request. `false` costs the reading of the last reply and of the question, a second or two as a rule, and the collapse follows at once. `true` gives the agent one turn to write down what it needs, in the ledger, the graph, the assessment or on the shelf, and then the collapse follows. If the server cannot answer such a request, the screen says so with the server's words and the collapse is made without the question.

**The read-ahead.** A new context has to be read by the server once, and at about 740 tokens a second a block of 15,000 tokens takes 20 seconds. After a collapse at rest Cartographer therefore sends the new start of the context at once, asking for one token of answer, so that it is read while you are away. When you type before it is done, it is stopped and your message goes first. `readAhead: false` switches it off. A collapse in the middle of a turn needs none: the agent's next request reads the new context.

### The shelf

A task reads a file, reports, and the file text is gone with the task. When the agent keeps sending tasks to the same file, it can put the file on its shelf: `{"action":"shelve","path":"src/roll.py"}`, or with `"lines":"1-80"`. Marking changes nothing at that moment, since putting text at the front of the context would make the server read everything again. From the next collapse on the file stands in the block, and since a task continues from the main agent's context, every task then starts with it already read.

The shelf holds at most `shelfTokens` (12,000); a file that would not fit is refused, with the sizes. The block shows a shelved file as it was at the collapse. When the file changes afterwards the block is left as it is and the state block says which copy is old; the next collapse writes the current text. A file that was deleted leaves the shelf, and both you and the agent are told. `/context` shows what is on the shelf, what waits for the next collapse, and what was taken off.

### Recalling and dropping

`{"action":"recall","id":"t12"}` returns report `t12` in full. It stays in view until the next collapse. A report that is still in view is not added a second time.

`{"action":"drop","id":"t12"}` replaces a report that stands in the context by its one line. This changes the context in its middle, so the server reads everything behind that place again; the answer to the call says how many tokens that is. It is for a large report the agent is done with while much work is still ahead. A dropped report comes back to its place with `recall`.

The main agent has no notes of its own that survive a collapse, on purpose: a `note` action is refused for it with a pointer to the ledger, the graph and the assessment.

### Inside a task

A task manages its own steps and nothing else. What stands before its brief is the main agent's context, which the server has read and which stays untouched.

- A large result ends with a mark like `[s3 · about 2,100 tokens]`. `{"action":"drop","id":"s3"}` replaces that result by one line.
- When a task reads the same lines of a file again, the older copy is replaced by one line without being asked. This is done only where it pays: the copy is at least about 400 tokens, and what follows it, which the server then reads again, is at most eight times its size.
- `{"action":"note","text":"…"}` writes down a finding. Notes stay when the steps are collapsed.
- A task has a shelf too. Its files stay in the task's view when its steps are collapsed, and with `"hand_on": true` a file goes onto the main agent's shelf when the task ends. The report then says so.
- When the context is `collapseFull` percent full during a task, the task is asked the same question, with the same two answers. Then its steps become one block: its notes, one line per call, and its shelf. The task goes on with its brief. It can ask for this itself with `collapse`.

### What `/context` shows

```
  The agent's context: about 21k of 100k tokens (the server's count for the last answer; the parts below are estimates)
    fixed      9.1k   the prompt and the tools; never changes
    top         310   the assessment and the graph, as copied at the last collapse
    record      180   6 finished tasks, one line each
    shelf      1.2k   src/roll.py, src/cli.py (lines 1-80)
    talk       2.9k   14 messages between you and the agent, of at most 8.0k tokens
    work       7.6k   22 messages since the last collapse; a collapse frees about 6.9k
    state       640   the state block, written anew for every request
  kept reports: 6 (t1 to t6); the newest: …
  last collapse: Tue 10 Nov 2026, 14:05 (goal g1 was closed), about 41k → 12k tokens
  next: while the agent rests, once 10k tokens would go or you have been away 5 m; when a goal closes; while it works, at 80k tokens. /collapse does it now.
```

### What has been tried, and what has not

Tried here, against the scripted stand-in: every path above. Tried against a real llama.cpp server (build b12322) with a 0.6B Qwen model: that a request with a reply schema and tools together is accepted, that with thinking switched off the answer is the one JSON object in 7 tokens, that the question reuses what the server had read, and that a request for one token returns with the prompt read.

**The question and the tools.** The question before a collapse names the shape of its answer, and it carries the tools, because the server has read them as part of the prompt. With the Qwen 3.8 chat template on llama.cpp build 11913, that combination is refused: `failed to parse grammar`, for a schema and for plain `json_object` alike, with any one tool. With `tool_choice` set to `none` the same request is accepted and the prompt is not read again (measured: 707 of 708 tokens from the cache). So every question is sent that way. If a server still refuses the shape, the question is asked once more without it and from then on without it, and you are told once.

### Reading the prompt

Every request asks llama.cpp to say how far it is with reading the prompt (`return_progress`). The server then puts a count into the stream for every 2,048 tokens it has read, and the full screen shows it in the strip: `reading 14.1k of 27.3k new ▮▮▮▮▯▯▯▯ 52% · 740 tok/s · writing in ~18 s`. Only what the server has to read anew is counted, not what it still has from the request before. Readings shorter than `prefillTokens` (1,000) are not shown. This works through llama-swap, since the count comes back in the same stream as the reply. A server that does not know `return_progress` ignores it. `"prefill": false` leaves it out of the requests.

Tried: against the scripted stand-in end to end, and the server's side against llama.cpp build 11913 by hand. Not shown: the read-ahead after a collapse, which is a request of its own without a stream; the plain terminal shows none of this.

Not tried, because it needs your machine:

- **Whether Qwen 27B answers the question sensibly.** The small model shows only that the mechanism works. If your model says `true` every time, each collapse costs a turn; if it says `false` when something was about to be lost, you will see the agent rediscover things. The `◆ asked before collapsing` line shows every answer.
- **Which slot the extra requests land in.** Your server has four slots. The question and the read-ahead begin with the same text as the conversation, and llama.cpp picks the slot whose content is most alike, so they should land in the conversation's slot; the read-ahead shares only the prompt and the tools with it. If the read-ahead goes to another slot, the next answer reads the context a second time, and the `read for this answer` figure after it shows that: it should be a few hundred tokens, not thousands. With `-np 1` the server has one slot and this cannot happen.
- **llama-swap.** A request while another is running should queue or go to a free slot; the read-ahead is stopped when you type for that reason.

## The brain folder

```
<project>/.atlas/
  carto-ledger.json   goals, questions, notes. Yours to read, edit and commit
  carto-plan.json     the plan and its authorization. Yours to read and edit
  carto-atlas.json    the graph, and where the agent put the tree. Yours to read, edit and commit
  assessment.md       the agent's assessment of the project. Yours to read, edit and commit
  carto-top.json      the copy of the assessment and the graph that the agent's context starts with. Written by Cartographer
  checkpoints.git/    the files before and after each change task. Kept out of git
  home/               the home folder commands see in the sandbox: caches and settings of tools. Kept out of git
  shells/             what the shell windows are started with, and the command each was last given. Kept out of git
  carto-windows.json  which windows are open, so that the next start can say which are gone. Kept out of git
  carto-wakes.json    the wakes the agent has set. Read at each start, written whenever one is set, fires or is removed. Kept out of git
  carto-context.json  what a collapse keeps: the lines of finished tasks, the talk, the shelf. Written by Cartographer. Kept out of git
  reports/            every task's report in full, t1.md, t2.md, …, with its brief. Kept out of git
  export/             what you copied out of the full screen: messages, sessions, tabs. Kept out of git
  session.sqlite      the session: every message, task and report. Kept out of git
  plugins/            empty for now; plugins the agent writes for this project will live here
  config.json         optional: settings for this project only
  .gitignore          keeps what belongs to this machine out of git: the lines above that say so
```

Deleting `.atlas/` makes Cartographer forget the project. One `carto` runs per project at a time.

**Sharing the folder with the Orchestrator extension.** The Orchestrator pi extension also writes an `.atlas/` folder, in whatever folder pi was started from: `graph.json`, `ledger.json`, `working-direction.json` and a `.gitignore`. Cartographer reads and writes none of those files. A folder that holds only those is not a brain, and Cartographer does not pick it as a project. When you start `carto` in such a folder and agree to set up a brain, it adds its own files next to them.

An earlier version kept the ledger in `ledger.json`. On the first start after the update, a `ledger.json` written by Cartographer is renamed to `carto-ledger.json` and a line on the screen says so. The Orchestrator's file of that name stays where it is.

## Settings

`~/cartographer/config.json` applies to every project. `<project>/.atlas/config.json` overrides it for one project, the environment variables `CARTO_SERVER` and `CARTO_MODEL` override both, and `--url` and `--model` override everything.

| Key | Default | |
|---|---|---|
| `server` | none | Address of the server, ending in `/v1` |
| `model` | none | Model name as the server knows it |
| `contextWindow` | 100000 | Context size the server was started with (`-c`) |
| `maxTokens` | 8192 | Longest single reply, thinking included. Also the longest file one `write` call can hold |
| `mainTurns` | 40 | Replies the main agent may make in one turn, notes included, before the turn is ended. Carrying out a plan takes about two per item |
| `taskTurns` | 30 | Replies one task may make, notes included, before it is ended without a report |
| `askMinutes` | 0 | Minutes an `ask` waits for your answer before the agent is told there was none. 0: without limit |
| `screen` | true | Whether `carto` on a terminal takes the whole screen. false: the plain terminal, as with `--plain` |
| `repeatCut` | true | Whether a reply that writes the same thing over and over is cut off |
| `prefill` | true | Whether the server is asked how far it is with reading the prompt |
| `prefillTokens` | 1000 | From how many tokens to read anew the reading is shown in the strip |
| `colors` | `"auto"` | The colours of the full screen: `"auto"`, `"truecolor"`, `"256"`, or `"none"`. See [How it looks](#how-it-looks) |
| `theme` | `"auto"` | `"auto"` asks the terminal for its background; `"dark"` or `"light"` says it |
| `windowTail` | 10 | Lines of output the agent is shown for each busy shell window at the end of every request, 1 to 40. More lines show more of a command's progress and cost more tokens per request |
| `shellWait` | 30 | Seconds a `shell` call waits for its command before it returns and leaves the command running in its window. A task can ask for up to 300, or for 0 |
| `wakeMin` | 60 | Seconds between two firings of one wake, at least, and the pace at which wakes are let through after 12 in quick succession. Lower it only if your server answers much faster than a minute on a full context |
| `wakesMax` | 8 | Wakes the agent may have set at a time |
| `treeDepth` | 3 | Levels of the file tree the agent is shown, 1 to 6, until it sets a depth of its own |
| `thinking` | true | Whether the terminal starts with the agent's own text shown. Ctrl-T and `/thinking` switch it while it runs |
| `chatWindow` | 8000 | Tokens of your talk with the agent that a collapse keeps word for word. The newest message is kept whatever its size |
| `shelfTokens` | 12000 | Tokens the agent's shelf may hold. Together with `chatWindow` at most half of `contextWindow` |
| `collapseTokens` | 10000 | While the agent rests, its context is collapsed once at least this many tokens would go |
| `collapseMinutes` | 5 | And after you have been away this many minutes, whatever would go. 0: never for that reason |
| `collapseFull` | 80 | While the agent works, its context is collapsed when it is this full, in percent of `contextWindow`, 30 to 95. The same limit holds for a task's steps |
| `readAhead` | true | Whether the server is sent the collapsed context at once, so that it is read when your next message comes |
| `shellRead` | `[]` | More folders a command may read, besides the system and the project: full paths, or starting with `~/`. For programs installed in your home folder that the sandbox does not show by itself |

## What is not here yet

In build order:

1. **Plugins** under `.atlas/plugins/`: the agent testing the project by extending its own harness.
2. **Heat and focus for the graph**, so that a large graph shows the part in use.

And smaller things, named where they belong above: the full screen does not replay earlier sessions and cannot type into a shell window; the reading of the prompt is not shown for the read-ahead after a collapse.

## Tests

`npm test` runs the real `carto` command in throwaway project folders against `test/stand-in.mjs`, a scripted stand-in for the model server. It covers:

- launch and settings errors, the brain folder, the lock;
- which folder becomes the project: a brain or repository in the home folder, an `.atlas/` folder left by the Orchestrator extension, a repository nearer than a brain, the question before the first set-up (this one needs `python3` for a terminal and is skipped without it);
- a task from brief to report, including that the task's prompt is the main agent's stored conversation plus the brief, and that file text never reaches the main agent;
- the refusals, two tasks in one turn, the turn limits, a kill in the middle of a task followed by a restart;
- the confinement of the look tools;
- the ledger: every operation and its errors, the limits, what a hand-written file must hold, a broken file left untouched, a call run twice after a crash;
- the state block: present once at the end of every main-agent request, never stored, absent from tasks, current after a change, after an edit by hand and after `/new`;
- the plan: every operation, what withdraws the authorization and what does not, the instruction in the state block for each situation, a finished item not run again;
- writing: refused for the main agent, for a look task, and for a change item before `/approve` or after the plan grew; every kind of path a task may not write to; edits that match nothing or more than one place;
- a change task end to end: the files written, the record of changes in the report, the project's own git repository left untouched, a reply cut off at the output limit;
- checkpoints and `/undo`: files back byte for byte, one task taken back at a time, the user's own files left alone, a task that was cut off, the plan item reopened and the authorization withdrawn;
- a kill in the middle of a change task: the restart finishes it, it may still write, and the undo goes back to before the task;
- the shell, with real commands in a real sandbox: what a window can and cannot reach (the project, the home folder, the system, the brain, `.git`, `/tmp`, the network, the environment, other processes), who may type into one, the network mark, long output, a kill in the middle of a command, the record and the undo of what commands did. These are skipped, and say so, on a machine where bubblewrap does not work; one test checks what Cartographer does without it;
- shell windows: folder and environment kept between commands, a command that outlives its call, `wait` with and without a line to wait for, `read`, `send` to a program that asks, `stop`, `close`, `exit`, the limit of four, output between two calls neither lost nor repeated, the windows block at the end of the main agent's and of a task's requests and that it is never stored, the `windowTail` setting, who may do what, the note that wakes the agent and the limit on such notes, a window's changes as a step of their own with `/diff` and `/undo`, `/shells`, `/kill`, `/stop` leaving other windows running, a message from you ending a wait, the windows reported as gone after a restart. These run in the sandbox where there is one and without it otherwise;
- the atlas: every operation on nodes and its errors, the limits, the tree at each depth and anchor and when it is made smaller, a task writing nodes and the record under its report, a node left out of date by a change task until it is confirmed, who may move the tree, a call run twice after a crash, an edit by hand, a broken file left untouched;
- the assessment and the copy at the front: written by the main agent only, the first message of the conversation identical in every request until a goal closes, `/pin` or `/new` replaces it, and identical between the main agent and its tasks;
- time: the stamps on messages and task reports, the same words in every request, nothing of them stored;
- wakes: each kind firing and not firing, the number of times, the least interval, every refusal, a restart, firings folded into one; in a session, a note that wakes a resting agent, `sleep` ending the turn with no further request, quiet turns leaving the request while the turns before them stay the same, a firing told in the state block while the agent works or a task runs, a wake ending the main agent's wait but not a task's, `/wakes`, and wakes in quick succession being spaced out and not dropped;
- approval switched off: `--yolo` and `/yolo`, change items and network items running without `/approve`, what the agent and the screen are told, `/undo` under it, and that it is not remembered;
- standing items: needing `/approve`, running more than once, ending when marked done;
- the context: the report ids and `/report`; a collapse at rest, after the size limit, after time away, by `/collapse` and at the agent's word; a collapse in the middle of a turn at a closed goal and at the fill limit, and that a reply which ends the turn waits for the rest; the question, its exact request, both answers at rest and in a turn, a server that refuses it; the read-ahead being the start of the next request to the letter, and being stopped by typing; the shelf with its limit, its refusals, a changed and a deleted file; recall and drop; a task's marks, re-reads, drops, notes, shelf, its own collapse and the one near the limit, and that nothing before its brief changes; the talk held to its window; a restart; `/context` and `/new`;
- a task's flow: notes followed up and counted, the reply limit with its warnings and the notes that come back, `return` with and without a report, `done` marking the plan item or leaving it open, the summary in the record, the main agent's tools refused without ending the task, `chat` from a task;
- `ask`: choices and free answers, from the main agent and from a task, with piped input and on a terminal, a command typed while a question waits, `askMinutes`, nobody left to answer;
- what you type while a task runs: sent to the task once, told to the main agent, kept as talk;
- a reply that repeats itself: cut off for the main agent and for a task, the one retry, the stop at the second time, the setting;
- the full screen, on a real terminal read through a small emulator (`test/vt.py`): the tabs, the two modes, a run of calls folded and opened with the keys, a call leading to its tab, the items of Diff and Carto opening, `e` handing the right file and line to the editor, the Context tab folded and wholly opened, pasted text with and without the terminal's marks, the list of commands under a slash and one Enter sending a completed command, Up bringing back what was sent, Tab going to the next tab or completing, the sheet of keys, the search under a slash, Escape and a key arriving as one, dragging over a message and what is copied then, the strip, a question, the reading of a long prompt, `/copy session` to the clipboard sequence and to a file, a click on a tab and on an item, the conversation left on the terminal on leaving, and the terminal's modes switched off again; the look: the margin, a background for each kind of block and none for the agent's words, the bars from edge to edge, the selection by its background, Markdown, a palette made again from the background the terminal answers, Ctrl-T leaving no line behind; and without a terminal: measuring and wrapping text, the names of keys in both encodings, lines that arrive at once taken as pasted, the Chat tab's folding, live text and transcript, the list that the other tabs are made of, the views read from a filled brain, the Context tab built from a request, and the palette itself (the levels of text, hues of one lightness, blocks that stay readable on a low-contrast theme, 256 colours and none);
- the sandbox switch: `--no-bwrap` and `/bwrap`, a command reaching beyond the project, what the agent, the task and the screen are told, the system prompt staying the same across a switch, the windows closed by a switch, `/stop`, `/kill` and a kill of `carto` with the sandbox off.

The stand-in is not a model. The tests show that the program does the right thing when the model behaves; they say nothing about how a model behaves.

`npm test -- kill` runs only the tests whose name contains "kill".

## Files

| | |
|---|---|
| `bin/carto` | The command. Checks Node and hands over to `src/cli.mjs` |
| `install.sh` | Packages, the executable mark, the link on your PATH, `config.json` |
| `src/cli.mjs` | Options, finding the project, checking the server, start and exit |
| `src/project.mjs` | Which folder is the project; creating and locking `.atlas/` |
| `src/config.mjs` | Settings and where they come from |
| `src/harness.mjs` | Opens the session: model provider, tools, and who may call which |
| `src/prompt.mjs` | The system prompt, the task's role line, the refusals |
| `src/ledger.mjs` | The ledger: its file, its operations, how it is printed |
| `src/plan.mjs` | The plan: its file, its operations, the authorization rules |
| `src/checkpoints.mjs` | Checkpoints in `.atlas/checkpoints.git`: record, compare, undo |
| `src/sandbox.mjs` | The bubblewrap sandbox: what a window sees, and bounding a command's output |
| `src/windows.mjs` | The shell windows: opening one, typing into it, waiting, reading, stopping, closing, and announcing what happens in them |
| `src/reaper.mjs` | Ends a window's processes when the sandbox is off, also when `carto` itself was killed |
| `src/wake.mjs` | The note that wakes the agent, and which turns such notes started are left out of a request |
| `src/wakes.mjs` | The wakes the agent sets: the three kinds, when each fires, their file |
| `src/atlas.mjs` | The graph: its file, its operations, which nodes may be out of date |
| `src/tree.mjs` | The file tree: anchor, depth, fitting it into 60 lines |
| `src/assessment.mjs` | The assessment and its file |
| `src/top.mjs` | The copy of the assessment and the graph at the front of the context, and when it is replaced |
| `src/context.mjs` | What a collapse keeps and how it is written: the task lines, the talk, the shelf, the block; a task's steps and their marks |
| `src/engine.mjs` | When the context is collapsed, the question before it, the read-ahead after it |
| `src/time.mjs` | How times, durations and ages are written |
| `src/request.mjs` | What is added to a request as it is sent: the copy at the front, the times, the state block, the windows block |
| `src/state.mjs` | The state block added to the end of each main-agent request, and the windows block added after it and to each task request |
| `src/tools/ledger.mjs` | The `ledger` tool |
| `src/tools/plan.mjs` | The `plan` tool |
| `src/tools/atlas.mjs`, `src/tools/assess.mjs` | The `atlas` and `assess` tools |
| `src/tools/task.mjs` | The `task` tool: fork, brief, checkpoints, report |
| `src/tools/look.mjs` | `read`, `search`, `list` and the confinement to the project |
| `src/tools/change.mjs` | `write`, `edit` and the paths a task may write to |
| `src/tools/shell.mjs` | `shell` and `window`: who may do what, and what the caller is told |
| `src/tools/wake.mjs` | The `wake` and `sleep` tools |
| `src/tools/chat.mjs` | The `chat` tool: how the agent tells you something |
| `src/tools/ask.mjs`, `src/asks.mjs` | The `ask` tool, and the question that waits for your answer |
| `src/tools/return.mjs` | The `return` tool: the one way a task ends |
| `src/tools/context.mjs` | The `context` tool: recall, shelf, drop, note, collapse |
| `src/terminal.mjs` | The plain terminal: input, and printing what happens. It also runs the session behind the full screen |
| `src/screen/app.mjs` | The full screen: pi-tui's terminal and layout, the tabs, the two modes and their keys, the strip |
| `src/screen/parts.mjs` | The parts of the screen as pi-tui components: the row of tabs, the bodies of the tabs, the strip, the place to type, the sheet of keys |
| `src/screen/keys.mjs` | Keys by name for the commands mode; text that was pasted without being marked as pasted |
| `src/screen/chat.mjs` | The Chat tab: runs of calls folded and opened, what is being written, the transcript |
| `src/screen/list.mjs` | A list of items that fold, with one selected: what tabs 2 to 5 are made of |
| `src/screen/views.mjs` | What those tabs hold: the brain's files as items with their place in the file, the changes by file, the shell windows, and the request the agent was sent, part by part |
| `src/screen/text.mjs` | Text in cells: width, wrapping, styled lines; and telling a repeating reply from ordinary text |
| `src/screen/theme.mjs` | The palette: levels of text, one hue for each kind of block, backgrounds made for the terminal's own |
| `src/screen/copy.mjs` | Copying to the clipboard and to `.atlas/export/` |
| `test/run.mjs`, `test/stand-in.mjs`, `test/vt.py` | The tests, the stand-in server, and the terminal the full screen is tested on |
