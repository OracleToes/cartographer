# SPEC.md

Carto is an agent for one person and one project.

It works in small, atomic steps, and it treats its own working context as an
explicit object it maintains: what the context holds can be written, pinned,
swept, rebuilt, and deleted for good.

It is lightweight, and what it shows the person is information rather than
chrome. What makes it different is that the context is maintained as a real
object rather than left to accumulate.

The Brain persists across restarts and collapses. The live context does not.

## 1. Scope

Carto has three defining properties:

1. **Context gardening.** A full suite of context engineering and surgery over
   the agent's own working context.
2. **Ephemeral context around a persistent Brain.** The working context is
   disposable; the Brain is what the agent brings forward.
3. **Scoped tasking.** The agent works in small, atomic steps.

The governing idea is that a model only needs what it needs to act now. Carto
curates the context to be exactly that, which is why it is short and why what is
in it carries so much weight.

**Permissive first, and the prompt is trusted.** Carto places no limit on the
agent that the person has not defined: no turn limit, no maximum length on a name
or an entry, no read limit on a file, and no defensive gate that exists because a
limit seemed prudent. A limit the person has not asked for slows the agent down
and teaches it to work around the tool instead of using it.

Where behaviour matters, the answer is the prompt, not a mechanism. The agent is
told what to do and trusted to do it. Anything that could go wrong is corrected by
saying so, not by building something that stops it.

The one exception is a capability the person turns off deliberately (§6.1). That
is not a limit on the agent; it is the person deciding what it has.

Where a bound is part of how a tool works, it is said so in that tool's own
description and nowhere else. This rule governs every place a limit could be
added later: it is not there unless the person put it there.

Carto is built on the `pi` packages and adds only what they do not provide
(§12).

## 2. The Brain

The Brain is the persistent record. It survives restarts and collapses, and a
live context can always be rebuilt from it alone — after a crash as well as at a
collapse, and a crash during a collapse cannot lose Brain state.

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

The Brain is the agent's attention, not its history. Atlas and Ledger tell it
what it is focused on and what it is working on, and it follows them rather than
re-deriving what it already decided. Nothing in the Brain is kept because it
happened; it is kept because it is still what the agent is acting on.

The Atlas tools do not validate connectivity.

What is in the Brain is what is in focus. The agent decides when a record has
stopped earning its place and deletes it, or moves it to a more permanent Atlas
entry. Nothing removes a record on the agent's behalf, and nothing scores it.

Atlas also holds the agent's loose task/plan graph: larger goals linked to
smaller steps down to atomic leaves, attached to the files they touch, with
leaves worked before stems and no forced order beyond that. As leaves finish,
the agent updates them in place, retires completed task nodes via `mark`, or
folds lasting understanding into permanent Atlas notes.

### 2.2 Ledger

The Ledger is the agent's lightweight active working state: current focus and
active leaf, open questions, what has been solved, and live progress through a
problem. Updating existing Atlas and Ledger handles in place as changes happen
keeps the Brain ready for a collapse at any moment — even mid-step — without
losing the agent's way or piling up bookkeeping records.

### 2.3 Chat

Chat is deliberate dialogue, recorded.

- **Agent Chat** is written through the `chat` tool, or via the required `message` field of `collapse`.
- **Person Chat** is the person's own message, recorded as it is sent.
- **System Chat** is written when a forced automatic collapse happens (context overflow, declined compaction, or recoverable length stop), so both the person and the rebuilt agent see why the context reset.

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
Otherwise it is swept to the archive at collapse, unless the person has chosen
to delete it at that collapse (§4.1).

Brain records are not ephemeral. They stay in the Brain until they are deleted,
or until they are marked for archive and a collapse moves them out (§4.1).

**Only Chat is a conversation.** Inside a generation the person's message is
already in the body, where it was said, and the agent's Chat reaches the model as
the `chat` tool's result; the head does not repeat either until a collapse ends
that body. Both are Chat records in the Brain, so they stay until someone deletes
them, and the collapse places them in the head (§3.2, §5.1): the conversation
goes on across a collapse, and the transcript and the Context view are two views
of the same records. New person messages carry their Chat identity in the live
entry, including when carried across an automatic collapse. Applying a Chat
record action now removes its corresponding live contribution as well as the
record; unrelated identical messages and sibling tool calls remain. Legacy
entries without an identity are matched only when there is one live occurrence
and one available record with that text; ambiguous lines remain separately
actionable as live contributions, without guessing which Brain record they are.
Chat is swept like every Brain record: only a delete or an
archive mark removes one, and an archived record moves out as the record, never
also as a swept line. A rebuild in the middle of a generation (an apply-now)
keeps to the Chat the head held at the freeze, and a message handed on as the new
generation's first turn is left out of that head; either way each record is read
once, and joins the head at the next collapse. The Context view lists a record
once: in the head when it is frozen there, and for the person's words said since,
as the live row, which marks the record.

