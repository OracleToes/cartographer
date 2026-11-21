# Confirmed intent

**Amended 2026-11-20 by the person:** wakes are scrapped — the timer wake, the
folder wake, the path wake, and the sleep-tool wake are gone; nothing armed
re-engages the agent but the person. The entries below record the decisions
they were made as, with the amendments noted where they landed. Pins are
also re-scoped the same day: a pin is a marker on a book entry (any Brain
record — atlas, ledger, chat), not a separate Pins book; a pin carries no
reason, no source, no other bookkeeping — an item pinned on the context layer
never falls to the archive layer, and an item pinned on the archive layer
never gets deleted.

> Amended 2026-11-21, by the person: a pin also records who placed it — the author,
> "user" or "agent" — and nothing else. Under the 2026-11-21 re-scope (§50) the
> archive is Carto's own database, swept item by item: a pinned archive item
> stays in the archive until unpinned or restored, and no export-to-Brain seam
> exists.

What the person wants to be true. Each entry records the decision and the
confirmation that established it. Nothing here is inferred. Nothing here is a
transcript of their words standing in for agreement.

The first entry is the definition of Carto itself, because the old specification
was written by a model and the person found it built on assumptions about their
intent. This file exists so that does not happen again.

---

## 1. What Carto is

**Decision.** Carto is a durable agent with robust context gardening, ephemeral
context, and scoped tasking. It is lightweight, informative, and novel in a
useful way.

Atlas and Ledger are the Brain: they inform the agent of its own state in place
of memory, and represent its attention and focus. The Context section, engine,
and gardening tools are a full suite of context engineering and surgery on the
agent's own working context.

The agent does not know when changes happen to the world. It trusts its map of
the project and the things it has chosen to preserve.

**Established by.** Stated by the person in conversation, restated by the agent,
and used as the basis for every subsequent decision.

## 2. The agent owns its Brain

**Decision.** The agent modifies everything in its Brain without approval. The
Brain is its own garden. Gates, change requests, and permission restrictions on
Brain operations are assumptions by a model about the person's intent, not the
person's intent.

**Established by.** "the agent should be able to modify everything in its brain
without approval, that is its own garden" and "the stuff about gating everything
behind change requests and permissions, and restrictions are largely assumptions
by the model about my intent".

## 3. The agent does not see `.brain`

**Decision.** The agent does not read `.brain` directly. The reason is scoping,
not trust: direct access invites curiosity to fill the context with duplicated or
stale copies of the agent's own state.

**Established by.** The person named this as the deliberate case where their
trust of the agent scopes its capability, rather than a rule that must be
enforced against the agent.

## 4. Gates belong on project files, not on the Brain

**Decision.** The person wants a gate for destructive edits to project files, but
does not want it to be a permission queue. It should be gentle: designed so the
agent does not do bookkeeping, planning, or organising. The agent should have an
informed idea of the project and what the person wants, and delegate to itself a
boilerplate creation or one atomic step.

If the appetite constraint cannot be solved, the person's fallback is better than
a gate: a mode where the agent is instructed not to edit, the edit tool is
disabled, and the shell is still trusted.

**Established by.** The person described the goal and the fallback, and confirmed
the agent's reading that this is a capability boundary rather than an approval
state machine.

## 5. Deletion is real and unpoliced

**Decision.** Deleted text is really gone. Pi Durable's tendency to keep
permanent archives conflicts with the product: Carto is an ephemeral daemon.

Deleting a Brain record needs no approval and no reason. A deleted Brain record
does not enter the archive; the archive is for ephemeral material, and the agent's
deletion is a decision rather than an accident.

**Established by.** "yes, i want deleted text really gone, i know that pi-durable
tries to keep stuff in permanent archives, but this agent is an ephemeral daemon."

## 6. Ephemeral means the context, not the Brain

**Decision.** The Brain persists: Chat, Atlas, Ledger, pins, wakes, and the
things kept about the project. Everything else is ephemeral — tool work,
reasoning, read calls, the transcript.

> Amended 2026-11-20, by the person: wakes are scrapped; pins are markers on
> book entries, not a record type. The persisted set is Atlas, Ledger, Chat,
> with pins riding the entries.

The agent keeps what it needs by pinning and by writing to its books. It is
expected to lose the rest.

**Established by.** "the brain persists yes, that's the durable thing about it ...
but most of the context, the tool work, the reasoning, the read calls, etc are
ephemeral".

