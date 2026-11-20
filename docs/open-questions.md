# Open questions, assumptions, and untouched taste

Everything the rewrite touched and could not settle. Grouped by what it would
take to close it. Each entry says what is wrong, why it matters, and what the
person would need to decide.

This file is the agenda for the next discussion session. It is ordered so that
earlier entries constrain later ones.

---

## §1. Reading discipline (settle first, it changes every answer)

**Q1.1 — Should Carto be this large?** *Resolved 2026-11-20:* decided per
mechanism — each mechanism must justify itself in review, or it is flagged
for removal. Elegance is neither a feature count nor an implementation weight;
it is a per-mechanism justification.

**Q1.2 — Is novelty a requirement or a description?** *Resolved 2026-11-20:*
a description. Novelty is allowed, never demanded; conventional is fine when
it works.

## §2. The Brain's record set — resolved

Confirmed by the person, answering the four questions of this section:

- The Brain holds Atlas, Ledger, Chat, pins, and wakes.
- Deletion is a single step: "delete means delete". No undo the person can
  see, no pending state.
- `handoff` is dropped entirely. The Ledger plus the sticky records are
  sufficient to rebuild a session.
- `activity` is ephemeral; a restart does not recover what the agent was
  doing. `context` is not a Brain record.

See `docs/intent.md` §18.

**Q2.5 — deletionMarks (derived, one-word veto).** The set the person picked
included deletion marks, but the single-step answer abolishes the mark's only
function: the record sat in a pending-at-collapse state until a purge cleared
it, which is a two-step delete with an internal name. Recorded as removed.
*Needs:* one word from the person if marks exist for a reason other than
pending deletion.

## §3. Pi Durable immutability versus real deletion — resolved

Pi storage is one store per generation, confirmed by the person. A collapse
creates a fresh store for the new generation; the previous generation's
material is kept as the archive for one collapse and deleted at the next. The
Brain is separate from Pi storage and persists across generations; a live
session is rebuilt from the Brain alone, which the person asked about directly
("we should be able to rebuild a session state from the brain store if
something happens, right?" — yes). See `docs/intent.md` §17 and `MINI.md`
§4.2.

The mechanics below were derived from the person's stated intention, not from
what is easiest, because the person delegated the choice and did not know
which was best. Confirmed by the person: Blessed.

**The archive is the sealed previous generation's Pi store.** At collapse the
old store is sealed read-only and becomes the archive; the new generation gets
a fresh store. No copy and no export is written at collapse: "it becomes the
archive" means the old live context unchanged, and `.brain` must not grow by
accident. Nothing enters the Brain at collapse.

**The person restores; the agent cannot read it.** Recovery opens the sealed
store read-only and copies chosen records into the Brain. The archive never
appears in the projection or the state block; the agent does not know it
exists.

**Pins in the archive survive the purge by becoming Brain records.** Pin
markers live in the Brain, because it is the durable thing. At the next
collapse the purge first exports every pinned-to-archive record into the Brain,
flushes, and only then deletes the sealed store. Unpinned material leaves with
the file. Order matters: a crash before the delete loses nothing; a crash
after loses only what was never pinned.

**The Brain grows only by what is explicitly kept.** `.brain` gains records
only through the agent's writes and the purge's pinned exports — nothing else
enters it, so it cannot balloon. One sealed generation exists at a time.

See `docs/intent.md` §29.

## §4. Recover — resolved

**Q4.1 — Resolved.** Recovery restores the record to its original type; stale
evidence is marked stale and surfaces through the state block's stale line.

**Q4.2 — Resolved.** The agent gets nothing. It does not know the archive
exists and has no way to address it.

See `docs/intent.md` §30 and `MINI.md` §4.1.

## §5. Collapse signalling — resolved

**Q5.1 — Resolved.** The agent is told, in one system-prompt line, that the
person may collapse at any time and that collapse rebuilds its context from
the Brain. Consequence, not threat.

**Q5.2 — Resolved.** No boundary, no warning. Afterwards the person sees a
plain report, not a confirmation.

See `docs/intent.md` §31.

## §6. Projection order and timestamps — resolved by the freeze

**Q6.1 — Order.** Resolved by the frozen projection. Nothing in the projection
changes between collapses, so there is no prefix to protect; order is a
collapse-time convention. No requirement either way. See `docs/intent.md` §19.

**Q6.2 — Timestamps.** Resolved by the frozen projection. They stay on the
record's ID line; the line only changes at a rebuild. See `docs/intent.md` §19.

**Q6.3 — Does an edited record move?** Resolved by the frozen projection. No
record moves between collapses. See `docs/intent.md` §19.

## §7. The state block

**Q7.0 — Resolved.** The block is injected per request and never persisted.
`onYield` continues a text-only reply with a byte-sized marker user message;
the payload carries exactly one current block at the tail, and the store keeps
only markers until the generation ends. Approved by the person.
Hook naming *resolved 2026-11-20:* injection happens at `beforeRequest`, not
the spec's `beforeProviderRequest` — the payload is provider-native and a
splice would reimplement provider specifics for the same wire result. Kept
by the person after the trade was shown. See `docs/intent.md` §20 and
`docs/rebuild-slices.md`.

### The block's schema

**Q7.0b — Resolved.** The projection is frozen between collapses, confirmed
by the person. See `docs/intent.md` §19.

**Q7.0c — Resolved.** No ceiling and no fallback. The user's work comes first;
the Brain is kept in between and during tasks; the growing list and the
fullness number are the pressure. See `docs/intent.md` §27.

**Q7.1 — Resolved.** The six confirmed contents: context state, space by
Brain part, pending changes, stale items, wakes, and the project tree. See
`docs/intent.md` §21.

**Q7.2 — Resolved 2026-11-16.** The state block's items reuse the Brain's
generation-local handles; no separate scheme. The pending list is ephemeral
(starts empty after a crash), and the frozen projection persists as a
per-generation snapshot file under `.brain/context/`. See `docs/intent.md` §34.

**Q7.3 — Resolved by confirmation.** It is present on every request; that is
what “appended to every request” means in §6.3 of MINI.md. Always present,
including when nothing is stale.

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

The person chose minimal-first for the prompt: the tools, what they do and how
to use them, then iterate. `docs/prompt-draft.md` is reference material under
that direction, not the starting point. See `docs/intent.md` §22.

What follows is the draft's own design notes, kept for iteration.

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
verified against a provider and may be invented. *Resolved 2026-11-20:* the
person chose to ship a live bar anyway. The `prompt_progress` shape remains
unverified against the real server; if it is absent, the live segment shows
nothing.

**Q9.2 — If it is invented, what replaces it?** *Resolved 2026-11-20 (same
decision):* the bar ships with the live segment unverified; the exact numbers
(request payload plus provider usage) are always available after a request
and are the truthful floor. The bar must never present an invented figure as
measured — the live segment is estimate-glyphed until measurement exists.

## §10. Turn control — resolved

Interrupt (stop at a boundary), Steer (queued at the next boundary, arrives in
the transcript), Follow-up (queued after the run). Pause, edit-draft, and
resume removed with the approval-era draft; Cancel = interrupt + drop the
queue. Confirmed by the person. See `docs/intent.md` §33.

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

**Q13.5 — Resolved.** Confirmed by the person: a changed digest marks the
record stale — a gentle signal to update the Brain, never a block. See
`docs/intent.md` §28.

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
