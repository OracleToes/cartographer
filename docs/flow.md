# How Cartographer operates — one connected map

Fixed from the pasted draft on 2026-11-16: the tool-result path loops back into the next request (it does not fall through to resting), `return` is refused in the main agent and belongs to the task, the handoff question is opt-in and off by default, the network boundary is the sandbox and not the gate, and every id used in a cross-subgraph edge now exists. The prior prose review lives in git history (`d971a97..8e22a1d`). Mermaid; GitHub renders it.

```mermaid
flowchart TB
    %% ==========================================
    %% 1. SESSION & TURN LIFECYCLE
    %% ==========================================
    subgraph SESS ["1. Session & Turn Lifecycle"]
        direction TB
        A["carto in project folder"] --> B{".brain present?"}
        B -- "no" --> ASK["Ask to create (-p skips the prompt)"] --> OPEN
        B -- "yes" --> OPEN["Open session (.brain/session.sqlite + main agent)"]

        OPEN --> REST{"Turn trigger?"}
        REST -- "User message" --> STEER["Steer main conversation (may interrupt)"]
        REST -- "Wake trigger (time/file/window)" --> NOTE["Write wake note"] --> STEER

        STEER --> BUILD_REQ["Assemble Dressed Request"]
        BUILD_REQ --> SERVER["Model Server"]
        SERVER --> REPLY{"Reply has tool calls?"}

        REPLY -- "yes" --> GATE_ENTRY["Route to Permission Gate"]
        REPLY -- "no (self-note)" --> YIELD{"onYield: stretch continues, or rests?"}
        YIELD -- "continues (one line added)" --> BUILD_REQ
        YIELD -- "rests (sleep / limit / same note / wake-quiet)" --> REST

        GATE_ENTRY --> WHICH
        AFTER["Tool result returns - afterTool for executed calls: loop check, shelf ask, accounting (a refusal is a result too)"] --> BUILD_REQ
    end

    %% ==========================================
    %% 2. REQUEST ASSEMBLY (VIEW OVER TRANSCRIPT)
    %% ==========================================
    subgraph REQ_PIPE ["2. Dressed Request Assembly (Cache View)"]
        direction LR
        P["Prepend (fresh .md)"] --> PRE["Preamble (charter/tools)"]
        PRE --> TOP["Top Block (assessment/graph)"]
        TOP --> FRONT["Front Block (collapse keep-set)"]
        FRONT --> MSGS["Recent Messages (old reads = 1 line)"]
        MSGS --> STATE["State Block (fill, shelf, ledger/plan/approval/requests; wakes main-only)"]
        STATE --> WIN["Windows Block (live shells)"]
        WIN --> READ["Newest Read (at the very end)"]
    end

    %% ==========================================
    %% 3. THE PERMISSION GATE
    %% ==========================================
    subgraph GATE ["3. The Gate (per-call enforcement)"]
        direction TB
        WHICH{"Which conversation?"}

        WHICH -- "Main Agent" --> MR{"Call type?"}
        MR -- "read / search / list / inline command" --> MINLINE["Runs inline (no plan needed)"]
        MR -- "write / edit / remove" --> MREF["REFUSED (the main agent never changes the project)"]
        MR -- "typing into a running program" --> MREF2["REFUSED (starting a command is a read; typing is not)"]
        MR -- "task / wake / sleep" --> MAINEPTY["Allowed (the main agent's alone)"]
        MR -- "return" --> MRET["REFUSED (return belongs to a task)"]

        WHICH -- "Task Focus (fork)" --> TF{"Main-only call? (task / wake / sleep)"}
        TF -- "yes" --> TREF["REFUSED (ends with return)"]
        TF -- "no" --> TR{"Call type?"}
        TR -- "read-only" --> TINLINE["Runs inline"]
        TR -- "write / command" --> AUTH{"Authorized plan item?"}
        AUTH -- "yes (/approve or /yolo)" --> GO["Run in sandbox + checkpoints"]
        AUTH -- "no / look-only" --> TREF2["REFUSED"]
    end

    %% ==========================================
    %% 4. CHANGE LIFECYCLE
    %% ==========================================
    subgraph CHANGE ["4. Change Lifecycle (hypothesis to undo)"]
        direction TB
        HYP["Agent forms hypothesis / change"] --> PLAN["Add plan item"]
        PLAN --> REQ_VIEW["Wait in the Requests view (async)"]
        REQ_VIEW -- "/deny" --> DENY["Item discarded"]
        REQ_VIEW -- "/approve, or unambiguous words like 'approved p2' (network items need naming)" --> OK["Authorized - the agent carries it via a task focus"]
        OK --> CP["Pre/post checkpoints + sandbox (/undo reverts)"]
        CP --> REP["Journal report t<id> and verify"]
    end

    %% ==========================================
    %% 5. CONTEXT COLLAPSE
    %% ==========================================
    subgraph CTX ["5. Context Fill & Mechanical Collapse"]
        direction TB
        DUE{"At collapse point or the ceiling?"}
        DUE -- "no" --> KEEP_GOING["Continue"]
        DUE -- "yes - decided in afterMainCall, at the round's last result" --> OPTIN{"handoffQuestion on? (default: no)"}
        OPTIN -- "no (default)" --> COLLAPSE["Mechanical collapse (no LLM summary)"]
        OPTIN -- "yes" --> HANDOFF{"Handoff question - one JSON: handoff true/false, thinking off"}
        HANDOFF -- "true" --> NOTES["The agent writes one handoff turn, then collapses"] --> COLLAPSE
        HANDOFF -- "false" --> COLLAPSE
        COLLAPSE --> KEEP["Rebuild the front block (1-line tasks, salient notes, shelf listing, capped chat, one line per call)"]
        KEEP --> DURABLE["Full transcript remains intact in .brain/"]
    end

    %% ==========================================
    %% CROSS-SUBGRAPH CONNECTIONS
    %% ==========================================
    BUILD_REQ -.-> REQ_PIPE
    REQ_PIPE -.-> SERVER

    GATE_ENTRY --> WHICH
    MINLINE & MAINEPTY & TINLINE & GO & MREF & MREF2 & MRET & TREF & TREF2 --> AFTER
    AFTER -. "afterMainCall decides a collapse" .-> DUE

    MAINEPTY -. "spawns task / adds plan" .-> HYP
    OK -. "executes via" .-> WHICH
    GO -. "bracketed by" .-> CP

    KEEP -. "feeds into next request" .-> FRONT
```

