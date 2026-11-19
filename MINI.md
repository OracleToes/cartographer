# Mini

## Decision

Mini is a new durable-agent kernel, not a smaller skin over the existing control plane.

It serves one person working in one project. It keeps a shared, inspectable brain; compiles bounded context from that brain and the project; converses; observes files; proposes changes; and can sleep until relevant work arrives.

The five retained concepts are the product:

- **Atlas** — concise, source-backed project knowledge.
- **Ledger** — durable goals, notes, and unanswered questions.
- **Context gardening** — selecting, refreshing, and showing the evidence supplied to the model.
- **Chat** — the visible working thread between person and agent.
- **Wake and sleep** — durable pauses and relevant resumptions.

Everything else must earn its way back as a small attachment. Mini does not preserve legacy behaviour merely because it already exists.

## Product boundary

Mini v1 has one active thread and one shared brain per project.

It can:

1. hold a conversation;
2. record and update Atlas and Ledger entries;
3. inspect project files through a bounded read capability;
4. pin exact evidence into the next model context;
5. propose a patch without changing a file;
6. apply only an explicitly approved proposal;
7. sleep on a time or file/folder condition; and
8. resume with a compact, visible handoff.

Mini v1 does not have plans, task forks, approval envelopes, autonomous file writes, arbitrary shell access, terminal windows, process jobs, sandboxing, checkpoints, conferences, catalogs, reports, shelves, assessments, settings screens, action palettes, or debug tabs.

Those are not hidden. They are absent from the Mini path.

## Non-negotiable architecture

The domain is functional and deterministic. Side effects live at a narrow outer boundary.

```text
command -> validate and decide -> domain events + requested effects
events  -> reduce              -> next brain state
state   -> compileContext      -> model request projection
effect  -> run at the boundary -> result event
events  -> reduce              -> next brain state
```

The core exposes only pure functions:

```text
decide(state, command) -> { events, effects }
reduce(state, event) -> state
compileContext(state, evidence, budget) -> context
projectScreen(state, context) -> screen model
```

The composition root alone may use the filesystem, SQLite, model API, clock, IDs, file watcher, timer, or patch applier. Time, IDs, file digests, and external results enter the core as command or result-event data. Reducers never mutate an input or reach outside their arguments.

An effect may not change durable state directly. It returns a result event; the reducer is the only writer of brain state.

## Durable shape

Mini stores its own data at `.brain/mini.sqlite` so it can coexist with a legacy brain during migration. The database holds only two durable streams:

1. an append-only event and conversation log; and
2. periodically written, versioned brain snapshots for fast startup.

A snapshot is a cache of replayable events, not a second source of truth. There are no parallel JSON stores for atlas, ledger, context, wakes, top state, plans, reports, or assessments.

The initial snapshot shape is:

```js
{
  version: 1,
  ledger: { entries: [] },
  atlas: { nodes: [] },
  context: { pins: [], handoff: null },
  wakes: { entries: [] },
  changes: { proposals: [] },
  activity: { kind: "idle", detail: null, since: null }
}
```

The event log also contains user messages, model messages, model-tool requests, effect results, approvals, rejections, errors, and lifecycle transitions. Conversation history is not copied into the snapshot.

### Ledger

A ledger entry is deliberately small:

```js
{
  id,
  kind: "goal" | "note" | "question",
  text,
  status: "open" | "answered" | "closed",
  answer: null | { text, evidenceIds },
  pinned: false,
  createdAt,
  updatedAt
}
```

A question is the normal way to make uncertainty visible. It replaces most request, ask, task, and approval machinery. A goal may be closed with an outcome; a note may be pinned when it belongs in every useful context.

### Atlas

An Atlas node is a concise claim, not a second codebase:

```js
{
  id,
  title,
  claim,
  evidence: [{ path, range, digest }],
  links: [nodeId],
  createdAt,
  updatedAt
}
```

Freshness is derived by comparing stored evidence digests with observed file digests. Focus, attention, recency, stale state, and graph views are projections, not competing durable records. An Atlas claim without evidence is visibly unverified rather than silently trusted.

### Context

A pin preserves exact material and why it matters:

```js
{
  id,
  source: { path, range, digest } | { eventId },
  excerpt,
  reason,
  priority,
  createdAt
}
```

`handoff` is one compact, editable summary written when the agent sleeps or when the user asks for a reset. It states current intent, open questions, active evidence, and the next useful action.

### Changes

A change proposal is an immutable candidate until it is superseded or resolved:

```js
{
  id,
  rationale,
  patch,
  base: [{ path, digest }],
  status: "proposed" | "approved" | "rejected" | "applied" | "conflicted",
  createdAt,
  resolvedAt: null
}
```

