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

**Carto places no limit on the agent that the person has not defined.** There is
no turn limit, no maximum length on a name or an entry, no read limit on a file,
and no defensive gate that exists because a limit seemed prudent. A limit the
person has not asked for is a limit that slows the agent down and teaches it to
work around the tool instead of using it.

Where a bound is part of how a tool works, it is said so in that tool's own
description and nowhere else. This rule governs every place a limit could be
added later: it is not there unless the person put it there.

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

The prompt asks the agent to size its own entries. Under §1 there is no schema
length limit to size them against.

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

A pin renders inline on the entry it marks. It is not a record of its own and
takes no place in the prefill's order.

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

The live context is built on a store that is append-only: an entry, once
committed, cannot be removed from it. A collapse therefore builds a new context
in a new store, with only what survives the collapse in it. The previous store
is deleted as a whole, so everything it held is gone rather than hidden. This is
what makes a real deletion possible at all; it is not an optimisation.

The head is written first in the new store, in its fixed order, byte for byte as
it stood before. Keeping it identical is what lets the provider's cached prefix
survive a collapse, so a collapse pays for the body and the tail and never for
the head again. Anything that would change a head byte between generations must
be paid for at the collapse instead.

**Nothing outside a collapse removes text.** A deletion is not carried out in
place, and no mechanism that hides an entry from the context is a substitute for
one. Hiding leaves the bytes where they were, and this section would then be
false. The only two ways text goes are a store deleted whole at a collapse, and a
delete applied at a collapse.

Inside a generation, text leaves the context by being swept into the archive,
which is a move, not a deletion. It is deleted for good when the archive drops
it.

## 4. Collapse

Collapse is the gardening operation. It is the only thing that rebuilds the
context, and either party may trigger it. It needs no approval.

A collapse:

1. ends the live context;
2. sweeps every unpinned ephemeral item and every Brain record marked for
   archive into the archive;
3. deletes every Brain record marked for delete, and every unpinned archive item
   past its grace period;
4. places all Brain records into the new context's head (§5.1), in order,
   clustered by type, and returns every entry marked for restore to its place in
   the context;
5. places pinned ephemera and pinned files into the head, after Chat.

Brain records not marked for archive are never moved. No Brain record is deleted
by a collapse; only a delete deletes.

The system prompt carries one standing line: Context may collapse at any time, 
and a collapse rebuilds the agent's context from the Brain.

The agent is expected to keep its brain up-to-date, because it does not want to
forget.

### 4.1 Archive, restore, and delete are marks

Archive, restore, and delete are three separate actions, and each is a mark by
default. Marking applies the action at the next collapse, and the mark can be
changed or withdrawn until then.

- **Marked for archive** leaves the entry in the context for now. It is not in
  the head, not pinned, and it does not stay. The next collapse sweeps it.
- **Marked for delete** leaves the entry visible for now and removes it at the
  next collapse.
- **Marked for restore**, for an entry in the archive, leaves it in the archive
  for now and returns it to the context at the next collapse.

Each action can also be **applied now**. Applying an action now changes the
context immediately, which forces a rebuild at that point: the prefill runs
again from the changed entry through the tail. The head is untouched, so
applying an action now costs the body and the tail, never the head.

Marks are visible in the state block. A mark also carries its author, and only
the person may withdraw a mark the agent placed.

A deletion happens for real only at a collapse. Applying a delete now removes
the entry from the context, but the store it was committed to still holds it
(§3.4), so the text is gone from the model's view before it is gone from disk.

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

**Pinned files and pinned ephemera stand for their source, not for a copy of a
read.** A pinned file is the file at the moment of collapse: it is read again and
placed in the head as the file now stands, so the head holds the file, not a
quotation of it and not a stale snapshot. Pinned ephemera is held the same way,
each item under its own handle. This is why the head stays byte-stable across a
collapse while the files it carries change (§5.5).

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

- **Context fullness** — the server's own count for the last request, plus what
  tool calls have added since.
- **Space breakdown** — by Brain part (Ledger, Atlas, Chat), separately from
  tool work and from the stable system and tool prompts.
- **Pending changes** — one line per Brain write since the last collapse, named
  by handle.
- **New and stale entries** — Brain records written since the last collapse, and
  read results whose file changed since the read, named by handle (§5.5).
- **The project tree** — as described in §6.3.
- **Pinned entries** — every pinned entry, with its author.

A long pending list is the signal to collapse.

