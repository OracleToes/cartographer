# Carto

## Purpose

Carto is a small, durable project memory and terminal agent for one person and one project.

Carto keeps five product parts:

- **Atlas**: short project claims with checked evidence.
- **Ledger**: goals, notes, and questions.
- **Context gardening**: a clear choice of what enters a new model context.
- **Chat**: deliberate Person Chat and Agent Chat records.
- **Wake and sleep**: durable wait and resume work.

Carto does not keep old product systems only because they existed before. It keeps Atlas, Ledger, context gardening, Chat, and wake/sleep.

The command is `carto`. The product name is Carto. The file name of this plan remains `MINI.md` for compatibility with this repository task.

## Runtime home and configuration

Carto installs its files and launcher below `~/.carto/`.

Its global configuration is `~/.carto/config.json`.

Project data stays below the selected project root:

```text
<project>/.brain/brain.sqlite
<project>/.brain/context/<generation>.sqlite
```

A configuration has this form:

```json
{
  "version": 1,
  "model": "provider/model",
  "collapseMode": "request"
}
```

`carto --model provider/model` overrides the saved model for one start. A first `--model` value creates the configuration file. It does not replace the saved model on later starts.

Carto supports a keyless local llama-swap or llama-server endpoint:

```sh
carto --model llama-swap/Flint --endpoint http://localhost:8888/v1
```

It saves this configuration:

```json
{
  "version": 1,
  "model": "llama-swap/Flint",
  "llamaSwapEndpoint": "http://localhost:8888/v1",
  "collapseMode": "request"
}
```

The endpoint must use `http` or `https`. Carto registers `llama-swap/Flint` as a Pi OpenAI-compatible completions model. It sends no `Authorization` header and stores no provider secret. A local server that needs a secret must use a Pi-supported provider login path instead.

`collapseMode` is `request` by default. In this mode the agent requests a collapse and the person confirms it. In `agent` mode, Carto can perform the same collapse without a confirmation and can expire the prior archive.

## Use Pi, do not duplicate Pi

Carto uses fixed versions of Pi packages.

- **Pi Durable** stores commits before Carto shows them. It runs durable conversations, tasks, tool calls, sleeps, wakes, retries, streaming state, and SQLite storage.
- **Pi AI** provides models, providers, tool validation, model streams, usage, and provider errors.
- **Pi TUI** provides alternate-screen terminal rendering, focus, editors, scrolling, input, and mouse support.

Carto adds only product rules that Pi does not provide:

- the Carto Brain data;
- Atlas, Ledger, Chat, pin, archive, and deletion rules;
- the Carto context projection and short handles;
- product tools and bounded project operations;
- the three-tab Carto workspace.

Carto does not implement a second provider layer, model stream parser, tool schema validator, scheduler, timer queue, SQLite adapter, generic terminal editor, or generic transcript compactor.

Pi Durable transcript entries are immutable. Pi `reset()` and Pi compaction can remove old entries from model context, but they do not delete them from storage. Carto collapse is a product retention operation, not Pi compaction. Carto disables automatic Pi compaction and requests Carto collapse when a new context is needed.

## One project, one Brain

Each project has one durable Carto Brain document with `history: "latest"`. It stores the current state, not an audit history of every old Brain value.

```text
{
  version: 1,
  chat: [],
  ledger: [],
  atlas: [],
  userPins: [],
  carryPins: [],
  handoff: null,
  wakes: [],
  changes: [],
  deletionMarks: [],
  context: { liveGeneration: null, archiveGeneration: null },
  activity: { kind: "idle", detail: null }
}
```

Stable Brain IDs are private storage IDs. They do not go to the agent.

The Brain names one live generation and, after an ordinary collapse, at most one archive generation. Carto creates a new generation file before it commits the new Brain generation state. It removes an unreferenced file only after that commit succeeds. A restart uses the Brain as the source of truth.

## Short context handles

Carto gives the person and agent short, type-prefixed references such as:

```text
L1    Ledger
C10   Chat
A1    Atlas
P1    pin
H1    handoff
```