## Reading notes

- **The loop that matters:** `BUILD_REQ → SERVER → REPLY` and either straight back to `BUILD_REQ` via `onYield`, or out through the gate into `AFTER` and back to `BUILD_REQ`. `REST` is only ever reached when a stretch ends (`sleep`, a limit, a same-note run, a wake-quiet turn); a turn does not end at a plain reply.
- **The gate never refuses on network.** The main agent's inline commands run in the read-only window (no network, read-only mounts — decision O5); a command that must write or reach the network is a change item for a task, not a gate refusal. File create/edit/remove is refused twice: `beforeTool` (change tools) and `book` (file mutations outside a change task carrying the authorized `planItem`).
- **`/yolo` is a session switch**, not an answer in the Requests view; nothing ever waits for approval while it is on. The mechanical gates stay regardless.
- **The state block is not identical for the two conversations**: wakes ride the main agent's copy only; a focus gets its own fullness count, shelf line and the requests that wait for it. The newest successful reply's read batch stands together at the very end of the request, after every block; replacing it is a transient-tail eviction, never a collapse.
- **Collapse honesty:** the handoff question is opt-in (`handoffQuestion`); with it off, nothing asks the model anything — the front block is assembled by the harness. `afterMainCall` decides it after a round of tool results, and since 2026-11-16 the plain-reply path ends the stretch at the same line; the rest path collapses it mechanically (`docs/design.md` §7).
- **Plan edits are orchestrator-only**, enforced in `book` rather than by this diagram; and only the orchestrating context may call `task` (a focus cannot start one).
- **The screen's view of a request is its own rebuilt replay**, not the captured payload; both builds call the same `dressRequest`, the live one alone consumes wakes and window notices, and `test/unit.mjs` pins the byte-equality. If the flow ever disagrees with a live run, the live run wins and the chart is wrong.