The block is identified by shape, not by announcement. It uses the same
delimiters every time, and the system prompt describes that shape once. Nothing
in it says that it is not the person's text. It is tagged so it is never mistaken
for Chat and never becomes a Chat record.

### 5.4 Handles

Everything the agent sees carries a short, type-prefixed, generation-local
handle. Everything, without exception: the system prompt, the tool schemas, each
Brain record, each Chat record, each tool call, each piece of reasoning, each tool
result, each `bash` result, each file in the project, each ephemeral item, and the
state block itself. There is no item in the context that has no handle.

Handles are what the tools address. A tool names its target by handle; an agent
that wants to pin a tool call, a piece of its own reasoning, or a file does so by
handle. The handles are also why the context can be talked about at all: a handle
is how one item refers to another.

**Files are handled by the tree.** The project tree gives a handle to every file
and directory it shows. A file's handle comes from the tree, not from a separate
inventory, so a file the tree does not show has no handle — which is why the tree
is rendered for a whole project and not only for what the agent happens to
mention.

- Handles are stable within a live generation and are rebuilt at collapse.
- The agent never sees a database key or a storage-level identifier.
- A tool parameter that names an item takes a handle. An unknown handle is an
  explicit error.
- **A path is a fallback, not an alternative.** `read` and `edit` take a handle
  first and a file path second, and `create` takes a path because the file does
  not exist yet and has no handle to give. A resolved path is the same file its
  handle names.

Every durable ID line carries an ISO 8601 UTC timestamp, so the agent can see
when something changed.

**The prefixes.**

| Prefix | Names |
| --- | --- |
| `A` | Atlas node |
| `L` | Ledger entry |
| `C` | Chat record |
| `T` | the project tree |
| `F` | a file |
| `D` | a directory |
| `H` | the system prompt |
| `Y` | a tool's definition and schema |
| `B` | the state block |
| `P` | a pin, named by the handle of the entry it marks |
| `X` | an ephemeral item, pinned or not |
| `R` | the result of a tool call |
| `S` | the result of `bash` |
| `E` | a Brain entry written since the last collapse, seen in the body |
| `U` | the person's message |

A file has one handle and one letter whether the tree is rendering it, a pinned
copy is sitting in the head, or a tool is being pointed at it. Pinning a file does
not give it a second name.

`S` is a subdivision of `R`: a `bash` result is a tool result, and the shell
deserves its own letter because it is quoted and discussed far more than it is
cited.

### 5.5 Read results and staleness

A `read` produces a tool result in the body, and that result carries a handle
like any other.

Pinning it pins the result, not the file. From then on the context holds the text
the agent actually read, attributable and citable, rather than a live view of a
path.

**A pinned read result goes stale when its file changes.** The state block says
so, by handle, from the moment the change is seen.

**At collapse, a pinned read result is made true.** The file is read again, and
the result becomes what the file now holds. This is what a pin means here: the
agent keeps its view of that file from being silently out of date, and pays for
it in a fresh read at every collapse rather than in a stale quotation.


### 5.6 Freeze

The prefill is built at collapse and is frozen until the next one. It is never
patched in between.

A Brain write between collapses does not enter the head. It exists as the write
tool's own result in the body, and as a pending line in the state block.

The freeze binds the projection, and only the projection. Two exemptions:

- **Applying an action now** (§4.1) rebuilds the prefill from the changed entry
  through the tail. That is a rebuild, not a patch, and the head is untouched.
- **The tail is always current.** The state block changes on every request by
  design; that is not a break in the freeze.

The prohibition that does hold without exception: the frozen region is never
edited in place. No entry already in the context is rewritten, masked, omitted,
or replaced by an overlay. Anything that would have to change there is done at
the next collapse or by an apply-now rebuild.

### 5.7 The state block is the continuation

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

The agent's ideal edit is small, atomic, and scoped: one function, one value
changed, one chunk removed, one small file added, or the minimum scaffolding that
makes the next step possible. It does not need to remember how a change was made;
it needs the report it wrote and the current state of the project.

Atomic here is an intention (§7). Nothing refuses a large change, and nothing
counts lines. What keeps changes small is the prompt and the agent's willingness
to stop.

### 6.1 Read only mode

A toggle in the workspace puts Carto in **read only** mode, and turns it off
again. The person sets it; nothing else does.

In read only mode:

- **`create` and `edit` are not offered.** They are absent from the tool set
  rather than refused when called, so the agent never forms a call it cannot
  make.
- **`bash` is still offered, and still trusted.** The mode is not a sandbox. The
  shell can write, replace, and delete files, and the person knows it. Read only
  mode removes the tools whose only purpose is to change the project; it does not
  remove the agent's hands.
- **The prompt says so.** It tells the agent that it is in read only mode and
  that the person is relying on it not to use the shell to work around that.

There is no propose, approve, or apply queue, in read only mode or out of it. A
proposal is not a capability, and the gate is on the capability.

The gate is on what each tool is *for*, never on whether a particular change
looks destructive. There is no definition of a destructive change to test
against, because nothing tests for one.

### 6.2 `.brain` is outside the agent

The agent does not read or write `.brain` directly. This scopes its capability;
it is not a permission gate. Direct access would fill the agent's context with
duplicated or stale copies of its own state.

`.brain` never renders. It is skipped in every listing, excluded from aggregated
sizes, and rejected as a tree anchor at any depth.

### 6.3 The project tree

The state block carries the project tree, rendered in the block itself. It shows
files, directories, and their sizes, and marks which files an Atlas node is
attached to, so the tree is a map of what the agent understands rather than a
listing.

The tree is anchored at the project root by default. The `tree` tool changes the
anchor and nothing else: it does not return the tree, because the tree is already
in the state block, which every request carries.

**`tree` ends the turn immediately.** The state block renders as the next turn, so
the agent sets where it is attending and sees the tree it just asked for at once,
rather than reading a second rendering of it in a tool result.

The anchor stays inside the project.

## 7. Tools

The agent's tools are scoped, unique, and permissive. A tool's own description is
the authority on what it does; the system prompt carries only what no single
description can say.

The prompt is short as a consequence of that rule, not as a target. There is no
word count to hit and none to stay under: a prompt that carries only what nothing
else can say is short because so little qualifies.

**A tool names its target by handle** (§5.4). That is the addressing scheme every
tool shares, and it is why every item in the context carries one. A file may also
be named by path: `read` and `edit` prefer the handle and fall back to the path,
and `create` takes a path because the file it makes has no handle yet.

| Tool | Does |
| --- | --- |
| `chat` | Writes one Agent Chat record: something declared person-facing. |
| `atlas` | Creates or updates one Atlas node, optionally linked to other nodes and attached to a reference. |
| `ledger` | Writes to the Ledger: a goal, note, question, instruction, or progress. |
| `pin` | Sets or clears the pin on one entry. |
| `read` | Reads a file by handle, or by path, from a start line, for a number of lines. |
| `edit` | Applies ordered text replacements to an existing file, named by handle or by path. Never creates, never replaces a file whole. Absent in read only mode. |
| `create` | Writes a new file, at a path. Refuses a path that already exists. Absent in read only mode. |
| `bash` | Runs a command inside the project. |
| `tree` | Sets the project tree's anchor. The tree renders in the state block. |
| `collapse` | Ends the context here and rebuilds it from the Brain. |
| `sleep` | Waits: forever, or for a number of seconds. |

`read`, `edit`, and `bash` are taken from the durable package. Carto supplies
their descriptions and scopes them to the project root; it does not write a file
or command layer beside them.

- **`read`** takes a file's handle, or its path, and optional `offset` and
  `limit`.
- **`edit`** takes a file's handle, or its path, and a list of `oldText`/`newText`
  replacements, each matched against the original file, not against the result of
  the one before. The package applies them all or nothing and refuses a file that
  does not exist. Editing an existing file is the only thing it does. Carto adds
  the handle: it resolves the handle to the path before the package sees it.
- **`bash`** runs a command through the project's environment. The name is the
  package's, and it is what an agent that has used a coding tool before already
  knows.

**Creation is separate from editing.** `create` writes a file that must not
exist and refuses a path that already does. The package's own `write` tool
creates *or* overwrites, and overwriting is the capability Carto does not offer.
A whole-file replacement is a rewrite, not a step toward a goal, and it discards
text the agent never read. Because `create` refuses an existing path, editing
again means `edit`, whose replacements must match the file exactly — so a file's
old contents have to pass through the agent's context before they can be
replaced.

**Replacement is not the same as deletion.** `edit` is what refuses to replace a
file whole; nothing stops the agent from deleting one. `bash` runs commands,
including whatever removes files. So a file can be deleted and recreated, and its
previous contents then exist only in git.