### 3.2 Pins

A pin is a boolean on an entry, for the layer that entry is in. It is not an
entry, carries no reason, and has no bookkeeping beyond its author: the person
or the agent.

- An entry pinned on the live context layer never falls to the archive.
- An entry pinned on the archive layer is never deleted. It stays in the archive
  until it is unpinned or restored.

A pin only stops a sweep. So it exists only where something is swept:

- Ephemeral items and files, on the live context layer. An ephemeral item is
  swept by default and a pin is how it stays; a file is pin-only.
- Any item in the archive, a Brain record that was archived included, where the
  pin stops its grace running out.

**A Brain record (Atlas, Ledger, Chat) on the context layer has no pin.** The
Brain is not swept: a record leaves it only by a mark (§4.1). A pin on one would
hold nothing back, so there is no way to place one, for the person or the agent,
in any view. A Brain entry can be pinned once it is in the archive, in the archive
layer.

The person may pin or unpin any entry that can carry a pin. The agent may pin a
file or an ephemeral item and may unpin only its own pins; it may not remove a pin
the person placed. The agent has no handle on the archive, so it never pins
there.

A pin renders inline on the entry it marks. It is not a record of its own and
takes no place in the prefill's order.

The state block lists every pinned entry and its author.

### 3.3 The archive

The archive is Carto's own database under `.brain/`. It is the destination for
everything a collapse sweeps and for ephemeral entries the person archives
immediately (§4.1).

- It holds swept ephemeral items and Brain records marked for archive.
- It holds unpinned items for one collapse period. An item archived during a
  collapse or between collapses is deleted for good at the next collapse, unless
  it is pinned or restored.
- A pinned item in the archive remains until it is unpinned or restored.

Restoring puts an entry back where it came from, as its original type: a Brain
record returns to the Brain and so to the head, and an ephemeral item returns to
the live context. It does not also pin; a pin is a separate action either party
can take. A restored attachment that no longer resolves is marked stale.

Restoring is a person action, and the person's alone. The agent does not know
the archive exists. Anything swept is, to the agent, gone forever: it has no
handle for it, no way to address it, and no belief that it is retrievable. The
archive is invisible to the agent in every view, every listing, and every result
it can reach.

**The person reaches the archive by a toggle.** It swaps their view between the
context layer and the archive layer, and the person then works the UI as they
would anywhere else: pin, unpin, and restore from there. There is no separate
recovery screen and no mode of its own. The archive is the same UI over a
different layer, which is why a pin means the same thing on both (§3.2).

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
2. sweeps every unpinned ephemeral item not chosen for deletion, and every Brain
   record marked for archive, into the archive;
3. deletes ephemeral items chosen for deletion, every Brain record marked for
   delete, and every unpinned archive item past its grace period;
4. places every record the Brain holds into the new context's head (§5.1), in
   order, clustered by type, and returns every entry marked for restore to its
   place in the context;
5. places pinned ephemera and pinned files into the head, after Chat.

Brain records not marked for archive are never moved. No Brain record is deleted
by a collapse; only a delete deletes.

The system prompt carries one standing line: the context may collapse at any time,
and a collapse rebuilds the agent's context from the Brain.

A collapse rebuilds the context, and everything unrecorded is gone.

A collapse must not lose live content because it was interrupted. Before creating
its new generation, it records the intended handoff; the handoff becomes committed
in the same transaction as the Brain and archive changes. Recovery keeps the old
store if that transaction did not commit, and keeps the new generation if it did.
When missing or ambiguous files prevent a safe decision, recovery preserves the
stores and reports the problem instead of guessing which one to delete.

**The agent collapses when it is appropriate**, and what makes it appropriate is
that it has finished a piece of work and put what it needs into its Brain. A
short run ends that way: the work is done, the Brain is current, and a collapse
carries the result forward cleanly.