Other active typed records use the same rule, for example `W1` for a wake, `X1` for a change, and `D1` for a deferred removal.

A handle is local to one live context generation. The Brain stores the handle table, so a handle does not change when the person edits a record or when another record arrives. A new record receives the next free number for its type. A hidden record that has a deletion mark keeps its handle until the collapse removes it. Carto rebuilds and renumbers all handles when it creates a fresh live context; the new generation starts again at 1 with no gaps.

The agent sees only handles and typed content. It never sees a Brain database key, Pi entry ID, generation file name, or another private storage value. A tool parameter that names a record takes a handle. Carto resolves the handle below the presentation layer. An unknown handle is an explicit error; it never falls back to a private ID.

A fresh Carto projection uses this structural order:

1. Carto rules.
2. All Ledger entries together, in stable creation order, oldest first.
3. All visible Chat records together, in chronological order.
4. Atlas records.
5. User pins and carry pins.
6. Handoff.
7. Other active typed records, such as wakes, changes, and deferred removals.
8. A transient current input, when a preview needs one.

Editing a Ledger entry does not move it. Its timestamp shows the edit time.

Every durable item ID line has an ISO 8601 UTC timestamp. The agent can therefore see both the type and the time of a change. Links in Atlas and Handoff use short handles, never private IDs.

A stale Atlas record or stale pin does not send its old evidence text as a current fact. Carto sends a short stale warning with its public handle and timestamp instead.

Context gardening is a pure projection:

```text
projectContext(brain, generation input, budget) -> context plan
```

It does not read files, call a model, write the Brain, or delete data. Its result gives each item a source, freshness state, reason, estimate, public handle, and omission state. The agent renderer receives only safe public text.

## Retention, archive, and deletion

Carto has two retention rules.

### Working context uses keep-first retention

Working context includes file reads, source excerpts, tool output, temporary model output, and the Pi transcript.

It is temporary. The agent can make a carry pin for material that must enter the next live generation. A carry pin lasts one collapse period. The agent must select it again if it still matters later.

At ordinary collapse, Carto moves the old live session to the archive. The person can rescue needed archive material with a user pin before the next collapse. At the next collapse, Carto permanently deletes the unpinned archive.

The person can remove a carry pin at the next collapse. A carry pin that came from the current live generation naturally expires at that collapse. Carto shows a deferred removal while it is pending.

### Deliberate records use delete-at-collapse

Chat, Atlas, and Ledger stay by default. They are removed only after a deletion mark, unless the person selects **Delete now**.

**Delete at collapse** is the normal low-cost path. It marks a record. The mark hides the record from ordinary use and can be cancelled before collapse. Carto removes marked records at the next confirmed collapse.

**Delete now** removes the Brain record immediately. Carto stops active work, starts a fresh live generation from the new Brain projection, and discards both the old live context and any archive context. This is more expensive, but it prevents the removed material from entering the next model prefill.

**Remove now** for a pin uses the same fresh-generation path. **Remove at collapse** is the default pin path.

Carto does not ask for a reason for ordinary deletion. It does not create a lasting audit record for ordinary lost memory.

After an ordinary collapse and after an immediate restart, Carto requests SQLite secure-delete, WAL checkpoint/truncation, and `VACUUM` for applicable retained or discarded Carto databases. This is best-effort local cleanup. It is not a secure erase guarantee for SSD wear leveling, backups, snapshots, or a remote filesystem.

“Durable” means that state survives a restart or crash. It does not mean that state stays forever.

## Collapse

A normal collapse does this:

1. Save carry pins for the current live generation.
2. Save any user pins that rescue archive material.
3. Create a new live Pi Durable session from the Carto context projection.
4. Commit the new Brain generation state.
5. Make the prior live session the archive.
6. Remove the prior archive only after the Brain commit succeeds.
7. Run database cleanup.

The new live session receives the fresh structured Carto projection. It does not receive arbitrary unpinned material from old context files.

