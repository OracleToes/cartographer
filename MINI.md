# MINI.md — the specification of record

Carto is a durable agent for one person and one project. It is lightweight,
informative, and novel in a useful way.

This document holds only what the person has confirmed. Every line either states
confirmed intent, or is marked with the section that records it as open. The
record of who confirmed what is `docs/intent.md`. The list of everything still
unresolved is `docs/open-questions.md`.

The file name is `MINI.md` for compatibility with the repository task. The
product name is Carto and the command is `carto`.

## 1. What Carto is

Carto is a durable agent with three properties the person named:

- **robust context gardening**, as a full suite of context engineering and
  surgery for the agent's own working context;
- **ephemeral context** around a durable brain;
- **scoped tasking**, so the agent works in small, atomic steps.

It is built on three Pi packages and does not rebuild what they provide.

## 2. The Brain

The Brain is the durable thing. It persists across restarts and collapses. It
holds the agent's map of the project and its own state, standing in for memory.

The Brain holds:

- **Atlas** — nodes that store what the agent understands about the project:
  a name and a text entry. A node may be linked to other nodes; it may also be
  attached to any other reference in Carto. No typed edges, no source requirement,
  no evidence. Atlas is the map layer over the project tree: it connects what
  the agent understands into a graph. A file is not connected to the atlas
  unless the agent attaches a node to it — files are not implicitly nodes; the
  tree anchors where the map lives, not what is in it. Attention is a
  consequence of the minimal context, not a score the system computes — the
  agent stays focused because it keeps its Brain maintained.

  > Confirmed by the person: "the atlas serves the dual purpose of giving the
  > tree leaves, and of mapping out meaningful structure. the focus of it is a
  > consequence because the context is so minimal."

- **Ledger** — goals, notes, questions, instructions, and progress through a
  particular problem.
- **Chat** — deliberate Person Chat and Agent Chat records.

Deleting a Brain record is a single step with no undo state.

> Confirmed by the person: the Brain holds Atlas, Ledger, Chat.
> `handoff` is dropped — the Ledger is sufficient to rebuild a session.
> `context` and `activity` are not Brain records. Deletion is single-step. See
> `docs/intent.md` §18.
>
> Amended 2026-11-20 by the person: wakes are scrapped — the timer and path
> watches, the wake records, and the deferred wake tool are gone. The wake
> history stands in `docs/intent.md` §37. Pins are markers on a book entry —
> any Brain record (atlas, ledger, chat) — not a separate Pins book: a pin is
> rendered inline on the entry it marks.

The Brain is the only durable storage. Nothing else in Carto is durable.

### 2.1 The Atlas graph

Nodes are nodes — a name and a text entry. A node may be linked to other
nodes, or attached to any other reference in Carto; there are no typed edges,
and nothing requires a node to connect to anything. A node, or a sub-graph of
nodes, may float unconnected from the rest of the Atlas and from the project
tree. The tools are permissive and easy to use, by intent — the graph's
usefulness comes from the agent tending it, not from validation.

> Confirmed by the person.

### 2.2 The agent owns its Brain

The agent modifies everything in its Brain without approval. The Brain is its own
garden. There is no approval queue, no change-request record type, and no state
machine that mediates the agent's own housekeeping.

The person can do the same operations. Neither party needs the other's consent to
tend the Brain.

> Confirmed by the person: "the agent should be able to modify everything in its
> brain without approval, that is its own garden."

### 2.3 The agent does not see `.brain`

The agent does not read or write `.brain` directly. This is not a permission
gate; it is a scoping decision. Direct access would let curiosity fill the
agent's context with duplicated or stale copies of its own state. It is also
invisible: the project tree never lists it (§6.1), and no anchor may point
into it.

> The person named this explicitly as a case where their trust of the agent
> scopes its capability, rather than a rule the agent must obey.

### 2.4 Deletion is cheap and unpoliced

Deleting a Brain record costs nothing and needs no approval. The prompt asks the
agent to size its own entries; the runtime does not enforce a limit the agent
must budget against.