## 7. Two retentions, one archive

**Decision.** Brain records are sticky: they survive collapse by existing, and
only the agent's deletion moves them out. Ephemeral material is disposable: it
becomes the archive at collapse, and everything in the archive that is not pinned
there or recovered is deleted at the next collapse.

**Pin** means "keep it here" — in the Brain if it is there, in the archive if it
is there. **Recover** exists only for the archive and means "put it back in the
Brain". Recover does not pin; a pin is a separate action.

> Amended 2026-11-21, by the person: Brain records survive collapse by existing;
> the archive is Carto's own database (§50), swept item by item at collapse.
> Pinned archive items stay in the archive until unpinned or restored; pinned
> context items never fall to the archive. The person's pins ("user" author)
> and the agent's pins ("agent" author) coexist; the person may remove either,
> the agent only its own.

**The agent does not know the archive exists.**

**Established by.** The person confirmed the distinction directly: "yes, i think
that's the distinction, pin applied to either layer means 'pin it here' ... the
agent doesn't know the archive exists."

## 8. Collapse

**Decision.** The person or the agent can trigger collapse. No approval is
needed.

The person expects the agent will rarely trigger a collapse on its own, because
it does not want to forget. Knowing the person can collapse at any time is meant
to keep the agent's representation of intent, progress, and understanding current
in the Brain.

**Established by.** "the agent and the user can both trigger collapse" and the
reason given for it.

## 9. Friction teaches the agent to skip its memory

**Decision.** The agent should not be given limits on the size of Brain entries
that it can see and cannot measure. The observed failure: the agent knows the
character limit, overshoots, retries shorter, overshoots, and abandons the entry.
Friction on keeping the Brain causes the agent to route around the Brain
entirely. Forcing it to keep the Brain causes the opposite failure: it gets stuck
in the bureaucracy of bookkeeping.

The prompt asks for appropriate sizing. The runtime does not enforce limits the
agent must budget against.

**Established by.** The person described the observed behaviour and named the
balance as delicate.

## 10. The Brain is attention, not a cache

**Decision.** Atlas holds only what is in focus, informing the agent when
something has gone stale. Ledger entries are deleted when they no longer apply,
or when a more permanent Atlas entry would suffice.

The agent may store findings, thought processes, and anything else it finds
useful. The agent decides when a record has stopped earning its place.

**Established by.** "the heat of the atlas to keep only what's being focused on in
attention and inform the agent when something is stale, and deleting entries from
the ledger that no longer apply".

## 11. Only the transcript is a conversation

**Decision.** A Person message is already in the transcript. Its text is not
repeated in the projection. Agent Chat text reaches the model as a tool result
from the `chat` tool, not through the projection.

The projection carries structure, handles, and state.

**Established by.** The person was shown that the payload contained every Person
message twice, and chose the tool result over the projection.

## 12a. The state block is the continuation

**Decision.** There is no separate nudge and no "you are not done" text. The
agent executes the system prompt. The state block tells it where things stand,
and it decides what comes next: reason, call a tool, or sleep.

The old design had two mechanisms, a dashboard and a synthetic continuation. They
are one.

The block arrives as a user-role message because Pi only makes a new request when
the context ends in a user message or a tool result. Its identity comes from its
shape, described once in the system prompt, not from an announcement inside it.
Carto tags it so it never becomes Chat.

**Established by.** The person's answer that the state block is the continuation,
and the agent's report of the Pi constraint, which the person accepted.

## 12. The state block

**Decision.** The projection ends with a short state block. It tells the agent
what is stale in the Brain, the state of the context, and what is taking space,
broken down by Brain part and by tool calls, separately from the stable parts
such as the system and tool prompts.

It is the part of the context expected to change often. Its items carry
structured IDs.

**Established by.** The person proposed it and described its placement and
contents.

## 13. Timestamps stay

**Decision.** Every durable item's ID line carries an ISO 8601 UTC timestamp,
because the agent reads it to know when something changed.

**Established by.** The person confirmed the timestamp is mandatory for this
reason when asked whether it was an invented requirement.

## 12b. The present is all that matters

**Decision.** The core philosophy: a model only needs what it needs to act now.
Carto curates the context to be exactly that.

The state block is the last thing the model reads on every request. It is
information about the present, not a history. It is appended to every request and
removed from the context after use, so it exists only at the tail and never
accumulates.

