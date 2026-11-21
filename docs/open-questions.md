# Open questions

Only questions that are still questions. Each entry says what is unsettled and
what would close it.

The last pass of this file mixed answers, agent inferences presented as answers,
and questions. That is why it could not be trusted as an agenda. Every entry here
is a question that is still a question.

An entry is deleted once `SPEC.md` answers it, once the person answers it and the
answer is written into the spec, or once it turns out not to be a spec question
at all. Nothing is kept as a record of having been asked.

The rule this file enforces: no entry is resolved because an agent wrote
"resolved" next to it. An entry closes when the person says the thing, and then
it leaves the file.

Entries are marked with the `SPEC.md` section they would land in. Every
integration is a separate decision.

---

## Open

**1 — Palette keys.**
Bindings exist; the spec names none. Low stakes, and it is a build decision
unless the keys are meant to be fixed.
*Would land in:* §8, if at all.
*To close:* whether the spec names keys.

**2 — Edit-prompting in the TUI.**
Deferred, not open. Recorded here so the deferral itself is not lost. The
person's reason: prompt text benefits from programmatic insertion that is not
human-readable, and the core of the project matters more than an editor for the
prompt.
*Would land in:* §8.
*To close:* revisiting the deferral.