The filesystem rule is therefore about what the tools are *for* — creation is one
call, the narrowing of a file is another — not a boundary the filesystem
enforces against `bash`.

**Atomic is an intention, not a mechanism.** Nothing enforces it, and no tool
refuses a change for being too large. It is what the agent is asked to aim at:
one function, one value changed, one chunk removed, one small file added, or the
smallest scaffolding that makes the next step possible. The prompt asks for it
because a small change is one the agent can describe, verify, and undo, and a
large one is not.

Because it is an intention, it is checked by reading the work, not by the tools.
Neither the spec nor the runtime supplies a size limit to enforce in its place.

## 8. Workspace

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
boundary. A click folds or unfolds a card, a toggle toggles every card in view,
and the wheel over an open card scrolls its window. Chat remains the only channel
that addresses the person.

**The token bar is always visible**, and its figures come from llama.cpp, not
from a guess.

- **The denominator is the server's own capacity.** The context window is the
  total the server reports for its `-c` setting. The budget is marked *inside*
  the bar.
- **The numerator is the server's own count** for the last request, plus what the
  tool calls have added since.
- **The bar also reports what the server measures**: tokens per second for
  generation and for prompt reading, how much of the window is filled, and
  whether a prompt is still being read or generation has begun. Prefill is the
  slow half of a long context, and showing it is the point of reading the server
  rather than estimating.
- **Before the first measured request** the bar shows an estimate in a different
  glyph and colour, and says that it is one.

The estimate is not a fixed characters-per-token constant. It is re-learned from
the server's replies: the size of a request against the prompt tokens the server
reports for it, as a moving average, clamped so one odd reply cannot swing it.

`llama.cpp` is a local server with a small, stable HTTP surface. Everything above
is read from it, and none of it is inferred from a provider's response headers.

## 9. Turn control

The person's input box is live while the agent works. Typing never affects the
run, and nothing is sent until the person sends it.

**Pause** stops the run where it is without breaking the stream of generation.
The person types in the input box normally, unpauses, and the run continues
unaffected. Nothing is committed or discarded by a pause, and the agent is not
told it happened. A pause that is never released leaves the run stopped; it is
not a cancel.

**Send while paused** behaves as if the run had not been paused:

- **Steer** sends the message to the run as a steer and the stream is not
  broken. It is placed at the next tool boundary and joins the work in progress.
- **Follow-up** sends the message as a follow-up. It arrives after the run
  answers and starts the next run.
- **Interrupt** breaks the stream and delivers the person's message immediately.

An interrupt is the only one of the three that costs work, and what it costs is
fixed:

- A **Chat call that was mid-send is sent.** What the agent had already written
  reaches the person. A half-written declaration is still a declaration.
- **Every other tool call in flight is aborted.** Its result is written as
  partially completed, and stays in the context so the agent can see what it had
  done and what it had not. An aborted tool call is visible, not erased.
- The person's message is read at once, and the run restarts from it.

If the person unpauses while text is in the input box, nothing special happens.
The run resumes, the stream continues, and the text stays where it is until it is
sent.

**Cancel** is an interrupt plus dropping what was queued.

## 10. Sleep

`sleep` is a tool call that ends the current turn with nothing to say, and it is
the only way the agent stops working.

- **`sleep` with no argument** stops and stays stopped. The agent rests until the
  person sends it a message.
- **`sleep` with a whole number above zero** stops and rests for that many
  seconds, then starts again on its own.

Resuming is always the same thing: the agent receives the state block as its next
turn and acts on what it says. A timed sleep is not a different kind of event with
different handling — the agent wakes by receiving the state block, exactly as it
would after any turn that carried no tool call.

A message from the person ends a rest early, whether the rest had a time or not,
and starts the same way. A rest that is over is over: there is nothing left
pending, and no second start.

The wait is durable: the agent rests across a restart, and the time is an argument
to the call.

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
product tools (including `create`, whose existence check the package's write tool
does not offer), and the workspace. It does not implement a provider layer, a
stream parser, a tool validator, a scheduler, a timer queue, a SQLite adapter, a
terminal editor, or a transcript compactor.

## 13. Open

1. Which llama.cpp endpoints and fields carry the token bar's figures, and what
   the bar shows while the server is unreachable.

The model is always given the whole context. Carto does not rely on a provider
keeping conversation state on its own side, and no swept text is presumed to be
retained there.