A limit the agent can see and cannot measure is worse than no limit. The agent
sees `maxLength` in a tool schema, overshoots it, retries, overshoots, and gives
up on making the entry at all. That friction teaches the agent to skip its own
memory.

> Confirmed by the person, from observed behaviour. The mechanism: schema limits
> are model-visible, and the model cannot count characters reliably.

## 3. Ephemeral context

Most of what the agent works with is ephemeral: tool work, reasoning, read calls,
and the model transcript. It is not kept.

The agent keeps what it needs by pinning it — a marker on an entry — and by
writing it into the Brain through Ledger, Atlas, and Chat. Ephemeral material it
does not pin is swept automatically to the archive at collapse; Brain records are
kept in the Brain unless the person or the agent marks them for archive.

"Ephemeral daemon" means the context is disposable, not the Brain. The Brain is
the durable property.

> Confirmed by the person.

## 4. Retention and the archive

There are two retentions, and they meet at the archive.

**Brain records are sticky.** Atlas, Ledger, and Chat survive collapse by
existing. They never archive on their own; the person or the agent may mark a
Brain record for archive, and it then sweeps to the archive on the next collapse.
(Marked for archive is like a pin, backwards: it does not stay in context, it
also does not get deleted.)

**Ephemeral material is disposable.** Tool calls, reasoning, read calls, and
other non-chat model output are swept automatically into the archive at collapse,
unless pinned. The archive is never the agent's decision — it is a consequence of
collapse, not a place the agent chooses.

**The archive is Carto's own database.** It exists to satisfy collapse and
permanent deletion — nothing else. pi-durable requires no archive and provides no
deletion primitive (it cuts a context with a reset and keeps every entry); Carto
builds the archive itself. The archive lives under `.brain/`, is readable and
restorable by the person only, and is never referenced by the Brain or the
agent. Pinned items in the archive remain in the archive unless unpinned or
restored to the context. Items in the archive that are not pinned — swept
ephemeral files and brain entries marked for archive — are deleted for good
after one collapse of grace. The archive is never the source of truth; the Brain is. A crash during
collapse cannot lose Brain state, because the Brain does not reference the
archive.

### 4.1 Pin and recover are different

- **Pin** means "keep it here." A pin is a marker on an entry — a Brain record
  (atlas, ledger, chat) — plus the two layout concepts the re-scope added:
  pinned files and pinned ephemera, which are confirmed positions in the
  prefill (open — what a pinned file is, and where pinned ephemeral content
  lives, — see `docs/open-questions.md` §15). Never a separate record, and
  carries no reason, no source, no other bookkeeping. An
  item pinned on the context layer never falls to the archive layer. An item
  pinned on the archive layer never gets deleted; it remains in the archive
  until unpinned or restored to the context. Pins render inline on the entry
  they mark and are clustered near the head of the prefill so they stay stable
  across collapses, without costing prefill. A pin records who placed it —
  the author, "user" or "agent" — and nothing else: the person may place and
  remove any pin from any view (chat, ledger, atlas, context), the agent may
  place its own pins and remove only its own pins; the agent may not remove a
  pin the person placed. The state block lists every pinned record, with its
  author, pre-collapse.
- **Recover** exists only for the archive. It means "put it back in the
  context" — the entry returns as its original type. It does not also pin; a
  pin is a separate action that either party can take.

**The agent does not know the archive exists.** Recovery is a person action.

Recovered records return to their original type, named by handle. An
attachment that no longer verifies is marked stale — the state block's stale
line carries it. The agent has no way to address the archive, by design.

> Confirmed by the person.

### 4.2 Deleted text is really gone

Deleted material is deleted. A deleted Brain record does not become an archive
entry, because the agent's deletion is a decision, not an accident. Deleting an
entry from context is a separate action from marking it for archive: delete
permanently removes it, never archived, costing a prefill because the tail is
cut; archival moves it to the archive for good or for later restore.

Pi Durable is designed to retain history. Carto is an ephemeral daemon and does
not keep that history for its own sake. The Brain document uses
`history: "latest"` and stores current state, not an audit trail of every old
value.