A long piece of work collapses *before* it starts. If a problem needs a lot known
about the project, the agent pins what it needs to know, arranges its context so
nothing in it is a distraction, collapses, and then begins — so it works inside a
context built for the problem rather than one it accumulated on the way there.

Either side may collapse at any moment. At an estimated 75% context fill by
default (adjustable in config), the state block warns the agent to prepare the
Brain and collapse before it runs out of room. The percentage is an estimate,
not a guarantee of available output.

**The agent keeps itself small, and nobody un-sticks it.** The agent is long
running, so a collapse it asks for, or one the model's limits force, is carried
out and the agent goes on by itself: the context is rebuilt from the Brain and
the new generation starts on a state block, with no message from the person.
This holds for every host and for a run that nothing of the person's started,
such as a timed rest waking.

- **The warning.** At an estimated fill reaching the configured collapse warning
  percentage (default 75%) of a known window the state block says
  `[COLLAPSE NEEDED]` on every request until the context is rebuilt: write what
  you need to continue to the Brain, mark what is obsolete, then collapse. An
  unknown window is reported as unknown; no percentage is invented.
- **Limits are the other trigger.** Carto uses the signals pi already provides
  and adds no threshold of its own. A recognised provider overflow error, and a
  `length` stop that pi's own check calls recoverable — the response ended below
  the output limit that was intended, so the cause may be the context — ask for
  one collapse. A `length` stop is not proof the context is full; a response that
  ended at the intended limit is an ordinary stop and continues as any answer.
- **Bounded.** A generation that was itself rebuilt automatically and then asks
  to collapse again having done no work, or having started already at the warning
  fill, is not collapsed a third time. The host says plainly that the rebuild got
  nowhere (the head may be too large for the window) and waits for the person.
- **Nothing the person said is lost.** Messages queued when the collapse runs,
  and a message whose run the model's limit killed before it was answered, are
  carried into the new generation and are what it starts on. A message sent while
  the rebuild is under way waits for the new session. A paused agent is not
  restarted, but the person's own messages are still delivered.
- **Collapse communication.** When the agent calls `collapse`, it passes a required `message` recorded into Chat so the person and the rebuilt agent know why it collapsed and what comes next. When a forced automatic collapse happens (overflow, declined compaction, or recoverable length limit), Carto records a System Chat notice before freezing the new head so both sides see that an automatic collapse occurred.
- **The cost is accepted.** A collapse forced by a limit loses whatever the agent
  had not written to the Brain. Nothing removes unmarked Brain records.

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

For ephemeral content in Context, sweeping to the archive is already the default.
The person's `d` instead chooses deletion at the next collapse and shows that
choice on the entry; it does not sweep the entry to the archive. `!d` removes it
from the model's view immediately; its bytes remain in the append-only live store
until that store is removed at collapse. The first `a` highlights the ephemeral
entry in red to confirm the action; the second `a` archives it immediately.
The highlight is a confirmation, not an archive mark waiting for collapse.

The person and the agent can both create, edit, delete, reorder, and mark records
of every type the Brain knows, from the workspace as much as from a tool. A record
the person made is a record of its type, in every respect: the agent does not know
the difference, and does not know the person made, deleted, or moved anything. To
the agent, the Brain is simply itself.

Each action can also be **applied now**. Applying an action now changes the
context immediately, which forces a rebuild at that point: the prefill runs
again from the changed entry through the tail. The head is untouched, so
applying an action now costs the body and the tail, never the head. A Brain
record is in the head, so applying an action on one now rebuilds the head from
that entry: the bytes before it are untouched, and the rest is paid for again.

Marks are visible in the state block. A mark also carries its author, and only
the person may withdraw a mark the agent placed.

A deletion happens for real only at a collapse. Applying a delete now removes
the entry from the context, but the store it was committed to still holds it
(§3.4), so the text is gone from the model's view before it is gone from disk.

**Archiving a Brain record moves it out of the Brain.** The record is not
duplicated and does not stay behind carrying a mark: it is a Brain record while
it is in the Brain and an archived record while it is in the archive. The Brain
holds no archived state, and a record kind has no field to hold one. When it is
restored it is a Brain record again, of its original type.

That is what makes the archive a destination rather than a flag. It also keeps
the Brain's promise intact: everything in it is live, and a live context can be
rebuilt from the Brain alone (§2) without any of it being hidden from the rebuild
by a mark.

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

