# Spec gaps

A plan, not authority (§1.4). It lists where the build and `SPEC.md` disagree,
what each gap costs, and the order the gaps get closed. A gap is closed only
when the code does what the section says and a test would catch it breaking.

Each stage ends with `npm test` and a push (§4). Status is written here as the
stages land; a stage that has not run is `open`, and one that cannot be built is
`blocked` with the reason, never softened to `open`.

## How this list was made

Read `SPEC.md` end to end against the code, not against memory. Several gaps are
in work previously reported as finished, including the archive layer itself. The
rule for the rest of this document: nothing here is closed by an intention.

## Stage 1 — the archive's marks: restore and delete apply at a collapse

**Status: done.** `ArchivedItem` carries a mark, the collapse applies it after
the sweep and before grace, restore and delete from the UI go through the mark,
and `mark.clear` carries an author so the person's own marks are theirs alone.

**Spec.** §4.1: "Archive, restore, and delete are three separate actions, and
each is a mark by default. Marking applies the action at the next collapse…
**Marked for restore**, for an entry in the archive, leaves it in the archive for
now and returns it to the context at the next collapse." §4 collapse step 4
includes "returns every entry marked for restore to its place in the context".
§4.1 also fixes who may withdraw what: "only the person may withdraw a mark the
agent placed."

**What the code does.** `ArchiveWrite` is `pin | restore | drop`, and every one
of them acts at once. An archived item has no mark to carry, so nothing waits for
a collapse and collapse step 4 has nothing to return. `mark.clear` takes no
author, so the person's own marks cannot be distinguished from the agent's.

**Plan.**

- `ArchivedItem` gains `mark?: { action: "restore" | "delete"; author: Author }`.
  It is the same shape a Brain record's mark has, because §4.1 makes it the same
  mechanism on a different layer.
- `ArchiveWrite` becomes marks plus the collapse's own act:
  `mark.set`, `mark.clear`, `drop` (the person deleting past grace), and
  `restore` surviving only as the collapse's application. The person still gets
  an immediate restore, because they may apply an action now (§4.1) — but it goes
  through the mark and then the collapse applies it, so there is one path.
- The collapse applies archive marks with the other marks: a restore puts the
  item back where it came from (Brain record to the Brain, ephemeral to the live
  context), a delete drops it for good.
- Mark authority: `mark.clear` and archive `mark.clear` carry an author. A mark
  placed by the person is withdrawn by the person only; the agent may withdraw
  its own. An agent that tries is refused with a sentence that says so.
- Nothing about the archive reaches the agent: these marks are never in the state
  block, never in a tool's result, and never in the prefill (§3.3).

**Test.** An item marked for restore is still in the archive before the collapse
and back where it came from after; a person's mark survives an agent's attempt to
clear it; an agent's own mark can be cleared by the agent.

## Stage 2 — pins that keep their promise

**Spec.** §5.1: the head is `… → chat → **pinned files** → pinned ephemera`, and
"a pinned file is the file at the moment of collapse: it is read again and placed
in the head as the file now stands". §5.5: "**At collapse, a pinned read result
is made true.** The file is read again, and the result becomes what the file now
holds." And "**A pinned read result goes stale when its file changes.** The state
block says so, by handle, from the moment the change is seen."

**What the code does.** There are no pinned files at all: no record, no pin, no
region of the head. A pinned `read` result is carried into the head as the text
that was read, so it is exactly the stale quotation §5.5 says a pin exists to
prevent. `staleAtlasNodeIds` covers Atlas attachments only; a read result is
never reported stale.

**Plan.**

- The Brain gains `files: PinnedFile[]`: `{ path, pinned, updatedAt }`. A file is
  not a Brain record (§2.1) and this is not a record of it: it is the pin on it,
  which §5.1 needs a home for. It takes a `P` pin and the file keeps its `F`
  handle — one handle, as §5.4 requires.
