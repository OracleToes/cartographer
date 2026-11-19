# Mini

## Purpose

Mini is a new, small Cartographer.

It serves one person in one project.

It has five core parts:

- Atlas: short, source-backed project knowledge.
- Ledger: goals, notes, and questions.
- Context gardening: choose what stays in context.
- Chat: deliberate messages between the person and the agent.
- Wake and sleep: stop safely and resume later.

Mini does not keep old features because they already exist.

## Clean start

This repository keeps this plan, the license, and Git history.

It does not keep the old runtime, user interface, tests, package files, or command wrapper.

The old code has useful ideas. It has no module that Mini must keep.

An old Cartographer brain can later be an import source for Atlas and Ledger. Mini does not need old Cartographer code to run.

## Use Pi

Mini uses Pi. It does not make a second version of Pi.

- [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) stores work before Mini shows it. It runs durable model turns, tools, tasks, sleeps, wakes, retries, and SQLite commits.
- [pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai) provides models, providers, login, tool schemas, tool-call parsing, streaming, token use, cost data, and model errors.
- [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui) provides terminal input, rendering, scrolling, focus, keys, mouse input, Markdown, and basic controls.

Mini only adds product rules that Pi does not provide:

- the Mini Brain data;
- Atlas and Ledger rules;
- Chat rules;
- context pins, archive, and collapse rules;
- Mini tools;
- one Shared Brain screen.

Mini does not make its own:

- model provider layer;
- model stream parser;
- tool schema validator;
- task scheduler;
- retry system;
- timer or wake queue;
- SQLite storage adapter;
- terminal framework;
- generic terminal editor;
- generic transcript compactor.

Pin exact Pi package versions. Test every Pi upgrade as a separate change.

## An important Pi limit

Pi Durable transcript entries are immutable.

Pi Durable `reset()` and `compact()` stop old entries from going to the model. They do not delete old entries from storage.

Mini collapse is not Pi compaction.

Mini turns off Pi automatic compaction. A Pi Durable compaction hook declines a compaction and asks for a Mini collapse. Mini uses Pi Durable for safe work and storage. Mini uses its own product rule for the life of context data.

## One project, one Brain

Mini has one durable Brain for each project.

The Brain is a Pi Durable document with `history: "latest"`.

This means Mini keeps the current Brain value. It does not keep a long list of old Brain values.

The Brain contains:

```js
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

Mini uses Pi Durable SQLite storage. It does not make a new storage engine.

Mini has three small storage files:

```text
.brain/brain.sqlite     the Mini Brain document
.brain/live.sqlite      the current Pi Durable model session
.brain/archive.sqlite   the previous model session, if one exists
```

The live and archive files are context files. They are not the Brain.

The Brain names the current live generation and archive generation. It is the source of truth.

## Two rules for keeping data

Mini has two different rules.

### Working context uses the keep rule

Working context includes:

- file reads;
- source excerpts;
- tool results;
- temporary model text;
- the current model transcript.

Working context is temporary.

The agent must pin an item to carry it into the next live session.

If the agent does not pin an item, Mini moves it to the archive at collapse.

The archive lasts for one collapse period.

Before the next collapse, the person can pin an archive item.

Mini deletes every archive item that the person does not pin at that next collapse.

### Deliberate records use the delete rule

These records stay by default:

- Chat;
- Atlas;
- Ledger.

They do not need a pin.

Mini deletes one only after it has a deletion mark.

A deletion mark hides the record from normal use. The person can cancel the mark before the next confirmed collapse. The next confirmed collapse deletes the marked record.

This is product deletion. It is not a secure disk-wipe promise.

## Pins

There are two kinds of pin.

### Carry pin

The agent makes a carry pin.

It keeps one working-context item for the next live session.

A carry pin lasts for one collapse period. The agent must make it again if the item still matters at the next collapse.

A carry pin has:

```js
{
  id,
  item,
  reason,
  source: { path, range, digest } | { contextId },
  createdAt
}
```

### User pin

The person makes a user pin.

It rescues an item from the archive, or keeps an item from the active context.

A user pin stays until the person removes it.

A user pin has the same source and reason fields as a carry pin.

A changed file makes a source pin stale. Mini shows the stale state. Mini does not use the old source text as a current fact.

## Collapse

Collapse is a visible, user-confirmed action.

The agent can request a collapse when the live context is too large. The agent cannot delete an archive in the background.

A collapse does this:

1. The agent writes its carry pins for the current live session.
2. The person can add user pins from the old archive.
3. Mini stores the new pins in the Brain.
4. Mini starts a new live Pi Durable session from the Brain projection.
5. Mini marks the current live session as the new archive.
6. Mini removes the old archive.

The new live session receives:

- Mini rules;
- the handoff;
- user pins;
- current carry pins;
- useful Atlas and Ledger records;
- active wakes, changes, and deletion marks.

It does not receive unpinned material from an old live session.

A collapse must survive a crash.

Mini first saves the new Brain generation state. It deletes an old archive file only after that save succeeds. A restart uses the Brain generation state. It keeps referenced files and later removes unused files.

A crash can leave an extra old file. A crash must not lose a saved user pin or a saved carry pin.

## Chat

Chat is a deliberate record.

- A person message writes one user Chat record.
- The agent writes an agent Chat record only with the `chat` tool.
- Ordinary model text is not a Chat record.
- Mini does not treat an idle model answer as a message to the person.

If the model sends text without a `chat` tool call, Mini does not add it to Chat. Mini treats it as temporary output or a tool-protocol fault.

A Chat record has:

```js
{
  id,
  author: "user" | "agent",
  text,
  createdAt
}
```

Chat stays until it has a deletion mark.

## Atlas and Ledger

Atlas is project knowledge.

An Atlas item has a short claim and its evidence.

```js
{
  id,
  title,
  claim,
  evidence: [{ path, range, digest }],
  links: [],
  createdAt,
  updatedAt
}
```

A changed evidence digest makes an Atlas item stale.

Ledger is a list of goals, notes, and questions.

```js
{
  id,
  kind: "goal" | "note" | "question",
  text,
  status: "open" | "answered" | "closed",
  answer: null | { text, evidenceIds },
  createdAt,
  updatedAt
}
```

Atlas and Ledger stay until they have a deletion mark.

A closed goal is still a record. It is not deleted just because it is closed.

## Context gardening

Context gardening chooses what enters a new live session.

It is a pure projection. It does not read files, call a model, change the Brain, or delete data.

```text
projectContext(brain, generation, budget) -> context plan
```

The context plan lists each item, its source, its reason, its freshness, and its estimated size.

Mini shows the context plan in the Shared Brain screen.

The context plan uses this order:

1. Mini rules.
2. The current user message.
3. The handoff.
4. User pins.
5. Carry pins.
6. Open Ledger goals and questions.
7. Relevant, fresh Atlas records.
8. Active wakes, changes, and deletion marks.

Mini does not use hidden context blocks.

Mini does not use a vector store in version one.

Mini uses links, paths, exact words, freshness, and direct user pins to choose records.

When an item does not fit, Mini says why. For example: `too large`, `stale`, `duplicate`, or `not used for this session`.

Mini does not silently cut a claim in half.

## Functional design

Mini keeps product decisions pure.

```text
user or model command
  -> pure Mini decision
  -> Pi Durable commit and task
  -> new Brain value or result