A crash can leave an extra old context file. It must not lose a saved user pin or carry pin. On open, Carto preserves referenced files and removes only unreferenced context files.

## Chat

Chat is a deliberate durable record. It is separate from raw model output.

- A person message creates Person Chat.
- The `chat` model tool creates Agent Chat.
- A person can also add Agent Chat for retroactive or corrective steering.
- A person can edit Person Chat and Agent Chat.
- A person can delete either type at collapse or delete it now.
- Raw model text never silently becomes Agent Chat.

Chat starts expanded in the Chat tab and is never folded by default. The person may manually fold an individual Chat item with `f`. A folded item stays in fresh context. Chat remains in context unless it has a deletion mark or is deleted now.

If a model writes ordinary text without the `chat` tool, Carto keeps it as visible transient model activity. It is not a deliberate Agent Chat record.

## Live disclosure

Carto shows all agent-generated content to the person.

This includes reasoning, ordinary model text, tool calls, tool arguments, tool output, warnings, errors, and deliberate Agent Chat tool activity.

Each streamed item that exceeds five visual rows receives its own five-row scrolling disclosure window. The live window follows the newest text. When the person expands it, the view grows upward and keeps the newest text visible. Older completed transient items fold to one summary line by default. They remain expandable; Carto does not silently drop them because they are old.

Carto uses semantic ANSI terminal styles. It uses the terminal theme and does not hard-code an RGB palette. Reasoning, model text, Chat, tool calls, tool output, warnings, and errors have distinct styles.

## Terminal workspace

Carto uses Pi TUI alternate-screen full-screen mode first.

It has exactly three initial tabs:

```text
1 Chat
2 Brain
3 Context
```

The workspace is compact. It has no permanent command palette, settings screen, job drawer, raw-model page, or oversized menu system.

- **Chat** shows expanded durable Chat and live disclosure.
- **Brain** shows Ledger, Atlas, changes, wakes, and deferred removals.
- **Context** shows the current handle projection, pins, archive state, and omissions.

The person can do nearly all safe Brain and context operations that the agent can do. Compact input commands cover Ledger, Atlas, pins, handoff, wakes, deletion marks, deletion cancellation, immediate deletion, and approval or rejection of changes. Commands name records by their short handle, for example `/delete C2`, `/unpin P3`, `/approve X1`, or `/wake W1 | time | ...`. A raw durable ID is never a command argument.

### The frame

The screen has a fixed top block, a scrolling body, and a fixed footer.

```text
  Carto · cartographer                                                llama-swap/Flint
  ────────────────────────────────────────────────────────────────────────────────────
  1 Chat   2 Brain   3 Context                                   ⠹ reading 64% · 1.4k tok/s
  ▰▰▰▰▰▰▰▰▰▰▨▨▱▱▱▱▱▱▱▱  9.4k + 1.2k new / 33k · cap 16k · 32%
  DURABLE CHAT                                                                      3
  ▌C1  Person · 14:32
  ▌    Explain the retry policy.
  LIVE                                                                     1 item · streaming
    Model output                                                                streaming
       The retry policy is one scheduler with two backoffs.
  ────────────────────────────────────────────────────────────────────────────────────
  j k move · g G ends · 1 2 3 tabs · i input · a actions · ? help    chat · send follow-up
```

| Row | Content | Job |
|---|---|---|
| 1 | Product, project directory, model | Where you are and what answers |
| 2 | One rule | Separates the chrome from the content |
| 3 | Tabs, and the turn state | What you see, and what the agent does |
| 4 | The token bar | Token pressure, always |
| 5 | The body | Scrolls. It is the only part that moves |
| last | The footer | Keys that work now, and the last notice |

Every row is exactly the terminal width. Chrome has two cells of padding. The body is never wider than the frame, so a long line wraps inside the body rather than outside it.

The screen repaints on a clock, not on input alone. Carto asks for a frame at 100 ms while the agent works, and at 1 000 ms when it is idle. This is why streamed text appears without a key press. Carto reads the terminal width on an interval, because Pi TUI announces a resize to the layout and not to this frame.