- `pin` accepts a file handle (`F`/`D` from the tree) as well as a record handle.
- At a collapse, a pinned file is read again and its current text is placed in
  the head, after Chat and before pinned ephemera. `projectContext` stays pure
  (§11): it takes the resolved text as an argument, and the collapse — the
  runtime adapter — does the reading. If the file is gone, the head says so in
  place of the text rather than dropping the pin silently.
- At a collapse, a pinned `readResult` is re-read from its recorded path and its
  text becomes what the file now holds. If the file is gone, the item keeps its
  text and is marked stale.
- Staleness for read results: the state block names a pinned read result whose
  file has changed since the read, by handle, the same way it names an Atlas
  node. `staleAtlasNodeIds` grows a sibling for results rather than a second
  mechanism.

**Status: done.** `brain.files` holds pinned files; the tree mints `F`/`D`
handles and `pin` accepts one; the collapse reads every pinned file and every
pinned `read` result again and the head carries the text, with a file that
cannot be read said so in its place. The state block lists each stale entry with
its own reason. `F`/`D` handles on tree rows landed here because a pin has to
name a file, which is stage 3's job, done early and once.

**Test.** Pin a file, change it, collapse: the head holds the new text. Pin a
read result, change the file, collapse: the head holds the new text and the
state block named it stale before the collapse.

## Stage 3 — every item in the context carries a handle

**Spec.** §5.4: "Everything the agent sees carries a short, type-prefixed…
handle. Everything, without exception: … each file in the project, each ephemeral
item, and the state block itself. There is no item in the context that has no
handle." The table gives `T` for the tree and `B` for the block, and `P` for a
pin "named by the handle of the entry it marks".

**What the code does.** The block carries `B`. The tree carries nothing — `T` is
never assigned. Pins never get a `P`: the views draw a `⊙u`/`⊙a` badge instead,
which is a mark on the row rather than a handle the agent can address.

**Plan.**

- The tree line carries `T1` in the state block, and `tree` is addressable by it.
- A pin renders with its `P` handle next to the entry's own handle, in the
  state block and in the views, so "named by the handle of the entry it marks"
  is literally true and the pin can be addressed.
- One place builds each of these, so the transcript, the Context view and the
  prefill cannot disagree (§5.4: "one numbering").

**Status: done.** The tree line carries `T1` and `tree` takes a directory handle
as its anchor; every pin is named `P <handle of what it marks>` in the state
block, the transcript, the Context view and the archive, through one function.
`F`/`D` on tree rows landed in stage 2 because a pin has to name a file.

**Test.** The state block contains `T1` and a `P` handle for a pinned record;
the Context view and the block show the same `P` for the same pin.

## Stage 4 — `tree` ends the turn, and the descriptions tell the truth

**Spec.** §6.3: "**`tree` ends the turn immediately.** The state block renders as
the next turn, so the agent sets where it is attending and sees the tree it just
asked for at once." §7: "A tool's own description is the authority on what it
does."

**What the code does.** `tree` sets the anchor and returns a sentence; the turn
continues, so the agent acts on the tree it had before it asked. `mark`'s
description does not mention apply-now, and neither does `pin`'s mention a pin on
a file or on an ephemeral item — both of which the sections above make real.

**Plan.**

- `tree` ends the turn the way `collapse` does: it commits the request and the
  host delivers the state block as the next turn.
- `mark`, `pin` and `tree` descriptions say what the tool now does, and nothing
  about what it does not.

**Test.** A `tree` call ends the turn: the tool's result is terminal and the next
turn is the state block.

## Stage 5 — a bound is in the description, not the schema

**Spec.** §1: "nothing in the context has a bound a person did not put there…
Where a bound is part of how a tool works, it is said so in that tool's own
description and nowhere else." §2.5: "The prompt asks the agent to size its own
entries. Under §1 there is no schema length limit."