Pi storage is one store per generation. Collapse creates a fresh store for the
new generation and sweeps the previous generation's ephemeral material to the
archive. The old generation's store is deleted once the archive no longer needs
it. Transcript text that a collapse deletes is removed rather than hidden.

The Brain is separate from Pi storage and persists across generations. A live
session can always be rebuilt from the Brain alone, after a crash as well as at
a collapse. A crash during collapse cannot lose Brain state.

Carto requests SQLite secure-delete, WAL checkpoint and truncation, and `VACUUM`
for the Brain store, after a collapse, an archive purge, and an immediate
restart where the storage engine allows it. This is best-effort local cleanup
for the Brain file, not a guarantee against SSD wear levelling, backups, or
snapshots.

> Confirmed by the person: "i want deleted text really gone". The archive is
> not a sealed generation's store and the purge does not export pinned items
> into the Brain; the archive is Carto's own database, swept item by item at
> collapse, and the person owns everything in it. The per-generation store is
> deleted whole once the archive no longer needs it. See `docs/intent.md` §17
> and §29, amended 2026-11-21.

## 5. Collapse

Collapse is the gardening operation. It ends the current live context, sweeps
what it is told to sweep — every unpinned ephemeral item and every Brain record
marked for archive — to the archive, and writes a new context from the Brain.
Nothing else is deleted at collapse: unpinned items in the archive are deleted
for good after one collapse of grace, pinned items remain in the archive, and
Brain records not marked for archive are never moved.

**Collapse needs no approval.** Either the person or the agent can trigger it.

The person's expectation is that the agent will rarely trigger a collapse on its
own, because it does not want to forget. Knowing the person can collapse at any
time is meant to keep the agent's representation of its intent, progress, and
understanding current in the Brain.

The system prompt carries one line: the person may collapse the context at any
time, and a collapse rebuilds the agent's context from the Brain. A standing
fact, not mutable state; stated as consequence, not as threat.

A person-triggered collapse gets no boundary and no warning. Afterwards the
person sees a plain report — collapsed, previous generation archived — not a
confirmation beforehand.

> Confirmed by the person.

Collapse does not delete Brain records. Only a delete can.

## 6. The projection

The agent sees a projection built from the Brain plus its live context. The
projection is the stable head of the prefill. The prefill window, in order —
the person's worked-through layout, verbatim:

system prompt → tool definition/schema → atlas entries → ledger entries →
chat entries → pinned files → pinned ephemera → regular ephemera →
uncollapsed brain entries → regular ephemera → state block.

The head — everything through pinned ephemera — is the stable prefix, ordered
by type so the server's cached prefix stays warm across collapses and collapse
does not cost prefill. Brain entries clustered by type sit near the head; the
state block is always at the tail. Everything in this layout carries a short
reference ID (see below) — what "uncollapsed brain entries" and "pinned files"
mean and where pinned ephemeral content lives are still open — see
`docs/open-questions.md` §15.

**The projection carries structure, not a second copy of the dialogue.** A Person
message is already in the transcript; its text is not repeated in the projection.
Agent Chat text reaches the model as a tool result from the `chat` tool, not
through the projection.

> Confirmed by the person, choosing tool result over projection.

**Short handles.** Everything the agent sees in the context carries a short,
type-prefixed, generation-local reference ID — files, tool calls, entries, and
anything else the prefill carries; there is no other scheme, and no tool
parameter accepts a raw key. A handle is stable within one live generation and
is rebuilt at collapse. The agent never sees a database key, a Pi entry ID, or a
generation file name. A tool parameter that names an item takes a handle; an
unknown handle is an explicit error. The confirmed Brain-record handles are
`L1` (Ledger), `C10` (Chat), and `A1` (Atlas); the prefill layout's other
positions — pinned files, pinned ephemera, regular ephemera, uncollapsed brain
entries — carry short reference IDs too. What the kind prefixes are, and how
ephemeral items are named, are open — see `docs/open-questions.md` §15.