A Brain record written since the last collapse appears here, at the point it was
written, as `E`. It reaches the head at the next collapse, not before (§5.6).

Body entries are never gathered into clusters, never sorted by kind, and never
listed by type. They appear where they actually are.

### 5.3 Tail: the state block

The last thing in the prefill is the **state block**. It is the agent's
dashboard about its Brain and the project, and it reports:

- **Context fullness** — the server's input and output count for the last
  response, plus estimated tool work added since. When the window is known,
  report estimated percentage and warn `[COLLAPSE NEEDED]` at the configured
  collapse warning percentage (default 75%); when it is unknown, do not invent
  a percentage.
- **Space breakdown** — by Brain part (Ledger, Atlas, Chat), separately from
  tool work and from the stable system and tool prompts.
- **Pending changes** — one line per Brain write since the last collapse, named
  by handle.
- **New and stale entries** — Brain records written since the last collapse, and
  read results whose file changed since the read, named by handle (§5.5).
- **Persistent jobs** — when persistent piped processes exist, one compact
  status line per `J` handle (label, running/exited status, unread line count,
  quiet/active indicator); never scrollback buffers, and omitted when none exist.
- **The project tree** — as described in §6.3.
- **Pinned entries** — every pinned entry, with its author.
- **Marks** — every entry carrying a mark, with its action and its author (§4.1).
- **The mode** — `[READ ONLY MODE]` or `[EDIT MODE]` (§6.1).
- **Decision flow & state-reactive attention cues** — a compact mode-aware
  `flow:` checklist at the tail, plus conditional `attention:` cues derived
  strictly from live facts (such as `bash` used for file edits, pinned files
  drifting on disk since collapse, an untouched/flat Brain after several tool
  calls or persistent jobs with unread output). It does not instruct the agent
  to archive or delete Chat. Omitted when clean.

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
| `J` | a persistent piped process (`proc`) |
| `E` | a Brain entry written since the last collapse, seen in the body |
| `U` | the person's message |

A file has one handle and one letter whether the tree is rendering it, a pinned
copy is sitting in the head, or a tool is being pointed at it. Pinning a file does
not give it a second name.

`S` is a subdivision of `R`: a `bash` result is a tool result, and the shell
deserves its own letter because it is quoted and discussed far more than it is
cited.

**`X`, `U`, `R`, and `S` are numbered in prompt order, and the transcript and
the Context view use one numbering.** A Brain record's handle is the Brain's, and
survives a collapse with the record. An ephemeral item has no record to hold one,
so its number comes from where it sits: `X3` is the third ephemeral item in the
prompt in both views, because a handle is only useful if it names the same thing
wherever the person reads it.

The state block lists live ephemeral handles with short identifying previews, so
the agent can select an item without rewriting the cached prompt body. Pinned
items already in the frozen head keep their `X` handles; live `X` numbering
starts after those handles.

A tool row in the transcript is one row — the call's arguments and its result —
so it wears the result's handle, `R` or `S`, which is the text a person quotes
and the item a pin holds (§5.5). The call keeps its own `X` handle in the Context
view, where both are drawn.

### 5.5 Read results and staleness

A `read` produces a tool result in the body, and that result carries a handle
like any other.

Pinning it pins the result, not the file. From then on the context holds the text
the agent actually read, attributable and citable, rather than a live view of a
path.

**A pinned read result goes stale when its file changes.** The state block says
so, by handle, from the moment the change is seen.

**An Atlas node attached to a file goes stale the same way.** When a file under
an attachment changes, the node is reported stale in the state block and is
written back as stale at the next collapse, stored on the entry like a pin.
Staleness is a gentle signal: it blocks nothing, deletes nothing, and asks for
nothing. Its whole effect is that the agent is told its note about that file may
no longer be true.

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
  use. Because the model never sees prior blocks, it never accumulates and
  every request sees the tail fresh at its attention peak.
- It guides rather than coerces: its compact `flow:` decision tree and
  condition-triggered `attention:` cues reflect observed live state so the agent
  steers itself cleanly without blocking tool calls or imposing rigid phases (§1).

## 6. Project files

Carto reads and edits paths that resolve inside the selected project root. A
symlink that resolves outside the root is rejected.

The agent's ideal edit is small, atomic, and scoped: one function, one value
changed, one chunk removed, one small file added, or the minimum scaffolding that
makes the next step possible. It does not need to remember how a change was made;
it needs the report it wrote and the current state of the project.