**What the code does.** Tool parameters carry minimums that silently constrain
the agent — a length the person never asked for, enforced by the validator rather
than stated anywhere.

**Plan.** Each such bound is either removed, or kept and stated in that tool's
description. Which one it is, is decided per parameter by whether the tool can
work without it: a bound the tool genuinely cannot run without is stated; the
rest go.

**Test.** No product tool's parameters carry a limit its description does not
state.

## Stage 6 — a rest that survives a restart

**Spec.** §10: "The wait is durable: the agent rests across a restart, and the
time is an argument to the call."

**What the code does.** `restThenResume` holds a `setTimeout` and
`session.state.sleepSeconds` in memory. A restart during a rest loses the rest;
the agent never wakes.

**Plan.** The timed rest becomes a durable sleep: pi-durable commits a sleep on
the call's task (`sleepUntil`), so the time is in the store, not in a timer.
The host's resume path is the one it already has — the state block as the next
turn (§5.7) — so a woken rest and a resumed one are the same event.

**Test.** A rest started before a reopen still ends, and the agent starts again
from the state block.

## Stage 7 — apply-now is a rebuild, not a collapse

**Spec.** §4.1: "Applying an action now changes the context immediately, which
forces a rebuild at that point: the prefill runs again from the changed entry
through the tail. The head is untouched, so applying an action now costs the body
and the tail, never the head." §5.6 exempts it from the freeze for the same
reason.

**What the code does.** `!` then `d` calls `runCollapse("context surgery (now)")`:
a whole collapse, which rewrites the head, sweeps the store and rotates the
generation. That is the most expensive operation there is, presented as the
cheap one.

**Plan.**

- Applying now rebuilds the frozen projection in place for the current
  generation: the entries from the changed one to the end are re-rendered, and
  the head prefix is left byte-identical whenever the change is not a Brain
  record (§5.1). Nothing is swept, nothing rotates, no grace is spent.
- A change to a Brain record does change the head's composition, which §5.1
  allows ("Its composition changes only when the Brain changes"), and the rebuild
  says so plainly in what it reports.
- A mark still waits for the collapse when the person has not applied it now.

**Test.** An apply-now on a body entry leaves the head prefix byte-identical and
changes only what follows it; no collapse counter moves.

## Stage 8 — pause: blocked

**Spec.** §9: "**Pause** stops the run where it is without breaking the stream of
generation… Nothing is committed or discarded by a pause, and the agent is not
told it happened."

**What the code does.** There is no pause. The only run control is interrupt,
which §9 names as the one action that costs work.

**Why it is blocked.** A run is a pi-durable task, and pi-durable exposes no way
to suspend one. `HarnessInspection.scheduling` reports `"paused"`, but the only
transition into it is *before* `Harness.resume()`, which is the host opening the
session; there is no call that pauses a running run and no call that resumes one
in place. `abortTask` marks an abort, which is an interrupt. Generation and its
stream live inside the provider request the harness owns, so there is nothing on
this side to hold that would not also break the stream — which is precisely what
§9 says a pause must not do.

**What that leaves.** Either the section's pause is not buildable on this
dependency, or the dependency needs the capability. Both are the person's call,
not mine, so this stage stays `blocked` until they say which. Nothing is faked in
the meantime: the app does not offer a pause that secretly interrupts.

**Test.** None. A test here would only assert a faked pause.

## Not in this plan

- Pinned files being re-read at *apply-now* as well as at a collapse: stage 7
  rebuilds from the Brain, and a pinned file's text comes from the same place in
  both paths, so it follows from the two stages rather than needing its own.
- Anything the spec leaves to the build: glyphs, colours, key choices (§8).

## Order and why

1 → 2 → 3 → 4 → 5 → 6 → 7, then 8 as a question for the person. The archive's
marks come first because everything else that touches the archive is built on
them; the pins come next because they are the head's promise; the rest are
independent and ordered by how much they mislead the agent today.