A proposal never edits the workspace. Approval is a user event, not a model capability. The apply effect rechecks every base digest, writes only the approved patch, and emits either `change-applied` or `change-conflicted`.

### Wakes and activity

A wake is durable state, not a timer hidden in a process:

```js
{
  id,
  kind: "time" | "path",
  condition,
  status: "armed" | "ready" | "consumed" | "cancelled",
  reason,
  createdAt
}
```

`activity` is one visible current state: `idle`, `thinking`, `reading`, `waiting-for-approval`, `applying-change`, `sleeping`, `woken`, or `error`. It is derived from lifecycle events and never becomes a parallel workflow system.

## Commands, events, and effects

Commands express intent. Validation either rejects the command with a visible event or produces domain events and requested effects.

| Command family | Typical events | Possible effect |
| --- | --- | --- |
| Send a message | `message-recorded`, `activity-set` | request a model turn |
| Edit Ledger or Atlas | `ledger-recorded`, `atlas-recorded` | none |
| Inspect a path or range | `inspection-requested` | read only the requested material |
| Pin or unpin evidence | `context-pin-recorded` | none |
| Propose a change | `change-proposed` | none |
| Approve a proposal | `change-approved` | apply its patch |
| Reject a proposal | `change-rejected` | none |
| Arm or cancel a wake | `wake-armed`, `wake-cancelled` | arm timer or file observation |
| Sleep | `handoff-recorded`, `sleep-entered` | wait for user, timer, or path event |
| Observe external work | `file-observed`, `wake-ready` | optionally request a model turn |

Effect runners are capabilities with small, typed inputs and outputs:

- `readPaths` can return only requested paths/ranges and their digests.
- `requestModel` receives the compiled context and returns visible messages/tool calls.
- `applyPatch` receives an approved proposal and returns checked file-change results.
- `armWake` and `disarmWake` manage timers and file/folder observation.
- `persist` atomically appends events and snapshots.

There is no generic shell, command execution, mutable file-book API, network access, or runner/window capability in v1.

## Model contract

The model receives a compact static policy plus compiled project context. The static policy says only what cannot be represented as data:

- work from supplied evidence and inspect before making a claim;
- make durable commitments in the Ledger and durable project knowledge in the Atlas;
- keep pins and handoff useful and bounded;
- propose changes instead of making them;
- respect explicit approval; and
- sleep when useful work is blocked or complete.

The model tool surface is fixed and small:

| Tool | Meaning |
| --- | --- |
| `chat` | emit a visible message to the shared thread |
| `ledger` | create, update, answer, close, or pin a ledger entry |
| `atlas` | create or revise a source-backed Atlas claim |
| `inspect` | request a bounded file or range read |
| `pin` | add or remove exact context evidence with a reason |
| `propose_change` | persist a patch and rationale for review |
| `wake` | arm, cancel, or inspect a durable wake |
| `sleep` | record a handoff and enter the sleeping state |

Tool calls become commands and are validated by the same domain rules as user actions. The model cannot call an effect runner directly.

## Context gardening

Context gardening is a compiler, not a hidden prompt accumulator.

For each model turn it selects, in order:

1. stable Mini rules;
2. the current handoff and open pinned Ledger entries;
3. relevant Atlas claims and their freshness state;
4. exact pinned excerpts with reasons and digests;
5. recent thread messages; and
6. the minimal new inspection results needed for the current turn.

Selection has an explicit token budget. When material does not fit, the compiler records what was omitted and why; it never silently stuffs arbitrary state into the prompt. The exact resulting context, budget allocation, evidence list, and omissions are visible in the UI.

Pins whose file digest changes become stale. Stale pins and Atlas evidence are shown before they are used again. The agent may refresh them by inspection, but it may not claim they still describe the file without new evidence.

There are no shelves, reports, read-ahead batches, generated top snapshots, task-local prompt blocks, or invisible state sections.

## Conversation and lifecycle

A user message is durable before a model request starts. A model reply or tool call is durable before the next step begins. This makes restart, replay, and debugging straightforward.

Sleep is a real transition:

1. record or revise the handoff;
2. arm the requested time or path wakes;
3. set activity to `sleeping`;
4. stop requesting model turns; and
5. resume only when a user message or a ready wake creates a `woken` event.

Initial wake sources are a timestamp and a file or folder change. A path wake observes a declared scope only; it is not a general project watcher. Window output, process completion, cron-like scheduling, and autonomous polling are deferred.

Quiet wakes may add a compact lifecycle item without forcing a long conversational exchange. A wake with meaningful evidence can request the next model turn using the ordinary context compiler.