Atomic here is an intention (§7). Nothing refuses a large change, and nothing
counts lines. What keeps changes small is the prompt and the agent's willingness
to stop. That is deliberate: a mechanism that refused large changes would be the
prompt not being trusted (§1).

### 6.1 Read only mode and edit mode

Carto is always in one of two modes. A toggle in the workspace switches between
them. The person sets it; nothing else does.

- **Edit mode** is the default. The harness enforces nothing, and the agent edits
  as it works.
- **Read only mode** means the agent makes no destructive change to the project.
  The harness enforces this at `create` and `edit`, and nowhere else.

**The tools stay offered in both modes.** Withholding them would mean
re-defining the schema between collapses, and the head is frozen (§5.1, §5.6):
the schema changing is a head byte changing, which forces the whole prefill to be
paid again. So `create` and `edit` remain in the tool set, and in read only mode
they return an error telling the agent not to make edits or any other destructive
change while the mode is on.

**The mode is stated in the state block**, as `[READ ONLY MODE]` or
`[EDIT MODE]`. The state block is the tail, which is rebuilt every request
anyway, so the mode costs nothing to report and nothing is broken by it changing.
The system prompt defines what the two modes mean, once, because no tool
description can say what the mode is rather than what one tool does.

**`bash` is still offered in read only mode, and still trusted.** The mode is not
a sandbox. The shell can write, replace, and delete files, and the person knows
it and relies on the agent not to use it that way. Read only mode takes away the
agent's stated intent to change the project, not its hands.

There is no propose, approve, or apply queue, in either mode. A proposal is not a
capability, and the gate is on the capability.

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

The tree is anchored at the project root by default, at a depth of two. The `tree`
tool sets the anchor and the depth, both optional: the anchor defaults to the
project root, and the depth defaults to two. A depth of one is the anchor and its
immediate contents; anything below one renders the same as one, because there is
no useful rendering of an anchor with nothing under it. The tool does not return the tree:
it is already in the state block, which every request carries, and the tool's
result is only that the block will be rendered at the new anchor.

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

**The system prompt teaches, it does not prohibit.** It is the first thing the
agent reads and the thing it follows: how to read its environment, how to use its
tools well, and what pattern of thinking to hold to. It guides the agent into the
way of working rather than fencing off mistakes, because the context it sits over
is short enough that guidance is not competing with noise.

It is also where the things that cannot be enforced are said: the agent keeps
small, atomic steps; it does not know when the world changes and trusts its map
and what it kept; it declares to the person through `chat` and treats its plain
text as its own reasoning.

**A tool names its target by handle** (§5.4). That is the addressing scheme every
tool shares, and it is why every item in the context carries one. A file may also
be named by path: `read` and `edit` prefer the handle and fall back to the path,
and `create` takes a path because the file it makes has no handle yet.

| Tool | Does |
| --- | --- |
| `chat` | Writes one Agent Chat record: something declared person-facing. |
| `atlas` | Creates or updates one Atlas node, optionally linked to other nodes and attached to a reference. |
| `ledger` | Writes to the Ledger: a goal, note, question, instruction, or progress. |
| `pin` | Sets or clears the pin on one file from the tree or one live ephemeral item by handle; the agent cannot remove the person's pin. |
| `mark` | Marks one Brain record for archive or delete, or withdraws a mark the agent placed. Applies at the next collapse. |
| `read` | Reads a file by handle, or by path, from a start line, for a number of lines. |
| `edit` | Applies ordered text replacements to an existing file, named by handle or by path. Never creates, never replaces a file whole. Errors in read only mode. |
| `create` | Writes a new file, at a path. Refuses a path that already exists. Errors in read only mode. |
| `bash` | Runs a command inside the project. |
| `proc` | Starts, drives, reads, and stops persistent piped processes (`J` handles) that live in host memory, survive collapse, and are shared live in the `jobs` view. |
| `tree` | Sets the project tree's anchor and depth. The tree renders in the state block. |
| `collapse` | Ends the context here and rebuilds it from the Brain, recording a required Chat `message` to the person. |
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

