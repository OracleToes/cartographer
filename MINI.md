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

- **Atlas** — source-backed claims about the project, with checked evidence.
  Atlas is the map layer over the project tree: it marks the files the agent
  understands and connects what it understands into a graph. Attention is a
  consequence of the minimal context, not a score the system computes — the
  agent stays focused because it keeps its Brain maintained.

  > Confirmed by the person: "the atlas serves the dual purpose of giving the
  > tree leaves, and of mapping out meaningful structure. the focus of it is a
  > consequence because the context is so minimal."

- **Ledger** — goals, notes, questions, instructions, and progress through a
  particular problem.
- **Chat** — deliberate Person Chat and Agent Chat records.
- **Pins** — the agent's and the person's pins, in both layers.
- **Wakes** — the timers and path watches the agent has asked for.

Deleting a Brain record is a single step with no undo state.

> Confirmed by the person: the Brain holds Atlas, Ledger, Chat, pins, and
> wakes. `handoff` is dropped — the Ledger is sufficient to rebuild a session.
> `context` and `activity` are not Brain records. Deletion is single-step. See
> `docs/intent.md` §18.

The Brain is the only durable storage. Nothing else in Carto is durable.

### 2.1 The Atlas graph

Nodes are source-backed claims with evidence. Edges between nodes are optional
and typed; nothing requires a node to connect to another node. A node, or a
sub-graph of nodes, may float unconnected from the rest of the Atlas and from
the project tree. The tools are permissive and easy to use, by intent — the
graph's usefulness comes from the agent tending it, not from validation.

Edge types (directed, except `contradicts` which is symmetric):

- **`replaces`** — this node supersedes that one. The decay instrument: a dead
  claim that says so.
- **`depends-on`** — this claim rests on that one. The verification path: walk
  down what a claim stands on.
- **`contradicts`** — the two cannot both hold. Resolve or explicitly hedge;
  never act on both.

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

The agent keeps what it needs by pinning it and by writing it into the Brain
through Ledger, Atlas, and Chat. Everything else is expected to be lost.

"Ephemeral daemon" means the context is disposable, not the Brain. The Brain is
the durable property.

> Confirmed by the person.

## 4. Retention and the archive

There are two retentions, and they meet at the archive.

**Brain records are sticky.** Atlas, Ledger, and Chat survive collapse by
existing. Nothing moves them to the archive unless the agent deletes them.

**Ephemeral material is disposable.** At collapse, the old live context becomes
the archive. It is not the agent's decision and it is not stored as a second
Brain tier.

**The archive is a one-collapse grace period on forgetting.** Everything in the
archive that is not explicitly pinned there or recovered is deleted at the next
collapse. The archive is never the source of truth; the Brain is. A crash during
collapse cannot lose Brain state, because the Brain does not reference the
archive.

### 4.1 Pin and recover are different

- **Pin** means "keep it here." Applied in the Brain, it pins to the Brain.
  Applied to the archive, it pins to the archive. Each pin survives the purge it
  is attached to, until removed.
- **Recover** exists only for the archive. It means "put it back in the Brain."
  It does not also pin; a pin is a separate action that either party can take.

**The agent does not know the archive exists.** Recovery is a person action.

Recovered records return to their original type, named by handle. Evidence
that no longer verifies is marked stale — the state block's stale line carries
it. The agent has no way to address the archive, by design.

> Confirmed by the person.

### 4.2 Deleted text is really gone

Deleted material is deleted. A deleted Brain record does not become an archive
entry, because the agent's deletion is a decision, not an accident.

Pi Durable is designed to retain history. Carto is an ephemeral daemon and does
not keep that history for its own sake. The Brain document uses
`history: "latest"` and stores current state, not an audit trail of every old
value.

Pi storage is one store per generation. Collapse creates a fresh store for the
new generation. The previous generation's material is kept as the archive for
one collapse, and deleted at the next collapse. Transcript text that a collapse
deletes is removed rather than hidden.

The Brain is separate from Pi storage and persists across generations. A live
session can always be rebuilt from the Brain alone, after a crash as well as at
a collapse. A crash during collapse cannot lose Brain state.

