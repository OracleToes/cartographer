# Cartographer

A durable agent you start from a project folder. The program lives in one place, this folder, and is installed once. Each project gets only a brain folder, `.brain/`, which holds the agent's memory of that project.

Cartographer is one agent with a durable project brain and finite attention. Its active context and focused working contexts are temporary; the underlying Durable transcript remains stored, while the ledger, plan, atlas, and assessment are how it keeps what matters readily available past the forget threshold. A focused context is the same agent concentrating on one bounded piece of work, not a separate worker. It can update the shared brain and project state; only the orchestrating context changes the plan. Project changes still follow the plan, approval, checkpoint, and sandbox rules described below. What waits for you gathers in one Requests view. On a terminal Cartographer runs in a full screen with a Chat tab — Conversation, Work, and isolated Consult subtabs — plus Carto, Diff, Shells, Model, and Settings. Model includes the current route's native-GBNF readiness and provider-request inspection; Settings shows configuration, session policy, provider diagnostics, and assessment without authorizing anything. Plugins are not built yet (see [What is not here yet](#what-is-not-here-yet)).

## Install

Needs Node 22.19 or newer, git (for the checkpoints around change tasks), bubblewrap (the `bwrap` command) and `script` from util-linux, which every Linux has (both for running commands; without them everything else still works), and a llama.cpp-compatible `/v1` model server—normally llama.cpp behind llama-swap—that enforces native GBNF `grammar`. A merely OpenAI-compatible server is not a supported Cartographer runtime.

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
No brain for this project yet. Set one up in /home/momo/some/project/.brain? [Y/n]
```

Enter or `y` sets up the brain and starts a session. Anything else leaves the folder untouched. Later runs continue the session, from the project folder or any folder below it, and do not ask again. With `-p` or piped input there is nobody to ask, so the brain is set up without the question.

### The full screen

On a terminal `carto` takes the whole screen. `carto --plain` gives the line-by-line terminal described further down instead, and so does `"screen": false` in the settings; with `-p` or piped input it is always the plain one.

```
 Cartographer   1 Chat  2 Carto  3 Diff  4 Shells  5 Model  6 Settings
 Conversation · Work · Consult

▎› add a seed option to the roller

The roller takes --seed now. Two tests cover it; both pass.

│▸ 14 calls · t3 · 1m 12s
◂ report t3  1,204 characters  (/report shows it)

