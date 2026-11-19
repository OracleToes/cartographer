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

**Decision.** The Brain persists: Chat, Atlas, Ledger, pins, handoff, and the
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
