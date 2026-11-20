# Confirmed intent

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
is created for the new generation. The previous generation's material is kept as
the archive for one collapse and deleted at the next collapse. Transcript text
that a collapse deletes is removed rather than hidden.

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

**Established by.** The person answered the four record-set questions directly:
the proposed set ("chat, atlas, ledger, pins, wakes"), single-step delete
("delete means delete"), handoff dropped entirely, activity ephemeral. The
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
broken down by Brain part — Ledger, Atlas, Chat, pins, wakes — separately from
tool work and from the stable system and tool prompts; one line per pending
Brain write since the projection was rebuilt, named by handle; what is stale,
named by handle; wakes armed and their target times; and the project tree,
anchored at a directory to a depth, with Atlas-linked files marked. Nothing
instructive.

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
ledger, pin, inspect, edit, shell, tree, sleep. Wake is deferred.

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