**The screen is surfaces, darkest outermost.** The chrome (the margin round the
frame, the header row, the key bar and the context bar) sits on the deepest tone;
the sidebar and the working area are raised out of it, each on its own step;
the prompt, entry headers in the transcript and context views, and a selected
row are raised again. The frame has a margin of two
cells and one row, one cell on a narrow terminal and none on a very small one,
with a breathing row between the bands only when the terminal has rows to
spare. Every cell of the frame is painted: a pane that is shorter than its room
is filled to its foot, never left to show the terminal's own background. Text
runs on a three-step ramp (body, dim, faint) and a saturated colour always means
something. None of this changes what a view shows or what a key does.

**The Context view is the real prompt**, in the order the model sees it, with a
fold tree. Every entry is collapsible, and every entry starts collapsed: a row
is its handle, its name, a one-line summary, and its estimated token cost until
it is opened (when the token cost stays on its header). Each tool gets one
collapsible entry in its own sub-tree. Schema-shaped content has a
human-readable view and a real view. A row that trails off is readable in full
somewhere.

**The Context view shows what the model receives, as it is now, and nothing in
its place.** There is no placeholder and no sentence describing a row instead of
being it. A head row is the frozen head's own lines: a record, a pinned item, and
a pinned file with the text the collapse read, each as written there, in both
views. The head is listed from the frozen bytes, so a record or a pin that has
left the Brain since the freeze is still shown, marked as leaving at the next
collapse, because the model still reads it. **Nothing the head does not hold is
listed in the head**, not with a note and not in a row of its own: a record
written, or a file or an item pinned, since the freeze is not in the context
yet, and a view of the context does not show it where it is not. A pending change
is shown where it really is, on a row that exists: a pinned item's body row is
highlighted as `pin on collapse`, the way a row marked for delete is highlighted,
and the tail, which is where the state block lists the pins and the marks,
carries the highlight for a pin that has no other row, such as a file. The Atlas,
the Ledger, the transcript and the Tree are where a pending record or pin is
read and changed. The body holds every message the model receives, the agent's `chat`
calls and its plain text included; the tail is the state block as sent. The
head is listed in §5.1's order, the system prompt first (it is the first
section of the system message, ahead of the projection); the tools are shown as
registered, `bash` with Carto's sentence. The token count covers what is shown.

**An edit made there is an edit to the source of truth.** A Brain-backed entry is
edited in the Brain, and the change is everywhere that record appears: the
record, the pending line in the state block, and the next collapse. It is never a
private annotation layer over what the model sees. Anything not kept stays
ephemeral, and a staged change takes effect at the next collapse unless the person
applies it now (§4.1).

**The person has the same controls in every view of the Brain** (§3.2, §4.1).
`p` pins or unpins the entry under the cursor where something can carry a pin
(§3.2): an ephemeral item in the Context view or a transcript card, an item in
the archive, and a file in the Tree, where the head holds a
pinned file as it stands, read again at every collapse. Atlas, Ledger and Chat
records have no pin outside the archive, so `p` is not theirs. The person's press
unpins a pin whoever placed it, and the file's pin is keyed by the same path the
agent's `pin` writes, so one file is one pin. In the Context view, Atlas, and
Ledger, `a` marks the record for archive, `d` marks it for delete, `u` withdraws
the person's mark, and `!` arms the next mark to apply at once; the books route
these into the same code as the Context view, and the header says when `!` is
armed. In the books `d` and `u` mark and withdraw in the detail pane too, and
the detail pages with `ctrl+d` and `ctrl+u`. `c` collapses from the Context view,
Atlas, Ledger, and the Tree, where the marks are applied. While `/` takes a
filter, every one of these keys is a letter of it. A file carries a pin and no
mark: the `mark` tool is for Brain records. These keys are commands in the same
list as everything else, so the footer, `f1`, and the palette show them.
In Chat, `escape` leaves the prompt and selects a block (the last one); `j`/`k`
(or the arrows) walk the Chat blocks, the person's and the agent's, and the cards;
`g` and `G` go to the first and last; and `a`, `d`, `u` and `!` (and `p`, on a
card) do what they do everywhere else, through the same handlers as the Context view's rows: a Chat block
is its Brain record, a card is the ephemeral item it renders (a tool row is its
result), and an ephemeral card asks before it archives. `escape` or `enter` returns
to the prompt. A card still streaming is not an item anything holds and cannot be
selected. A click folds a card; it never pins or marks.

**The open book follows the Brain.** The drain that rebuilds the transcript, on
every run boundary, on a throttled live-watch tick and on a slow timer, also
redraws the open Atlas or Ledger when the Brain's records changed, and the
sidebar's counts with it, judged by a digest of what the books show so a quiet
Brain costs a read and a comparison, not a redraw. The Context view and the Tree
follow on the same drain.