The frame is one pure function of a state value. The renderer does no I/O. Tests call the same function that the terminal calls.

### The token bar

The bar is one bar with three segments, and it is always visible.

```text
▰▰▰▰▰▰▰▰▰▰▨▨▱▱▱▱▱▱▱▱  9.4k + 1.2k new / 33k · cap 16k · 32%
└ filled ┘└change┘└ free ┘
```

| Part | Glyph | Meaning |
|---|---|---|
| filled | `▰` | Tokens the server keeps and has already read |
| changing | `▨` | Tokens the server must read now, not yet read |
| free | `▱` | Room left in the window |
| cap | `┊` | The 16 000 budget, drawn in the first free cell at that boundary |
| estimate | `▤` | A number Carto estimated, not measured |

The denominator is the real window the server reports, not the budget. The budget is a mark inside the bar, so the person sees the two limits together. A prompt that fits one cell fills that cell, so the bar never shows nothing.

Before the first request, the bar shows an estimate. The estimate uses `▤` cells, a muted style, the word `estimate`, and `~` before the number. Four independent marks, so a terminal without colour still shows the difference. Once the server sends progress, the bar shows measured numbers and no estimate.

The server reports `prompt_progress` with `{total, cache, processed}`. Carto draws fresh work as `total - cache`, what is done as `processed - cache`, and the rest as `total - processed`. When a provider sends no progress, Carto stops the bar at the estimate. Carto never invents numbers.

### The status row

The third row holds the tabs on the left and the turn state on the right. The state uses a word, a glyph, and a spinner where time passes.

| State | Text |
|---|---|
| Idle | `○ idle` |
| Waiting for the model | `⠋ waiting for the model` |
| A local action runs | `● applying` |
| Reading the prompt | `⠹ reading 64% · 1.4k tok/s` |
| Writing the answer | `⠸ writing · 12s` |
| A tool runs | `⠼ tool inspect src/retry.ts · 3s` |
| Paused | `⏸ paused · r edits the draft · x cancels` |
| Collapse is requested | `● collapse requested · a shows the commands` |
| Recently read | `· read 4.2k new in 1.8s` |
| Failed | `! model error: …` |

The spinner is not decoration. The screen must redraw while the agent works, and a moving glyph is the proof that it does.

### The footer

The footer takes the whole bottom row. The keys sit at the left, and the tab with a send mode, the insert state, or the last notice sits at the right.

Carto shows only the keys that work here. When the row is short, the hints drop from the right, one at a time. The footer never truncates a hint that it shows.

| Mode | Hints |
|---|---|
| Navigate | `j k move · g G ends · 1 2 3 tabs · i input · a actions · ? help` |
| A Chat item is selected | `… · f fold · e edit · d delete at collapse · D delete now` |
| A live item is selected | `… · o open` |
| A pin is selected | `… · u remove at collapse · U remove now` |
| Insert | `Esc back · Enter send` |
| While the agent works | `… · p pause · x cancel` |

### Modal controls

Carto has Navigate and Insert modes. It has no Visual mode.

- `Esc` always returns to Navigate mode and closes detail state.
- `1`, `2`, and `3` select Chat, Brain, and Context.
- `j` and `k` move selection. `g` and `G` move to the start or end.
- `Backspace` closes a detail or action view in Navigate mode.
- `i` opens input. In Chat edit detail, it replaces the selected Chat text.
- `f` folds or unfolds selected durable Chat.
- `o` expands or folds selected live disclosure.
- `e` opens selected Chat edit detail.
- `A` opens input for person-authored Agent Chat.
- `d` marks selected Chat for deletion at collapse. `D` deletes it now.
- `u` removes a selected pin at collapse. `U` removes it now.
- `a` opens the compact action reference. `?` opens the key reference.
- `p` pauses the active turn. `r` edits a paused draft, or starts useful work while idle. `x` cancels the turn.
- `I`, `S`, and `F` open the input with Interruption, Steer, or Follow-up as the delivery mode.
- `Enter` sends. A line that starts with `/` runs a person command instead, such as `/undelete C2` to cancel a deletion mark.

