# Open questions, assumptions, and untouched taste

Everything the rewrite touched and could not settle. Grouped by what it would
take to close it. Each entry says what is wrong, why it matters, and what the
person would need to decide.

This file is the agenda for the next discussion session. It is ordered so that
earlier entries constrain later ones.

---

## §1. Reading discipline (settle first, it changes every answer)

**Q1.1 — Should Carto be this large?** The person asked for "an elegant rebuild
of the main branch's core features". The old specification was 467 lines of
mechanism. The rewrite above is shorter, but if elegance means fewer mechanisms
rather than better ones, more of it should go. *Needs:* whether "lightweight"
caps the feature count, or only the implementation weight.

**Q1.2 — Is novelty a requirement or a description?** The person said Carto is
"novel in a useful way". Read as a requirement, every design must be
unfamiliar-but-useful. Read as a description, novelty is allowed and not
demanded. *Needs:* which.

## §2. The Brain's record set

**Q2.1 — What remains after removing `changes`?** The old Brain held `chat`,
`ledger`, `atlas`, `userPins`, `carryPins`, `handoff`, `wakes`, `changes`,
`deletionMarks`, `context`, `activity`. Removing change requests removes
`changes` and the `/approve` and `/reject` commands. *Needs confirmation of the
remaining set.*

**Q2.2 — Do deletion marks survive?** If the agent deletes without approval, a
deletion mark only earns its place as an undo that the person can see. The old
spec had `d` mark and `D` delete now. With no confirmation, is a two-step delete
still wanted? *Needs:* yes, as undo; or no, one delete action.

**Q2.3 — Is `handoff` still needed?** It existed to bridge a collapse. With the
agent tending its own Brain, a handoff competes with the Ledger for the same job.
*Needs:* whether it is a distinct record or a Ledger kind.

**Q2.4 — Does activity belong in the Brain?** `activity: {idle}` is durable
state about an ephemeral fact. *Needs:* whether a restart should recover what the
agent was doing.

## §3. Pi Durable immutability versus real deletion

**Q3.1 — Pi Durable transcript entries are immutable.** This is an observable
fact in the dependency, not a guess. The old spec's workaround was to keep old
transcripts as an archive generation and purge the previous one at the next
collapse. If deleted text must really be gone, a transcript that Pi never deletes
is a problem however the archive is arranged.

Options:
- accept that the Pi store retains what Carto has forgotten, and rely on
  secure-delete and `VACUUM` being best-effort;
- give each generation its own Pi store and delete the whole store at collapse,
  rather than relying on row deletion inside a retained database;
- both.

*Needs:* a decision, because option two changes how generations are stored.

**Q3.2 — Does collapse create a new Pi store or reuse one?** Related to Q3.1.
The old spec reused one database and reset it. Deleting a file is a stronger
guarantee than deleting rows.

## §4. Recover

**Q4.1 — What does recovery restore?** A recovered record must return to some
type. Options: its original type, a neutral "recovered note" type the agent then
files, or a conversation item. *Needs:* which.

**Q4.2 — Can the agent ask for a recovery?** The agent does not know the archive
exists, so it cannot. But it can notice something missing and ask the person. Does
it get a way to say "I think something was lost"? *Needs:* whether that is a tool,
a Ledger question, or nothing.

## §5. Collapse signalling

**Q5.1 — Does the agent know a collapse can happen at any time?** The person
hopes it will keep its Brain current if it knows. That requires the agent to be
told, in the state block or the instructions. *Needs:* whether it is told, and
how bluntly.

**Q5.2 — Warning before a person-triggered collapse?** The old spec had a
confirmation. Removing it means a person can collapse mid-work. *Needs:* whether
the agent needs a boundary to finish first, and whether the person should see what
will be lost.

## §6. Projection order and timestamps

**Q6.1 — Is structural order a requirement at all?** The old spec mandated
Ledger → Chat → Atlas → pins → Handoff → active. That order is what put volatile
Chat at the front of the prompt. With Chat text out of the projection, order is
mostly a caching concern, but the person has not said whether they want a
required order. *Needs:* required order, or "stable first, volatile last".

