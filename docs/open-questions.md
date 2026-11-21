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

- The Brain holds Atlas, Ledger, Chat — with pins as markers on those records
  (2026-11-20, by the person: wakes are scrapped and a pin is a marker on a
  book entry, not a record of its own; the record-set decision was re-scoped
  and carries no reason, no source, no other bookkeeping).
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
it, which is a two-step delete with an internal name. *Resolved 2026-11-20:*
vestigial; dropped. No extra legacy machinery unless the project needs it.
See `docs/intent.md` §35.

## §3. Pi Durable immutability versus real deletion — resolved

Pi storage is one store per generation, confirmed by the person. A collapse
creates a fresh store for the new generation and sweeps the previous generation's
ephemeral material to the archive. The Brain is separate from Pi storage and
persists across generations; a live session is rebuilt from the Brain alone,
which the person asked about directly ("we should be able to rebuild a session
state from the brain store if something happens, right?" — yes). See
`docs/intent.md` §17 and `MINI.md` §4.2.

The mechanics below were derived from the person's stated intention, not from
what is easiest, because the person delegated the choice and did not know
which was best. Confirmed by the person: Blessed.

**The archive is Carto's own database, swept item by item.** The archive is not
the sealed previous generation's Pi store. Unpinned ephemeral content sweeps
into it automatically at collapse; Brain records sweep only when the person or
the agent marks them for archive. Pinned items in the archive stay there until
unpinned or restored; unpinned items are deleted for good. The person owns the
archive — the agent never knows it exists. The details and the still-open seams
are recorded in §15.

**The person restores; the agent cannot read it.** Recovery restores the archived
entry to the context as its original type. The archive never appears in the
projection or the state block; the agent does not know it exists.

**Pins in the archive survive until unpinned or restored.** Pinned items in the
archive remain there until the person unpins or restores them. There is no
per-generation export seam; the archive is Carto's own database.

> Amended 2026-11-21, by the person: the sealed-store/export framing is
> superseded — see §15. The archive is Carto's own database, swept item by item
> at collapse; pinned archive items stay in the archive, and the export-to-Brain
> seam no longer exists. The detailed seams are listed in §15.

**The Brain grows only by what is explicitly kept.** `.brain` gains records
only through the agent's writes and the person's own writes — nothing else
enters it, so it cannot balloon. The archive holds the material that is swept;
pinned archive items remain in the archive, and the person owns them.

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

**Q7.1 — Resolved.** The contents: context state, space by Brain part,
pending changes, stale items, and the project tree (wakes dropped 2026-11-20;
pins are markers on book entries, not a Brain part). See
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
*Resolved 2026-11-20:* prompt-only, stated explicitly by the person ("prompt
only, i stated this explicitly earlier too"). No structural enforcement in the
edit tool. See `docs/intent.md` §36.

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

## §10. Turn control — resolved; interrupt superseded 2026-11-20

Interrupt (stop at a boundary), Steer (queued at the next boundary, arrives in
the transcript), Follow-up (queued after the run). Pause, edit-draft, and
resume removed with the approval-era draft; Cancel = interrupt + drop the
queue. Confirmed by the person. See `docs/intent.md` §33.

*Superseded 2026-11-20:* the person corrected the interrupt semantics
directly — Interrupt stops the run NOW, not "at a Pi Durable boundary"; that
was their stated intent in the main branch, the previous build, and this
build ("Interrupt means interrupt"). While a stream is interrupted, the
input box remains usable: steering and follow-ups can be sent without
breaking the stream, or submitted immediately, which breaks it. MINI.md §9
keeps its wording (MINI.md is never edited); the supersession is recorded in
`docs/intent.md` §47.

## §11. Wake and sleep

*Resolved 2026-11-20, by the person:* wakes are scrapped. The timer wake, the
folder wake, the path wake, and the sleep-tool wake are all gone; nothing
armed re-engages the agent but the person. See MINI.md §10 and
`docs/rebuild-slices.md` (slice 3, R1).

**Q11.1 — Are wakes still in scope for the first rebuild?** *Resolved
2026-11-20:* no. Wakes are scrapped entirely; the sleep tool just ends the run.

**Q11.2 — What are the bounds?** *Resolved 2026-11-20:* moot — there is no
wake machinery left to bound.

## §12. The workspace, re-scoped by the person

*2026-11-20, by the person:* R5 (the UI) is designed from a deep crawl of the
Posting source — Posting's design philosophy and structure, pi-tui first where
it does what we want, hand-rolled the minimum for Posting-level elegance. The
MINI.md §8 frame and three-tab split are "not necessarily required"; the
Context view and the token bar are required, the former being the flagship
("the open-brain surgery section": see, remove, reorder, edit, add — an
accurate, structured, editable representation of everything the agent sees).
Testing of slices is the person's to do at their own pace —
the confirmed marks say R4 and any slice's testing is never raised again.
The proposal is `docs/ui-proposal.md`. The person's
marks on it are resolved (2026-11-20, its §10) and the UI is built on this
branch — R5a shell + Chat, R5b token bar, R5c Brain views, R5d Context surgery
view — so the frame/tab questions below are answered by the build as much as by
the proposal.

**Q12.1 — The three tabs.** *Resolved 2026-11-20:* modes, not tabs
(`docs/intent.md` §44); the build renders Chat / Context / Brain as views,
reachable by jump keys and the palette.

**Q12.2 — Five-row disclosure.** *Resolved 2026-11-20:* the disclosure feature
is already done — the views fold and expand as needed, no fixed row count
exists. The question was bookkeeping, not an open design question; the
person has marked it resolved.

**Q12.3 — The footer hint set.** *Resolved 2026-11-20:* the footer is
context-sensitive (Posting's idiom) — it shows the keys that work where you
are — and is built with R5a.

## §13. Small things that are probably assumptions

**Q13.1 — `collapseMode` configuration.** With no approval, the setting has no
meaning. Removed from the rewrite. *Needs:* acknowledgement that it is gone.

**Q13.2 — The `10,000-entry` folder wake limit.** Moot as of 2026-11-20:
wakes are scrapped entirely; the folder wake is dropped with them.

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

**Q14.3 — Tab order.** Open — folds into the person's marks on
`docs/ui-proposal.md`.

---

## §15. The archive, re-scoped 2026-11-21 — the agreed shape is recorded in MINI.md; the seams are not

The person re-scoped the archive this session. Confirmed (2026-11-21): the
archive is Carto's own database (not pi-durable's — verified: pi-durable
requires no archive and provides no deletion primitive); Brain entries never
archive on their own but may be marked for archive by user or agent; unpinned
ephemeral content sweeps into the archive automatically at collapse; pinned
archive items remain in the archive until unpinned or restored; unpinned
archive items are deleted for good after one collapse of grace; pinned content
is ordered near the head of the prefill for stability; a delete button
permanently deletes an entry without archiving it; restore is user-only and the
agent never knows the archive exists. MINI.md §4, §4.1, §4.2, §5, §6 record the
confirmed shape.

**Q15.2 — Deletion timing — RESOLVED 2026-11-21.** Unpinned archive items are
deleted for good after one collapse of grace ("we are utilizing that
consequence to have a one-collapse grace period for files that get swept
automatically and brain entries marked for archive"). Held for one collapse;
pinned archive items remain in the archive until unpinned or restored.

Still open (PROPOSED, not confirmed — the person has not ruled on these):

**Q15.1 — What are "pinned files" and "pinned ephemera"?** Both are confirmed
positions in the prefill (the person's worked-through layout). What is not
confirmed: what a pinned file is (evidence? command output? transcript entry?),
what a pinned ephemeral item is, and where pinned ephemeral content lives after
collapse (lifted into the frozen head, or kept somewhere else — nothing exists
today). Pins on brain records are unchanged.

**Q15.3 — Archive-marked brain entry semantics.** Does marking a brain entry
for archive remove it from the Brain (the record leaves the Brain's sticky
set, the archive holds it for later restore), or is the record kept in the Brain
while its live context is cut? Does the Brain carry an `archived` mark on the
record, restored by the recovery path?

**Q15.4 — Frozen head structure.** The confirmed layout puts atlas entries,
ledger entries, chat entries, pinned files, and pinned ephemera in the head.
Today the frozen projection renders atlas and ledger only, and chat is never
projected (intent §11). Is the frozen projection extended to the full head
(atlas, ledger, chat, pinned content) — with chat possibly superseding §11's
"chat never reaches the projection" — or does the head come from a new
assembly?

**Q15.5 — Recovery UI.** Recovery is confirmed to exist and is person-only
("entries on the archive layer can be restored. only the user knows the archive
layer exists"). What is not confirmed: is the recovery UI built now, and does it
keep the archive visible as a list the user can restore from?

**Q15.6 — The old generation store's lifecycle.** The archive is item-by-item,
not a sealed store, but the old generation store itself (transcript, frozen
projection) still exists under pi-durable. When is it deleted — at collapse
after the sweep, or held for one collapse of grace alongside the archived
items? (And separately: is the per-generation store kept, or does Carto move to
a single store with reset semantics?)


## How this was produced

The rewrite of `MINI.md` was mechanical about what to keep. A line stayed only if
one of these held:

1. the person stated it in this conversation;
2. the person confirmed it when the agent restated it;
3. it is an observable fact about a dependency, verifiable in `node_modules`;
4. it was in the old specification, was not challenged, and is marked open here.

Anything else was removed and appears in this file. Nothing was removed silently.