**The projection is frozen between collapses.** It is rebuilt only at collapse;
it is never patched between collapses. A Brain write between collapses appears as
the write tool's result and as a pending-change line in the state block — never
as a projection patch. This is what keeps the prefix the server has already read
valid, and it is what makes the pending list meaningful.

> Confirmed by the person.

**Order is the stability requirement.** After the freeze, nothing in the head
changes between collapses, and at a rebuild the prefix must stay identical
enough to keep the server's cached prefix valid. The head is ordered by design —
system prompt, tool schemas, Brain entries clustered by type, pinned content —
rather than by the Brain row order; the emitted tails remain a convention.

**Every durable ID line carries an ISO 8601 UTC timestamp**, so the agent can see
when something changed. Between collapses the line is frozen, so the timestamp
costs no prefix stability; it moves only at a rebuild.

> Confirmed by the person.

### 6.1 The state block

The context ends with a **state block**: a short section after everything the
agent reads. It is the agent's own dashboard about its brain and the project.

It tells the agent:

- the state of the context — how full it is (last reported provider usage,
  plus what the tool calls have added since);
- what is taking up space, broken down by Brain part — Ledger, Atlas, Chat —
  separately from tool work and from the stable system and tool prompts;
- pending changes — one line per Brain write since the projection was built,
  named by handle: the signal to collapse;
- new and stale entries — new Brain records, and Atlas entries whose
  attachment changed since the projection was built, named by handle: the
  signal to keep the Brain current;
- the project tree — anchored at a directory, to a depth, showing files,
  directories, sizes, and which files an Atlas node attaches to.

It is the part of the context expected to change often. Its items carry the
same short reference IDs everything else carries. An Atlas entry attached to a file whose contents changed since the entry was
written is marked stale — a gentle signal to update the Brain, never a block on
anything.

> Confirmed by the person.

### The project tree

The block carries the project tree to a depth, anchored at a directory. It shows
files, directories, and their sizes, and marks which files an Atlas node
attaches to, so the tree is a map of what the agent understands rather than a
listing.

The person is willing to pay its cost on large projects.

**`.brain` never renders.** It is skipped in every listing and excluded from the
aggregated sizes, and an anchor resolving into it, at any depth, is rejected.
The agent's map does not contain the Brain.

**The agent moves the anchor and the depth.** Attention is part of the present: if
the agent is working in a subdirectory, that is where the agent is now, and the
tree shows it. The anchor stays inside the project.

> Confirmed by the person, 2026-11-20: ".brain should be hidden from tree".

### A brain write is a tool result and a pending change

Between collapses, an Atlas or Ledger write does not enter the projection. It
exists as the tool's own result, and as a line in the state block saying what is
pending about the Brain.

This keeps the projection stable, so a brain write does not invalidate the
prefix the server has already read.

**A long list of pending changes is the signal to collapse.** The block growing
is how the agent notices that its map and its books have diverged.

### 6.2 The state block is the continuation

There is no separate nudge and no "you are not done" message. The agent is
executing the system prompt; the state block tells it where things stand, and it
decides what to do next: reason further, make a tool call, or sleep.

A run ends when a reply carries no tool call. To continue the agent's work, the
state block is delivered as the next turn. The agent reads the current state and
acts on it. The old design kept these apart: a dashboard and a synthetic
continuation. They are one mechanism.

The user's work comes first. The agent keeps its Brain in between and during
tasks; the less there is to do, the more imperative keeping the Brain is. There
is no ceiling on the pending list and no forced collapse — the growing list and
the fullness number are the pressure, and the person collapsing at any time is
the backstop.

> Confirmed by the person.

**The block must arrive as a user-role message.** A new request is only made when
the context ends in a user message or a tool result. A section in the system
prompt cannot start a turn, and a later system message cannot either. This is a
property of Pi Durable, not a design choice.

**The mechanism.** After a text-only reply, `onYield` continues the run with a
byte-sized marker user message. On every request, `beforeRequest`
strips any marker from the payload and appends a freshly rendered state block as
a trailing user-role message. The model sees exactly one current block at the
tail; the store keeps only markers; markers die with the generation's store at
collapse. Blocks never accumulate in the payload.