It is purely informative and never instructive. It does not tell the agent to do
anything. Continuing the turn happens because the agent follows its system prompt
with accurate information.

**Established by.** The person named this the crux of the project and corrected
the agent for treating the block as a kept record.

## 12c. The system prompt is the core directive

**Decision.** The system prompt is the first thing the agent sees and the thing it
will follow as core instruction, combined with the person's instruction and the
context. It teaches the agent how to think and act: how to interpret its
environment, and how to use its tools well.

It guides the agent into the desired pattern of thinking rather than prohibiting
what it must not do. Because the curated context is short, the agent has little to
distract it from these directives, so they carry the weight that rules would
otherwise have to.

**Established by.** The person's agreement that instruction is better than
prohibition, and that the agent must know how to use its tools well.

## 13a. The agent is long-running and only stops by sleeping

**Decision.** The agent does not suffer context rot because it rarely reaches the
limit; it collapses before that. A run ends when a reply carries no tool call.
Only a deliberate `sleep` stops the agent.

`chat` is the tool through which the agent declares something user-facing. Plain
text is the agent's own reasoning and is not Chat. This is prompted and
emphasised so it is understood, not learned by trial and error, and it makes
reasoning genuinely ephemeral because it is part of the task context rather than
a record.

`sleep` takes a wake timer. It sleeps until that timer fires, indefinitely if
there is no timer, or until the person wakes it.

> Amended 2026-11-20 by the person: this decision is superseded — wakes are
> scrapped. `sleep` ends the run; nothing armed re-engages the agent but
> the person.

**Established by.** The person's description of the long-running design and the
observed main-branch behaviour.

## 14. Procedural, then one state flow

**Decision.** **B leading to A.** Named procedures over explicit records — modules
of functions that take what they need and return what they produce, with no
object owning state and exposing methods over it. Then a single
state → update → render flow, with effects collected at the boundary.

**Established by.** The person chose "B leading to A" when asked to choose
between two readings of procedural, after the agent identified that the current
code fuses a pure clamp with an effectful render in one function.

## 15. The tests are the acceptance criteria

**Decision.** Keep the existing tests if they do not force the old shape. Tests
that assert `MINI.md` behaviour are kept. Tests that assert an internal calling
convention are rewritten to assert the same behaviour through the new shape.

**Established by.** The person agreed on this condition.

## 16. The rebuild is a rebuild, in slices

**Decision.** The project is rebuilt from these fundamentals, in verifiable
slices that are pushed and tested one at a time, rather than one large rewrite.

**Established by.** The person asked for a rebuild from the fundamentals with the
dependencies used, and the agent proposed slices, which the person did not
contradict.

## 17. Pi storage is one store per generation