The sidebar also has a single vertical, token-weighted map of the occupied
prompt, using the Context view's ordered entries and their type colours: frozen
head at the top, live body in occurrence order, and state-block tail at the
bottom. It does not show unused capacity. Hovering a row shows its region,
entry and estimated size; a row shared by several entries says so. Clicking a
row provides the same detail when mouse motion is unavailable. On short screens
the map yields to navigation. Hovering or clicking it does not change focus.

**The transcript renders everything the model does.** The Chat the head holds is
drawn first, in the head's order, before anything the generation did — after a
reload as before it, and whatever the entries' timestamps say; Chat written since
sits where it was written. The person's lines land
where the context places them. The agent's Chat words render as Chat. Its
reasoning, plain model text, and tool calls render as foldable cards: dimmer than
Chat, in their own hues, never mistaken for Chat. A card streams while the run is
in flight inside a limited-height window, and folds to a one-line header at the
boundary. A header click folds or opens a card; a click on a long card's body or
hidden-lines indicator toggles between the preview and full content. A toggle
folds or opens every card in view, and the wheel scrolls the transcript. Chat remains the only channel
that addresses the person. The transcript shows the Chat and ephemera the model
actually sees, in the frozen head's order followed by the live body; it does not
retain a separate historical transcript. After collapse, archived or deleted
Chat and swept work disappear, while Chat and pinned work in the new head remain.
Session notifications are transient UI notices, not transcript messages.

**The context bar spans the whole bottom of the application and is always
visible.** Its width is the server's own context capacity: the total the server
reports for its `-c` setting. Filling it is a picture of the context, not a
gauge with a budget mark.

It shows three quantities, each in its own colour:

- **Fill** — how much of the context is occupied, in one colour regardless of
  content type. It is restored from the session's last measured response after
  reopening. During a prompt read, the cached prefix keeps its position and fill
  colour, as does the prior fill beyond the prompt's extent.
- **Prefilled** — during a prompt read, the newly processed part of the uncached
  tail is shown in a second colour; the cached prefix is not recoloured.
- **To prefill** — the remainder of that tail is shown in a third colour. With
  an unknown context window, the progress bar scales to the prompt. The bar's
  width does not change as progress labels, speeds or ETA change.

The bar also shows prefill and decode speeds in tokens per second. During an
active prompt read, the prefill speed and remaining-time estimate are highlighted;
during generation, the decode speed is highlighted. Paused, finished, or lost
requests keep their figures in the quieter ink. When the server has not supplied
a progress or speed figure, it is unknown, not zero or an invented live
measurement. On narrow terminals the bar may shorten its labels.

The two prefill quantities are the point of the bar. Prefill is the slow half of
a long context, and a bar that shows how far along the read is tells the person
which part of the context is being paid for and how much of it is breaking when
something invalidates the head.

**The figures come from llama.cpp.** The server's count for the last request plus
what the tool calls have added since; its tokens per second for generation and
for prompt reading; and whether a prompt is still being read or generation has
begun. None of it is inferred from a provider's response headers.

**Before the first measured request** the bar shows an estimate in a different
glyph and colour, and says that it is one. The estimate is not a fixed
characters-per-token constant: it is re-learned from the server's replies — the
size of a request against the prompt tokens the server reports for it — as a
moving average, clamped so one odd reply cannot swing it.

**When the server is not there**, the bar changes but does not disappear:

- **On a new start with no measurement yet**, the whole bar is empty. Nothing has
  been measured and there is nothing to draw.
- **When a server that was reporting stops** — a lost connection, or the server
  dying — the last known values stay where they are, greyed. The person can still
  see where the context stood, and the grey says it is no longer live.

The endpoints and field names the figures are read from are the runtime's, not the
spec's (§12). What the spec fixes is what the bar knows and where it comes from.

The glyphs and the exact colours are the build's to choose. What the spec fixes is
what the bar represents: capacity across the bottom, three quantities, three
colours, and an estimate that announces itself.

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
different handling — the agent starts again by receiving the state block, exactly
as it would after any turn that carried no tool call.

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
storage. Runtime adapters supply time, commits, filesystem access, cleanup, and UI
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

The model is always given the whole context. Carto does not rely on a provider
keeping conversation state on its own side, and no swept text is presumed to be
retained there.