**Q6.2 — Where does the timestamp go?** Confirmed that it stays. Open: on the
record's ID line, which shifts whenever anything above it changes, or in the
state block, which is already the volatile part. *Needs:* which.

**Q6.3 — Does an edited record move?** The old spec said editing a Ledger entry
does not move it. *Needs:* confirm this is still wanted, since it affects cache
stability.

## §7. The state block

**Q7.0 — How is the block removed after the request?** Settled that the block is
appended to every request and is not kept. Open: the mechanism.

`beforeProviderRequest` replaces the provider body for that request only, so the
block could be injected there and never touch the transcript — but that hook
cannot *start* a run, and a run needs a context ending in a user message or tool
result. `onYield` can start one but appends a persisted message.

Possible shapes:
- persistent user message, trimmed from the payload on later requests by
  `beforeProviderRequest`, so the store keeps it and the model never sees two;
- a persisted message carrying a marker, excluded when the next request is built;
- something else, if Pi has a way to append an entry that is not part of the
  context.

*Needs:* a decision on the mechanism before the context layer is built.

### The block's schema

**Q7.1 — What fields?** Confirmed contents: staleness, context state, and a
space breakdown by Brain part and tool calls. *Needs:* the actual field list.

**Q7.2 — What is the structured ID scheme?** "Items given structured IDs" is
unwritten. *Needs:* a scheme, and whether it is the same handle system as the
Brain or separate.

**Q7.3 — Does the state block cost context?** It is at the end, so it is cheap to
change. But it is still tokens on every request. *Needs:* whether it is always
present or only when something is stale.

## §7b. Prompt editing in the TUI

**Deferred by the person.** Do not build this now. The person's reason: prompt
text benefits from programmatic insertions and other things that are not
human-readable, and the core of the project matters more than an editor for the
prompt. Editing is to be added later as a manipulation on whatever works.

What is known and should not be lost:
- The person wants to be able to edit the prompt in the TUI, including the tool
  descriptions, which are part of the prompt's voice.
- The old tree hardcoded the prompt with a comment saying prompt wording is
  source code with no runtime customization. That is an assumption, not intent.
- The old prompt (`origin/main:src/prompt.mjs`) is 265 lines in nineteen named
  sections — `one-mind`, `dyad`, `roles`, `talking`, `taste`, `plan`, `dispatch`,
  `goals`, `ledger`, `atlas`, `assessment`, `running`, `context`, `duty`, `sleep`,
  `state`, `code`, `consult` — written in first person as the agent talking to
  itself. It is the closest thing to the desired voice that exists anywhere.
- Open: one file or several; whether the shipped prompt is a coalescing default
  or created once and owned; and whether schemas stay in code while descriptions
  move to text.

## §7c. The system prompt draft

`docs/prompt-draft.md` is a first draft. It is a proposal, not intent, and the
person has not reviewed it.

Open in it:
- **Q7c.1 — Is the pronoun split right in practice?** "We" for the work, "I" for
  the agent's own uncertainty. The draft uses "I trust nothing I have not read"
  and "we make small changes". Whether that reads as one voice or two is a judgement
  about the prose, not the rule.
- **Q7c.2 — Resolved.** The tool descriptions are the authority. The system
  prompt does not repeat what a tool does; it carries only what no single
  description can say.