Carto requests SQLite secure-delete, WAL checkpoint and truncation, and `VACUUM`
for the Brain store, after a collapse, an archive purge, and an immediate
restart where the storage engine allows it. This is best-effort local cleanup
for the Brain file, not a guarantee against SSD wear levelling, backups, or
snapshots.

> Confirmed by the person: "i want deleted text really gone", and "a fresh
> store per generation" when choosing between storage shapes, with the person's
> expectation that a session can be rebuilt from the Brain store if something
> happens. The archive is the sealed previous generation's Pi store; at the
next collapse the purge first exports pinned-to-archive records into the
Brain, then deletes the store. See `docs/intent.md` §29.

## 5. Collapse

Collapse is the gardening operation. It ends the current live context, writes a
new one from the Brain, and moves the old one to the archive.

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

The agent sees a projection built from the Brain plus its live context.

**The projection carries structure, not a second copy of the dialogue.** A Person
message is already in the transcript; its text is not repeated in the projection.
Agent Chat text reaches the model as a tool result from the `chat` tool, not
through the projection.

> Confirmed by the person, choosing tool result over projection.

**Short handles.** The agent and the person refer to records by short,
type-prefixed, generation-local handles such as `L1`, `C10`, `A1`, `P1`, `H1`,
`W1`. A handle is stable within one live generation and is rebuilt at collapse.
The agent never sees a database key, a Pi entry ID, or a generation file name. A
tool parameter that names a record takes a handle; an unknown handle is an
explicit error.

**The projection is frozen between collapses.** It is rebuilt only at collapse;
it is never patched between collapses. A Brain write between collapses appears as
the write tool's result and as a pending-change line in the state block — never
as a projection patch. This is what keeps the prefix the server has already read
valid, and it is what makes the pending list meaningful.

> Confirmed by the person.

**Order is not a requirement.** After the freeze, nothing in the projection
changes between collapses, and at a rebuild there is no cached prefix to
invalidate. The emitted order is a convention, not a product decision.

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
- what is taking up space, broken down by Brain part — Ledger, Atlas, Chat,
  pins and wakes — separately from tool work and from the stable system and
  tool prompts;
- pending changes — one line per Brain write since the projection was built,
  named by handle: the signal to collapse;
- what is stale — Atlas evidence or pins whose source changed since the
  projection was built, named by handle;
- wakes — what is armed and its target time;
- the project tree — anchored at a directory, to a depth, showing files,
  directories, sizes, and which files an Atlas node links to.

It is the part of the context expected to change often. Its items carry
structured IDs. An evidence file whose digest has changed since the claim was
written is marked stale at rebuild — a gentle signal to update the Brain,
never a block on anything.

> Confirmed by the person.

### The project tree

The block carries the project tree to a depth, anchored at a directory. It shows
files, directories, and their sizes, and marks which files an Atlas node links
to, so the tree is a map of what the agent understands rather than a listing.

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

## 10. Wake and sleep

The agent can sleep. A `sleep` without a time option ends the run; the agent
wakes when the person wakes it. A `sleep` with a timer ends the run; it
wakes when the timer expires. No other wake machinery exists — no folder
wake, no project-path wake.

> Confirmed by the person, 2026-11-20. See `docs/intent.md` §37 and
> `docs/open-questions.md` §11.

## 10a. The tool surface

The agent's tools are scoped, unique, and permissive. Tool descriptions are the
authority on what a tool does; the system prompt carries only what no single
description can say.

- **chat** — declare something person-facing. Plain model text is not Chat; it, the reasoning, and the tool calls render as foldable cards — visible, dimmer, and their own hues, but never Chat.
- **atlas** — create or update one source-backed claim node, with optional
  typed edges to other nodes.
- **ledger** — the agent's working book: goals, notes, questions, instructions,
  progress.
- **pin** — pin or remove one Brain item. A pin means "keep it here".
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
> agreed in discussion. Wake is the only deferred tool; sleep's timer defers
> the wake need for now.

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
