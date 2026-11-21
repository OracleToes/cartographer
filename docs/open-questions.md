# Open questions

Only questions that are still questions. Each entry says what is unsettled and
what would close it.

The last pass of this file mixed three kinds of entry: answers, agent inferences
presented as answers, and questions. That is why it could not be trusted as an
agenda. Every entry here is now one of two things:

- **Open** — genuinely undecided.
- **Needs confirmation** — the agent believes the person answered it, but the
  answer was not restated and agreed. These are not settled, and nothing from
  them goes into `SPEC.md` until they are.

The rule this file exists to enforce: no entry is resolved because an agent
wrote "resolved" next to it. An entry closes when the person says the thing and
agrees with the restatement.

Nothing here is copied into `SPEC.md` by this pass. Entries are marked with the
`SPEC.md` section they would land in, and every one of those integrations is a
separate decision.

---

## A. Needs confirmation

The person may have decided these; this file cannot show that they did.

**A4 — Showing a diff without applying it.**
The approval queue is gone. Whether the agent may *show* a proposed change
before making it was never answered.
*Would land in:* §7.
*To close:* whether visibility-before-edit exists as a tool, a render, or
nothing.

**A5 — What counts as destructive.**
Overwrite, delete, and large patches are the obvious cases. Append, and creating
a file, are not obvious. `SPEC.md` §7 settles overwrite by never offering it and
settles delete by leaving it to `bash`, but has no definition of "destructive"
to apply to the capability gate.
*Would land in:* §6.
*To close:* a definition, or a decision that the gate never needs one.

**A6 — The token bar's glyphs and colour roles.**
`▤` for an estimate, `▰` for a measured figure, `┊` for the budget mark, and the
muted/accent/warning roles were locked in an earlier build. `SPEC.md` §8 keeps
the behaviour — estimate in a different glyph and colour — and names no glyph.
*Would land in:* §8.
*To close:* whether the old glyphs survive.

**A7 — The pronoun split in the prompt.**
"we" for the work, "I" for the agent's own uncertainty. A judgement about the
prose, not the rule.
*Would land in:* §12.
*To close:* whether that reads as one voice.

**A9 — Whether prompting is enough to produce small edits.**
`SPEC.md` §7 states atomic edits as an intention and says nothing enforces it.
Whether the prompt actually changes behaviour is unknown to the person.
*Would land in:* §7, as a caveat or not at all.
*To close:* observation, not a decision. Not a spec question until something is
observed.

**A10 — The recovery UI.**
Restore is the person's action and the agent cannot see the archive. Whether the
archive is shown as a list the person can restore from, and whether that is
built now, is unsettled.
*Would land in:* §3.3.
*To close:* whether the spec describes a view or only the capability.

## B. Open

**B1 — Which llama.cpp endpoints and fields carry the token bar's figures.**
`SPEC.md` §8 fixes the source as the server: capacity from `-c`, the count from
the last request, tokens per second for generation and prompt reading, fill, and
prefill-versus-generating. The endpoints and field names are not fixed, and
neither is what the bar shows while the server is unreachable.
*Would land in:* §8.
*To close:* the reads, and the degraded state.

**B2 — Whether the old generation store is deleted at collapse or held for the
grace period.**
`SPEC.md` §3.4 says a collapse builds a new store and the previous one is
deleted whole. It does not say *when*: immediately, or alongside the archived
items that get their one collapse of grace.
*Would land in:* §3.4.
*To close:* one or the other, and whether the grace period applies to the store
as well as to its items.

**B3 — Whether archive-marked records stay in the Brain.**
`SPEC.md` §4.1 says a Brain record marked for archive is swept into the archive
at collapse. It does not say whether the record leaves the Brain, or stays there
carrying a mark while only its live-context presence goes.
*Would land in:* §4.1.
*To close:* which of the two the Brain does.

**B4 — Palette keys.**
Bindings exist; the spec names none. Low stakes, and it is a build decision
unless the keys are meant to be fixed.
*Would land in:* §8, if at all.
*To close:* whether the spec names keys.

**B5 — Edit-prompting in the TUI.**
Deferred, not open. Recorded here so the deferral itself is not lost. The
person's reason: prompt text benefits from programmatic insertion that is not
human-readable, and the core of the project matters more than an editor for the
prompt.
*Would land in:* §8.
*To close:* revisiting the deferral.

---

## How this file was produced

Every entry in the previous version was checked against `SPEC.md` at `e481a37`
and against what the person actually said in conversation.

- Entries already answered by `SPEC.md` were deleted.
- Entries contradicted by `SPEC.md`, or contradicted by the person, were thrown
  out.
- Entries whose resolution rested on an agent's own inference, or on an agent
  telling the person something was resolved, were not kept as answers. What
  survived of them is listed as needs-confirmation.
- Mechanic names, hook names, and payload shapes were dropped. They are not
  spec questions.
