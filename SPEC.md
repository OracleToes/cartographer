# SPEC.md

Carto is an agent for one person and one project.

It works in small, atomic steps, and it treats its own working context as an
explicit object it maintains: what the context holds can be written, pinned,
swept, rebuilt, and deleted for good.

The Brain persists across restarts and collapses. The live context does not.

## 1. Scope

Carto has three defining properties:

1. **Context gardening.** A full suite of context engineering and surgery over
   the agent's own working context.
2. **Ephemeral context around a persistent Brain.** The working context is
   disposable; the Brain is the memory.
3. **Scoped tasking.** The agent works in small, atomic steps.

Carto is built on the `pi` packages and adds only what they do not provide
(§12).

## 2. The Brain

The Brain is the persistent record. It survives restarts and collapses, and a
live context can always be rebuilt from it alone.

It holds three kinds of record: **Atlas**, **Ledger**, and **Chat**.

### 2.1 Atlas

An Atlas node is a name and a text entry.

- A node may link to other nodes.
- A node may attach to any other reference in Carto.
- There are no typed edges, no source requirement, and no evidence
  requirement.
- Nothing requires a node to connect to anything. A node, or a whole
  sub-graph, may float free of the rest of the Atlas and of the project tree.

A file is not an Atlas node. A file appears in the Atlas only when a node is
attached to it. The project tree is where the Atlas may attach; it is not what
the Atlas contains.

The Atlas is not scored. Attention is a consequence of a small context, not a
value the system computes.

The Atlas tools do not validate connectivity.

### 2.2 Ledger

The Ledger is the agent's working book: goals, notes, questions, instructions,
and progress through a problem.

### 2.3 Chat

Chat is deliberate dialogue, recorded.

- **Agent Chat** is written through the `chat` tool.
- **Person Chat** is the person's own message, recorded as it is sent.

Chat is not plain model output. Reasoning, plain model text, and tool calls are
never Chat, and are never recorded as Chat.

A Chat record appears in the context exactly once, in exactly one place. It is
never duplicated and never displayed twice.

### 2.4 Ownership

The agent modifies everything in its Brain without approval. There is no
approval queue, no change-request record, and no state machine between the
agent and its own housekeeping.

The person can perform the same operations. Neither party needs the other's
consent to work on the Brain.

### 2.5 Deletion and length

Deleting a Brain record is one step and has no undo. A deleted record is not
archived and does not become an archive entry. Marking a record for archive is a
different action, and the two are never confused (§3.3).

No schema length limit is placed on a Brain entry. The prompt asks the agent to
size its own entries; the runtime enforces no character budget and exposes none.

## 3. Context

The context is what the model reads on a request. It has two layers: the **live
context** and the **archive**.

### 3.1 Ephemeral material

Most of what the agent works with is ephemeral: tool calls, reasoning, read
calls, other non-Chat model output, and the model transcript. None of it is
kept.

An ephemeral item survives only if it is pinned on the live context layer.
Everything else is swept to the archive at collapse.

Brain records are not ephemeral. They stay in the Brain until they are deleted
or marked for archive.

### 3.2 Pins

A pin is a boolean on an entry, for the layer that entry is in. It is not an
entry, carries no reason, and has no bookkeeping beyond its author: the person
or the agent.

- An entry pinned on the live context layer never falls to the archive.
- An entry pinned on the archive layer is never deleted. It stays in the archive
  until it is unpinned or restored.

The person may pin or unpin any entry. The agent may pin any entry and may unpin
only its own pins; it may not remove a pin the person placed.

The state block lists every pinned entry and its author.

### 3.3 The archive

The archive is Carto's own database under `.brain/`. It is the destination for
everything a collapse sweeps, and nothing else.

- It holds swept ephemeral items and Brain records marked for archive.
- It grants one collapse of grace. An unpinned item in the archive is deleted
  for good at the following collapse.
- A pinned item in the archive remains until it is unpinned or restored.

Restoring puts an entry back into the live context as its original type. It does
not also pin; a pin is a separate action either party can take. A restored
attachment that no longer resolves is marked stale.

Restoring is a person action, and the person's alone. The agent does not know
the archive exists. Anything swept is, to the agent, gone forever: it has no
handle for it, no way to address it, and no belief that it is retrievable. The
archive is invisible to the agent in every view, every listing, and every result
it can reach.

### 3.4 Deleted text is really gone

Deleting removes text from storage rather than masking it. The context keeps no
audit trail of earlier values.

This covers both kinds of removal: a sweep at collapse is a real deletion of the
previous context, and a delete is a real deletion of a Brain record.