> Confirmed by the person.

**The block is identified by shape, not by announcement.** It uses the same
delimiters every time, and the system prompt describes the shape once. Nothing in
the message says "this is not the person's text": the model recognises the form.
Carto also tags the message so it is never mistaken for Chat, and never becomes a
Chat record.

### 6.3 The present is all that matters

This is the core philosophy of the project, not a detail of the block.

A model only ever needs what it needs to act **now**. Carto curates the context
to be exactly that. The state block is the last thing the model reads on every
request: it is information about the present, not a history of state, and it is
not kept.

**It is appended to every request and removed from the context after use.** It
exists only at the tail — the rattle on the snake. It never accumulates, so its
cost is one block in the prefill and nothing more.

**It is purely informative and never instructive.** It does not ask the agent to
do anything. It tells the agent where things stand. Continuing the turn is a
consequence of the agent following its system prompt with accurate information
about now, not an instruction inside the block.

> Confirmed by the person, who named this the crux of the project.

## 7. Project files and the edit boundary

Carto inspects and edits paths that resolve inside the selected project root. A
symlink that resolves outside the root is rejected. `.brain` is not readable or
writable by the agent.

> Confirmed as a scoping and safety boundary, not a trust gate.

The person's ideal is that the agent **only wants** to make small, atomic,
scoped edits: one boilerplate creation, or one atomic step toward the project
goal. It forgets the details of making changes and remembers the report it wrote
and the current state of the project.

**The gate is on the capability, not on the change.** Either the edit tool is
offered, or it is not. When it is not, the agent can still read and reason and
use the shell, and it is instructed not to make edits. There is no propose /
approve / apply queue, and `changes` is not a Brain record type.

> Confirmed as the person's direction, with the caveat that the appetite
> constraint is unsolved. See `docs/open-questions.md` §8.

## 8. The workspace

Carto uses the Pi TUI alternate screen. The workspace renders **modes** —
**Chat**, **Context**, and **Brain** — reachable by key and palette, not
fixed tabs. There is no permanent palette, settings screen, or drawer.

> The three-tab frame was re-scoped by the person on 2026-11-20: the token
> bar is required, the Context view is the flagship, and the mode set
> follows Posting's dense-screen philosophy on pi-tui primitives. See
> `docs/intent.md` §44 and `docs/ui-proposal.md`.

**The Context view is the real prompt**, in the order the model sees it, with a
fold tree. Functions, schemas, and records are collapsible; a leaf is never
folded. Tools get one collapsible entry per tool in their own sub-tree. Schema-
shaped content has a human-readable view and a real view. The fold rule applies
everywhere it makes sense. A row that trails off is readable in full somewhere.

**The frame** is a fixed header, a scrolling body, and a fixed footer, with one
row and one cell of padding so the chrome never touches the terminal edge. The
header is never pushed off screen. The bottom bar takes the whole bottom row.

**The transcript renders everything the model does, Chat or not.** The person's
lines land where the context places them; the agent's Chat words render as
Chat. Its reasoning, its plain model text, and its tool calls render too, as
**foldable cards**: dimmer than Chat, in their own hues, never mistaken for
Chat. A card streams while the run is in flight — thinking, text, and
tool-call arguments appear as they are written — inside a limited-height
window; at the boundary it folds to a one-line header. A click folds or
unfolds a card; `ctrl+e` toggles every card in view; the wheel over an open
card scrolls its window. Chat remains the only channel that addresses the
person.

> Confirmed by the person, 2026-11-20: "Everything visible, chat distinct" —
> the veil on plain model text is reversed. Reasoning in its own disclosure
> window and tool calls as foldable streaming cards were the same call.

**The token bar** is always visible. It uses the server's real window as the
denominator, marks the budget inside the bar, and shows an estimate in a
different glyph and colour before the first measured request.

> Open: the bar's source of measurement. The `prompt_progress` field shape in the
> old spec was asserted, never verified. See `docs/open-questions.md` §9.