```

Mini pure functions include:

```text
decide(brain, command) -> next Brain change and requested work
projectContext(brain, generation, budget) -> context plan
projectScreen(brain, context plan) -> screen data
```

These functions do not use the filesystem, clock, model, terminal, or database.

Pi Durable performs stored commits, durable task steps, retries, sleeps, and wakes.

Pi AI performs model calls and tool validation.

Pi TUI performs terminal input and rendering.

## Model tools

Mini has a small tool set.

- `chat`: write one deliberate agent Chat record.
- `ledger`: add or change a Ledger record.
- `atlas`: add or change an Atlas record with evidence.
- `inspect`: request a bounded file read.
- `pin`: make or remove an agent carry pin.
- `propose_change`: store a patch for review.
- `wake`: arm, cancel, or view a wake.
- `sleep`: write a handoff and sleep.

Pi Durable defines and runs these tools. Pi AI validates their arguments and reads their tool calls.

The person makes and removes user pins in the Shared Brain screen.

The model cannot write files with a Mini tool.

The model cannot apply a patch. The person approves a change. Mini then runs one limited apply task.

## Wake and sleep

Wake and sleep are durable states.

Mini uses Pi Durable tasks for them.

- A time wake uses a Pi Durable sleep.
- A file or folder watcher sends a Pi Durable signal.
- A user message wakes the active work.

Mini does not make a second timer system or a second task queue.

The handoff is short. It says the intent, open questions, useful records, and next action.

## Shared Brain screen

Mini has one screen.

It uses Pi TUI components. Mini does not make a second terminal framework.

The screen has these parts:

- Chat and a message editor.
- Current activity.
- Ledger.
- Atlas.
- Context pins and handoff.
- Archive status: `This archive will be deleted at the next collapse.`
- A change review when a change exists.
- A wake card when a wake exists.

On a wide terminal, Chat is the main area. The Brain is a small side area.

On a narrow terminal, the parts appear one after another.

There are no permanent tabs, command palette, settings product, job drawer, raw model page, or plan page.

## Not in version one

Mini does not include:

- plans or task forks;
- approval envelopes;
- arbitrary shell commands;
- terminal windows;
- process jobs;
- sandboxing;
- checkpoints;
- conferences;
- reports or shelves;
- assessment files;
- catalog screens;
- a vector store;
- automatic transcript summaries.

## Build order

1. Add the Pi packages and pin their versions.
2. Define the current-only Mini Brain document.
3. Build live and archive session rotation.
4. Test collapse, user rescue, deletion, and crash recovery.
5. Add Atlas, Ledger, Chat, pins, and the small tool set.
6. Add model calls and bounded file inspection.
7. Add wake and sleep with Pi Durable tasks and signals.
8. Build the one Pi TUI Shared Brain screen.
9. Add approved patch apply and an optional old-brain importer.

## Done means

Mini version one is ready when all of these are true:

- A restart does not lose the current Brain, a pending tool, or a pending wake.
- A collapse moves unpinned current context into one archive.
- At the next confirmed collapse, Mini deletes unpinned archive data.
- A user pin saves an archive item before that deletion.
- A carry pin lasts one collapse period and must be selected again.
- Chat, Atlas, and Ledger stay without pins.
- Chat, Atlas, and Ledger are deleted only after a deletion mark and a confirmed collapse.
- Agent Chat exists only after a `chat` tool call.
- The next live session contains only the Brain projection and selected pins. It does not contain unpinned old context.
- A crash during collapse leaves a usable old or new generation. It does not lose a saved pin.
- Mini uses Pi Durable, Pi AI, and Pi TUI instead of duplicate framework code.