## 4. Collapse

Collapse is the gardening operation. It is the only thing that rebuilds the
context, and either party may trigger it. It needs no approval.

A collapse:

1. ends the live context;
2. sweeps every unpinned ephemeral item and every Brain record marked for
   archive into the archive;
3. deletes every unpinned archive item past its grace period;
4. places all Brain records into the new context's head (§5.1), in order,
   clustered by type;
5. places pinned ephemera and pinned files into the head, after Chat.

Brain records not marked for archive are never moved. No Brain record is deleted
by a collapse; only a delete deletes.

The system prompt carries one standing line: the person may collapse the context
at any time, and a collapse rebuilds the agent's context from the Brain.

The agent is expected to trigger a collapse rarely, because it does not want to
forget. The person may collapse without warning, and afterwards sees a plain
report rather than a confirmation request.

## 5. The prefill

The prefill is what the model reads. It has three regions, in this order:
**head**, **body**, **tail**.

### 5.1 Head

The head is fixed, clustered by type, and in one order:

```text
system prompt → tool definitions and schemas → atlas entries → ledger entries
→ chat entries → pinned files → pinned ephemera
```

Every position is stable. The head appears in this order on every request and
does not change between collapses. Its composition changes only when the Brain
changes, never because of new activity.

### 5.2 Body

Everything outside the head is the body, and the body has no ordering scheme. It
is the live context in the order it actually occurred, one entry at a time:

- regular ephemera (tool calls, reasoning, read calls, plain model text),
- Brain records written since the last collapse,
- new Chat,
- tool results,
- the person's messages.

Body entries are never gathered into clusters, never sorted by kind, and never
listed by type. They appear where they actually are.

### 5.3 Tail: the state block

The last thing in the prefill is the **state block**. It is the agent's
dashboard about its Brain and the project, and it reports:

- **Context fullness** — last reported provider usage, plus what tool calls have
  added since.
- **Space breakdown** — by Brain part (Ledger, Atlas, Chat), separately from
  tool work and from the stable system and tool prompts.
- **Pending changes** — one line per Brain write since the last collapse, named
  by handle.
- **New and stale entries** — Brain records written since the last collapse, and
  attached files whose contents changed since their node was written, named by
  handle.
- **The project tree** — as described in §6.2.
- **Pinned entries** — every pinned entry, with its author.

A long pending list is the signal to collapse.

The block is identified by shape, not by announcement. It uses the same
delimiters every time, and the system prompt describes that shape once. Nothing
in it says that it is not the person's text. It is tagged so it is never mistaken
for Chat and never becomes a Chat record.

### 5.4 Handles

Everything the agent sees in the context carries a short, type-prefixed,
generation-local handle: files, tool calls, Brain records, and every other item
the prefill carries. There is no other naming scheme, and no tool parameter
accepts a raw key.

- Handles are stable within a live generation and are rebuilt at collapse.
- The agent never sees a database key or a storage-level identifier.
- A tool parameter that names an item takes a handle. An unknown handle is an
  explicit error.
- The prefixes are `A` (Atlas), `L` (Ledger), and `C` (Chat).

Every durable ID line carries an ISO 8601 UTC timestamp, so the agent can see
when something changed.

### 5.5 Freeze

The prefill is built at collapse and is frozen until the next one. It is never
patched in between.

A Brain write between collapses does not enter the head. It exists as the write
tool's own result in the body, and as a pending line in the state block.

### 5.6 The state block is the continuation

There is no separate nudge and no "you are not done" message. A run ends when a
reply carries no tool call. To continue the agent's work, the state block is
delivered as the next turn, and the agent reads the current state and acts.

- The block arrives as a user-role message. A system message cannot start a turn.
- The block is rendered fresh at the tail of every request and is removed after
  use. It never accumulates, so its cost is one block and nothing more.
- It is purely informative and never instructive. It does not ask the agent to
  do anything.

## 6. Project files

Carto inspects and edits paths that resolve inside the selected project root. A
symlink that resolves outside the root is rejected.

The agent's ideal edit is small, atomic, and scoped: one boilerplate creation, or
one step toward the project goal. It does not need to remember how a change was
made; it needs the report it wrote and the current state of the project.

The edit gate is on the capability, not the change. Either the edit tool is
offered or it is not. When it is not, the agent can still read, reason, and use
the shell, and it is instructed not to make edits. There is no propose, approve,
or apply queue.

### 6.1 `.brain` is outside the agent

The agent does not read or write `.brain` directly. This scopes its capability;
it is not a permission gate. Direct access would fill the agent's context with
duplicated or stale copies of its own state.