- **Q7c.3 — How is "small atomic changes" taught?** The `working` section
  currently asserts it and gives a self-check ("when we notice ourselves
  organising..."). Open: whether that is enough to change behaviour, since the
  person suspects prompting is the lever but has not seen it work.
- **Q7c.4 — Resolved.** The agent is called Carto.
- **Q7c.5 — Length.** The draft is roughly 900 words. The old prompt was longer,
  but carried a larger product. Open: whether this is the right size.

## §8. The edit boundary and the appetite constraint

**Q8.1 — How does "only wants small atomic edits" get enforced or encouraged?**
The person suspects better prompting fixes it and is unsure whether prompting is
enough. The old spec had no mechanism for this at all. *Needs:* whether this is
prompt-only, or whether the edit tool can express atomicity structurally.

**Q8.2 — What is the fallback mode called, and how is it entered?** The person
described "instructed not to edit, edit tool disabled, shell trusted". *Needs:*
whether it is a user-set mode, an agent-selected mode, or both.

**Q8.3 — Can the agent propose an edit without making it?** Removing the approval
queue removes the mechanism, but the person may still want the agent to *show* a
diff before applying it. *Needs:* whether visibility-at-time-of-edit replaces
approval.

**Q8.4 — What counts as destructive?** Overwrite, delete, and large patches are
the obvious cases. Is appending destructive? Is creating a file? *Needs:* a
definition if the capability gate depends on it.

## §9. The token bar

**Q9.1 — Where do the measured numbers come from?** The old spec asserted a
`prompt_progress` payload with `{total, cache, processed}`. This was never
verified against a provider and may be invented. *Needs:* whether the person's
server actually reports progress, and in what shape.

**Q9.2 — If it is invented, what replaces it?** The confirmed truth is the
`beforeProviderRequest` payload plus provider `Usage`. That gives exact numbers
after a request but no live progress during one. *Needs:* whether a bar without
live progress is acceptable, or whether progress must come from somewhere else.

## §10. Turn control

**Q10.1 — Does any of it survive the gate removal?** Pause, edit-draft, resume,
cancel, Interruption, Steer, Follow-up were written for a product with an approval
mindset. *Needs:* which are still wanted.

**Q10.2 — What does the agent do with a steer?** It queues at a Pi Durable
boundary. *Needs:* confirmation, and whether the agent is told a steer is waiting.

## §11. Wake and sleep

**Q11.1 — Are wakes still in scope for the first rebuild?** They are a named
product part but the largest piece of durable task machinery.

**Q11.2 — What are the bounds?** The old spec said a folder wake checks direct
entries and has a 10,000-entry limit. That number looks invented. *Needs:* a real
bound, or "bounds are the runtime's problem".

## §12. The workspace, unchanged but unverified

**Q12.1 — The three tabs.** Chat, Brain, Context. The person has not contradicted
them. *Needs:* confirmation that the tab split is still right now that Brain has
fewer record types.

**Q12.2 — Five-row disclosure.** `MINI.md` said "every long live item has an
independent five-row newest-text disclosure window", and the code defaults to
`rows = 5`. Nothing requires five. *Needs:* whether a fixed number is wanted, or
"enough to read, expandable".

**Q12.3 — The footer hint set.** The old spec enumerated hints per mode. They
depend on keys that may no longer exist.

## §13. Small things that are probably assumptions

**Q13.1 — `collapseMode` configuration.** With no approval, the setting has no
meaning. Removed from the rewrite. *Needs:* acknowledgement that it is gone.

**Q13.2 — The `10,000-entry` folder wake limit.** Unverified number.

**Q13.3 — `1.4k tok/s`, `reading 64%`, `· 12s` in the status row.** These imply a
live token-rate measurement. Unverified, same problem as §9.

**Q13.4 — `history: "latest"` for the Brain.** This is a Pi document option. It
matches "current state, not audit history", but it has not been checked that Pi
supports it for this document type in this version. *Needs:* a check before it is
relied on.

**Q13.5 — Atlas evidence digests.** The old spec made a changed digest mark a
record stale. That mechanism was not questioned and is probably right, but it was
also never confirmed. *Needs:* confirmation.

## §14. Matters of taste, low stakes

**Q14.1 — Glyphs.** `▤` estimate versus `▰` confirmed, `┊` for the budget mark.
The person locked these earlier. *Needs:* confirm they survive the rewrite.

**Q14.2 — Colour roles.** Muted, accent, warning were named in code. *Needs:*
nothing unless the person contradicts them.

**Q14.3 — Tab order.** Chat, Brain, Context. *Needs:* confirmation only.

---

## How this was produced

The rewrite of `MINI.md` was mechanical about what to keep. A line stayed only if
one of these held:

1. the person stated it in this conversation;
2. the person confirmed it when the agent restated it;
3. it is an observable fact about a dependency, verifiable in `node_modules`;
4. it was in the old specification, was not challenged, and is marked open here.

Anything else was removed and appears in this file. Nothing was removed silently.