## Turn control

The input supports three delivery modes:

- **Interruption** stops the active stream, then sends now.
- **Steer** queues at the next safe Pi Durable boundary. It does not interrupt an active tool. Pi finishes an emitted tool-call batch, then Carto delivers the steer before the next model request.
- **Follow-up** queues after the active run and starts a later run.

The person can:

- pause an active stream;
- edit the preserved paused draft;
- resume after editing;
- cancel an active or paused turn;
- send an Interruption, Steer, or Follow-up;
- continue an unfinished agent turn without a new person message;
- start useful agent work while idle without creating Person Chat.

A provider stream cannot be frozen and resumed in the same socket after arbitrary edits. Pause therefore aborts at a Pi Durable boundary, saves an editable partial draft, and starts a fresh continuation request when the person resumes. Carto labels that request as turn-control data, not Person Chat.

## Atlas, Ledger, pins, handoff, wake, and changes

Atlas stores source-backed project claims:

```text
{
  id, title, claim, evidence, links, createdAt, updatedAt
}
```

Ledger stores goals, notes, and questions:

```text
{
  id, kind, text, status, answer, createdAt, updatedAt
}
```

A changed evidence digest makes an Atlas item or pin stale. Carto shows stale state and requires a new inspection before it uses old source text as a fact.

A user pin can preserve selected archive or live material until the person removes it. A carry pin preserves selected agent working context for one collapse period.

A handoff stores intent, open references, a next action, and a short note. Wakes use Pi Durable tasks. Time wakes use durable sleep. Path wakes recheck a bounded project path. A folder wake checks direct entries and has a 10,000-entry limit. A root wake ignores `.brain`.

The model can propose a patch. It cannot write project files through a Carto tool. The person approves a stored patch before Carto runs the limited apply task.

## Project boundary

Carto can inspect paths that resolve inside the selected project root. It does not inspect or patch `.brain`.

A symbolic-link destination and an approved patch destination must resolve inside the selected project root. Carto rejects a path that escapes the root through a link.

## Functional design

Product decisions use pure transformations:

```text
user or model command
  -> pure Carto decision
  -> Pi Durable commit and task
  -> next Brain state and requested effects
```

Core pure functions include:

```text
decide(brain, command) -> decision
projectContext(brain, generation input, budget) -> context plan
```

They do not read the filesystem, use a clock, call a model, render a terminal, or write a database. Runtime adapters supply time, Pi Durable commits, file inspection, cleanup, and UI effects.

## Completion criteria

Carto is ready when all of these are true:

- `carto` reads `~/.carto/config.json` and supports one-start `--model` overrides.
- `llama-swap/Flint` uses `http://localhost:8888/v1` without a stored secret or an Authorization header.
- Carto uses Pi Durable, Pi AI, and Pi TUI instead of duplicate infrastructure.
- The UI starts with Chat, Brain, and Context only.
- Context uses fresh type-prefixed generation-local handles and hides private IDs from the agent.
- Fresh context keeps Ledger together, keeps Chat chronological, and puts an ISO UTC timestamp on each durable item ID line.
- Chat is expanded by default and is manually foldable.
- Person Chat and Agent Chat are distinct and editable.
- Raw model content stays visible but does not silently become Agent Chat.
- Every long live item has an independent five-row newest-text disclosure window.
- Pause, edit, resume, cancel, continue, Interruption, Steer, Follow-up, and idle start work are available.
- Deferred deletion and deferred pin removal are normal paths.
- Delete now and Remove now create a fresh prefill and clean up old context files.
- At ordinary collapse, unpinned working context moves to one archive, and unpinned archive material expires at the next collapse.
- Chat, Atlas, and Ledger stay until a deletion mark or an immediate deletion.
- A confirmed collapse runs secure-delete, WAL cleanup, and `VACUUM` where applicable.
- A crash during collapse leaves a usable referenced generation and does not lose a saved pin.