`.brain` never renders. It is skipped in every listing, excluded from aggregated
sizes, and rejected as a tree anchor at any depth.

### 6.2 The project tree

The state block carries the project tree, anchored at a directory and shown to a
depth. It shows files, directories, and their sizes, and marks which files an
Atlas node is attached to, so the tree is a map of what the agent understands
rather than a listing.

The agent moves the anchor and the depth. The anchor stays inside the project.

## 7. Tools

The agent's tools are scoped, unique, and permissive. A tool's own description is
the authority on what it does; the system prompt carries only what no single
description can say.

| Tool | Does |
| --- | --- |
| `chat` | Writes one Agent Chat record: something declared person-facing. |
| `atlas` | Creates or updates one Atlas node, optionally linked to other nodes and attached to a reference. |
| `ledger` | Writes to the Ledger: a goal, note, question, instruction, or progress. |
| `pin` | Sets or clears the pin on one entry. |
| `read` | Reads a line range inside the project root. |
| `edit` | Applies one atomic edit to a path inside the project. |
| `shell` | Runs a command inside the project. |
| `tree` | Sets the project tree's anchor and depth, and returns the rendered tree. |
| `collapse` | Ends the context here and rebuilds it from the Brain. |
| `sleep` | Ends the run. |

## 8. Workspace

Carto uses the Pi TUI alternate screen and renders **modes** — **Chat**,
**Context**, and **Brain** — reachable by key and palette. There is no permanent
palette, settings screen, or drawer.

**The frame** is a fixed header, a scrolling body, and a fixed footer, with one
row and one cell of padding so the chrome never touches the terminal edge. The
header is never pushed off screen. The bottom bar takes the whole bottom row.

**The Context view is the real prompt**, in the order the model sees it, with a
fold tree. Functions, schemas, and records are collapsible; a leaf is never
folded. Each tool gets one collapsible entry in its own sub-tree. Schema-shaped
content has a human-readable view and a real view. A row that trails off is
readable in full somewhere.

**The transcript renders everything the model does.** The person's lines land
where the context places them. The agent's Chat words render as Chat. Its
reasoning, plain model text, and tool calls render as foldable cards: dimmer than
Chat, in their own hues, never mistaken for Chat. A card streams while the run is
in flight inside a limited-height window, and folds to a one-line header at the
boundary. A click folds or unfolds a card, `ctrl+e` toggles every card in view,
and the wheel over an open card scrolls its window. Chat remains the only channel
that addresses the person.

**The token bar is always visible.** It uses the server's real window as the
denominator, marks the budget inside the bar, and shows an estimate in a different
glyph and colour before the first measured request.

## 9. Turn control

- **Interrupt** stops the run now, as close to now as the run's abort check
  allows, and not politely at a boundary.
- **Steer** queues a message for the next durable boundary. The agent sees it
  arrive in the transcript.
- **Follow-up** queues a message for after the run.
- **Cancel** is an interrupt plus dropping what was queued.

There is no pause, no draft editing, and no resume.

## 10. Sleep

The agent can sleep. A `sleep` ends the run, and the person is the only thing
that re-engages the agent afterwards. Nothing on a timer reawakens it and nothing
watches a path for it.

## 11. Runtime shape

Product decisions are pure transformations over explicit records:

```text
decide(brain, command)          -> decision
projectContext(brain, liveInput) -> projection
```

Neither reads the filesystem, reads a clock, calls a model, renders, or writes
storage. Runtime adapters supply time, commits, file inspection, cleanup, and UI
effects.

**Procedural first.** Modules of functions that take what they need and return
what they produce. No object owns state and exposes methods over it. State is one
explicit value; behaviour is functions over that value.

## 12. Dependencies

Carto is built on three `pi` packages and does not rebuild them:

- `@earendil-works/pi-tui` — rendering, layout, focus, editors, scrolling,
  overlays, key parsing.
- `@earendil-works/pi-durable` — conversations, tasks, tool calls, sleeps,
  retries, SQLite storage.
- `@earendil-works/pi-ai` — models, providers, tool validation, streams, usage,
  provider errors.

Carto adds only the Brain and its records, the prefill and its handles, the
product tools, and the workspace. It does not implement a provider layer, a
stream parser, a tool validator, a scheduler, a timer queue, a SQLite adapter, a
terminal editor, or a transcript compactor.

## 13. Open

1. The token bar's source of measurement.
2. What a pinned file is, and how a file carries a pin.
3. How ephemeral entries are named. The Brain prefixes are fixed; the prefix and
   scheme for files, tool calls, and ephemera are not.