## The single workspace

Mini has one screen: **Shared Brain**. It is the conversation and context-engineering surface, not a control center with modes.

```text
Mini · project name                              sleeping until src/ changes

Conversation
  visible thread and composer

Now
  one activity line; current goal; next wake or pending approval

Ledger
  open goals, notes, and questions; answer/close/pin controls

Atlas
  source-backed claims; stale evidence is obvious; inspect/refresh controls

Context
  pins, handoff, compiled budget, included evidence, and omissions

When needed
  proposed change review and approve/reject controls
  armed wake cards and cancel controls
```

On a wide screen, conversation is the main column and the shared brain is a compact adjacent rail. On a narrow terminal, the same sections stack as collapsible blocks below the conversation. The screen has no permanent tabs, command palette, settings product, job drawer, raw payload page, or separate planning surface.

Every displayed item is either a durable record, a pure projection, or a current effect status. Nothing material to the model is hidden behind a different mode.

## Project setup and migration

`carto` creates or opens `.brain/mini.sqlite`. Project-local configuration is intentionally tiny and file-based if it is needed at all; it does not receive a settings UI in v1.

Migration is additive and explicit:

1. leave the existing legacy brain untouched;
2. create a new Mini database;
3. import only compatible Atlas claims and Ledger entries;
4. retain source paths, evidence, timestamps, and provenance where valid;
5. mark imported unsupported or stale evidence as unverified; and
6. write an import event for every migrated record.

Plans, tasks, focus forks, shelves, reports, assessment text, catalog/index records, windows, checkpoints, conferences, and legacy prompt state are not translated. Their absence is intentional, not a migration failure.

Mini becomes the default only after the new path meets its acceptance criteria. Legacy code stays isolated until then; it is not destructively simplified in place.

## Delivery sequence

### 1. Establish the kernel

Create a `mini/domain` package with immutable data constructors, schema validation, command deciders, reducers, context compiler, and screen projections. Write fixture-driven tests for replay, invalid commands, stale evidence, context budgeting, changes, and wake transitions. This phase imports no legacy runtime modules.

### 2. Add durable adapters

Implement the event store and snapshot adapter for `.brain/mini.sqlite`, then the typed effect runner. Prove that replaying the log produces the same snapshot, that a restart resumes safely, and that an interrupted effect cannot silently change domain state.

### 3. Add the model loop and file observation

Connect the context compiler, model request adapter, bounded inspector, timer, and path watcher. Add the small static policy and the eight-tool protocol. Use a stand-in model in tests.

### 4. Build the Shared Brain screen

Render the pure screen projection in one terminal workspace. Add only direct controls for messages, Ledger, Atlas, pins, changes, wakes, and sleep. Make compiled context inspectable before tuning visual polish.

### 5. Add explicit patch application and import

Implement approve/reject/apply flow with digest conflict handling. Add the one-way Atlas/Ledger importer and show imported provenance. Test it against representative legacy brains without making the Mini runtime depend on legacy modules.

### 6. Cut over deliberately

Run Mini in real projects, close the remaining behavioural gaps that belong to the stated core, and then remove legacy entry points only when Mini is proven as the default. Do not port deferred systems to make the cutover feel safer.

Each phase is a small pushed change with pure-domain tests first. The full suite remains deterministic and within its existing time budget.

## Acceptance criteria

Mini v1 is ready when all of the following are true:

- A new project can create, reload, and replay one durable shared brain.
- A conversation survives restart without duplicate model turns or lost visible messages.
- Ledger questions, goals, and notes can be created, answered, closed, and pinned.
- Atlas claims retain evidence and accurately show stale or unverified status after files change.
- The context panel shows exactly what the model receives, its budget, and why each item was selected or omitted.
- Inspection is bounded, read-only, and visible in the event history.
- The agent can store a patch proposal but cannot edit a workspace before user approval.
- Approved patches either apply against their recorded base or report a conflict without partial silent mutation.
- A time or path wake persists across restart, wakes the agent once, and leaves a compact handoff trail.
- The UI is one shared-brain workspace with no legacy menus, plan state, jobs, terminal windows, or hidden context modes.
- Domain tests exercise the reducer and context compiler without filesystem, clock, model, or process access; integration tests exercise adapters through deterministic fakes.

## Deferred attachments

After v1, any addition must fit the same command/event/effect boundary. Plausible later attachments are bounded read-only checks, history and undo derived from events, a text configuration file, an inspector/export command, and audited network access.

None is needed to make Mini a durable agent. The core remains Atlas, Ledger, context gardening, chat, wake, and sleep.