**Decision.** Pi storage is one store per generation. At collapse a fresh store
is created for the new generation. The previous generation's ephemeral material
is swept to the archive (Carto's own database, not the sealed store — §50) and
the old store is deleted whole once the archive no longer needs it. Transcript
text that a collapse deletes is removed rather than hidden.

> Amended 2026-11-21 by the person: the archive is Carto's own database, swept
> item by item at collapse; the sealed-store mechanism is superseded. See §50.

The Brain is separate from Pi storage and persists across generations. A live
session can always be rebuilt from the Brain alone, after a crash as well as at
a collapse. A crash during collapse cannot lose Brain state.

**Established by.** The person chose "a fresh store per generation" between the
two Pi storage options, and asked "we should be able to rebuild a session state
from the brain store if something happens, right?" — yes; that is the design,
and now a requirement on it.


## 18. The Brain's record set

**Decision.** The Brain holds Atlas, Ledger, Chat, pins, and wakes. Deleting a
Brain record is a single step; there is no pending-deletion state and no
two-step undo. `handoff` is dropped — the Ledger plus the sticky records are
sufficient to rebuild a session. `context` is not a Brain record. `activity` is
ephemeral; a restart does not recover what the agent was doing.

> Amended 2026-11-20 by the person: wakes are scrapped and pins are markers
> on book entries, not records — the record set is Atlas, Ledger, Chat, with
> pins riding the entries. A pin carries no reason, no source: it is a marker
> on the entry it marks.

**Established by.** The person answered the four record-set questions directly:
the proposed set ("chat, atlas, ledger, pins, wakes"), single-step delete
("delete means delete"), handoff dropped entirely, activity ephemeral.
The wakes and pins halves of this set were re-scoped 2026-11-20 — see the
amendment above. The
deletion-mark item picked as part of the proposal is abolished by the
single-step answer; derived and flagged in `docs/open-questions.md` §2.


## 19. The projection is frozen between collapses

**Decision.** The projection is rebuilt only at collapse. Between collapses it is
never patched: a Brain write appears as the write tool's result and as a
pending-change line in the state block, not as a projection edit. This keeps the
prefix stable between collapses and makes the pending list the signal to
collapse.

Order is not a requirement after the freeze, and timestamps stay on the record's
ID line — both fall out of the freeze rather than needing their own decisions.

**Established by.** The person confirmed the frozen projection directly when
asked, after it was pointed out that an unfrozen projection costs a prefix
invalidation per Brain write and empties the pending list of meaning.


## 20. The state block is injected; the transcript holds markers

**Decision.** The state block is not persisted as a message. On every request
`beforeProviderRequest` removes any state-block marker from the payload and
appends the freshly rendered block as a trailing user-role message. After a
text-only reply, `onYield` continues the run with a byte-sized marker user
message, which the injection then replaces. The model always sees exactly one
current block at the tail; the Pi store accumulates only markers, and they die
with the generation's store at collapse.

**Established by.** The person approved this derived shape when told that
`onYield` can only append a user message and prompt sections can only patch the
leading system message — so the block cannot itself start a turn, and the
continuation rides a marker while the block is injected per request.


## 21. The state block contents

**Decision.** The block holds: the state of the context (fullness from the last
reported provider usage, plus what tool calls have added since); space taken up,
broken down by Brain part — Ledger, Atlas, Chat — separately from tool work and
from the stable system and tool prompts; one line per pending Brain write since
the projection was rebuilt, named by handle; what is stale, named by handle;
and the project tree, anchored at a directory to a depth, with Atlas-linked
files marked. Nothing instructive.

> Amended 2026-11-20 by the person: wakes are scrapped (the armed-wakes line is
> gone) and pins are markers on book entries, not a Brain part — the space
> breakdown covers Atlas, Ledger, Chat, and renders [pinned] inline on the
> entries they mark.

**Established by.** The person approved this list when shown it, in full.

## 22. The prompt starts minimal

**Decision.** The system prompt starts minimalistic: the tools, what they do,
and how to use them, plus what no tool can say — then it is iterated on. The
tools are scoped and unique; they carry the voice. The elaborate draft in
`docs/prompt-draft.md` is reference material, not the starting point.

**Established by.** The person directed it: "i say we try for minimalistic at
first, just, here are your tools, here's what they do and how to use them. and
then we iterate on that."


## 23. Attention is a consequence of minimality, not a metric

**Decision.** Carto has no attention score, heat counter, or decay system. A
model is steered by everything in its context, and Carto's context is
deliberately pruned, so every remaining item steers harder. Focus is what
happens when the Brain is well maintained. The staleness instruments are
evidence freshness, the pending list, and the state block's stale lines. Raw
signals at rebuild (age, in-degree, freshness) may be shown as information;
they are never reduced to a score and never delete anything by themselves.

**Established by.** "to a model, everything in its context is steering,
especially with a harness such as carto, where its context is deliberately
pruned ... the focus of it is a consequence because the context is so minimal.
the agent stays informed and focused because it keeps its brain well
maintained."

## 24. The Atlas is the map layer over the tree

**Decision.** The Atlas serves two purposes: it lends the project tree its
leaves — marking files and directories the agent understands rather than a
bare listing — and it maps meaningful structure, connecting what the agent
understands into a graph. The tree is the scaffold; the Atlas is the
understanding hung on it.

**Established by.** "so the atlas serves the dual purpose of giving the tree
leaves ... and of mapping out meaningful structure."


## 25. Atlas edges are optional and typed

**Decision.** Atlas nodes may link to other Atlas nodes with one of three edge
types: `replaces` (this supersedes that), `depends-on` (this rests on that), and
`contradicts` (symmetric; the two cannot both hold). No node is required to be
connected to anything. Nodes and sub-graphs may float unconnected to the rest of
the Atlas and to the tree. The Atlas and the other tools are permissive and
easy to use; the graph's value comes from the agent tending it, not from
structural validation.

**Established by.** The person agreed to the small typed edge set and directed:
"we should not require a node to be connected to another node, so an edge is not
always required, we want the atlas (and the other tools) to be permissive and
easy to use, so a node or cluster can exist unconnected."


## 26. The tree anchor is a dedicated `tree` tool

**Decision.** The project tree's anchor and depth are moved by a dedicated,
scoped `tree` tool that returns the rendered tree — an explicit act of
attention, not a side effect of reading. The tool surface is: chat, atlas,
ledger, pin, inspect, edit, shell, tree, sleep.

> Amended 2026-11-20 by the person: wakes are scrapped — the deferred wake
> tool is dropped with everything else.

**Established by.** The person chose "yes, dedicated tool" when asked to choose
between a dedicated tool, `inspect` re-anchoring implicitly, and `shell`
emulating it.


## 27. No ceiling on pending changes; the user's work comes first

**Decision.** Nothing mechanically caps the pending list or forces a collapse.
The agent executes the user's work first; it keeps the Brain in between and
during tasks. The less there is to do in a project, the more imperative keeping
the Brain is. The growing pending list and the fullness number are the
pressure; the person collapsing at any time is the backstop.

**Established by.** "correct. the less things there are to do in a project, the
more keeping the brain will be imperative, they execute user tasks first, and
keep the brain in between and during."

## 28. Digest drift is a gentle signal

**Decision.** An Atlas claim whose evidence file's digest has changed since the
claim was written is marked stale at rebuild. It gently informs the agent to
update its Brain; it blocks nothing and deletes nothing.

**Established by.** "i think so? it gebtly informs the agent to update its
brain."


## 29. The archive is the sealed previous generation's store

**Decision.** At collapse the previous generation's Pi store is sealed
read-only and becomes the archive; the new generation gets a fresh store. No
copy and no export is written at collapse. Recovery opens the sealed store
read-only; the agent cannot read it and does not know it exists. Pin markers
for the archive live in the Brain; at the next collapse the purge first
exports pinned-to-archive records into the Brain, flushes, and only then
deletes the sealed store. Unpinned material leaves with the file. The Brain
grows only by what is explicitly kept.

> **Superseded 2026-11-21 by the person.** The sealed-store archive is no longer
> the archive's shape: the archive is Carto's own database, swept item by item
> at collapse (pinned ephemera and archive-marked brain entries), deleted
> whole-store at purge. See §50 for the re-scope.

**Established by.** Blessed by the person: 'Blessed.'


## 30. Recovery restores the original type; the agent cannot address the archive

**Decision.** A recovered record returns as its original type (Atlas to Atlas,
Ledger to Ledger, Chat to Chat), and evidence that no longer verifies is
marked stale — the state block's stale line informs the agent. The agent has
no tool, command, or signal for the archive; giving it one breaks the
boundary that the archive exists.

**Established by.** The person confirmed both halves directly: "yes, restore the
original type, let the state block inform the agent of stale data" and "no it
doesn't even know the archive exists, giving it a tool breaks intent."


## 31. Collapse signalling

**Decision.** The system prompt carries one line: the person may collapse the
context at any time, and a collapse rebuilds the agent's context from the
Brain. A standing fact, not mutable state; consequence, not threat. A
person-triggered collapse gets no boundary and no warning; afterwards the
person sees a plain report of what collapsed, not a confirmation.

**Established by.** The person confirmed both halves directly: "5.1 yes agreed"
and "5.2 yes confirmed."


## 32. The agent collapses through a dedicated `collapse` tool

**Decision.** The agent can trigger collapse through a dedicated, scoped
`collapse` tool. The person triggers collapse from the workspace. Cancelled
or not, no approval is involved in either path.

**Established by.** The person agreed when asked how the agent triggers
collapse, against the alternative of dropping the agent's trigger.

## 33. Turn control keeps three verbs

**Decision.** Three delivery modes survive: Interrupt (the person stops the
run at a Pi Durable boundary), Steer (a message queued at the next boundary;
the agent just sees it arrive), Follow-up (a message queued for after the
run). Pause, edit-draft, and resume are removed with the approval-era draft —
the agent's output already lives in Chat and the Ledger. Cancel is interrupt
plus dropping the queue.

**Established by.** The person confirmed: "confirmed."

## 34. The state block's details, confirmed

**Decision.** The state block's items reuse the Brain's generation-local
handles; there is no separate ID scheme. The pending list — one line per
pending Brain write since the projection was rebuilt, named by handle — is
ephemeral: it lives in session memory and starts empty after a crash, like
activity itself. The frozen projection persists as a per-generation snapshot
file under `.brain/context/`, written once when the generation is created,
immutable until the generation is purged; a crash reopens the identical
bytes. Slice two carries the full set of §21 contents, including the project
tree, rendered at the project root at a small fixed depth until slice three's
`tree` tool exists.

**Established by.** The person, answering the four questions asked before
slice two began: "reuse the Brain handles", "ephemeral is fine", "per-generation
snapshot file", "everything in the continuation-loop slice".

## 35. The archive carries no deletion marks

**Decision.** The archive is the sealed previous generation's store, and it
is opened sealed. `deletionMarks` — the pending-at-collapse set of records
awaited purge — is dropped. Deletion is one step, as decided in §18; the
mark had no function left. No extra legacy machinery is carried unless the
project needs it.

**Established by.** The person, reviewing the Q2.5 derivation: "i think you
determined deletionmarks was vestigial? ... that doesn't sound useful?"

## 36. Small atomic edits are a prompt matter, not a tool limit

**Decision.** "Only wants small atomic edits" is taught by prompting. The
edit tool does not express atomicity structurally; no size, count, or shape
limit is enforced in the tool.

**Established by.** The person, directly and explicitly: "prompt only, i
stated this explicitly earlier too".

## 37. Wakes are the sleep tool's wake

**Superseded 2026-11-20 by the person: wakes are scrapped.** The sleep-tool
wake, the timer wake, the folder wake, and the path wake are all gone; the
agent sleeps and ends its run; the person is the only thing that re-engages
it. The decision as established:

**Decision.** The only wake is the `sleep` tool's. A `sleep` without a time
option wakes when the person wakes it; a `sleep` with a timer wakes when the
timer is up. No other wake machinery is needed — no folder wake, no project
path wake. MINI.md §10's second wake path and the bounds question (§11 of
docs/open-questions.md) are dropped with it.