## 9. Turn control

Three delivery modes survive:

- **Interrupt** — the person stops the run now, not politely at a boundary.
- **Steer** — a message queued at the next Pi Durable boundary; the agent sees
  it arrive in the transcript.
- **Follow-up** — a message queued for after the run.

Pause, edit-draft, and resume are gone; what the agent had said or proposed
already lives in Chat and the Ledger. Cancel is interrupt plus dropping what
was queued. A provider stream cannot be frozen mid-token; the stop takes
effect as close to now as the run's abort check allows — not at a boundary,
and not on the agent's convenience.

> Confirmed by the person; the interrupt semantics were restated by the
> person on 2026-11-20 ("Interrupt means interrupt"). See `docs/intent.md`
> §47 and `docs/open-questions.md` §10.

## 10. Sleep

The agent can sleep. A `sleep` ends the run; the person is the only thing
that re-engages the agent after a sleep — no timer wake, no path watch, no
other machinery.

> Amended 2026-11-20 by the person: wakes are scrapped. The sleep-timer
> wake and the wake records are gone; the person is the only wake. See
> `docs/rebuild-slices.md`.

## 10a. The tool surface

The agent's tools are scoped, unique, and permissive. Tool descriptions are the
authority on what a tool does; the system prompt carries only what no single
description can say.

- **chat** — declare something person-facing. Plain model text is not Chat; it, the reasoning, and the tool calls render as foldable cards — visible, dimmer, and their own hues, but never Chat.
- **atlas** — create or update one Atlas node: a name and a text entry,
  optionally linked to other nodes, optionally attached to any other reference
  in Carto.
- **ledger** — the agent's working book: goals, notes, questions, instructions,
  progress.
- **pin** — pin or remove one Brain record (atlas, ledger, chat). A pin means "keep it here".
- **read** — read a line range inside the project root.
- **edit** — apply one atomic edit to a path inside the project.
- **shell** — run a command inside the project.
- **tree** — set the project tree's anchor and depth in the state block and
  return the rendered tree; the agent's explicit statement of what it is
  attending to. `.brain` is not an anchor and never appears.
- **collapse** — end the context here and rebuild from the Brain. Rare; the
  escape hatch to a fresh context.
- **sleep** — end the run; there is nothing left to do.

> Confirmed by the person, with the dedicated `tree` and `collapse` tools
> agreed in discussion.

## 11. Use Pi, do not duplicate Pi

Fixed versions. Pi Durable stores commits, tasks, tool calls, sleeps, wakes,
retries, and SQLite. Pi AI provides models, providers, tool validation, streams,
usage, and errors. Pi TUI provides rendering, focus, editors, scrolling, input,
and mouse.

Carto adds only what Pi does not: the Brain, its records and rules, the
projection and handles, the product tools, and the workspace.

Carto does not implement a provider layer, stream parser, tool validator,
scheduler, timer queue, SQLite adapter, terminal editor, or transcript compactor.

## 12. Functional design

Product decisions are pure transformations over explicit records:

```text
decide(brain, command) -> decision
projectContext(brain, liveInput) -> projection
```

Neither reads the filesystem, reads a clock, calls a model, renders, or writes
storage. Runtime adapters supply time, Pi Durable commits, file inspection,
cleanup, and UI effects.

**Procedural first.** Modules of functions that take what they need and return
what they produce. No object owns state and exposes methods over it. State is one
explicit value; behaviour is functions over that value.

> Confirmed by the person: "B leading to A" — named procedures over explicit
> records, then a single state → update → render flow.

## 13. What is not in this specification

Removed because the person identified them as assumptions rather than intent:
approval queues, change-request records, `approve X1`, collapse confirmation,
gated deletion, and model-visible length limits on Brain entries.

Removed because the person did not confirm them: any retention or ordering
requirement not restated above.

Everything in this section is either gone or is tracked in
`docs/open-questions.md` as an open question. Nothing is silently dropped: the
questions file lists each one and what it would take to settle it.