⠹ task m3 · edit src/roll.py · 38s · 31 tok/s
ctx ▮▮▮▯▯▯▯▯ 41k/100k · 1 goal · plan 2/5 · approved · 1 window, 1 busy · 2 wakes
Esc: commands · Ctrl-O: $EDITOR · ? all keys
Task ›  Message the agent while it works · Esc for commands
```

(An illustration of the layout, not a recorded run.)

The screen is deliberately static: the filled top tab is the primary location, the quieter second row names its current subview, and selected rows remain the strongest content surface. Chat keeps the existing material in three projections: Conversation for user-directed exchange, Work for ordinary private focus activity, and Consult for a separate conference-local audit. Message and work blocks use a one-cell role rail plus a faint fill rather than a bright card per line. The activity strip steps down from immediate work to shared state to its key reminder, and the input names who is speaking (**You**, **Task**, or **Answer**) rather than relying on a bare prompt glyph. On narrower terminals labels compact as whole words and margins shrink before content does. These are hierarchy and alignment cues, not animations; labels and glyphs still carry the meaning when colour is unavailable.

| Tab | What it shows |
|---|---|
| **1 Chat · Conversation** | Two-party speech only: your submitted messages, delivered `chat` speech, and genuine questions and answers. Agent speech says whether it is sending, delivered, or failed. A failed delivery is not presented as something the agent said. |
| **1 Chat · Work** | Private reasoning, ordinary agent notes, calls, results, task activity, and Cartographer notices. Runs still fold; Ctrl-T hides private reasoning and notes without putting them into Conversation. |
| **1 Chat · Consult** | A separate, read-only `co<N>` conference timeline. It labels Cartographer, Atlas, Ledger, Plan, Assessment, Context, host debate routing, and host final-report decisions; it distinguishes reasoning, chat/prose, local tool calls, and local tool results. The audit remains advisory and never enters parent Conversation, Work, context, or project authority. |
| **2 Carto** | The live shared brain: Atlas, Ledger, Plan, Requests, Tree, and **Current shared brain**. Shelf and report material lives here, not in Model. |
| **3 Diff** | What changed: by the last step, in this session, or against the project's own git `HEAD`. |
| **4 Shells** | The shell windows, live, plus **Wakes**. Open a window for its newest lines or its terminal-emulator output; Wakes lists the main agent's scheduled time, file, and window triggers. |
| **5 Model** | **Routes**, **Latest sent**, **Main sent**, **Raw payload**, **Next preview**, and **Current accounting**. Routes shows discovered model names, the active route's native-GBNF readiness, and an explicit connect/select control; the other views separate frozen provider requests, the audit-only serialized payload, an unsent calculation, and live accounting. |
| **6 Settings · Safety** | The configured provider and limits, the live approval, initiation, and sandbox policy, plus separate route-listing and native llama.cpp GBNF diagnostics. It reports the backend-owned state; it does not authorize agent work. |
| **6 Settings · Assessment** | The current durable assessment and whether its top-of-context copy is current, stale, or missing. A current assessment can be opened in the editor; the top copy changes only through its safe refresh path. |

Carto through Settings are lists of items that fold. Chat's Conversation and Work use the ordinary local event feed; Consult reads only its private conference audit and live child activity. One item is selected, and the keys act on it: open it, fold it, open its current source in an editor where that is truthful, or copy it.

**Two modes.** As in vi, and **Esc** goes from one to the other. The place to type, at the bottom, shows which you are in.

- **Typing** (how carto starts): every key is text for the agent. Enter sends. Alt-Enter, Shift-Enter or Ctrl-J breaks the line, and so does a backslash before Enter. Pasted text keeps its lines and is never sent by itself; a paste of more than ten lines shows as `[paste #1 +40 lines]` and is sent in full, and a tab in pasted text becomes four spaces. A slash at the start of a line lists the commands with what they do, and Tab completes a command, a command's own word (`/copy session`, `/kill` and a window's name), or a path in the project.
- **Commands**: every key is a command, and nothing is typed. The mode does not depend on the tab: you can type with the plan in view, and move through Chat's Conversation, Work, or Consult subtab with the keys.

Pasting always goes to typing, whatever the mode was. A terminal that does not mark what it pastes sends the lines as if they were typed; several lines arriving at once are taken as pasted for that reason, and stay together.

| In commands mode | |
|---|---|
| `1` to `6` | Go to a tab: Chat, Carto, Diff, Shells, Model, or Settings. |
| `[` and `]` | Previous and next view inside the tab that shows (`H` and `L` do the same). |
| `j`, `k` | Move down and up. `g` and `G` go to the first and last row. |
| Enter, Space, `o` | Open or fold the selected row. `l` opens and `h` folds. In Chat Work, a call can lead to its owning tab; a `read`, `search`, `list`, or `task` opens its result in place. In Consult, it opens an attributed audit block or folds a conference. In Shells, Enter opens a window's output and goes back from it; in Wakes it opens the selected schedule row. In Model → Routes, Enter validates the active route or selects and validates another listed route. |
| `+` and `-` | Open everything or fold everything (`zR` and `zM` do the same). |
| `e` | In Chat Conversation, **Reword future kept talk** for the selected stable source. It changes only the mutable talk source for a later collapse; the active Durable conversation and every sent request stay unchanged. Current brain records use their own editor. Work and Consult are private and read-only. Model rows are read-only historical or preview material. In Settings → Assessment, it opens the current durable assessment; Safety rows are descriptive and read-only. |
| `d` | In Chat Conversation, confirm **Remove from future kept talk** for the selected stable source. It does not erase the Durable transcript, omit the active message, or change a sent request. Work and Consult are private and cannot be removed from future kept talk. On a brain record, `d` is that record type's confirmed delete. In Requests, it forgets the request without telling the agent. In Shells → Wakes, it opens confirmation before removing the selected wake. |
| `u` | In Diff, confirm **Undo last checkpoint change**. Active shell changes are checkpointed first, so the dialog may name a shell window. Recovery restores that checkpoint's changed files; a move's revision returns to unapproved review. A cut-off task warns that recovery returns the project to its earlier checkpoint. |
| `f`, `v`, `x`, `t`, `n` | On the relevant Carto row: fold a report, archive a brain record out of what the agent reads, unshelve a file, settle a record, or create a new entry. `a` shelves from Current shared brain or approves in Requests. |
| `y`, `Y` | Copy the selected row or the whole tab. |
| `r` | Read the tab again. |
| `:` | Type a command. |
| `i`, `a`, Esc | Type. |
| `?` | Show the keys. |

| In both modes | |
|---|---|
| Tab, Shift-Tab | Next and previous tab. While typing, Tab completes once there is text. |
| PgUp, PgDn, wheel | Scroll. Ctrl-Home and Ctrl-End go to the top and end. |
| Ctrl-Shift-F | Search the tab that shows. Where the terminal cannot send it, use Esc then `/`. |
| Ctrl-T | Show or hide the agent's private reasoning and notes. Nothing is added to the conversation. |
| Ctrl-C | Clear what you typed. With the line empty, press it again soon after to leave, as `/quit` does. |
| Ctrl-X | Stop the agent. |
| Ctrl-V | Pause the agent in its stream; it starts nothing on its own until you unpause or write a line or command. |
| Ctrl-K | Open the command palette for navigation and registered actions. |
| Ctrl-L | Draw the screen again. |
| Ctrl-O | Open the selected source or template in `$EDITOR`. |
| `?`, F1 | Show the keys. |

**The strip** above the place to type is always there. Its first row says what the agent is doing and where: a task and its declared move, a call, or writing. While the server reads a long prompt, it says so instead. The second row shows current context accounting, the settled model-route/native-GBNF status, open goals, plan progress, waiting requests, shell windows, wakes, and what is switched off. A stopped model server or a failed grammar gate stays visible there while local controls remain usable. A quieter third row keeps the relevant key reminder beside the input.

#### Chat, Work, Consult, Model, and Settings

Conversation is the steering wheel: it deliberately excludes reasoning, ordinary assistant text, tool work, and harness notices. Work is the private trace of ordinary agent/focus activity. Consult is a distinct, read-only projection of only the local `co<N>` conference audit plus its live child state: each contribution is visibly attributed to a consult member, while host debate-routing and final-report decisions, reasoning, chat/prose, calls, and results have separate blocks. It remains advisory—neither parent history nor project authority—and is never rendered in ordinary Work. A collapse or the screen's item limit can remove ordinary local rows from view without erasing the Durable transcript; a conference's durable audit remains consult-local.

A Conversation row is changed only after Cartographer has an admitted Durable source for it. Equal visible words are never used to choose a row. **Reword future kept talk** and **Remove from future kept talk** affect the mutable source that a later collapse may copy. They do not rewrite the append-only transcript, the active request already being built, or frozen sent payloads. If a row has not acquired a stable source yet, the screen leaves it unchanged.

**Soft-forget active message** is a different action: `book target=message action=edit` creates a Durable omission marker for one stable message entry. Later active-context construction omits it; the raw transcript and earlier sent requests remain. It is not a Conversation edit or a brain-record deletion.

Model has six distinct views:

- **Routes** is the settled model-route and transport projection. It keeps discovered names visible when a route-list refresh fails, distinguishes discovery from successful native-GBNF validation, and uses Enter to connect the active route or select and validate another listed route. It never treats a successful `/models` response alone as readiness.
- **Latest sent** follows the newest frozen provider payload from any conversation. **Main sent** stays on the newest main-agent payload. Both are read-only snapshots retained for this run. They show the provider body in semantic reading order; response material below the sent boundary is labelled **Since request — not sent**.
- **Raw payload** is the latest request's frozen serialized JSON, retained for audit or copying. It repeats the semantic sent-request rows by design; it is not a second context segment and does not count in the sent views' input-token bars.
- **Next preview** is a pure current calculation. It is explicitly **not sent**, consumes no wakes, and can change when state, windows, a read batch, a collapse, or a new message changes.
- **Current accounting** is fresh context accounting, not a sent payload and not a promise of a next request.

A sent request is the payload Cartographer passed to the provider, not proof of a server's hidden chat-template prompt. A sent row has no edit or delete action. Current ledger, shelf, report, and context-store records remain in Carto's **Current shared brain**; they are never unfolded as though they were part of an old frozen request.

Settings keeps configuration and policy state descriptive. A route-listing result never establishes readiness: only a successful native llama.cpp GBNF proof does. Blocked and disconnected diagnostics stay visible, and Cartographer does not fall back to ordinary tool calls or prompt-only decisions. The live approval, initiation, and sandbox state says what the backend will enforce; selecting or copying a Settings row cannot change it. Assessment distinguishes the durable text from its byte-stable top-of-context copy, which becomes current only through the existing safe refresh path.

**Copying.** Drag over text to select it, and it is copied when you let go. `/copy` copies the last delivered agent speech, `/copy session` exports the local session projection, `/copy report` exports the last task report, and `/copy tab` exports the tab that shows. In Consult, copying a conference exports only that private conference timeline; copying a member block exports its persona-attributed block. The files go under `.brain/export/`.

**What you send while the agent works** goes to whoever is working. If a task is running, the task reads it with the result of its current step, and the main agent is told about it with the task's report. A consultation conference is isolated and does not receive interactive user input; its caller receives only its bounded final receipt. Otherwise the main agent reads your line after its current step. When the agent has put a question to you with `ask`, the next thing you send is the answer.

What the full screen does not do yet: it does not retain an unbounded request audit or prove a provider's hidden prompt. Enable `CARTO_TRACE` for an optional wire observation.

### The plain terminal

With `--plain` the screen looks like this (an illustration of the layout, not a recorded run):

```
Cartographer · /home/momo/some/project
new brain /home/momo/some/project/.brain · ByteShape at http://127.0.0.1:8888/v1
Type a message. /help lists commands. Ctrl-C clears the line; again leaves. Ctrl-X stops the agent. Ctrl-V pauses its stream. Ctrl-T hides and shows its thinking.
› where is the config loaded?
┊ The user wants the place where configuration is read. I have no node for it yet, so I start an inspect focus (no move, only reading).
▸ task  Find where configuration is loaded. Report the file, the function and the line numbers…
│ search /config/ in src                           → 14 matches in 5 files of src.
│ read src/config.ts                               → 112 lines
│ read src/main.ts                                 → 100 lines
◂ report  1.3k characters  (/report shows it)
Configuration is loaded in src/config.ts by loadConfig() (lines 20-58) …
  context 3.4k of 100k tokens · 412 read for this answer
›
```

| You see | Meaning |
|---|---|
| `▸ task …` | The main agent handed a piece of work to a task; the text is the start of its brief. `▸ move m2 …` carries out declared move m2 |
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
| `● atlas  + component roller …` | The agent wrote or rewrote an atlas node; linking it never creates a project file |
| `● plan  ! m2 reported` | The focus returned a claim with evidence. The orchestrator reviews it, then `● plan  ✓ m2 accepted` marks the move done |
| `! Cartographer ended the turn: the same call was sent 3 times …` | The agent sent the same call three times and it failed each time. Its turn is ended; inside a task, the task is ended and the main agent is told why |
| `◂ report t3 …` | The task reported, and the report is kept as `t3`. `/report` prints the last one in full, `/report t3` that one |
| `◂ shelf  the task added src/roll.py` | A task put a file on the main agent's shelf; see [The context](#the-context) |
| `◆ context collapsed (goal g1 was closed): about 41k → 12k tokens · kept …` | The agent's context was replaced by what a collapse keeps. The reason is in the brackets |
| `◆ asked before collapsing (…): does it need to write something down first? no · 1.2 s` | The one question before a collapse, the agent's answer, and how long the server took for it |
| `read ahead by the server: 12k tokens in 16 s, so the next answer starts at once` | After a collapse at rest the server has read the new context already |
| `│ ◆ the task's steps collapsed (…)` | A task's own steps became one block of notes, because its context was nearly full or because it asked |
| `● context  folded report t12` | The agent used `book` with `target=context`: recalled or folded a report, kept a note, or asked for a collapse. `shelf` add/remove has its own call and receipt |
| `◂ Cartographer ended the task: …` | The task used all its replies without calling `return`, wrote the same note three times, or sent the same failing call three times. The main agent gets what the task had noted, and nothing is marked done |
| `◂ changed 2 files (+37 −1)` | What a change task did to the files, taken from the checkpoints and not from its report. The files are listed below it |
| `● ledger  + goal g1 …` | The agent changed its ledger: `+` added, `✓` closed, `~` reworded, `-` removed |
| `● plan  + p2 [change] …` | The agent created an authorization envelope. `● plan  + m2 [move] …` declares one executable move; its detail shows targets, proof, capabilities, budget and revision |
| `◂ atlas  wrote roller, cli` | What a task did to the graph: nodes it wrote or removed, and nodes its changes left possibly out of date |
| `● atlas  + component roller …` | The main agent changed the graph itself: `+` written, `~` rewritten, `-` removed, `✓` confirmed. Also where it moved the tree |
| `● top of the context rewritten` | The copy of the assessment and the graph at the start of the agent's context was replaced with the current ones. The next answer reads the whole context again |
| `atlas: 3 nodes · assessment written 2 h ago` | At the start: what the atlas holds |
| `plan  2 move revisions wait for you` | Those move revisions are requests; approve with `/approve m1 m2` or snapshot an envelope with `/approve p2`; name a network move or its envelope explicitly |
| `requests  4 requests wait for you` | `/requests` lists them: move revisions and questions of taste |
| `approval: OFF (yolo) · …` and the prompt `[yolo] ›` | You have switched approval off: declared change moves run without `/approve` |
| `● model  model-a → model-b · context 75k tokens (server capacity 75k; settings cap 100k)` | You switched the model with `/model`: the conversation goes on where it was, a task forked after runs on the new one, and Cartographer uses the full reported context capacity |
| `context … · … read for this answer` | How full the context is, and how many tokens the server had to read rather than reuse for the last answer |

| Command | |
|---|---|
| `/thinking`, `/thinking on`, `/thinking off`, Ctrl-T | Hide or show the agent's own text. Switching it on prints what the newest turn held back |
| `/report`, `/report t12` | The last task's report in full, or the kept report with that id |
| `/context` | What the agent's context holds, part by part with sizes; the kept reports; when it was last collapsed and when it will be next |
| `/collapse` | Collapse the agent's context now. Works while the agent is idle |
| `/fold ID …` | What the agent does with `fold`: take a kept report out of view, leaving its one line |
| `/recall ID …` | Bring a kept report back into view in full |
| `/archive ID …`, `/unarchive ID …` | Take a row out of what the agent reads for good, or bring it back: a report's record line, a ledger entry, a plan envelope or move, a node of the graph. The row stays on disk either way |
| `/done ID …` | Settle a row the way the agent does: a ledger entry is closed, a reported move is accepted after review, an envelope closes after its children, a node is confirmed |
| `/delete ID … --yes` | Remove a report for good: its record line and its file. Nothing recalls it again; Cartographer requires the explicit `--yes` acknowledgement |
| `/shelve PATH [lines]`, `/unshelve PATH\|all` | Tend the shelf as the agent does: keep a file in view from the next collapse on, or take one off |
| `/model`, `/model NAME` | The models the server serves, each with its reported server capacity where available, and which is on; a name or a number from the list switches. A task forked after runs on it too, and Cartographer states the active context limit |
| `/ledger` | Goals, questions and notes, open and closed, and where the file is |
| `/plan` | The plan, its authorization envelopes and move revisions, and where the file is |
| `/atlas` | The tree as the agent sees it, the graph, which nodes may be out of date, and where the file is |
| `/focus NODE_OR_PATH reason`, `/unfocus` | Set or clear the explicit Atlas focus; a running move remains a temporary overlay |
| `/assessment` | The agent's summary of the project, and where the file is |
| `/requests` | What waits for you: move revisions to approve and questions of taste to answer |
| `/approve ID …` | Approve exact move revisions. `/approve p2` snapshots p2's current waiting children; bare `/approve` snapshots every current waiting move |
| `/deny ID [why]` | Turn one request down: a move revision is superseded, an envelope selection denies its current waiting children, a question closes |
| `/answer ID words` | Answer a question of taste; the agent uses the answer and carries on |
| `/pin` | Replace the copy of the assessment and the graph at the start of the agent's context with the current ones now. Works while the agent is idle |
| `/yolo`, `/yolo on`, `/yolo off` | Show, switch off or switch back on the need for `/approve`. The settings can hold the default (`yolo`); a switch while running is never remembered. See [Without approval](#without-approval-yolo) |
| `/initiate`, `/initiate on`, `/initiate off` | Whether the agent starts working on its own when carto starts (it looks around, tends the map and works what is approved, or sleeps when there is nothing to do). The settings can hold the default (`initiate`); a switch while running is never remembered |
| `/wakes`, `/wakes remove ID`, `/wakes remove all` | What the agent has set to wake itself, and taking one or all of them away |
| `/diff` | What the last change task did to the files, as a patch; or a shell window, when that is the newest step. `/diff all` shows a long patch in full |
| `/undo` | Take the last step back: a change task, or what a shell window changed with no task around. Again for the one before it |
| `/bwrap` | How the tasks' commands run. `/bwrap off` runs them without the sandbox, `/bwrap on` with it again. The settings can hold the default (`bwrap`); a switch while running is never remembered |
| `/shells` | The shell windows: what runs in each, for how long, and its newest lines |
| `/kill NAME`, `/kill all` | Close a shell window, or all of them, and end what runs there |
| `/send NAME line` | Type a line into a shell window, as you; `/shells` lists the windows |
| `/stop`, Ctrl-X in the full Screen | Stop what the agent is doing. A command it was waiting for is interrupted; other shell windows keep running |
| `/pause`, Ctrl-V in the full Screen | Hold the agent in its stream mid-reply; use it again to continue, while any line or command ends the held stream |
| `/new` | Start a fresh context: the current assessment and graph, and nothing else in view. The record of finished tasks, the shelf and the talk start empty; the reports stay in `.brain/reports/` |
| `/status` | Messages in view, context size, which model is on, working or idle, how many shell windows are open, how many wakes are set, whether approval is off |
| `/quit`, Ctrl-C when idle | Leave |

Compatibility decision: the plain terminal retains command aliases such as `/stop` and `/pause` for scripts and line-oriented use. The full Screen exposes the matching Ctrl-X and Ctrl-V controls, and Ctrl-C remains its clear-line/quit control rather than a stop alias.

### How the agent talks to you

The agent has three kinds of output.

- **A note to itself.** Text without a tool call. You see it dim behind `┊`, together with the model's reasoning; nobody answers it. In the agent's own context it stands as "Note to self: …", and Cartographer follows it with one line so that the agent goes on. Notes are how a model without reasoning thinks in words. They are dropped when the context is collapsed.
- **`chat`**: what it wants you to read. It does not wait for you or end the turn; the agent continues working after sending a message. Use `ask` when it needs your answer to continue, and `sleep` when it is ready to rest. A task can use `chat` too and carries on after it.
- **`ask`**: the rare blocking question, for when truly nothing can go on without you. A matter of taste that others do not depend on is not this: the agent records it as a question in the ledger, and it waits for you in the Requests view while the agent carries on. With `ask`, the call waits until you answer, and your answer is its result. With `choices` you can answer with a number; you can always type something else. In the full screen the strip says that the agent waits and since when. `askMinutes` in the settings makes it give up after that many minutes and tell the agent to go on without an answer; the default is to wait without limit. `/stop` ends the wait. With piped input, the next line is the answer.

What is said with `chat` and `ask`, and what you answer, is kept as the conversation with you: a collapse keeps the last of it word for word.

The main agent ends its turn only with `sleep`. Since a note never ends a turn, two limits stand behind it: a turn ends after `mainTurns` replies, notes included, and at once when the agent writes the same note three times in a row. A turn that a wake started and in which the agent did nothing but write is a rest already.

### A reply that repeats itself

A local model sometimes loses its way and writes the same character or phrase until it is stopped. Cartographer watches every reply as it grows, the main agent's and a task's, including the text inside a call's arguments. When the end of it is one character about 80 times, or one phrase of up to 40 characters eight times and at least 80 characters of it, the reply is cut off and thrown away, and the agent is told what happened and gets one more try. The second time in a row, the agent is stopped and you decide. Rules, indents and rows of zeros in code do not count. `"repeatCut": false` switches this off.

### Calls that fail again and again

When the agent sends the same call, with the same arguments, three times and it fails each time, with no call succeeding in between, Cartographer ends the turn and says so on the screen. The agent finds the reason in the call's result when it works next. A new message from you starts the count again. Three such calls in one reply end the turn with that reply. Inside a task the task ends, and the main agent is told the call, the error, and the last thing the task wrote.

A reply that repeats one character or one line without end is not caught yet; that needs the live stream and comes with the interface work.

You can type while the agent works. A task receives the line with its next result, and the main agent is told about it with the task's report; otherwise the main agent receives it after its current step.

If you leave, or the program is killed, while the agent is working, the work is not lost: the next `carto` in that project continues it.

Other ways to run it:

```sh
carto -p "what does this project do?"    # one message, print the answer, leave
carto --where                            # show the core, project and brain folders; do nothing
carto --no-bwrap                         # run the tasks' commands without the sandbox
carto --here                             # use the current folder as the project, whatever is above it
carto --url URL --model NAME             # another server or model for this run
```

The model a session is on comes from the settings at every start, so a model changed in `config.json` takes hold the next time carto starts here, whatever model the stored session began with. Cartographer opens its local brain and terminal without requiring a live model connection. After the terminal is visible it makes a light `/models` health check, which does not start a model; if the server is unavailable it says so (and keeps it in the full-screen status strip) while leaving the local commands, ledger, plan, atlas and shell controls usable. Sending a message retries the connection. Immediately before the first model turn—and whenever `/model` adopts another route—Cartographer proves native GBNF enforcement; an unreachable or non-enforcing route is refused before an ordinary agent or host-control request can run, never downgraded. `/model` switches while it runs, picking from the list the server serves (llama-swap's), and every listed model becomes known to the session as it is discovered. llama-swap's top-level `context_length` (or its `context_window` mirror; legacy llama.cpp listings use `meta.n_ctx`) is the total capacity for the prompt and reply together. Cartographer refreshes that listing after the first proof request because llama-swap can discover it only once a model is loaded. When it reports one, Cartographer uses the smaller of the settings' `contextWindow` cap and that full reported capacity—there is no fixed reply reserve. The collapse threshold, shelf's soft cap (half of it), state block and display use that active context. The provider dynamically reduces an individual reply ceiling only if the actual prompt is near the server limit. `/model` lists reported server capacities and, after a switch, states the active context and settings cap. It warns when `chatWindow` is more than half of the active window and never raises that window above the settings' `contextWindow`. Every other setting (`chatWindow`, `maxTokens`, `collapseFull`, the file and entry limits) is global, not per model, and is not reloaded on a switch.

### Same-model consultation conferences

`consult` opens one bounded, isolated conference on the caller's **current resolved model**. It takes a concrete question, optional supplied context, optional captured project files, and a required consult-local opening persona. It does not switch models and has no external consultation model setting.

A host-owned llama.cpp-native GBNF selector controls both debate continuation and conclusion. Its raw no-tools request receives only the bounded consultation question, completed labelled contributions, and eligible roster—not an active persona packet, live project access, or a Durable tool surface. Before the host has recorded at least two completed contributions from two distinct participants, its grammar permits only `continue:<participant>` values. Once that host gate is met and Cartographer is eligible, the grammar also permits `report:cartographer`; the native decision alone chooses whether to continue or authorize Cartographer's final advisory. Debate participants receive immutable captured inputs and only `consult_source`; the authorized Cartographer report additionally receives `consult_return`. Participants have no project, shell, network, shared-brain, plan, approval, user-decision, or nested-task authority. A missing, malformed, ignored, or failed native decision ends the conference without fabricating a conclusion. The conference result is advisory: the agent must verify factual and technical claims against current sources, tests, or proof before relying on them.

A completed conference has an immutable private audit record. The Work view reveals that audit only when deliberately expanded or copied; it is not a continuing conversation. The former `thread` follow-up field is removed and is explicitly refused. On a brain that contains retired material, C5 preserves original storyteller and Case bytes under `.brain/legacy/raw/`, writes readable static exports under `.brain/legacy/exports/`, and converts old storyteller shelf placements to immutable snapshots. An active, resumable, unreadable, or malformed legacy Case blocks startup: use the pre-C5 release to explicitly stop unfinished work, then rerun C5 to archive it. C5 never loads or resumes archived material.

#### Native grammar is required

Cartographer proves native grammar enforcement immediately before its first model turn and whenever `/model` selects another model. The terminal itself can open while the server is stopped; its light background listing check reports an unavailable server without starting a model, and the next model turn retries. The forced-literal proof asks for an incompatible answer while allowing only `cartographer`; an endpoint that returns anything else is refused before ordinary agent or host-control work. There is no OpenAI custom-tool adapter, prompt-only routing fallback, or generic-server mode. The former `consultGrammar` compatibility setting is refused; remove it rather than trying to select an adapter.

`/consult probe [PATH]` is the inspectable version of that evidence. It sends two tiny synthetic, non-streaming requests to the **current selected model**: a forced-literal GBNF enforcement check and a finite-roster routing check. Both requests deliberately have no tools, no project files, no chat transcript, and no conference capture. Without `PATH`, Cartographer writes the raw request/response JSON log under `.brain/export/` (ignored by git). Give one new project-relative `.json` filename, for example `/consult probe llama-cpp-selector-probe.json`, to write a log you can inspect or commit. A passing diagnostic proves enforced finite output on that endpoint/model route; it does not claim calibrated or semantically correct routing.

### Which folder is the project

Going up from the folder you are in, the first folder that has a Cartographer brain or is the top of a git repository. If there is none, the folder you are in.

- The search stops before your home folder and before `/`. A brain or a repository there never becomes the project of the folders below it.
- A brain is a `.brain/` folder that holds `session.sqlite`. A `.brain/` folder with other contents does not count (see the next section).
- Your home folder and `/` are refused as projects unless you pass `--here`.
- `carto --here` uses the folder you are in, whatever is above it.
- `carto --where` shows which folder would be used and why, and creates nothing.

## How it works

The orchestrating context talks with you and decides what focused work to do. It reads project files, searches, lists, tends its shelf, reasons and plans inline, and may run read-only commands inline; project changes and commands that can write go through one focused task carrying exactly one live, approved declared move revision. A task is a forked working conversation of this same agent. It receives a fresh state block, shares the durable ledger, atlas and assessment, and may keep findings there while it works. Only the orchestrating context changes the plan.

The focus is temporary, not a second mind: when it returns, the orchestrating context receives its report and shared-memory updates, while its detailed working conversation may leave active context. This soft-forget does not erase the underlying Durable transcript. The focus should know this and keep the facts needed later in the ledger, atlas, shelf, or report. The active state block gives it a one-line `I am ...` purpose and current project/brain state. Project file text and command output stay in that working context unless kept or reported.

| Tool | Who | What |
|---|---|---|
| `task` | orchestrating context | Enter one bounded focus context. A change focus names exactly one declared move revision and runs only when that revision is live |
| `book` | orchestrating and ordinary focused contexts | One `target` + `action` call against one flat declaration; the per-action grammar is enforced locally with actionable errors. It tends reports, ledger, plan, atlas, assessment, Durable conversations/messages/tool calls/results, prompts, tools, exact local schemas, and authorized project-file changes; plan edits remain orchestrator-only |
| `read` | orchestrating and focused contexts | Inspect one project file by path or file ID. Successful calls from one reply are one transient batch; a later successful batch replaces it |
| `shelf` | orchestrating and ordinary focused contexts | Add, remove or list explicit working-memory placements that survive later read batches and collapse |
| `search` | orchestrating and focused contexts | A regular expression over project files; returns `path:line: text` |
| `list` | orchestrating and focused contexts | Project files as a tree with sizes |
| `shell` | declared change move | Type a command into a shell window under its move capability and budget; returns what it printed and its exit status, or that it is still running |
| `window` | orchestrating and focused contexts | Read a window, wait for its command, stop it, close it. Sending input requires the same live move that opened the window |
| `wake` | orchestrating context | Set or remove a wake: after a time, when a file changes, when a shell window prints something |
| `sleep` | orchestrating context | End the turn and rest until something wakes Cartographer |
| `chat` | orchestrating and ordinary focused contexts | Say something to you. Does not wait |
| `ask` | orchestrating and ordinary focused contexts | Put a question to you, with optional choices, and wait for the answer |
| `return` | focused context | End an ordinary focus with its report and optional shelf handoff |

Project-file references are confined to the project root; symlinks, `.brain/`, and `.git/` are refused. Explicit references and shelf adds are not hidden by `.cartoignore`; ambient discovery still follows its existing filters. `book` file create/edit dispatches only from a focus carrying a live declared move revision and retains its targets, capability, budget, approval, sandbox, network, and root protections; `file remove` deletes a project file the same way (a checkpoint records the deletion, so `/undo` brings it back). A file edit takes the file's ID alone and always edits the live version; an exact SHA-256 version may be pinned as a precondition, never as a required bookkeeping step. A move preserves identity only through an explicit, version-checked `file rebind`. `book target=message action=edit` soft-forgets one stable active message: later active-context construction omits it, while the raw Durable transcript and earlier sent requests remain unchanged. Top-level `read` is model-callable; the `write`, `rm`, and `edit` executors behind authorized `book` file operations are internal primitives.

**References.** New `book` calls pass `{ id, namespace?, kind?, version? }` — the ID alone is enough; the namespace and kind are inferred and the live version is used unless one is pinned. Paths are locators, not identities. File versions are SHA-256 digests and exact bytes are kept under `.brain/catalog/versions/`; retained non-file versions are under `.brain/catalog/entities/`. Durable-owned transcript/task IDs remain their native IDs. App-managed catalog file IDs and shelf placement IDs count up within the brain — `f1`, `f2`, … and `sh1`, `sh2`, … — because they only ever need to be unique per project directory; ids written before 2026-11-15 (`f-`/`sh-<uuid>`) stay valid. An explicit `carto --fork-brain` rotates the namespace, transactionally rebinds saved internal references, and records its source namespace; backups/restores keep their namespace. Tool schemas are static and flat in every request; there is no provider-side schema expansion to verify.

The same tool declarations are registered in every request, for the orchestrating context and each focus, so a fork keeps the provider prompt prefix stable. The authority hook still distinguishes them: project-file mutations run only in an ordinary focus carrying one live declared change move; when already in that focus, the checked operation runs inline. Brain-scoped book operations run directly there, but only the orchestrating context changes plans or controls session wakes/sleep. `shell` starts commands only from an ordinary focus carrying a live declared change move. An ordinary focus return records whether shared atlas, ledger, or assessment updates occurred; this is not a user-approval bypass.

### How a task goes

A focus begins with its one-line purpose in the state block, the current shared state, the brief, and instructions for what is allowed. It knows its detailed working conversation may leave active context at return, so it should put lasting findings in the shared ledger and atlas before they are lost; the underlying Durable transcript remains stored. After that:

- Text without a call is a note to itself and never ends the focus.
- `chat` and `ask` reach you from inside a focus.
- `book` can update the shared ledger (including salient notes), the assessment (one whole-text write), reports, and atlas. `shelf` tends the focus's working set. The only book operation reserved for the orchestrating context is changing the plan. `task`, `wake`, and `sleep` remain orchestration-only; a focus cannot nest another focus.
- **`return` ends the focus**, and nothing else does. `report` carries the outcome not already represented in shared memory. `done` says whether the assigned work is carried out; `true` reports a completion claim, but the orchestrating context must review the durable report and checkpoint evidence before it accepts the move. `summary` is the line kept for the focus after collapse; without it, the start of the report is used. `shelf` names files or references to add if needed, then hand to the shared context.
- A declared move focus has the move's hard reply budget (six by default; at most eight), notes included; an inspect focus gets four. From three before the end, each result says how many remain and asks for return. If it uses them all, the orchestrating context receives the notes marked as not a report, and nothing is marked done.
- What you type while a focus runs goes to it with its next result; the orchestrating context is told with the report.

The session is stored by [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) in one SQLite file.

The full screen is built on [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui), the terminal library pi itself uses. pi-tui owns the terminal: it reads the keys in whatever way the terminal speaks (the Kitty keyboard protocol where there is one), lays the parts of the screen out, scrolls them, selects and copies text with the mouse, searches, lays sheets over the screen, edits what you type, renders the agent's Markdown, and writes only the rows that changed. Cartographer's own is what the tabs hold, the two modes, and the colours (`src/screen/`). pi-durable itself does not use pi-tui.

## The ledger and goals

The ledger is the agent's memory of the project across sessions. The conversation is disposable; the ledger is what stays. It holds three kinds of entry:

| Kind | | |
|---|---|---|
| goal | `g1` | Something you want achieved, with a "done when" line saying how you will both know it is reached |
| question | `q2` | Something of taste or design for you to answer; it waits in the Requests view while the agent carries on |
| note | `n3` | Anything else worth keeping: a decision, a preference, a finding |

A note the agent expects to need at every step carries `"salient": true`; a salient note is marked ● and stands in every request and in the block a collapse keeps, until the mark is cleared (`salient: false`) or the note is closed. Only a note carries salience.

It is a notebook, not a gate. Nothing in it stops the agent from working, and the agent needs no permission to write to it. The agent is told to record a goal once you have agreed to its wording, to change that wording only when you ask, and to write down what you say that should outlast the conversation. Every change it makes is printed as a `● ledger` line, so you see what it understood.

When there is no open goal, `carto` says so at the start, and the agent is told to answer what you ask and to find out what you want to achieve. When it closes a goal, it is told to say what was achieved against the done-when line and to ask whether that is what you wanted.

**Editing it yourself.** The ledger is `<project>/.brain/carto-ledger.json`. Change it in any editor, or tell the agent what to change. The file is read again at every step, so an edit takes effect at the agent's next request. An entry needs only `id` (like `g1`, `q2`, `n3`), `kind` and `text`; a goal also takes `doneWhen`, a note may take `"salient": true`, and `"status": "done"` closes an entry. If the file cannot be read after an edit, `carto` and the agent both say what is wrong, and nothing writes to the file until it is repaired.

Limits: 400 characters per entry, 40 open entries, and the newest 50 closed entries are kept.

## Requests and declared moves

Nothing in the project is changed, and no command is started, without one declared **change move**. The plan has two layers:

- An **authorization envelope** (`p<N>`) records the user-visible intent and its final done-when condition. It never runs.
- An executable **move** (`m<N>`) is one concrete action under an envelope. It stores its exact action, targets, completion condition, required proof, capabilities, hard budget, revision, approval and lifecycle state.

The Requests view shows waiting move revisions, not broad envelopes. `/approve m2` approves exactly revision 1 of `m2`. `/approve p2` snapshots and approves the waiting children of `p2` at that moment; it cannot approve a child added later. Bare `/approve` snapshots all waiting move revisions. `/deny m2 [why]` supersedes that revision. A plain affirmative can approve ordinary waiting moves, but an affirmative never silently approves a network move; name that move or envelope. Editing a move creates a new revision and removes its approval. Adding a move or changing an envelope invalidates incomplete child approvals, so the request always describes the current contract.

```
› /requests
  Requests  2 requests wait for you:
    m2  [approval]  m2 r1 [change] Create src/roll.py
    q3  [question]  q3  Should a wrong argument print the usage text or an error?
  /approve ID ... approves · /deny ID [why] turns one down · /answer ID words answers a question
```

A move is deliberately small. A change move must name project-relative targets and required proof, and by default gets at most 6 model replies, 4 successful direct file operations, and 2 command starts. The focus gets that one move revision only: no free-form brief can add paths or authority. Read-only investigation, planning and reasoning stay available inline and do not need a move.

A focus ending with `done: true` has made a claim, not completed the plan. Cartographer records before/after checkpoints, rejects changed paths outside the move's targets, keeps command evidence, and turns the focus into a durable report. The orchestrating context reads that report and explicitly accepts the move. An envelope can close only after every child move is accepted or superseded. This makes the approval, evidence and final acceptance separately visible.

**Checkpoints and undo.** A change focus is checkpointed before and after its move. `/diff` shows its record. `/undo` restores the checkpoint delta and reopens that exact move as a fresh, unapproved revision; it does not reopen a broad envelope as permission to redo arbitrary work. Files the move did not touch stay as they are. A task stopped before an after-checkpoint is still recorded as interrupted; undo uses the before checkpoint and can therefore also take back later edits made in the same project state.

**Direct files and commands.** The main agent never writes. `book` file create/edit/remove checks the focus's live move token on every successful operation, including its revision, approval, file capability, targets and remaining file budget. Commands check the same live token, capability, network permission and command-start budget. A move may send input only to a window it opened. Shell writes cannot be fully confined to paths by prompt or wrapper, so Cartographer detects scope breaches from the final checkpoint diff and blocks the move; it does not claim preventative shell path confinement. Move-owned busy windows close before the final checkpoint, preventing a program from continuing to write after the report.

All project paths remain confined to the project root; symlinks, `.brain/`, `.git/`, ignored paths and nested repositories are refused because checkpoints cannot safely undo them.

**Editing the plan yourself.** The plan is `<project>/.brain/carto-plan.json`, read again at every step. Envelopes live in `items` and moves in `moves`. A change envelope has `id`, `mode`, `text`, and `doneWhen`. A change move has `id`, `parent`, `action` (also mirrored as legacy `text`), `targets`, `doneWhen`, `proof`, `capabilities`, `budget`, `revision`, `status`, and, when approved, `approvedRevision`. Hand-editing an active plan is possible, but malformed records stop plan writes and execution until repaired. Do not set approval fields to grant future work: approvals are exact move-revision snapshots.

### Without approval (yolo)

`carto --yolo`, or `/yolo on`, skips the user-approval wait for declared change moves. It is meant for when you are present and watching. It does **not** widen a move: each focus still gets one exact move revision; targets, capabilities, budgets, checkpoints, report evidence, scope review and orchestrator acceptance stay in force. `/yolo off` restores waiting requests for unapproved revisions. The setting is session-only unless configured in `config.json`.

What yolo does not change: the main agent still never writes; read-only inline commands still use the read-only sandbox; the command sandbox is separately controlled by `/bwrap`; and adding a later move never inherits authority from an earlier one.

## Running commands

A declared change move runs commands with `shell`: to try what it wrote, run its stated test, install a named dependency, start a server, or move/delete a declared file. The main agent may run a command too, as a read: it opens a read-only window (the project, the brain and `.git` mounted read-only, no network), which is enough for the tests, the lints and `git status`, and for nothing that writes. With the sandbox off the main agent still runs commands in a read-only window when bubblewrap works; when bubblewrap does not work, nothing holds a window to read-only and the main agent runs none.

```
▸ task m2  Write src/roll.py and run its stated checks…
│ write src/roll.py                                → 12 lines, a new file
│ $ python src/roll.py 2d6
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

**Who may do what.** Starting a command or sending a line of input is for the task carrying the live declared move that owns the window. Reading, waiting, stopping and closing are open to the main agent and to every task, because none of them starts anything: the main agent can wait for a build itself, and stop or close what it no longer needs. The main agent may also run a command itself, but such a command runs in a read-only window: the project, the brain and `.git` are mounted read-only and the window has no network, so it is for the tests, the lints, git status and other checks that change nothing — like any other read. With the sandbox off the command still runs in a read-only window when bubblewrap works — the off switch now governs only how change tasks run their commands; when bubblewrap does not work, nothing holds the window to read-only and the main agent runs none. A command that must write or reach the network needs a declared change move.

**You and the windows.** `/shells` lists them with their newest lines. `/kill NAME` closes one and ends what runs there, `/kill all` every one; the agent finds a line in its windows block saying that you closed it. `/stop` (or Ctrl-X in the full Screen) stops the agent and interrupts the command it was waiting for at that moment; commands in other windows keep running, and a line names them. Windows do not outlive `carto`: they end when you leave and when it is killed, and at the next start the agent is told which windows were running something and are gone.

**A window after its task.** A window that is still running when its task ends can go on changing files. Those changes belong to no task, so Cartographer records them as a step of their own, named after the window, when the command ends, before the next change task starts, and when you leave. `/diff` shows such a step and `/undo` takes it back like a task's, without touching the plan. Only windows that were running something count: what you edit yourself while every window stands free is never recorded as a window's doing. What you edit while a window is at work does land in that window's step, since Cartographer cannot tell who wrote a file. A process that a command left in the background of a free window (`… &`) is not noticed this way; its changes go unrecorded until the next task's checkpoint takes them as given.

**Who may run a command.** A focus starts or sends a command only with its live declared move. Inline read-only commands remain available to the orchestrator. A mutating or networked test belongs in a narrow declared move and waits for that move's approval.

### Starting on its own

When carto starts, the agent gets a turn of its own: nobody has to write first. In it the agent does what the situation calls for — reads the project and tends the assessment and the atlas, works an approved move, or calls `sleep` when there is nothing to do. What it may do without you in the room follows the same gates as always: looking is free, changes wait for your approval (unless `/yolo`), and inline commands it runs itself are read-only — when bubblewrap is unavailable that inline lane has none. An authorized change move remains its separate, declared direct lane when `/bwrap off` is in effect. `/initiate off` keeps it waiting for you instead; `/initiate on` lets it start on its own again, and it starts at once if it is resting. The setting is `initiate` in the settings (default `true`); a `/initiate` switch while carto runs is never remembered. This first turn is what keeps an unattended `carto` moving: without it the agent sat in front of an unread project until someone wrote.

### Waking up

Besides the automatic wakes above, the agent can set its own with the `wake` tool. A wake does not make the agent wait: it sets one and goes on working, or ends its turn, and is told when the wake fires. Three kinds:

| The agent gives | It is woken |
|---|---|
| `every` (seconds) | each time that long has passed |
| `path` | when that file changes, appears or disappears; for a folder, any file under it. Inside the project only, and not `.brain/` |
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

**Between runs.** Wakes are kept in `.brain/carto-wakes.json` and are there again at the next start. Nothing fires while `carto` is not running: a time that came due meanwhile fires once at the start, and a file wake compares with the files as they are then.

What this does not do yet:

- It saves context, not inference: each firing is still one request, and with a context that changed far back, a slow one.
- A wake turn in which the agent acts stays in the context like any other turn. An agent that acts on every wake fills its context until the context engine exists.
- Wakes belong to the main agent. A task cannot set one.
- With approval on and no approved declared move, a woken agent can look and report but cannot change anything until you are back. See [Requests](#requests) and [Without approval](#without-approval-yolo).
- On the plain terminal a `◆` line that arrives while you are typing lands in the middle of your line. What you typed is still there and is sent when you press Enter.

### The sandbox

Every command window is a [bubblewrap](https://github.com/containers/bubblewrap) sandbox unless you switch the sandbox off (below). A **normal change-move command** is not pointed at the live project: Cartographer first makes one private, disposable source copy for that focus, then runs its stage windows there. The live project is never writable from those windows. It sees the machine like this:

| | |
|---|---|
| Stage work tree | The only writable project-shaped path. It is a bounded copy outside the project and `.brain/`; its candidate diff is not a project change yet |
| Live project | At most visible through bubblewrap's read-only system view; never rebound writable |
| `.brain/` and `.git/` of the live project | Blocked in a command stage; neither is an alternate source or write route |
| Dependencies | A present `node_modules/` may be overlaid read-only for command resolution; it is not a candidate path |
| The system (`/usr`, `/etc`, …) | Read-only |
| Your home folder | Not there. A normal window gets `<project>/.brain/home/`; a command stage gets a fresh private home that is destroyed with the stage |
| Toolchains in your home folder | Read-only in ordinary windows: every `PATH` entry that lies in your home folder, and these folders when they exist: `.nvm` `.volta` `.bun` `.deno` `.rustup` `.pyenv` `.rbenv` `.asdf` `.sdkman` `.juliaup` `.ghcup` `.dotnet` `.local/lib` `.local/share/{mise,uv,pnpm,fnm}` |
| `/tmp`, `/var/tmp` | The window's own: empty when it opens, gone when it closes |
| `/run`, `/mnt`, `/media` | Empty: no sockets of your session, no other drives |
| The network | Off, unless the staged move's declared capability grants it |
| Processes | Only the window's own. They end when the window is closed, and when Cartographer exits or is killed. What a command leaves in the background stays until then, as in any terminal |
| The environment | A short fixed list (`PATH`, `HOME`, `LANG`, …). No variable of your shell is passed on |
| Input | A terminal. A program can ask, and a change task can answer with `window` send. Programs that notice a terminal behave as they do for you: `ls` prints in columns. Colours and pagers are switched off |

At the focus boundary Cartographer closes every stage window, scans a bounded manifest-backed candidate, and checks its source digest, exact approved move revision, target list, file-operation and changed-surface limits before it writes any live path. It validates the whole candidate first and restores earlier paths if an apply fails. A stale, malformed, oversized, or out-of-target stage is discarded; a cleanup failure blocks the move; either is a durable closure gap. Direct mode below is deliberately different: it keeps detection-only final-checkpoint scope review.

If a program that works in your terminal is "not found" in an ordinary sandbox window, it probably lives in a part of your home folder that is not in the list above. Name its folder in the `shellRead` setting. A command stage deliberately has no extra host read folders: its source input is the frozen stage copy and its read-only dependency overlay.

**A read-only window.** The main agent runs its own commands (the tests, the lints, `git status`) in a window that is read-only like any other read: the project folder and the brain are mounted read-only there too, and the network is unreachable, whatever envelope text says. The window exists only while the sandbox is on. The window is shown with `read-only` in the windows block. A command that must write or reach the network cannot run in one; it needs a declared change move. Reading, waiting, stopping and closing work the same in it.

**The network.** A change move can declare `network: true` in its capabilities when its envelope permits it, for steps such as installing packages:

```
● plan  + p2 [change envelope] Install dependencies
● plan  + m2 [move, network] npm install package-x
plan  1 move waits for approval: /approve m2 approves this revision
```

You see the mark before you authorize, and changing a move's network capability creates a new unapproved revision. The commands of that move's focus then share the machine's network, which includes services on localhost such as the model server. Other moves have no network at all; a command that fails there is told so.

The network is decided when a window opens and stays with the window. A move without network capability cannot type into a network window, and a network move cannot inherit network through a window another move opened: each uses its own window.

**Output.** No command is stopped for taking long; it is left running, as described above. A call returns the first 40 lines and the last 160 of what was printed (at most 2,000 and 8,000 characters), with a line in between that says how many were left out. Colour codes are removed and a progress bar is reduced to its last state.

**What undo covers.** A promoted staged candidate contains only regular, non-ignored project files that passed the ordinary move gate. Its successful promotion is then in the checkpoints like any other change: the record after the task lists it, `/diff` shows it, and `/undo` takes it back. A staged command cannot promote build output, installed dependencies, an `.env` file, a nested repository, `.git`, or `.brain`; those paths are refused rather than quietly escaping the checkpoint. The broader exception still applies in direct mode, where a command can alter ignored or outside-project files before the final checkpoint detects only project-surface consequences.

**After a kill.** A window that was open when Cartographer was killed ends with it, and so does what ran there. A dead process's disposable command stage is removed on the next start; no staged candidate is applied during recovery and no command is run again. The resumed task records the missing/stopped stage as a closure gap and needs a deliberate successor move if the work still matters. The agent's windows block says which windows are gone and what they were running.

**Switching the sandbox off.** When the work has to reach beyond the project folder, you can let commands run without the sandbox:

```
carto --no-bwrap        for the whole session
"bwrap": false          in the settings, for every run until changed
/bwrap off              from now on; /bwrap on switches back; /bwrap shows which it is
```

Commands then run directly on the machine, as you, with your environment and the network. They can read, change and delete whatever you can, anywhere. What stays the same:

- A plan still needs `/approve` before a task's command runs. With the sandbox off, tasks' commands run directly on your machine; the main agent's commands still run in a read-only window while bubblewrap works, and not at all when it does not.
- `book` file create/edit/remove, top-level `read`, `shelf`, `search` and `list` still reach the project folder only. The way out of it is `shell`.
- The windows work the same, with bounded output, and every process of a window ends with it: on `/kill`, when you leave, and within about a second of Cartographer being killed. A process that detaches itself into a session of its own escapes this.

What you give up:

- `/undo` and the record of changed files cover the project folder only. What a command changes outside it is neither listed nor reversible. The task's record says so.
- The plan's `network` mark means nothing: every command has the network.
- A command can also change the project's `.git` folder and the brain in `.brain/`, checkpoints included. In the sandbox both are read-only.

The switch is not stored. Every start is sandboxed again unless you pass `--no-bwrap` or the settings say `"bwrap": false`, and that includes a task that was cut off by a kill and is resumed: its remaining commands run in the sandbox. `/bwrap` waits until the agent has stopped, because a running task was told how its commands run when it started. A window keeps the way it was opened, so a switch in either direction closes every open window, with what runs there; the same name is a new window afterwards.

While the sandbox is off, the prompt reads `[no sandbox] ›`, each command's result line says `no sandbox`, and `/approve` repeats it. The agent is told in the state block and each change task in its brief; both are asked to stay inside the project folder unless you asked for something outside it. That is a request to the model, not a barrier.

**Without bubblewrap.** When `bwrap` is missing, or cannot start a sandbox on the machine, the header says so (`no sandbox: … · tasks cannot run commands`), `shell` is refused, and the agent is told to say how to run what it wrote. Looking, writing and editing work as before. `--no-bwrap`, the settings' `"bwrap": false`, or `/bwrap off` runs commands on such a machine, without a sandbox.

Limits:

- The sandbox guards against accidents: a command that deletes the wrong folder, kills the wrong process or writes where it should not. It is as strong as bubblewrap and the kernel, and it was not examined as a defence against a program written to break out.
- In a project without a `.gitignore`, everything a command creates is checkpointed, a virtual environment or a build folder included. That costs time and space; a `.gitignore` avoids it.
- `.brain/home/` grows with the caches tools keep there. It can be deleted at any time.
- A command's output appears on the screen only as its last line, when the call returns. `/shells` shows more of it while it runs.
- A window is line-based. A program that draws the whole screen (an editor, `top`, `less`) cannot be used in it.
- The guess that a program waits for input rests on a line without a line end followed by silence. A progress display that stops moving looks the same.
- Windows do not survive a restart of `carto`. A server the agent needs again has to be started again; the agent is told that it is gone.

## The atlas, the assessment and time

The atlas is the agent's map of the project. It has two parts, and they are kept apart on purpose: one is what the folder holds, the other is what the agent has understood.

**The tree** is drawn by Cartographer from the files as they are, so it cannot be wrong or out of date. It respects `.gitignore` and leaves out `.brain/`. It is drawn three levels below an anchor, which starts at the project root; a folder below the last level is one line with a file count. A drawing longer than 60 lines is made smaller, first by showing fewer entries of each folder, then fewer levels, and the first line says so. The agent sees the tree in every request and can move it: an `atlas` call with a `tree` operation sets the anchor to a folder, sets it back with anchor `.`, or changes the depth from 1 to 6. The view stays as the agent left it, across sessions. A task gets the tree in its brief and looks further with `list`.

**The graph** is written by the agent and its tasks as nodes. A node has a name, one line that says what it is, and optionally a longer detail, links to other nodes, and links to files or folders. A node needs no file and no link, and no file needs a node: what gets a node is the agent's decision. Each file line of the tree names the nodes that link to it.

When a node links to a file, Cartographer keeps a fingerprint of that file from the moment the node was written. If the file later changes or disappears, the node is reported as "may be out of date", to the agent in every request and under the report of the task that changed the file. It stays so until the node is rewritten or the agent confirms that it still holds. A folder link notices files added to or removed from that folder, not changes inside them.

**A node for a file that is not there yet.** Linking an atlas node never creates a project file. The agent first creates the file through a declared move's checked file action, then links the node. This keeps every project mutation inside a move checkpoint and undo record.

**Attention is a separate trail.** The graph's claims remain durable; attention is a bounded, derived record in the same atlas file. A deliberate successful read or shelf placement, an Atlas action, a task/checkpoint change, file drift, and a broken link can advance the work trail. Directly observed nodes are hot; only their immediate inbound or outbound graph neighbours are nearby. Heat never spreads a second hop. A touched path with no existing node stays visible as a mapping gap — Cartographer never invents a node for it. Missing fingerprints, drift, broken links, and gaps are separate `Needs checking` facts rather than proof that a claim is false.

**Focus and active work.** You or the agent can set one explicit focus on a node or confined project path, with a short reason. It persists across restarts until visibly replaced or cleared. A running move contributes a temporary `Active work` overlay for its declared targets; it never overwrites explicit focus. The fresh request-tail map groups focus, active work, hot, nearby, mapping gaps, needs checking, and cold candidates. The stable graph/tree copy remains structural so attention changes do not churn the cached top of context.

**Cold candidates are advice, not automation.** A cold, isolated node may be shown with the reasons it is a reversible archive candidate. During active work the map says only how many candidates there are; maintenance/idle work can show their details. No node is automatically archived or removed. `archive` hides it from the active map and `restore` returns it; a focused archived node keeps its lens, and removal requires the focus to be deliberately cleared or replaced first.

**The assessment.** The agent keeps one summary of the project for itself: what it is, how it is built and run, what state it is in, what matters when changing it. It lives in `.brain/assessment.md` as plain text, rides at the top of the agent's context, and its only write path is one whole-text `book` call (`target=assessment, action=write`) — the whole text at once, no entries, no partial edits; the details that would not fit belong in nodes of the atlas. A task cannot rewrite it; it puts what it learned in its report.

**Who writes.** A task that carries no move is asked to record what it learned that will still matter later, and a task that carries a change move rewrites the nodes about what it changed. Both write directly, so the knowledge does not have to pass through a report and be written down a second time. Under the task's report the main agent gets Cartographer's own record: which nodes the task wrote, removed, or left possibly out of date. The main agent can write, correct and remove nodes too.

**Mapping without a goal.** When no goal is set, or moves wait for `/approve`, the agent may start an inspect task (no move, only reading) that maps a part of the project the graph says nothing about. Whether to do that and when to stop is left to it. Nothing in the project changes; type a message or `/stop` at any time.

**Editing them yourself.** The graph is `<project>/.brain/carto-atlas.json`, the assessment is `<project>/.brain/assessment.md`. Both are read again at every step. A node needs `name` and `gist`; everything else is optional, and fields Cartographer does not know are kept. An assessment you keep by hand works as it is, and `/assessment` shows it. A books file (`carto-books.json`) left from an earlier Cartographer is folded into the assessment the first time it is read, once, and its practice entries are dropped — the practice book is retired. A node you added is listed as new. A graph file that cannot be read is reported to you and to the agent and is never overwritten; the tree is still drawn.

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
  cli  Prints one roll; takes no arguments yet  [src/cli.py]
  roller  roll(sides) returns a random whole number from 1 to sides  [src/roll.py]  → cli
  tests_are_empty  tests/test_roll.py holds one test that checks nothing
  /home/momo/Projects/simpledice/.brain/carto-atlas.json · edit it by hand, or tell the agent what to change
```

## The built-in prompt

The system prompt and tool descriptions are source code in `src/prompt.mjs`. They are fixed for a run; changing them is a code change reviewed and made by the project maintainer. There is no agent-facing proposal, approval, or runtime overlay workflow. The old core `prompt.json` and project `.brain/carto-proposals.json`, if present, are left untouched but are no longer read or applied.

Besides the tool descriptions, the prompt tells the agent how to work when nobody is talking to it. In substance:

- **The dyad.** You work beside the agent at a shared screen. Chat Conversation is the steering wheel: interrupt any time, and answer while it works; your messages may drop or redirect the work, and your edits to the brain are taken as they are.
- **Two modes.** With approval required (the default), each change move revision is a request you answer in your own time; looking, recording, testing and proposing never wait for it. With approval off (`/yolo`), the agent still gets one declared move at a time, with the same targets, budgets, checkpoints, evidence review and sandbox. Approval off is trust, never wider authority. The state block says which mode you are in.
- **The standing duty.** At the start of a session, and after every wake with nothing owed to you, the agent's turn is its own: map the project, record it in the assessment and the atlas, form hypotheses and test them (with the commands it may run), work what stands approved, and keep the map honest. Your silence is "not authorized yet", never "do not look".
- **Sleep, with evidence.** `sleep` is a conclusion the agent reaches after checking a written list — nothing waiting from you, no open wake, no approved move ready, no question owed to you, no untested hypothesis, no unmapped ground in view, no found weakness unplanned. If anything remains, that is the next work, not a reason to sleep.

What the state block says (time, tree, atlas, ledger, plan, requests, shelf, fold-ins) is built fresh for every request and is never stored; see [How the agent sees its brain](#how-the-agent-sees-its-brain).

### Time

The model has no clock, so Cartographer tells it the time in three places, always written the same way:

- after each of your messages: `[sent Tue 10 Nov 2026, 14:05]`;
- after each task report: `[task ended Tue 10 Nov 2026, 14:07, after 2 m 10 s]`;
- at the head of the state block: the time now, how long ago your newest message came, and since when the agent has been working.

Ledger entries older than an hour say their age, and so does a node when the agent looks at it. The stamps are worked out from the stored time of each message at the moment a request is sent. They are not stored, and a message carries the same words in every request, so they cost nothing to re-read. Times are in the time zone of the machine `carto` runs on.

Shell windows use the same clock: how long a command has been running, and how long ago the last one ended.

## How the agent sees its brain

None of the brain is stored in the conversation. Cartographer adds it to each request as the request is sent, in two places chosen by how often the content changes. The server re-reads a prompt from the first changed character on, so what changes rarely goes to the front and what changes often goes to the very end.

**At the front: the assessment and the outline of the graph.** The assessment and the graph's outline stand before your first message, in every request of the main agent and of every task:

```
<project>
Written by Cartographer from your own records of this project, as they stood on Tue 10 Nov 2026, 14:05 (goal g1 was closed). What was written since is listed in the state block at the end of the request.

Your assessment
A small Python dice roller. roll.py holds the roller, cli.py prints one roll. The tests check nothing yet.

Your graph (3 nodes)
  cli  Prints one roll; takes no arguments yet  [src/cli.py]
  roller  roll(sides) returns a random whole number from 1 to sides  [src/roll.py]  → cli
  tests_are_empty  tests/test_roll.py holds one test that checks nothing
</project>
```

This is a copy, kept in `.brain/carto-top.json`, and it is replaced at four moments only: the first start in a project, when the context is collapsed (a closed goal is the usual cause), on `/new`, and on `/pin`. Writing a node or the assessment does not touch it, because a change here makes the server read the whole context again; at a collapse the whole context is read again anyway, so the new copy costs nothing more. Between those moments the state block lists the nodes written since the copy, and the agent's own `book` (target=assessment, action=write) call holds its newest assessment. An outline over 6,000 characters lists its oldest nodes by name only.

**At the end: the state block.** Each request of the main agent ends with a block, built at that moment and added to that request only (a task gets its own copy too — see below):

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
Not approved: 1 change move waits for you.
  p2 [change] Write roll.py with the roller and its argument check (done when: the command and argument check are demonstrated)
    m2 [waits for approval · 6 replies · 4 file ops · 2 commands] Write src/roll.py and run its stated check · src/roll.py
  (done envelopes: p1)

Requests
  m2 [waits for approval · 6 replies · 4 file ops · 2 commands] Write src/roll.py and run its stated check · src/roll.py · waits for approval
  q3  Should a wrong argument print the usage text or an error? · waits for an answer

Answer the user's newest message first. Declared change moves wait for the user: show their exact contracts and ask for approval. Do not start m2 before approval; inline reading, reasoning and planning continue.
</state>
```

The last paragraph is one instruction for the situation at hand: no goal, a goal without a plan, move revisions waiting for you, an authorized next move, or a finished plan.

So the agent always sees exactly one copy of the state, the current one, also after `/new` and after an edit by hand. The block does not depend on what the conversation holds, so a collapse of the context does not lose it. Because the block is at the very end of the prompt, the server re-reads only the block and what follows the previous request, not what comes before. Measured on llama.cpp with a goal and a note in the ledger: 130 to 230 tokens read per main-agent request. A task gets its own copy of the block too — the never-stale truth plus its purpose in place of the main agent's next-step instruction, its own server count and the same shelf lines, and what waits for you; only the wakes stay the main agent's, since nothing in a task can act on one. (The windows block, which a task also gets while a window is open, is described under [Shell windows](#shell-windows).) Those figures are from before the tree and the atlas lines were part of the block; it is longer now by those lines, and none of this slice has been measured on a real server yet.

The fixed part of the prompt, system text plus tool descriptions, grew with the plan, the change tools, the atlas, the shell windows, the wakes, the context engine and the task flow (`ask`, `return`). It was about 2,100 tokens before them. It is now about 9,100 tokens by a rough count of four characters per token, of which the `atlas` tool's description is about 1,100, `shell` and `window` together about 900, `wake` and `sleep` together about 650 and `context` about 500, and the first request of an empty project comes to about 9,400; that is an estimate, and `/context` after the first answer shows the real number on your server. The fixed part is read once per server start and reused after that. The figures in the paragraph above were measured before the plan was part of the block; with a plan in it the block is longer by the plan's lines.

## The context

The model reads one context of at most `contextWindow` tokens, and a long piece of work produces more than that. Cartographer keeps the context small by **collapsing** it: everything the agent had in view is replaced by one block that holds what is worth keeping. pi-durable's own compaction, which would have the model write a summary, is switched off.

A collapse writes no summary and asks the model for nothing but one word. What it keeps was collected while the work happened:

- **One line for each finished task**, with an id and the minute it ended: which kind, what was asked, how it ended, in the order the tasks ended. The report itself is kept in `.brain/reports/t12.md`, and the agent gets it back in full with `context` and the id. You read it with `/report t12`.
- **The shelf**: files, or line ranges of files, that the agent chose to keep in view — a structured listing of what stands, then the contents, as the collapse found them. See below.
- **The talk**: what you wrote and what the agent said to you with `chat`, word for word, in order, each saying with the minute it was said, the newest `chatWindow` tokens of it (8,000 unless you change it). The agent's own notes and reasoning are not talk and are not kept, which is the reason `chat` is a tool of its own.
- **The calls of the stretch before the collapse**: one line per call — the minute, the call as Cartographer describes it, its outcome — in the order they were made. The newest that fit (about 1,000 tokens) stand; the rest are counted out, one line. This part is history: it is never re-dressed or re-read, only written.

Every line of the block carries a local hour:minute; each cluster reads in the order it happened.

The ledger, the plan, the graph and the assessment are not in the conversation at all, so a collapse cannot touch them. (A salient note is shown in the kept block as a copy re-read from the ledger at the boundary; the ledger itself remains the only copy that counts.) The agent is told this in its prompt: what it will need later belongs there.

After a collapse a request is laid out like this, from what changes least to what changes most:

```
the prompt and the tools          never change
<project> … </project>            the copy of the assessment and the graph, renewed at each collapse
<context> … </context>            the block: task lines, salient notes, shelf, talk, calls. Unchanged until the next collapse
the work since the collapse       grows at its end only
<state> … </state>                written anew for every request
<windows> … </windows>            written anew for every request
```

The block as the agent reads it:

```
<context>
Written by me, from my own records, not by user's hand. My context was collapsed at 14:32 (it held about 78% of what fits). What I had in view before is gone except for what stands here: the finished tasks, my salient notes, my shelf, the last of my talk with user, and the calls of the stretch before the collapse. My ledger, plan, graph and assessment are as I left them; the state block at the end of the request shows them.

Finished tasks (`book` with book context, action recall and the id brings a report back in full)
s3 · 13:05 · look · asked: Map src/ and record what each file does → Three files; roll.py holds the roller …
s4 · 13:40 · change m1 · asked: Add a --sides option to cli.py → Added; 2 files changed, tests pass

Salient notes (ledger notes marked salient; `book` with target=ledger, action=edit, salient: false drops the mark)
09:12  ● n3  roll.py's watch step must survive the rename

Shelf at 14:32 · 1 item, as the files were at the collapse
14:32  src/roll.py [sh1]

== src/roll.py (lines 1-18 of 18) [shelf id sh1]
 1  import random
 …

Talk with the user, word for word, in order; what was said before 13:18 is gone
13:18  user: make the dice roller take the number of sides
13:19  me: Then the goal is: …

Calls of the stretch before the collapse (the minute, the call, its outcome; the newest that fit stand here)
13:20  read README.md → 2 lines
13:22  shell npm test → exit 0 · 4.2 s
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
| The agent calls `book` with `target=context`, `action=collapse` | When the calls of that reply are done |

A collapse that would free next to nothing is not made, however full the context is. That case means the shelf, the talk and the fixed part fill the window by themselves; lower `chatWindow`.

**The question (opt-in, off by default).** With `"handoffQuestion": true`, before a collapse that the agent did not ask for itself, Cartographer asks it whether something in view is written down nowhere and will be needed. With the default `false` the collapse carries the last reply mechanically — the block quotes the calls of the last reply and what each returned, never asks — and nothing of that one request is spent on the question. The control request is a separate no-tools native-GBNF completion that permits exactly `{"handoff":true}` or `{"handoff":false}`, with thinking switched off. `false` collapses at once; `true` gives the agent one turn to write down what it needs in the ledger, graph, assessment, or shelf. A malformed, unsupported, or unconstrained answer is not retried without grammar: the screen records the failure and the collapse is made mechanically.

**The read-ahead.** A new context has to be read by the server once, and at about 740 tokens a second a block of 15,000 tokens takes 20 seconds. After a collapse at rest Cartographer therefore sends the new start of the context at once, asking for one token of answer, so that it is read while you are away. When you type before it is done, it is stopped and your message goes first. `readAhead: false` switches it off. A collapse in the middle of a turn needs none: the agent's next request reads the new context.

### The shelf

One `read` call inspects one project file. Up to eight `read` calls made by the same agent reply are admitted as one transient batch and divide about 8,192 output tokens before they run. Their successful raw-line results stand together at the very end of the next request; a failed read stays inline and does not displace the preceding successful batch. A later successful batch removes the prior batch from active view. This is not a context collapse and writes nothing to the brain: the Durable transcript still holds every tool result, while the request simply carries the current batch at its tail. The agent reads every file it needs to compare in the same reply. Before that happens, it deliberately preserves source material it needs afterward on `shelf` or records lasting conclusions in the ledger, atlas or assessment.

`shelf` is the explicit durable working set. `shelf` with `action:"add"` takes a project `path` or `id` (and optional `range:"1-80"`), a report, pinned record, or an existing placement to refresh; `action:"remove"` takes it off, and `action:"list"` shows placements. An add returns a one-line receipt and the snapshot appears immediately in the state block, then survives collapse. A focus has its own shelf; `handOn: true` passes a placement to the main shelf when that focus returns. There is no shelf question or automatic promotion from `read`. Migrated legacy consultation snapshots may be removed but cannot be refreshed or resumed.

The shelf holds whatever the agent or you add; nothing refuses. Half the window (the shelf's soft cap) is its intended share, and as it fills the state block says so, in the agent's own words and as a share of shelf space, so the agent makes room itself (fold or unshelve) before it has to. When a shelved file changes, the state block names it with a line delta; read it or re-add its placement to refresh the snapshot. `/context` shows what is on the shelf, what is currently rendered, and what was taken off.

### Recalling and folding

The state block lists every report that stands in view, with its size, so the agent sees what it is carrying. A report stays in view until **the agent decides** it has done the bookkeeping for it — updated the assessment, the graph, the ledger and the plan from it — and folds it itself; the automatic collapse is only the backstop.

`{"target":"context","action":"fold","id":"t12"}` replaces a report that stands in the context by its one line. This changes the context in its middle, so the server reads everything behind that place again; the answer to the call says how many tokens that is. A folded report comes back to its place with `{"target":"context","action":"recall","id":"t12"}`, which returns it in full; it stays in view until the next collapse or until it is folded again. (`drop` does the same as `fold`, for habits carried over.)

The main agent has no notes of its own that survive a collapse, on purpose: `book` with `target=context`, `action=note` is refused for it with a pointer to the ledger, the graph and the assessment.

### Inside a task

A focus has its own collapsible working conversation, but it is the same agent and shares the durable ledger, atlas and assessment. It receives the current state block and its one-line purpose; changes it makes to shared memory persist beyond the focus.

- A large result ends with a mark like `[s3 · about 2,100 tokens]`. `{"action":"drop","id":"s3"}` replaces that result by one line.
- When a task reads the same lines of a file again, the older copy is replaced by one line without being asked. This is done only where it pays: the copy is at least about 400 tokens, and what follows it, which the server then reads again, is at most eight times its size.
- `{"target":"context","action":"note","text":"…"}` writes down a finding. Notes stay when the steps are collapsed.
- A focus has a shelf. Its items stay in view when its steps collapse. With `handOn: true` on `shelf` add, or by naming a path/reference in `return.shelf`, the item is handed to the shared shelf when the focus ends; `return.shelf` adds it first if it is not already there.
- When the context is `collapseFull` percent full during a task, the task's steps become one block: its notes, one line per call, and its shelf. With `handoffQuestion` on, the task is first asked the question, with the same two answers; with the default off the cut is mechanical. The task goes on with its brief. It can ask for this itself with `book` (`target=context`, `action=collapse`).

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

Tried here, against the scripted stand-in: every path above. A committed live llama-swap log in `live_logs/llama-cpp-selector-probe.json` records a forced-literal native-GBNF pass and a finite-route pass for the Swift1.5 route.

**The question and tools.** A native host-control request deliberately omits tool declarations. This avoids the chat-template ambiguity of trying to constrain an answer that could instead be a tool call, keeps the decision surface small, and ensures the grammar is the actual boundary. Cartographer never retries such a decision without grammar.

### Reading the prompt

Every request asks llama.cpp to say how far it is with reading the prompt (`return_progress`). The server then puts a count into the stream for every 2,048 tokens it has read, and the full screen shows it in the strip: `reading 14.1k of 27.3k new ▮▮▮▮▯▯▯▯ 52% · 740 tok/s · writing in ~18 s`. Only what the server has to read anew is counted, not what it still has from the request before. Readings shorter than `prefillTokens` (1,000) are not shown. This works through llama-swap, since the count comes back in the same stream as the reply. A server that does not know `return_progress` ignores it. `"prefill": false` leaves it out of the requests.

Tried: against the scripted stand-in end to end, and the server's side against llama.cpp build 11913 by hand. Not shown: the read-ahead after a collapse, which is a request of its own without a stream; the plain terminal shows none of this.

Not tried, because it needs your machine:

- **Whether Qwen 27B answers the question sensibly.** The small model shows only that the mechanism works. If your model says `true` every time, each collapse costs a turn; if it says `false` when something was about to be lost, you will see the agent rediscover things. The `◆ asked before collapsing` line shows every answer.
- **Which slot the extra requests land in.** Your server has four slots. The read-ahead shares the conversation's ordinary prompt structure, so llama.cpp should place it near that conversation; if it goes to another slot, the next answer can read the context a second time, visible in the `read for this answer` figure. The native-GBNF handoff question deliberately uses a separate no-tools control payload, so Cartographer does not depend on it sharing the participant/request cache. With `-np 1` there is one slot and this distinction cannot arise.
- **llama-swap.** A request while another is running should queue or go to a free slot; the read-ahead is stopped when you type for that reason.

## The brain folder

```
<project>/.brain/
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
  carto-context.json  what a collapse keeps: the lines of finished tasks, the salient notes shown at the collapse, the talk, the shelf. Written by Cartographer. Kept out of git
  reports/            every task's report in full, t1.md, t2.md, …, with its brief. Kept out of git
  export/             what you copied out of the full screen: messages, sessions, tabs. Kept out of git
  session.sqlite      the session: every message, task and report. Kept out of git
  plugins/            empty for now; plugins the agent writes for this project will live here
  PREPEND.md          optional: your own markdown, read by the model before its prompt. Yours to write
  config.json         optional: settings for this project only
  .gitignore          keeps what belongs to this machine out of git: the lines above that say so
```

Deleting `.brain/` makes Cartographer forget the project. One `carto` runs per project at a time.

**The rename from `.atlas/`.** Before 2026-11-15 the brain lived in `.atlas/`, a name the Orchestrator pi extension also used for its own files (`graph.json`, `ledger.json`, `working-direction.json`). Since the rename the brain is `.brain/`, Cartographer's alone. The first time you start `carto` after updating, a folder `.atlas/` that is a Cartographer brain (it holds `session.sqlite`) is renamed to `.brain/`, and a line on the screen says so; the checkpoint exclusion list inside it is carried over. A folder that holds only other tools' files is not a brain and is left alone. Cartographer never reads or writes the extension's files, and a folder with only those is still not a project.

An earlier version kept the ledger in `ledger.json`. On the first start after the update, a `ledger.json` written by Cartographer is renamed to `carto-ledger.json` and a line on the screen says so. The Orchestrator's file of that name stays where it is.

## Settings

`~/cartographer/config.json` applies to every project. `<project>/.brain/config.json` overrides it for one project, the environment variables `CARTO_SERVER` and `CARTO_MODEL` override both, and `--url` and `--model` override everything. The `user` setting names the person Cartographer works with, and follows the same order with `CARTO_USER` as the environment override; it defaults to the OS user who started `carto`.

`PREPEND.md` puts your own markdown in front of the model's prompt. It is read from `<installation>/PREPEND.md` (every project) and from `<project>/.brain/PREPEND.md` (this project only); when both exist, both are read, the installation first. It stands before everything the system prompt says, is re-read on every request, and editing it takes effect on the next one. Cartographer never writes it. Because it stands before the prompt, changing it makes the server read the prompt again from the top.

| Key | Default | |
|---|---|---|
| `server` | none | Address of the server, ending in `/v1` |
| `model` | none | Model name as the server knows it |
| `user` | the OS user who started carto | Which name the agent calls you by, in its prompts, notes and messages. One name on one line, 80 characters at most. `CARTO_USER` overrides both settings files |
| `contextWindow` | 100000 | Cap on Cartographer's full active context budget. A reported server capacity may lower it, never raise it; no fixed reply room is removed |
| `maxTokens` | 32768 | Longest single reply, thinking included. It is dynamically lowered only when an actual near-full request needs room to fit |
| `mainTurns` | 40 | Replies the main agent may make in one turn, notes included, before the turn is ended. Planning and accepting one move take several orchestration replies |
| `taskTurns` | 6 | Fallback reply ceiling for a focus without a stored move contract; new declared moves carry their own hard 1–8 reply budget (6 by default) |
| `askMinutes` | 0 | Minutes an `ask` waits for your answer before the agent is told there was none. 0: without limit |
| `screen` | true | Whether `carto` on a terminal takes the whole screen. false: the plain terminal, as with `--plain` |
| `yolo` | false | Whether declared change moves run without `/approve` from the start. `--yolo` overrides it for one run; `/yolo` switches it while carto runs and is never remembered |
| `bwrap` | true | Whether the tasks' commands run in the bubblewrap sandbox. `--no-bwrap` overrides it for one run; `/bwrap` switches it while carto runs and is never remembered |
| `initiate` | true | Whether the agent starts working on its own when carto starts. `/initiate` switches it while carto runs and is never remembered |
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
| `collapseTokens` | 10000 | While the agent rests, its context is collapsed once at least this many tokens would go |
| `collapseMinutes` | 5 | And after you have been away this many minutes, whatever would go. 0: never for that reason |
| `collapseFull` | 80 | While the agent works, its context is collapsed when it is this full, in percent of `contextWindow`, 30 to 95. The same limit holds for a task's steps |
| `readAhead` | true | Whether the server is sent the collapsed context at once, so that it is read when your next message comes |
| `handoffQuestion` | false | Whether a collapse the agent did not ask for is preceded by the `{"handoff": true|false}` question. false: the collapse carries the last reply mechanically |
| `shellRead` | `[]` | More folders a command may read, besides the system and the project: full paths, or starting with `~/`. For programs installed in your home folder that the sandbox does not show by itself |

## Seeing what the model was actually sent

`/copy session` exports the session as Markdown (each call as one line), `/copy tab` exports the selected Model view with its sent/not-sent boundary, and `/copy report` the last task's report — each goes to the clipboard and to a file under `.brain/export/`. For anything the above cannot show, `CARTO_TRACE` dumps the wire itself:

```
CARTO_TRACE=1 carto                    writes .brain/export/trace-<time>.jsonl
CARTO_TRACE=/tmp/wire.jsonl carto      writes that file instead
```

One JSON line per call to the model: the request exactly as it went on the wire (it may carry `return_progress`, which the prefill watcher adds), and the raw response body as it came back — the SSE stream, unparsed. The `/models` check before the session begins is not traced. A trace file can be large, since every request holds a whole context; nothing in Cartographer reads it. Delete it when you are done with it.

## What is not here yet

Not built or deliberately deferred:

1. **Plugins** under `.brain/plugins/`: the agent testing the project by extending its own harness.

And smaller things, named where they belong above: the full screen does not replay earlier sessions; the reading of the prompt is not shown for the read-ahead after a collapse; and nothing is ever pruned from the brain — the transcript, the catalog and the index memo grow without bound on a long goal, and no lifecycle exists yet (`docs/design.md` parks it pending an explicit decision).

## Tests

`npm test` runs `test/all.mjs`: the unit suite (`test/unit.mjs`) and the ported integration suite (`test/run.mjs`), both measured against a hard wall-clock budget. The unit suite is a fast, self-contained set of checks for the shared operations the screen offers over a row, the shell tool's contract and the state block. It covers:

- the ledger: add/done and the errors an unknown id gets;
- the plan: add/done and the file left consistent;
- the assessment: one whole-text write through the `book` tool, clip-and-inform over the limit, and a legacy books file folded into it on first read;
- the atlas: `add` with `mayCreate` off refused for a missing file and accepted for one that exists, `confirm` re-stamping a node;
- the screen's operations (`src/ops.mjs`): archive/unarchive/drop/settle round-trips on every book, the specific item removed (the double-load regression), a goal closed re-pinning the copy at the top of the context;
- the shell tool: the parameter schema (missing required refused, `seconds` unified across run/wait/send), the in-band line that says which arguments mean nothing for the action, and the read-only lane's refusals with the sandbox off;
- the state block: the command lines for the sandbox on, switched off, and unavailable, including that the switched-off line says the main agent cannot run commands at all.

The integration suite runs the real `carto` command in throwaway project folders against a scripted stand-in for the model server (`test/stand-in.mjs`), so no model is needed. Both are seconds; both are meant for the end of a piece of work.

## Files

| | |
|---|---|
| `bin/carto` | The command. Checks Node and hands over to `src/cli.mjs` |
| `install.sh` | Packages, the executable mark, the link on your PATH, `config.json` |
| `src/cli.mjs` | Options, finding the project, checking the server, start and exit |
| `src/project.mjs` | Which folder is the project; creating and locking `.brain/` |
| `src/config.mjs` | Settings and where they come from |
| `src/harness.mjs` | Opens the session: model provider, tools, and who may call which |
| `src/read-batch.mjs` | Plans the bounded transient file-read batch and its shared output ceiling |
| `src/prompt.mjs` | The built-in system prompt, tool descriptions, the task's role line and refusals |
| `src/requests.mjs` | The one list of what waits for the user, and carrying a decision out |
| `src/ledger.mjs` | The ledger: its file, its operations, how it is printed |
| `src/plan.mjs` | Authorization envelopes and executable moves: file operations, exact-revision approval, acceptance, closure and undo |
| `src/checkpoints.mjs` | Checkpoints in `.brain/checkpoints.git`: record, compare, undo |
| `src/sandbox.mjs` | The bubblewrap sandbox: what a window sees, disposable-stage mounts, and command-output bounds |
| `src/stage.mjs` | Private normal-command source stages: materialization, candidate manifests, promotion, rollback, and cleanup |
| `src/windows.mjs` | The shell windows: opening one, typing into it, waiting, reading, stopping, closing, and announcing what happens in them |
| `src/reaper.mjs` | Ends a window's processes when the sandbox is off, also when `carto` itself was killed |
| `src/wake.mjs` | The note that wakes the agent, and which turns such notes started are left out of a request |
| `src/wakes.mjs` | The wakes the agent sets: the three kinds, when each fires, their file |
| `src/atlas.mjs` | The graph: its file, its operations, which nodes may be out of date |
| `src/tree.mjs` | The file tree: anchor, depth, fitting it into 60 lines |
| `src/assessment.mjs` | The assessment and its file |
| `src/top.mjs` | The copy of the assessment and the graph at the front of the context, and when it is replaced |
| `src/context.mjs` | What a collapse keeps and how it is written: the task lines, the salient-notes section, the talk, the shelf, the block; a task's steps and their marks |
| `src/legacy-cutover.mjs` | One-way C5 archival migration: exact legacy bytes, digests, readable static exports, shelf snapshots, and stopped-Case safety checks |
| `src/engine.mjs` | When the context is collapsed, the question before it, the read-ahead after it |
| `src/time.mjs` | How times, durations and ages are written |
| `src/request.mjs` | What is added to a request as it is sent: the copy at the front, the times, the state block, the windows block |
| `src/state.mjs` | The state block added to the end of each request — the main agent's and a task's — and the windows block added after it and to each task request |
| `src/tools/book.mjs` | The flat `book` interface: ledger, plan, atlas, assessment, reports, context actions and authorized file changes |
| `src/tools/task.mjs` | The `task` tool: fork, brief, checkpoints, report |
| `src/tools/read.mjs` | One-file transient `read`, including the per-batch output ceiling |
| `src/tools/shelf.mjs` | Explicit durable shelf placements |
| `src/tools/look.mjs` | `search`, `list` and the confinement to the project |
| `src/tools/change.mjs` | Internal `write`, `edit`, `rm` primitives and the paths a task may write to |
| `src/tools/shell.mjs` | `shell` and `window`: who may do what, and what the caller is told |
| `src/tools/wake.mjs` | The `wake` and `sleep` tools |
| `src/tools/chat.mjs` | The `chat` tool: how the agent tells you something |
| `src/tools/ask.mjs`, `src/asks.mjs` | The `ask` tool, and the question that waits for your answer |
| `src/tools/return.mjs` | The `return` tool: the one way a task ends |
| `src/ops.mjs` | The operations the screen offers you over a row (archive, unarchive, delete, fold, settle, add), the same code the commands run and the same operations the agent uses |
| `src/terminal.mjs` | The plain terminal: input, and printing what happens. It also runs the session behind the full screen |
| `src/screen/app.mjs` | The full screen: pi-tui's terminal and layout, the tabs, the two modes and their keys, the strip |
| `src/screen/parts.mjs` | The parts of the screen as pi-tui components: the row of tabs, the bodies of the tabs, the strip, the place to type, the sheet of keys |
| `src/screen/keys.mjs` | Keys by name for the commands mode; text that was pasted without being marked as pasted |
| `src/screen/chat.mjs` | Chat Conversation and Work plus the isolated Consult audit: folded calls, live response material, local speech/work projections, and persona-attributed conference activity |
| `src/screen/list.mjs` | A list of items that fold, with one selected: what Carto, Diff, Shells, Model, and Settings use |
| `src/screen/{workspace,review,runtime,settings}.mjs` | Settled feature views for the shared brain, checkpoint review, runtime/model inspection, and Settings & Safety |
| `src/screen/views.mjs` | The command that opens a selected source or template in the configured editor |
| `src/screen/text.mjs` | Text in cells: width, wrapping, styled lines; and telling a repeating reply from ordinary text |
| `src/screen/theme.mjs` | The palette: levels of text, one hue for each kind of block, backgrounds made for the terminal's own |
| `src/screen/copy.mjs` | Copying to the clipboard and to `.brain/export/` |
| `test/unit.mjs` | The fast unit suite; `npm test` runs it |