**Established by.** The person, in one line and the timer semantics stated
with it in the same message: "wakes = only the sleep tool".

## 38. Context edits are edits to the source of truth — never an overlay

**Decision.** In the workspace's Context view, the person's actions are real
edits to the underlying truth, not a private annotation layer. Brain-backed
content is edited in the Brain, and the edit is everywhere the record
appears: the record, the state block's pending-changes line, the next
collapse. Ephemeral parts — tool calls, reasoning, the state block — never
reach the Brain by themselves; only what is intentionally kept becomes part
of it. Collapse is what makes staged changes part of what the model sees.
Applying immediately ("Now") forces a prefill, and the person takes it
knowing the cost. An earlier proposal of an ephemeral per-generation overlay
("surgery changes what the model sees, never what the Brain remembers") was
rejected by the person explicitly and is not to be built.

**Established by.** The person, objecting to the overlay design: edits must
be what happens everywhere — "what the model sees, the record, EVERYWHERE";
"Collapse is how we make those changes. what we do to the brain before that
is a queue on what's about to happen at collapse, unless we specifically
perform an action Now."

## 39. The token bar renders candidate A

**Decision.** The R5 token bar is the single-row design segmented by context
part (colour per part, hatched/muted estimate fill versus solid measured
fill, `┊` budget tick, right-aligned numbers). Candidate B (bar plus a
breakdown line) is rejected; the per-part detail lives in the Context view's
rail.

