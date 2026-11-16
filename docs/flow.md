# How Cartographer operates — a flow review

A structural read of the codebase as of `254fe41` (2026-11-16). Not a substitute for the README (the harness as it is) and `docs/design.md` (the intent) — this is the wiring: what runs, in what order, and what is allowed to touch what. Where the code and the design intent differ, that is said here rather than smoothed over.

## The one-paragraph version

`carto` in a project folder opens a session: a Durable harness over `.brain/session.sqlite`, one root conversation (the **main agent**) on your model server, with a flat list of tools shared byte-for-byte with every **task** conversation forked from it (so the server's prefix cache holds). The agent is driven by turns: a user message or a wake note starts one, the model reads the dressed request, calls tools or doesn't, and the request/response cycle runs until the stretch ends (a `sleep`, a `return`, a limit, or a same-note run). Reads are inline for everyone; writes exist only inside a change **task** carrying an authorized plan item — with checkpoints, the sandbox and `/undo`. The context fills mechanically and, when it is full, is collapsed to a known keep-set (no model summarization). The brain in `.brain/` is the memory; the request is a cache rebuilt from it each step.

## 1. The big picture — session and turn lifecycle

```mermaid
flowchart TD
    A["carto in a project folder"] --> B{".brain present?"}
    B -- "no" --> ASK["ask to create it - nobody to ask: -p makes one without asking"]
    B -- "yes" --> OPEN
    ASK --> OPEN["open session: harness over .brain/session.sqlite, root conversation, main agent on config.model"]
    OPEN --> REST{"what can bring a turn?"}
    REST -- "user types a message" --> STEER["message steers the main conversation - it may interrupt a turn"]
    REST -- "a wake trigger fires - time, file, or window" --> NOTE["a note is written and sent - the turn that begins is the agent's own"]
    NOTE --> STEER
    STEER --> TURN["the turn: dressed request to the model server"]
    TURN --> REPLY{"reply has tool calls?"}
    REPLY -- "no" --> SELF["it is a note the agent left itself - the turn goes on, or rests with sleep"]
    SELF --> REST
    REPLY -- "yes" --> GATE["the gate decides who may call what"]
    GATE --> SAND["tool runs - commands in the sandbox"]
    SAND --> AFTER["afterTool: loop check, shelf ask, engine accounting"]
    AFTER --> TURN
```

Facts to read with the chart:

- The main agent **initiates**: on start and after every wake with nothing owed. It rests only with `sleep`, and only after a written checklist (nothing waiting in Requests, no wake owed, no approved plan item open, no untested ledger hypothesis, the atlas/commission done).
- A reply cut off at the output limit is not continued by the harness — the screen tells the user, who decides. For a task, the same cut is its end.
- A turn that a wake started in which the agent did nothing (or only `sleep`) is "quiet" and is left out of later requests once a newer wake overtakes it (`src/wake.mjs`).
- `onYield` bounds every stretch: same note repeated `LOOP_MAX` times ends it; per-stretch reply counts (`mainTurns` / `taskTurns`) end it otherwise. Wake notes continue; `sleep` rests.

## 2. One request, before the model reads it

Nothing added here is stored in the conversation; the stored transcript is the truth, the request is the view.

```mermaid
flowchart LR
    P["prepend - your own markdown, read fresh each request"] --> PRE["preamble - the charter and tool sections, cached prefix"]
    PRE --> TOP["copied top block - the assessment and the graph"]
    TOP --> FRONT["front block - what the last collapse kept, minute-stamped"]
    FRONT --> MSGS["the messages since - reads beyond the newest are one line each"]
    MSGS --> STATE["state block - at the end of the last message: context fill, shelf, ledger, plan, approval, requests, wakes, focus"]
    STATE --> WIN["windows block - shell windows as they are now"]
    WIN --> READ["the newest read - content at the very end, after everything"]
    READ --> SERVER["the model server"]
```

- The same flat tool list is sent byte for byte to the main agent and every task fork, so the server never re-reads a differing prefix.
- Per request, `dressRequest` also: drops overtaken quiet wake turns, collapses superseded reads to one line, folds dropped reports, strips the handoff-ask markup, and — for a task — appends a one-shot note, and strips a task's own finished steps to one block leaving large results marked by id and size.
- The state block is an ending of the *last* message only; the newest read stands after it, and only the windows block may sit between them. A task gets its own copy of the block (its own fullness count, its own shelf line, the requests that wait) — wakes alone stay the main agent's.

## 3. The gate — who may call what, decided per call

```mermaid
flowchart TD
    C["a tool call"] --> WHICH{"which conversation?"}
    WHICH -- "main agent" --> MR{"read-only?"}
    MR -- "read / search / list, book reads, recall, shelf, read-only command" --> MINLINE["runs inline - no plan item, no approval"]
    MR -- "write / edit / rm, or a command with writes or network" --> MREF["REFUSED - the main agent never changes the project"]
    MR -- "typing into a running program" --> MREF2["REFUSED - a command started is a read, typing into one is not"]
    MR -- "task / wake / sleep" --> MAINEPTY["allowed - the main agent's alone"]
    MR -- "return" --> MRET["REFUSED - return belongs to a task"]
    WHICH -- "a task focus (a fork)" --> TF{"main-only call? task / wake / sleep"}
    TF -- "yes" --> TREF["REFUSED - the brief says so, it ends with return"]
    TF -- "no" --> TR{"read-only?"}
    TR -- "yes" --> TINLINE["runs inline"]
    TR -- "a change or a command" --> AUTH{"authorized change plan item in this task's brief?"}
    AUTH -- "yes (approved, or /yolo on)" --> GO["checkpoints bracket the work; sandbox confines it; /undo can take it back"]
    AUTH -- "no, or a look-only task" --> TREF2["REFUSED - only the authorized change runs"]
```

Additional gate rules enforced in the same hooks (`src/harness.mjs`):

- One file read comes back per reply; a further read in the same reply is refused, and the question that follows asks whether the lot should be shelved (the shelf ask).
- The plan is changed by the orchestrating context only — a task can never edit it.
- `sleep`/`wake` are orchestrator-only; no nesting of foci (a task cannot start a task).
- A change task's commands run in the sandbox (bubblewrap): project root confined, brain and `.git/` read-only for change tasks, network only when its item says so. Read-only commands for the main agent run in the read-only profile (decision O5, 2026-11-15) — enforced by the sandbox, not by discipline.
- The same call failing `LOOP_MAX` times in a row ends the turn as a loop; the failure and its error ride the results for the screen and the task machinery.

## 4. The change lifecycle — from hypothesis to undo

```mermaid
flowchart LR
    HYP["the agent forms a hypothesis or a warranted change"] --> PLAN["a plan item is added - the only way project files change"]
    PLAN --> REQ["it waits in the Requests view - approval is per item, async, non-blocking"]
    REQ -- "user: /approve, or 'approved p2' - network items need naming" --> OK["item authorized"]
    REQ -- "user: /deny" --> DENY["items gone"]
    OK --> TASK["a task focus carries it out - the orchestrator never writes"]
    TASK --> CP["checkpoint before, checkpoint after - /undo reverts the task's work"]
    CP --> REP["a report t<id> is journaled - recall by id"]
    REP --> VRFY["the agent checks its own hypotheses; what held and what did not goes in the report"]
```

Default mode: an item waits for you, and the agent does everything that does not depend on it. Yolo mode: approval is off, the agent's judgment governs — but the mechanical gates (confinement, sandbox, checkpoints, `.brain/`/`.git/` protection) are unchanged. `/undo` and `/approve` are user commands; the user can equally steer with their own words, or edit any artifact by hand — both doors (user and agent) act on the same brain.

## 5. The context's life — fill, collapse, keep

```mermaid
flowchart LR
    FULL["context fills - the state block says how full"] --> DUE{"at the collapse point?"}
    DUE -- "no" --> FULL
    DUE -- "yes" --> HANDOFF["opt-in only (handoffQuestion): one JSON, handoff true or false, thinking off - off by default, no ask"]
    HANDOFF -- "asked and true" --> NOTES["the agent writes what would be lost - one turn"]
    HANDOFF -- "not asked, or false" --> NOW
    NOTES --> NOW["collapse"]
    NOW --> KEEP["front block: finished tasks as one-liners + salient notes chronological + a structured shelf listing + the talk, capped at chatWindow, minute-stamped + one line per call of the stretch, capped at callsTokens"]
    KEEP --> TRANSCRIPT["the Durable transcript is kept whole - soft-forget never claims erasure"]
    KEEP --> FULL2["the new short context is read once, then work goes on"]
    FULL2 --> FULL
```

- The collapse is decided in `afterMainCall`, after a round of tool results, once they have all come back — never on a plain reply. The fullness check runs there and the collapse rides the round's last result.
- The handoff question is opt-in (`handoffQuestion`, decision O1); with it off the collapse carries the last reply mechanically, with no ask. Either way, no model writes any of the keep-set — it is what the harness knows to keep.
- The context is a cache: the ledger, plan, atlas, assessment, reports and the transcript are never inside it in full — a collapse cannot touch them. What is in the front block is a projection of them.
- Folds (`book context fold`) shrink mid-session what is carried; recall brings back by id. The state block shows what stands in full, with ids and token counts.

## 6. What the user's side looks like

- The full-screen tabs: Chat (the dyad, word for word, editable by both parties), Carto (ledger/plan/atlas rows with the same verbs the agent has), Diff (what changed, `/diff`, `/undo`), Shells (persistent escape hatches), Context (the request the agent was sent, part by part, in reading order).
- Requests is the one place approvals gather: `/requests`, `/approve`, `/deny`, `/answer` — or plain words ("yes", "approved p1"), which the harness reads as an approval only when they are unambiguous, and named only item-by-item.
- The user edits any brain artifact by hand or through the screen; the agent sees hand edits at the next step. The brain is a shared thing; the relationship is a dyad.
- The screen and the agent are meant to be two doors over the same operation engine. Today the chat/context/shell surfaces are bespoke and the ops layer (`src/ops.mjs`, the `book` capability table) is shared for many rows but not all — full parity is the design direction (§8 of the design doc), not a shipped fact.

## 7. Standing gaps and disclaimers

- MCP: not present anywhere, in any direction — no server, no client (`grep -ri mcp` comes up empty).
- The trace/`CARTO_TRACE` log and `live_logs/` exports are measurement tools, not runtime truth; the Context tab is the honest in-app view of a request.
- Live behavior against a real model is deliberately scarce; most of the machinery above is verified offline (tests, stub probes). Anything about model *behavior* in this review is the prompt and the harness as written, not a measurement.
- What I read for this review: `src/harness.mjs`, `src/engine.mjs`, `src/context.mjs`, `src/request.mjs`, `src/state.mjs`, `src/wake.mjs`, `src/requests.mjs`, the tool surfaces, and the top of `src/index.mjs`/`src/cli.mjs`. What I did not re-read line by line: the screen's renderers, `src/sandbox.mjs`, `src/windows.mjs`, `src/trace.mjs` — for those, the charts describe their call sites and the design doc, not an independent audit.
- The five charts are Mermaid; GitHub renders them, many viewers don't. If they arrive as bare source, every section above it stands alone as text.
