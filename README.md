# Carto

Carto is a person↔agent pair programmer that stays scoped to the task you
hand it: a dyadic working relationship, not a sovereign agent. The agent
plans, reads, edits, and records; you watch it work, steer it, and keep the
books — Atlas (source-backed claims), Ledger (the working book), Chat
(what it says to you), pins, and wakes. The books live in the Brain, which
is sticky by default: only what you or the agent intentionally add becomes
part of it. Ephemeral work — tool calls, reasoning, the state block — never
enters the Brain on its own.

Carto is in active rebuild. `MINI.md` is the specification. `docs/intent.md`
is the ledger of decisions and who made them. `docs/tests.md` and
`AGENTS.md` describe the push discipline. `docs/ui-proposal.md` describes
the workspace UI.

## The cost of Now

Context edits — deleting, editing, reordering, inserting — do not reach the
model's window when you make them. They take effect when the context is
rebuilt: at collapse (`/collapse`, the spec's own call, also available from
the workspace). Before that, they are simply changes in the Brain, and the
state block's pending-changes line lists what moved since the last rebuild.

**Now is a modifier on the next action only.** Arming Now and deleting one
item applies that deletion immediately; every other queued change stays
queued. It is not an apply-all and it is not collapse. There is no warning
or confirmation — taking Now *is* the acknowledgment. The cost is a rebuilt
payload and the prefill it forces for the affected span of context.

Worked example: twelve changes queued, Now-armed delete of one item →
that item is gone from what the model reads immediately; the other eleven
apply at the next collapse.

## Deletions

Delete means delete. There is no pending deletion state and no undo.
Records you delete are gone; the projection rebuilt at the next collapse
simply will not contain them.

## Person-authored records

You can create, edit, delete, or reorder records of every type the Brain
knows — Atlas node, Ledger entry, Chat line, pin, wake. A person-created
record is authentic and indistinguishable: the agent does not know the
difference between your records and its own, and does not know that you
created, deleted, or moved anything at all.