**Established by.** The person, one word: "token bar: A".

## 40. Posting's philosophy and structure are the UI's reference

**Decision.** R5 is designed after the Posting source: keyboard-first
dense screen, jump mode, context-sensitive footer, summoned command palette,
semantic colour tokens. pi-tui first wherever it does what is wanted;
hand-rolled the minimum for Posting-level elegance (disclosure folds, the
bar, the parts rail); nothing else without the person's word.

**Established by.** The person, confirming the R5 design direction:
"posting philosophy confirmed".

## 41. The person tests Carto; testing gates nothing

**Decision.** The person tests Carto at their own pace and reports issues as
they come across them. No slice is gated on the person's testing; it is not
a condition for building, pushing, or moving on, and it is not to be raised
to the person again. Issues reported by the person are fixed as reported.

**Established by.** The person, directly: "i will test carto thoroughly and
report any issues as i come across them."

## 42. Now is a one-shot modifier on the next action — nothing else

**Decision.** Now arms a single-action modifier on the next action the
person takes on the context: that action applies to the model's view
immediately, every other queued change stays queued. Now is not an
apply-all, not a rebuild shortcut, and not collapse — `/collapse` is the
spec's separate call and is not mixed into Now. There is no confirmation
or prefill warning in the UI; taking Now is the acknowledgment.
(The README this entry once pointed at was created unasked and deleted at
the person's direction; the cost remains undocumented by choice — see §45.) Reorder follows the same rule as every
other action: applied at collapse, or immediately with Now armed — there
is no per-reorder prefill penalty by default.

**Established by.** The person, directly: "Now applies *this* action
immediately, without applying the other things queued to change. it is a
modifier on the Next action the user takes on the context." And: "if i had
12 changes queued in the context, and i wanted to Delete one item Now, and
then all 12 changes also happened immediately, i would be furious."

## 43. Person-created records are authentic, indistinguishable, and of any type

**Decision.** The person can create, edit, delete, and reorder records of
every type the Brain knows — atlas, ledger, chat — from the
workspace.

> Amended 2026-11-20 by the person: wakes are scrapped and pins are markers
> on book entries, not records — the set is atlas, ledger, chat, with
> pins riding the entries.
>
> Amended 2026-11-21, by the person: a pin records its author — "user" or "agent"
> — and nothing else. The person may remove any pin from any view; the agent may
> remove only its own pins. What is created is authentic and standard: identical in every
respect to an agent-created record. The agent does not know the
difference, and does not know that the person created, deleted, or moved
anything at all. This is previously stated intent, not a new decision; it
is recorded here so it is not re-asked.

**Established by.** The person, directly: "it should become what ever type
of entry you make. the user can make all types of entry the brain knows
how to store, such as atlas, ledger, chat, etc. it is not distinct at all,
it exists as authentic and standard as anything else in the brain, the
agent doesn't know the difference or even that the user put it there- or
deleted or moved anything for that matter. This is also previously stated
intent, and i should not have to repeat myself about it."

## 44. The workspace renders modes, not tabs

**Decision.** R5 renders modes (Chat / Context / Brain) reachable by keys
and the command palette, Posting-style. MINI.md §8's three-tab frame is not
carried into the build.

**Established by.** The person, one line: "modes, as you proposed."

## 45. No prefill warning about Now — ever; the acknowledgment is the action

**Decision.** Now carries no confirmation or warning dialog. The earlier
statement "it is documented in the README" referenced a document that does
not exist on this branch; a README was created unasked in response and
deleted at the person's direction on 2026-11-20. The standing rule is:
no in-UI warning, and the workspace does not grow documents to justify
an action the person took knowingly. The person takes Now by choice;
that choice is the acknowledgment.

**Established by.** The person, directly: "there is no prefill warning
about Now, it is documented in the README" — and, on discovering the
unasked-for README: "delete that. i didn't need or want it. and quit
making and doing stuff i didn't ask for."

## 46. How the person's words are to be heard: question, assumption, statement, request

**Decision.** Four kinds of utterance, exhaustive:

1. **Question** — a request for information, nothing else, ever. A question is
   never a request to create or change anything. Asked *why*, the answer is an
   explanation, not work.
2. **Assumption** — something the person asserts that may be wrong. It may be
   verified; the person learns from being told plainly that they are wrong.
   Verification never licenses changing something they did not ask to change.
3. **Statement** — something said to put it in the shared context. It asks for
   nothing and wants no acknowledgement of intent.
4. **Request / Task** — the remainder. Only this, or a §8 decision request,
   licenses work.

**Established by.** The person, directly, after the README was created unasked:
asks for a definition of the difference between the four, and confirms the
exhaustiveness of the split. Recorded verbatim in meaning; see `AGENTS.md` §3
(QUESTION, ASSUMPTION, STATEMENT, REQUEST) and §8.

## 47. Interrupt stops the run NOW

**Decision.** Interrupt (`ctrl+x`) stops the run immediately — not at a Pi
Durable boundary, not "politely." This was the person's stated intent in the
main branch, the previous MINI build, and this build. While the stream is
interrupted, the input box remains usable: messages can be sent as steering
(without breaking the stream) or as follow-ups (queued for after the run), or
submitted immediately — which breaks the stream. The selection mechanism on the
input line was delegated to the agent ("your choice, don't ask me about it"):
`shift+tab` cycles the armed send mode — steer → after run → now — shown in
the footer; `enter` sends in the armed mode. This supersedes MINI.md §9's
"stops the run at a Pi Durable boundary"; MINI.md is never edited, so the
supersession lives here and in `docs/open-questions.md` §10.

**Established by.** The person, directly: "Interrupt means interrupt, it
doesn't mean politely ask for a moment when the agent is done doing what it's
doing. this is not an ambiguous definition in any sense of the english
language. while the stream is interrupted, the user can type in their input
box, send steering, or followups without breaking the stream, but they can
also submit their message Immediately and break the stream."

## 48. Keybindings are vim-first

**Decision.** Where vim motions and keybinds apply, they are used instead of
Posting's. Where vim does not cover it, Posting's keys apply. Where neither
covers it, the agent decides the binding, and the person gives feedback.
Jump mode (Posting) is retained as designed — vim has no equivalent.

**Established by.** The person, directly: "i want vim motions and keybinds
where applicable, instead of postings. if vim motions doesn't cover it,
posting makes sense, and if not then, you will decide the keybind for it and
i will give feedback."

## 49. The sidebar is visible on boot; the boot view is Chat

**Decision.** The workspace boots with the sidebar (the Brain index) visible,
toggleable with `ctrl+h`, and with Chat as the main view.

**Established by.** The person, answering the two open marks: "1. A" and
"2. A".

## 50. The archive is Carto's own database, swept item by item

**Decision, 2026-11-21 (re-scope).** The archive is not a sealed generation's
store and is not required by pi-durable or its immutable storage — verified
that pi-durable provides no deletion primitive (reset hides the context; entries
stay in storage by construction) and no archive concept at all. Carto builds the
archive itself, as its own database, under `.brain/`.

The confirmed shape of the archive model:

- Brain records never archive on their own; the person or the agent may mark a
  Brain record for archive, and it sweeps to the archive on the next collapse
  (marking is like a pin, backwards: it does not stay in context, it is also not
  deleted).
- Ephemeral content (tool calls, reasoning, non-chat text output, read calls)
  sweeps automatically into the archive at collapse, unless pinned.
- Pinned items in the archive remain in the archive until unpinned or restored
  to the context. Items in the archive that are not pinned — swept ephemeral
  files and brain entries marked for archive — are deleted for good after one
  collapse of grace.
- The prefill window, in order — the person's worked-through layout: system
  prompt → tool definition/schema → atlas entries → ledger entries → chat
  entries → pinned files → pinned ephemera → regular ephemera → uncollapsed
  brain entries → regular ephemera → state block. Brain entries are clustered
  by type near the head; pinned content sits near the head so the prefix stays
  stable across collapses and collapse does not cost prefill; new/stale entries
  are listed in the state block; the state block is always at the tail.
- A separate delete button permanently deletes an entry without going to the
  archive (it costs a prefill — the tail is cut — which is acceptable).
- Entries on the archive layer can be restored. Only the user knows the archive
  layer exists; only the user can do anything with it.

The unresolved seams are recorded in `docs/open-questions.md` §15 (proposed, not
confirmed): what pinned files and pinned ephemera are (and where pinned
ephemeral content lives after collapse), archive-marked brain entry semantics,
the frozen head's structure (whether the projection grows to the full head, and
what "uncollapsed brain entries" means), the recovery UI, and the
per-generation-store lifecycle. (Deletion timing is confirmed — one collapse of
grace — and is not open.)

**Established by.** The person, across the conversation this session: "i think
we might need to change how the archive works fundamentally... the archive is
a consequence of us using pi-durable and it having an immutable store. we
have to use our own system so that we can really delete stuff from our
context..." and the worked-through layout "system prompt / tool definition/schema
/ atlas entries / ledger entries / chat entries / pinned files / pinned
ephemera / regular ephemera / uncollapsed brain entries / regular ephemera /
state block", with the new/top-of-file intent restatement "brain entries never
archive on their own, but they can be marked by the user or agent for
archival... all other ephemeral content... gets swept automatically into the
archive at every collapse, unless pinned... Pinned items in the archive remain
in the archive unless they're unpinned or restored to the context. items in the
archive that have not been pinned are deleted for good... yes, entries on the
archive layer can be restored. only the user knows the archive layer exists."
